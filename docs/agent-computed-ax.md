'# Source computed AX 与私有 RPC

K6 原始要求包括权限约束下的 DOM/AX、定位、截图、文本与下载及 target/epoch/time/version。本检查点在既有 DOM 核心上实现真正的浏览器 computed accessibility；公开 AX 和其余 K6 并未完成。新私有 op `observe-ax` 需同时协商 agent-rpc-v1、agent-observe-v1、agent-observe-ax-v1，通道至少8192字节。旧worker/小缓冲事前拒绝；公共observations query与SDK不隐含新增AX入口。

调用只接受已有opaque elementId、原binding/document和maxChars（默认256，0..512）。Source在原Native隔离realm解析WeakRef，核对当前原Document/native document token、连接状态、父/相邻节点和既有有界DOM字段指纹。取得原Element临时CDP对象，DOM.describeNode(depth0,piercefalse)确定backendNodeId；Accessibility.getPartialAXTree(fetchRelativesfalse)只请求该原节点的computed role/name/description/value与支持的bool/tristate状态，核对返回backendID；不获取全树、不接受调用方selector/objectId/backendNodeId/脚本/CDP。官方[协议定义](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Accessibility.pdl)描述了这种按节点关闭亲属抓取的读取方式。

AX返回后回到同一realm，以原Element引用再核对身份和DOM指纹，并比较上次已返回的有界AX投影。外部label等变化也使旧AX句柄拒绝；改变maxChars时按原预算重新投影比较，不因纯预算变化错误判陈旧。新的DOM快照仍替换整张最多16句柄表；AX不积累新DOM句柄。revision是原DOM快照序号，observationId/time区分AX读取，不冒充全局mutation counter。password/hidden提前redacted，完全跳过DOM属性和AX请求，ax为null，不伪造computed数据。

结果 stage为accessibility-observed、scope为main-document-element-accessibility，附原binding/document/version/time。role最多64，name/description/value合计最多512 UTF-16单位，value的有限number/bool明确转为字符串，states仅固定bool/tristate白名单；不返回原AX nodeId/backendID、sources、关联节点、完整properties或CDP对象。完整记录6144字节，原Worker帧8192保持。DOM描述与AX回复在Playwright解码后检查32768字节，并限制投影遍历深度/项数及getter；这不是原始传输解码前的分配上限。AX计算/事件/全局浏览器缓存与物理内存预算仍属未通过范围，不能用本检查点替代C5或原8小时。

固定Chromium构建来源的InspectorAccessibilityAgent::disable在未enabled时会直接返回，因而只调用getPartialAXTree后再disable不足以清理该版本创建的上下文；当前[上游源码](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/accessibility/inspector_accessibility_agent.cc)行为已有差异。本实现明确持有enable/disable配对，不注册应用AX事件监听，不订阅/保留整树。实际任务覆盖enable、读取、原节点验证、disable和临时对象group释放，成功清理及再次验证后才返回；读取、清理的非合作等待都持有同一ordinary名额，不能提前排空。清理失败poison后续读但不修改写fence/人控lease，显式end重试自己的清理并等待真实工作；未确认清理返回unknown。禁用只确认本session自己的协议清理，不声称其他AX用户或整个浏览器已释放物理内存。

22项新合同覆盖schema、真实字段投影、身份/budget/遮蔽、实际pending与清理、权限/epoch/Page变化、end和原人工grant、清理失败/重试、Realm AX指纹及私有能力/帧/版本关联；相关68项通过。Mac/Linux完整128文件各1227项零失败，分别1212通过15平台跳过、1221通过6跳过。现有Node/Python包全部源码和字节保持，重建同hash、50项当前服务/消费者输入核对后双平台离线安装115Node/56Python/TSC及Mac公共/5源码Mypy通过。

真实标准Native由已安装Node DOM/input SDK取得原句柄和注入，computed AX走认证私有Provider/Worker通道；并非公开AX SDK。无ARIA role/name的readonly required输入，DOM投影为空而AX得到textbox、外部嵌套label Shipping address、description Confirm delivery、value123及readonly/required；嵌套span按钮的直接DOM文本为空，AX name为Place order，checkbox checked为true。替换为相同id的新按钮拒绝旧句柄，新定位得到Replacement order；外部label改为Shipping changed也拒绝旧AX指纹。相同句柄不同预算可读；800中文AX name截为512且truncated，40000字符嵌套名的浏览器回复超限拒绝后健康读取仍成功，密码ax null。人控期间AX可读、写暂停，读/end保留原grant，值OBSHF；导航epoch1→2拒绝旧AX上下文。结果成功必须经过真实disable/group释放await；这是协议清理确认，不是物理AX缓存测量。

原公开DOM/input unknown与超时/断开流程仍通过。重开账本4closed Run/10injected/2rejected/1unknown，DOM/AX文字不写账本；Session closed不占配额、runtime/namespace退役，已知Node/代理PID退出，Source无宿主发布端口。执行副本的已独立验证Linux broker偏差单列manifest，未改仓库broker/Chromium输出缓存。首轮相关60/68通过，7个失败来自遗漏observedAt，另1个是小通道夹具误以为旧DOM读context仍可通过；补齐字段并按原8192门槛修正夹具后68/68通过。Native验证器的局部变量冲突在冻结最终执行版前修正，未执行错误候选Native；保留开发候选与失败日志。

41项仍10完成/17部分/14待做，K6部分。下一独立检查点接公共AX DTO/权限及Node/Python runtime/类型/安装/Native；再完成截图/下载、完整locator/frame/write-by-handle、K7业务后置条件/分类恢复、K8事件取消、K10适配器/文件/Profile、K4兼容、unknown Engine Start、N1/物理/设备及原8小时。原8小时增长失败未修复/未重跑，未放宽门槛、强制浏览器GC、动采样器/演示/无关peer，未暂存/提交/推送。WebGL“WebGL 无法显示”黑框及其他显示保持。

见[证据](evidence/agent-computed-ax.json)、[Python DOM观察范围](python-observation-sdk.md)及[原始K6清单](optimization-backlog.md)。
