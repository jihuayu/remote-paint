# 后端 Session 客户端（开发中）

`sdk/backend.mjs` 是 Node.js 后端 ESM 客户端，旁边的 `backend.d.mts` 提供 TypeScript 类型。客户端不包含 Viewer、页面动作或 Agent run 接口；当前尚未独立发布 npm/Python 包，也未完成 Native provider 与连接票据验收。

```ts
import { SessionClient, SessionClientError } from '../sdk/backend.mjs';

const apiKey = process.env.REMOTE_PAINT_API_KEY;
if (!apiKey) throw new Error('Configure the backend credential');
const client = new SessionClient({
  baseUrl: 'https://your-session-control.example',
  apiKey,
});

// 此请求与幂等键应事先保存在调用方的作业记录中。
const creation = client.sessions.prepareCreate(
  { region: 'your-configured-region', ttlSeconds: 900 },
  { idempotencyKey: 'the-key-saved-with-this-job' },
);
try {
  const { data: operation } = await creation.send();
  const status = await client.operations.get(operation.operationId);
  const session = await client.sessions.get(operation.sessionId);
  // 操作成功与会话此刻可用是两个状态；连接前检查 session.data.state。
} catch (error) {
  if (error instanceof SessionClientError) {
    // outcome 为 unknown 时保留原请求/键，查询或重发 creation.send()。
    // 不以新幂等键重建同一作业。
  }
  throw error;
}
```

接口分别是 `sessions.prepareCreate(input,{idempotencyKey})`、`sessions.create(input,{idempotencyKey,signal?,retries?})`、`sessions.get(sessionId,options?)`、`sessions.release(sessionId,options?)` 和 `operations.get(operationId,options?)`。返回只读的 `{data,requestId}`，运行时也冻结返回数据。具体服务契约见[HTTP API](session-control-api.md)。

`prepareCreate` 同步校验并捕获原正文及幂等键。之后调用方修改输入对象或 options 不会改变发送内容；`send({signal?,retries?})` 不能替换请求/键。prepared 对象本身不持久化，调用方进程重启后应从自己的作业记录恢复原参数与原键。`create` 是单次调用的便捷封装，内部也先捕获参数。

默认不自动重试。可在客户端或每次请求上显式设置 `retries:0|1|2|3`，最多发送四次；只重试传输错误、超时及 408/429/5xx，始终使用原正文/键，取消后不重试。4xx 权限或幂等冲突不会触发自动重试。重试次数不代表之前各次均未受理。

## 错误与期限

`SessionClientError` 提供 `code`、`status:number|null`、`requestId:string|null`、`outcome`、`retryable`，不附原始 fetch 异常、完整响应或凭据。错误 message 为固定客户端消息；HTTP 公开错误码保留在 code 中，便于调用方处理。

| outcome | 语义 |
| --- | --- |
| `not-dispatched` | 本次客户端调用在发出请求前被校验拒绝或取消 |
| `rejected` | 本次请求收到符合契约的 4xx 拒绝（408 除外）；此前请求仍须按原幂等记录判断 |
| `unknown` | 本次请求可能已受理，包括断线、超时、响应损坏或存储确认暂不可用 |

`CLIENT_ABORTED` 可能是 not-dispatched 或 unknown。AbortSignal 中止的是客户端等待，不能撤回已被服务受理的创建；释放通过独立 `sessions.release` 请求完成。当前没有长任务事件、Webhook 或游标重连，未代替 K8 的完整契约。

默认每次 HTTP 尝试期限 10 秒，覆盖 fetch 与响应正文读取；有重试时每次都有独立期限，调用方可用外层 AbortSignal 限制整个调用。响应默认上限 64 KiB，按流读取并校验 UTF-8/JSON、请求 ID、资源 ID、操作种类/状态、会话可用性字段和精确 schema。错误/未知版本字段不会直接作为已确认的成功值返回。响应大小和期限可配置，错误和服务版本兼容策略仍待独立发布验收。

## 后端与开发环境

客户端要求 Node.js 后端，管理 key 不放入 Viewer 或浏览器 bundle。默认使用 Node 内置 fetch；显式注入的 fetch 属于可信后端配置，应遵守 AbortSignal 与 redirect 参数。客户端禁用 HTTP 重定向、cookie 凭据和 referrer；仅允许 HTTPS API origin，开发环境另允许 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP。baseUrl 不含路径、query、fragment 或嵌入凭据。

类型声明使用 `.d.mts` 与 `.mjs` 的 ESM 配对规则，见 [TypeScript 模块文档](https://www.typescriptlang.org/docs/handbook/modules/reference)。`tests/types/session-client.mts` 包含正向类型推导及应拒绝的缺少幂等键、跨 ID 类型、租户注入、替换 prepared 请求和修改只读结果等用例。本次使用固定 TypeScript 5.9.3，`strict`、`exactOptionalPropertyTypes`、`NodeNext` 与 `noEmit` 检查；未把类型检查代替运行时验证。

Python 3.11+ 的 asyncio 对应实现及取消语义见[Python 客户端](session-python-client.md)，仍处于独立发布前的开发阶段。
