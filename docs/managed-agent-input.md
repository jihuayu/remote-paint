# 本地 Agent CDP 输入子集

`createManagedAgentInput(source.control)` 返回冻结的 `fence()` / `send(method, params, {fence})` 两个入口。工厂仅供持有真实 ControlLease 的 Source 侧代码调用；返回对象不提供 Page、CDP session、Source 或 ControlLease。

只允许 Input.insertText、Input.dispatchKeyEvent、Input.dispatchMouseEvent、Input.imeSetComposition。每次 send 必须显式携带请求形成时的版本戳，绑定控制器 UUID、控制版本、文档和 viewport；适配器不会替调用方换成最新版本。通用 Runtime/Page/Target/Browser 命令不开放。参数要求普通对象的自有 data 字段，禁止 getter、继承字段、symbol、额外字段、嵌套对象及任意 commands；只接收有界字符串/有限数值，再由 ControlLease 做事件语义校验。接收时复制、冻结，鼠标分支只读取一次调用方字段，入队后修改对象不能改写动作。

send 成功返回冻结的 `{stage:'input-injected', fence}`，只证明输入注入完成。AgentInputError.outcome 为 `not-dispatched` 表示本次动作尚未调用 CDP；`unknown` 表示已开始发送，不能据此断言页面没有变化。发送后的错误统一成 AGENT_INPUT_FAILED，CDP 伪装的 AGENT_PAUSED 也不会被误报为未发送。不自动重试；调用方需检查实际状态并重新确认权限和版本。受信任的无选项 ControlLease.agent(event) 兼容路径仍保留，原来的错误行为也保留。

13 个新合同验证参数捕获、受限方法、版本戳、语义错误、队列上限、人机交接、发送前/发送后结果、脱敏和关闭。完整 110 文件测试在 Mac / Linux 均 975 项零失败，分别 960/969 通过、15/6 平台跳过。完整回归在 v1 执行快照上运行；后续只修正了不属于该 110 文件的 Native opt-in fixture 等待条件，生产代码、全部单测及依赖逐字节相同，未宣称修正后重新完整运行。

真实 Native Source 中，受信任原始引用接口在排队后改写参数会得到 AMUTATED；本地适配器在同样的真实 CDP ACK 持有条件下得到 APLANNED。真实人接管并释放后，旧戳被 STALE_AGENT_FENCE / not-dispatched 拒绝，新戳可继续输入。真实页面先执行 U 后，由测试控制器模拟响应丢失并抛出 AGENT_PAUSED，适配器返回 AGENT_INPUT_FAILED / unknown；页面只出现一次 U，没有重放。真实人接管时尚未发送的 STALE 返回 AGENT_PAUSED / not-dispatched。独立页面 HTTP 报告确认效果；测试 ACK 持有和响应故障不是物理时延或 N1 丢包证据。

首轮 Native fixture 在导航后的显示帧发布前尝试 human acquire，handoff 未开始，断言失败并出现排队文本 ASTALE；失败结果和快照保留。仅增加等待实际 Source.latest 的条件后用例通过。两轮 Native 容器均退出、PID 为 0、无 OOM，已知浏览器及 broker PID/startTicks 全部退役，HTTP fixture 关闭。执行快照仅将 broker 替换为先前已验收的 Linux 构建，canonical 文件保持原样，偏差记录在 manifest。

这只是 Source 内部的受限输入子集。版本戳不是认证凭证，尚未绑定远端租户、管理 Session、目标和 Agent run；完整 Playwright/composite 操作、取消/期限以及 Native worker/服务/SDK 的 Agent 授权链仍需独立实现。K5 保持部分完成，allAgentCdpFenced=false。SDK 27 个合同输入未变，继承先前双平台 78 Node/17 Python、严格 TSC 和 Mac Mypy；本项没有新打包、发布或 Viewer 像素验证。WebGL 指定“WebGL 无法显示”黑框源码保持。41 项仍为完成 9、部分 15、待做 17；未知启动收敛、N1、物理/设备及原 8 小时增长验收均未完成。

见[范围收据](evidence/managed-agent-input.json)。未提交、暂存或推送代码，未修改公共演示，未强制浏览器 GC 或重跑 8 小时。
