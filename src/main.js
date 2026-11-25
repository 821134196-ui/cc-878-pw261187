import http from 'node:http';
import { config, ORIGINS } from './config.js';
import { DemoState } from './state.js';
import { DemoDnsRegistry, startDemoDnsServer } from './dns-demo.js';
import { DnsMonitor } from './resolver.js';
import { ReverseProxy } from './proxy.js';
import { startOrigin, startTarpit } from './origins.js';
import { createDashboardHandler } from './dashboard.js';

async function main() {
  const state = new DemoState(config);
  const registry = new DemoDnsRegistry(config);

  const dnsServer = await startDemoDnsServer({ config, registry, state });

  const origins = await Promise.all([
    startOrigin(ORIGINS.blue, state),
    startOrigin(ORIGINS.green, state),
  ]);
  const tarpit = await startTarpit({ host: '127.0.0.1', port: config.tarpitPort, state });

  const proxy = new ReverseProxy({ config, state });
  const monitor = new DnsMonitor({
    config,
    registry,
    state,
    onEndpointsChanged: (endpoints, context) => proxy.setEndpoints(endpoints, context),
  });

  const dashboard = createDashboardHandler({ state, registry, monitor });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const handled = await dashboard(req, res, url);
      if (handled) return;
      await proxy.handle(req, res);
    } catch (error) {
      state.log({
        layer: 'proxy',
        kind: 'unhandled_server_error',
        severity: 'critical',
        title: 'HTTP 服务未捕获错误',
        detail: error.stack || error.message,
      });
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Demo server error: ${error.message}`);
      } else if (!res.destroyed) {
        res.destroy(error);
      }
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 30_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.proxyPort, config.proxyHost, resolve);
  });

  monitor.start();
  const firstRefresh = await monitor.refresh('boot-wait');
  if (!firstRefresh.endpoints?.length) {
    state.log({
      layer: 'dns',
      kind: 'boot_without_endpoints',
      severity: 'critical',
      title: '启动时没有可用端点',
      detail: 'Dashboard 仍可访问；请检查内置 DNS 端口与日志。',
    });
  }

  const uiUrl = `http://${config.proxyHost}:${config.proxyPort}/__ui/`;
  const proxyUrl = `http://${config.proxyHost}:${config.proxyPort}/who`;
  console.log('\nDNS draining reverse-proxy demo is running:');
  console.log(`  Dashboard : ${uiUrl}`);
  console.log(`  Proxy     : ${proxyUrl}`);
  console.log(`  Origin A  : http://127.0.0.1:${config.bluePort}`);
  console.log(`  Origin B  : http://127.0.0.1:${config.greenPort}`);
  console.log(`  Demo DNS  : udp://127.0.0.1:${config.dnsPort} (${config.dnsName})`);
  console.log('  Press Ctrl+C to stop.\n');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, closing demo...`);
    monitor.stop();
    server.close();
    await proxy.close();
    await Promise.allSettled([
      dnsServer.close(),
      tarpit.close(),
      ...origins.map((origin) => origin.close()),
    ]);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start demo:', error);
  process.exit(1);
});
