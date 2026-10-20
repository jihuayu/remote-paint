# 可信后端 Agent 持久执行器

`DurableAgentExecutor({store,registry,providers,actionKey,maxConcurrent?,timeoutMs?})` 把同一v4 SQLite账本的 Run/Invocation 接到标准 Native provider 的私有 Agent RPC。create/perform 先同步提交可查询的 intent 再返回 ID，随后异步派发；getRun/getInvocation 查询原状态，context 显式获取原 run 的当前上下文，end 请求收尾，status/shutdown 管理实际在途工作。这里仍是可信后端入口，尚无公共 Agent HTTP 授权或 Agent SDK。

创建键和调用键采用固定域、租户和逻辑 run 的稳定 SHA256 身份；相同键返回同一记录，不再执行。动作 fingerprint 使用配置的32字节 actionKey 作 HMAC，覆盖一次捕获的工具、参数、binding 与原始 fence；参数键顺序正规化，默认值省略与显式参数仍可视为不同请求。原始动作文本/密码/URL、幂等键及错误 message 不入账本。更换 actionKey 会使旧键产生冲突，不能把旧键当作新动作重放。HTTP层后续必须从自己的可信认证状态确定租户和权限。

每个 run 最多一个普通任务和一个独立 end；全局默认各64，可配置1至256，没有等待请求的无界队列。普通查询使用索引定点读取；恢复与关闭以64条一页读取元数据，不在每次调用复制整个历史。owner claim 保留原 loadAgents 调试快照 API，同时支持 compact 模式。恢复隔离只保留父 Run 身份集合，无须保存全部 Invocation ID。恢复遍历在修改状态后继续按原 ID 游标推进，90条历史跨页合同验证未漏项。初版每次读取完整历史的问题由同名合同实际1复现，改为索引/分页后实际0；该结构合同不等于原8小时物理增长已经修复。

每次实际 provider 调用前先持久记录一次 requested，再检查同一个账本 owner、Registry 当前 Ready/region/version 和 run 阶段，发送前没有额外 await。Registry 检查中发生重入 end 也会被最后的阶段栅栏拒绝。provider 方法在构造时绑定；标准 provider 和 worker 原来的身份/版本/私有 owner 栅栏继续生效。回复后再次检查 Ready，严格核对类型、租户、Session、worker run、target 和原始 fence，不能把旧或外来回执记作成功。

只有经类型化私有边界确认的明确拒绝可记录 not-dispatched。未知异常、伪装 outcome 的普通 Error、畸形回执、可能发送后的超时或 Ready 丢失记录 unknown，并隔离该 run；同键重试只查询 unknown，新的输入被拒绝。injected 仍只表示输入注入，绝非业务成功。取消在派发前可拒绝而不调用 provider；signal/timeout 传给私有 RPC，其发送后观察取消不能证明远端已停止。真正停止后续组合步骤需要 end，完整任务期限/事件/业务验证仍待做。

end 在未派发 begin 前关闭其确定未开始的意图；begin 正在执行时先置 closing，迟到的已验证 binding 只用于关闭，绝不重新 active。已知 run 的 end 有独立派发名额，等待标准 worker 的实际队列与 run-closed 回执。结果未知且没有 binding 的 begin 不通过 current-context 猜测绑定，只能等实际 Session 终态收尾。已发送 end 的请求标记不重用，失败或观察超时后不能盲目重试关闭 RPC。人控期间结束 Agent 继续保留人的原 grant 与按键。

执行器重建后，旧 intent invocation 记为确定未派发的 rejected，requested 记 unknown，既有 injected 及终态不改写；旧 run 只允许元数据收尾，没有恢复连接、自动 RPC、重新 active 或新浏览器分配。已证实从未派发的 begin 可关闭；其余旧 run 等待原 Session 真正 closed/expired，再由账本自身计算实际终态摘要释放 Agent writer。Agent 元数据不阻挡 Session 退役，也不能绕开原 Native runtime/namespace 见证和配额规则。shutdown 先停接新工作并收尾，观察期限到期只返回 pending/unconfirmed，实际服务工作还在时不释放 ledger owner；未知远端状态如未收敛仍明确 unconfirmed。

新增31合同，双平台完整118文件1096项零失败/取消：Mac1081通过15平台跳过，Linux1090通过6跳过。包含同步意图/发送前标记、幂等冲突、参数快照/无明文落盘、拒绝与unknown、优先end/迟到begin、重入发送栅栏、关停owner保留、实际文件身份故障、有限容量、分页、密钥变化，以及实际writer SIGKILL的 intent/begin/invocation-intent/requested/文件效果后/receipt 后六个窗口。文件夹具是结构验证，不能当作 Native 页面效果证据。原SDK包字节不变，以当前28个后端输入重新安装测试，双平台78Node/17Python与严格TSC、Mac Mypy通过，没有新包构建、公开发布或公共Agent SDK。

新的真实标准 Native worker 使用同一个执行器与持久账本：七工具、同键同ID/改请求拒绝、独立页面HTTP报告文字B拼、按钮一次、拖动430/130、无人观看滚动80均通过。普通mousedown夹具忙400ms使50ms RPC观察超时，Invocation为unknown，同键无重放，新动作拒绝，独立end等待实际收尾；页面只有一次mousedown，未激活普通click。此为受控工作夹具，不是物理延迟或N1测量。同一页面随后经已有公共Viewer控制授权接管，Agent调用记rejected/AGENT_PAUSED；end后原grant仍能keyup/F，归还后新run最终B拼HFZ。重开正常账本为3个closed run、12 injected/1 rejected/1 unknown invocation。

真实控制进程死亡专项使用独立标准Native Session。先让实际 provider 收到输入回执，再在交回执行器/写入结果之前保持该回执；独立页面HTTP确认只输入一次CRASH，控制进程随即由父进程SIGKILL。重开同一SQLite后该Invocation为unknown，创建和动作的同键重试返回原ID，新动作拒绝，恢复期间没有Agent RPC，也没有重新分配浏览器。Registry只关闭原Session，原namespace退役且配额释放，原Agent run再以实际Session终态关闭，unknown历史不变。正常与死亡专项两个容器均移除，SQLite重开均runtime retired，退役证据文件hash一致；已知控制/代理PID均退出。该证明的恢复范围是六个结构窗口加真实Native效果后/结果前窗口的关闭式恢复，不代表所有异常窗口或可恢复任务重放。

durableExecutorIntegrated=true，trustedDurableAgentExecutorQualified=true，durableRunInvocationRecoveryQualified=true，仅按上述关闭式恢复范围。公共HTTP Agent scope、Node/Python Agent SDK、完整Playwright/其他修改工具、结构化观察/业务验证、完整取消/事件/故障矩阵继续待做。allAgentCdpFenced=false，productionNativeFullyQualified=false；原未知Engine Start隔离、N1/物理/设备与8小时增长仍未通过。41项9完成、16部分、16待做。WebGL“WebGL 无法显示”黑框与其他显示代码保持。未暂存、提交、推送、修改演示、强制浏览器GC、放宽门槛或启动新8小时。

见[证据](evidence/durable-agent-executor.json)。


后续检查点已提供[公共Agent HTTP](public-agent-http.md)：独立agents:read/write/end、可信租户和原始context/fence，持久状态/幂等重试、HTTP观察取消与独立end通道；真实Native授权及票据矩阵通过。此前“公共Agent授权/API待实现”属于当时检查点范围，公共Node/Python Agent SDK仍待做。原K3公共授权合同现有逐项完成审计，完整Playwright/工具覆盖及所有生产故障不在该结论内。
