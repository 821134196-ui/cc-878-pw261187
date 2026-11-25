import http from 'node:http';
import net from 'node:net';

function sendJson(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function startOrigin(spec, state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'origin'}`);
    const originSocket = req.socket;
    const tracked = originSocket.__demoOriginConn;
    if (tracked) tracked.requestCount += 1;

    const connection = tracked ? state.getConnection(tracked.id) : null;
    if (connection) {
      connection.requests = tracked.requestCount;
      connection.status = 'active';
      connection.lastRequestAt = Date.now();
    }

    res.on('finish', () => {
      const finishedConnection = tracked ? state.getConnection(tracked.id) : null;
      if (finishedConnection && !originSocket.destroyed) {
        finishedConnection.status = 'idle';
      }
    });

    res.setHeader('x-origin-id', spec.id);
    res.setHeader('x-origin-name', encodeURIComponent(spec.label));
    res.setHeader('x-origin-color', spec.color);
    res.setHeader('x-origin-port', String(spec.port));
    res.setHeader('x-origin-pid', String(process.pid));
    if (tracked) {
      res.setHeader('x-origin-conn', tracked.id);
      res.setHeader('x-origin-request-count', String(tracked.requestCount));
    }
    res.setHeader('x-origin-peer-port', String(originSocket.remotePort || ''));

    state.log({
      layer: 'origin',
      kind: 'origin_request',
      severity: 'info',
      title: `${spec.label} 收到请求`,
      detail:
        `${req.method} ${url.pathname} · 源站连接 ${tracked?.id || '?'} ` +
        `(对端 TCP 端口 ${originSocket.remotePort || '?'}) 第 ${tracked?.requestCount || 1} 次请求`,
      meta: {
        origin: spec.id,
        port: spec.port,
        path: req.url,
        originConnectionId: tracked?.id,
        peerPort: originSocket.remotePort,
        requestCount: tracked?.requestCount,
        proxyRequestId: req.headers['x-demo-request-id'],
      },
    });

    if (url.pathname === '/download' || url.pathname === '/stream') {
      const chunks = Math.min(30, Math.max(2, Number(url.searchParams.get('chunks')) || 9));
      const intervalMs = Math.min(2000, Math.max(120, Number(url.searchParams.get('interval')) || 650));
      const padBytes = Math.min(2048, Math.max(0, Number(url.searchParams.get('pad')) || 96));
      const startedAt = Date.now();

      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-demo-stream': 'download',
      });

      res.write(
        JSON.stringify({
          type: 'start',
          origin: spec.id,
          label: spec.label,
          port: spec.port,
          color: spec.color,
          chunks,
          intervalMs,
          at: new Date().toISOString(),
        }) + '\n',
      );

      let sequence = 0;
      const timer = setInterval(() => {
        if (res.destroyed || req.destroyed) {
          clearInterval(timer);
          return;
        }

        if (sequence >= chunks) {
          clearInterval(timer);
          res.write(
            JSON.stringify({
              type: 'end',
              origin: spec.id,
              port: spec.port,
              durationMs: Date.now() - startedAt,
              at: new Date().toISOString(),
            }) + '\n',
            () => res.end(),
          );
          state.log({
            layer: 'origin',
            kind: 'download_finished',
            severity: 'success',
            title: `${spec.label} 的慢下载正常结束`,
            detail: `端口 ${spec.port} · ${chunks} 个数据块已全部写出；旧连接此刻才允许关闭/排空。`,
          });
          return;
        }

        const payload = {
          type: 'chunk',
          seq: sequence,
          origin: spec.id,
          port: spec.port,
          color: spec.color,
          at: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          pad: '·'.repeat(padBytes),
        };
        res.write(JSON.stringify(payload) + '\n');
        sequence += 1;
      }, intervalMs);

      req.on('close', () => clearInterval(timer));
      res.on('close', () => clearInterval(timer));
      return;
    }

    if (url.pathname === '/slow-headers') {
      const delay = Math.min(10000, Math.max(0, Number(url.searchParams.get('ms')) || 3000));
      setTimeout(() => {
        sendJson(res, 200, { ok: true, origin: spec.id, delayedMs: delay, at: new Date().toISOString() });
      }, delay);
      return;
    }

    sendJson(res, 200, {
      ok: true,
      origin: spec.id,
      label: spec.label,
      color: spec.color,
      port: spec.port,
      pid: process.pid,
      path: req.url,
      receivedAt: new Date().toISOString(),
      connection: tracked
        ? {
            id: tracked.id,
            requestCount: tracked.requestCount,
            peerPort: originSocket.remotePort,
            localPort: originSocket.localPort,
          }
        : null,
      proxyRequestId: req.headers['x-demo-request-id'] || null,
    });
  });

  server.on('connection', (socket) => {
    const connId = state.nextId('o');
    socket.__demoOriginConn = { id: connId, requestCount: 0 };
    state.addConnection({
      side: 'origin',
      id: connId,
      origin: spec.id,
      color: spec.color,
      endpointLabel: spec.label,
      localPort: spec.port,
      peerPort: socket.remotePort,
      tcpPort: socket.remotePort,
      status: 'open',
      createdAt: Date.now(),
      closedAt: null,
      requests: 0,
    });

    socket.on('close', () => {
      const record = state.getConnection(connId);
      if (record) {
        record.status = 'closed';
        record.closedAt = Date.now();
      }
    });
    socket.on('error', () => {
      // Proxy-driven resets during retry/drain are expected.
    });
  });

  server.keepAliveTimeout = 20000;
  server.headersTimeout = 22000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(spec.port, spec.host || '127.0.0.1', () => {
      state.log({
        layer: 'origin',
        kind: 'origin_listening',
        severity: 'success',
        title: `${spec.label} 已启动`,
        detail: `http://127.0.0.1:${spec.port}`,
      });
      resolve({
        server,
        spec,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

export function startTarpit({ host, port, state }) {
  const server = net.createServer((socket) => {
    const connId = state.nextId('t');
    socket.__tarpitId = connId;
    state.log({
      layer: 'origin',
      kind: 'tarpit_accepted',
      severity: 'warning',
      title: `Tarpit :${port} 接受 TCP 连接但不响应 HTTP`,
      detail: `连接 ${connId} · 对端端口 ${socket.remotePort}；代理将触发 HEADER_TIMEOUT 并切换到下一个解析结果。`,
    });
    socket.on('error', () => {
      // Expected when the proxy destroys the timed-out request.
    });
    setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, 10000).unref?.();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      state.log({
        layer: 'origin',
        kind: 'tarpit_listening',
        severity: 'info',
        title: `超时故障端点已启动`,
        detail: `tcp://${host}:${port}（接受连接、永不返回响应头）`,
      });
      resolve({ server, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
