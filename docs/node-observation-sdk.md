'# Node Agent DOM 观察 SDK

`AgentClient` 从 Node 包根、`/backend` 和 `/agent` 提供 `observations.context(run)` 与 `observations.read(context, input, {signal?})`。reference 必须包含逻辑 agentRunId、Session 和 pinned version，完整 AgentRun 可直接使用。读上下文包含固定 Source binding/document，无写 fence/controlVersion；`agents:observe` 独立权限保持。现有七输入工具接口和 Python 包内容保持。

runtime 在 await 前完整捕获普通 data 对象，拒绝 getter、未知字段、伪造逻辑标识、写上下文替代读上下文、任意JS/CDP/CSS。query 支持 snapshot、locate(id/tag/testId)、opaque element；输入 limits 归一化默认 maxNodes8/maxChars1024/maxVisited128，最大16/2048/256，显式私有RPC期限50..120000。读 options 只接受 signal；即使 client 配置 mutation retries，每次 context/read 仍只发一次 HTTP。没有读幂等键、自动读新 context、重取写 fence、旧 selector 重绑或输入重放。

返回严格要求200且无Location，验证 requestId/JSON envelope，再逐字段检查逻辑 Run、Session、version、Source tenant/worker/target、controlSessionId/pageEpoch/viewport、原 query/limits、time/revision/scope、节点集合/opaque句柄/去重/长度/遮蔽。文本按UTF-16合计，Source记录独立6144字节、公有记录8192字节；外层transport响应预算保持。context、数组、节点及嵌套metadata深度冻结，公共TypeScript判别query、distinct IDs和readonly字段从根及agent入口导出。role/name为有限DOM属性，不冒充computed AX。

本地abort/deadline仅结束等待；底层fetch、响应体和body.cancel实际结束前，仍持有共享有界ordinary名额。end沿用独立名额和权限。HTTP已返回408而Source工作仍在运行时，SDK的HTTP槽可结束，服务端executor的实际槽继续保持；没有把这两个层次混成同一生命周期。known-bound同owner recovery-required输入可观察，但不能据DOM结果改判Invocation成功或解除写隔离。

18项新SDK合同：Mac/Linux完整126文件各1205项零失败（Mac1190通过15跳过，Linux1199通过6跳过）。新Node开发包20文件，双平台重新离线安装，47当前服务/消费者输入核对且无源码fallback，各115Node/37Python/TSC通过；Mac公共类型和4源码Mypy通过，Python wheel字节保持。初轮新旧Agent合同36/37通过，唯一失败是字节测试夹具实际未达到其声明的8192字节；修正为独立Source/public超限样本后37/37通过。再补根入口新类型引用并调整Native的非法query期望为SDK本地CLIENT_INVALID_REQUEST，冻结最终候选，完整回归和Native实际退出0。早期候选和失败日志保留。

真实标准Native全程观察和持久输入均用新离线安装Node包；原始HTTP只用于故意越权/伪造wire的服务端边界检查。独立observe/read凭据隔离，DOM/password、4000中文截断1024后句柄可读，替换/改文拒绝旧句柄；同Page导航epoch1→2拒绝旧读上下文/句柄/写fence。人控期间可读、写暂停，观察与end保持原grant，页面值OBSHF。3000节点只访问32并截断，4813字节公开大快照通过。

真实慢点击超时成为unknown，点击一次后SDK观察实际DOM；Run仍recovery-required，历史unknown不变、同key不重放、新输入拒绝、显式end结束。真实Source回包受控延迟时，SDK收到HTTP408/客户端abort而服务端实际槽保持，独立end可执行，晚到数据不能接管已closed Run。重开账本确认4closed Run/7injected/2rejected/1unknown，Session closed不占quota、runtime和namespace退役、已知Node/代理PID退出，Source无宿主发布端口。Native使用既有独立验证Linux broker的执行副本；该二进制偏差在冻结manifest单独记录，不改仓库broker或Chromium构建缓存。

41项仍10完成/17部分/14待做，K6部分。下个独立检查点为Python观察SDK；其后computed AX、截图/下载、完整locator/frame、write-by-handle、业务后置条件/分类、事件取消、Playwright/文件/Profile、兼容矩阵、unknown Engine Start、N1/物理/设备及原8小时仍需完成。原8小时增长失败未修复/未重跑，不放宽门槛、不强制浏览器GC、不动采样器/演示/无关peer修改；未暂存、提交或推送。WebGL“WebGL 无法显示”黑框及其他显示保持。

见[证据](evidence/node-observation-sdk.json)、[公共观察接口](public-agent-observation.md)和包内README示例。
