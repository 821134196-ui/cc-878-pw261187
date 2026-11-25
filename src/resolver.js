import { Resolver } from 'node:dns/promises';

function normalizeDnsError(error) {
  const raw = `${error.code || ''} ${error.message || ''}`;
  if (/TIMEOUT|ETIMEOUT/i.test(raw)) return 'DNS_TIMEOUT';
  if (/NXDOMAIN|ENOTFOUND/i.test(raw)) return 'NXDOMAIN';
  if (/REFUSED|ECONNREFUSED/i.test(raw)) return 'DNS_SERVER_REFUSED';
  return error.code || 'DNS_ERROR';
}

export class DnsMonitor {
  constructor({ config, registry, state, onEndpointsChanged }) {
    this.config = config;
    this.registry = registry;
    this.state = state;
    this.onEndpointsChanged = onEndpointsChanged;

    this.resolver = new Resolver({
      timeout: config.dnsQueryTimeoutMs,
      tries: 1,
    });
    this.resolver.setServers([`${config.dnsHost}:${config.dnsPort}`]);

    this.endpoints = [];
    this.key = null;
    this.inFlight = null;
    this.timer = null;
  }

  async resolveOnce() {
    const srvRecords = await this.resolver.resolveSrv(this.config.dnsName);
    const expected = new Map(
      this.registry.srvRecords().map((record) => [`${record.target}:${record.port}`, record]),
    );

    const settled = await Promise.allSettled(
      srvRecords.map(async (srv) => {
        const addresses = await this.resolver.resolve4(srv.name);
        if (!addresses || addresses.length === 0) {
          const error = new Error(`No A records for ${srv.name}`);
          error.code = 'ENODATA';
          throw error;
        }
        return { srv, addresses };
      }),
    );

    const endpoints = [];
    const resolutions = [];

    settled.forEach((result, index) => {
      const srv = srvRecords[index];
      const meta = expected.get(`${srv.name}:${srv.port}`) || {};

      if (result.status === 'fulfilled') {
        const address = result.value.addresses[0];
        const endpoint = {
          id: meta.color ? `${meta.color}:${srv.port}` : `${srv.name}:${srv.port}`,
          host: address,
          port: srv.port,
          target: srv.name,
          color: meta.color || null,
          kind: meta.kind || 'unknown',
          label: meta.label || srv.name,
          fault: meta.fault || null,
        };
        endpoints.push(endpoint);
        resolutions.push({
          target: srv.name,
          port: srv.port,
          status: 'ok',
          code: null,
          addresses: result.value.addresses,
          endpointId: endpoint.id,
          color: endpoint.color,
          kind: endpoint.kind,
          label: endpoint.label,
        });
      } else {
        const code = normalizeDnsError(result.reason);
        resolutions.push({
          target: srv.name,
          port: srv.port,
          status: code === 'DNS_TIMEOUT' ? 'timeout' : 'error',
          code,
          addresses: [],
          endpointId: null,
          color: meta.color || null,
          kind: meta.kind || 'unresolved',
          label: meta.label || srv.name,
          message: result.reason?.message || String(result.reason),
        });
      }
    });

    return { endpoints, resolutions };
  }

  refresh(reason = 'interval') {
    if (this.inFlight) return this.inFlight;

    const startedAt = Date.now();
    this.state.dns.lastReason = reason;
    this.state.dns.status = 'checking';

    this.inFlight = (async () => {
      try {
        const { endpoints, resolutions } = await this.resolveOnce();
        const durationMs = Date.now() - startedAt;
        const failures = resolutions.filter((item) => item.status !== 'ok');
        const timeouts = failures.filter((item) => item.code === 'DNS_TIMEOUT');
        const key = endpoints.map((endpoint) => endpoint.id).join('|');

        this.state.dns.tickCount += 1;
        this.state.stats.dnsTicks += 1;
        this.state.dns.lastTickAt = Date.now();
        this.state.dns.lastDurationMs = durationMs;
        this.state.dns.serial = this.registry.serial;
        this.state.dns.srvAnswers = this.registry.srvRecords();
        this.state.dns.resolutions = resolutions;

        if (endpoints.length === 0) {
          const error = new Error('SRV 查询成功，但没有任何端点完成 A 记录解析');
          error.code = 'ALL_ENDPOINT_RESOLUTION_FAILED';
          throw error;
        }

        const changed = key !== this.key;
        if (changed) {
          const previousKey = this.key;
          this.key = key;
          this.endpoints = endpoints;
          await this.onEndpointsChanged?.(endpoints, {
            reason,
            resolutions,
            previousKey,
            key,
            durationMs,
          });
        } else {
          this.state.log({
            layer: 'dns',
            kind: 'dns_tick_unchanged',
            severity: timeouts.length ? 'warning' : 'info',
            title: '周期 DNS 刷新：端点集合未变',
            detail: `${durationMs} ms · ${key} · 保留当前 Agent 与 keep-alive 连接`,
            meta: { reason, key, durationMs },
          });
        }

        if (timeouts.length > 0) {
          this.state.dns.status = 'partial_timeout';
          this.state.dns.message = `${timeouts.length} 条解析结果超时，${endpoints.length} 个端点可用`;
          this.state.dns.partialCount += 1;
          this.state.stats.partialTimeouts += 1;
          if (reason !== 'interval' || changed) {
            // The generation event already explains changed answers; still make
            // partial timeout explicit in the timeline on manual refreshes.
          }
          this.state.log({
            layer: 'dns',
            kind: 'dns_partial_timeout',
            severity: 'warning',
            title: '部分解析结果超时（DNS_TIMEOUT）',
            detail: `${timeouts.map((item) => `${item.target} → ${item.code}`).join('；')}。这是解析阶段超时，与 TCP/HTTP 尝试失败分开计数。`,
            meta: { resolutions },
          });
        } else if (failures.length > 0) {
          this.state.dns.status = 'partial_error';
          this.state.dns.message = `${failures.length} 条解析失败，${endpoints.length} 个端点可用`;
          this.state.dns.partialCount += 1;
          this.state.log({
            layer: 'dns',
            kind: 'dns_partial_error',
            severity: 'warning',
            title: '部分解析结果失败',
            detail: failures.map((item) => `${item.target} → ${item.code}`).join('；'),
          });
        } else {
          this.state.dns.status = 'ok';
          this.state.dns.message = `${endpoints.length} 个端点解析成功`;
          this.state.dns.successCount += 1;
        }

        return { changed, endpoints, resolutions };
      } catch (error) {
        const code = normalizeDnsError(error);
        const durationMs = Date.now() - startedAt;
        this.state.dns.failureCount += 1;
        this.state.dns.status = 'error';
        this.state.dns.lastTickAt = Date.now();
        this.state.dns.lastDurationMs = durationMs;
        this.state.dns.message = `DNS 刷新失败：${code}；继续使用上一份可用端点`;
        this.state.log({
          layer: 'dns',
          kind: 'dns_refresh_failed',
          severity: 'critical',
          title: 'DNS 整体刷新失败',
          detail: `${code}: ${error.message}。旧解析结果和连接池继续服务，不会清空为 502。`,
          meta: { code },
        });
        return { changed: false, endpoints: this.endpoints, resolutions: [], error };
      } finally {
        this.inFlight = null;
        // Schedule the next fixed delay after this attempt settles. This also
        // restarts the cadence after a manual/control-triggered refresh so the
        // countdown does not snap back to a stale interval boundary.
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = setInterval(() => this.refresh('interval'), this.config.dnsRefreshMs);
        }
        this.state.dns.nextRefreshAt = Date.now() + this.config.dnsRefreshMs;
      }
    })();

    return this.inFlight;
  }

  start() {
    this.refresh('startup');
    this.timer = setInterval(() => this.refresh('interval'), this.config.dnsRefreshMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
