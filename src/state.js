const MAX_EVENTS = 220;
const MAX_REQUESTS = 36;
const MAX_GENERATIONS = 10;
const MAX_CONNECTIONS = 80;

export class DemoState {
  constructor(config) {
    this.config = {
      proxyPort: config.proxyPort,
      bluePort: config.bluePort,
      greenPort: config.greenPort,
      dnsPort: config.dnsPort,
      tarpitPort: config.tarpitPort,
      deadPort: config.deadPort,
      dnsRefreshMs: config.dnsRefreshMs,
      dnsQueryTimeoutMs: config.dnsQueryTimeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      headerTimeoutMs: config.headerTimeoutMs,
    };
    this.startedAt = Date.now();
    this.seq = 0;
    this.counters = {};
    this.listeners = new Set();

    this.control = {
      activeColor: 'blue',
      faultMode: 'none', // none | dns-timeout | conn-refused | header-timeout
      autoRefresh: true,
    };

    this.dns = {
      name: config.dnsName,
      server: `127.0.0.1:${config.dnsPort}`,
      serial: 1,
      tickCount: 0,
      successCount: 0,
      partialCount: 0,
      failureCount: 0,
      lastTickAt: null,
      lastDurationMs: null,
      lastReason: 'startup',
      nextRefreshAt: Date.now() + config.dnsRefreshMs,
      status: 'pending', // pending | ok | partial_timeout | error
      message: '等待第一次 DNS 刷新',
      srvAnswers: [],
      resolutions: [],
    };

    this.stats = {
      clientRequests: 0,
      proxiedRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      newConnections: 0,
      reusedConnections: 0,
      retryCount: 0,
      dnsTicks: 0,
      partialTimeouts: 0,
      generationSwitches: 0,
      drainStarted: 0,
      drainCompleted: 0,
      bytesProxied: 0,
    };

    this.events = [];
    this.generations = [];
    this.connections = [];
    this.requests = [];
  }

  nextId(prefix) {
    this.counters[prefix] = (this.counters[prefix] || 0) + 1;
    return `${prefix}${this.counters[prefix]}`;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // SSE listeners must never break the demo.
      }
    }
  }

  log(entry) {
    const event = {
      id: this.nextId('ev'),
      ts: Date.now(),
      severity: 'info',
      layer: 'proxy',
      kind: 'note',
      title: '',
      detail: '',
      ...entry,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit(event);
    return event;
  }

  addGeneration(record) {
    this.generations.push(record);
    if (this.generations.length > MAX_GENERATIONS) {
      this.generations.splice(0, this.generations.length - MAX_GENERATIONS);
    }
    return record;
  }

  getGeneration(id) {
    return this.generations.find((g) => g.id === id);
  }

  addConnection(record) {
    this.connections.push(record);
    if (this.connections.length > MAX_CONNECTIONS) {
      // Prefer dropping oldest closed connections first.
      const closedIndex = this.connections.findIndex((c) => c.status === 'closed');
      if (closedIndex >= 0) this.connections.splice(closedIndex, 1);
      else this.connections.splice(0, this.connections.length - MAX_CONNECTIONS);
    }
    return record;
  }

  getConnection(id) {
    return this.connections.find((c) => c.id === id);
  }

  addRequest(record) {
    this.requests.push(record);
    if (this.requests.length > MAX_REQUESTS) {
      const finishedIndex = this.requests.findIndex((r) => r.phase === 'done' || r.phase === 'error');
      if (finishedIndex >= 0) this.requests.splice(finishedIndex, 1);
      else this.requests.shift();
    }
    return record;
  }

  getRequest(id) {
    return this.requests.find((r) => r.id === id);
  }

  prune() {
    const cutoff = Date.now() - 9000;
    this.connections = this.connections.filter(
      (c) => c.status !== 'closed' || (c.closedAt || 0) > cutoff,
    );
  }

  snapshot() {
    this.prune();
    return {
      ok: true,
      now: Date.now(),
      startedAt: this.startedAt,
      config: this.config,
      control: this.control,
      dns: this.dns,
      stats: this.stats,
      events: this.events,
      generations: this.generations,
      connections: this.connections,
      requests: this.requests.slice(-24),
    };
  }
}
