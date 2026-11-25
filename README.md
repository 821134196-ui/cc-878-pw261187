# DNS Draining Reverse Proxy Demo

一个**零第三方依赖**的本机演示：反向代理周期性查询 DNS；当 SRV/A 解析出的源站端点变化时，新请求立刻使用新的连接池代际，旧的空闲连接马上关闭，已经在传输的下载则继续到结束。页面实时展示连接复用、代际排空和失败重试分别发生在哪一层、哪条 TCP 连接上。

## 一分钟运行

```bash
npm start
```

打开：

```text
http://127.0.0.1:8080/__ui/
```

本机两个源站端口：

- 源站 A Blue：`http://127.0.0.1:4101`
- 源站 B Green：`http://127.0.0.1:4102`

代理入口是 `:8080`，例如：

```bash
curl -i http://127.0.0.1:8080/who
curl -N http://127.0.0.1:8080/download?chunks=10\&interval=550
```

页面按钮都通过同一个 `:8080` 入口发请求，不需要额外前端构建。

## 推荐演示脚本

1. 点击 **“连发 3 个请求”**。  
   第一个请求创建代理到源站的 TCP 连接，后两个请求显示相同的 `C…` 连接 ID、相同 TCP 源端口和 `reused=true`；源站响应头中的 `O…` 连接也相同。

2. 点击 **“一键演示：复用池 + 排空 + 新连接”**。脚本会：
   - 回到 A/`:4101` 并清除故障；
   - 并发预热 4 个短请求，产生多条 keep-alive 连接；
   - 启动约 5.5 秒的 `/download` NDJSON 慢下载；
   - 在下载中途把 DNS 答案从 A 改成 B；
   - 再发一个新请求，证明它进入新代际并落到 B/`:4102`；
   - 等待旧下载收完所有数据块，然后旧代际才 `closed`。

3. 观察页面中的三类标记：
   - **复用**：绿色 `connection_reused` 事件、连接 chip 上的请求次数、`x-demo-proxy-reused: true`。
   - **排空**：黄色 `drain_started` / `drain_completed` 事件，旧 generation 从 `active → draining → closed`，以及 `idle sockets destroyed`。
   - **重试**：橙色 `attempt_retry` 事件和请求卡片中的逐次尝试、错误码与耗时。

4. 在 **“解析 / 连接故障注入”** 中选择：
   - `部分 DNS 超时`：DNS 中加入一个故意不回答 A 查询的 target，状态为 `partial_timeout` / `DNS_TIMEOUT`，健康端点仍可用。
   - `ECONNREFUSED`：SRV 加入 `127.0.0.1:4199`（无监听），第一次尝试立即失败，代理重试到健康源站。
   - `响应头超时`：SRV 加入本机 tarpit `:4103`；TCP 能连接，但不返回 HTTP 响应头，代理记录 `HEADER_TIMEOUT` 后重试。

## 关键语义

### 周期 DNS 与分代连接池

`src/dns-demo.js` 启动一个进程内 UDP DNS 服务，回答：

- `_http._tcp.origin.demo.local` 的 SRV 记录，记录中包含源站端口；
- `blue.origin.demo.local` / `green.origin.demo.local` 等 target 的 A 记录；
- 对 `ghost.origin.demo.local` 的 A 查询故意丢包，用来稳定演示部分解析超时。

`src/resolver.js` 每 3 秒使用 Node 的 `dns.promises.Resolver` 向这个本机 DNS 发真实查询：先查 SRV，再并发解析每个 target 的 A 记录。端点集合不变时保留当前 `http.Agent`；端点集合变化时调用 `proxy.setEndpoints()` 创建新代际。

DNS 整体刷新失败时继续保留上一份可用端点，不会因为一次刷新错误把所有现有流量变成 502。

### 为什么新请求不会用到失效连接

每个 generation 拥有独立的 `http.Agent({ keepAlive: true })`。当前请求处理函数在开始时绑定 `this.activeRuntime`；DNS 切换只会把共享指针替换成新 runtime，并 retire 旧 runtime，不会改写已经在处理中的请求所引用的旧 runtime。

retire 时：

1. 旧 generation 标记为 `draining`；
2. 立即 destroy `agent.freeSockets` 中的空闲连接；
3. active request 计数不清零，正在传输的下载继续使用旧 socket；
4. 响应正常结束后主动 `socket.end()`，不把该 socket 放回旧池；
5. active 计数归零后 `agent.destroy()`，generation 标记 `closed`。

因此新请求只能从新 generation 的 Agent 取连接，而已经开始的下载不会被提前切断。

### 哪些错误可以区分

页面、JSON state 和事件中分别保留这些 code：

| Code | 发生阶段 | 含义 | 演示方式 |
| --- | --- | --- | --- |
| `DNS_TIMEOUT` | DNS/A 解析 | 某个 SRV target 的 A 结果超时，其他端点可能正常 | “部分 DNS 超时” |
| `ECONNREFUSED` | TCP 连接 | 解析成功，但目标端口无监听 | “ECONNREFUSED” |
| `CONNECT_TIMEOUT` | TCP 连接 | 建连超过 `CONNECT_TIMEOUT_MS` | 代码路径保留 |
| `HEADER_TIMEOUT` | 等待 HTTP 响应头 | TCP 已连接，但源站/tarpit 未及时返回 headers | “响应头超时” |

只有 **GET / HEAD / OPTIONS** 且响应头尚未发送时，代理才会尝试下一个解析端点。响应头一旦发出或响应流已经开始，就不能安全地换源重发；此时流出错会直接销毁客户端响应。

## HTTP / API

页面和控制 API 由代理端口 `:8080` 一起提供：

```text
GET  /__ui/                 仪表盘
GET  /__api/state           完整实时状态 JSON
GET  /__api/events          SSE，每 250ms 推送 state
POST /__api/switch          {"color":"blue"|"green"}；省略 color 则切换
POST /__api/fault           {"mode":"none"|"dns-timeout"|"conn-refused"|"header-timeout"}
POST /__api/refresh         立即执行一次 DNS 刷新
```

其余路径都会被反向代理到当前 DNS 解析出的健康端点。演示源站提供：

```text
GET /who                    返回源站、端口、源站连接和 TCP 信息
GET /download?chunks=10&interval=550
                            慢速 NDJSON 下载，用于观察排空
GET /slow-headers?ms=3000   延迟返回响应头
```

代理成功响应会带这些观察头：

```text
x-demo-proxy-gen
x-demo-proxy-conn
x-demo-proxy-reused
x-demo-proxy-attempt
x-demo-endpoint
x-demo-generation-status
x-demo-tcp-port
x-origin-id
x-origin-port
x-origin-conn
x-origin-request-count
```

代理侧连接的临时 TCP 源端口与源站看到的对端端口一致，因此可以用它关联两侧事件。

## 测试

```bash
npm test
```

集成测试会用独立端口启动一个演示实例，验证：

- 三个串行请求复用同一条代理/源站 TCP 连接；
- DNS 切换后新请求落到新端口和新 generation；
- 切换前开始的下载收完全部 chunk；
- 旧 generation 出现 `drain_started → drain_completed`；
- partial DNS timeout 被记录为 `DNS_TIMEOUT`；
- `ECONNREFUSED` 和 `HEADER_TIMEOUT` 后都能重试成功。

## 配置

常用环境变量：

```text
PROXY_PORT=8080
BLUE_PORT=4101
GREEN_PORT=4102
DNS_PORT=53530
TARPIT_PORT=4103
DNS_REFRESH_MS=3000
DNS_QUERY_TIMEOUT_MS=650
CONNECT_TIMEOUT_MS=900
HEADER_TIMEOUT_MS=1400
DRAIN_HARD_TIMEOUT_MS=30000
```

## 目录结构

```text
src/
  main.js         启动 DNS、两个源站、tarpit、代理和仪表盘 API
  config.js       端口与超时配置
  dns-demo.js     进程内权威演示 DNS + 可控记录注册表
  resolver.js     周期 SRV/A 解析、部分失败归类
  proxy.js        分代 Agent、复用统计、重试、优雅排空
  origins.js      Blue/Green 源站和 header-timeout tarpit
  dashboard.js    静态页面与控制/SSE API
  state.js        内存状态、事件和裁剪
public/
  index.html
  styles.css
  app.js
test/
  integration.test.js
```

这是一个用于解释故障域和连接生命周期的本地教学演示，不是生产级代理实现；生产中还需要考虑 TLS、连接/请求体缓冲、并发上限、DNS TTL、健康检查、优雅停机和可观测性采样。
