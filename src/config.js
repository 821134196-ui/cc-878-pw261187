export const config = {
  proxyHost: process.env.HOST || '127.0.0.1',
  proxyPort: Number(process.env.PROXY_PORT || 8080),

  blueHost: '127.0.0.1',
  bluePort: Number(process.env.BLUE_PORT || 4101),
  greenHost: '127.0.0.1',
  greenPort: Number(process.env.GREEN_PORT || 4102),

  dnsHost: '127.0.0.1',
  dnsPort: Number(process.env.DNS_PORT || 53530),
  dnsName: process.env.DNS_NAME || '_http._tcp.origin.demo.local',

  // A resolved endpoint whose A record is deliberately never answered.
  ghostTarget: 'ghost.origin.demo.local',
  // A resolved endpoint with no listener: reliable ECONNREFUSED retry demo.
  deadTarget: 'dead.origin.demo.local',
  deadPort: Number(process.env.DEAD_PORT || 4199),
  // A local tarpit that accepts TCP but never sends HTTP headers.
  tarpitTarget: 'tarpit.origin.demo.local',
  tarpitPort: Number(process.env.TARPIT_PORT || 4103),

  dnsRefreshMs: Number(process.env.DNS_REFRESH_MS || 3000),
  dnsQueryTimeoutMs: Number(process.env.DNS_QUERY_TIMEOUT_MS || 650),
  connectTimeoutMs: Number(process.env.CONNECT_TIMEOUT_MS || 900),
  headerTimeoutMs: Number(process.env.HEADER_TIMEOUT_MS || 1400),
  drainHardTimeoutMs: Number(process.env.DRAIN_HARD_TIMEOUT_MS || 30000),
};

export const ORIGINS = {
  blue: {
    id: 'blue',
    label: '源站 A · Blue',
    short: 'A',
    color: '#2a78d6',
    host: config.blueHost,
    port: config.bluePort,
  },
  green: {
    id: 'green',
    label: '源站 B · Green',
    short: 'B',
    color: '#1baf7a',
    host: config.greenHost,
    port: config.greenPort,
  },
};
