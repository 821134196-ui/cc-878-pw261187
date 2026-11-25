const $ = (id) => document.getElementById(id);

let state = null;
let serverClockOffset = 0;
let eventFilter = 'all';
let eventSourceOk = false;

const phaseText = {
  queued: '排队中',
  dialing: '建连中',
  connecting: '建连中',
  waiting: '等响应头',
  waiting_headers: '等响应头',
  retrying: '重试中',
  streaming: '下载/传输中',
  done: '已完成',
  error: '失败',
};

const generationText = {
  active: '当前活跃',
  draining: '排空中',
  closed: '已关闭',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function serverNow() {
  return Date.now() + serverClockOffset;
}

function clock(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function duration(from, to = serverNow()) {
  if (!from) return '—';
  return `${Math.max(0, to - from)} ms`;
}

function shortId(id) {
  return id || '—';
}

function setAction(text) {
  $('actionResult').textContent = text;
}

async function postApi(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function httpResponseError(response) {
  const body = await response.json().catch(() => ({}));
  const attemptCodes = Array.isArray(body.attempts)
    ? body.attempts.map((attempt) => attempt.code).filter(Boolean).join(' → ')
    : '';
  const codePrefix = body.code ? `[${body.code}] ` : '';
  const attemptSuffix = attemptCodes ? `；各次尝试：${attemptCodes}` : '';
  return new Error(
    `HTTP ${response.status} ${codePrefix}${body.message || body.error || response.statusText}${attemptSuffix}`,
  );
}

async function fetchJsonChecked(input) {
  const response = await fetch(input);
  if (!response.ok) throw await httpResponseError(response);
  return response.json().catch(() => ({}));
}

function portLabel(key, fallback) {
  return state?.config?.[key] || fallback;
}

function statusPill(status, okText, map) {
  const [className, text] = map[status] || ['pill-neutral', status || 'unknown'];
  return `<span class="pill ${className}">${escapeHtml(okText || text)}</span>`;
}

function dnsPill(status) {
  const map = {
    ok: ['pill-success', 'DNS 正常'],
    checking: ['pill-blue', '刷新中'],
    pending: ['pill-neutral', '等待首次刷新'],
    partial_timeout: ['pill-warning', '部分解析超时'],
    partial_error: ['pill-warning', '部分解析错误'],
    error: ['pill-critical', 'DNS 刷新失败'],
  };
  return statusPill(status, null, map);
}

function generationPill(status) {
  const map = {
    active: ['pill-success', generationText.active],
    draining: ['pill-warning', generationText.draining],
    closed: ['pill-muted', generationText.closed],
  };
  return statusPill(status, null, map);
}

function requestPill(request) {
  if (request.phase === 'error') return '<span class="pill pill-critical">失败</span>';
  if (request.phase === 'done') return `<span class="pill pill-success">${request.statusCode || '完成'}</span>`;
  if (request.phase === 'retrying') return '<span class="pill pill-serious">重试中</span>';
  if (request.phase === 'streaming') return '<span class="pill pill-blue">传输中</span>';
  if (request.phase === 'waiting_headers') return '<span class="pill pill-blue">等响应头</span>';
  if (request.phase === 'connecting' || request.phase === 'dialing') {
    return '<span class="pill pill-neutral">建连中</span>';
  }
  return `<span class="pill pill-neutral">${escapeHtml(phaseText[request.phase] || request.phase)}</span>`;
}

function renderControls() {
  $('proxyUrl').textContent = `127.0.0.1:${state.config.proxyPort}`;
  const originPortsStatic = $('originPortsStatic');
  if (originPortsStatic) {
    originPortsStatic.textContent = `:${state.config.bluePort} / :${state.config.greenPort}`;
  }
  const switchBluePort = $('switchBluePort');
  if (switchBluePort) switchBluePort.textContent = `:${state.config.bluePort}`;
  const switchGreenPort = $('switchGreenPort');
  if (switchGreenPort) switchGreenPort.textContent = `:${state.config.greenPort}`;
  $('dnsName').textContent = state.dns.name;
  $('dnsServer').textContent = state.dns.server;
  $('dnsInterval').textContent = `${state.config.dnsRefreshMs} ms`;
  const dnsMap = {
    ok: ['pill-success', 'DNS 正常'],
    checking: ['pill-blue', '刷新中'],
    pending: ['pill-neutral', '等待首次刷新'],
    partial_timeout: ['pill-warning', '部分解析超时'],
    partial_error: ['pill-warning', '部分解析错误'],
    error: ['pill-critical', 'DNS 刷新失败'],
  };
  const [dnsClass, dnsText] = dnsMap[state.dns.status] || ['pill-neutral', state.dns.status];
  const dnsStatusElement = $('dnsStatusPill');
  dnsStatusElement.className = `pill ${dnsClass}`;
  dnsStatusElement.textContent = dnsText;
  $('dnsMessage').textContent = state.dns.message;
  $('dnsLastTick').textContent = state.dns.lastTickAt
    ? `${clock(state.dns.lastTickAt)} · ${state.dns.lastDurationMs ?? '?'} ms · ${state.dns.lastReason}`
    : '—';

  const remain = Math.max(0, (state.dns.nextRefreshAt || 0) - serverNow());
  const pct = Math.min(100, Math.max(0, (remain / state.config.dnsRefreshMs) * 100));
  $('countdownBar').style.width = `${pct}%`;
  $('countdownText').textContent = `${(remain / 1000).toFixed(1)}s 后周期刷新 · 第 ${state.dns.tickCount} 次 · serial ${state.dns.serial}`;

  const active = state.generations.find((g) => g.status === 'active');
  const inflight = state.generations.reduce((sum, g) => sum + (g.activeRequests || 0), 0);
  const busyDraining = state.generations.find((g) => g.status === 'draining' && g.activeRequests > 0);
  const globalPill = $('globalPill');
  if (!eventSourceOk) {
    globalPill.className = 'pill pill-critical';
    globalPill.textContent = 'SSE 断开，重连中…';
  } else if (inflight > 0 && busyDraining) {
    globalPill.className = 'pill pill-warning';
    globalPill.textContent = `${inflight} 个在途请求 · 旧代际 ${busyDraining.id} 排空中`;
  } else if (inflight > 0) {
    globalPill.className = 'pill pill-warning';
    globalPill.textContent = `${inflight} 个在途请求 · ${active ? active.id : '未知代际'}`;
  } else {
    globalPill.className = 'pill pill-success';
    globalPill.textContent = `代理就绪 · ${active ? active.id : '等待 DNS'}`;
  }

  document.querySelectorAll('.fault-btn').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.mode === state.control.faultMode);
  });

  const headerTimeoutSeconds = ((state.config.headerTimeoutMs || 1400) / 1000).toFixed(1);
  const hints = {
    none: '当前 SRV 只包含正在使用的源站端口。',
    'dns-timeout': 'SRV 中加入 ghost 目标；演示 DNS 不回答它的 A 查询。健康端点仍可用，状态明确标为 DNS_TIMEOUT。',
    'conn-refused': `SRV 中加入 :${state.config.deadPort}（无监听）。第一个尝试会立刻 ECONNREFUSED，代理重试健康端点。`,
    'header-timeout': `SRV 中加入 :${state.config.tarpitPort} tarpit。TCP 能连上，但 ${headerTimeoutSeconds} 秒内没有响应头，产生 HEADER_TIMEOUT 后重试。`,
  };
  $('faultHint').textContent = hints[state.control.faultMode] || '';
}

function renderStats() {
  const items = [
    ['客户端请求', state.stats.clientRequests],
    ['连接复用', state.stats.reusedConnections],
    ['代理重试', state.stats.retryCount],
    ['DNS 刷新', state.stats.dnsTicks],
    ['部分解析超时', state.stats.partialTimeouts],
    ['排空完成', state.stats.drainCompleted],
  ];
  $('statsGrid').innerHTML = items
    .map(([label, value]) => `<div class="stat"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${label}</div></div>`)
    .join('');
}

function endpointBadge(endpoint) {
  const className = endpoint.color === 'blue' ? 'blue' : endpoint.color === 'green' ? 'teal' : '';
  const label = endpoint.color === 'blue' ? 'A' : endpoint.color === 'green' ? 'B' : '!';
  return `<span class="badge ${className}">${label} · ${escapeHtml(endpoint.host)}:${escapeHtml(endpoint.port)}</span>`;
}

function renderDnsAnswers() {
  const answers = state.dns.resolutions || [];
  if (!answers.length) {
    $('dnsAnswers').innerHTML = '<div class="empty-state">尚无解析结果</div>';
    return;
  }

  $('dnsAnswers').innerHTML = answers
    .slice()
    .reverse()
    .map((item) => {
      const statusClass = item.status === 'ok' ? '' : item.code === 'DNS_TIMEOUT' ? 'timeout' : 'error';
      const right =
        item.status === 'ok'
          ? `<span class="badge">${escapeHtml((item.addresses || []).join(','))}</span>`
          : `<span class="badge ${item.code === 'DNS_TIMEOUT' ? 'dns' : 'error'}">${escapeHtml(item.code)}</span>`;
      return `
        <div class="dns-record">
          <span class="record-status ${statusClass}"></span>
          <div>
            <strong>${escapeHtml(item.label || item.target)}</strong><br />
            <code>${escapeHtml(item.target)}:${escapeHtml(item.port)}</code>
          </div>
          ${right}
        </div>`;
    })
    .join('');
}

function proxyConnectionsForGeneration(genId) {
  return state.connections.filter((conn) => conn.generationId === genId && conn.side !== 'origin');
}

function renderSocketChips(gen) {
  const connections = proxyConnectionsForGeneration(gen.id).slice(-10);
  if (!connections.length) return '<span class="node-sub">暂无代理侧连接</span>';
  return `<div class="socket-chips">${connections
    .map((conn) => {
      const classes = ['socket-chip'];
      if (conn.status === 'closed') classes.push('closed');
      else if (conn.requests > 1) classes.push('reused');
      else if (conn.status === 'idle') classes.push('idle');
      else classes.push('active');
      const title = `${conn.id} · ${conn.status} · ${conn.requests} requests · TCP ${conn.tcpPort || '?'}`;
      return `<span class="${classes.join(' ')}" title="${escapeHtml(title)}">${escapeHtml(conn.id)}·${conn.requests}${conn.tcpPort ? `·:${conn.tcpPort}` : ''}</span>`;
    })
    .join('')}</div>`;
}

function renderTopology() {
  const blueActive = state.connections.filter(
    (c) => c.side === 'origin' && c.origin === 'blue' && c.status === 'active',
  ).length;
  const greenActive = state.connections.filter(
    (c) => c.side === 'origin' && c.origin === 'green' && c.status === 'active',
  ).length;
  const blueConns = state.connections.filter((c) => c.side === 'origin' && c.origin === 'blue' && c.status !== 'closed').length;
  const greenConns = state.connections.filter((c) => c.side === 'origin' && c.origin === 'green' && c.status !== 'closed').length;
  const inflight = state.generations.reduce((sum, gen) => sum + (gen.activeRequests || 0), 0);

  const generations = state.generations
    .slice(-3)
    .reverse()
    .map((gen) => {
      const idle = proxyConnectionsForGeneration(gen.id).filter((c) => c.status === 'idle').length;
      const statusClass = ['active', 'draining', 'closed'].includes(gen.status) ? gen.status : 'closed';
      return `
        <div class="pool-gen is-${statusClass}">
          <div class="pool-gen-head">
            <span class="pool-gen-title">${escapeHtml(gen.id)} · ${generationText[gen.status] || escapeHtml(gen.status)}</span>
            ${generationPill(gen.status)}
          </div>
          ${renderSocketChips(gen)}
          <div class="mini-counts">
            <span>active <b>${gen.activeRequests}</b></span>
            <span>idle <b>${idle}</b></span>
            <span>new <b>${gen.connectionsCreated}</b></span>
            <span style="color:#086008">reuse <b>${gen.reuseCount}</b></span>
            <span>killed idle <b>${gen.idleSocketsDestroyed}</b></span>
          </div>
        </div>`;
    })
    .join('');

  const faultMode = state.control.faultMode;
  const headerTimeoutSeconds = ((state.config.headerTimeoutMs || 1400) / 1000).toFixed(1);
  const faultBody =
    faultMode === 'dns-timeout'
      ? '<strong>Ghost DNS 记录</strong><div class="node-sub">A 查询被丢弃 · DNS_TIMEOUT</div>'
      : faultMode === 'conn-refused'
        ? `<strong>Dead endpoint :${state.config.deadPort}</strong><div class="node-sub">无监听 · ECONNREFUSED → retry</div>`
        : faultMode === 'header-timeout'
          ? `<strong>Tarpit :${state.config.tarpitPort}</strong><div class="node-sub">TCP open · no headers · ${headerTimeoutSeconds}s HEADER_TIMEOUT → retry</div>`
          : '<strong>未注入故障</strong><div class="node-sub">可在左上选择故障模式</div>';

  $('topology').innerHTML = `
    <div class="topo-node node-browser">
      <h3><span class="node-icon"></span>浏览器 / curl</h3>
      <div class="node-sub">页面按钮发起同源 HTTP 请求；慢下载用 ReadableStream 持续读取。</div>
      <div class="mini-counts"><span>在途 <b>${inflight}</b></span></div>
    </div>
    <div class="topo-arrow ${inflight ? 'arrow-active' : ''}">→<span class="arrow-label">HTTP :${state.config.proxyPort}</span></div>
    <div class="topo-node node-proxy">
      <h3><span class="node-icon"></span>反向代理 + 周期 DNS + 分代 Agent</h3>
      <div class="node-sub">每 ${state.config.dnsRefreshMs}ms 解析 SRV/A；端点集合变化才换池。复用、重试、排空都发生在这一层。</div>
      ${generations || '<div class="empty-state">等待第一个连接代际</div>'}
    </div>
    <div class="topo-arrow ${blueActive + greenActive ? 'arrow-active' : ''}">→<span class="arrow-label">TCP keep-alive</span></div>
    <div class="origin-stack">
      <div class="topo-node topo-node node-origin-blue">
        <h3><span class="node-icon"></span>源站 A Blue · :${state.config.bluePort}</h3>
        <div class="node-sub">${blueActive} 个活动响应 · ${blueConns} 条 open 源站连接</div>
      </div>
      <div class="topo-node topo-node node-origin-green">
        <h3><span class="node-icon"></span>源站 B Green · :${state.config.greenPort}</h3>
        <div class="node-sub">${greenActive} 个活动响应 · ${greenConns} 条 open 源站连接</div>
      </div>
      <div class="topo-node node-origin-fault">
        <h3><span class="node-icon"></span>故障域</h3>
        ${faultBody}
      </div>
    </div>
  `;
}

function renderLiveRoutes() {
  const active = state.requests.filter((r) => !r.endedAt).slice(-6).reverse();
  if (!active.length) {
    $('liveRoutes').innerHTML = '<div class="empty-state">当前没有在途请求。运行“连发 3 个请求”或“一键演示”观察连接行为。</div>';
    return;
  }

  $('liveRoutes').innerHTML = active
    .map((request) => {
      const attempt = request.attempts[request.attempts.length - 1] || {};
      const phase = requestPill(request);
      const endpoint = attempt.port ? `:${attempt.port}` : request.endpointId || '—';
      const conn = attempt.connId || request.connId || '分配中';
      const reused = attempt.reused || request.reused ? '<span class="badge reuse">reused</span>' : '<span class="badge no-reuse">new</span>';
      return `
        <div class="route-line">
          <span class="badge">${escapeHtml(request.id)}</span>
          <div class="route-flow">
            <span class="route-path">${escapeHtml(request.method)} ${escapeHtml(request.path)}</span><br />
            Browser → proxy <b>${escapeHtml(request.generationId || '?')}</b> → endpoint <b>${escapeHtml(endpoint)}</b>
            → conn <b>${escapeHtml(conn)}</b> ${reused}
            ${request.attemptCount > 1 ? `<span class="badge retry">attempt ${request.attemptCount}</span>` : ''}
          </div>
          ${phase}
        </div>`;
    })
    .join('');
}

function renderAttempts(request) {
  if (!request.attempts?.length) return '';
  return `<div class="attempt-list">${request.attempts
    .map((attempt) => {
      const failed = Boolean(attempt.errorCode);
      const success = attempt.outcome === 'response';
      const pendingLabel = attempt.phase === 'headers' ? '等响应头' : '建连中';
      const right = failed
        ? `<span class="badge error">${escapeHtml(attempt.errorCode)}</span>`
        : `<span class="badge">${escapeHtml(attempt.statusCode || pendingLabel)}</span>`;
      return `
        <div class="attempt-row ${failed ? 'failed' : success ? 'success' : ''}">
          <span>#${attempt.number}</span>
          <span>
            <code>${escapeHtml(attempt.host)}:${escapeHtml(attempt.port)}</code>
            ${attempt.connId ? ` · <code>${escapeHtml(attempt.connId)}</code>` : ''}
            ${attempt.reused ? '<span class="badge reuse">复用</span>' : ''}
            ${attempt.tcpPort ? ` · TCP :${attempt.tcpPort}` : ''}
            ${failed ? `<br /><span style="color:#942020">${escapeHtml(attempt.errorMessage || '')}</span>` : ''}
          </span>
          <span>${right}<br />${duration(attempt.startedAt, attempt.endedAt || serverNow())}</span>
        </div>`;
    })
    .join('')}</div>`;
}

function renderChunks(request) {
  if (!request.chunkCount && request.phase !== 'streaming') return '';
  let expected = 9;
  try {
    expected = Number(new URL(request.path, location.origin).searchParams.get('chunks')) || 9;
  } catch {
    // keep default
  }
  expected = Math.max(expected, request.chunkCount || 0);
  const green = request.originId === 'green';
  const dots = Array.from({ length: expected }, (_, index) => {
    const received = index < request.chunkCount;
    return `<span class="chunk-dot ${received ? `received ${green ? 'green' : ''}` : ''}" title="chunk ${index}">${index}</span>`;
  }).join('');
  return `<div class="chunk-track" aria-label="已接收 ${request.chunkCount || 0}/${expected} 块">${dots}</div>`;
}

function renderRequests() {
  const container = $('requestList');
  const scrollTop = container.scrollTop;
  const requests = state.requests.slice().reverse();
  if (!requests.length) {
    container.innerHTML = '<div class="empty-state">还没有经过代理的请求。</div>';
    return;
  }

  container.innerHTML = requests
    .map((request) => {
      const originClass =
        request.phase === 'error'
          ? 'is-error'
          : request.originId === 'blue'
            ? 'origin-blue'
            : request.originId === 'green'
              ? 'origin-green'
              : 'origin-fault';
      const age = duration(request.startedAt, request.endedAt || serverNow());
      return `
        <article class="request-card ${originClass}">
          <div class="request-top">
            <div class="request-title">
              <span class="badge">${escapeHtml(request.id)}</span>
              <span class="request-path">${escapeHtml(request.method)} ${escapeHtml(request.path)}</span>
            </div>
            ${requestPill(request)}
          </div>
          <div class="request-meta">
            <span>耗时 <b>${age}</b></span>
            <span>代际 <b>${escapeHtml(request.generationId || '—')}</b></span>
            <span>源站 <b>${escapeHtml(request.originId || request.endpointId || '—')}${request.originPort ? `:${request.originPort}` : ''}</b></span>
            <span>代理连接 <b>${escapeHtml(request.connId || '—')}</b></span>
            <span>TCP 源端口 <b>${escapeHtml(request.tcpPort || '—')}</b></span>
            <span>源站连接 <b>${escapeHtml(request.originConn || '—')}</b></span>
            <span>字节 <b>${request.bytes}</b></span>
            ${request.reused ? '<span class="badge reuse">连接复用</span>' : '<span class="badge no-reuse">新连接</span>'}
            ${request.attemptCount > 1 ? `<span class="badge retry">${request.attemptCount} 次尝试</span>` : ''}
            ${request.errorCode ? `<span class="badge error">${escapeHtml(request.errorCode)}</span>` : ''}
          </div>
          ${renderAttempts(request)}
          ${renderChunks(request)}
        </article>`;
    })
    .join('');
  container.scrollTop = scrollTop;
}

function renderGenerations() {
  const generations = state.generations.slice().reverse();
  if (!generations.length) {
    $('generationList').innerHTML = '<div class="empty-state">尚无连接代际</div>';
    return;
  }

  $('generationList').innerHTML = generations
    .map((gen) => {
      const idle = proxyConnectionsForGeneration(gen.id).filter((c) => c.status === 'idle').length;
      const statusClass = ['active', 'draining', 'closed'].includes(gen.status) ? gen.status : 'closed';
      const lifetimeEnd = gen.closedAt || serverNow();
      const endpoints = gen.endpoints.map(endpointBadge).join(' ');
      return `
        <article class="generation-card ${statusClass}">
          <div class="generation-title">
            <strong>${escapeHtml(gen.id)}</strong>
            ${generationPill(gen.status)}
          </div>
          <div class="generation-endpoints">${endpoints}</div>
          <div class="metric-row">
            <div class="metric"><b>${gen.activeRequests}</b><span>active</span></div>
            <div class="metric"><b>${idle}</b><span>idle</span></div>
            <div class="metric"><b>${gen.connectionsCreated}</b><span>new conn</span></div>
            <div class="metric"><b>${gen.reuseCount}</b><span>reuse</span></div>
          </div>
          <div class="mini-counts">
            <span>请求 ${gen.totalRequests}</span>
            <span>重试 ${gen.retryCount}</span>
            <span>销毁空闲 ${gen.idleSocketsDestroyed}</span>
            <span>寿命 ${duration(gen.createdAt, lifetimeEnd)}</span>
            <span>${gen.retiredAt ? `切换于 ${clock(gen.retiredAt)}` : `创建于 ${clock(gen.createdAt)}`}</span>
          </div>
        </article>`;
    })
    .join('');
}

function eventMatchesFilter(event) {
  if (eventFilter === 'all') return true;
  if (eventFilter === 'dns') return event.layer === 'dns' || event.kind.includes('dns');
  if (eventFilter === 'reuse') return event.kind.includes('reuse') || event.layer === 'reuse';
  if (eventFilter === 'drain') return event.kind.includes('drain') || event.layer === 'drain';
  if (eventFilter === 'retry') return event.kind.includes('retry') || event.layer === 'retry';
  return true;
}

function renderEvents() {
  const container = $('eventList');
  const scrollTop = container.scrollTop;
  const events = state.events.filter(eventMatchesFilter).slice(-80).reverse();
  if (!events.length) {
    container.innerHTML = '<div class="empty-state">当前过滤下没有事件</div>';
    return;
  }

  const layerNames = {
    dns: 'DNS',
    control: '控制面',
    pool: '连接池',
    reuse: '复用',
    drain: '排空',
    retry: '重试',
    origin: '源站',
    client: '浏览器',
    proxy: '代理',
  };

  container.innerHTML = events
    .map(
      (event) => `
      <article class="event-item severity-${escapeHtml(event.severity || 'info')}">
        <time class="event-time">${clock(event.ts)}</time>
        <span class="event-layer layer-${escapeHtml(event.layer)}">${layerNames[event.layer] || escapeHtml(event.layer)}</span>
        <div class="event-body">
          <div class="event-title">${escapeHtml(event.title)}</div>
          <div class="event-detail">${escapeHtml(event.detail)}</div>
        </div>
      </article>`,
    )
    .join('');
  container.scrollTop = scrollTop;
}

function renderConnections() {
  const body = $('connectionBody');
  const connections = state.connections.slice(-18).reverse();
  if (!connections.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">暂无连接</td></tr>';
    return;
  }

  body.innerHTML = connections
    .map((conn) => {
      const side = conn.side === 'origin' ? '源站' : '代理';
      const owner = conn.side === 'origin' ? `${escapeHtml(conn.origin)} :${conn.localPort}` : `${escapeHtml(conn.generationId || '—')} → :${escapeHtml(conn.remote?.split(':')[1] || '')}`;
      const port = conn.tcpPort || conn.peerPort || '—';
      return `
        <tr>
          <td>${side}</td>
          <td><code>${escapeHtml(conn.id)}</code></td>
          <td>${owner}</td>
          <td><code>${escapeHtml(port)}</code></td>
          <td><span class="status-dot ${escapeHtml(conn.status)}">${escapeHtml(conn.status)}</span></td>
          <td>${conn.requests || 0}</td>
        </tr>`;
    })
    .join('');
}

function render() {
  if (!state) return;
  renderControls();
  renderStats();
  renderDnsAnswers();
  renderTopology();
  renderLiveRoutes();
  renderRequests();
  renderGenerations();
  renderEvents();
  renderConnections();
}

async function fetchStateOnce() {
  try {
    const response = await fetch('/__api/state');
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    state = await response.json();
    serverClockOffset = state.now - Date.now();
    render();
  } catch (error) {
    setAction(`无法读取状态：${error.message}`);
  }
}

function connectEvents() {
  const source = new EventSource('/__api/events');
  source.addEventListener('state', (event) => {
    state = JSON.parse(event.data);
    serverClockOffset = state.now - Date.now();
    eventSourceOk = true;
    render();
  });
  source.onopen = () => {
    eventSourceOk = true;
  };
  source.onerror = () => {
    eventSourceOk = false;
    if (state) renderControls();
    else {
      const pill = $('globalPill');
      pill.className = 'pill pill-critical';
      pill.textContent = '连接中…';
    }
  };
}

async function runReuseDemo() {
  const button = $('reuseDemo');
  button.disabled = true;
  try {
    setAction('串行请求开始：第一个建连，后两个应复用…');
    const lines = [];
    for (let i = 1; i <= 3; i += 1) {
      const response = await fetch(`/who?demo=reuse&i=${i}&t=${Date.now()}`);
      if (!response.ok) throw await httpResponseError(response);
      const body = await response.json();
      const line = `#${i} ${body.origin}:${body.port} ${response.headers.get('x-demo-proxy-conn')} reused=${response.headers.get('x-demo-proxy-reused')} tcp=${response.headers.get('x-demo-tcp-port')} originConn=${response.headers.get('x-origin-conn')}`;
      lines.push(line);
      setAction(lines.join('\n'));
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
  } catch (error) {
    setAction(`复用演示失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function warmPool(silent = false) {
  if (!silent) setAction('并发 4 个短请求，预热 keep-alive 池…');
  const token = Date.now();
  await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      fetchJsonChecked(`/who?demo=warm&i=${i}&t=${token}`),
    ),
  );
  if (!silent) setAction('预热完成：现在池里应有多条 idle socket。');
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function startDownload() {
  const response = await fetch(`/download?chunks=10&interval=550&ui=${Date.now()}`);
  if (!response.ok) throw await httpResponseError(response);
  const gen = response.headers.get('x-demo-proxy-gen');
  const conn = response.headers.get('x-demo-proxy-conn');
  let chunks = 0;
  let origin = null;

  const done = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line);
          if (payload.type === 'start') origin = payload.origin;
          if (typeof payload.seq === 'number') chunks += 1;
        } catch {
          // Ignore partial non-JSON instrumentation line.
        }
      }
    }
    return { chunks, origin, gen, conn };
  })();

  return { response, gen, conn, done };
}

async function runDownloadDemo() {
  const button = $('downloadDemo');
  button.disabled = true;
  try {
    setAction('发起慢下载…可在 1-2 秒后点击“一键切换”或 A/B 按钮。');
    const download = await startDownload();
    setAction(`下载已响应：gen=${download.gen} conn=${download.conn}。现在切换 DNS，旧下载仍会继续。`);
    const result = await download.done;
    setAction(`下载完整结束：${result.chunks} 块，源站=${result.origin}，原 gen=${result.gen} conn=${result.conn}。`);
  } catch (error) {
    setAction(`下载演示失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function runGuidedDrain() {
  const button = $('guidedDrain');
  button.disabled = true;
  try {
    const bluePort = portLabel('bluePort', 4101);
    const greenPort = portLabel('greenPort', 4102);
    setAction(`1/6 回到 A :${bluePort}，并清除故障…`);
    await postApi('/__api/fault', { mode: 'none' });
    await postApi('/__api/switch', { color: 'blue' });
    await new Promise((resolve) => setTimeout(resolve, 350));

    setAction('2/6 并发预热 4 条连接…');
    await warmPool(true);

    setAction('3/6 启动 10 块慢下载…');
    const download = await startDownload();
    setAction(`下载已开始：${download.gen} / ${download.conn}；等待 1 秒后在中途切换。`);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    setAction(`4/6 DNS 改为 B :${greenPort}；观察旧代际 drain_started…`);
    await postApi('/__api/switch', { color: 'green' });
    await new Promise((resolve) => setTimeout(resolve, 450));

    setAction('5/6 切换后发送新请求，必须进入新代际…');
    const response = await fetch(`/who?demo=after-switch&t=${Date.now()}`);
    if (!response.ok) throw await httpResponseError(response);
    const body = await response.json();
    setAction(
      `新请求落在 ${body.origin}:${body.port} gen=${response.headers.get('x-demo-proxy-gen')} conn=${response.headers.get('x-demo-proxy-conn')}。\n` +
        '旧下载仍在传输；继续等待它结束并触发 drain_completed…',
    );

    const result = await download.done;
    setAction(
      `6/6 完成：旧下载收到 ${result.chunks}/10 块，始终来自 ${result.origin}，连接 ${result.conn} 未被新请求复用。\n` +
        '时间线中可对照 connection_reused、drain_started、drain_completed。',
    );
  } catch (error) {
    setAction(`一键演示失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function runRetryDemo() {
  const button = $('retryDemo');
  button.disabled = true;
  try {
    let mode = state.control.faultMode;
    if (mode === 'none' || mode === 'dns-timeout') {
      mode = 'conn-refused';
      setAction('先把 ECONNREFUSED 故障端点加入 DNS…');
      await postApi('/__api/fault', { mode });
    }

    setAction(`用 ${mode} 模式请求 /who；观察第一次尝试失败和第二次成功…`);
    const response = await fetch(`/who?demo=retry&mode=${mode}&t=${Date.now()}`);
    if (!response.ok) throw await httpResponseError(response);
    const body = await response.json();
    setAction(
      `浏览器最终看到 HTTP ${response.status}，源站 ${body.origin}:${body.port}。\n` +
        `proxy-attempt=${response.headers.get('x-demo-proxy-attempt')} gen=${response.headers.get('x-demo-proxy-gen')} error-code=${response.headers.get('x-demo-error-code') || '(none)'}。\n` +
        '下方“请求与尝试”可看到每次失败的具体错误码和耗时。',
    );
  } catch (error) {
    setAction(`重试演示失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  $('refreshNow').addEventListener('click', async () => {
    const button = $('refreshNow');
    button.disabled = true;
    try {
      await postApi('/__api/refresh');
    } catch (error) {
      setAction(`刷新失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  });

  $('switchBlue').addEventListener('click', () => postApi('/__api/switch', { color: 'blue' }).catch((e) => setAction(e.message)));
  $('switchGreen').addEventListener('click', () => postApi('/__api/switch', { color: 'green' }).catch((e) => setAction(e.message)));
  $('switchToggle').addEventListener('click', () => postApi('/__api/switch', {}).catch((e) => setAction(e.message)));

  document.querySelectorAll('.fault-btn').forEach((button) => {
    button.addEventListener('click', () => postApi('/__api/fault', { mode: button.dataset.mode }).catch((e) => setAction(e.message)));
  });

  $('reuseDemo').addEventListener('click', runReuseDemo);
  $('warmPool').addEventListener('click', () => warmPool(false).catch((e) => setAction(e.message)));
  $('downloadDemo').addEventListener('click', runDownloadDemo);
  $('guidedDrain').addEventListener('click', runGuidedDrain);
  $('retryDemo').addEventListener('click', runRetryDemo);

  document.querySelectorAll('.filter-btn').forEach((button) => {
    button.addEventListener('click', () => {
      eventFilter = button.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach((other) => other.classList.toggle('is-active', other === button));
      renderEvents();
    });
  });
}

bindEvents();
fetchStateOnce();
connectEvents();
setInterval(() => {
  if (state) renderControls();
}, 120);
