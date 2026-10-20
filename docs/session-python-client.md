# Python 后端客户端（开发中）

`sdk/python` 提供 Python 3.11+ 的 asyncio 客户端，HTTP 依赖固定为 HTTPX 0.28.1。公开模型使用不可变 dataclass，Session/Operation ID 使用不同 NewType，包带 `py.typed`。当前为 `0.0.0.dev0`，没有发布到公共包索引；Native provider、Viewer ticket 与完整版本兼容验收仍待完成。

```python
import asyncio
import os
from remote_paint_session import SessionClient, SessionClientError, CreateSessionInput

async def main():
    async with SessionClient(
        base_url="https://your-session-control.example",
        api_key=os.environ["REMOTE_PAINT_API_KEY"],
    ) as client:
        # 请求及键应先保存在调用方的作业记录中，重试与重启恢复继续使用它们。
        creation = client.sessions.prepare_create(
            CreateSessionInput(region="your-configured-region", ttl_seconds=900),
            idempotency_key="the-key-saved-with-this-job",
        )
        accepted = await creation.send()
        operation = await client.operations.get(accepted.data.operation_id)
        session = await client.sessions.get(accepted.data.session_id)
        # 检查操作结果与当前 Session 状态后，再使用后续连接接口。

asyncio.run(main())
```

`prepare_create` 同步校验并捕获不可变正文和原幂等键，后续 `send(retries=...)` 不接受替换正文/键。`sessions.create(input=None, *, idempotency_key, retries=None)` 是便捷封装。可选输入为 `CreateSessionInput(url=None,region=None,ttl_seconds=None)`；None 字段省略，空输入打开精确 `about:blank`。HTTP 服务契约见[接口说明](session-control-api.md)。

`sessions.get(session_id)`、`sessions.release(session_id)`、`operations.get(operation_id)` 与创建一样返回 `ApiResult`。模型使用 Python 的 snake_case 字段，如 `session_id`、`operation_id`、`request_id`；wire JSON 仍使用服务定义的 camelCase。创建操作的历史成功不等于当前会话仍 ready，重启隔离、期限与释放状态需要独立查询。

## 重试、取消和资源关闭

默认不自动重试。客户端或单次调用可设置 `retries=0|1|2|3`，最多四次，仅重试网络异常、请求超时及 408/429/5xx。每次创建都保留原始正文与幂等键。网络错误、超时或响应损坏可能发生在受理之后，不能另换新键创建同一作业。

`SessionClientError` 提供固定 message、`code`、`status`、`request_id`、`outcome` 与 `retryable`，不把服务原始错误消息、响应正文或底层传输异常作为公开错误消息返回。outcome 与 Node 客户端相同：`not-dispatched` 表示本次未派发，`rejected` 表示收到符合契约的 4xx 拒绝（408 除外），`unknown` 表示可能已受理。rejected 仍不能否定此前重试的副作用。

取消正在执行的请求会抛出继承 `asyncio.CancelledError` 的 `SessionClientCancelledError`，保留 Task 的 cancelled 语义，并提供 `outcome`。Task 在客户端协程尚未开始前就被取消时，可能只出现原生 CancelledError；此时请求没有发出。取消客户端等待不能撤回服务已受理的创建，释放使用独立请求。

默认每次尝试有 10 秒总期限，覆盖请求发出、响应 headers 与流读取；调用方可用外层 `asyncio.timeout` 约束含重试的整个作业。默认最多 64 个活动客户端请求，超额在发出前返回 `CLIENT_BUSY`。HTTPX 连接池最多 16 个连接。客户端拥有的请求 Task 会在 `aclose()` 时取消并等待，关闭为 single-flight；异步上下文管理器自动关闭。每次响应在 finally 中关闭，响应关闭失败会禁止新请求，并通过固定错误报告；调用方仍须关闭客户端。

## 响应和传输约束

响应默认最多 64 KiB，流式读取时检查，期限也覆盖流读取。校验 UTF-8、JSON、精确字段、请求 ID/header 一致性、Session/Operation ID、操作类型与状态、就绪字段及配额标记。结果与嵌套操作错误模型均不可变。未知 schema 不当作已确认成功；发布时的跨版本兼容仍待验证。

API origin 使用 HTTPS；本地开发另允许 localhost、127.0.0.1、::1 的 HTTP。base_url 不能携带管理凭据、路径前缀、query 或 fragment。客户端拒绝重定向，不把管理 key 发给 Location 目标；不发送服务设置的 cookie、不自动使用环境代理，要求未压缩的 JSON 响应。显式传入的 HTTPX AsyncBaseTransport 是可信测试/后端配置，应遵守 asyncio 取消与关闭契约。

HTTPX 的[异步流与关闭接口](https://www.python-httpx.org/async/)和[每阶段超时](https://www.python-httpx.org/advanced/timeouts/)由库提供；客户端在外层增加每次尝试的总期限、原请求重试和结构验证。当前没有 Viewer 渲染、页面操作、Agent run、事件游标或 Webhook，未代替完整 K1/K8/K9 验收。

运行合同：`python -m unittest discover -s tests/python -p test_session_client.py -v`，需先安装 `sdk/python` 的依赖并确保 Node 22.13+（带 node:sqlite）可用。Node 子进程仅运行明确的 HTTP/SQLite provider 夹具，覆盖真实丢失响应、租户隔离、查询、释放与进程回收，不启动 Chromium。严格类型合同位于 `tests/types/session_client.py`，包含要求被拒绝的缺失键、混用 ID、修改结果、替换 prepared 键和越界重试数。
