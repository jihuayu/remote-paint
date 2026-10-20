# Native worker 私有 Agent RPC

可信后端可调用 `DockerSessionProvider.agent({tenantId,sessionId,region,version,command,signal?,timeoutMs?})`，沿原有私有 attach/stdin 通道进入标准 `native-session-worker.mjs` 和同一个 Native Source。命令仅有 begin、context、perform、end；context 可带 runId，省略时显式查询当前 run，用于恢复尚不确定的 begin 结果。perform/end 必须指定 runId，perform 必须带原始 binding/fence；不会自动换成当前版本或降级到无戳输入。Source 内只执行已受管的七个输入工具，没有 Page/CDP、任意 JavaScript 或 Source URL/key 出口。

每个私有 AgentCall 都先验证固定 Session 与 owner credential，requestId 严格递增，只用于关联与拒绝重放，不是业务幂等键。Worker 使用初始化时固定的租户/Session，回执绑定 tenant/Session/target/run 及原始 fence。Provider 在参数捕获后、发送前和回复后检查同一条当前 durable Ready 所有权；外来、恢复、关闭、健康失效或版本漂移均拒绝。begin 只创建该已有浏览器内的临时 run，不再分配浏览器。

私有 Ready 可声明 agent-rpc-v1 能力。新父通道接受旧版 version-only Ready，但在发送前拒绝 Agent 调用，保留会话可用；未知/重复/畸形能力拒绝。没有改变公开 Session Ready 或既有 SDK 的 version-only 结果。旧父通道对新增私有字段仍可能拒绝启动，完整滚动版本矩阵继续由 K4 验收。

每通道最多一个普通调用及一个可优先进入的 end，没有无界请求队列。尚未写入的普通调用在 end 抢占时以 AGENT_RUN_CLOSED/not-dispatched 取消，不能把较新 ID 的 end 先发、再发送旧 ID。单行请求上限 32768 字节，worker 未完成输出预算 32768 字节；实际 stream write 回调后清除请求 Buffer。AgentResult 不占原有八个生命周期帧额度，但必须对应当前已发送请求；陌生、跨身份、错误 fence、额外/畸形回执使通道失效。

调用方 signal/期限是 RPC 观察器的取消：未发送可报告 not-dispatched 并移除；一旦开始写入则报告 unknown，实际在途名额保留到回复或通道终止，不重试、不盲目重放。要阻止后续组合步骤应显式 end；已发送副作用无法撤回。end 自有名额，可到达正在执行的 run，并等待实际队列和输入清理；人控期间 end 保留人的租约与按键。worker 关闭还等待真实 RPC 结束，超过原关闭期限报告 cleanup-incomplete，不能把调用观察器超时当成资源已经退出。

NativeResource 在活动 run 全生命周期持有独立 acquirePageRun 租约，包含两次 RPC 之间等待页面后置条件的时间；不增加 display/observation/recording 编码需求。end、失效、owner abort 或资源关闭释放租约。首轮真实 Native v2 曾出现滚轮 ACK 成功、无人观看时页面时钟却停止，60 秒观察未见滚动，根实际 1；其容器和 namespace 已退役。新增 clock 合同前1后0，并修复 run 生命周期拥有权后，同脚本 v3/v4 均实际0，无 Viewer 的滚动独立 HTTP 报告为80像素。旧 worker 合法非 UUID Session ID 仍可初始化，新管理 Agent 功能对该旧身份明确不可用。

最终新增37合同，全部在两平台完整回归通过。116文件共1036项零失败/取消：Mac1021通过15平台跳过，Linux1030通过6跳过。覆盖严格数据/权限、帧关联、超时/取消后占用、优先结束、未知回执、缓冲清理、输出背压、实际 Node 子 worker、关闭不早报完成、资源健康/时钟及 provider durable Ready。开发中的初版 fake deferred/写回调等待错误和请求 ID 倒序、旧身份兼容、零 Viewer 时钟、旧能力缺失的失败记录均保留；后续绿色完整回归不能覆盖或抹去这些失败事实。

真实标准 Native worker/provider 使用真实 Registry/SQLite/Engine/私有 bridge/内核启动见证，无 Node Source 适配器、无 Source CDP 测试端点、无宿主 Source 端口映射。独立页面报告确认文本 A→B→B拼、按钮一次、拖动430/130、无 Viewer 滚动80，以及同页最终 B拼XHFZ。普通并发调用被本地 BUSY 拒绝。页面普通 mousedown 夹具阻塞400ms后产生 RPC timeout/unknown，名额仍忙；end 等真实步骤收尾，页面只报告一次 mousedown、未激活该普通按钮、没有重放。这是受控主线程工作夹具，不是物理时延或 N1 丢包测量。

同一实际页面随后经已有公共 controller ticket/Welcome/FrameCommit 接管；Agent 写入与人控期间 begin 均 AGENT_PAUSED，结束 Agent 后原人工 grant 继续 keyup/F，明确归还后新 run 写 Z；旧 run 不得作用于新 run。现有安装版 Node SDK只用于创建/查询/释放 Session，Agent RPC由可信内部 provider调用，不宣称公共 Agent SDK 已完成。会话释放后管理状态closed/holdsQuota=false，旧 Agent 路由拒绝。实际 v2/v3/v4 容器均移除，重开账本为retired且退役证据文件hash一致；已知宿主代理/控制进程退出，三个Linux回归容器终止PID0无OOM。

边界：私有 owner credential 不是公网 Agent 用户授权。独立 HTTP Agent scope、公共 Node/Python Agent SDK、持久 Run/Invocation/任务恢复、完整 Playwright/Steel及其他修改工具、结构化观察与业务验证、完整取消/事件、异常故障矩阵仍需后续检查点。allAgentCdpFenced=false，productionNativeFullyQualified=false。SDK原有27输入/包未变，继承双平台78 Node/17 Python、严格TSC及Mac Mypy；未重新打包或发布。未做新的公共Viewer渲染像素、物理/设备、N1或8小时验收。41项仍9完成、16部分、16待做，原8小时增长失败保持。WebGL“WebGL 无法显示”黑框与其他显示源码不变。未暂存、提交、推送、修改演示、强制浏览器GC或重跑8小时。

最终仅补充范围文档形成990文件检查点，见[证据](evidence/private-agent-rpc.json)。


v4同账本已增加Agent Run/Invocation持久元数据及owner恢复隔离，见[日志范围](session-agent-journal.md)。异步执行器尚未把真实RPC接入该日志，公共授权与SDK继续待做；本节原始1036项是当时检查点记录，最新完整回归为1065项。


后续检查点已将真实provider/RPC接入[持久执行器](durable-agent-executor.md)，支持幂等状态、unknown不重放与限定窗口的关闭式恢复；真实Native效果后控制进程SIGKILL及原Session退役已验证。本文此前“执行器尚未接入”属于当时检查点范围；公共Agent授权/API/SDK仍未实现。


后续检查点已提供[公共Agent HTTP](public-agent-http.md)：独立agents:read/write/end、可信租户和原始context/fence，持久状态/幂等重试、HTTP观察取消与独立end通道；真实Native授权及票据矩阵通过。此前“公共Agent授权/API待实现”属于当时检查点范围，公共Node/Python Agent SDK仍待做。原K3公共授权合同现有逐项完成审计，完整Playwright/工具覆盖及所有生产故障不在该结论内。
