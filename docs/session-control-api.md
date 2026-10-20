# Session 控制 API（开发中）

`service/session-http.mjs` 提供尚未独立发布的后端 HTTP 服务工厂。当前支持持久化创建、查询和释放；实际 Native provider、Viewer ticket、浏览器嵌入和 SDK 发布仍待接入。这里的 Session ID、操作 ID 分别使用 `ses_`、`op_` 前缀，不充当 Page target 或 Agent run ID。

## 接口

| 方法与路径 | 所需 scope | 结果 |
| --- | --- | --- |
| `POST /v1/sessions` | `sessions:create` | 创建或重放原创建操作 |
| `GET /v1/operations/:operationId` | `sessions:read` | 查询操作状态 |
| `GET /v1/sessions/:sessionId` | `sessions:read` | 查询会话状态、区域、版本及期限 |
| `DELETE /v1/sessions/:sessionId` | `sessions:release` | 释放或重放原释放操作 |

每次请求必须携带 `Authorization: Bearer <backend-api-key>`。创建还必须携带 `Idempotency-Key` 与 `Content-Type: application/json`，正文例如 `{"region":"your-region","ttlSeconds":900}`。可选 `url` 默认为精确的 `about:blank`，也支持无嵌入凭据的 HTTP(S) URL；不支持其他 `about:`、`data:`、`file:` 或 `javascript:`。请求只接受 `url`、`region`、`ttlSeconds`，租户由认证结果决定；客户端提供租户字段会报错，额外租户 header 不参与授权。

成功响应为 `{"data":{...},"requestId":"req_..."}`。创建/释放的 pending 操作返回 202，已有终态返回 200，同时提供相对 `Location: /v1/operations/:operationId`。操作有 `operationId`、`sessionId`、`kind`、`status`、`createdAt`、`updatedAt`、`error`；status 为 `pending`、`succeeded` 或 `failed`。会话状态独立于创建操作历史：创建曾成功的会话在重启恢复时仍可能暂不可用，必须查询会话状态。

错误响应为 `{"error":{"code":"...","message":"..."},"requestId":"req_..."}`。响应 header `X-Request-Id` 与正文相同，值由服务生成；响应均 `Cache-Control: no-store`。HTTP parser 在进入处理器前拒绝的畸形报文可能使用 Node 自身响应或关闭连接。

## 幂等、期限与重试

幂等键为 1 到 128 个可打印且无空格的 ASCII 字符，按租户隔离。同键同请求返回同一 Session 与创建操作；同键不同规范化请求返回 409 `IDEMPOTENCY_CONFLICT`。最初省略的区域和 TTL 默认值保存在账本中，服务配置改变后的重试仍使用原值。省略 URL 与显式 `about:blank` 具有相同语义。

客户端超时、断线或丢失响应时，创建结果可能未知。重试必须保留原键与原请求，不能生成新键；HTTP 断线不会取消已经持久受理的创建。查询原操作可确定受理后的结果。关闭失败的资源继续占用配额，只有明确的 closed 回执才释放槽位。释放失败后显式重试可能创建新的释放操作，旧失败结果仍可查询。

TTL 从实际 ready 开始，运行时使用单调时钟。过期记录保留为原 ID，不替换成新会话。重启隔离旧活动资源并按原 ID 核对/关闭，不重放创建，不为旧会话续 TTL。

常见错误包括 400 参数无效、401 `UNAUTHENTICATED`、403 `FORBIDDEN`、404 跨租户或不存在的资源、409 幂等冲突、429 `SESSION_QUOTA`。认证服务故障、存储确认失败、容量和并发请求饱和返回 503；不能把这些错误理解成“上一次创建从未执行”。provider 异常与认证异常的原始内容不会作为 HTTP 错误消息返回。

## 服务装配与所有权

工厂参数为 `{registry, authenticate, maxBodyBytes?, maxConcurrentRequests?, requestTimeoutMs?}`，返回尚未 listen 的 `http.Server`。必须传入使用 SQLite 等可信同步账本的 `SessionRegistry`；纯内存注册表或持久状态未确认时拒绝服务。调用方先配置区域 provider、打开账本、构造注册表并执行 `recover()` 核对旧资源，再装配服务。清理仍不确定的旧资源继续保留配额，不当作可连接会话。

`authenticate({token, signal})` 由可信后端配置提供，可同步或异步返回 `{tenantId, scopes}`；返回 null/undefined 表示无效凭据，抛错或无效身份表示认证暂不可用。回调应响应 AbortSignal。请求过期后仍未结束的认证调用继续占用认证并发额度，避免反复超时累积无限调用；迟到的成功结果不会触发创建。

`createApiKeyAuthenticator([{apiKey,tenantId,scopes},...])` 可用于明确的固定后端配置，闭包只保存 key 的 SHA-256 与身份。key 必须为 32 到 256 个 URL-safe ASCII 字符，并应使用加密随机生成的凭据。需要即时撤销/轮换时应配置能够查询当前授权状态的认证回调。管理 key 留在后端；Viewer 短时票据接口另行实现。当前服务拒绝带 Origin 的请求，不发送 CORS 允许 header，也不提供 WebSocket/CDP 代理。

默认正文上限 16 KiB、64 个活动请求及 64 个尚未结束的认证调用、10 秒总处理期限。HTTP headers 总量最多 16 KiB，最多 64 项；关键 header 不允许重复。正文只支持无压缩 UTF-8 JSON，未完整收到或达到期限的正文不会被受理。每连接仅处理一个请求，socket 数有界。服务工厂不自动绑定公网端口，也不配置 TLS；调用方负责可信代理/TLS 与监听地址。

关闭时由调用方停止接入、结束现有 HTTP 连接，然后等待 `registry.shutdown()`，最后关闭账本。工厂不会擅自关闭调用方提供的注册表或账本。测试使用真实 loopback HTTP 与真实 SQLite，但 provider 为明确的夹具，不能替代 Native 生命周期或计费验收。

## 后端客户端

开发中的 Node ESM/TypeScript 客户端和固定请求重试契约见[客户端说明](session-backend-client.md)。Viewer 连接与嵌入仍需单独的短时授权接口。
