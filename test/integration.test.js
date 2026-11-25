import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const baseUrl = 'http://127.0.0.1:18080';
let child;
let output = '';

const testEnv = {
  ...process.env,
  PROXY_HOST: '127.0.0.1',
  PROXY_PORT: '18080',
  BLUE_PORT: '14101',
  GREEN_PORT: '14102',
  DNS_PORT: '43530',
  TARPIT_PORT: '14103',
  DEAD_PORT: '14199',
  DNS_REFRESH_MS: '1000',
  DNS_QUERY_TIMEOUT_MS: '400',
  HEADER_TIMEOUT_MS: '700',
};

async function getState() {
  const response = await fetch(`${baseUrl}/__api/state`);
  assert.ok(response.ok);
  return response.json();
}

async function postApi(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  assert.ok(response.ok, `${path} failed: ${JSON.stringify(json)}`);
  return json;
}

async function waitFor(predicate, { timeout = 8000, interval = 100, message = 'condition' } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${lastError.message}` : ''}`);
}

test.before(async () => {
  child = spawn(process.execPath, ['src/main.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: testEnv,
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`demo server exited early code=${code} signal=${signal}\n${output}\n`);
    }
  });

  await waitFor(
    async () => {
      const state = await getState();
      return state.generations.length > 0;
    },
    { timeout: 15000, message: 'initial DNS generation' },
  );
});

test.after(async () => {
  if (!child?.killed) child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test('three sequential proxied requests reuse the same proxy and origin TCP connection', async () => {
  const connectionIds = [];
  const reusedHeaders = [];
  const tcpPorts = [];

  for (let index = 1; index <= 3; index += 1) {
    const response = await fetch(`${baseUrl}/who?test=reuse&i=${index}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.origin, 'blue');
    assert.equal(body.port, 14101);
    connectionIds.push(response.headers.get('x-demo-proxy-conn'));
    reusedHeaders.push(response.headers.get('x-demo-proxy-reused'));
    tcpPorts.push(response.headers.get('x-demo-tcp-port'));
  }

  assert.ok(connectionIds[0]);
  assert.equal(connectionIds[1], connectionIds[0]);
  assert.equal(connectionIds[2], connectionIds[0]);
  assert.deepEqual(reusedHeaders, ['false', 'true', 'true']);
  assert.equal(tcpPorts[1], tcpPorts[0]);
  assert.equal(tcpPorts[2], tcpPorts[0]);
});

test('DNS switch drains old generation but lets an in-flight download finish', async () => {
  await postApi('/__api/fault', { mode: 'none' });
  await postApi('/__api/switch', { color: 'blue' });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Parallel warm requests create several free sockets.
  await Promise.all(
    Array.from({ length: 4 }, (_, index) => fetch(`${baseUrl}/who?test=warm&i=${index}`)),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));

  const downloadResponse = await fetch(`${baseUrl}/download?test=drain&chunks=6&interval=250`);
  assert.equal(downloadResponse.status, 200);
  const oldGeneration = downloadResponse.headers.get('x-demo-proxy-gen');
  assert.match(oldGeneration, /^g\d+$/);

  const downloadTextPromise = downloadResponse.text();
  await new Promise((resolve) => setTimeout(resolve, 450));

  await postApi('/__api/switch', { color: 'green' });

  const newResponse = await fetch(`${baseUrl}/who?test=after-switch`);
  const newBody = await newResponse.json();
  assert.equal(newBody.origin, 'green');
  assert.equal(newBody.port, 14102);
  assert.notEqual(newResponse.headers.get('x-demo-proxy-gen'), oldGeneration);

  const downloadText = await downloadTextPromise;
  const chunkCount = (downloadText.match(/"type":"chunk"/g) || []).length;
  assert.equal(chunkCount, 6, 'the pre-switch download must receive every chunk');
  assert.match(downloadText, /"origin":"blue"/);

  const state = await waitFor(
    async () => {
      const current = await getState();
      const generation = current.generations.find((g) => g.id === oldGeneration);
      if (generation?.status === 'closed') return current;
      return null;
    },
    { timeout: 8000, message: 'old generation drain completion' },
  );

  const oldRecord = state.generations.find((g) => g.id === oldGeneration);
  assert.equal(oldRecord.status, 'closed');
  assert.ok(oldRecord.totalRequests >= 1);
  assert.ok(state.events.some((event) => event.kind === 'drain_started'));
  assert.ok(state.events.some((event) => event.kind === 'drain_completed'));
});

test('partial DNS A-record timeout is reported separately and leaves healthy endpoints', async () => {
  const result = await postApi('/__api/fault', { mode: 'dns-timeout' });
  assert.equal(result.dns.status, 'partial_timeout');

  const state = await getState();
  assert.equal(state.dns.status, 'partial_timeout');
  assert.ok(
    state.dns.resolutions.some((item) => item.status === 'timeout' && item.code === 'DNS_TIMEOUT'),
    'one resolution should be DNS_TIMEOUT',
  );
  assert.ok(
    state.dns.resolutions.some((item) => item.status === 'ok' && item.port === 14102),
    'healthy green endpoint should remain usable',
  );
});

test('ECONNREFUSED on one resolved endpoint is retried at the proxy layer', async () => {
  await postApi('/__api/fault', { mode: 'conn-refused' });
  const response = await fetch(`${baseUrl}/who?test=retry-refused`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-demo-proxy-attempt'), '2');
  const body = await response.json();
  assert.equal(body.origin, 'green');

  const state = await waitFor(
    async () => {
      const current = await getState();
      const request = current.requests.find((item) => item.path.includes('test=retry-refused'));
      return request?.attempts?.length === 2 ? current : null;
    },
    { message: 'recorded retry attempts' },
  );

  const request = state.requests.find((item) => item.path.includes('test=retry-refused'));
  assert.equal(request.attempts[0].errorCode, 'ECONNREFUSED');
  assert.equal(request.attempts[0].port, 14199);
  assert.equal(request.attempts[1].outcome, 'response');
  assert.ok(state.events.some((event) => event.kind === 'attempt_retry'));
});

test('accepted tarpit endpoint produces HEADER_TIMEOUT and then succeeds on retry', async () => {
  await postApi('/__api/fault', { mode: 'header-timeout' });
  const response = await fetch(`${baseUrl}/who?test=retry-header-timeout`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-demo-proxy-attempt'), '2');

  const state = await waitFor(
    async () => {
      const current = await getState();
      const request = current.requests.find((item) => item.path.includes('test=retry-header-timeout'));
      return request?.attempts?.length === 2 ? current : null;
    },
    { message: 'recorded header-timeout attempts' },
  );

  const request = state.requests.find((item) => item.path.includes('test=retry-header-timeout'));
  assert.equal(request.attempts[0].errorCode, 'HEADER_TIMEOUT');
  assert.equal(request.attempts[0].port, 14103);
  assert.equal(request.attempts[1].outcome, 'response');
});
