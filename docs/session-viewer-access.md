# Viewer 访问（开发中）

`service/viewer-access.mjs` 的 `ViewerAccess` 将公共显示连接与私有 Source 访问密钥分开。后端通过已有 API key 签发短票据；浏览器只取得该票据和公共网关路径。当前真实 HTTP/WebSocket 测试接入 Node Source 和原有 `ControlLease`，已验证真实协议转发及输入分派。实际 Native worker 的私有传输桥接、可嵌入 Viewer、Agent/CDP 独立授权和渲染验收仍未完成，不能据此声明 K2/K3/K5 全部通过。

## 后端装配

构造 `new ViewerAccess({registry, resolveSource, maxGrants?, maxConnections?, connectTimeoutMs?, maxBufferedBytes?})`，再将同一实例作为 `viewerAccess` 传入 `createSessionControlServer`。二者必须共享同一个持久化 Registry。

可信后端回调 `resolveSource({tenantId, sessionId, region, version, signal})` 查找该 Session 已拥有的私有传输，返回 `{tenantId, sessionId, region, version, origin, streamOrigin, key}`。前四项必须与请求完全一致；`origin` 为私有 Source 的 HTTP Origin，`streamOrigin` 为其数据网关 HTTP Origin。`key` 只在后端用于连接私有 `/stream`。解析器应响应 AbortSignal；超时、撤销或关闭后迟到的解析结果不会创建连接。该回调不应创建/重放 Session，也不能仅把请求标签贴到任意 Source 上。实际 provider 的端点所有权桥接尚待实现。

私有 Source 端口和旧式密钥入口必须保持在可信网络内。此网关不会改变现有本地演示入口的授权方式。HTTP 工厂仍由调用方配置 TLS、监听地址和可信代理；代理访问日志必须遮蔽 `/v1/viewer/stream` 的票据查询参数。实现自身不记录票据、API key 或私有 Source URL。

## 签发、刷新、撤销

后端使用 `Authorization: Bearer <backend-api-key>`，向 `POST /v1/sessions/:sessionId/viewer-tickets` 发送 JSON：

```json
{"role":"readonly","audience":"https://embed.example","ttlSeconds":60}
```

角色只接受 `readonly` 和 `controller`。两者都要求 `viewers:read`；controller 另需 `viewers:control`。Session 必须属于认证租户且处于 Ready；创建/释放权限本身不能签发 Viewer 票据。audience 必须是规范化的 HTTPS Origin；本机开发可使用 HTTP loopback Origin，不接受通配符、路径、凭据或查询参数。

成功响应仍为 `{data,requestId}`，data 含 `grantId`、`sessionId`、`version`、`role`、`audience`、`expiresAt`、`ticket` 和相对 `streamPath`。票据使用独立 `vwt1.` 格式的 256 位随机值，服务内只保留其 SHA-256。`grantId` 可用于管理，不能用于连接。期限默认 60 秒，可设 1 到 120 秒，始终受原 Session 期限约束；运行中同时检查绝对时间和单调期限。票据不能调用管理 API；API key 不能作为 Viewer 票据使用。

浏览器连接公共网关的 `streamPath`，WebSocket Origin 必须精确匹配 audience。票据绑定认证租户、Session、区域和 Ready 版本/代次，客户端消息不能提升角色。每票据最多一条活动或正在建立的连接；断线后在有效期内可重连，其他标签页需各自取得票据。

`POST /v1/sessions/:sessionId/viewer-tickets/:grantId/refresh` 只接受 `{ttlSeconds?}`，保留原角色和 audience，并原子撤销旧票据、关闭旧连接。刷新不会续 Session TTL。已过期但尚保留的管理记录可在原 Session Ready 时刷新；记录清除后应重新签发。无效刷新不会静默撤销原有效票据。

`DELETE /v1/sessions/:sessionId/viewer-tickets/:grantId` 撤销票据及活动/正在建立的连接。刷新和撤销都要求原角色的签发权限，跨租户和不存在的 grant 返回相同 404。刷新和签发没有幂等键，调用方不能假定丢失 HTTP 响应意味着未签发。撤销后再次调用会返回 404。

## 服务端协议边界

只读连接仅能发送首次 `Hello`、`FrameAck` 和 `RequestKeyframe`；伪造输入、控制租约、Agent/CDP、二进制或重复握手会关闭连接。其 Welcome 显式设置 `input:false`、`inputFeedback:false`、`control:null`，并携带 `viewerSessionId`、`viewerVersion`、`viewerGrantId` 和 `viewerRole` 供客户端核对。原 `sessionId` 继续用于 Source 控制租约标签。控制状态和编辑器反馈不会转发给只读连接。

controller 连接另可发送 `AcquireControl`、`RenewControl`、`ReleaseControl`、`Input`。这些请求继续通过 Source 的原有 Session/page/viewport/lease/sequence 检查和输入队列栅栏。网关移除上游握手中的 `control-channel-v1`，使用现有单连接控制回退，因此浏览器不会取得私有 Source 密钥或 Native 配对票据。此阶段未提供 Agent/CDP 权限，也未完成外部 Agent 绕过路径的全面验收。

每条双向消息都重新核对票据和持久 Ready 状态。显式撤销/刷新立即关闭对应连接，并中止解析；期限、Registry 失效和 Session 关闭还由 250ms 看门狗关闭空闲连接。撤销前已被 Source 接受的工作遵循现有输入队列和断连清理语义，不能撤回已执行的 CDP 动作。

默认最多 1024 个保留 grant、16 个活动/待建连接；每次连接期限 5 秒；已超时但未结束的解析器继续占用最多 16 个解析额度，额度耗尽时拒绝新的连接。客户端消息最多 32KiB，每连接每秒最多 512 条；单连接发送缓冲默认 32MiB，实例发送缓冲总和受两倍该值约束。超限关闭连接，不启动传输重试。进程重启、访问实例关闭会撤销全部内存票据；HTTP 工厂不持久化票据，也不恢复旧显示连接。

证据见[访问检查点](evidence/viewer-access.json)。当前验收范围为真实 Node Source 协议及后端权限边界，整份候选全量测试和真实 Native 渲染测试仍等待原始 8 小时测试退出。


公共握手保留上游 1000/1001/1008/1012/1013 关闭码的分类，理由使用固定文本；协议/版本拒绝不会变成可自动重试的临时故障。Viewer 的公共票据运行时与刷新/断开接口见[运行时说明](session-viewer-runtime.md)，实际 iframe 嵌入和 Native 端点桥接仍待完成。
