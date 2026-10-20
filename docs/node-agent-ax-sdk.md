# Node computed AX SDK

新增 `AgentClient.observations.accessibility(context, {elementId, limits?: {maxChars}, rpcTimeoutMs?}, {signal?})`。context 来自既有 observation-context，elementId 来自显式 DOM 定位；调用同步捕获全部原始值，再返回 Promise。仅接受严格字段与普通自有数据，不接收 selector、脚本、CDP ID 或 retries。maxChars 默认256、范围0..512，私有 RPC 期限50..120000。复用公共 agents:observe API，每次读取只发一个 HTTP 请求，即使客户端 mutationRetries 为3，也不重试读、不自动刷新 context、重绑元素或重放输入。

响应严格关联逻辑 Run/Session/version、原 tenant/worker/target/controlSession、document、element 和 budget，验证200无Location、固定 stage/scope、UUID/time/revision、文本与布尔状态白名单。Source AX记录6144字节，公开记录8192字节，独立保留外层响应预算。redacted:true 必须 ax:null；否则 role/name/description/value/states 为投影字段，不接受 raw CDP node/source/关系。name/description/value 的UTF16长度合计不得超过请求预算。返回值深度冻结，TypeScript 暴露 readonly 字段及 redacted 判别联合；根入口、backend和agent类型一致。

实际 HTTP fetch、body读取和取消仍保留真实名额直至结算；超时或调用方取消只停止等待，独立 end 容量可用。AX、DOM、输入共用原客户端 ordinary 容量，不因读超时提前释放。远端错误沿用结构化脱敏错误；不改变 Source cleanup、writer隔离或动作账本行为。

17项新增合同覆盖同步捕获、严格关联、冻结/类型/判别、状态白名单、UTF16/Source/公开/传输字节、单请求、旧上下文、非配合fetch/body.cancel、取消/独立end，以及真实SQL/HTTP权限、unknown输入可读但历史隔离保持、HTTP408实际executor槽。首轮54项相关测试有一处夹具误把完整读context传为Run reference，按原接口修正后54/54；SDK行为未放宽。最终130文件1265项双平台零失败：Mac1250通过/15跳过，Linux1259通过/6跳过。

重新构建Node20成员开发包；Python10成员wheel字节保持。52个当前服务/合同输入逐hash核对，Mac/Linux新目录离线安装各132 Node、56 Python和TypeScript通过；Mac公共Python类型与5个源码模块Mypy通过。Native进程只加载新安装包中的Node AX方法，原始HTTP仅用于故意伪造或无权限的拒绝案例。

真实SDK→公开HTTP→DurableExecutor→私有Source→canonical Native验证外部label Shipping address、description Confirm delivery、value123、textbox/readonly/required、嵌套按钮Place order、checkbox checked；相同句柄预算变更、替换同id元素/外部label变化拒绝旧句柄、512中文截断、超大AX拒绝、密码ax:null、导航旧epoch拒绝。人控期间可读而写暂停，读/end保留原grant与页面值OBSHF。实际慢点击成为unknown后AX读到Unknown action observed，原历史仍unknown、writer仍隔离、同key未重放、新输入拒绝。SDK收到HTTP408或CLIENT_ABORTED时实际executor槽仍占用，独立end可完成。4closed Run/10injected/2rejected/1unknown，Session不占配额、runtime/namespace退役，已知Node/代理PID退出；Source无宿主发布端口。执行副本沿用单独验证的Linux broker偏差，不覆盖仓库broker或Chromium缓存。

资格仅扩展到Node computed AX SDK。Python AX SDK、截图/下载/完整locator/frame/write-by-handle、业务后置条件仍待做。32KiB raw AX检查在Playwright解码之后，不能证明接收前分配或浏览器AX物理缓存上限。K6仍部分，41项仍10完成/17部分/14待做；保留K7/K8/K10/K4、unknown Engine Start、N1/物理/设备和原8小时全部目标。原8小时增长失败未修复/未重跑，未放宽门槛、强制浏览器GC、改采样器/演示/无关peer，未暂存/提交/推送。WebGL继续“WebGL 无法显示”黑框，其他内容正常显示。

见[证据](evidence/node-agent-ax-sdk.json)、[公共AX接口](public-agent-ax.md)和[原始清单](optimization-backlog.md)。
