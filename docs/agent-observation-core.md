# Source Agent 结构化观察核心

Source受管Run新增observationContext/observe，经独立agent:observe同步授权，固定tenant/Session/target/run。读上下文只含binding和document，不提供controlVersion/写fence；人工接管期间允许读、写仍暂停，Agent end保持原人工grant。Native资源通过agent-observe-v1声明能力，旧worker或小于8KiB接收缓冲的通道在发包前拒绝。标准Docker provider使用固定8KiB接收帧，worker发送仍受8KiB帧/32KiB pending输出约束；通用旧通道默认2KiB保持。

固定可信代码在现有Native隔离环境执行，并在同次JS调用中以原生document token核对Document。固定原Page、capture、CDP发送函数，异步前后重检目标、Native绑定/代次、pageEpoch/viewport与授权，不接收任意JS/CDP/CSS。snapshot、locate(id/tag/testId)、element只读取main-document light DOM。字段为直接文本、少量DOM/ARIA属性和表单值；name仅aria-label/name/alt投影，role仅属性，不冒充computed AX。password/hidden值默认遮蔽。版本/target/epoch/观察时间随结果返回。

默认遍历128、最多256节点；最多16返回节点、2048 UTF-16文本单位，Realm结果4096字节、完整记录6144字节。长Unicode还按实际UTF-8字节截断，truncated明确标记。一个真实观察任务持有名额到实际结算和对象清理；超时/取消不释放实际RPC槽，end独立。清理失败的结束结果为unknown。每次新快照替换句柄表，最多16个opaque ID，以WeakRef对照原节点、Document、连接状态、父/相邻节点及已返回字段的有限指纹，不通过旧selector再定位。revision是快照序号，不是全局DOM mutation counter；GC/新快照也可使句柄失效。此阶段句柄仅可读，不是修改接口。

26项新合同；Mac/Linux完整123文件各1165项零失败（Mac1150通过15平台跳过，Linux1159通过6跳过）。旧Node/Python开发包所有字节未改，重新构建同hash并离线安装，43个当前消费者/服务输入核对；各97Node/37Python/TSC及Mac公共类型与4源码Mypy通过。

真实标准Native页验证DOM/文本/值/权限与元数据、密码遮蔽、iframe/shadow不进入该范围、4000中文截断为1024且句柄可解析；点击替换和改文后旧句柄拒绝。公开Viewer人工接管时仍读、写暂停，读与end保持原grant，页面值OBSHF。真实导航同一Page target的epoch1→2，旧读上下文/句柄/写fence均拒绝，新文档结果准确。3000节点页面只访问32并标记truncated，合法大快照4601字节通过。Source无宿主发布端口，关闭重开账本确认Session closed不占配额、runtime retired与namespace退役文件hash一致，已知控制/代理PID退出。本fixture直接使用可信私有RPC，不生成持久Agent Invocation，不能冒充公共观察或持久任务验收。

首轮Native上述基础行为已过，在大快照处被旧2KiB接收缓冲拒绝，实际退出1。保留该失败与已退役namespace证据；修复标准provider帧配置并加小缓冲事前拒绝/大合法帧回归后，新的Native候选实际退出0。未删失败记录、提高8小时内存门槛或自动重跑8小时。

K6仅部分实现；下一检查点接公共agents:observe权限、持久Run/Registry关联及Node/Python观察SDK、安装/类型与实际Native流程。AX、截图/下载、跨frame/完整定位、write-by-handle、业务后置条件/分类、事件取消、Playwright/文件/Profile、unknown Engine Start、N1/物理/设备与原8小时仍待完成。41项现在10完成、17部分、14待做。原七工具SDK资格沿原范围保留，allAgentCdpFenced/productionNativeFullyQualified/eightHourPassed仍false。WebGL“WebGL 无法显示”黑框及其他显示源码保持。未暂存、提交、推送、修改演示、强制浏览器GC或动原采样器。

见[证据](evidence/agent-observation-core.json)。
