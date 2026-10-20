'# Python Agent DOM 观察 SDK

Python 后端新增 `AgentClient.observations.context(run)` 与 `read(context, AgentObservationInput(...))`。使用独立 agents:observe；reference 为 AgentRun 或带逻辑 Run/Session/version 的 AgentObservationReference。返回读 context 含固定 binding/document，无输入 fence/controlVersion，其他写/结束/Session/Viewer权限不随观察授权获得。

模型均 frozen+slots：reference、context、document、snapshot/locate/element 判别query、limits、input、node、observation；nodes 为 tuple，element/observation ID 使用 distinct NewType。query为AgentSnapshotQuery()、AgentLocateQuery(id/tag/testId,value)、AgentElementQuery(element_id)；参数snake_case。context/read为同步捕获函数，返回可await协程前校验并复制原context、query、limits和私有期限，故调用方即使延后await或以object.__setattr__改原对象，也不改变已捕获请求/预期。只接受指定模型的确切类型，不执行外部自定义对象属性或dict子类钩子。

每次context/read固定一次HTTP，即使client配置mutation retries；无读retries或幂等参数。响应要求200无Location，JSON/requestId与逻辑Run/Session/version、Source tenant/worker/target、controlSessionId/pageEpoch/viewport、原query/limits逐项匹配，严格校验scope/time/revision、nodes/opaque ID/去重/遮蔽和字段长度。文本合计按UTF-16；Source记录6144字节、公有记录8192字节，均独立于HTTP响应预算。冻结查询与结果不提供任意JS/CDP/CSS，不重绑旧selector，不自动取新context/写fence，不重放输入。

调用方取消或本地deadline仅停止等待，底层HTTP/响应体关闭非合作时继续占用实际ordinary名额；end保持独立实际HTTP连接池。aclose仍单flight、固定1秒本地等待，未完成关闭返回CLIENT_CLOSE_PENDING且后台真实关闭继续，新调用拒绝，实际任务结束后再完成关闭。响应清理失败会关闭client。HTTP408已经结束时，Python HTTP槽可以归零而服务端executor槽仍保留；二者分别记录。观察unknown输入后的真实DOM不会更新原Invocation结论或解除writer隔离。

19项新Python合同与旧接口一起56项全部通过。双平台重新构建、离线安装新wheel（10成员，6包文件），49项当前服务/消费者输入核对且无源码fallback，各115Node/56Python/TSC通过；Mac公共Python类型及5源码Mypy通过。Node runtime/declarations逐文件保持，Node包20文件仅README更新Python观察说明。完整Mac/Linux126个JS文件各1205项零失败，分别1190通过15平台跳过、1199通过6跳过。首轮source运行56项已过，Mypy报告17处ObservationExpected联合类型在type(...)分支后无法缩窄，改为isinstance明确分流后最终安装包源码与公共类型实际退出0；初始报告保留。

真实标准Native观察和持久输入均由独立Python进程中的新离线安装wheel调用，Node只管理Session生命周期与Viewer协议；原始HTTP仅用于故意越权/伪造wire检查。固定manifest与origin证明导入venv site-packages内的_observation.py及py.typed，6个安装包源码hash逐项匹配。DOM/password边界、4000中文截断1024后句柄仍可读，替换/改文拒绝旧句柄，同Page导航epoch1→2后拒绝旧context/句柄/写fence通过。人控期间可读、写暂停，观察和end保持原grant，页面值OBSHF；3000节点只访问32且truncated，公开快照4813字节通过。

真实慢点击超时成为unknown，页面实际点击一次；Python观察到其DOM变化，但Run仍recovery-required、原Invocation仍unknown，同key不重放、新输入拒绝，显式end结束。真实Source回包受控延迟时HTTP408/取消仍持有服务端实际槽、独立end可结束、晚到数据不能接管closed Run。Python任务取消返回CLIENT_CANCELLED，取消请求没有送入Source RPC。重开账本4closed Run/7injected/2rejected/1unknown，Session closed不占配额、runtime/namespace退役；Python实际退出0，Node/Python/代理PID均已退出，Source无宿主发布端口。执行副本使用既有单独验证Linux broker，偏差单列manifest；不改仓库broker/Chromium缓存。

Node/Python DOM观察SDK资格在以上范围成立，K6仍部分，41项仍10完成/17部分/14待做。computed AX、截图/下载、完整locator/frame、write-by-handle及业务后置条件仍待实现；K7分类/恢复、K8事件取消、K10适配器/文件/Profile、K4兼容、unknown Engine Start、N1/物理/设备及原8小时仍需完成。原8小时增长失败未修复/未重跑，未放宽门槛、强制浏览器GC、动采样器/演示/无关peer，未暂存/提交/推送。WebGL“WebGL 无法显示”黑框及其他显示保持。

见[证据](evidence/python-observation-sdk.json)、[Node范围](node-observation-sdk.md)、[公共HTTP范围](public-agent-observation.md)和Python包README示例。
