# Agent Run 与 Invocation 持久日志

`SqliteSessionStore` 在同一个私有 SQLite 文件中增加 `agent_runs` 和 `agent_invocations`，格式升级为 v4。保留原 Session load 的精确返回形状，Agent 使用独立 `agent_revision`。v1/v2/v3 在同一迁移事务中添加新表；v2 缺失的 Engine Start 历史继续为 legacy-unknown，v3 保留 inode、instance_id、Session/runtime revision 和类型化启动见证。旧代码拒绝新格式，不能降级后忽略 Agent 历史。实际上一检查点 v3 模块创建的 SQLite 也已迁移验证，旧模块再打开 v4 以 STATE_SCHEMA 拒绝，文件 hash 不变。

可信控制进程以全新 Symbol 调用 `claimAgentController(owner)`，并用 `loadAgents({owner})`、`commitAgentRun(row,{owner})`、`commitAgentInvocation(row,{owner})` 操作元数据；`releaseAgentController(owner)` 后才能关闭账本。账本独占文件锁与每次文件/实例身份检查继续生效。返回数据为复制的记录，不含 Page/CDP、Source 地址、凭据或动作参数。原 Session Registry 和 Native runtime owner 可同时存在。

逻辑 arun_UUID/ainv_UUID 与 worker 的 run_UUID、target_UUID、controlSessionId 分开。Run 固定租户、Session、region、Ready version、创建键 hash 与 fingerprint；同一 Session 最多一个 reserved Agent writer。调用固定父 run、工具名、键 hash、动作 fingerprint 和原始四字段 fence。只保存摘要和有界元数据，不保存文本、密码、URL、原始参数或错误 message。调用者必须在执行层验证真实 RPC 回执、对敏感动作使用合适的服务端摘要；任意传入的 hash 本身不证明远端效果或授权。

begin、end 和每个 invocation 只有一次从未请求到已请求的持久派发标记。相同键不能绑定另一个 run/动作，身份、fence、已接受证据和终态不能重写；不得通过 closing→recovery-required→closing 重新获得 end 派发资格。invocation 的 intent/requested 与 injected/rejected/unknown 分开：injected 只表示经验证的输入注入回执，绝不表示业务成功；rejected 明确 not-dispatched，unknown 表示已经进入派发边界而结果未知。unknown 保持终态，即使后来有迟到回执也不自动改写或重放。

换 owner 或重开数据库会把已有 reserved Run 列入 recoveryRequired，已确认的历史保持原样。恢复方不能重新 active、绑定未知 begin、接受新动作或重复派发；只能收尾、把确定未派发的 invocation 记 rejected，或把已请求而未知的调用记 unknown。派发标记与实际 RPC 之间仍有崩溃窗口，宁可保留未知。未派发的 begin 可根据持久历史生成 never-dispatched 关闭摘要；已请求 begin 的明确拒绝及 worker end 只接受匹配的先前派发和经执行层验证的回执摘要。end 不能跳过先前的 requested 标记。

Agent writer reservation 与浏览器配额分开。未知 Agent 元数据不阻挡 Session 关闭；Native Session 仍须满足原来的 runtime 退役见证才能释放配额。对已不可变 closed/expired Session，精确的实际 Session 摘要可关闭不确定 Agent Run；不存在的终态、别的 Session 摘要或猜测没有效果均不可用。不会因 unknown Engine Start、404 或容器看似消失就放宽原内核退役条件。

默认上限为 10000 个 Run、160000 个 Invocation、每行 8192 字节及整个账本 256 MiB，可在构造器设置有限行数；达到上限拒绝新记录，不静默驱逐幂等历史。迁移、容量或写失败整体回滚。Session/tenant 外键、重复键、reserved writer 唯一索引和读回索引校验同时约束记录。

新增29合同，最终 Mac/Linux 的117文件1065项均零失败/取消：Mac1050通过15平台跳过，Linux1059通过6跳过。测试实际 SQLite 重开、事务回滚、独占 owner、文件替换、记录/索引/引用损坏、容量、旧版本迁移、v3迁移 DDL 后 SIGKILL，以及 intent/begin/requested/夹具效果后/receipt 后与未提交结果的实际 writer SIGKILL。文件效果夹具不是浏览器副作用证明。开发首轮两项测试夹具错误已保留失败记录，纠正后64项范围回归通过；后来增加的最终合同由完整1065项覆盖。

SDK API/包内容未变；复用相同 tgz/wheel，重新安装到无源码回退的独立 consumer，使用当前 v4 及新增日志模块的28个输入。双平台78 Node、17 Python、严格TSC通过，Mac Mypy通过；没有新包构建或公开发布，更没有公共 Agent SDK。新标准 Native worker 回归实际0：同页输入 B拼XHFZ、无Viewer滚动80、超时unknown保留在途名额且无重放、人控grant保留、完整namespace移除、重开runtime为retired、holdsQuota=false。该回归使用v4账本和原私有RPC，尚未把这些真实RPC接到新Agent日志。

范围严格为持久元数据及存储恢复隔离。下一检查点才实现异步执行器把派发记录与实际 provider/RPC 调用串联，加入运行/调用查询和幂等重试，再独立完成 HTTP Agent scope 和 Node/Python Agent SDK。durableExecutorIntegrated=false，durableRunInvocationRecoveryQualified=false，publicTenantAgentAuthorizationQualified=false，publicAgentSdkQualified=false，allAgentCdpFenced=false，productionNativeFullyQualified=false。完整Playwright/观察/业务验证、异常故障、N1/物理/设备和原8小时增长仍未验收。41项9完成、16部分、16待做；WebGL“WebGL 无法显示”黑框及其他显示源码不变。未暂存、提交、推送、修改演示、强制浏览器GC、改原门槛或重启8小时。

见[证据](evidence/session-agent-journal.json)。


后续检查点已将真实provider/RPC接入[持久执行器](durable-agent-executor.md)，支持幂等状态、unknown不重放与限定窗口的关闭式恢复；真实Native效果后控制进程SIGKILL及原Session退役已验证。本文此前“执行器尚未接入”属于当时检查点范围；公共Agent授权/API/SDK仍未实现。
