import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_000) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(req, res, pathname) {
  let relativePath = pathname.replace(/^\/__ui\/?/, '');
  if (!relativePath || relativePath === '/') relativePath = 'index.html';
  const filePath = path.resolve(publicDir, relativePath);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== path.join(publicDir, 'index.html')) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return true;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { ok: false, error: 'not_found', path: pathname });
  }
  return true;
}

export function createDashboardHandler({ state, registry, monitor }) {
  return async function dashboardHandler(req, res, url) {
    const { pathname } = url;

    if (pathname === '/' ) {
      res.writeHead(302, { location: '/__ui/' });
      res.end();
      return true;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (pathname === '/__ui') {
      res.writeHead(302, { location: '/__ui/' });
      res.end();
      return true;
    }

    if (pathname.startsWith('/__ui/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
      }
      return serveStatic(req, res, pathname);
    }

    if (pathname === '/__api/state' && req.method === 'GET') {
      sendJson(res, 200, state.snapshot());
      return true;
    }

    if (pathname === '/__api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');

      const sendState = () => {
        try {
          res.write(`event: state\ndata: ${JSON.stringify(state.snapshot())}\n\n`);
        } catch {
          clearInterval(timer);
        }
      };
      sendState();
      const timer = setInterval(sendState, 250);
      req.on('close', () => clearInterval(timer));
      return true;
    }

    if (pathname === '/__api/switch' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const nextColor =
          body.color === 'blue' || body.color === 'green'
            ? body.color
            : registry.activeColor === 'blue'
              ? 'green'
              : 'blue';

        registry.update({ activeColor: nextColor });
        state.control.activeColor = registry.activeColor;
        state.log({
          layer: 'control',
          kind: 'manual_switch',
          severity: 'info',
          title: `控制面把 DNS 源站地址改为 ${nextColor}`,
          detail: `DNS serial 增至 ${registry.serial}；等待下一次周期刷新，也可立即刷新。按钮会触发一次立即刷新以便演示。`,
        });
        await monitor.refresh('control-switch');
        sendJson(res, 200, { ok: true, control: state.control, dns: state.dns });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return true;
    }

    if (pathname === '/__api/fault' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const allowed = new Set(['none', 'dns-timeout', 'conn-refused', 'header-timeout']);
        const mode = allowed.has(body.mode) ? body.mode : 'none';
        registry.update({ faultMode: mode });
        state.control.faultMode = registry.faultMode;
        state.log({
          layer: 'control',
          kind: 'fault_mode_changed',
          severity: mode === 'none' ? 'info' : 'warning',
          title: `故障注入模式：${mode}`,
          detail:
            mode === 'dns-timeout'
              ? 'DNS 响应包含一个 A 查询无响应的目标，刷新结果将出现 DNS_TIMEOUT。'
              : mode === 'conn-refused'
                ? 'SRV 中加入无监听端口，代理尝试将收到 ECONNREFUSED 并重试。'
                : mode === 'header-timeout'
                  ? 'SRV 中加入本地 tarpit，TCP 可连接但 HEADER_TIMEOUT，随后重试。'
                  : '已移除故障解析结果。',
        });
        await monitor.refresh('fault-change');
        sendJson(res, 200, { ok: true, control: state.control, dns: state.dns });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return true;
    }

    if (pathname === '/__api/refresh' && req.method === 'POST') {
      const result = await monitor.refresh('manual');
      sendJson(res, 200, { ok: true, result, state: state.snapshot() });
      return true;
    }

    if (pathname.startsWith('/__api/')) {
      sendJson(res, 404, { ok: false, error: 'unknown_api', path: pathname });
      return true;
    }

    return false;
  };
}
