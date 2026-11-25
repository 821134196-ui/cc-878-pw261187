import http from 'node:http';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function endpointLabel(endpoint) {
  return `${endpoint.label || endpoint.id} · ${endpoint.host}:${endpoint.port}`;
}

function classifyError(error, phase) {
  if (error?.code === 'CONNECT_TIMEOUT') return 'CONNECT_TIMEOUT';
  if (error?.code === 'HEADER_TIMEOUT') return 'HEADER_TIMEOUT';
  if (error?.code) return error.code;
  if (phase === 'connect') return 'CONNECT_ERROR';
  if (phase === 'headers') return 'HEADER_ERROR';
  return 'PROXY_ERROR';
}

export class ReverseProxy {
  constructor({ config, state }) {
    this.config = config;
    this.state = state;
    /** @type {Map<string, {record: object, agent: http.Agent, endpoints: object[], hardTimer?: NodeJS.Timeout}>} */
    this.runtimes = new Map();
    this.activeRuntime = null;
    this.clientServer = null;
  }

  setClientServer(server) {
    this.clientServer = server;
  }

  async setEndpoints(endpoints, context = {}) {
    if (this.activeRuntime) {
      this.retireGeneration(this.activeRuntime, context.reason || 'DNS 端点集合变更');
    }

    const serial = this.state.nextId('g');
    const record = {
      id: serial,
      status: 'active',
      createdAt: Date.now(),
      retiredAt: null,
      closedAt: null,
      reason: context.reason || 'dns-change',
      key: context.key || endpoints.map((e) => e.id).join('|'),
      endpoints: endpoints.map((endpoint) => ({ ...endpoint })),
      activeRequests: 0,
      totalRequests: 0,
      connectionsCreated: 0,
      reuseCount: 0,
      retryCount: 0,
      bytes: 0,
      idleSocketsDestroyed: 0,
    };

    this.state.addGeneration(record);

    const agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 1200,
      maxSockets: 8,
      maxFreeSockets: 4,
      scheduling: 'fifo',
    });

    const runtime = { record, agent, endpoints, hardTimer: null };
    this.runtimes.set(record.id, runtime);
    this.activeRuntime = runtime;

    this.state.log({
      layer: 'pool',
      kind: 'generation_created',
      severity: 'success',
      title: `新连接代际 ${record.id} 已启用`,
      detail: `DNS serial ${this.state.dns.serial} → ${endpoints.map(endpointLabel).join('；')}。新请求只会从这个新 Agent 取连接。`,
      meta: { generationId: record.id, endpoints, context },
    });

    return record;
  }

  retireGeneration(runtime, reason) {
    const { record, agent } = runtime;
    if (record.status !== 'active') return;

    record.status = 'draining';
    record.retiredAt = Date.now();
    record.drainReason = reason;
    this.state.stats.drainStarted += 1;

    let idleCount = 0;
    const freeSocketGroups = agent.freeSockets ? Object.values(agent.freeSockets) : [];
    for (const sockets of freeSocketGroups) {
      for (const socket of sockets || []) {
        idleCount += 1;
        try {
          socket.destroy(new Error('idle connection retired by DNS change'));
        } catch {
          // Socket may already be closed.
        }
      }
    }
    record.idleSocketsDestroyed += idleCount;

    this.state.log({
      layer: 'drain',
      kind: 'drain_started',
      severity: 'warning',
      title: `代际 ${record.id} 开始排空`,
      detail:
        `DNS 已切换，立即销毁 ${idleCount} 条空闲 keep-alive 连接；` +
        `另有 ${record.activeRequests} 个已开始请求继续占用旧连接，不会被新请求复用。`,
      meta: {
        generationId: record.id,
        idleCount,
        activeRequests: record.activeRequests,
      },
    });

    runtime.hardTimer = setTimeout(() => {
      if (record.status === 'draining') {
        this.state.log({
          layer: 'drain',
          kind: 'drain_hard_timeout',
          severity: 'critical',
          title: `代际 ${record.id} 达到最长排空时间，强制关闭`,
          detail: `仍有 ${record.activeRequests} 个请求未结束。演示下载通常会在此之前正常结束。`,
        });
        record.status = 'closed';
        record.closedAt = Date.now();
        try {
          agent.destroy();
        } catch {
          // ignore
        }
      }
    }, this.config.drainHardTimeoutMs);
    runtime.hardTimer.unref?.();

    this.finishIfDrained(runtime);
  }

  finishIfDrained(runtime) {
    const { record, agent, hardTimer } = runtime;
    if (record.status !== 'draining' || record.activeRequests > 0) return;

    record.status = 'closed';
    record.closedAt = Date.now();
    if (hardTimer) clearTimeout(hardTimer);
    try {
      agent.destroy();
    } catch {
      // ignore
    }

    this.state.stats.drainCompleted += 1;
    this.state.log({
      layer: 'drain',
      kind: 'drain_completed',
      severity: 'success',
      title: `代际 ${record.id} 已排空并关闭`,
      detail: `所有切换前已开始的响应均已结束；共服务 ${record.totalRequests} 个请求，复用 ${record.reuseCount} 次。`,
      meta: { generationId: record.id, totalRequests: record.totalRequests },
    });
  }

  trackSocket(proxyReq, attempt, runtime, endpoint, requestRecord) {
    proxyReq.on('socket', (socket) => {
      if (!socket.__demoConn) {
        const connId = this.state.nextId('c');
        socket.__demoConn = { id: connId, requestCount: 0 };
        const connection = {
          id: connId,
          generationId: runtime.record.id,
          endpointId: endpoint.id,
          endpointLabel: endpoint.label || endpoint.id,
          color: endpoint.color || null,
          remote: `${endpoint.host}:${endpoint.port}`,
          tcpPort: socket.localPort || null,
          status: 'connecting',
          createdAt: Date.now(),
          connectedAt: null,
          closedAt: null,
          requests: 0,
          reused: false,
          lastError: null,
        };
        this.state.addConnection(connection);
        this.state.stats.newConnections += 1;
        runtime.record.connectionsCreated += 1;

        socket.once('connect', () => {
          connection.status = 'active';
          connection.connectedAt = Date.now();
          connection.tcpPort = socket.localPort || connection.tcpPort;
          attempt.tcpPort = connection.tcpPort;
        });
        socket.on('close', () => {
          connection.status = 'closed';
          connection.closedAt = Date.now();
          if (!connection.tcpPort) connection.tcpPort = socket.localPort || null;
        });
        socket.on('error', (error) => {
          connection.lastError = error.code || error.message;
        });
      }

      const demoConn = socket.__demoConn;
      const connection = this.state.getConnection(demoConn.id);
      const reused = demoConn.requestCount > 0;
      demoConn.requestCount += 1;

      if (connection) {
        connection.requests = demoConn.requestCount;
        connection.status = 'active';
        connection.generationId = runtime.record.id;
        connection.endpointId = endpoint.id;
        connection.tcpPort = socket.localPort || connection.tcpPort;
      }

      attempt.connId = demoConn.id;
      attempt.tcpPort = socket.localPort || attempt.tcpPort;
      attempt.reused = reused;
      attempt.assignedAt = Date.now();

      requestRecord.connId = demoConn.id;
      requestRecord.tcpPort = attempt.tcpPort;
      requestRecord.reused = reused;

      if (reused) {
        attempt.outcome = attempt.outcome || 'reused';
        runtime.record.reuseCount += 1;
        this.state.stats.reusedConnections += 1;
        if (connection) connection.reused = true;
        this.state.log({
          layer: 'reuse',
          kind: 'connection_reused',
          severity: 'success',
          title: `复用 ${demoConn.id}（TCP 源端口 ${attempt.tcpPort || '?'}）`,
          detail:
            `${requestRecord.method} ${requestRecord.path} 在 ${runtime.record.id} 的 keep-alive 池中` +
            `第 ${demoConn.requestCount} 次使用同一条到 ${endpoint.host}:${endpoint.port} 的连接；没有重新 TCP 握手。`,
          meta: {
            requestId: requestRecord.id,
            generationId: runtime.record.id,
            connectionId: demoConn.id,
            tcpPort: attempt.tcpPort,
            requestOrdinal: demoConn.requestCount,
          },
        });
      }

      const connected = socket.readyState === 'open' || socket.connecting === false;
      if (connected) {
        clearTimeout(attempt.connectTimer);
        attempt.phase = 'headers';
        requestRecord.phase = 'waiting_headers';
        this.armHeaderTimeout(proxyReq, attempt);
      } else {
        attempt.phase = 'connect';
        requestRecord.phase = 'connecting';
        socket.once('connect', () => {
          clearTimeout(attempt.connectTimer);
          attempt.phase = 'headers';
          requestRecord.phase = 'waiting_headers';
          this.armHeaderTimeout(proxyReq, attempt);
        });
      }
    });
  }

  armHeaderTimeout(proxyReq, attempt) {
    if (attempt.headerTimer) return;
    attempt.connectedAt = Date.now();
    attempt.headerTimer = setTimeout(() => {
      const error = new Error(`Timed out waiting for response headers after ${this.config.headerTimeoutMs}ms`);
      error.code = 'HEADER_TIMEOUT';
      attempt.phase = 'headers';
      proxyReq.destroy(error);
    }, this.config.headerTimeoutMs);
    attempt.headerTimer.unref?.();
  }

  clearAttemptTimers(attempt) {
    clearTimeout(attempt.connectTimer);
    clearTimeout(attempt.headerTimer);
  }

  sendBadGateway(res, requestRecord, error) {
    if (res.headersSent) {
      try {
        res.destroy(error);
      } catch {
        // ignore
      }
      return;
    }

    const code = classifyError(error, 'attempts');
    requestRecord.phase = 'error';
    requestRecord.errorCode = code;
    requestRecord.endedAt = Date.now();
    this.state.stats.failedRequests += 1;

    const body = JSON.stringify(
      {
        ok: false,
        error: 'all_upstream_attempts_failed',
        code,
        message: error.message,
        requestId: requestRecord.id,
        attempts: requestRecord.attempts.map((attempt) => ({
          number: attempt.number,
          endpoint: attempt.endpointId,
          code: attempt.errorCode,
        })),
      },
      null,
      2,
    );

    res.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-demo-error-code': code,
      'x-demo-request-id': requestRecord.id,
    });
    res.end(body);
  }

  forwardResponse({ req, res, proxyRes, requestRecord, runtime, endpoint, attempt }) {
    this.clearAttemptTimers(attempt);
    attempt.outcome = 'response';
    attempt.statusCode = proxyRes.statusCode;
    attempt.headersAt = Date.now();

    requestRecord.phase = 'streaming';
    requestRecord.statusCode = proxyRes.statusCode;
    requestRecord.originId = proxyRes.headers['x-origin-id'] || endpoint.color || endpoint.kind;
    requestRecord.originPort = Number(proxyRes.headers['x-origin-port']) || endpoint.port;
    requestRecord.originConn = proxyRes.headers['x-origin-conn'] || null;

    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      try {
        res.setHeader(key, value);
      } catch {
        // Invalid header from a fault injector should not crash the proxy.
      }
    }

    res.setHeader('x-demo-proxy-gen', runtime.record.id);
    res.setHeader('x-demo-proxy-conn', attempt.connId || '');
    res.setHeader('x-demo-proxy-reused', String(Boolean(attempt.reused)));
    res.setHeader('x-demo-proxy-attempt', String(attempt.number));
    res.setHeader('x-demo-endpoint', endpoint.id);
    res.setHeader('x-demo-generation-status', runtime.record.status);
    if (attempt.tcpPort) res.setHeader('x-demo-tcp-port', String(attempt.tcpPort));

    const isDownloadStream = requestRecord.path.includes('/download');
    let ndjsonBuffer = Buffer.alloc(0);

    const handleNdjsonLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      try {
        const payload = JSON.parse(line);
        if (typeof payload.seq === 'number') {
          requestRecord.chunkCount = (requestRecord.chunkCount || 0) + 1;
          requestRecord.lastChunkAt = Date.now();
          requestRecord.chunks.push({
            seq: payload.seq,
            at: payload.at || Date.now(),
            origin: payload.origin || requestRecord.originId,
            port: payload.port || requestRecord.originPort,
          });
          if (requestRecord.chunks.length > 14) requestRecord.chunks.shift();
        }
      } catch {
        // A complete non-JSON line is not a numbered chunk; byte count is still correct.
      }
    };

    proxyRes.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      requestRecord.bytes += bytes;
      runtime.record.bytes += bytes;
      this.state.stats.bytesProxied += bytes;

      if (isDownloadStream) {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        ndjsonBuffer = ndjsonBuffer.length === 0
          ? bufferChunk
          : Buffer.concat([ndjsonBuffer, bufferChunk]);
        let newlineIndex = ndjsonBuffer.indexOf(10);
        while (newlineIndex !== -1) {
          handleNdjsonLine(ndjsonBuffer.subarray(0, newlineIndex).toString('utf8'));
          ndjsonBuffer = ndjsonBuffer.subarray(newlineIndex + 1);
          newlineIndex = ndjsonBuffer.indexOf(10);
        }
      }
    });

    proxyRes.on('end', () => {
      if (isDownloadStream && ndjsonBuffer.length > 0) {
        handleNdjsonLine(ndjsonBuffer.toString('utf8'));
      }
      ndjsonBuffer = Buffer.alloc(0);
      attempt.responseEndedAt = Date.now();
      requestRecord.upstreamEndedAt = Date.now();
      const connection = this.state.getConnection(attempt.connId);
      if (connection && runtime.record.status === 'active') {
        connection.status = 'idle';
      }
      // A retired generation must not return this socket to the free pool for
      // future requests. End politely only after the upstream response ended.
      if (runtime.record.status === 'draining' || runtime.record.status === 'closed') {
        attempt.retiredSocketClosedAfterResponse = true;
        try {
          proxyRes.socket?.end?.();
        } catch {
          // ignore
        }
      }
    });

    proxyRes.on('error', (error) => {
      attempt.errorCode = classifyError(error, 'stream');
      attempt.errorMessage = error.message;
      if (!res.headersSent) this.sendBadGateway(res, requestRecord, error);
      else res.destroy(error);
    });

    proxyRes.pipe(res);
  }

  async handle(req, res) {
    if (!this.activeRuntime || this.activeRuntime.endpoints.length === 0) {
      this.sendBadGateway(
        res,
        this.state.addRequest({
          id: this.state.nextId('r'),
          method: req.method,
          path: req.url,
          startedAt: Date.now(),
          phase: 'error',
          attempts: [],
          bytes: 0,
          chunks: [],
        }),
        new Error('尚未获得可用 DNS 端点'),
      );
      return;
    }

    // New requests always bind to the current active generation. A DNS switch
    // retires this runtime but never changes which runtime the handler mutates.
    const runtime = this.activeRuntime;
    runtime.record.activeRequests += 1;
    runtime.record.totalRequests += 1;
    this.state.stats.clientRequests += 1;
    this.state.stats.proxiedRequests += 1;

    const requestRecord = this.state.addRequest({
      id: this.state.nextId('r'),
      method: req.method,
      path: req.url,
      startedAt: Date.now(),
      endedAt: null,
      phase: 'queued',
      statusCode: null,
      generationId: runtime.record.id,
      endpointId: null,
      connId: null,
      tcpPort: null,
      reused: false,
      attemptCount: 0,
      attempts: [],
      bytes: 0,
      chunkCount: 0,
      chunks: [],
      originId: null,
      originPort: null,
      originConn: null,
      errorCode: null,
    });

    let finished = false;
    let activeProxyReq = null;
    const finishRequest = () => {
      if (finished) return;
      finished = true;
      runtime.record.activeRequests = Math.max(0, runtime.record.activeRequests - 1);
      if (!requestRecord.endedAt) requestRecord.endedAt = Date.now();
      if (requestRecord.phase !== 'error') requestRecord.phase = 'done';
      this.state.completedRequests = (this.state.completedRequests || 0) + 1;
      if (requestRecord.statusCode && requestRecord.statusCode < 400) {
        this.state.stats.completedRequests += 1;
      }
      this.finishIfDrained(runtime);
    };

    res.on('finish', finishRequest);
    res.on('close', () => {
      if (!finished && !res.writableFinished) {
        requestRecord.clientAborted = true;
        this.state.log({
          layer: 'client',
          kind: 'client_abort',
          severity: 'warning',
          title: `${requestRecord.id} 浏览器中断请求`,
          detail: `${req.method} ${req.url}；代理将中止到源站的剩余流。`,
        });
        try {
          activeProxyReq?.destroy(new Error('client aborted'));
        } catch {
          // ignore
        }
      }
      finishRequest();
    });

    const retryableMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    let lastError = null;

    for (let index = 0; index < runtime.endpoints.length; index += 1) {
      const endpoint = runtime.endpoints[index];
      requestRecord.attemptCount = index + 1;
      requestRecord.endpointId = endpoint.id;
      requestRecord.phase = 'dialing';

      const attempt = {
        number: index + 1,
        generationId: runtime.record.id,
        endpointId: endpoint.id,
        endpointLabel: endpoint.label || endpoint.id,
        color: endpoint.color || null,
        host: endpoint.host,
        port: endpoint.port,
        connId: null,
        tcpPort: null,
        reused: false,
        startedAt: Date.now(),
        assignedAt: null,
        connectedAt: null,
        headersAt: null,
        responseEndedAt: null,
        endedAt: null,
        statusCode: null,
        outcome: 'pending',
        phase: 'connect',
        errorCode: null,
        errorMessage: null,
      };
      Object.defineProperties(attempt, {
        connectTimer: { value: null, writable: true, enumerable: false },
        headerTimer: { value: null, writable: true, enumerable: false },
      });
      requestRecord.attempts.push(attempt);

      const outcome = await new Promise((resolveAttempt) => {
        let settled = false;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          this.clearAttemptTimers(attempt);
          attempt.endedAt = Date.now();
          resolveAttempt(value);
        };

        const headers = { ...req.headers };
        for (const header of HOP_BY_HOP) delete headers[header];
        headers['x-forwarded-for'] = req.socket.remoteAddress || '127.0.0.1';
        headers['x-forwarded-proto'] = 'http';
        headers['x-demo-request-id'] = requestRecord.id;

        const proxyReq = http.request({
          host: endpoint.host,
          port: endpoint.port,
          method: req.method,
          path: req.url,
          headers,
          agent: runtime.agent,
        });
        activeProxyReq = proxyReq;

        attempt.connectTimer = setTimeout(() => {
          const error = new Error(`TCP connect timeout after ${this.config.connectTimeoutMs}ms`);
          error.code = 'CONNECT_TIMEOUT';
          attempt.phase = 'connect';
          proxyReq.destroy(error);
        }, this.config.connectTimeoutMs);
        attempt.connectTimer.unref?.();

        this.trackSocket(proxyReq, attempt, runtime, endpoint, requestRecord);

        proxyReq.on('response', (proxyRes) => {
          settle({ type: 'response', proxyRes, proxyReq });
        });

        proxyReq.on('error', (error) => {
          attempt.errorCode = classifyError(error, attempt.phase);
          attempt.errorMessage = error.message;
          attempt.outcome = 'error';
          settle({ type: 'error', error, proxyReq });
        });

        if (req.method === 'GET' || req.method === 'HEAD') {
          proxyReq.end();
        } else {
          req.pipe(proxyReq);
        }
      });

      if (outcome.type === 'response') {
        // The browser/curl may have gone away while we were waiting for an
        // upstream. Drain the upstream response instead of writing to a
        // destroyed response and do not start another attempt.
        if (finished || res.destroyed || res.writableEnded) {
          outcome.proxyRes.resume?.();
          return;
        }

        this.forwardResponse({
          req,
          res,
          proxyRes: outcome.proxyRes,
          requestRecord,
          runtime,
          endpoint,
          attempt,
        });
        return;
      }

      if (finished || res.destroyed || res.writableEnded) {
        return;
      }

      lastError = outcome.error;
      const code = classifyError(lastError, attempt.phase);
      attempt.errorCode = code;

      const hasNext = index < runtime.endpoints.length - 1;
      if (hasNext && retryableMethod && !res.headersSent && !finished && !res.destroyed) {
        const next = runtime.endpoints[index + 1];
        runtime.record.retryCount += 1;
        this.state.stats.retryCount += 1;
        requestRecord.phase = 'retrying';

        this.state.log({
          layer: 'retry',
          kind: 'attempt_retry',
          severity: 'warning',
          title: `请求 ${requestRecord.id} 在第 ${attempt.number} 次尝试后重试`,
          detail:
            `${code} at ${endpoint.host}:${endpoint.port}（${endpoint.label || endpoint.id}）` +
            ` → 下一个解析结果 ${next.host}:${next.port}。响应头尚未发送，因此浏览器看到的是一次成功响应。`,
          meta: {
            requestId: requestRecord.id,
            generationId: runtime.record.id,
            failedEndpoint: endpoint.id,
            nextEndpoint: next.id,
            code,
            attempt: attempt.number,
          },
        });
        continue;
      }

      break;
    }

    if (!finished && !res.destroyed && !res.writableEnded) {
      this.sendBadGateway(res, requestRecord, lastError || new Error('unknown proxy error'));
    }
  }

  async close() {
    for (const runtime of this.runtimes.values()) {
      clearTimeout(runtime.hardTimer);
      runtime.agent.destroy();
    }
    this.runtimes.clear();
    this.activeRuntime = null;
  }
}
