# Remote Paint 优化实施进度

目标覆盖 [41 项优化清单](optimization-backlog.md)及轻微丢包下的体验优化。当前实现保留在本地工作区，不提交、不推送（用户最新要求）。既有 `live/peer.mjs` 无关修改保持原状。Chromium 与 Cargo 构建缓存保留。

WebGL 暂使用黑框和“WebGL 无法显示”占位，保留原区域的变换、裁剪、透明度和层级，页面其余内容应正常提交。原 C12/B13 的 WebGL 位图或视频回退暂不实施。


最新长测状态：尚无独立8小时通过。旧8小时v2在第3575轮失败，238个完整样本的原始绝对上限及10项状态匹配增长域未越界，仅作失败前缀分析。时钟重绑定、失败窗口停止及浏览器进程退役取样已分别补复现和检查。714文件v11基线通过，但同版轻丢包试跑在第416轮触发原有3秒Gateway Ping超时，失败与完整清理证据均保留。

当前717文件候选已修复大消息阻挡Pong及挂载表合法分段读取的问题，Mac/Linux各400项JS和157项Rust通过；13项原生专项、14档真实大资源弱网以及CPU/GPU的WebGL文字占位通过。双平台本地Broker产物已更新并保留旧版本。新600秒v12基线已通过：约614.853秒、19样本、2145个配对帧及44次输入像素证明，8个Source均关闭；同版弱网也已通过约605.514秒、14样本、1780个配对帧及32次输入像素证明，内核记录1565次丢包。新720文件独立8小时v3已启动，仍待完整时长、原物理策略和全链路清理验收。原超时、内存上限和物理增长策略不变，失败时间不累计。下文早期“正在运行”属于当时检查点状态。

## 实施顺序

1. WebGL 来源识别、占位协议、Viewer 显示和真实原生链路验收。
2. 弱网输入流水线、控制优先调度、多帧 credit、帧龄与恢复，补网络劣化实验。
3. 客户端 GPU 呈现和损伤重绘，缓存、内存与生命周期。
4. 原生订阅、资源 LRU、二进制元数据与 Gateway 调度。
5. SDK 接入、权限与会话边界、部署发布和兼容长时验收。

每项达到原清单验收条件后才标记完成；仅实现部分时记录剩余条件。物理 IME、目标设备、真实公网、长时测试与产物验证分别记录。

## 41 项状态

| 编号 | 优化 | 状态 | 验收与证据 |
| --- | --- | --- | --- |
| C1 | GPU 直接呈现 | 已完成（Chrome WebGL2） | Worker/主线程共享 GPU pass 与 picture cache，ImageBitmap 提交无需 JS/CanvasKit 像素读回。Mac Metal 与 Linux SwiftShader 的 alpha、文字、resize、context lost/CPU 和 2D 回退通过；软件 WebGL 默认选择 CPU。WebGPU 未编译进当前 Wasm，其他浏览器另属 C12。 |
| C2 | 屏幕损伤区域重绘 | 部分实现 | 持久 pass surface、旧/新矩阵位置和子 pass 损伤传播、整数 scissor/不可见 quad 剔除；相同画面跳过呈现。120 轮完整重画像素对照和 Mac/Linux GPU/CPU 两路径通过。GPU 根图与 bitmaprenderer 仍有整图传递，CPU raster snapshot 的拷贝尚待减少。 |
| C3 | 取消对单个输入 ACK 的逐条等待 | 已完成（已测范围） | 16 个有界有序输入；合并仅限未发送且语义一致的移动/滚轮；租约撤销清队列，重连重置序号。真实原生输入/IME 回归保留；默认原生Source的两个独立13组矩阵、共26,000次文本输入完整到达且实际Worker像素确认，每组均通过动画、22次移动拖动、300ms全丢包及重连租约清理，见[最新网络证据](evidence/native-source-loss-default.json)。 |
| C4 | 优化启动与版本缓存 | 已完成（Chrome 两条路径） | 公开静态资源以整体内容指纹发布，immutable/ETag/gzip；入口和会话配置 no-store。预加载不重复下载，Wasm 执行前 SHA 校验。69 项单测与实际浏览器缓存/损坏/版本拒绝验收通过；启动资产异步压缩并与浏览器并行准备。 |
| C5 | 管理完整客户端内存 | 部分实现 | buffer/解码/pass/元数据预算、增量记账、Wasm/Skia观察及轮换保留；修复退役Wasm backing归属和CanvasKit忽略wasmBinary导致的重复Base64分配。原始物理策略独立30分钟测试通过，逐项重算两种状态的全部10项增长域及绝对上限。两次独立8小时失败均保留；649文件v2在约164分钟因时钟探针失败，238完整样本的原上限/10增长域未越界，尚未通过8小时。 |
| C6 | 有权限边界的持久资源缓存 | 待实现 | 按原清单验收，记录实际证据 |
| C7 | 改善指针和编辑的即时反馈 | 已完成（公开文本、Chrome 两路径） | input-feedback-v1 显式协商；仅标记公开且非敏感的文本可预览，待确认新字始终遮挡；光标/hover、接管与输入阶段区分。独立版本化 FeedbackState 不阻塞 InputAck，焦点/租约/原生画面屏障拒绝迟到状态。93 项单测及真实 Rust/Node × Worker/主线程 4 组通过；系统 IME、访问性和跨浏览器另属 C8/C12，不预测滚动。 |
| C8 | 完整 IME 与访问性 | 待实现 | 物理系统候选窗与语义层仍待验收。C7 实验发现 CDP 取消替换选区的组合文本后不恢复原选区；已保留失败与独立复现，未描述为完整 IME 支持。 |
| C9 | 分辨率与设备能力自适应 | 待实现 | 按原清单验收，记录实际证据 |
| C10 | 明确各种 ACK 的语义 | 部分实现 | InputAck.stage=input-injected；Welcome.ackStage 和 FrameAck.stage=scene-submitted，提交前必须完成资源校验/解码/绘制。只读消费另用consumer-released归还在途帧额度；没有物理呈现或业务成功ACK，收到字节与资源可用的独立反馈仍待补。 |
| C11 | 页面隐藏与设备故障恢复 | 部分实现 | 显示与 Agent 活动分离；真实 Chrome 隐藏/冻结恢复、导航后新基线、Worker 异常与静默退出回退、旧输入租约清理通过。128项单测；物理休眠及其他目标设备生命周期仍待验收。 |
| C12 | 浏览器兼容与区域回退 | 部分实现 | WebGL 黑框及文字占位通过真实 Linux/CanvasKit Worker 像素验证；矩阵、裁剪、透明度单测通过。其他纹理、浏览器和复杂合成仍待验收。 |
| C13 | 控制消息与重放队列调度 | 部分实现 | 默认 Worker 的控制连接改在主线程，绕过慢 SHA 和 Worker 的同步忙碌：注入 1.2 秒 Worker 阻塞时输入确认约 8 ms、撤销约 19 ms。主线程兼容路径仍可能被同步重放阻塞；数据解码切片和过期 viewport 取消待补。 |
| K1 | 稳定 Session API | 部分实现 | SQLite注册表与HTTP创建/查询/释放已接通，可信Bearer租户与独立scope，幂等/TTL/配额/重启隔离及请求限制。Node ESM客户端带TypeScript声明、固定原请求/键的手动或显式重试、响应校验与取消/未知结果分类；实际丢失HTTP响应后重试仅分配一次。Mac/Linux各72项通过及严格类型检查退出0。连接票据与实际Native provider仍待接入，未发布完整公共SDK。见[客户端证据](evidence/session-client.json)及[接口说明](session-control-api.md)。 |
| K2 | 可嵌入 Viewer | 待实现 | 按原清单验收，记录实际证据 |
| K3 | 安全授权 | 部分实现 | 后端HTTP已使用可信Bearer租户认证与创建/读取/释放独立scope，管理客户端禁重定向和浏览器运行。现有控制子连接使用绑定原Viewer/Session的10秒一次性票据，错误Origin/跨Viewer/重放/过期拒绝；主Viewer本地key仍待替换为绑定租户、Session、角色、期限、audience且可撤销的Viewer ticket，不能据后端认证声明K3完成。 |
| K4 | 版本和能力协商 | 部分实现 | frame-window-v1/control-channel-v1 能力协商；新客户端携带静态 build hash，错配关闭 1008 并显示刷新提示。未声明 build 的旧 harness 客户端仍走兼容路径；完整 SDK/Chromium/SKP 兼容表待补。 |
| K5 | 输入与多角色控制 | 待实现 | 按原清单验收，记录实际证据 |
| K6 | 结构化观察与结果 | 待实现 | 按原清单验收，记录实际证据 |
| K7 | 动作和业务成功分离 | 待实现 | 按原清单验收，记录实际证据 |
| K8 | 取消与长任务事件 | 待实现 | 按原清单验收，记录实际证据 |
| K9 | 开发者体验和发布 | 部分实现 | Node ESM/.d.mts及Python3.11+ asyncio客户端已生成私有tgz/纯Pythonwheel；白名单核对源码/类型/元数据，Mac/Linux离线独立安装各74项Node及16项Python合同通过，TypeScript两平台通过、Python安装包PEP561/严格类型Mac通过。没有SDK源码回退。包仍是未发布开发版，缺完整Viewer/Agent示例、Native/票据与滚动版本验收。见[包证据](evidence/session-sdk-packages.json)及[复验说明](session-sdk-packages.md)。 |
| K10 | Agent 与文件集成 | 待实现 | 按原清单验收，记录实际证据 |
| B1 | 原生持续采集与按需订阅 | 已完成（Linux ARM64 受管 Source） | 浏览器原生订阅/真实document与frame token、输入水位及credit交给Rust自主Mapper/Gateway；正式浏览器与双平台Broker已更新并保存旧产物。[正式路径验收](evidence/native-source-default-acceptance.json)含76项C++、Mac/Linux各221项JS、当前57MiB/2MiB压力/45MiB旧RPC/423回滚、完整直播/Node回退/WebGL文字占位/真实9MiB及200ms Gateway关闭、12 Source/48进程身份清理；24次跨站导航、重置/实际Retry/64MiB压力/六消费与完整内核矩阵保留精确版本证据。Linux BeginFrame页面时钟仍由Node驱动，取消逐帧捕获登记/map/publish/Runtime.awaitPromise。标准构建图/双架构发布、其他平台兼容、完整Session/PSS及长时N1分别继续。 |
| B2 | 更精确的时钟和消费需求 | 已完成（Linux受管Source） | 显示/观察/录制/页面运行独立计数，受管Agent输入临时持有页面运行租约；零显示观察/录制真实像素、输入与新帧屏障、导航/resize、慢端隔离、64MiB压力恢复、延迟首消费者及关闭通过。198项JS每平台、137项Rust同修订及22组冻结/7组正式复验，见[需求与消费证据](evidence/source-consumer-demand.json)。B1原生持续订阅与完整SDK另列。 |
| B3 | 根据损伤与可见性选择 tile | 待实现 | 按原清单验收，记录实际证据 |
| B4 | 字体与图片缓存平滑淘汰 | 部分实现 | 字体/图片各32MiB、128项LRU；同键进行中编码共享，编码和等待在缓存锁外。23项C++、137项JS和真实140图像素压力通过：稳定字体仅编码一次，图片按字节淘汰并保持预算。旧版帧级指标不能可靠区分编码归属，冷缓存尖峰的性能对照仍待完成；八小时冻结版本不含此改动。 |
| B5 | 减少新增 glyph 的重复工作 | 待实现 | 按原清单验收，记录实际证据 |
| B6 | typed Scene 与端到端二进制元数据 | 待实现 | 按原清单验收，记录实际证据 |
| B7 | 有界多帧流水线 | 已完成（原生数据面） | 原生 Gateway 协商最多 6 帧、16 MiB 与 512 项资源 credit；单个大关键帧可独占窗口，仍受既有帧预算约束；5 秒最老帧超时。连续发送基线、资源 pin/reuse、晚 ACK 恢复、旧客户端与超字节窗口合同验收通过；真实内核丢包矩阵、拖动、全丢包及重连通过；完整原生验收确认排空后 17/17 资源，慢客户端独立断开。长期压力另属 C5/B10。 |
| B8 | 控制和大资源的优先级 | 已完成（Rust 与默认 Worker） | 独立控制 TCP/WS 连接与主线程控制处理；默认Viewer资源协议块≤32KiB。未协商块协议的消费者，其大逻辑消息也以≤64KiB的WS片段发送，允许协议Pong穿插，保持应用消息顺序、原长度/字节预算和15秒进度看门狗。真实大资源、控制输入及票据边界通过；最新补验见[片段与Pong](evidence/gateway-fragment-kernel-netem.json)和[原生回归](evidence/gateway-fragment-native.json)。 |
| B9 | 选择性压缩与帧打包 | 待实现 | 按原清单验收，记录实际证据 |
| B10 | 资源缓存的归属和回收 | 部分实现 | 既有分域准入和64KiB录制键索引保留；CDP/RPA timing移动已有键/值，畸形对象返回错误且不提交Mapper。双平台各129项Rust、14组原生合同和5组正式复验通过；Cpp47及JS188各复用未改验收。活跃Source/瞬时编码、Node/VM、Session/PSS仍待补。 |
| B11 | 降低 IPC 复制和写锁等待 | 待实现 | 按原清单验收，记录实际证据 |
| B12 | Gateway 事件驱动和共享计算 | 待实现 | 按原清单验收，记录实际证据 |
| B13 | 真实网站兼容与可用回退 | 部分实现 | WebGL按约定占位；Canvas2D补齐同帧像素/SKP，软件与ANGLE SwiftShader GPU API的透明/缩放/变换/圆角/动画/导航/resize/压力恢复通过。物理GPU/Mac原生、OOPIF、视频、复杂滤镜仍待验。 |
| B14 | 区域和传输部署 | 待实现 | 按原清单验收，记录实际证据 |
| B15 | 会话密度与调度 | 待实现 | 按原清单验收，记录实际证据 |
| B16 | 定制浏览器的持续维护 | 部分实现 | Broker 构建产物和 receipt 原子替换，已验证旧进程在替换期间完成 880 次 IPC 并继续监听。旧基线双架构CI第2次尝试均在245分钟编译步骤超时，打包smoke跳过，增量/缓存保存步骤成功；新改动未提交/推送。SBOM、签名、回滚与持续升级验收待补。 |
| B17 | 更快且更稳的 Session 首帧 | 已完成（本地原生链路） | 导航 commit 后建立捕获，导航/捕获/首场景分开。实际持续加载 HTML、慢图和 SSE 均未结束时可显示首帧；资产准备与浏览器并行，3 对冷进程诊断串行/并行中位约 296/196 ms（不是 SLA）。 |
| B18 | 减少服务器重复绘制 | 待实现 | 按原清单验收，记录实际证据 |

当前 9 项在列明范围内完成，14 项部分实现，18 项待实现；N1 的真实大资源14组及小资源两轮完整13组同帧帧龄矩阵已通过；真实大资源同帧帧龄14组及3组试跑已通过，千次输入扩展版的两个完整14组独立运行已通过，分层丢弃与恢复指标已通过当次用例验收，长时负载继续。

## 本轮可复查证据

- [WebGL 原生像素与删除恢复](evidence/webgl-placeholder-live.json)。
- [六帧/字节窗口、基线和资源生命周期](evidence/frame-window.json)。
- [控制通知绕过慢 SHA 校验](evidence/control-priority.json)。
- [持续加载页面的首帧](evidence/streaming-startup.json)。

FrameAck 确认场景已校验和绘制提交，不承诺物理显示扫描；InputAck 确认输入已注入，不承诺业务成功。多帧模式的 delta 基线是最后发送的帧，资源直到所有相关 inflight 与已确认基线不再引用后才释放；恢复时明确放弃旧窗口并发送完整基线。

## 轻微丢包专项

最新默认原生Source已通过两个独立完整13组矩阵，共26,000次文本输入；每组均验证实际Worker动画/拖动像素、300ms全丢包恢复、自动完整基线重连及旧人工租约撤销，见[最新网络证据](evidence/native-source-loss-default.json)及文末逐组数据。真实9MiB内核弱网14组矩阵与独立3组试跑也已通过，[大资源网络证据](evidence/native-source-bulk-network-default.json)记录实际Worker图像及输入像素、输入确认和清理。带时钟校准的同帧像素观察器已在基线与150ms/2%两个配置各两次运行通过，见[观察器证据](evidence/native-source-frame-age-observer-default.json)；随后c5d在同一535文件冻结版上通过两轮完整13组、26000次输入及23238个配对帧，见[完整帧龄矩阵](evidence/native-source-frame-age-matrix-default.json)；真实单项9MiB依赖的同帧帧龄14组及3组试跑也已通过，[大资源帧龄证据](evidence/native-source-bulk-frame-age-default.json)记录40个实际大资源帧及272次输入；千次输入扩展版的两个完整14组独立运行也已通过，见[千次输入证据](evidence/native-source-bulk-exposure-default.json)；分层丢弃与恢复指标已通过[统计验收](evidence/native-source-loss-metrics-default.json)，长时压力仍待补，N1未完成。输入来自合成beforeinput，可合并中间状态，不包含物理键盘与屏幕扫描。

以下[早期内核报告](evidence/network-loss.json)及表格保留各自旧版本和采样范围，不替代最新默认原生候选的证据。

同一隔离 Linux ARM64 网络命名空间中，tc 仅匹配 Gateway TCP 端口，源 CDP 不受劣化；带宽 20 Mbit/s，并加入抖动。每组 1,000 次输入，全部到达且像素确认，采集错误为 0。各劣化组 tc 实际记录 34–276 个丢包；这与应用层丢弃整个资源消息的恢复实验分开记录。

| 配置 RTT | 丢包 | 输入至像素 p50 / p95 / p99（ms） |
| --- | --- | --- |
| 无劣化 | 0% | 42.7 / 59.2 / 67.8 |
| 20 ms | 0.5% | 83.0 / 105.4 / 120.8 |
| 40 ms | 1% | 105.6 / 152.3 / 208.4 |
| 80 ms | 1% | 164.3 / 300.2 / 366.3 |
| 150 ms | 2% | 373.2 / 761.9 / 952.3 |

实际 WebSocket Ping RTT 分布保存在原始数据中，例如 80 ms/1% 组为 75.9–93.3 ms。该结果验证当前路径能在轻微丢包下继续推进，没有历史版本同条件 A/B，不能据此承诺优化幅度；也不是跨机器公网测量。

最新二进制在增加 512 项资源 credit 与实时缓存统计后，额外复跑 80 ms/1% 的 1,000 次输入，p50/p95/p99 为 161.2/295.1/368.7 ms；拖动终点像素正确。300 ms 全丢包结束后 505 ms 恢复像素，显式断开旧连接后 701 ms 建立完整新基线并撤销旧租约，详见 [最新弱网生命周期回归](evidence/network-loss-lifecycle.json)。全矩阵与该回归共 14,000 次输入。全矩阵保留其实际执行版本 hash，避免混淆后续小改动的版本。

完整原生回归见 [报告](evidence/optimization-native-live.json)：像素差异 0.97%，私有/Blob 图片和文字 ink 验收通过；资源缺失重发、导航、resize、慢客户端隔离通过，窗口排空后缓存精确回落至 17/17 项资源；无人观看后停止采集。

N1 完整目标：在实际 RTT 20/40/80/150 ms、0.5%/1%/2% 丢包、抖动和受限带宽下验证输入、拖动、动画和大资源；测试短时断线恢复。统计输入到真实像素 p50/p95/p99、帧龄、恢复耗时、队列字节峰值及丢弃原因。

可靠资源与增量依赖不得直接丢弃。丢弃仅针对尚未发送且可替代的显示状态；重新连接后建立新基线。WebSocket 的 TCP 重传仍会导致同一连接内的队头阻塞，应用层实验须与内核实际丢包实测分别记录，不能混称为网络丢包验收。

## 历史基线双架构构建

[GitHub 双架构构建 38891606933](https://github.com/jihuayu/remote-paint/actions/runs/38891606933)第2次尝试已结束，arm64/x64的Compile patched Chromium步骤均在245分钟超时，打包smoke跳过。增量输出与缓存保存步骤均成功，见[最新API复核](evidence/baseline-ci-second-timeout.json)。该运行固定旧提交08aefec，不包含当前未提交的优化；尚无当前双架构产物验收。本次只读核对，没有取消或重跑工作流。

## 独立控制与大资源调度验收

[配对控制合同](evidence/paired-control-contract.json)验证真实 Rust WebSocket、8 MiB 夹具字体、分块 SHA 与重组、ControlLease；CDP 在该合同中为模拟，不代表真实像素。暂停数据读取 800 ms 时输入确认继续通过；控制票据不可跨 Viewer 或重放，错误 Origin 拒绝。四组数据/控制连接同时在线，第五个 Viewer 被拒绝；关闭控制连接会撤销租约并关闭对应数据连接。

[内核数据链路实验](evidence/bulk-native-contract-network.json)只对数据下行配置 40 ms 延迟、1% 丢包与 2 Mbit/s，控制连接使用独立优先级类。8 MiB 数据约 34.3 秒传完，全部字节校验正确；不能把该实验的几毫秒 ACK 当作共享公网链路表现。

[真实图片共享弱网实验](evidence/bulk-native-network.json)使用实际 Linux Chromium → Rust → CanvasKit，Gateway 两条连接共同受到配置的 80 ms RTT、1% 丢包及 2 Mbit/s 带宽约束。12 次输入均在图像提交前得到确认，ACK p50/p95 约 275/482 ms，图像及后续输入像素约 5.34 秒全部就绪；三处图像抽检像素精确，Viewer 不请求源图片 URL。ACK 是注入确认，不是像素或业务完成。

[Worker 阻塞实验](evidence/worker-control-isolation.json)人为阻塞 Worker 1.2 秒，主线程仍收发输入并显示控制撤销，约 8/19 ms。它验证事件循环隔离，不是任意 Wasm 解码耗时的测量。

新版配对传输另在[冻结版本](evidence/network-paired-loss.json)跑完 13 组、13,000 次文本输入，全部到达且确认原生像素，采集错误为 0。该矩阵在静态资源缓存改造前冻结，具有自己的文件/二进制 hash，不能混作缓存启动性能证据。

## 启动缓存与版本验收

[实际缓存报告](evidence/viewer-asset-cache.json)覆盖 Chrome Worker 与主线程：首次打开、第二个页面和正常刷新分别记录网络字节、Wasm 获取/校验/初始化和首帧。Wasm 原始 8,242,911 字节，gzip 3,484,204 字节；首次预加载只下载一份，二次打开与刷新传输均为 0。新页面的实例化和调度仍有成本，少量本地样本不支持每次二开都会更快的承诺。

公开脚本、样式和 Wasm 使用不可变指纹路径；入口与会话配置不缓存，私有绘图内容不写入 HTTP 持久缓存。每次命名空间同时取决于资源和转换逻辑。错误资源版本返回 410；Wasm 损坏在执行前拒绝；Viewer build 错配关闭 1008，并在两条浏览器路径显示明确原因。保留校验后的 ArrayBuffer 初始化，未启用未经完整性检查的流式执行。

静态资源准备采用异步压缩，同一版本并发准备合并，公开 bundle 缓存最多两版。[交错启动诊断](evidence/startup-asset-preparation.json)在独立 Node 进程与原生浏览器中运行 3 对，串行/并行 Session 准备中位约 296/196 ms；首个串行样本与宿主构建重叠，原样保留。该诊断不包含 Viewer 呈现，不是延迟 SLA。

当前完整原生动态回归通过：图像与文字验收、资源缺失恢复、导航、resize、慢客户端隔离、无人观看停止采集均正常，排空后缓存 17/17。导航/resize 期间 3 次捕获因代数变化作废并恢复，详见[完整报告](evidence/optimization-native-live.json)。[构建替换报告](evidence/atomic-broker-rebuild.json)与[本地未提交版本记录](evidence/optimization-local-revision.json)记录实际进程与二进制 hash。

## GPU 呈现验收

[Mac Metal](evidence/gpu-presentation-mac.json)与[Linux SwiftShader](evidence/gpu-presentation-linux.json)在主线程和 Worker 各比较 60 帧 960×640 场景。GPU pass/picture 缓存全部使用同一 GrDirectContext，测试拦截确认没有 CPU raster surface、CanvasKit readPixels 或 WebGL readPixels 调用。初始透明层抽检为约 [255,128,0,64]，文字 ink 保留；上下文丢失后使用原资源在 CPU 重放，像素与 CPU 对照一致。初始化 GPU 不可用、仅 2D context、resize 和重置后的迟到 bitmap 均通过。当前 CanvasKit Wasm 没有 MakeGPUDeviceContext，未宣称支持 WebGPU。

[实际原生回归](evidence/gpu-native-live.json)强制使用 Linux GPU 路径，文字/私有图片、增量复用、输入 watermark、缺资源重发、慢 Viewer、重连、导航与 resize 全部通过；排空后缓存 17/17，Viewer 错误为空。[WebGL 占位回归](evidence/gpu-webgl-placeholder-live.json)仍能显示黑框文字及其余 DOM 更新。导航期间原有捕获失效按阶段保留在报告中。

分段测量只覆盖本地提交耗时，不包含显示扫描或网络闭环。Mac 的硬件 GPU 路径减少该探针的提交耗时；Linux 软件 WebGL 反而更慢，因此自动模式按实际 renderer 选择 CPU，可用 ?gpu 强制测试、?cpu 强制 CPU。ImageBitmap 向浏览器提交仍可能包含内部 GPU 拷贝，不能称为绝对零拷贝；GPU 驱动缓存预算也不等于完整客户端内存管理。源码 hash 见 [C1 版本收据](evidence/gpu-local-revision.json)。

## 损伤重绘实施与未完成部分

每个 pass 保留 surface；变化的 quad 合并旧/新矩阵映射范围，子 pass 的局部损伤经过父矩阵和目标裁剪传播，按整数矩形 scissor 重画。透明背景先在损伤内清除，再按原有 Viz 顺序叠加；不可见变化与相同图像不触发呈现。透视或未来 effect 依赖按全 pass 损伤处理；当前 Viz 仍拒绝的滤镜没有因此获得渲染支持。旧 pass 移除、resize、格式变化和失败均释放所属 surface。

74 项 Node 单测通过，其中 120 次变化逐像素对照每次重新分配的完整重画，覆盖移动、旋转、滚动、透明叠加、裁剪、层级变化、resize 和背景 alpha。独立小 caret 验证旧位置擦除和子损伤传播；失败后重新渲染可以恢复。

[Mac](evidence/damage-presentation-mac.json)与[Linux](evidence/damage-presentation-linux.json)在主线程及 Worker 中各运行 60 帧 960×640 局部移动。背景格式稳定后最大损伤 7,812 像素，2D 路径最多读回 31,248 字节；pass surface 只分配三次（child/root 和一次背景 alpha 格式切换）。局部 GPU/CPU 像素与完整图像对照通过，未变画面跳过提交；context loss 后 CPU 像素正确。

[原生 GPU](evidence/damage-native-live.json)与[默认 CPU2D](evidence/damage-native-cpu-live.json)完整回归分别通过图片、文字、stream 更新、导航、resize、慢客户端、重连与资源重发；Viewer 错误为空，排空后资源 17/17。这两个最终独立回归均为 source errors=0。对应 [WebGL 占位](evidence/damage-webgl-placeholder-live.json)及[静态缓存/损坏/版本拒绝](evidence/damage-viewer-asset-cache.json)也通过。

C2 仍标为部分实现：GPU 根图到呈现 surface、bitmaprenderer 的最终 ImageBitmap 提交仍传整图；初始化即选择 CPU 时使用 2D 局部读回；运行中 GPU 丢失后的 CPU bitmap 路径和 CPU raster surface 的 snapshot 也仍可能复制整图。栅格 scissor 的收益不能包装成整个呈现链已无整屏工作，完整内存记账和长时验收另属 C5。版本见 [C2 收据](evidence/damage-local-revision.json)。

最新 [80 ms/1% 内核丢包回归](evidence/damage-network-lifecycle.json)固定 C1/C2 源码与 Broker 版本，在默认自动 CPU2D 模式运行 1,000 次输入，全部注入且原生像素包含对应状态；p50/p95/p99 约 187/346/583 ms，最大进展间隔 750 ms。tc 实际丢弃 102 个包；22 次拖动终点像素正确，300 ms 全丢包结束后约 440 ms 恢复，新完整基线重连约 1,012 ms 并撤销旧租约，sourceErrors=0。该单组不替代此前完整矩阵，也不构成真实公网或物理键盘验收。

初始化 CPU 模式在选择 Viewer canvas context 前先探测 GPU，软件/缺失 GPU 直接使用 2D，局部更新不必创建整图 ImageBitmap；运行中 GPU 丢失仍通过原 bitmaprenderer 回退。最终默认 CPU2D 的弱网样本与[此前 CPU bitmap 样本](evidence/damage-network-bitmap-lifecycle.json)分别保留版本；随机丢包结果不能作为同条件性能 A/B。

## 客户端内存预算与长时验收

新增共享 ClientMemory：按 compact/standard/large 设备档位设置接收、chunks、raw、解码 picture、raster、pass、Wasm、GPU 与合计预算。接收、重组和缓存对同一 ArrayBuffer 引用只计算一次 backing storage。Wasm 堆与其对象估计、Skia GPU cache 与 texture 估计分别取覆盖关系，避免重复相加；这些仍不等于完整进程或驱动物理占用。CanvasKit 0.42 的 GPU usage JS 包装漏 return，固定版本通过先激活上下文再读取原绑定取得实际 Skia cache 数字。

分配前检查已知大小；缓存 picture/raster 按字节淘汰，pass surface/快照、图层、读回、ImageBitmap 暂存与显示缓冲持有对应记账。释放服务器资源、重连和关闭会清理所属引用；已提交及待提交依赖不能因压力任意丢掉。chunks 淘汰后如果未来 manifest 缺依赖，通过既有 keyframe 屏障恢复，不向 CanvasKit 送不完整字节。

[失败复现](evidence/client-memory-before-rotation.json)显示只删除 picture/image 并不能缩小已增长的 Wasm arena：约 109 轮图片变化后 CPU 两条路径触发 256 MiB 档位限制，堆实际已到约 266 MiB。当前按堆使用阈值轮换 CanvasKit 实例，保留原 canvas 的已提交画面、输入控制连接、FrameGate 与原始资源，下一帧使用新实例完整重放。待 GC 的旧实例继续计入预算，直到 FinalizationRegistry 观察到原对象回收；不把清空缓存当成堆已释放。该策略不修改 CanvasKit 厂商包，也未通过提高预算掩盖复现。

[实际 Linux→Mac 三 Viewer 短压测](evidence/client-memory-short.json)运行约 120 秒：589 次 PNG/字体更新、53 次 resize、4 次导航与 36 次输入都通过像素检查，累计图片超过 64 MiB；三个实例多次轮换，最终 active Wasm 均为 128 MiB，旧实例已有明确 GC 回收计数。硬件 GPU 无像素读回。分块缺依赖恢复、压力回收和重放继续成功，source errors=0；导航首次 root layer 尚未就绪的 3 次原生注册拒绝作为有界重试单独计数。

压测还修复采集竞态：resize 先暂停新采集并排空原生 callback，随后排空 BeginFrame，再改变 viewport；并发 resize 串行，期间 demand 更新保留。新文档的原生 API 可能先于 root layer 就绪，只有受信任的导航/初始化窗口允许最多 2 秒注册拒绝重试，首个成功帧即结束窗口；持续拒绝仍走错误路径。没有把转换错误加入测试白名单。

[运行时竞态验收](evidence/client-memory-runtime.json)验证主线程和 Worker 在初始化暂停时清代数、销毁，不呈现旧帧、不重建已销毁输出；[Mac](evidence/client-memory-gpu-mac.json)/[Linux](evidence/client-memory-gpu-linux.json)检查实际 GPU cache 和清缓存后的正确像素；[原生完整回归](evidence/client-memory-native-live.json)及[缓存/版本回归](evidence/client-memory-viewer-cache.json)通过，Node 单测 84 项通过。

[8 小时运行收据](evidence/client-memory-soak-start.json)仅证明冻结版本已启动并有真实进展，不能作为通过证据。代码、Broker 与 Chromium 运行时已独立冻结；Mac 端使用 Metal GPU Worker、CPU Worker 和 CPU 主线程三条路径，持续图片变化、导航、resize 和输入，分别记录 JS VM、Wasm arena、Skia GPU cache 与进程 RSS。需等满连续覆盖时长并检查最终 report/进程状态；仍需补单个压缩资源解码前的大小准入、JS 索引和驱动物理占用边界，以及更多设备/复杂场景，C5 保持部分实现。


## 公开文本与指针即时反馈

[接入和协议说明](input-feedback.md)明确默认关闭正文预览，必须显式标记公开编辑器。服务端先检查类型、用途、敏感标记、样式与长度，才读取正文；当前控制者通过独立 FeedbackState 得到公开正文和内置 cursor/hover 几何。待确认输入只显示圆点，格式化结果由远端校正。InputAck 不再带正文，也不等待可选 DOM 读取。界面明确“待确认”“已注入”和已包含输入的画面，未新增业务成功假象。

[原生数据面](evidence/input-feedback-native.json)和[旧 Node 数据面](evidence/input-feedback-node.json)各验证 Worker 与主线程：8 类不允许正文预览的字段均为 value getter 零读取；反馈消息、普通调试状态和输入叠层未出现生成的敏感测试值。源脚本切换到密码框时输入仍到达真实源端，旧公开编辑器只显示圆点；DOM 探测暂停期间 ACK 继续返回。组合预览、提交、撤销后远端校正、Tab 失效屏障、自定义 cursor URL 剥离、部分超出画面的 hover 裁剪、pointerleave/cancel 清理均通过。Node 路径最初失败来自测试未监听 Worker 转发，修正观察点后通过，未修改受保护的 live/peer.mjs。

93 项 Node 单测、5 项 Rust 单测及两平台 Broker 构建通过。[完整原生回归](evidence/input-feedback-native-live.json)和[真实输入回归](evidence/input-feedback-native-input.json)通过；完整回归中一次导航导致的旧采集失效按原断言保留，Viewer 错误为空。C7 不宣称物理 IME：非空选区上的 CDP 组合撤销未恢复原选区，失败实验与独立复现留在工作记录，C8 仍待实现。版本见 [C7 收据](evidence/input-feedback-revision.json)。

[既有 CI 基线](evidence/baseline-ci-timeout.json)的 x64/arm64 均在 245 分钟编译步骤超时，增量输出和构建缓存保存成功，打包 smoke 未运行。这份 CI 不包含当前未提交的优化，不作为新版本产物验收。C5 的冻结 8 小时运行继续进行，未纳入本轮 C7 修改，也尚未通过。


## JS 缓存索引预算补充

[索引预算收据](evidence/client-memory-index.json)在精确 backing ArrayBuffer 之外，分别估算账本 token/闭包/Map、buffer 索引、trimmer/retired 条目，以及 chunks/raw/picture/raster 缓存条目与 hash 字符串。共享 buffer 的字节仍只记一次，各 owner 的索引估算独立记账。快照和峰值单独显示 jsIndexEstimateBytes，不把估计值称为引擎实测大小。

96 项单测通过：大量单字节 chunk 会因索引开销触发回收；被已提交画面引用的 raw 资源不会被丢弃，预算不足拒绝新条目且回滚；释放 owner 后对应索引估算清零。[实际 Chrome 主线程/Worker 运行时竞态](evidence/client-memory-index-runtime.json)、真实原生反馈两路径和静态缓存/版本拒绝回归通过。任意保留 scene、pass 副本/签名及 JS VM 自身开销仍未完全覆盖，压缩图片/字体的解码前准入、物理驱动占用和长时最终验收也未完成，C5 继续部分实现。正在运行的 8 小时测试使用此前冻结版本。


[C7 长文本补充](evidence/input-feedback-scroll.json)复现并修复：400 字符的横向滚动编辑器中，旧预览的 caret 超出可见框约 4500 像素。现在使用源 scrollLeft/scrollTop 和换行样式，并将本地预测 caret 保持在预览框内；Rust/Node × Worker/主线程四组以及 96 项单测通过。该补充不改变 C8 的物理 IME 与选区恢复未完成结论。


[当前反馈/索引版本弱网回归](evidence/input-feedback-network-lifecycle.json)冻结代码后，在独立容器仅对 Gateway 施加 80 ms RTT / 1% 丢包：1,000 次公开文本输入全部进入真实源端并由原生像素确认，收到 244 次公开正文反馈；p50/p95/p99 约 189/319/373 ms，最大进展间隔约 300 ms。tc 实际丢弃 111 包；22 次拖动终点像素正确，300 ms 全丢包后约 403 ms 恢复，重连约 1000 ms 且撤销旧租约，sourceErrors=0。随机丢包未固定种子，不能把相对此前样本的差异解释为性能改进；完整矩阵、更多负载及真实公网仍未完成。


## 保留场景与异步提交的内存所有权

[场景预算收据](evidence/client-memory-scene-gate.json)为 FrameGate 的已提交和准备中 JSON 场景增加有界遍历估计，包含未知但仍保留的字段；共享对象在单份场景内只计算一次。准入失败保留原可见基线。异步重放取得所需原始资源的快照和共享 backing-buffer pin；清理/恢复立即取消旧代数，但场景与原始字节仍记账到实际 display 结束。迟到的异步完成不能恢复已清理帧或覆盖新基线。输入控制器仅保存有界 viewport/native 版本信息，避免其独立保留整幅场景。

103 项 Node 单测通过，包括深度/条目/字节上限、已提交状态回滚、清理期间资源保留、失败释放和旧提交不能倒退。[Chrome 主线程/Worker 真实 CanvasKit 轮换](evidence/client-memory-scene-gate-runtime.json)在初始化被暂停时覆盖 FrameGate 清代数、旧任务恢复与新画面像素。pass 副本/签名、解析/遍历临时分配、图片/字体解码准入和完整物理占用仍需补，C5 继续部分实现。冻结8h测试未包含此更改。


## pass 副本与签名预算

[pass 预算收据](evidence/client-memory-pass.json)补齐持久缓存的 JS 场景副本、签名字符串和序列化工作预算。复制估计按 JSON 展开别名，并限制条目、深度和字节，拒绝循环引用；在 stringify/parse 前预留工作空间，再用同一 owner 调整到副本估计与实际签名长度。相同签名复用已有副本，非视觉元数据变化只替换对应副本与记账；移除、重用失败和设备清理异常均释放所属 metadata/surface。

109 项单测通过，保留 120 次损伤/完整重画像素对照。实际 [Mac Metal](evidence/client-memory-pass-mac.json) 与 [Linux SwiftShader](evidence/client-memory-pass-linux.json) 在主线程和 Worker 覆盖 GPU/CPU、alpha、中文、resize、context loss；passMetadata 在清缓存后为零，恢复后像素一致。[运行时/FrameGate 竞态](evidence/client-memory-pass-runtime.json)及真实 WebGL 黑框文字/其余页面回归通过。wire JSON 解析与遍历临时工作、JS VM 自身、字体/图片解码准入及驱动/进程实际占用仍未完整覆盖，C5 不标完成。正在进行的8h冻结版本不包含本轮场景预算。


[本轮最终原生回归](evidence/client-memory-scene-native-live.json)覆盖图片/文字、缺资源、慢 Viewer、导航、resize 与重连，Viewer 错误为空；一次导航主动取消旧采集按原断言保留，未当作无错误运行。[公开文本反馈](evidence/client-memory-scene-input-feedback.json)在主线程/Worker 保留隐私、滚动 caret 与异步确认行为。

[当前场景预算版本的弱网回归](evidence/client-memory-scene-network.json)固定源码/Broker，在独立网络命名空间施加80 ms RTT/1%丢包：1,000 次公开文本输入全部由原生像素确认，237 次公开正文反馈，p50/p95/p99 约182/318/369 ms，最大进展间隔约268 ms。22 次拖动终点正确；300 ms 全丢包结束后约391 ms恢复，重连约1029 ms并撤销旧租约；sourceErrors=0，tc丢弃114包。它不替代完整矩阵、真实公网或物理输入/呈现验收，也不用于宣称相对此前随机样本的性能改进。


## 解码准入的原生资源描述

[资源描述收据](evidence/resource-memory-producer.json)补齐原生完整索引：资产超过256项、找不到资产或范围冲突时明确失败，不再静默截断；字体槽位来自重新加载的实际子集，并随缓存子集保留，包含保留ID空洞与复合字形依赖。Rust/Node都从PNG IHDR尺寸与CRC推导RGBA F16像素估计，字体使用序列化字节与实际槽位估计，不把压缩字节当成解码大小。每帧resourceMemory覆盖全部所需资源；新版本索引不完整不能降级为旧索引。旧无版本索引明确返回无描述。

113项Node、8项原生C++、8项Rust测试通过，两个Broker目标构建通过。真实staged Chromium的Rust/Node两条链路均输出完整图片/字体描述并重放首帧；本检查点尚未声称Viewer已执行解码前拒绝。构建在独立headless_shell_decode目标链接，原演示浏览器可执行文件保持原位；冻结8h副本仍独立运行。


## Viewer 解码前内存准入

[准入收据](evidence/client-memory-decode-admission.json)记录 resource-memory-v1 协商：真实原生 Source 必须提供覆盖全部依赖且不可随同一资源变更的描述，Viewer 在 MakePicture 和实际 replay 前预留 Wasm 解码与临时工作空间。超过 picture LRU 的合法对象使用临时 owner，绘制结束释放；raster 命中避免重新反序列化。完整预留贯穿首次绘制，原子拆分成持久 owner 不能提前释放安全余量。GPU 预估不足时在上传前切换 CPU，并对实际 Skia cache 占用执行预算检查。旧夹具 Source 的无描述模式在 Welcome 和遥测中明确标记，不伪称受保护。

3072×3072 单色 PNG 仅约42 KiB，按 RGBA F16 估计72 MiB。在实际 Linux Chromium → CanvasKit Worker/主线程中，compact 在提交前拒绝并保留旧像素；standard 可以真实重放并释放临时所有权。这证明策略准入与可恢复性，不证明压缩图一定实际分配72 MiB，也不证明 compact 设备物理上不能显示它。字体大小仍是按槽位/字节的保守估计。

118 项 Node、8 项 C++、8 项 Rust 测试通过。[Mac Metal](evidence/client-memory-decode-mac.json)和[Linux SwiftShader](evidence/client-memory-decode-linux.json)保留主线程/Worker 的 GPU/CPU 像素对照、resize、context loss 与预算转 CPU 检查；[运行时竞态](evidence/client-memory-decode-runtime.json)、[输入反馈](evidence/client-memory-decode-input-feedback.json)、[缓存](evidence/client-memory-decode-asset-cache.json)和[WebGL 黑框文字](evidence/client-memory-decode-webgl.json)回归通过。[完整原生回归](evidence/client-memory-decode-native-live.json)Viewer 错误为空，排空后17/17资源；一次导航作废已按原断言恢复。新浏览器独立链接验证后原子发布，再通过默认 Ninja 图和溯源检查；旧演示进程及冻结8h副本保持原映射。

[冻结当前版本的弱网回归](evidence/client-memory-decode-network.json)在80 ms RTT、1%内核丢包下完成1,000次公开文本输入，全部由原生像素确认，sourceErrors=0；p50/p95/p99约193/320/393 ms。22次拖动、300 ms全丢包后的恢复和重连新基线通过，tc记录122次丢包。保留原始随机样本，不以跨版本样本宣称性能提升。

C5继续部分实现：wire解析/遍历临时分配、UI/VM及物理驱动/进程占用仍不完整。正在运行的八小时测试冻结于这些更改之前，必须单独报告结果；当前版本尚未完成八小时验收。


## wire JSON 解析与排队预算

[解析准入收据](evidence/client-memory-metadata-admission.json)将 UTF8 字节计数、最大嵌套与条目检查放到 JSON.parse 前，扫描仅使用标量状态，不先分配 TextEncoder 副本或对象图。根据原始文本、节点与深度保守估计解析/字符串/对象工作空间，在分配前申请 receive 预算，直到队列完成才释放。控制快速路径也经过相同检查；独立 UI 控制通道另有32 KiB/层级/条目/估算上限。语法错误不会把原始消息摘录写入 UI。它是引擎相关的有界估计，不是实际 V8 分配测量。

123项 Node 测试通过，检查预算拒绝先于 JSON.parse、排队预算耗尽后的释放与恢复、Unicode/转义以及错误清理。实际 Chrome Worker/主线程各注入深 SceneUpdate、深 FeedbackState、超 UTF8 字节与错误 JSON，共8种连接：均拒绝、释放接收预算并保留旧像素。[完整原生](evidence/client-memory-metadata-native-live.json)、[输入反馈](evidence/client-memory-metadata-input-feedback.json)、[缓存完整性](evidence/client-memory-metadata-asset-cache.json)及[Worker 忙碌时的独立控制](evidence/client-memory-metadata-control.json)回归通过。

[最终冻结版本弱网实验](evidence/client-memory-metadata-network.json)在80 ms RTT/1%内核丢包完成1,000次公开文本输入，全部由原生像素确认，sourceErrors=0；p50/p95/p99约202/351/503 ms，22次拖动、300 ms全丢包及重连通过，tc记录125个丢包。这是有版本记录的随机样本，不是与前轮的性能A/B。

UI 与跨线程消息复制、JS VM/浏览器网络缓冲及驱动/进程物理开销仍未完整覆盖；C5继续部分实现，当前版本8小时验收尚未完成。


## 显示消费者与 Agent 页面活动分离

[真实页面活动收据](evidence/page-activity.json)验证 source.acquirePageActivity() 的独立租约：无显示需求时只推进原生 BeginFrame/rAF，不产生序列化场景；嵌套租约独立且幂等释放，Agent-only resize 后恢复页面时钟。释放 Agent 不会停止仍有 Viewer 的显示；最后的显示消费者离开时，若无 Agent 活动则停止捕获。关闭后清理活动，迟到释放安全。

123项 Node 测试仍通过，真实 Linux 浏览器的 BeginFrame 发出/ACK一致且无时钟错误。调用约定见[生命周期说明](viewer-lifecycle.md)。这只是 C11 的页面活动基础：外部 Agent 必须显式持有租约；Viewer 隐藏/恢复、设备休眠及 Worker 崩溃处理仍待实现，C11标为部分实现。


## Viewer 隐藏、冻结与故障恢复

[生命周期收据](evidence/viewer-lifecycle.json)记录真实自定义 Linux Source → Rust → Chrome CanvasKit 的主线程/Worker 验收。隐藏或冻结立即关闭显示与控制连接，清理旧输入/场景并释放渲染器；恢复建立新画布、渲染实例和完整基线。启动被取消时，新初始化必须等待旧初始化结束，所有迟到消息受代数屏障限制。Worker 重建保留单调连接代数；实际完整原生回归验证了原有手动重连约定。

测试通过 Browser 最小化/恢复产生实际 document.hidden，再按隐藏→冻结→激活→可见的合法顺序驱动 Chrome 生命周期。Playwright 默认焦点模拟会持有可见捕获引用，因此专用测试使用公开 noDefaults CDP 连接；早期直接冻结可见页面触发原生 DCHECK 的失败日志保留，不当作产品恢复成功。

隐藏期间 Agent 的 rAF 继续且显示采集停止；导航后的恢复像素正确，提交记录没有旧 epoch；旧租约撤销，新画布输入只到达一次，旧画布事件不能影响新控制。实际未捕获 Worker 异常和静默关闭分别触发兼容路径；模拟20秒墙钟跳跃触发新基线。物理系统休眠、BFCache/移动设备矩阵尚未验收，C11继续部分实现。

128项 Node 测试通过。[完整原生回归](evidence/viewer-lifecycle-native-live.json) Viewer 错误为空，保留一次导航作废；[输入反馈](evidence/viewer-lifecycle-input-feedback.json)、[WebGL 黑框](evidence/viewer-lifecycle-webgl.json)、[缓存](evidence/viewer-lifecycle-cache.json)及[独立控制](evidence/viewer-lifecycle-control.json)通过。[有版本记录的80ms/1%弱网回归](evidence/viewer-lifecycle-network.json)的1,000次公开文本输入全部由像素确认，sourceErrors=0，p50/p95/p99约198/339/400ms，拖动/全丢包/重连通过。该网络快照早于最后的连接代数传递修复，收据明确区分版本；修复由随后完整原生重连与生命周期验收覆盖。


## 长测失败的超时诊断

[失败收据](evidence/client-memory-eight-hour-failure.json)不能当作八小时通过：旧冻结版本在约2小时43分钟、第4,921轮失败，三条 Viewer 诊断中的预算失败计数均为0，但导航阶段出现非预期捕获错误。源码检查确认原生 Viz 的6秒等待超时会调用普通 cancel 并报 Capture canceled，掩盖超时语义；尚无证据证明底层为什么超时。

[诊断检查点](evidence/capture-timeout-diagnostics.json)分开 VIZ_CAPTURE_TIMEOUT 与 VIZ_CAPTURE_CANCELED，并在捕获错误附带有界的注册、CDP ACK/回复与 Viz 到达时序。130项测试及真实 Broker Viz 合同通过。没有放宽长测的 unexpectedErrors 断言；下一步按每4轮导航的独立短测尝试复现，完整八小时仍待重新验收。


[当前冻结版本短测失败](evidence/capture-navigation-reproduction-failed.json)在第176轮复现 VIZ_CAPTURE_TIMEOUT：原生注册约20ms得到ACK、CDP回复约36ms，但6秒内没有Viz场景。三条Viewer预算失败计数仍为0，未把短测当作内存验收通过。

源码确认 EmitVizScene 在检查两项 pending_writes 上限前就把捕获ID加入 seen；队列拒绝或元数据过大时会永久去重未发送的请求，256项整体清空也可能重新发出历史tag。这是明确的丢失风险，与观测现象相符，但尚未用修复前后饱和测试证明本次超时的全部因果。下一步修复有界写入与去重所有权，重建原生浏览器并复跑相同短测，再安排当前版本八小时验收。


## 原生 Viz 写入归属与仍存在的超时

[写入归属检查点](evidence/viz-delivery-ownership.json)用单个发送任务串行化 Viz 输出，维持两项正常包预算；只有写出成功的 ID 进入有界 LRU，重复活跃 ID 更新热度，避免256项整体清空造成历史重发。饱和时以7字节故障回执替换尚未发送的正常包，Broker 明确结束相关期待；故障发送期间出现新捕获会追加下一条回执。超大场景返回对应捕获的紧凑错误。

Broker 对期待的移除和 scene/resource 发布持有同一归属锁；取消或故障清理不能错过正在发布的资源。131项JS、11项Rust和13项C++测试通过，包含1万次饱和尝试、写入失败、迟到序列化、故障期间的新请求、单项LRU淘汰和确定性的取消/发布竞态。实际Mac/Linux Broker 故障回执与恢复合同通过，独立Chromium目标链接完成。原演示进程与标准可执行文件未替换，尚未作为正式构建产物验收。

[相同导航短测仍失败](evidence/viz-delivery-stress-failed.json)：第53轮CDP约35ms返回，但6秒没有Viz场景。这证明上述缺陷尚不能解释本次超时的全部原因；没有放宽错误断言或宣称长测已修好。下一步跟踪原生聚合入口、发送与接收拒绝，区分“帧未被聚合”和“场景在传输中丢失”。八小时仍未通过。


## 捕获首帧未进入 Viz 聚合的证据

[实际原生追踪](evidence/viz-aggregation-trace-failed.json)在第9轮再次失败，但已把阶段缩小：该新文档捕获的frameToken=1、sourceFrame=0，CDP约37ms返回，6秒内Viz未到；Broker拒绝增量为0。相同运行中健康捕获的Emit/Write记录均存在且写出成功，失败ID在原生stderr中没有任何Emit/Write记录。可确认它未进入当前发射入口，不能再将该超时归因为已修复的写队列。

下一步处理合成帧在聚合前被替代的语义：必须保持SKP与实际Viz帧精确配对，不能把后续场景套用旧捕获ID。需让后续合成帧携带有界的待捕获标记，明确报告原捕获帧被替代后，Source以新ID有界重试并记录计数。仍保留真正的传输、编码、协议错误与6秒总期限，不放宽长测错误断言。当前没有运行八小时测试。


## 精确帧替代回执与有界重试

[精确配对检查点](evidence/exact-frame-supersession.json)将捕获UUID与请求的compositor frame token编码为有界标记；后续帧保留该标记，Viz只在实际token相等时输出场景。若原帧在嵌入/聚合前被替代，则发送零pass的对应错误，不能把后续场景与旧SKP拼接。每个进程最多保存4个host标记，文本上限256字节。

Source只重试明确的VIZ_CAPTURE_SUPERSEDED，最多3次且共用6秒总期限；先排空原生编码/CDP回调，再以新ID请求完整资源。导航作废、编码、传输和协议错误继续走原有失败路径。最后一个显示消费者离开时，保持BeginFrame直到当前回调排空；无新显示需求时不注册下一次尝试。137项JS、11项Rust、17项C++及Mac/Linux实际Broker合同通过。

相同180秒、每4轮导航的原始压力测试通过：1,376轮、344次导航、125次resize、86次真实输入像素确认，更新图片累计约295MiB。18次原生追踪均显示请求token=1、实际token=2，并由有界重试恢复；非预期错误为0。6次导航主动作废旧捕获按原规则保留，三条Viewer预算失败计数均为0。本短测不能替代八小时或完整物理内存验收。

原生捕获、输入、完整直播、流式首帧、Agent页面活动与Viewer生命周期回归通过。冻结测试目录最初漏掉libvulkan.so.1，导致WebGL2创建返回false；失败日志保留。只补入同一构建的该运行库后，同一二进制在独立冻结目录通过黑框、446个标签亮像素、普通DOM更新与移除恢复，捕获错误为空。默认Ninja图和来源检查通过，正式路径与已验收独立目标二进制hash相同；原演示进程保留旧映射。下一步冻结此版重新运行八小时，C5和完整41项仍不标完成。

[当前精确帧版本八小时启动收据](evidence/client-memory-eight-hour-exact-frame-start.json)对应新runId `8c8f0d4c-1c2f-44f4-918b-926c5e555be8`，已独立冻结源码、Node依赖和18个浏览器运行文件。GPU Worker、CPU Worker、CPU主线程三条Mac Viewer同时运行；先400轮突发，再按2秒间隔更新、每40轮导航。当前只是运行中，必须保留原错误门槛并等待最终report和进程退出，不能把启动收据当作通过。


## 字体与图片独立 LRU 和编码共享

[B4检查点](evidence/native-asset-lru.json)将字体和图片改为各32MiB、最多128项的LRU，按字节压力逐项淘汰冷资源，命中会更新实际条目的热度。字体子集仍保留源glyph ID与完整槽位描述；缓存收费包含保留源字体/像素和索引估计，不能把压缩PNG大小当成源图片占用。持有不可变资源的编码器和IPC不会因缓存淘汰失效；它们的独立引用不伪称已纳入本缓存预算。

同键正在编码的请求共享成功或失败结果，编码与等待均在缓存锁外。每个域最多登记32个pending key；饱和时，新key独立编码并记录bypass，已有同键继续共享。失败不进入LRU，后续请求可重试。新原生遥测公开两个域的缓存收费、条目、淘汰、编码、共享、pending与bypass，字体和图片的锁也互相独立。

23项C++测试通过，包含字节/LRU热度、外部pin存活、确定性的并发失败与重试、1个pending槽下的1,000个其他key，以及真实Skia的260图压力与8线程相同picture序列化。后者每种资产仅编码一次，其余调用命中或共享，序列化字节一致。137项JS回归保留通过。

真实Linux Chromium/Rust到CanvasKit Worker逐次确认140张噪声图片的像素，更新图片约30MiB。图片缓存最高33,228,017字节，仍低于32MiB上限，最多68项；最终74次图片淘汰、142次图片编码和143次进行中共享。稳定字体收费769,584字节，始终仅编码一次，无字体淘汰；非预期捕获/Viewer错误为空。当前原生捕获、输入、完整直播、Rust/Node资源描述、生命周期与WebGL黑框回归通过；默认Ninja图与溯源确认正式路径和已验收独立目标hash一致，旧演示进程保持原映射。

旧版运行同一140图像素工作负载也通过，但缺少编码归属计数，帧内可以混合冷编码和缓存命中；帧级fontMs/命中数不足以计算冷缓存重编码次数，早期推断指标已移除。因此不以这次诊断宣称延迟或冷缓存尖峰改善，B4仍为部分实现，后续须补可比的编码统计和性能对照。当前八小时运行固定于B4之前，不覆盖此检查点；B10的host/layer/epoch生命周期与物理占用也尚未完成。


## Compositor host 生命周期与迟到编码

[B10生命周期检查点](evidence/capture-host-lifecycle.json)移除跨host静态录制表，将全层/tile缓存归属到各自LayerTreeHostImpl；访问、移除layer和析构均在其compositor线程进行。成功扫描后清理已不在树中的录制条目，去掉未使用的编码强引用字段。host析构会清理中央编码条目、损伤、frame标记和待请求；缓存payload在释放登记锁和全局capture锁之后销毁。异步编码携带不可变owner令牌，关闭或整数ID复用后不能重新创建旧缓存。已排队快照保留自己的不可变引用到编码完成。

138项JS和28项C++通过，覆盖销毁后的迟到写入、ID复用、独立host命名空间、1,000个已退休快照令牌与外部payload pin释放，以及NATIVE_CAPTURE_HOST_CLOSED不会变成supersession重试。七组真实原生回归覆盖捕获、输入、完整直播、Rust/Node资源描述、图片缓存压力、Viewer生命周期和WebGL黑框文字与普通DOM更新。

真实单一renderer完成200次含噪声图片的导航和逐次像素确认；原生stderr确认200个不同host的析构清理。Chrome会推迟旧compositor的实际销毁，转场最高11个存活host，导航循环结束仍有10个；约956ms后收敛到当前文档的1个host、1个owner令牌、1个marker和12个编码条目，201次创建对应200次释放。三次主动导航作废保留，非预期错误为空。这证明实际销毁后的归属释放，不证明转场字节或物理RSS有界。

早期测试错误地要求每帧host数都不超过2，把尚未析构的Chrome对象当作已退休；[失败证据](evidence/capture-host-lifetime-impl-only-failed.json)、同一二进制的完整补充采样和原始日志保留。最终测试改为更严格的销毁后单owner/单marker收敛检查，单独报告转场峰值；没有放宽捕获错误门槛，也没有在未证实的假设上额外修改main-thread析构。

独立冻结源码、依赖和运行目录的180秒三Mac Viewer压力测试通过：1,392轮、348次导航、126次resize、87次输入、20次帧替代重试，非预期错误和三条Viewer预算失败计数均为0；七次主动导航作废按原规则保留。默认Ninja图与来源检查通过，正式路径和已验收独立目标hash相同；旧演示进程和正在运行的八小时副本未替换。

本生命周期检查点尚未覆盖编码全局字节LRU（后续进展见下节）；录制/RasterSource及page epoch归属还要补，延迟销毁的转场录制缓存需要独立预算。Rust/Node Mapper在失败路径的临时资源与变更回滚、关闭Source时的显式清缓存、跨Session的进程/RSS/PSS验收也未完成。当前八小时固定于B4/B10之前，不覆盖本检查点。


## Renderer 编码字节预算与外部引用计费

[B10编码检查点](evidence/native-encoding-budget.json)将各host独立的计数缓存改为renderer进程内共享的64MiB、512项加权LRU，同时保留每host最多256项。收费包括SKP、Base64及字符串容量、font/range向量和嵌套字符串容量、编码对象与索引估计；溢出计算饱和并拒绝准入。它是保守的缓存所有权计费，不是物理堆/RSS测量。

返回的不可变指针共享计费控制块；缓存淘汰或host销毁后，只要快照仍持有引用，原reservation就继续保留。最后一个引用先销毁payload，再归还字节。编码、等待外部pin和payload析构均不持登记锁。字节不足时逐项淘汰，所有预算被pin占用时有限次尝试后返回当前完整的未缓存编码；不能把准入失败伪称为命中并只发送hash。未缓存的序列化/IPC工作不在该预算内。

34项C++和138项JS通过，包含跨host全局LRU、热度、退休pin、阻塞析构期间不提前归还额度且登记锁可被其他线程取得、SIZE_MAX与共享输入拒绝、100个host共享条目上限和完整元数据容量收费。初次构建因测试fixture中的原始信号量指针触发Chromium raw_ptr检查失败；日志保留，修正fixture后构建和全部测试通过。

真实Linux Chromium到CPU CanvasKit Worker对Rust tiled与Node全层/Base64两路径各完成80张512²噪声图片逐次像素检查。Rust最多76个条目，计费峰值66,264,815字节、最终434次淘汰；Node最多31项，峰值65,948,517字节、52次淘汰，均低于64MiB并先于旧256项上限触发字节压力。未发生非预期错误或不受计费的共享输入准入；该工作负载没有触发pinned-pressure bypass，后者由确定性C++测试覆盖。

七组原生功能回归通过。200导航的像素与原生析构日志再次通过，最终1个host/owner/marker；181.4秒独立冻结的Mac硬件GPU Worker、CPU Worker、CPU主线程压力完成1,400轮、350次导航、127次resize、87次输入和21次帧替代重试，5次主动导航作废单独记录，非预期错误和三个Viewer预算失败均为0。默认Ninja图和来源检查确认正式路径与已验证独立目标hash一致；原演示和八小时冻结副本保持原映射。

B10继续部分实现：未准入编码/IPC与临时输出副本、录制/SkPicture/RasterSource、host命名空间元数据、page epoch提前退休和实际pending取消还未统一预算。Rust/Node Mapper失败回滚、Source/Broker关闭清理、多Session与跨renderer总预算、RSS/PSS及驱动/分配器物理回收仍待完成。正在运行的八小时冻结于B4/B10之前，不覆盖本检查点；41项状态仍为7项完成、12项部分、22项待实现。


## Broker 关闭与管道缓存释放

[B10 Broker关闭检查点](evidence/broker-close.json)让主动关闭与协议/进程失败共用可重复等待的退出过程；失败设置closed后仍必须等待子进程退出。立即拒绝所有待请求并清理计时器、输出累积、stderr和三条管道；错误路径终止子进程，忽略SIGTERM时有界升级SIGKILL。完整包解析完会释放空切片的底层分配，避免长度0却持有整个大包。

144项JS通过，新增六项真实子进程覆盖2MiB响应、256KiB截断输出、畸形JSON、超限包与忽略SIGTERM、异常退出及不存在的可执行文件。真实Rust Broker、Viz、原生资源、Gateway、多帧窗口与完整直播六组回归通过。早期大资源窗口测试在旧/新wrapper都遇到固定3秒门槛：3秒时已有6,127,046字节到达，9,470,786字节的原始WebSocket消息尚未完整，随后确实提交首帧并因刻意不ACK以1013关闭。只将两处9MiB资源等待改用服务端既有15秒进度上限，普通/控制3秒与提交后1.5秒ACK规则不变；旧/新wrapper均通过修正后的测试，失败日志保留，不宣称吞吐性能改善。

本Broker检查点尚未覆盖Source.latest/Mapper或所有外层teardown失败后的继续执行；后续验证见下节。B10与41项总体状态不变，当前八小时冻结副本不包含这些更改。


## Source 关闭、迟到结果与失败清理链

[B10 Source关闭检查点](evidence/source-close.json)在关闭开始时清空latest、producer、firstScene、活动租约和Node Mapper的原始资源/内存描述/修订状态。关闭可重复等待同一个Promise；新或已排队的resize、迟到导航和capture/map结果不能重建关闭后的命名空间，也不能重新发布帧。仅关闭后的预期错误被忽略，活动采集的失败规则未改变。

Source与Live清理链会继续尝试每个资源的关闭，最后汇总错误。Gateway停止失败时仍移除peer事件与控制归属；传输层继续关闭所有peer、WebSocket和HTTP连接/监听器，外层继续关闭Source及fixture。Source启动失败也沿用完整清理链。

144项JS通过，直播、Rust/Node资源描述、Agent页面活动、Viewer生命周期和WebGL回归通过。真实Linux Chromium以Rust和Node两路径各创建5个Source，另有2个Live故障关闭场景；调用者继续保留全部12个已关闭对象，latest/Mapper均为空。覆盖真实map挂起后关闭再恢复、两次resize排队竞态、两次capture清理错误、两次control清理错误及一次Gateway stop错误，迟到帧/错误/失效事件均不复活状态。两个实际客户端socket、Viewer HTTP服务和私有fixture都结束；48个SystemInfo列出的进程身份在关闭后退出，/proc启动身份用于排除PID复用。原生Broker也确认退出且pending/输出底层buffer为空；非预期错误为0。

这是显式归属释放与实际进程退出验收，未证明Node VM/分配器RSS/PSS完全归还，也未覆盖Mapper接收失败scene后的事务回滚。录制和未准入编码预算、page epoch提前退休、跨renderer/Session总预算仍待补，B10和41项总体状态保持部分完成；现有八小时冻结副本不含本改动。


## Node Mapper 的事务准入与拒绝回滚

[B10 Node事务检查点](evidence/node-mapper-transaction.json)只暂存当前scene的资源与decode描述，不复制整个缓存历史；相同checksum继续复用原Buffer。epoch、revision、entries在完整scene/viewport/依赖校验及256KiB元数据预算通过后一起提交。Source将真实viewport传入Mapper，消除先提交后因Root viewport校验失败的路径。拒绝的同hash描述升级也不改动旧状态。

单资源/编码长度与64MiB活跃原始SKP预算在构建中检查；成功后按128MiB原始字节、512个资源/描述索引规划历史淘汰，再提交。外部快照可继续持有已淘汰Buffer，这些pin不伪称纳入Mapper缓存上限。149项JS通过，覆盖超过缓存总量的拒绝洪泛、65MiB活跃集合拒绝、元数据/viewport/ID错误、descriptor冲突、九次16MiB字节淘汰及520次索引压力。

真实Linux Node Source到CPU CanvasKit Worker使用实际SKP加nonce注入181次拒绝，累计164,014,380字节。缓存、epoch、修订号、已提交快照及旧Buffer身份保持不变，181次故障事件原样记录；恢复原生采集后，新图片像素通过，非预期Source/Viewer错误为空。真实映射/像素、完整直播、Rust/Node资源描述和12个Session关闭回归通过。

Rust原生资源ingest及map仍需统一事务，chunk弱索引和失败epoch切换尚未完成；完整Session与物理内存范围也仍未验收。B10与41项总状态不变，八小时冻结副本不含本检查点。


## Rust 原生资源与 scene 的统一事务

[B10 Rust事务检查点](evidence/rust-mapper-transaction.json)把RPA原生块接收移出会修改Mapper的独立ingest步骤；tile展开失败也会释放当前输入。原始块/Base64、资源与decode描述升级、chunk弱索引、epoch/revision/entries/serial都先暂存，全部Mapper校验及不可变Snapshot构造成功后才合并。缓存chunk仍可跨资源共享；描述升级复制资源记录/manifest并共享原字节，不修改旧快照。新增暂存原始资源总量受64MiB约束。

16项优化模式Rust通过，149项JS沿用上一Node检查点。真实Linux arm64通过140次Base64、140次RPA原始1MiB失败与140次后续hash miss，加上tile展开、元数据和描述升级失败，共423次拒绝；两种字节路径各超过128MiB，保留资源/chunk字节计数、索引和所有代数不变。原hash-only恢复为serial2/revision1，新有效输入为serial3/revision2。私有mapperStats将保留payload、wire、manifest与去重cache-owned chunk字节长度分列，不能冒充Session/RSS。

Broker/Viz/原生资源/Gateway/tile/窗口、原生像素、输入、直播、资源描述、12个Session关闭、Viewer生命周期与WebGL共13组回归通过。独立冻结的Mac GPU Worker、CPU Worker、CPU主线程压力运行181.3秒：1,316轮、329次导航、119次resize、82次输入、22次帧替代重试和5次主动导航作废，非预期错误和三个Viewer预算失败为0。Linux Broker原子替换到已验收hash，默认路径原生资源烟测通过；旧演示进程、其他架构产物与八小时冻结副本保留。

成功路径仍有已复现的预算缺口：三个15MiB的协议/header测试资源（没有CanvasKit像素验收）被Mapper接受后，仅payload/wire/manifest/去重chunk长度已达141,746,973字节，超过128MiB目标，尚未计索引/分配器。既有逻辑超限后仍保留全部当前required资源；四Snapshot/latest/Gateway/窗口的共享引用和manifest副本也未统一计费。该探针明确记录invariantPassed=false，不能作为通过证据；下一步实现成功路径的全局字节/引用预算。

因此B10继续部分完成。录制/RasterSource、page epoch提前退休及真实pending取消、跨renderer/Session总预算与物理RSS/PSS仍待补；41项仍为7完成、12部分、22待做，八小时冻结版本不覆盖本改动。


## 共享 Resource 所有权、硬缓存与有界弱索引

[B10缓存归属检查点](evidence/broker-cache-owners.json)把Mapper/Snapshot改为共享不可变Arc<Resource>，普通快照不再复制每个manifest字符串。128MiB、512项强缓存按输入hash更新热度并逐项淘汰，收费包括payload/wire实际Vec容量、manifest/引用向量容量、对象/索引估计及保守的引用chunk收费；共享或重复chunk可能重复计费。当前required资源也可不进入强缓存，Snapshot仍持有完整可发送引用。

512项资源弱索引优先保留当前Snapshot，允许已被强缓存淘汰但仍有外部owner的资源继续按hash命中；chunk弱索引最多8192项。大量活跃pin不能扩大索引，超出有界历史的资源按既有缺失恢复协议重新提供。事务提交前不修改这些状态。19项Rust通过，覆盖大工作集绕过强缓存、Arc/manifest指针共享、LRU热度、仍存活的退休快照、受限弱索引及reset后释放。

原三个15MiB协议/header夹具的强缓存已回到目标内，保守收费94,831,208字节；完整45MiB帧及hash-only跟进都成功。520次小资源历史压力仍保持512项；原423次真实RPA/RPC拒绝与恢复验证继续通过。原始失败、重放与新合同报告均保留；这不是把原135MiB的全部进程占用减少到强缓存收费值，缓存外Snapshot仍持有资源。

真正的Chromium图片测试使用四张2048²随机PNG、4096² viewport和非tiled原生捕获，经Rust Gateway原始资源路径及FrameGate交付57,802,256字节、4个真实SKP，再由CanvasKit CPU重放。四个指定像素全部正确，后续原生hash-only采集无资源恢复；保守强缓存收费130,709,217字节，仍低于128MiB。该路径验证支持大于缓存工作集的真实绘制，没有通过拒绝大帧来满足缓存上限；不宣称默认tiled大图片矩阵或总物理内存已完成。

13组原生/输入/直播/资源/窗口/关闭/生命周期/WebGL回归通过，默认Linux arm64 Broker原子替换与原生资源烟测通过，其他架构与旧演示进程保留。本检查点没有借用上一版三分钟压力或旧八小时作为新版本长期验收。

B10仍部分完成：下一步是跨缓存、Snapshot、latest、Gateway窗口与排队Bytes别名的唯一分配reservation，并覆盖manifest/scene/delta复制、索引和RPA输入/暂存；原生录制、未准入编码、page epoch及完整Session/PSS/cgroup也待补。41项状态保持7完成、12部分、22待做。


## 跨快照与发送别名的资源分配池

[B10资源池检查点](evidence/broker-resource-pool.json)将Rust资源payload、wire、chunk和manifest的最终分配归属纳入默认768MiB资源池。容量和owner开销在准入时保留额度，元数据与引用向量采用保守估计；共享chunk及descriptor升级后的共享字节不重复收费，升级的记录和manifest另行计费。Bytes/UTF-8别名或切片直到最后引用释放后才返还整块底层分配的额度，数据先析构再返还。单独的128MiB/512项强缓存仍按保守LRU收费，两者不是同一范围。

压力时先回收可丢弃的旧history和强缓存，保留最新有效快照及真实peer依赖。最多256个有界回执只确认旧发布已合并，不会提前发布尚未通过Source代数校验的新map；未知serial继续报错。资源额度拒绝会释放当前暂存分配，不提交epoch/revision/serial。Source按明确错误码暂停显示采集，保留需求和页面时钟，以100ms检查回收、强制重新提供资源；每秒最多一次通过硬准入的试探，防止保守headroom把较小的新帧永久阻塞。关闭取消轮询并屏蔽迟到回调，普通故障仍计错误。

26项Rust、153项JS和16组原生/输入/直播/资源/窗口/关闭/生命周期/WebGL回归通过。64MiB配额下，两个7.5MiB协议header夹具被慢ACK窗口持有，资源占用47,470,200字节；第三map明确拒绝，回滚后占用相同，峰值63,307,912字节低于配额。按序ACK后降至23,735,100字节，serial3恢复；14次变化后reset仍保留peer基线额度，关闭peer后降为零。该夹具不冒充可重放的CanvasKit图片。

真实Linux非tiled采集1536²随机PNG与上述两个协议pin共同触发Source压力：显示采集暂停，页面时钟继续，latest/epoch/viewport/inputSeq保持；ACK释放后强制原生资源重试，CanvasKit CPU实际像素[37,91,199,255]通过，普通Source错误为零。另一个四张2048² PNG的真实57,802,256字节原生SKP测试及四个像素/hash-only跟进继续通过，没有靠拒绝既有大帧来满足预算。

初轮两个8MiB夹具加协议头超过既有16MiB窗口，以及50ms时钟断言短于100ms空闲间隔的失败均保留；只修正验证夹具/等待范围，未扩大服务端窗口。默认Linux arm64产物和源码冻结信息单独记录，其他架构、旧演示进程及旧八小时副本保留。

输入包/解析/raw块复制早于本池准入，Snapshot JSON与弱索引后备分配、Gateway scene/delta和Tungstenite发送复制也仍有独立未覆盖归属。原生录制、未准入编码、page epoch、Node备用数据面及Session/PSS/cgroup尚未完成。B10继续部分完成；41项仍为7完成、12部分、22待做，八小时长测不包含本检查点。


## Viz/RPA 输入包、解析预留与早期 raw 准入

[B10输入池检查点](evidence/viz-input-pool.json)增加默认256MiB、四个私有reader共享的Viz/RPA输入池，完整包分配前预留实际Vec容量与owner开销，慢速半包继续占用额度。元数据先扫描结构，再预留4倍UTF-8文本、每个结构token768字节及64KiB固定开销；块索引按512字节/声明项预留。这是保守解析余量，不冒充全进程RSS。解析Value和索引额度随原始数据队列/map生命周期释放。

raw SKP在复制前进入已有资源池，Mapper接收持有最终Bytes额度的Payload，转入Resource时不再次复制/计费。Base64也先保留解码输出容量。tile展开移动capture和资源记录，分组只留几何数据，在展开过程中即检查2048个quad上限，避免先复制大型payload或扩张后才拒绝。

预算拒绝用固定栈prefix/scratch排空对应包；只清理已识别捕获中未完成的配对，不丢弃其他已完成scene/resources。scene先到、map已等待raw资源时，后续解析拒绝会唤醒等待并携带明确错误码。Source先排空原生/CDP回调，再暂停显示采集并保留页面时钟；连续失败从100ms退避到最多1秒，成功帧重置。未知故障仍按错误处理。

独立测试分配探针曾证伪初版2倍文本估计：含转义的2.1MB字符串请求布局峰值6,300,001字节，额度只有4,266,312。未发布该原型；改为4倍文本后额度8,466,320，转义/普通长串、稀疏对象、嵌套数组和宽字典五组均通过。该探针观察实际分配Layout并保守计算realloc重叠，仍不等同分配器usable size或物理RSS。

34项Rust、154项JS和20组回归通过。实际私有协议16MiB配额下，两个7MiB半包及已完成元数据保留14,762,636字节；第三个3MiB包被定向拒绝，占用不变，原完成帧与同连接后续帧仍分别映射serial1/2。关闭半包后额度为零；scene先到的解析失败约0.45ms返回明确错误而非等待3秒超时。

实际1536²随机PNG在明确2MiB小配额下于整包分配前拒绝，原生Source不发布部分帧，时钟继续且代数不变；切换到2,701字节的真实小PNG后交付SKP并通过CPU CanvasKit像素[29,83,197,255]，普通Source错误为零。最初solid quad恢复没有SKP，已保留为旧探针，最终不以其声称资源重传。默认配额的57,802,256字节/四个原生SKP与四像素测试，以及既有慢ACK资源池恢复仍通过。

本池不覆盖stdin RPC和Node请求序列化队列、Snapshot及临时manifest JSON、弱索引后备、Gateway/Tungstenite发送复制；原生录制、未准入编码、page epoch和完整Session/PSS/cgroup也待补。默认Linux arm64产物与源码冻结单独记录；旧八小时冻结运行不包含本检查点。B10继续部分完成，41项保持7完成、12部分、22待做。


## Node 请求序列化、积压和真实 Buffer 生命周期

[B10 Node请求检查点](evidence/node-request-budget.json)在进入序列化前增加累计预算：默认512MiB数据、4MiB控制，48个数据归属及64个总归属。节点/UTF-16文本按保守暂存与入参估计预留，再生成单个独立Buffer，避免整包JSON.stringify字符串、Buffer.from及包头拼接副本。getter、toJSON、Proxy、循环及id/op覆盖在编码前拒绝，不执行用户序列化钩子。

包额度与响应额度独立：实际管道写完后才退休包，入参估计保留至响应处理后；关闭等待私有管道/进程和所有归属清理。已收到响应但pipe仍阻塞的Buffer继续计费。控制保留空间能接纳status/reset，不代表能越过已进入同一stdin FIFO的字节。Source的状态轮询遇到暂时请求压力会继续，而普通失败仍报告错误。

独立GC探针证伪过首版账本：一个3MiB私有Buffer已计为0，但待响应计时器共享的词法环境仍保留它。原型未验收；写入后显式清空packet槽，再用真实子进程、WeakRef和强制GC验证：待响应期间已写完的Buffer/底层backing可收集，提前响应但仍阻塞的包不可收集，保留已关闭Broker对象也不再持有该包。这是引用可达性证据，不宣称自然GC时机或OS物理内存归还。

164项JS通过，包含300组确定性JSON/UTF-16语义对照、getter/Proxy不执行、真实不读stdin子进程、数据名额满时控制回复、提前响应与关闭。冻结副本28组回归通过；Rust源码/二进制未改，沿用34项Rust验收。明确2MiB Node额度下，大请求在分配包和发送前拒绝，RPC序号、进程和Rust Mapper全部状态不变；旧hash-only资源恢复为serial2。默认45MiB协议工作集、57,802,256字节真实原生SKP与像素，以及控制/反馈/页面时钟继续通过。

新增控制回归发现已有Node Welcome包装器在发送null测试消息时崩溃；空值判断修复后，实际Worker/主线程都拒绝为Invalid metadata JSON object。旧测试提示文字据浏览器探针精确更新，600ms控制门槛与1.2秒SHA延迟均未放宽，失败记录保留。

节点/字符串预算是逻辑估计，VM枚举缓存、GC和调用者外部持有数据未完整计费；Node响应解析、Rust stdin、Snapshot/临时manifest与Gateway发送复制仍待补。RVE scene先到/raw未完成的通用writer-fault配对审计也保持待修。原生录制、epoch及全Session/PSS/cgroup未完成，B10继续部分完成；41项仍为7完成、12部分、22待做，旧八小时冻结运行不含本轮改动。


## Source 崩溃清理与独立内存诊断

[崩溃清理检查点](evidence/source-crash-cleanup.json)用实际 `Page.crash` 复现清理挂起：独立PSS/cgroup采样仍运行，但控制会话关闭停住，Source未在原20秒退出门槛内结束。失败与定位轨迹保留。修复后，renderer崩溃会锁存到Source；关闭先结束拥有该renderer的浏览器，再排空控制队列和目标会话，避免等待死亡目标的detach。控制关闭可重复等待同一Promise；正常关闭顺序保持既有行为。

165项JS及冻结29组Linux回归通过，包含真实正常停止、renderer崩溃和Live清理后注入错误三种独立Source。三种用例的所有已采样pid+启动时间身份均退出；fixture及诊断清理不因前一步报错跳过。新长测每10秒独立记录逐进程RSS/PSS、CDP进程角色、cgroup内存/峰值/OOM事件和崩溃事件，死亡页面不再阻止诊断。Viewer最终通过状态须等工作负载与清理收据均验收后写入；15秒像素、600ms控制和1200ms慢SHA门槛未放宽。

该检查点未证明旧版renderer崩溃的具体分配根因，也未证明当前版本长时内存稳定或完整Session预算。接下来必须用当前冻结版本完成新的短测与独立8小时；旧失败运行的时间不累计，B10/C5及41项总体状态保持部分完成。


## 当前版本的独立内存诊断短测

[当前冻结版180秒短测](evidence/current-memory-diagnostics-stress.json)通过：1257轮图片更新、314次导航、114次resize和78次真实输入像素确认，Mac硬件GPU Worker、CPU Worker、CPU主线程三条路径均运行，预算失败为0。记录24份独立Source采样；后半段renderer PSS观测范围216.5–266.6MB，最后216.5MB，容器峰值806.4MB。工作负载和清理收据全部通过后才写入passed，Source/Broker/fixture及浏览器子进程均已关闭。

此结果只覆盖该180秒快循环，不替代8小时或完整Session字节预算，也不把旧失败renderer的具体分配原因视为已证明。当前版本新的独立8小时须另列runId、冻结清单和最终结果。


## 当前版本独立8小时启动

[运行收据](evidence/client-memory-eight-hour-current-b10-start.json)记录新runId `2585828c-e3d1-4175-98f9-8a8c656dcd7c`：独立冻结当前源码、依赖、Rust与18个Chromium运行时文件，LinuxSource独立容器对接Mac硬件GPU Worker、CPU Worker及CPU主线程。初始Viewer建立耗时36.72秒，随后8小时工作负载重新计时；首次进展采样405轮、预算失败[0, 0, 0]。旧失败运行的时间不累计。每10秒Source PSS/cgroup采样及外部Docker事件记录持续留证。

这里只证明已启动并推进；不得当作8小时通过或B10完整内存预算。须等最终report、连续覆盖与清理验收，期间可继续其他独立实现。


## Rust stdin RPC 输入准入与坏包隔离

[RPC输入池检查点](evidence/rpc-input-pool.json)将stdin完整包和serde解析加入独立的512MiB数据、4MiB控制池，另在控制池保留64KiB固定扫描/排空开销。完整Vec先预留实际容量与owner；解析前沿用4倍UTF8、每token768字节和64KiB余量。raw包与解析额度重叠至解析完成；Value先销毁再返回解析额度，RPA转入的原始Value同样保持其入站租约。它是精确raw容量与保守解析估计，不是全进程内存限额。

拒绝用固定prefix/scratch排空，并扫描完整包中的顶层id/op，包尾ID仍可关联错误。完整坏JSON、UTF8、孤立UTF16、深度或重复id/op返回INVALID_REQUEST；额度不足返回INPUT_BUDGET_PRESSURE，后续同管道请求继续。孤立UTF16没有宣称支持，仅隔离拒绝；中断长度/正文不能猜测重同步。小控制消息保留额度，但不承诺越过尚未读完的包或正在执行的map。

先前C85原型通过旧30组后，额外用例证实200KiB数据包在id/op靠后、控制256KiB时被临时区错误拒绝；失败保留且从未发布。修复允许未知小包使用可用raw暂存区，按最终类型无复制转移同一分配的收费；成功数据回退可增加一次控制预留尝试失败计数。

最终45项Rust、165项JS及新二进制冻结30组Linux回归通过。真实管道1MiB数据配额验证raw/解析拒绝、90MiB+1有界分块排空、包尾ID、300组结构转义、最小控制配额、临时区数据回退；原Mapper精确不变、正常下一包及旧hash复用serial2成功。独立分配Layout三组峰值均低于同时预留。默认45MiB Base64、57,802,256字节原生四资源像素、423次失败回滚、原生资源/输入压力恢复等合同保留。Linuxarm64产物及receipt原子替换，旧版本与receipt备份；正式路径的Mapper、私有Viz与RPC坏包/恢复三组烟测也通过。

当前8小时run2585828c仍固定在a296，不包含这个RPC检查点；不修改或重启其冻结目录。Node响应、Snapshot/asset临时JSON、发送复制、原生录制/epoch及全Session预算仍需补，其他架构产物也未在此发布；B10及41项总体状态不变。


## 私有 RVE 故障的半成对资源清理

[私有故障配对检查点](evidence/viz-fault-pairing.json)以有效RPA/scene接收路径复现：scene已交付而raw未到时，通用RVE只扫描scene等待表，map约3秒后才报配对不可用；Viz输入池满1MiB时，7字节故障回执本身还会被数据额度拒绝。

修复原子退休scene/raw两种未完成成员的并集，完整配对不在任一等待表内，继续保留。已交付或取走scene、仍等待raw的请求保存明确故障并唤醒map；尚未交付scene的回调直接收到原错误，不额外留下故障记录占注册槽。首版曾因这类额外记录使既有私有Viz回归失败，日志保留且未发布；修复后100轮重复故障和旧槽位断言通过。移除的Value/资源在注册锁外销毁，额度跟随真实数据释放。

严格7字节RVE先用固定栈读取、校验，不依赖数据池剩余空间；无效或未收完的回执不能提前清理请求。真实管道过载/传输故障×普通/满额四组均在原2秒门槛内返回明确码，包含满额分片回执。883,952字节半包在逻辑退休后仍收费，直到EOF才归还；已完成帧映射serial1，随后同流新帧serial2，最终输入池为零。

49项Rust、165项JS与冻结31组Linux回归通过，保留45MiB Base64、57.8MB原生四资源像素、423次回滚、控制与Source压力恢复等合同。这里注入的是实际私有协议，未声称Chromium已真实发出该writer故障或观察到pending capture取消。正式路径Mapper、私有Viz、RPC坏包及故障配对四组烟测也通过。当前8小时仍用a296冻结版，不含本检查点；Node响应、Snapshot/输出、原生录制/epoch及完整Session仍待补，B10和41项总体状态不变。


## Node 响应接收与解析临时区

[响应检查点](evidence/node-response-transients.json)将逐块Buffer.concat累积改为一个精确大小的独立响应Buffer，暂停stdout并每轮只交付一个完整包。到达chunk按整个ArrayBuffer收费，固定扫描区有独立余量；512字节头定位和全包结构扫描不生成完整文本或Value。UTF8解码/JSON.parse前按文本字节、标量/键/容器节点和深度预留保守额度。默认数据768MiB、控制8MiB，保留90MiB数据及256KiB控制包上限。

原8MiB真实子进程响应触发133次拼接，累计请求545,882,664字节；这是重复分配/复制工作量，不是同时物理内存。新实现的8MiB单测验证只分配一个完整backing、最终正文只写入一次，另有至多512字节前缀暂存，父进程无Buffer.concat。完整90MiB合法JSON响应也通过，默认预算内的逻辑峰值约660.6MB；调用者保留返回字符串时，临时缓冲区额度仍可退休，不据此宣称应用图已被计费。

177项JS和冻结34组Linux回归通过，含300组确定性JSON/UTF16语义对照、晚头/转义键、密集标量、深度、24包控制突发、合法32KiB密集Gateway消息、坏UTF8及关闭半包。首版4MiB控制默认值被新增密集消息用例证伪：它会导致整个Broker关闭；保留失败，增加默认预留至8MiB后重跑。独立强制GC证明已消费的Buffer及ArrayBuffer可收集、未完成半包仍保持引用，关闭后保留Broker和仅含大小的诊断对象不再pin住缓冲区；不承诺自然GC或RSS归还时机。

真实Rust在明确1MiB Node响应额度下先成功并发布基线，再拒绝较大合法响应，排空后同一进程/控制仍可用，旧已发布SKP的hash-only映射恢复。拒绝发生在Rust Mapper提交之后，不能称作远端事务回滚；仅保留JS结果也不会为Rust资源建立pin。默认45MiB工作集、57,802,256字节原生四SKP及四处像素、423次真正Mapper拒绝回滚、Source压力与控制门槛均保留。正式路径5组烟测通过；Rust/browser二进制未改，49项Rust验收沿用上一检查点。

本检查点只覆盖到达/私有Buffer及解析和交付临时估计。返回应用图/字符串、Node VM、Rust Snapshot/asset临时JSON、RPC/Gateway发送复制、原生录制/epoch及完整Session预算仍需补。8小时run2585828c使用更早冻结版，不包含本改动；B10仍部分实现，41项保持7完成、12部分、22待做，N1剩余范围不变。

## Snapshot 图与构造暂存归属

[Snapshot检查点](evidence/snapshot-graph-pool.json)增加独立默认256MiB池，`REMOTE_PAINT_SNAPSHOT_BYTES`配置1MiB至1GiB。构造前按借用Value扫描，分开保留Snapshot最终图、Mapper逻辑条目及暂存估计；不把已有资源池负责的SKP/Base64作为快照图重复收费。同一record的sourceLocalId可能被多个picture quad克隆，按实际次数估算。Snapshot不再派生深Clone，Arc共享归属；字段先销毁、额度后归还。Mapper reset替换逻辑条目HashMap，释放后备容量后才返回额度。

原真实b5e路径中，两份2MiB timing Value由Gateway已发布serial1和history/latest serial2保留，资源专用池仍为0，尚无Snapshot账本。新版本为这一路径保守计费9,140,222字节。明确32MiB额度下，更大的有效元数据在克隆和Mapper提交前被拒绝，旧epoch/revision/serial保持，随后小场景恢复serial3。替换发布与reset后该池归零，调用者仍保留的Node字符串另属应用图范围。

真实Gateway两帧测试在reset后仍保留874,488字节快照额度；有序ACK后剩437,244字节基线，关闭Peer才降至0。最低1MiB额度可接受小场景并拒绝较大场景，控制及清理继续可用。scene JSON先以256KiB上限流式计数，再分配精确长度Vec并禁止写入扩容；超限场景不会先分配完整序列化大字符串。最终保守额度仍预留256KiB，不代表小场景实际分配这么多。

54项Rust、177项JS和冻结35组Linux回归通过，正式路径6组烟测通过。六组资源为空的实际Mapper分配Layout探针均低于预留，包含2.1MiB文本、密集嵌套标量、转义场景ID、1750quads/246,827字节合法场景及超限2048quads。初版1100quads仅155,177字节，因未达到原>200KiB测试门槛失败；保留原日志并修正夹具规模，未降低门槛。默认45MiB工作集、57,802,256字节原生四SKP及四处像素、423次拒绝回滚，以及控制/Source压力等合同继续通过。Linuxarm64二进制与receipt原子替换，旧b5e备份保留；Chromium未改。

本池覆盖Snapshot和Mapper逻辑条目及构造暂存的保守归属，未覆盖其后RPC结果/emit、Gateway消息与Tungstenite副本、asset解析/manifest暂存、Mapper资源/弱索引后备、Node应用图或完整Session物理占用。8小时2585828c仍用a296冻结版，不包含本检查点；B10及41项保持7完成、12部分、22待做，N1剩余范围不变。

## RPC 借用序列化与输出包归属

[输出检查点](evidence/rpc-output-packets.json)用借用Serializer直接读取不可变Snapshot的scene、metadata和资源摘要，移走请求ID并保持入站租约，不再构造原先的完整map结果及外层包装Value副本。输出共享默认128MiB数据、8MiB控制预算；计数前保留小额暂存余量，先按90MiB数据/256KiB控制上限计数，再准入一个含4字节包头的精确OwnedVec，写入禁止扩容。第二遍长度变化在IO前拒绝。

实际旧路径的2MiB元数据回复序列化2,097,826字节，Vec容量4,194,768，requested-layout峰值8,396,923。借用路径只分配2,097,830字节包，峰值同为2,097,830，逻辑保留2,102,054字节；这是该探针的请求分配变化，不是整体RSS下降比例。默认完整90MiB正文也通过，包容量94,371,844字节；超限在大分配前拒绝。固定8KiB framing/stdio余量保留到emitter结束，包容量与每次计数余量分别收费。

60项Rust、177项JS及冻结36组Linux回归通过，正式路径7组烟测通过。独立阻塞writer、部分传输失败及变化Serializer测试覆盖了真实数据析构前不返还额度。实际Linux在明确1MiB输出数据额度下拒绝2MiB回复，控制额度返回关联错误，同一进程旧已发布SKP的hash-only映射恢复serial3。此时Mapper已经提交serial2，不能称作事务回滚。默认45MiB工作集、57,802,256字节四SKP像素、423次真正拒绝回滚、控制与Source压力合同保持。

暂停父端读取时，实际stdout是Unix socket pair，子进程阻塞在sock_alloc_send_pskb，父端达到65,536字节高水位；后续主RPC控制也必须等待。恢复读取后4MiB回复完整交付、后续控制成功，输出数据额度回到0。关闭阻塞输出时Rust退出2，旧进程身份消失；不会继续残缺帧。首版夹具只等pipe_write而失败，原5秒门槛和失败日志保留，v2改为匹配实际socket写阻塞及缓冲状态，未改变运行时。

同一真实关闭用例还复现Node的已关闭stdout Readable继续保留65,536字节，已记录为下一项清理缺口。该数据属于Node流内部，未被Rust包池或原Node接收/解析临时区宣称覆盖。已有控制/Gateway Value构造和handler暂存、asset JSON、WebSocket副本、持久索引、应用图/VM及完整Session仍待补。Linuxarm64二进制/receipt原子替换并保留968旧版，Chromium未改；8小时2585828c固定a296，B10及41项保持7完成、12部分、22待做，N1范围不变。

## Node 已关闭流的排队缓冲回收

[流关闭检查点](evidence/node-readable-close.json)修复destroy后仍由Readable队列持有原始Buffer的问题。真实子进程stdout/stderr各暂停到64KiB时，旧实现关闭并回收进程后仍保留两队列，强制GC也无法收集观察到的Buffer/ArrayBuffer。新增全局清理helper移除数据/可读回调、保留error/close监听，先destroy停止新读取，再用公共read每次最多1KiB丢弃已排队数据；不解码、不调用协议接收器，不把原始chunk留在close Promise的上下文。

Mac Node26.4.0与Linux Node22.23.3均通过正常关闭、强制失败和碎片输入三组实际子进程测试。两条队列均归零；保留Broker和流对象时，所有观察到的原缓冲区/底层backing可强制GC回收；无关闭后的额外data/readable交付、JSON.parse或协议event。Linux实际Rust四MiB写阻塞关闭用例，stdout残留从65,536字节降到0，子进程仍退出2且旧进程身份消失。

178项JS、冻结37组Linux回归和正式路径8组烟测通过；正常Source/renderer崩溃清理、待请求、未写完包、坏包、超限、spawn失败及重复关闭保持原规则。默认45MiB工作集、57,802,256字节四SKP像素、423次回滚、控制与Source压力合同继续通过。Rust066与Chromiumaa产物未变，沿用此前60项Rust与34项C++验收；本次没有新的原生产物替换。

这里证明的是排队引用被移除及强制GC可达性，不承诺自然GC时机或OS分配器归还，也未补齐活动流、Node VM和返回应用图预算。控制对象/asset暂存、Gateway/WebSocket复制、持久索引、原生录制/epoch及完整Session仍待补；8小时2585828c固定旧冻结版，不含本改动。B10及41项保持7完成、12部分、22待做，N1范围不变。

## 资源清单的借用序列化与最终缓冲区准入

[资源清单检查点](evidence/asset-manifest-owners.json)去掉了已解析assetRanges对应的临时section列表，以及每个chunk的JSON Value清单和描述升级时的JSON重解析。新资源先完整校验范围并计数，再构造chunk；PNG头/CRC、字体glyphSlots、范围顺序和32KiB分块规则保持。ChunkList按每次出现保留类型，避免同一hash同时作为font/image时丢失语义；新增id/kind存储在分配前准入，并计入强缓存收费。

清单直接借用不可变的id/chunk/kind和DecodeMemory字段，先计数再申请精确UTF-8缓冲区，禁止写入扩容，同一backing转入Utf8Bytes并由最终别名保持额度。升级只新建Resource元数据和新清单；payload、wire及chunk列表继续共享，旧Snapshot的null描述与旧清单保持不变。字段、键顺序、Unicode转义、chunk顺序与旧JSON逐字匹配。

实际旧生产工厂的512chunk夹具，清单构造requested-layout峰值477,114字节，新路径45,466字节；清单文本同为45,418字节。实际16MiB资源的512chunk升级，峰值476,991降到44,720字节，最终新增收费45,096字节。256range检查原先分配24,576字节后丢弃，新路径为0。这里是指定探针的请求分配结果，不是整体RSS下降比例；Mapper原有粗粒度Snapshot暂存已包含每chunk余量，不能据此声称旧路径完全无预算。

新增6项Rust测试覆盖完整JSON、同hash不同类型、精确额度不足时分配前拒绝、最后一个范围出错前不构造chunk、别名保持额度与旧快照不可变。66项Rust、178项JS、冻结37组Linux回归及正式路径9组烟测通过；64MiB池的两张7.5MiB未ACK帧、第三张拒绝后恢复、45MiB工作集、57,802,256字节四SKP像素、423次回滚、控制/Source压力、真实关闭流GC合同均保持。Linuxarm64原子替换并保留066旧产物和receipt，Chromium未改。

本次未补齐所有asset/hash/index暂存、控制/Gateway Value构造、WebSocket解析与队列/输出副本、持久索引或完整Session。8小时2585828c仍固定a296旧冻结版；B10及41项保持7完成、12部分、22待做，N1范围不变。

## 原生事件包装的借用字段

[事件检查点](evidence/borrowed-native-events.json)把19个Control、PeerStats、Peer生命周期及Viz事件发送点改为静态字段包装。Event仅借用调用方的消息、stats、ID或错误；不再为包装构造Value树，也不再复制其中字符串。字段在同步计数、精确包准入和实际stdout写入期间始终有效，沿用现有输出包归属及关键事件发送失败时退出2的行为。

七类事件的旧JSON逐字比对通过，包含键顺序、Unicode、错误码、省略字段和显式null的区别。合法32KiB密集Control夹具，旧包装峰值522,928字节，新包装分配为0；输出包单独分配32,703字节并保留36,927字节额度。实际11字段PeerStats的旧包装峰值1,408字节，新包装为0，输出包233字节。这里分别测量包装构造和输出包，不是整体旧/新RSS比例，也未移除原始消息图。

69项Rust、178项JS、冻结37组Linux回归和正式路径13组烟测通过。额外真实Linux探针在普通及独立控制WebSocket各发送一条32,146字节、含16,000额外节点的Input消息，事件内容完整，Broker继续响应控制查询，配对关闭事件与队列/进程回收通过。探针首版直接导入CommonJS入口时的失败记录保留；仅修正独立脚本导入，没有改变运行时或测试门槛。45MiB工作集、57,802,256字节四SKP像素、423次回滚、64MiB资源池、Source压力及关闭流合同继续通过。

WebSocket本身的JSON解析、待发送Value队列、其他握手/Gateway/handler构造、Tungstenite副本、asset/hash与持久索引、活动流/VM、原生/完整Session仍待补。Linuxarm64原子替换并保留2f8旧产物和receipt；Chromium未改，8小时2585828c仍固定a296旧版。B10及41项保持7完成、12部分、22待做，N1范围不变。

## WebSocket JSON 解析图准入

[解析图检查点](evidence/websocket-json-graphs.json)在Gateway数据连接与独立控制连接解析JSON前，使用共享默认128MiB额度。词法预检沿用4倍UTF-8、每token768字节及64KiB暂存余量，随后才调用serde解析；Private Parsed先析构Value、后返还额度，调用方只能借用图。控制握手在认证后显式释放，避免把填充数据保留到连接结束。

原32KiB消息、512次/秒、连接与peer上限保持。合法密集消息默认仍通过；明确1MiB额度下，分配前拒绝并关闭对应连接1013，配对数据连接按已有规则关闭1012，同一Broker的主RPC仍可查询且恢复ready。JSON错误沿用1008规则。resourceBudget.websocketJson分别报告活跃/峰值/拒绝和解析图范围。

新增5项Rust测试、全部74项Rust和178项JS通过；8组requested-layout结果覆盖密集数组、满32KiB字符串、末尾转义、对象/数组、Unicode/重复键和深层图，均低于已保留额度。8个并发reader只能持有两份给定容量的图；小额度在解析前拒绝，坏JSON/UTF8、深度和长度错误均归还额度。真实Linux默认/1MiB与普通/独立控制四组合通过，32,149字节消息含16,000额外节点，握手与处理后均无活跃解析收费。旧22e基线忽略新额度设置、仍转发消息的5秒失败记录保留；旧握手统计缺失不是内存滞留证据。

冻结38组Linux回归与正式路径14组烟测通过，45MiB工作集、57,802,256字节四SKP像素、423次回滚、64MiB资源池、控制优先级、Source压力及关闭流合同继续通过。Linuxarm64原子替换并保留22e旧产物和receipt。这里未覆盖Tungstenite在解析前分配的原始UTF8/frame/HTTP缓冲、待发送Value队列、其他Gateway/handler构造或输出副本，完整Session仍待补。Chromium未改；8小时2585828c固定a296旧版，41项仍7完成、12部分、22待做，N1范围不变。

## 待发送命令缓冲区与独立关闭槽

[发送队列检查点](evidence/outgoing-command-owners.json)把原先的main消息克隆、Gateway/Channel整串长度检查和队列消费端再次序列化，改为直接借用已准入的RPC消息，先按原32KiB上限计数，再申请精确UTF-8缓冲区。队列只持有不可变最终文本，别名保持原额度。普通命令默认32MiB、关闭原因及元数据另有1MiB；每个64槽队列/共享状态在构造前保留8KiB，发送端和接收端都结束后才返还。

旧实际Channel路径的4,000节点消息，wire为8,028字节，克隆与检查时requested-layout峰值140,936字节；新编码器峰值8,076字节，收费8,156字节。Mac/Linux的固定队列构造峰值3,264/3,256字节，均在8,192字节收费内。旧关闭对象的未接入receiver仍能读出4,000节点图，64条满队列还会拒绝关闭命令；新实现关闭未接入队列时丢弃待发缓冲，活跃receiver/外部别名持有的内容则继续计费至实际释放。固定队列额度不会提前当作已归还。

独立关闭槽不占普通字节或64个条目，保留该槽内最先接受的关闭请求；data/control共享同一原因缓冲。数据端即使已有64项notifications也先检查关闭槽。关闭会放弃尚未发送的后缀，但不会越过已进入Tungstenite/TCP的字节；缺失peer仍返回原有no-op成功。候选真实Socket测试中，内核TX在50ms观测前后分别保留142,848/142,848字节，另有32,165字节待发命令保持收费；恢复读取后按序收到前缀并正常关闭1001。它证明队列背压与关闭恢复，不是OS或库写缓冲已纳入预算。

Mac与Linux ARM64各82项Rust、178项JS、冻结39组Linux回归和正式路径15组烟测通过。明确64KiB普通额度的未接入配对队列和暂停fallback socket会拒绝新增命令；默认64条配对队列拒绝第65条，但三组都能使用独立关闭槽，收到指定1001及原因，最终普通/关闭/队列收费归零，同一Broker RPC继续可用。45MiB工作集、57,802,256字节四SKP像素、423次回滚、64MiB资源池、控制优先级、Source压力和关闭流合同保持。旧f52被保留，Linuxarm64产物原子替换。

写阻塞测试还明确证明：Tungstenite复制进内部frame/write Vec后，原命令额度可以归还，而库缓冲仍等待flush。首版夹具使用库默认写缓冲、首版暂停测试未观察到实际背压，均保留记录并补强为运行时配置与内核队列观测；未更改运行时或放宽门槛。下一步补HTTP/raw/read/write库后备预算，再处理其他Gateway构造、持久索引与完整Session；不能据此宣称全发送内存或RSS归零。Chromium未改，8小时2585828c仍固定a296旧版；41项保持7完成、12部分、22待做，N1范围不变。

## WebSocket 库内部缓冲准入

[库缓冲检查点](evidence/websocket-library-backing.json)覆盖锁定的Tungstenite 0.28.0与bytes 1.12.1。先前的实际库测试证实：即使原命令归还额度、flush排空，socket仍保留约16.9MB requested backing，增长峰值约25.3MB。因此发送长度上限不能代替容量所有权，也不能在flush后归还本额度。

共享池默认512MiB，可显式配置8MiB至2GiB。HTTP解析前预留2MiB固定握手、读缓冲和分片暂存余量；验证路由后、创建codec前，按data的16MiB+64KiB或control的128KiB写上限另留三倍容量增长余量。切换到较小chunk模式保留原额度，实际codec先析构再返还。每次read前另留2MiB，返回的Text/Binary/Ping/Pong/Close原因由最终Bytes owner携带，socket关闭、克隆或切片均不提前返还；未完成分片和不逃逸的关闭drain归固定余量。这里是锁定库requested-capacity的保守准入，不是全进程堆/RSS或OS内存上限。

Mac与Linux ARM64各88项Rust通过；实际库最大65,536字节HTTP、124个header、单字节分片UTF-8、交错Ping、失败握手及部分写均覆盖。HTTP峰值最高151,996字节，收包峰值最高180,264字节；data写增长峰值25,395,362字节，flush后仍有16,973,932字节，收费52,625,408字节。control峰值327,842字节，收费2,490,368字节。收到的消息和别名活得比socket久时继续收费，最后引用释放后才归零；原始输入声明1GiB会在大分配前拒绝。

真实Linux默认四组数据/控制连接及32,155字节中文Input通过，第五Viewer仍403。64MiB显式额度下角色准入失败503，原连接仍可输入；六个不完整HTTP握手占用固定额度后，已有连接的read准入关闭1013。8MiB额度下四个不完整HTTP占满，第五连接在HTTP解析前关闭TCP，不承诺该情况有HTTP响应。各组关闭归零，同一Broker可继续RPC及重新接入。首版探针把JSON键顺序当作内容差异，改为结构相等比较；失败记录和v1冻结副本保留，没有修改运行时或放宽语义门槛。

178项JS、冻结40组Linux回归与正式路径16组烟测通过，继续保留45MiB Base64、57,802,256字节四SKP像素、423次回滚、64MiB资源池、独立控制与暂停发送队列合同。Linuxarm64产物原子替换，保留8f旧版及receipt；Chromium未改，34项C++为此前验收复用。独立8小时2585828c固定a296旧版，不含此后库缓冲等检查点，尚未通过。

下一步补Gateway metadata/delta/SceneUpdate构造及缓存、peer/index后备；asset/hash、Mapper弱索引、Node活动流/应用图/VM、原生录制/epoch及完整Session/PSS仍待补。41项保持7完成、12部分、22待做，B10继续部分实现，N1剩余范围不变。

## Gateway 最终发送包与 delta 缓存归属

[Gateway发送包检查点](evidence/gateway-packet-owners.json)移除原先“克隆整份metadata再删除mappings/released”、header/body字符串复制与format整包的路径。现在借用原metadata并合并frameId/baseFrameId/protocol覆盖字段；完整scene借用已序列化原文，delta直接借用pass/ID序列化。先计数并遵守原256KiB帧上限，再申请单个精确最终UTF-8缓冲区。与旧实现逐字节一致，包含中文、转义、最大整数、完整/增量、pass新增/删除/重排与未变pass。

默认128MiB数据、8MiB控制池分别计费，最终不可变包、缓存delta及其别名保持额度。缓存命中只增加别名，不复制字符串。HashMap构造前留64KiB后备，clear只释放内容，不提前返还仍保留的桶容量；发布时保留原大于64项清理规则，另以128项硬边界防止单次发布间的突增导致后备增长。reset清空delta，Gateway实际析构才释放表后备。Welcome、ControlWelcome、ResourceRelease、FrameCommit、ChunkCacheReset改为借用字段生成最终包，没有包装Value图；所借用的原config/ID仍是其他归属范围。

实际旧路径的93,744字节完整帧，requested-layout构造峰值943,927字节；新路径93,792字节，收费93,872字节。增量帧93,770字节，旧峰值1,333,159字节，新93,818字节，收费93,898字节。61,604字节delta的缓存未命中旧峰值787,046字节，新61,652字节，收费61,732字节；命中旧分配61,604字节，新分配0。固定表Mac/Linux实际构造峰值低于64KiB收费。这是请求分配量和复制减少，不冒充物理RSS或完整Session改善。

真实Linux四个Viewer（两个配对控制）各8帧、共32次提交，与Mapper场景及frame/base信息一致；16,000节点timing完整保留，缓存delta为四个Viewer共享。256KiB额度下发现首版候选在已发送delta仍占142,268字节时，连续五次预算轮询均未就绪，当时将其推断为Source持续暂停；复核发现Source已有每秒一次受硬准入保护的试探，因此“永久暂停”未被证明。实际缺口是查询未回收可淘汰缓存，低配额新帧可能持续拒绝。即使原41组回归为绿，也未将该候选验收；保留失败探针并增加压力轮询回收。修复后查询回到65,536字节表后备，原连接无reset继续第三次提交；随后真实不足仍以1013拒绝第四次提交，没有部分帧/Commit逃逸。轮询清理后新连接可无reset收到最近完整帧。外部别名尚活时不提前归还，停止后包/内容/表收费均为0。

Mac与Linux ARM64各100项Rust、178项JS、修复后的冻结41组Linux回归及正式路径17组烟测通过。继续保留45MiB Base64、57,802,256字节四SKP像素、423次回滚、64MiB资源池、控制优先、Source压力及暂停发送队列合同。Linuxarm64产物原子替换并保留3d旧版/receipt；Chromium未改，34项C++为此前验收复用。冻结脚本首版误改了期望hash，保护检查在发布前拒绝；日志和未完成副本保留，未改运行时或门槛。

正式路径首轮烟测发现暂停fallback连接有一次收到1006而非1001，已回退3d产物并保留现场。确定性测试复现：Tungstenite在主动close遇到WouldBlock后，read不会重试自己的关闭帧；写上限接近满时close还会WriteBufferFull而没有入队。修复为先显式flush已提交数据，队列有空间后只提交一次close，并在读取关闭回应时持续重试flush。总边界仍为原200ms，没有放宽测试或延长期限。部分写入夹具在原边界内按序交付64字节文本及恰好一个1001关闭帧；十次独立Linux重复、共三十个关闭场景均1001，真实暂停场景内核TX连续50ms未排空，恢复读取后正常关闭、队列额度归零。修复后的100项Mac/Linux Rust与整套41/17门槛重新验证，旧97项/41绿候选未作为最终验收。

config长期图、peer统计/路由与known/known_chunks/abandoned/inflight/notifications、遍历和ACK临时索引尚未统一准入；Mapper弱索引、asset/hash、Node活动流/应用图/VM、原生录制/epoch、完整Session及OS/RSS/PSS也待补。独立8小时2585828c固定a296旧版，尚未通过且不含此后改动。41项继续7完成、12部分、22待做，B10和N1剩余范围不变。

## Gateway 长期状态与密集分段

[Gateway状态检查点](evidence/gateway-state-owners.json)覆盖原config长期克隆、registry、路由、peer容器与遍历/ACK临时索引。config保留原字段和未知字段，按原String/Vec容量递归预留后移动，没有再克隆一份；旧构造的128KiB配置峰值144,687字节，单独4000节点配置141,615字节；新构造同时包含二者，峰值Mac13,000字节、Linux12,976字节，原字符串指针保留。输入在测量前预建，这些数值只说明构造时的额外分配。4000节点配置、转义文本、额外容量和最终别名均验证。状态池默认512MiB，配置范围1MiB至2GiB；registry64KiB、route16KiB、每data peer64MiB提前留额，现有四Viewer上限不变。完整保守容器上界166,144个known chunk、133,635个pending packet的实际分配峰值43,515,984字节，在64MiB范围内；这是requested layout余量，不是RSS上限。

reset保持活peer的64MiB计费。stop后若部分HTTP连接仍真实持有Gateway，config/registry/route继续计费，最后路由关闭才归零。1MiB配置在保留前拒绝、无效bind回收、合法新peer503、错误Origin403；128MiB已有peer保持输入、原生捕获与页面时钟，第二peer503。固定容器余量已预留，不再用“另一个peer是否能准入”暂停已有捕获；canAdmitPeer只说明状态池字节余量，四Viewer协议限制独立存在。真实PNG连续帧及CPU CanvasKit像素通过。

本轮测量发现每资源256个asset range可产生513段，不能只用64MiB/32KiB估算chunk总数。发送计划按原32768项/64MiB缓存界限在资源之间reset，并精确计入重发chunk、清单和reset。若清单或密集小块索引成本高于完整payload，使用协议已有的完整资源包；普通小资源共享与2MiB/64chunk增量保留。256资源×256range真实Rust/compact ClientMemory/AssetCache测试完整提交256个资源，哈希与全部字节一致、内存失败0；该合成SKP头夹具不冒充原生像素证明。旧探针的Node共享Buffer曾夸大backing计费，校正为浏览器独立ArrayBuffer后旧版在原15秒期限超时；没有证明旧实际浏览器恰好撞到条目上限。ClientMemory逐owner扫描仍是独立性能缺口。

新增64px普通2Dcanvas夹具在旧9d与新候选均报Missing native layer，页面预热仍失败；Node Mapper独立观察到资源记录0、picture quad localId21。尚未修复，不能标为冷启动已解决，也不能替换成WebGL黑框。状态预算门槛改用独立128px PNG夹具，未忽略捕获错误；原canvas夹具、旧/新失败日志和ID证据完整保留。另修正先前“readyfalse会永久暂停Source”的推断：已有每秒一次受硬预算保护的试探，旧实际证据仅证明五次预算查询不回收缓存；原压力回收测试与修复保留，没有弱化门槛。

Mac与实际Linux ARM64各109项Rust、178项JS、冻结45组Linux回归及正式路径21组烟测通过。保留45MiB Base64、57,802,256字节四SKP像素、423次回滚、64MiB资源池、控制优先与原200ms关闭边界；140次真实PNG更新也通过。LinuxARM64产物原子替换并保留9d旧版及receipt；Chromium未改，34项C++为此前验收复用。独立8小时2585828c仍固定a296旧版，不含本轮，未据此宣布通过。41项继续7完成、12部分、22待做；Mapper持久索引、asset/hash、ClientMemory扫描、普通canvas、Node活动/VM、原生录制/epoch、完整Session及PSS和N1剩余范围继续推进。

## Mapper 持久索引、Weak 后备与临时分配

[Mapper索引检查点](evidence/mapper-index-owners.json)为resources、recency、references、chunks的长期后备和排序/哈希/统计去重临时分配建立独立额度。资源payload、wire、manifest、Snapshot图及逻辑entries继续使用已有归属。首次映射在分配前预留16MiB；失败不转移、不改变已提交代际，成功才将同一额度交给Mapper。默认池64MiB，可配置1MiB至1GiB；显式小于16MiB会在首次保留前返回RESOURCE_BUDGET_PRESSURE。已保留后备的Mapper即使额度恰好用满仍可继续，canAdmitMapper仅说明新实例的字节余量。

原实际容器增长、排序和统计指针集合夹具测得峰值11,188,272字节；clear后仍有1,232,928字节哈希桶，不能随临时Snapshot额度结束而提前返还。复核又发现：强引用归零后，Weak仍会保留整个Arc分配块，即使字段中的metadata lease已释放。把1280个WeakResource和16384个WeakChunk的真实零强引用分配块纳入同一重叠夹具后，峰值增至12,996,656字节，仍低于16,777,216字节额度。原测量与首版46组绿回归保留，但未用较窄测量替代最终验收；扩展后的115项Mac/Linux Rust及新冻结46组重新通过。统计去重集合296,286项上界来自当前128MiB缓存charge及目标结构453字节最小chunk成本，不是随意调低条目上限。

clear/reclaim保持哈希桶和额度；reset先替换四张实际表再归还，Mapper析构也先销毁数据。已有Snapshot、资源和wire别名仍使用自己的最终owner，索引额度释放不冒充这些资源已消失。原Snapshot临时计划仍对部分索引工作保守重叠收费，本轮不宣称所有逻辑记账都最小化，也不把16MiB准入等同于物理分配16MiB。相同Snapshot计数夹具的成功路径原有35字节eager错误字符串分配，改为惰性构造后为0；未据此宣称延迟或RSS改善。

真实Linux Broker在1MiB配置下首次映射前拒绝、资源/Snapshot/索引归零且同进程可继续RPC。16MiB额度下，256资源×256range填满8192项弱chunk索引，晚失败保持全部状态；清强缓存后按哈希继续映射，空表仍保留容量/收费，reset实际容量和收费均归零，原进程可再次映射。独立真实PNG Source在索引池恰好16MiB、无第二实例余量时继续捕获、页面时钟前进，CPU CanvasKit像素正确。

Mac与实际Linux ARM64各115项Rust、178项JS、最终冻结46组Linux回归和正式路径22组烟测通过，保留45MiB Base64、57,802,256字节四SKP像素、423次回滚、64MiB资源池、四Viewer/控制优先、140次PNG更新及原200ms关闭合同。LinuxARM64产物原子替换，保留809旧版及receipt；Chromium未改，34项C++为此前验收复用。独立8小时2585828c仍是固定a296旧版，不含本轮且未据此宣布通过。

map前expand_tiles已有SKP移动和2048 quad硬检查，但其原字段图复制及临时后备尚需准入；不能把条目上限当成每个Value图的内存所有权。ClientMemory逐owner扫描和普通2Dcanvas的原生记录缺口仍未解决，后者不得替换为WebGL占位。Node活动/应用图/VM、原生录制/RasterSource/epoch、完整Session及PSS、B4性能对照和N1剩余门槛继续保留。41项仍为7完成、12部分、22待做。

## 客户端增量记账与已释放回调
+
+[增量记账检查点](evidence/client-memory-incremental-ledger.json)把普通准入的完整owner/固定backing遍历改为增量维护类别、domain、引用总量、去重backing、owner元数据和decode headroom。保留每owner已声明类别费用、跨owner共享buffer去重、零字节owner存在性及Wasm/Skia最大值语义。每活类别增加160字节、每可变backing追踪项增加128字节估计，原512字节owner/96字节backing及各档位上限保留；新增状态没有免计费。
+
+对照使用冻结的旧完整扫描实现，并在对照端加入相同新增元数据费用，逐步比较5120次操作的数值快照、配额结果和峰值；不是把新增状态的费用隐藏掉。resize/split检查期间，淘汰回调可能先释放父owner，失败恢复只针对仍活的父owner，不重建已经释放的计数。MAX_SAFE_INTEGER的拒绝路径会重新计算活owner，避免加减溢出留下1字节残差。初次对照仅因新旧accounting说明文字不同而失败；保留日志，后续只排除该文字，数值、计数和错误继续完整比较。Mac与实际Linux各187项JS通过。
+
+固定ArrayBuffer在未通知转移时只能缩小/脱离，因此准入缓存是安全上界；可能超限时先重新采样backing，再触发压力或淘汰，避免旧存储已脱离后误拒绝。可变backing每次check刷新，公开快照也遍历backing校准实际byteLength。未经通知的固定buffer脱离可让准入峰值保守偏大，这一点有明确测试与说明；不能把该峰值宣称为实测物理内存。类别仍记录各owner准入时声明量，与既有语义一致。报告、压力、可变backing、数值恢复及类别/退役arena规模仍有遍历，没有宣称所有调用均常数时间。
+
+相同Linux Node预建60字节独立buffer、每owner640字节元数据的32768-owner准入，中位数从13292毫秒降至28.77毫秒；同批浏览器从6009.8降至87.8毫秒。独立同页浏览器门槛也测得明显下降；每次实际结果完整保留，不能挑一个倍数冒充端到端帧性能。512-owner结构探针原本分别迭代131328次entry和backing，普通新路径均0次。这些是记账/check微测试，不含网络、解码、CanvasKit绘制和显示扫描。
+
+真实浏览器GC又验证了释放后的归属：旧实现虽报0owner/0buffer，只要release/resize/split句柄尚活，其闭包entry.buffer仍保留2MiB数据；丢掉句柄后GC才回收。新实现释放时清除entry及最后backing记录的数据引用，保留同样句柄时GC已能回收；零计数与实际可回收在此夹具一致。该证据不等于OS立即归还RSS，也不替代完整Session/VM审计。
+
+47组冻结Linux回归与正式路径23组烟测通过，继续保留57,802,256字节四SKP像素、45MiB Base64、423次回滚、64MiB资源池、四Viewer/控制优先、140次PNG更新和原200ms关闭合同。Viewer内容指纹随协议模块更新，Wasm不变，新bundle拒绝旧指纹。Rust3d9与Chromiumaa未改，115项Mac/Linux Rust及34项C++为此前验收复用；没有伪称重新编译。独立8小时2585828c仍固定旧客户端和a296，不含本轮且未据此宣布通过。
+
+普通2Dcanvas缺少原生record、map前tile/WebGL Value准入、Node活动/应用图/VM、原生录制/RasterSource/epoch、完整Session及PSS、B4对照和N1剩余门槛仍待补。WebGL继续限定黑框文字占位；普通Canvas不能被误标成WebGL。41项保持7完成、12部分、22待做。

## 普通 Canvas 2D 的同帧像素副本

[Canvas原生检查点](evidence/canvas-native-capture.json)修复此前64px普通2Dcanvas在正式3d9+aa上持续出现的Missing native layer：Viz有picture quad，原生却没有TextureLayer kCanvas资源。现在由所属cc线程读取同一捕获帧SharedImage，复制为CPU不可变像素并录成SKP；矩阵、裁剪、圆角、opacity与层级仍取同帧Viz。软件映射处理row stride/格式/alpha/色彩空间/origin；GPU路径验证read usage，同步回读完成后结束访问。DrawingBuffer WebGL按约定占位，未知纹理仍严格拒绝。

副本池每renderer默认256MiB，可设32MiB至2GiB；先收取RGBA请求字节与1024字节包装估计，再分配。SkData回调先析构像素，最后别名消失才归还lease；8192维度/64MiB解码上限不变。原始BlinkCanvas/SharedImage、驱动、PNG编码临时存储和完整VM/Session不在该池。临时Canvas图像不进入长期image cache，普通DOM图片缓存保留；混合tiled DOM使用origin-zero完整Canvas tile，未宣称256px Canvas损伤分块。

32MiB夹具先拒绝4096²，页面时钟持续运行；缩至256²后同进程恢复精确像素。默认池的4096²/64MiB图像也通过，最终副本owners/bytes归零。C++另验证picture/SkData别名仍活时不提前还额度、并发不超池及padded BGRA转换。静态截图与CPU CanvasKit超24像素差异约0.44%，ANGLE SwiftShader GPU API路径约0.41%；透明/缩放/变换/圆角抽样逐通道差异不超过3。连续12动画帧的Canvas与DOM三色色块完全配对，导航epoch、视口版本/尺寸更新通过，ACK在绘制后发送。SwiftShader的RasterInterface计数证明GPU API分支被执行；物理GPU/Mac原生兼容与同步回读性能仍待验。

Mac与实际Linux各188项JS、41项Linux C++、51组冻结回归和27组正式烟测通过。Rust3d9及源码未变，115项Mac/115项Linux Rust为此前验收复用。57,802,256字节四SKP/四像素、45MiB Base64、423次回滚、14帧资源池恢复、140次PNG更新、控制优先与原200ms关闭合同保留。初版C++新像素测试缺少PNG反序列化回调而只绘出白背景；保留失败日志，补上既有显式解码器后41项通过，未改生产alpha数学迎合测试。

候选独立构建，保留旧AA二进制/收据，冻结回归后原子切换正式路径并复验。旧0001至0010补丁哈希不变，仅追加0011；不提交、不推送，无关peer差异和缓存保留。独立8小时固定旧AA/a296/旧客户端，不含本轮。B10、B13、C5仍为部分实现，41项保持7完成、12部分、22待做；预处理Value图、Node/VM、原生录制/epoch/Session/PSS、B4对照及N1剩余门槛继续推进。

## 映射前 tile/WebGL 展开归属

[展开检查点](evidence/capture-expansion-owners.json)在复制前读取原图、计算可见展开数量和新增布局额度，再由ExpandedCapture保留到映射结束，Value先析构、lease随后释放。原有2048quad限制及SKP/Base64移动保留；固定栈几何替代临时groups/hashset/number Vec，最后一个可见tile直接取得原quad，Value::Array直接移动输出向量。WebGL namespace也借用原值。完整额外字段即使最终被Mapper丢弃，其临时复制仍逐份收费。

独立池默认128MiB，REMOTE_PAINT_EXPANSION_BYTES范围1MiB至1GiB；数值是保守请求布局预算，非原始输入、栈、VM、OS或完整Session。32tile×256KiB额外字段的旧申请峰值16,899,654字节，新路径含新建输入峰值8,463,260字节、预留17,338,100字节；低额度拒绝只申请44字节错误字符串。最大tile/quad/pass、转义字段、WebGL、不可见区域、45MiB字符串不复制及最终owner释放均有实测；这不是帧延迟或RSS收益。

真实1MiB RPC拒绝大额外字段并保持Mapper状态，恢复后用hash对应的夹具SKP验证tile/边界像素；实际4096×2048原生DOM Source另验证准入前拒绝、页面时钟持续、缩小视口后同进程恢复正确512×256像素，使用真实接收的Gateway资源。双平台各123项Rust、188项JS通过；Rust/浏览器/生产JS完全未改的47组冻结与23组正式合同复用，Canvas/新准入5项各自重新执行，合计52/28组通过。Chromium1eb与C++源码/补丁未变，41项Linux C++为前轮验收复用；57,802,256字节四SKP/四像素、423次回滚、资源池/控制/关闭/Canvas合同保留。

初版冻结在WebGL色块更新测试失败，同样现象在旧3d9对照复现：测试的async谓词返回Promise(false)，本地Playwright却把Promise当真值提前结束；独立asyncfalse/同步false超时校准证实。删除无用async并断言实际返回true，原像素和错误断言保持，修正后旧/新各4次冷启动均有真实red witness，重新冻结验收通过。另一个新夹具误把RPC资源长度描述当SKP字节，已改为hash校验后的夹具像素检查；实际网络像素由独立native Source支路证明。失败日志均保留。

CDP/RPA timing合并的原始输入额度覆盖关系仍待单独审计，原生录制/RasterSource/host/epoch、Node/VM、Session/PSS及其他41项/N1门槛没有因此完成。独立8小时仍固定旧a296/AA/旧客户端，不含本轮且未宣布通过。状态维持7完成、12部分、22待做。

正式GPU导航夹具曾漏识别主动导航的CDP失效通知，旧Broker已按预案恢复后补验。新夹具主动在capture运行时导航，仅收集导航阶段明确失效消息，并验证浏览器/目标仍活、新URL、至多3次失效、新epoch的12个实际同帧像素及resize恢复；其他错误继续失败，报告显式保留这些导航事件。未改生产代码，也未放宽像素或预算。

## 当前客户端版本的独立八小时

[启动收据](evidence/client-memory-eight-hour-current-client-start.json)固定b46客户端、Rust48dc和Chromium1eb，runId为6aac0cc8-d1fb-42de-a2ef-f18696129f81。实际Mac Metal GPU Worker、CPU Worker及CPU主线程共同运行28800秒工作负载；初始400轮突发与后续导航/resize/图片/输入循环已开始，原2585828c旧版本测试继续独立运行，时间不累计。本轮后续录制键缓存等改动不在此冻结版本；这里只证明启动和初始进展，须等最终长时、内存、健康及清理验收。

## 原生录制键索引归属

[录制索引检查点](evidence/native-recording-index-owners.json)移除了长期缓存的RasterSource、DisplayItemList、SkPicture及其图片/字体引用，只存不可复用的Source代数、录制键、层/分块坐标、范围和LRU序号。SkPicture的approximateBytesUsed明确不计大外部对象：同一4MiB图片夹具中旧录制对象近似240字节，却实际保留4,195,328字节像素额度；新索引保留标量键时像素持有者已释放为0。这是实际归属实验，不是整进程内存或帧耗时收益。

索引固定1024项与2048个桶，实际后备61,440字节；每宿主先准入64KiB，后备析构后才还额度。进程池默认8MiB，REMOTE_PAINT_RECORDING_INDEX_BYTES范围64KiB至256MiB，额度不足完整重录并使用既有编码预算，不删内容。已有64MiB编码缓存命中时直接携带编码和标量几何；编码淘汰则从当前活跃RasterSource重录。新0012补丁提供64位非零Source代数，避免地址复用的错误命中；原有补丁哈希保持不变。

实际Linux完整层与256px分块两路均通过：同进程双宿主共享64KiB额度，第二宿主80次真实图片更新在索引拒绝时仍逐次像素正确；真实编码淘汰后第一宿主重录当前Source；关闭第一宿主后第二宿主同进程恢复缓存。另有两数据面各80次编码字节压力、200次导航后的实际宿主销毁，以及Canvas软件/ANGLE SwiftShader、57,802,256字节四SKP/四像素、423次映射回滚、控制和关闭合同复验。47项Linux C++、Mac/Linux各188项JS、55组冻结回归和31组正式烟测通过；Rust源码/锁文件/48dc二进制未变，双平台各123项Rust验收明确复用。

夹具失败均保留：纯色Viz变化不能要求图片录制失效；初版双窗口自动时钟曾采集超时，当前夹具以明确ACK的逐目标步进测顺序双宿主归属，不宣称并发显示调度通过；弹窗建立可能改变Source代数，因此编码淘汰实验先在弹窗之后取得实际稳定键。正式代码未因这些夹具修正而变化。

活跃Source、瞬时录制/序列化、固定池自身元数据、分配器/VM/驱动和完整Session仍另计。B4冷缓存尖峰性能对照、CDP/RPA timing合并、两条独立长测和其他41项/N1门槛仍待完成；本轮索引不进入已经冻结的八小时样本。状态维持7完成、12部分、22待做。

## 原生 timing 归属与异常恢复

[timing检查点](evidence/native-timing-owner-transfer.json)先测量旧实现：五组实际原生/RPC解析与复制峰值均落在仍存活的输入额度内，没有证明预算漏计。随后把CDP对象的键和值直接移入原生元数据，保持原生独有字段和逐字段浅层覆盖；空/null目标直接取得完整map。2.1MiB字符串、8KiB新键、嵌套向量及替换值保留原始分配地址，空目标不发生新增分配。深层样本Mac请求布局峰值由6,966,453降到3,941,913字节；大字符串解析峰值可能不变，不把它描述为整进程内存或帧延迟收益。

真实旧48dc Broker在非对象原生timing与非空CDP对象合并时panic并以101退出，使用独立夹具进程复现并保留日志。新路径返回明确错误，16次畸形元数据均保持Mapper未提交，原生输入/资源/RPC数据、展开和Snapshot额度返回；同一Broker随后完成6组有效/忽略语义的映射与hash对应夹具像素。实际网站像素另由原生Source→Gateway→Viewer、WebGL占位及Canvas合同证明。

Mac/Linux各129项Rust、14组针对受改原生合并路径的冻结合同与5组正式复验通过，含57,802,256字节四SKP/四像素、423次回滚和压力/Canvas导航恢复。Chromiumecb与25份原生源码/12补丁、生产JS/单测输入及253份依赖文件未变，47项C++和双平台各188项JS明确复用；上一轮55/31组检查保留为历史证据，没有宣称整套重新执行。

原有输入租约继续跨越移动后的图直至Mapper结束，Snapshot/输出持有各自准入，未修改任何额度和协议。两条八小时测试均固定其原有版本，不含本轮；完整Session/PSS、原生活跃Source/瞬时编码与其他41项/N1门槛仍待完成。下一步转向B1/B2的原生订阅与消费需求，状态保持7完成、12部分、22待做。

## 长测连续覆盖校验失败

[采样间隔失败证据](evidence/client-memory-sampling-gap-failures.json)保留两次独立运行。旧客户端2585828c运行了约8小时并正常清理Source/Broker，但468个样本出现91.325和118.792秒间隔，原有严格小于90秒的连续覆盖门槛失败，不能计为八小时通过。新客户端6aac0cc8也已出现115.838秒间隔，因此在保留证据后只关闭其已核实的专用Viewer浏览器，令原夹具正常清理Source/Broker；终态错误来自这次明确的人工终止，并非自发崩溃。

采样前已记录的应用健康未见崩溃、逻辑预算失败为0，容器事件没有OOM；这些只证明已有观测，不能替代连续覆盖。墙钟与单调间隔一致，但原因尚未确定，不推断为睡眠或内存泄漏。两次都保留原门槛、不拼接时长、不重用运行ID；下一步拆分采样耗时、补齐超时与临时句柄清理，经短测校准后启动新的独立八小时。C5与完整41项仍未完成。

## 采样器阶段校准

[四分钟校准](evidence/client-memory-sampler-phase-calibration.json)在真实Mac硬件GPU Worker、CPU Worker和CPU主线程三路及Linux Source上通过，含400次以上图片/字体更新、导航、resize和真实输入像素。诊断转到后台，Source命令保持有序，逐阶段记录耗时并限制等待，ps改为异步；90秒门槛提前即时检查，原八小时、像素和清理门槛保持。一次57.8MB真实原生工作集验证与采样实际重叠，最长采样间隔约60.73秒，未出现预算错误，最终Source/Broker均清理。

另外用真实Playwright连接所有权表证明64个未释放的waitForFunction句柄会保留64个通道；显式dispose后回到基线。修正的是夹具对象生命周期，未证明它导致之前长间隔，也未把它描述为产品Viewer泄漏。当前生产客户端b46、Broker48dfe9和Chromiumecb均未改；短测不能替代八小时，仍需新的独立连续运行。

新的独立八小时[启动记录](evidence/client-memory-eight-hour-sampler-start.json)已建立，runId=3319f9fa-46ee-4f62-9871-766fcf2f8125，固定客户端b46、Broker48dfe9、Chromiumecb和已校准采样器，目标28,800秒、400次初始突发、2秒更新与每40次导航。三模式保持原90秒连续采样、预算、像素和清理门槛，前两次失败不贡献时长。该运行现已终止失败：[阶段超时证据](evidence/client-memory-eight-hour-sampler-failure.json)记录约20分钟、第933轮时Viewer进程RSS的ps采样超过5秒门槛。20份成功样本保留，Source/Broker/fixture正常清理；未完成八小时，不贡献后续时长。尚未证明ps超时的具体系统原因，原连续采样、像素和完整物理内存验收门槛不变。

## B2消费需求、只读原生通道与首次唤醒

[需求与消费检查点](evidence/source-consumer-demand.json)将显示、观察、录制和页面运行分开。页面运行租约可abort并独立释放；受管Agent输入执行时自动持有活动租约。零显示端观察收到请求后的真实新资源、当前inputSeq及图片/字形像素；观察在epoch或viewport变化后关闭，录制跨导航和resize，显示端退出不停止录像。仅有页面运行时RAF继续而不编码，所有需求退出后停止外部时钟。

原生凭据绑定Source、Origin和服务端选定角色，最多8份待用票据、10秒单次有效；原4个显示额度保留，另有合计2个观察/录制端，既有字节预算不变。只读端不能取得控制或编辑反馈，consumer-released仅表示可归还在途消费额度。慢录制单独断开，显示继续；64MiB压力下零显示录制暂停编码、页面继续，ACK释放后恢复正确像素；活动连接与待用票据在关闭时撤销。完整账户/租户/Session SDK不由此替代。

首次正式复验保留了一次Native capture refused失败，并回退正式二进制。bootstrap停止时原生根图层可能尚未建立，首个消费者若很晚才到，原两秒窗口已过；这一根图层解释来自代码路径推断。修复让编码需求从零唤醒时先等一个真实BeginFrame ACK，再登记采集并采样输入/ordinal；取消期间排空ACK且不编码。显示/观察/录制三独立Source在2.2秒后才连接，均验证ACK先于登记、像素正确和零拒绝重试。没有扩大拒绝窗口或把错误改成成功。

Mac/Linux各198项JS通过；137项Rust对应同一未变的本轮修订，47项C++复用未变Chromiumecb。22组新冻结合同和7组Linux正式复验通过，保留57,802,256字节四SKP/四像素、423次回滚、资源池14帧、Canvas GPU同帧/导航/resize与WebGL黑框文字。Mac正式协议复用同一Rust二进制及未变协议客户端的验收，明确区别Source唤醒验证。当前为8完成、12部分、21待实现，B1原生持续订阅、C5新八小时、完整Session/PSS、SDK/兼容及N1仍继续。

## RSS采样子进程的有界回收与校准

[RSS校准证据](evidence/client-memory-rss-sampler-calibration.json)把每次ps限制为两秒并用SIGKILL结束，等待至多250毫秒回收；仅已确认退出的超时允许一次新测重试。启动/退出、格式、缺失进程和输出上限错误直接失败，未退出子进程也不重试。每次采样都记录实际尝试及完整请求PID覆盖，保留原五秒RSS阶段、九十秒连续覆盖、八小时工作负载和清理门槛。

Mac/Linux各205项JS通过，含真实ps、一次挂起后恢复、两次实际挂起终止、输出/身份错误和模拟无法回收句柄。实际三模式Mac Viewer与当前B2 LinuxSource的四分钟校准在第二次RSS采样故意挂起专用测试子进程：确认SIGKILL回收后，重试执行真正ps，后台PNG/字体/导航/resize/输入继续并检查像素。全部预算与Source/Broker清理通过，故障注入仅属于短测；未证明旧ps超时的具体系统原因，也没有八小时通过。下一步使用相同冻结版本、不加载故障preload启动新独立八小时，不累计任何失败时长。

新的独立八小时[RSS运行收据](evidence/client-memory-eight-hour-rss-start.json)对应runId `729a8b0f-6084-4284-a04b-5b5d5f158c86`，固定B2Source/Broker238、Chromiumecb、客户端b46和新采样器，Source与Mac三Viewer使用独立运行实例，不加载短测故障preload。目标28,800秒、400次初始突发、2秒更新和每40次导航；原五秒RSS阶段、九十秒连续覆盖、像素/预算/健康/最终清理门槛保留。已核实真实进展，当前仅运行中，不能作为八小时通过；未来B1修改不进入其冻结目录。

最新RSS长测729a8b0f已[终止失败](evidence/client-memory-eight-hour-rss-failure.json)：第482轮真实ps无输出，超过两秒后SIGKILL，250毫秒内仍未收到close事件。原门槛据实判失败，Source/Broker正常清理；这不证明该进程在稍后仍存活或具体内核原因。四分钟故障注入短测仍是既有证据，不能替代这次自然故障的调查与新的独立八小时。

后续独立检查确认故障ps的原PID已不存在；40次“本Node/空白专用Chrome”实际ps探测均正常退出，未复现加载三Viewer时的故障，因此不据此重启长测或认定根因。完整进程启动/exit/close与晚到事件仍待在真实负载下取证；B1原生持续订阅作为下一项独立实现继续，八小时和完整VM条件保持未通过。

## B1原生持续订阅基础候选

[原生基础检查点](evidence/native-subscription-foundation.json)实现固定四份订阅、原生ordinal预留区间、输入水位与主线程提交激活屏障、导航/上下文/host销毁时的同步撤销。每份订阅只保留一项在途工作，精确回执前保留实际录制与编码所有者；错误或缺失回执暂停，恢复与重试强制完整资源。新0013补丁追加生命周期钩子，独立Chromium候选不替换正式ecb。

冻结候选通过65项实际Linux C++、9组带测试专用回执接收端的原生检查与连续12次有序视口切换，持续8帧期间没有逐帧Runtime.evaluate/awaitPromise。真实Rust/CanvasKit的Canvas/DOM同帧、导航/resize及完整旧链路Viewer回归通过。首次夹具失败保留：连续resize没有等待外部BeginFrame ACK，重现了LocalSurfaceId切换丢ACK；新夹具沿用真实Source.resize已有的排空与停钟顺序，不扩大超时。另记录浏览器聚合Viz根图可能先于renderer树resize，生产Broker仍须单独校验。

这些只验收原生候选基础：默认Source仍逐帧登记、等待并通知映射/发布；生产Broker的订阅授权、串行Mapper、明确回执及Source持续路径尚未接通，未声称B1完成。当前为8完成、13部分、20待实现。八小时、完整内存、SDK、兼容及N1条件保留。

原生候选最后的socket审查另发现阻塞获取写锁可能越过本次传输期限。新v3改为有截止检查的Try/adopt，并用真实Unix慢接收端持续排空1MiB旧写入：原生等待在旧写入仍持锁时按期失败，socket不被另一项工作错误关闭。冻结版本66项C++、9组原生检查、12次有序resize、Canvas/DOM像素与当前候选完整旧链路Viewer复验均通过。既有connect的一秒socket超时另计，不声称OS实时保证。正式ecb/238不变，下一步仍是生产Broker与Source持续路径。

## B1 Broker 原生接收候选

[原生接收检查点](evidence/native-subscription-intake.json)接通固定四份订阅授权、双平面配对、独立Viz根尺寸与输入水位校验、精确56字节回执及撤销。未知或已撤销数据先鉴权再准入；原始RVB暂存与解析图分别计费，释放原始接收缓冲后才通知就绪。未提高额度，正式Broker与Chromium不替换。

Mac/Linux各153项Rust、205项JS及各6组实际Broker/Unix拒绝合同通过；冻结Linux保留16秒空闲连接、16MiB输入背压、423次事务回滚、57,802,256字节四SKP/四实际像素和零hash恢复。主循环尚未自动消费原生工作，成功映射/发布/Consumed只在真实Rust Mapper单测耦合验收；持续Source及端到端原生发布仍待接通，B1保持部分实现，41项仍为8完成、13部分、20待做。

## B1 Broker 自动映射发布候选

[调度检查点](evidence/native-subscription-dispatch.json)将 stdin/control 与单一 Mapper/history 所有者分开，固定四槽请求队列保留原始准入租约；原生数据唤醒映射循环，最终发布与撤销共用屏障，成功发布并释放接收所有者后才回送 Consumed。向 Node 只发送固定标量事件。旧映射取走数据后仍占混用名额，ID固定内联，满额输入池的故障控制不再需要额外数据额度；未提高任何限额。

Mac/Linux各156项Rust、205项JS、各4组实际调度和6组拒绝合同通过。冻结真实Chromium连续帧、Canvas/DOM同帧三色、暂停/输入水位、显式导航与resize通过；非切片大图走原生自动映射/Gateway，必需四SKP为57,802,256字节、四实际像素及零hash恢复，初始RPA另含225字节未引用录制块，随后hash-only为零原始资源字节，全程没有map/publish RPC。冻结旧路径保留423次回滚、64MiB池14帧、16MiB输入和满池故障、300项RPC语料及16秒空闲连接。

候选未替换正式二进制，默认Source仍使用逐帧CDP与map/publish；接入前还需校正第三次Retry后的事件outcome与实际Pause一致，并补真实document token、按需/空闲/输入/导航/resize屏障及持续路径完整背压验收。B1仍部分，41项保持8完成、13部分、20待做；八小时和完整Session/PSS未通过。

## B1 原生终态事件一致性

[终态检查点](evidence/native-subscription-outcome.json)使 Work.finish 返回实际回执终态，拒绝事件据此发送。实际双平台连续三次缓存失败均得到 Retry/Retry/Pause，事件与56字节回执一致，Mapper序号不变；显式恢复后发布下一帧。Mac/Linux各156项Rust、各4组冻结调度和6组拒绝合同、真实Chromium四组生命周期像素通过，修正上一检查点记录的事件状态缺口。大资源、423回滚、64MiB14帧与205项JS的完整验收继续明确归属于未变数据路径的上一冻结版本，本次未冒称重跑。正式二进制未替换，默认Source和完整B1继续待接入，41项仍为8完成、13部分、20待做。

## B1 原生真实文档标识候选

[文档绑定检查点](evidence/native-subscription-document.json)增加私有isolated接口describe和bindDocument：读取真实Blink WebDocument Token，绑定前比较预期标识；错误标识不占用订阅、generation或ordinal，新文档根未就绪返回明确状态。追加0014头文件补丁，旧0001至0013不变；RenderFrameImpl指针继续仅用于同步撤销，不能被当作文档身份。

冻结浏览器候选通过66项C++、Mac/Linux各205项JS、8组实际文档合同及24次连续跨站导航。空白/首次导航/同文档history/reload/默认跨站/独立Context真实渲染进程替换均校验标识、旧标识拒绝、序号和实际像素；原生持续Canvas/DOM同帧4组与57,802,256字节四SKP/四像素/零hash恢复也通过，未使用map/publish RPC。强制site-per-process与外部帧控制不兼容的首次失败保留，后续按真实默认启动方式验收。

正式浏览器及Broker不替换，默认Source尚未采用新标识；原生间隔/空闲心跳、Source对延迟导航事件的epoch去重及完整持续控制/背压/关闭仍待实现。B1部分、41项8完成/13部分/20待做、八小时及完整Session/PSS条件不变。

## B1 原生采集调度状态基础

[调度状态检查点](evidence/native-subscription-cadence-book.json)在固定四槽、原2048字节状态上限内加入单调时间的间隔/心跳截止时间和损伤挂起标记。限频或等待回执期间发生的损伤被保留；输入请求越过普通间隔但不能越过实际提交屏障。绝对请求时间避免其他订阅频繁出帧推迟或提前触发当前订阅的安全重试；暂停和撤销清除有效截止时间。没有新增帧、图片、任务队列所有者。

冻结实际Linux C++73项（新增7项边界）及原生文档8组/24次连续跨站导航/实际像素通过。这里只完成状态算法：私有cadence接口、实际CC损伤/单调时间传入和主线程单一计时器尚未接线，不能据此认定运行时限频或空闲心跳已完成。Broker156项Rust与205项JS保持同一代码/产物；57MB等完整合同仍归属上一文档候选，不冒称在本候选重跑。正式产物未替换，默认Source及B1仍继续，41项保持8完成/13部分/20待做。


## B1 默认 Source 重置恢复

[冻结重置检查点](evidence/native-source-reset-default.json)修复已复现的静默停帧：Broker 在排队前撤销原生订阅，即使重置最终被四槽队列拒绝，Source 也须排空并重新绑定。新控制事件按实际请求 ID 配对，固定三种暂停原因分别持有；重置不改变同一真实文档的 epoch，也不计入资源哈希缺失恢复。

双平台各211项JS与7组真实重置检查通过。11次请求中9次完成、2次按既有额度拒绝；覆盖无人观看、活动流、手动暂停、实际 Mapper 等待中的四项重置与并发 resize，以及仅重置被拒绝的恢复。过渡期间匹配版本的人工输入和消费者栅栏被拒绝，恢复后实际 Canvas/DOM 像素、input2、新原生序号范围及完整资源正确。测试显式使用两次小型诊断 map 制造真实资源等待；无逐帧 publish 或 awaitPromise。

同一冻结版本复验24次跨站导航、实际信用排空/重入恢复、页面需求及观察/录制，并通过64MiB实际原生压力的14个变化像素状态；重置后 Peer 未ACK基线继续持有额度，关闭后归零。真实哈希缺失恢复仍待验收，正式二进制保持原版本；B1部分、41项8完成/13部分/20待做，八小时与完整物理内存条件不变。


## B1 实际原生哈希缺失恢复

[冻结哈希恢复检查点](evidence/native-source-hash-retry-default.json)在两个独立默认 Source 会话中验证真实 Mapper 缺失与原生 Retry。实际 PNG 先以完整字节发布，再按 hash 复用；真实按键 ACK 建立 input2。实际 C++ 信用排空后仅暂停外部时钟，用五次明确的空诊断映射替换历史，再经既有 resourceBudget 回收释放全部旧资源所有者。此时尚未建立 Gateway/Peer，原生订阅保持启用且没有显式完整资源请求。

恢复时仅重启时钟，下一实际 hash-only 原生帧被 Mapper 以 cache miss/Retry 拒绝，Chromium 收到真实信用后自主补发702字节完整资源，再恢复零原始资源字节的 hash-only 帧。两次会话恢复窗口均没有 Node Runtime.evaluate、fresh/full 控制、reset 或重新绑定；同一文档、epoch1、viewport1、input2 保持。随后经真实 Gateway、FrameGate、CanvasKit 验证蓝色 PNG 与按键更新后的绿色 DOM 像素；两会话关闭后 Broker、RPC 及请求/响应所有者全部退出或归零。

这项故障由显式诊断映射和正常回收诱发，不冒充生产工作负载自然淘汰。纯色 DOM 无图片资源、Canvas 每帧新字节的两个早期探针失败均保留。生产代码、额度及二进制未变，211项双平台JS等验收继续归属精确生产版本的重置检查点；B1和其余默认路径合同继续，41项保持8完成/13部分/20待做。


默认 Source 接入及重置控制后的同一冻结版本另通过[旧 RPC 兼容回归](evidence/native-source-legacy-compat-default.json)：三个15MiB协议/header资源的45MiB完整帧及hash-only跟进成功；520个小场景保持512项强缓存。实际Linux Broker经Base64和私有RPA路径共423次拒绝后，资源/chunk/索引/epoch/revision/serial精确不变，旧hash恢复serial2/revision1、新有效帧serial3/revision2。此项沿用既有夹具、原额度与断言，不将协议header资源称作真实图片，也未在本轮冒称重跑Mac。


## B1 默认 Source WebGL 混合页面

[冻结混合页面检查点](evidence/native-source-webgl-default.json)在CPU和强制SwiftShader WebGL2两种真实CanvasKit Worker模式验证默认原生持续路径。源WebGL确实绘制绿色，Viewer将该区域显示为黑框；初始、普通内容更新、重建三个阶段，文字“WebGL 无法显示”与独立系统字体参考的双向字形像素匹配均超过95%（允许1像素边缘差异）。普通DOM与Canvas2D均从初始颜色更新为正确的新像素，WebGL移除后旧区域恢复白底，重新加入后再次显示占位文字。

两种模式各4组检查通过；GPU模式实际为SwiftShader的webgl2-bitmap，5帧GPU提交、0帧CPU及0字节CPU读回统计，不冒充物理GPU。Source无逐帧map/publish/awaitPromise、无捕获错误或哈希恢复，关闭后Broker与请求/响应所有者归零。此项仅更新验收夹具，生产代码、额度与二进制不变；4显示+2实际消费、网络/关闭等完整B1合同仍待验收，41项保持8完成/13部分/20待做。


## B1 默认 Source 四显示与双只读消费

[冻结六客户端检查点](evidence/native-source-six-consumers-default.json)在两个独立会话各通过7组检查：真实Chromium持续采集向4个显示、1个观察、1个录制WebSocket客户端交付PNG/DOM，每个客户端均由独立FrameGate与CanvasKit重放并验证像素。六项编码需求、六个Gateway peer所有者及仅四个控制端正确；第5显示和第3自动消费被403拒绝。观察/录制首帧严格晚于真实原生序号栅栏，人工CDP按键的input2与SourceFrame底线到达全部六端。只读观察者尝试控制时独立1008关闭，人工租约与输入序号保持。

四显示与连续录制跨新文档epoch2及384px/viewport2恢复；两种目标变更均使观察者1012关闭。第二录制者不ACK，按原默认5秒超时1013退出，两次会话中四个显示端各仍推进超过100帧。所有显示退出后录制独立维持采集与时钟，最后一端退出后实际C++信用排空、时钟停止，Gateway peer/route、控制归属及Broker/RPC归零，浏览器退出。另以原协议夹具复验Origin、跨Source、一次性10秒票据过期、角色/能力拒绝及4+2名额，与实际源页面像素证据分开。

最初夹具先换img.src，再await decode后改DOM，不承诺逻辑同帧更新；快速切换出现不一致的失败证据保留。后续改为预解码三图后同步替换，仍严格校验每帧图片/DOM一致；生产代码、限额与二进制未变。六端为验收进程内的真实协议和渲染客户端，不冒充六个完整浏览器；9MiB网络/关闭、故障/Node兼容等完整B1合同仍待验收，41项保持8完成/13部分/20待做。


## B1 默认 Source 与 Node 回退关闭

[冻结关闭检查点](evidence/native-source-close-default.json)保留原12场景：默认原生Rust与显式Node回退各5个Source和1个外层Live故障。原生首帧检查实际资源标量回执，不伪造payloads图；原来逐帧map猴补丁改为一次显式小诊断map，使真实Mapper等待RPA资源、实际C++等待原生信用，再发起关闭并验证二者拒绝/排空。重复关闭、排队resize、capture/control清理故障及Gateway stop失败均保留原断言。

12个已关闭对象继续被调用者持有，迟到帧、错误、reset和导航信号不能恢复latest、缓存、epoch或需求。实际48个浏览器进程的PID+启动身份全部退出，Broker/RPC/输出及原生绑定/重置监听清空；两个外层Viewer HTTP/socket和自有fixture在清理错误后仍结束。此项只改验收夹具，生产代码和二进制未变；不把小图片关闭观测当作9MiB排队网络的200ms关闭合同，也不冒称RSS/PSS/八小时通过。真实渲染崩溃、Node完整像素兼容及网络合同继续，41项仍8完成/13部分/20待做。


## B1 实际渲染器崩溃清理

[冻结崩溃检查点](evidence/native-source-crash-default.json)以真实Page.crash覆盖活动默认原生Source、真实Mapper资源等待/实际C++等待信用，以及活动Node回退。三种场景的浏览器所有者在渲染器崩溃后仍连接；随后发出的实际CDP文本输入在关闭前均挂起，由幂等Live.close释放并拒绝。等待场景只使用一次显式小诊断map，不伪造原生信用；关闭时该请求也被拒绝。

三个关闭Source继续被调用者持有，12个浏览器PID+启动身份全部退出；latest、缓存、需求、控制、原生绑定/重置监听及Broker/RPC归属均清空，Viewer HTTP停止。真实格式的迟到捕获/错误/reset/导航不能恢复状态。首轮Node迟到事件探针遗漏必需元数据的夹具失败已保留并修正，生产代码未改。该证据不替代9MiB排队弱网200ms关闭合同，也不声称像素、完整RSS/PSS或八小时通过；Node完整直播像素兼容与网络合同继续，41项仍8完成/13部分/20待做。


## B1 默认原生与 Node 回退完整直播

[冻结完整直播检查点](evidence/native-source-full-live-default.json)保留原动态夹具全部验收：私有图片与blob图片像素精确，标题/流式文字ink完整且空白替身被拒绝，合成动画不重发绘制资源；人工输入、慢客户端1013隔离、重连、实际导航、三次resize及丢资源后的恰好一次keyframe恢复均通过。默认原生Source按真实producer/frameToken/sourceFrame/captureOrdinal与Viewer对齐，Node提供namespace时仍保留其校验，未为标量回执伪造图数据。

受控Broker reset现按真实撤销/重新绑定验收：新序号范围、完整资源、同一文档epoch与input3保持，不将其记为哈希缺失。真实Mapper cache miss/Retry/自主完整补发在同一冻结版本另行复跑通过，恢复窗口零Node控制调用。原生与Node分别排空至17/17、3/3必需资源；无Viewer时采集归零，Viewer不请求源URL，无iframe及Viewer错误。冻结两路径Source错误均为0；工作版本Node一项原断言允许的导航作废保留在原报告。

默认原生保持零逐帧map/publish/awaitPromise，显式Node回退则继续真实逐帧evaluate/awaitPromise；两种行为分开记录。此项仅更新验收接口与版本输出，不改生产代码、限额或正式二进制；9MiB真实源弱网/资源进度/控制/ACK/200ms关闭及N1仍待验收，41项仍8完成/13部分/20待做。


## B1 默认配置真实大资源本地合同

[冻结大资源检查点](evidence/native-source-bulk-default.json)保持默认tiled配置，以1792²实际Canvas纹理生成两张超过9MiB的真实SKP，经NativeSource/private IPC/Gateway/FrameGate/CanvasKit验证三点实际像素，不再用追加header填充代表大图片。原raw窗口用例保留16MiB字节额度、15秒两次资源等待及1.5秒提交后ACK规则；第二个变化大帧在有序ACK前不能发送，故意不ACK仍1013退出。

独立的原控制用例保留32KiB资源块、默认5秒ACK和800ms读取暂停。原生待发送帧超过9MiB且内核非零TX持续50ms；16次真实配对控制/CDP文本ACK均在3秒内并先于图片完成，时钟推进。恢复读取后大Canvas、input18及输入长度16的标记像素正确；下一真实大帧背压期间第19次输入也通过。关闭时20ms后恢复读取，数据/控制均在原200ms Gateway期限内以1001结束，Peer/route归零；这不等于整个Source/浏览器必须在200ms退出。

最初夹具的512KiB内核TX门槛与生产32KiB发送缓冲矛盾，且控制用例遗漏原asset-chunks能力；两项已按原合同校正，生产缓冲与限额未改，失败证据保留。两会话无Source错误或逐帧map/publish/awaitPromise，关闭后Broker/RPC归零、浏览器退出。本项为本地合同，内核RTT/丢包/抖动/带宽与N1矩阵继续，正式二进制未替换，41项仍8完成/13部分/20待做。


## B1 默认原生输入与恢复的完整弱网矩阵

[冻结网络检查点](evidence/native-source-loss-default.json)固定527个源文件及候选浏览器/Broker，两个独立完整运行各覆盖无劣化基线与20/40/80/150ms RTT×0.5/1/2%丢包，共26,000次真实CDP文本输入，全部得到实际Viewer Worker的CanvasKit像素确认。每个用例都验证合成器动画变化、22次移动拖动终点、300ms内核全丢包后的输入像素、自动完整基线重连及旧人工租约失效。

Gateway双向TCP独占测试过滤器，内部CDP未受劣化；劣化组使用20Mbit和RTT/20抖动，0/0输入基线不加劣化，仅后续全丢包阶段建立自己的网络类。所有24个劣化输入阶段在全丢包之前已有实际netem子队列丢包，范围35–312，不把root与child重复相加。附加ping连接仅用于RTT与ACK，不冒充第二个像素Viewer。

冻结复跑的输入到像素结果如下；每组1000个原始时长、实际RTT、进展间隔、队列峰值、帧合并与内核统计均保留。

| 配置RTT（ms） | 丢包 | p50 / p95 / p99（ms） | 最大输入闭环（ms） | 输入阶段子队列丢包 |
| --- | --- | --- | --- | --- |
| 0 | 0% | 50.5 / 60.4 / 63.4 | 119.8 | 0 |
| 20 | 0.5% | 81.6 / 109.0 / 129.3 | 209.1 | 93 |
| 20 | 1% | 82.1 / 116.3 / 138.7 | 168.7 | 207 |
| 20 | 2% | 85.7 / 128.0 / 171.4 | 297.3 | 312 |
| 40 | 0.5% | 104.2 / 146.8 / 172.1 | 193.1 | 81 |
| 40 | 1% | 107.0 / 165.0 / 210.0 | 280.3 | 135 |
| 40 | 2% | 114.5 / 198.5 / 251.3 | 336.7 | 227 |
| 80 | 0.5% | 195.2 / 303.7 / 348.8 | 401.3 | 51 |
| 80 | 1% | 201.2 / 351.4 / 424.8 | 486.7 | 97 |
| 80 | 2% | 250.4 / 427.4 / 583.5 | 678.2 | 155 |
| 150 | 0.5% | 375.0 / 621.2 / 725.7 | 803.0 | 36 |
| 150 | 1% | 456.1 / 774.4 / 1100.7 | 1337.2 | 66 |
| 150 | 2% | 478.2 / 889.6 / 1123.9 | 1391.0 | 120 |

全部26个Source无采集/Viewer错误，Node的map/publish/awaitPromise均为0；测试浏览器与Broker退出，隔离命名空间恢复无netem。单用例JSON在清理前序列化，最终汇总中的少量peer/evaluate引用继续累计到清理结束，两个边界均保留，不能声称这些计数是同一时刻。延迟、输入、生命周期和网络字段逐项一致。只改验收夹具与证据，生产代码、限额及正式二进制未变；实际9MiB弱网及采集开始帧龄仍继续，不将输入延迟或进展间隔冒充完整帧龄。41项仍8完成/13部分/20待做，八小时未通过。


## B1 默认原生真实大资源的完整弱网矩阵

[冻结大资源网络检查点](evidence/native-source-bulk-network-default.json)固定529个源文件及相同浏览器/Broker候选；实际1792²Canvas纹理生成约11.06MB的原生SKP，保持默认tiled配置，经NativeSource/private IPC/Gateway传入真实Viewer Worker。完整14组包括0/0基线、20/40/80/150ms RTT×0.5/1/2%丢包的20Mbit配置，以及80ms/1%/2Mbit；另有基线、150ms/2%和2Mbit三个独立试跑，共17个Source及272次真实输入。

每组都有实际超过9MiB的原生资源回执、Gateway待发送帧和持续50ms的正内核TCP TX队列；16次配对控制连接的实际CDP文本输入各在3秒内确认，至少一次确认先于大图提交，最终三处纹理像素、input16水位与计数像素均正确。无自动重连掩盖传输失败；源时钟继续，Viewer不请求源图片URL。所有有丢包配置都在netem子队列观察到真实丢包，另保存内核TCP RTT估计，不把配置RTT直接当作实测。

冻结完整矩阵结果如下。0/0大资源基线仍受20Mbit限速，与上一输入矩阵的不加劣化基线分别说明。

| 配置RTT（ms） | 丢包 | 限速（Mbit/s） | 至最终图像与输入像素（s） | 最慢输入确认（ms） | netem子队列丢包 |
| --- | --- | --- | --- | --- | --- |
| 0 | 0% | 20 | 5.58 | 55.8 | 0 |
| 20 | 0.5% | 20 | 8.21 | 291.3 | 6 |
| 20 | 1% | 20 | 9.07 | 54.9 | 5 |
| 20 | 2% | 20 | 8.15 | 263.2 | 10 |
| 40 | 0.5% | 20 | 10.76 | 87.0 | 2 |
| 40 | 1% | 20 | 11.19 | 68.1 | 9 |
| 40 | 2% | 20 | 11.12 | 297.0 | 17 |
| 80 | 0.5% | 20 | 17.69 | 110.0 | 2 |
| 80 | 1% | 20 | 18.22 | 375.2 | 12 |
| 80 | 2% | 20 | 19.14 | 369.4 | 18 |
| 150 | 0.5% | 20 | 29.68 | 172.1 | 4 |
| 150 | 1% | 20 | 29.62 | 181.8 | 7 |
| 150 | 2% | 20 | 31.24 | 185.9 | 21 |
| 80 | 1% | 2 | 54.45 | 510.3 | 7 |

生产32KiB分块、16MiB/6帧额度、默认提交后5秒ACK和15秒资源无进展期限均未修改；完整弱网资源用例使用原有90秒总等待，不能将15秒无进展误写成15秒必须传完。原raw本地窗口的1.5秒ACK与独立本地200ms干净Gateway关闭合同继续保留；本弱网测试清理前移除劣化，不声称远端弱网关闭仍在200ms内完成。

全部17个Source无错误，map/publish/awaitPromise均为0，关闭后Broker/RPC所有者归零、浏览器退出，测试命名空间恢复无netem。此项只新增验收夹具和证据；正式二进制未替换。采集开始至真实像素的校准帧龄、完整丢弃指标和长时压力继续，B1/N1未完成，41项仍8完成/13部分/20待做，八小时无通过。


## B1 原生采集开始时间与时钟来源

[冻结原生时钟检查点](evidence/native-source-clock-default.json)在固定四槽订阅任务中携带Take时的单调微秒时间；晚到输入、重试、取消和新绑定不能改写已有任务的开始时间。RPA2与公开帧的native.timing新增captureStartedMicros和captureClock=chromium-time-ticks-v1；56字节credit及既有身份校验未变。私有scheduler同时返回nowMicros、clock和rendererProcessId，用于有请求/响应边界的时钟校准，不直接混减不同进程的时钟原点。

新的Linux候选浏览器c5d29a3b在两个独立Source会话各通过7组实际时钟、输入、像素、暂停恢复、resize、跨站导航和重置检查；每个会话的3次公开帧时间与私有lastStartedMicros按同一ordinal精确相等。跨站导航实际更换rendererPID，探针对应新producer。每个会话保留五组各12次请求/响应样本、最小往返及偏移区间，但这些样本只证明校准接口来源，尚不是完整帧龄。

76项实际Linux C++测试全部通过，新增3项覆盖时间归属、拒绝/重试/退休边界及56字节回执兼容。同一冻结浏览器、未变Broker和JS还通过18个顺序复验步骤：原生调度/忙碌credit、默认Source控制及24次跨站导航、重置和实际哈希缺失恢复、原生与Node回退完整直播、CPU/SwiftShader的WebGL黑框文字、4显示+2只读消费、64MiB压力下14个变化像素、本地真实大资源原raw及分块控制/200msGateway关闭、12组关闭与3次真实Page.crash，以及完整14组真实大资源内核弱网。12+3组关闭/崩溃验证的60个浏览器PID+启动身份全部退出；不将整个Source关闭时间冒充Gateway的200ms合同。

本候选14组弱网仍逐组验证约11.06MB原生资源、实际Viewer Worker三点纹理与输入16像素、3秒内控制确认、默认5秒ACK/15秒无进展/32KiB分块和90秒完整弱网传输，全部Source错误为0。前一节26,000次输入矩阵仍属于其明确记录的14b旧候选；不冒称已在c5d重跑。既有双平台211项JS与156项Rust按未变源码/产物引用，本次未重跑或声称新的Mac浏览器验收。

默认原生路径的Node控制面仍无逐帧map/publish/awaitPromise；显式探针与控制evaluate单列，旧Node回退没有伪造原生Take时间。正式浏览器/Broker、既有live/peer.mjs修改和构建缓存均保留。接下来需在实际Worker完成同一帧的像素读取、记录观察成本与全部提交覆盖，再校准Node/生产者/Worker时钟并报告偏移误差及观测漂移，分别统计采集开始到像素p50/p95/p99/最大值、输入闭环、合并和真实丢弃原因；物理屏幕扫描仍另列。B1/N1、完整物理内存和八小时未完成，41项仍8完成/13部分/20待做。


## N1 同帧像素与有界时钟校准观察器

[冻结观察器检查点](evidence/native-source-frame-age-observer-default.json)固定535个源文件及c5d浏览器，新增测试夹具在实际CPU2D Worker完成gate.commitAsync与同一帧绘制后同步读像素，再继续原有资源保留、frame通知及ACK。Worker计数、像素样本和主线程正常frame事件逐一匹配身份；从启用到停用的全部成功提交都必须覆盖，缺帧、越界时间、错误PID/时钟域和不可能的负帧龄直接失败。

两个独立运行分别覆盖不加劣化基线和150ms RTT/2%丢包，每配置1000次真实CDP文本输入，并保留动画、22次移动拖动、300ms内核全丢包、输入1001像素、完整基线重连和旧租约撤销。共4000次输入完成，3166个成功提交帧全部配对，覆盖率100%；每次均观察到新连接的配对像素，输入计数不回退，动画像素确实变化。附加ACK/ping连接仅为RTT探针，不计作第二个像素Viewer。

每个测量窗口前后各取原生与Worker时钟各12次请求/响应样本，以最小往返区间保留非对称时延的不确定性，校验原生TimeTicks域、rendererPID与公开producer，显式假设两次探针之间时钟按仿射漂移。另按当前Chromium的100微秒粗分辨率及now/origin两次取整，保守计入每个Worker时间戳200微秒和原生整数时间戳1微秒，在探针和被测端点均扩张区间。报告观测漂移与区间，未证明探针之间任意非线性漂移。7项实际Linux时钟数学测试覆盖不同原点、漂移、非对称时延、取整、区间外时间、PID/时钟域变化、不可能的负值和长时钟原点。

| 运行 | RTT（ms）/丢包 | 配对帧 | 采集至像素p50 / p95 / p99（ms） | 最大估计（ms） | 最大区间上界（ms） | 输入闭环p95（ms） |
| --- | --- | --- | --- | --- | --- | --- |
| 试跑 | 0 / 0% | 1093 | 8.06 / 10.98 / 42.00 | 423.52 | 424.52 | 58.8 |
| 试跑 | 150 / 2% | 495 | 209.92 / 464.63 / 698.65 | 985.18 | 986.10 | 921.9 |
| 冻结 | 0 / 0% | 1089 | 8.06 / 11.57 / 38.80 | 619.72 | 620.67 | 59.3 |
| 冻结 | 150 / 2% | 489 | 230.85 / 425.49 / 601.96 | 726.85 | 727.93 | 698.9 |

帧龄端点为实际CPU OffscreenCanvas像素读取，包含当前观察负载，未代表物理屏幕扫描或GPU呈现。输入与帧龄使用不同样本集合，各自列出分位数；最大值还包含短时全丢包和重连阶段。同步像素读取的计时读数p95约0.1ms，另列0.4ms保守取整余量；序列化、postMessage、主线程监听与探针的整体影响尚未分离，不据此承诺未插桩性能改善。

最初的浏览器请求拦截夹具在启动阶段失败，原样脚本对照也出现1006且无Source帧；普通加载与仅监听Worker事件均正常，失败代码、报告和对照保留。改用现有makeStaticAssets/preparedAssets路径生成测试包：复制的原始资源表必须先复现生产build指纹，再加入观察器并生成自己的版本；实际下载脚本SHA与登记字节相等。生产Viewer/Worker、Origin/授权与协议门槛未修改。所有Source错误为0，map/publish/awaitPromise为0；内核包丢失、Gateway快照合并及原生拒绝原因分开记录，未从ordinal空缺臆造丢弃原因。

此处仅验收观察器和两个配置，完整13组、真实9MiB帧龄及完整N1仍继续。正式二进制未替换，41项仍8完成/13部分/20待做，完整物理内存和八小时未通过。


## N1 同一冻结版本的两轮完整帧龄矩阵

[完整帧龄检查点](evidence/native-source-frame-age-matrix-default.json)在完全相同535个冻结文件、c5d浏览器和ed9d Broker上运行两轮独立矩阵。每轮覆盖不加劣化基线及20/40/80/150ms配置RTT×0.5/1/2%丢包，共26组、26000次合成beforeinput，Source计数/协议水位与实际像素全部确认；可合并中间显示状态。23238个启用窗口内成功Worker提交全部与同一原生Take、实际CPU OffscreenCanvas像素及正常frame事件配对，无样本静默排除，覆盖率100%。

每组仍通过实际合成器动画像素、22次移动拖动终点、300ms内核全丢包后的输入1001像素、自动完整基线重连和旧人工租约失效，帧龄覆盖包含新连接。所有Source错误为0，Node的map/publish/awaitPromise为0。Gateway双向TCP使用20Mbit和RTT/20抖动，内部CDP未受劣化；基线输入不加劣化，其后全丢包阶段单独建类。24个劣化输入阶段在全丢包前都已有真实netem子队列丢包，范围38–308，root与child不重复计数。每组补充ACK/ping连接10次实测RTT，并分别保存源计数、原生拒绝、Gateway合并及队列字节峰值。

下表各单元按第一轮/第二轮列示。每组1000次输入，最大帧龄包含短时全丢包和重连。配置RTT与补充ping连接实测值分别保存，未将配置值当作物理公网测量。

| 配置RTT（ms）/丢包 | 帧龄p95（ms） | 帧龄p99（ms） | 最大帧龄区间上界（ms） | 输入闭环p95（ms） | 配对帧 |
| --- | --- | --- | --- | --- | --- |
| 0 / 0% | 10.6 / 11.1 | 35.2 / 33.3 | 614.2 / 677.4 | 59.7 / 60.2 | 1087 / 1076 |
| 20 / 0.5% | 50.3 / 48.6 | 78.6 / 69.6 | 457.4 / 437.5 | 111.9 / 110.3 | 1071 / 1112 |
| 20 / 1% | 50.9 / 55.8 | 68.9 / 82.5 | 399.2 / 398.9 | 113.3 / 113.1 | 1091 / 1098 |
| 20 / 2% | 66.7 / 62.3 | 98.5 / 89.6 | 786.8 / 422.0 | 131.0 / 127.5 | 1080 / 1098 |
| 40 / 0.5% | 80.5 / 84.1 | 101.5 / 109.9 | 459.4 / 472.1 | 148.5 / 144.9 | 1081 / 1099 |
| 40 / 1% | 99.7 / 101.9 | 144.1 / 154.3 | 472.8 / 362.6 | 174.0 / 173.2 | 1074 / 1064 |
| 40 / 2% | 106.1 / 118.1 | 150.5 / 178.2 | 459.4 / 458.9 | 189.4 / 189.4 | 1069 / 1073 |
| 80 / 0.5% | 161.7 / 181.3 | 213.2 / 239.9 | 695.0 / 680.1 | 278.5 / 316.5 | 859 / 826 |
| 80 / 1% | 191.8 / 201.4 | 275.5 / 466.2 | 701.2 / 615.9 | 339.7 / 378.4 | 828 / 784 |
| 80 / 2% | 216.9 / 235.0 | 325.6 / 468.4 | 1116.7 / 1140.5 | 388.5 / 414.1 | 811 / 774 |
| 150 / 0.5% | 343.5 / 327.3 | 387.8 / 379.0 | 894.9 / 741.7 | 616.8 / 575.1 | 543 / 558 |
| 150 / 1% | 364.1 / 324.9 | 704.9 / 403.1 | 888.5 / 598.6 | 697.0 / 577.7 | 520 / 573 |
| 150 / 2% | 426.9 / 380.1 | 693.9 / 716.8 | 848.5 / 878.6 | 782.6 / 731.5 | 490 / 499 |

时钟沿用已验收的7项数学测试和同一观察器：窗口前后每域12次请求/响应区间、最小往返、PID/时钟域/时间范围校验、仿射漂移假设及时间戳取整余量均保留。26组的最大校准半区间约1.097ms；这仍以探针间仿射漂移为条件。像素读数及0.4ms保守取整余量单列，整体序列化、postMessage、监听和探针影响尚未分离，未承诺未插桩性能改善。

已观察的同连接frameId没有缺口；连接边界的未完成帧及未观察到的Viewer恢复原因仍不据此推定。此项只更新验收证据，生产代码、浏览器与Broker均未改，正式产物未替换。下一步继续真实9MiB资源的同帧帧龄及完整丢弃指标/长时压力；N1、完整B1和八小时尚未完成，41项仍8完成/13部分/20待做。


## N1 真实大资源的同帧依赖与帧龄

[冻结大资源帧龄检查点](evidence/native-source-bulk-frame-age-default.json)固定538个源文件及相同c5d浏览器、ed9d Broker。在测试观察器中新增当前帧依赖的数量、字节总和与最大单项三个标量，读取实际FrameGate资源视图；按byteLength计入真实视图，忽略无关缓存和后备buffer。遵守既有每帧256个依赖限制，跨帧窗口512项不变。新增三项计数/拒绝测试，与原七项时钟测试合计10项实际Linux测试通过。

原1792²Canvas噪声纹理通过真实NativeSource/private IPC/Gateway/Worker，所有被计入大资源子集的帧都实际依赖单项超过9MiB的SKP，同时三处纹理为绿色；最终输入16协议水位与计数像素也在同一测量帧中。整个启用窗口内的成功提交全部配对，热身与大资源子集分别说明，未用整个缓存大小冒充单帧依赖。14组完整矩阵加基线/150ms2%/2Mbit三个独立试跑，共17个Source会话、272次实际CDP文本输入、40个提交帧全部配对；本次40个都属于真实大资源子集。

各组保留原始默认tiled配置、32KiB分块、16MiB/6帧额度、提交后5秒ACK、15秒资源无进展及90秒完整弱网传输限制，16次输入确认各在3秒内，至少一次先于大图提交。真实待发送帧超过9MiB、内核正TX队列持续50ms，所有有丢包配置均观察到netem子队列丢包；未靠自动重连通过。Source值为x16，Viewer实际纹理与输入像素正确，无源图片重取。

下表为冻结完整矩阵；每个配置仅有少量实际大资源提交，因此同时列出数量和最大值，不从这些小样本承诺p95/p99 SLA。0/0组仍受20Mbit限速，与小资源输入矩阵的不加劣化基线分别说明。

| 配置RTT（ms）/丢包 | 限速（Mbit/s） | 实际大资源帧 | 最大单项依赖（B） | 最大帧龄估计（s） | 最大帧龄区间上界（s） | 最慢输入确认（ms） |
| --- | --- | --- | --- | --- | --- | --- |
| 0 / 0% | 20 | 3 | 11053857 | 5.466 | 5.466 | 56.2 |
| 20 / 0.5% | 20 | 2 | 11053857 | 7.436 | 7.437 | 42.0 |
| 20 / 1% | 20 | 3 | 11053857 | 8.100 | 8.101 | 48.3 |
| 20 / 2% | 20 | 3 | 11053857 | 8.273 | 8.274 | 285.0 |
| 40 / 0.5% | 20 | 3 | 11053857 | 10.314 | 10.315 | 58.9 |
| 40 / 1% | 20 | 2 | 11053857 | 10.613 | 10.614 | 66.3 |
| 40 / 2% | 20 | 2 | 11053857 | 10.594 | 10.595 | 61.1 |
| 80 / 0.5% | 20 | 2 | 11053857 | 17.291 | 17.292 | 111.7 |
| 80 / 1% | 20 | 2 | 11053857 | 17.811 | 17.812 | 356.2 |
| 80 / 2% | 20 | 3 | 11053857 | 18.173 | 18.174 | 108.7 |
| 150 / 0.5% | 20 | 2 | 11053857 | 29.971 | 29.972 | 172.5 |
| 150 / 1% | 20 | 2 | 11053857 | 29.932 | 29.933 | 173.2 |
| 150 / 2% | 20 | 2 | 11053857 | 31.107 | 31.108 | 172.1 |
| 80 / 1% | 2 | 2 | 11053857 | 53.792 | 53.793 | 419.6 |

大图帧龄包括源录制/编码和真实资源传输等待；没有将起点替换为发布、输入确认或传输完成。时间属于根帧Take，静态复用资源的最后内容变化时间另有含义。端点仍为实际CPU OffscreenCanvas像素读取；Node/原生/Worker的前后校准、仿射漂移假设、取整余量和区间全部保留，未测物理显示扫描或GPU。像素读取耗时单列，资源计数、序列化、postMessage、监听与探针的整体开销尚未分离。

生产Viewer/Worker与静态资源生成器不变，测试包仍走正常preparedAssets和版本协商；基线build等价与实际脚本SHA均验证。全部17个Source错误为0，map/publish/awaitPromise为0；关闭后Broker退出、RPC所有者归零、浏览器断开。独立完整14组复跑及完整丢弃指标/长时N1继续。之前26000次输入/23238帧仍精确归属旧535文件观察器版本，本次只增加有界资源标量；正式产物未替换，41项仍8完成/13部分/20待做，八小时未通过。


## N1 真实大资源的千次输入暴露

旧16次输入版本的独立完整复跑在40 ms RTT、0.5%组因实际内核丢包数为0而停止；该组图像、输入和帧龄检查通过，但丢包条件未满足，未计作丢包验收。原始失败报告及SHA保留在[新证据](evidence/native-source-bulk-exposure-default.json)的priorInconclusive字段，先前已通过的14组与3组试跑继续保留原版本归属。

扩展版只修改测试：按25 ms间隔向真实ViewerInput投递1000次beforeinput，经既有有界有序流水线执行CDP输入；每次ACK均从该次投递起严格少于3秒，前16次另列并要求至少一次确认早于大图提交。实际Source最终为1000个x，16位RG计数像素为[3,232,42,255]，与最终输入水位、三个绿色纹理像素和单项实际所需资源不少于9MiB属于同一Worker提交。测试ACK记录上限2048，生产输入窗口与队列未变。

同一538文件冻结版、c5d浏览器和ed9d Broker已通过2轮完整14组，共28,000次输入和631个同帧配对的大资源提交；另有独立3组试跑3000次输入、44个提交。全部成功提交均覆盖，采集与Viewer错误为0，Node map/publish/awaitPromise为0，关闭后Broker/RPC所有者归零、浏览器退出。两轮分别保存原始用例、网络统计、全部像素和校准数据。

下表只列完整矩阵，斜线前后为两轮独立结果；ACK为输入注入确认，耗时从真实大资源绘制开始至最终1000输入像素，帧龄端点为实际CPU Worker像素读取。

| 配置 RTT / 丢包 | Mbit/s | ACK最大 ms | 整段耗时 s | 大资源帧龄最大 s | 配对帧 | 实际内核丢包 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 / 0% | 20 | 58.2 / 57.0 | 27.726 / 27.786 | 5.551 / 5.505 | 41 / 41 | 0 / 0 |
| 20 / 0.5% | 20 | 78.9 / 127.4 | 27.587 / 27.919 | 7.392 / 7.693 | 36 / 37 | 14 / 19 |
| 20 / 1% | 20 | 103.7 / 107.4 | 27.534 / 27.782 | 7.683 / 7.727 | 37 / 37 | 37 / 36 |
| 20 / 2% | 20 | 252.7 / 123.6 | 27.851 / 27.856 | 7.994 / 8.064 | 36 / 36 | 68 / 78 |
| 40 / 0.5% | 20 | 133.1 / 135.2 | 27.851 / 27.815 | 10.484 / 10.712 | 32 / 32 | 15 / 18 |
| 40 / 1% | 20 | 182.3 / 134.6 | 27.611 / 27.771 | 10.551 / 10.533 | 32 / 32 | 32 / 25 |
| 40 / 2% | 20 | 205.5 / 380.9 | 27.612 / 27.606 | 10.780 / 10.900 | 32 / 32 | 54 / 66 |
| 80 / 0.5% | 20 | 208.9 / 223.8 | 27.822 / 27.757 | 17.498 / 17.184 | 20 / 21 | 19 / 16 |
| 80 / 1% | 20 | 220.9 / 499.9 | 28.289 / 27.952 | 17.488 / 17.502 | 21 / 20 | 22 / 28 |
| 80 / 2% | 20 | 377.3 / 422.8 | 27.855 / 28.352 | 18.678 / 18.093 | 18 / 20 | 80 / 59 |
| 150 / 0.5% | 20 | 350.0 / 363.9 | 29.991 / 29.738 | 29.858 / 29.636 | 2 / 2 | 17 / 13 |
| 150 / 1% | 20 | 427.9 / 425.0 | 30.345 / 30.490 | 30.238 / 30.364 | 3 / 2 | 31 / 25 |
| 150 / 2% | 20 | 567.6 / 537.0 | 32.391 / 31.715 | 32.280 / 31.591 | 2 / 2 | 57 / 67 |
| 80 / 1% | 2 | 988.5 / 1229.7 | 55.337 / 54.992 | 55.222 / 54.873 | 3 / 2 | 39 / 27 |

所有丢包配置组均有实际netem子队列丢包；未改变概率、MTU、offload或发送缓冲。默认5秒提交后ACK、15秒资源进度不活动期限、32KiB块、16MiB/6帧credit与90秒整段期限全部保留。本地原始ACK1.5秒和干净Gateway关闭200ms继续属于独立合同。

每帧校准区间、量化允许量、仿射时钟漂移假设及像素读取成本继续单列。此处不测物理扫描、不冒充物理键盘或无观察器性能；大资源可为缓存依赖，root Take不表示每项缓存资源最近改变时间。输入负载与旧16次版本不同，不作性能改善A/B。完整丢弃原因、长时N1、正式产物替换与完整B1继续；41项保持8完成/13部分/20待做，八小时无通过。


## N1 实际 Worker 恢复原因观察

[恢复观察器证据](evidence/native-source-recovery-observer-default.json)来自539文件冻结版和实际c5d/ed9d候选。两个独立运行各有两个Source，共12个观察窗口、16个实际Worker同帧配对提交；10项时钟/资源数学Linux单测通过。

测试专用诊断模块分别修改一个实际传入增量的baseFrameId，以及略过一个实际新ResourceManifest，触发生产FrameGate的Missing delta base与所需资源缺失两条恢复路径。共8次明确诊断故障、8次真实WebSocket排入的RequestKeyframe及新完整基线/输入像素恢复；另观察4次等待恢复时跳过的FrameCommit。恢复尝试、请求决定、实际发送分别计数，与内核丢包的单位不同。普通被动观察模块不包含故障入口或传入内容修改。

四个Source均额外通过实际服务端1012断开、自动重连、新完整基线和人工租约撤销；记录Socket代数、关闭码和窗口归属。所有成功提交均有真实CPU Worker像素与原生Take配对，Source错误及Node map/publish/awaitPromise为0，最终Broker/RPC所有者归零、浏览器退出。故障为明确诊断注入，不能当作自然网络丢失。

有界原生拒绝观察器保留实际code、outcome、capture identity/ordinal及是否匹配当前绑定；Source和异步PeerStats使用各自Node采样边界，不作原子端到端丢帧账本。原生Retry正例集成及被动完整网络矩阵继续。先前538文件两轮大资源675帧、535文件两轮小资源23238帧保持原版本归属；正式产物不替换，完整N1/B1和八小时未完成，41项仍8完成/13部分/20待做。


## N1 分层丢弃与恢复指标的完整矩阵

[统计证据](evidence/native-source-loss-metrics-default.json)固定539文件版本、c5d浏览器与ed9d Broker。完整小资源13组和真实单项9MiB大资源14组通过，共27,000次常规文本输入，另有13次300ms全丢包期间的文本输入；小资源11,565次、大资源314次成功Worker提交全部完成同帧像素与原生Take配对。小资源逐组保留动画、22次拖动、断线恢复和租约撤销；大资源逐组保留每次ACK少于3秒、最终1000输入像素与9MiB依赖同帧、内核TX持续50ms、原5秒ACK/15秒资源进度不活动/32KiB块/16MiB六帧/90秒整段期限。

Source发布/被覆盖/资源Retry、Broker实际NativeFrameRejected的code/outcome/capture identity和解析出的ordinal、每个Gateway消费者的latest序号合并、Worker恢复尝试/实际WebSocket排入的重同步请求/等待恢复时略过的commit，以及内核丢包，均分别记录。拒绝事件保留是否匹配当时活动绑定。Source与异步PeerStats在输入前、输入结束或大图完成、后校准结束分别保留Node时间见证；Worker使用自己的窗口与事件序号，不把这些不同采样边界拼成原子端到端丢帧账本，也不凭ordinal缺口猜测原因。

这27组自然TCP劣化用例中，原生拒绝0次，Worker资源恢复尝试0次、实际重同步请求0次、等待恢复时略过commit 0次；输入阶段内核共记录1967个包丢失。小资源内核数在全丢包注入前保存，大资源数在最终像素完成时保存，后续生命周期计数另留原始字段。零恢复不表示所有传输或快照均未被丢弃。

同一未变helper先前的4个Source已通过8次明确Worker诊断故障及真实RequestKeyframe/完整基线/像素恢复，另有4次服务端1012重连；本次再以两个独立Source的实际原生缓存缺失验证NativeFrameRejected正例，各观察一次retry、同绑定完整702字节资源补发、输入2与实际图像/DOM像素恢复。原生故障仍由五次明确诊断map诱发，Node仅有这五次诊断map，自动恢复的Node控制evaluate为0。正例与自然网络矩阵分别保存。被动模块的实际模板SHA、正常静态构建指纹与实际HTTP响应SHA均校验，并验证其中不含诊断故障入口或内容修改。

27个网络Source无采集或Viewer错误，正常路径Node map/publish/awaitPromise均为0；每组关闭后Broker退出、RPC所有者归零、浏览器断开，测试命名空间恢复无netem。生产代码、正式二进制、额度和旧失败证据均保留。此处只完成列明负载的分层统计与正确性验收；CPU像素端点、仿射时钟漂移与量化假设、完整观察成本未分离等限制保留，不宣称物理扫描、无观察器性能或完整长期N1。B1正式产物审计/替换、完整Session/PSS及八小时继续，41项保持8完成/13部分/20待做。


## B1 正式 Linux ARM64 受管 Source 验收

[正式验收](evidence/native-source-default-acceptance.json)确认当前134个生产文件与已测c5d版本一致，27个C++源文件和27个Rust源文件匹配构建收据，14个补丁的哈希与已打补丁Chromium源码一致。补跑当前版本57,802,256字节/四真实SKP/四像素/零哈希恢复、2MiB输入拒绝后真实小图恢复、三项15MiB旧RPC资源及423次精确事务回滚，四项全部通过。

Linux正式headless_shell及兼容别名均更新为c5d，Linux Broker更新为ed9d、Mac Broker为6b7；旧二进制与收据完整保存，按文件原子替换。新的独立容器从正式项目和浏览器目录直接只读挂载，实测76项C++、实际Source时钟/像素/输入/暂停/导航/resize/重置、完整原生直播、显式Node回退直播、WebGL黑框“WebGL 无法显示”文字与其余DOM/Canvas更新、真实9MiB本地窗口/1.5秒ACK/16次实际输入及200ms干净Gateway关闭、12个保留关闭Source和48个浏览器进程启动身份退出。两平台各221项JS全过；正式Mac Broker另通过4组真实进程/私有IPC/Mapper/Gateway/CanvasKit协议检查，其输入为明确协议夹具，不作为Mac Source浏览器验收。

最初本地大资源步骤遗漏隔离容器标记，在用例开始前停止；Linux两个GC/流清理单测因只读项目中写报告而遇到EROFS。两份失败日志保留；补齐环境与可写报告目录后沿用相同正式源码、用例与期限，后续正式检查全部通过，未重复已通过的业务步骤。源码仍只读，生成报告未覆盖旧项目报告。

Node仍负责Linux BeginFrame页面时钟、启停/策略与真实CDP输入；被替换的是逐帧捕获登记、映射/发布与捕获Runtime.awaitPromise，并非取消所有CDP。实际document token、原生frame token、epoch/viewport/输入水位和资源回执保持跨连接屏障。64MiB压力、六消费、实际原生Retry、崩溃和轻微丢包/帧龄/分层统计证据按已验证的相同生产源码与产物哈希复用，不冒称本次全部重跑。

B1在列明的Linux ARM64受管Source范围完成。当前原生构建仍保留专用Ninja目标来源，canonicalGraphAccepted与incrementalGraphUpToDate为false；标准构建图、双架构安装包、CI、SBOM及签名继续属于B16，未用运行验收代替发布验收。其他Source平台和物理GPU/系统IME等兼容条件、完整SDK/授权/部署、Session/PSS及独立八小时继续。41项现为9完成/12部分/20待做；N1长期和八小时没有通过。


## Mac 进程内存持久采样器

[采样器证据](evidence/client-memory-native-sampler.json)记录测试专用Darwin libproc观察器的7项实际检查：同一受管子进程连续读取、真实64MiB脏页分配、目标退出、启动身份不符、并发/协议/整数/输出边界，以及2秒无响应后SIGKILL与回收。原2秒请求、250ms回收、5秒阶段、64KiB输出和1024进程上限保留；没有自动重启、旧值回填或ps回退。实际分配的RSS增长67,731,456字节、physical footprint增长67,485,840字节；释放引用后仍保留分配器驻留的真实读数，不承诺RSS立即回落。

RSS、虚拟地址空间与physical footprint分别报告，physical footprint不是Linux PSS，各进程RSS相加也不是独占Session内存。PID/启动秒与微秒/UID/父进程在每次系统读取前后核对；源码、实际二进制与构建收据校验。观察器尚未接入三Viewer长测，此处不表示旧ps超时的内核根因已确认或八小时通过。正式B1浏览器/Broker和生产源码未改变；41项仍9完成/12部分/20待做。


## 持久采样器的三种真实 Mac Viewer 集成

[集成证据](evidence/client-memory-native-sampler-integration.json)固定556文件版本、正式B1 Linux ARM64浏览器/Broker及Apple M2 Max Metal设备，完成601.09秒实际工作负载：655次真实PNG/字体更新、6次导航、59次resize、40次输入及像素核对，累计图像147,255,157字节。硬件GPU Worker、CPU Worker与CPU主线程三种实际模式均核对；GPU呈现没有CPU读回。Wasm、JS与渲染逻辑额度仍按原规则检查，JS VM页/Worker堆、Skia缓存和系统进程指标分别保留。

11次进程采样由同一个受管libproc helper完成，实际原生请求中位0.472ms、最大1.029ms，包含报告写入的整个原生阶段最大1.520ms；采样覆盖间隔最大62.124秒，原2秒请求、250ms回收、5秒阶段和90秒覆盖门槛未放宽，也没有ps回退、自动重启或旧值替代。记录的每个Chrome进程有PID启动身份，离线核对均能沿父关系到达本次浏览器；这些时间见证不是原子进程组快照。RSS、虚拟空间、physical footprint与Linux PSS保持各自含义，不把进程RSS合计解释为独占内存。

本轮helper通过EOF退出并被回收，Viewer关闭；实际Linux Source、Broker和夹具服务关闭，两端驱动退出0。独立负例仅明确破坏helper构建收据的SHA，工厂在helper/Viewer启动前拒绝，随后同样完成Source/Broker/夹具清理；失败日志与预期Viewer退出1保留。Mac全部228项JS测试通过，Linux224项通过、4项Mac专用检查按平台跳过。macOS本机可用`node native/build-process-memory.mjs`重建测试观察器，再运行`node --test tests/process-native-memory.test.mjs`。

此处验证采样基础设施与列明10分钟负载，不表示无观察器性能改善、完整Session内存回落或八小时通过。Linux PSS的缺失字段、进程身份与进程组变化处理，以及创建销毁Session/跨站/长期增长仍需单独补强；当前Source长期用例仅为单个Source及同源导航。正式B1生产源码和产物哈希未变，旧失败与缓存均保留，没有提交或推送；41项保持9完成/12部分/20待做。


## Linux PSS 采集层的身份与缺失值合同

[独立采集层证据](evidence/linux-process-memory-observer.json)记录9项实际Linux/边界检查全部通过；Mac三个纯解析检查通过，六个Linux专用检查按平台跳过。读取通过已打开的/proc目录FD进行，每个进程前后核对PID、启动ticks、父进程与四个UID；目标退出后旧FD读取失败，不以已复用PID或旧行替代。两次观测到的后代身份列表匹配才标为observed-stable，发生变化最多重新执行一轮完整采样。每个采样阶段仍严格5秒，进程1024、单进程task4096、单文件64KiB、诊断详情32条有界。实际主机SIGSTOP约5.5秒后恢复，返回LINUX_MEMORY_TIMEOUT，拒绝迟到成功。

真实64MiB脏页分配使RSS/PSS/Private_Dirty分别增长67588096/67543040/67457024字节。实际同UID、不可dump进程的smaps_rollup被内核拒绝，返回EACCES、bytes:null与completeObservedCohort:false；availableBytes明确仅为可读部分，不冒充完整总量。缺字段、权限、进程身份变化或进程组不稳定均不能变成补零的PSS。父子进程实测覆盖、子进程回收后的新采样、根启动身份不符、单次在途及重复FD回收均已核对。

此处只完成新采集模块的独立合同，尚未接入runtimeMetrics和长测门禁。运行中的children枚举本身可能漏掉正在退出的进程，匹配的时间见证不等于冻结或原子快照；PSS为比例分摊，也不等于独占Session内存。完整Session创建销毁/跨站/长期增长、N1长期和八小时继续；41项仍9完成/12部分/20待做，没有提交或推送。


## Linux PSS、cgroup 与实际长测门禁接入

[运行集成证据](evidence/linux-memory-runtime-integration.json)将新采集层接入runtimeMetrics和Source诊断。PSS仅在观测到的后代身份列表稳定、全部所需rollup字段可读时给出完整总量；否则bytes:null，单独保留可读部分、不可读原因及覆盖数。实际cgroup由/proc/self/cgroup与mountinfo解析，打开所属目录FD，再核对前后进程归属；memory.current、memory.stat中的anon/file及OOM事件与PSS分开。挂载位置或归属不能确认时不回退到根目录假定值。cgroup包含内核、文件缓存及其他成员，PSS与cgroup都不被解释为独占Session内存；CDP进程角色另记较晚的时间见证，不冒称与启动身份原子配对。

新cgroup五项边界/实际检查通过。三组实际正式B1 Linux Source分别正常关闭、真实Page.crash renderer崩溃、明确注入清理错误；每组启动时观测八个进程，全部启动身份最终退出。死页面后PSS仍可独立读取，最终观测仅余控制Node；故障清理继续关闭Broker、夹具和诊断，明确清理错误按预期返回1而非伪造成功。完整Linux242项测试中238通过、四项Mac专用检查跳过。

新的三Viewer门禁要求真实硬件GPU Worker、CPU Worker、CPU主线程模式及完整观测PSS/已确认cgroup归属，原有Wasm/JS/render预算、2秒Mac原生请求、5秒阶段、90秒覆盖与真实像素工作负载不变。实际Apple M2 Max与正式B1 Source完成181.947秒、460次PNG/字体更新、一次导航、41次resize、28次输入，图像累计103,482,128字节；四次采样均完整，覆盖间隔最大62.154秒，Linux进程采集43.122至55.071ms，cgroup阶段最大1.849ms。Source cgroup在此隔离容器中另含init PID1，已如实列明；最终Viewer/helper/Source/Broker/夹具关闭，两端退出0。此前601秒结果保留原版本，本次不与其相加。

Mac首次全量运行有一项NATIVE_MEMORY_READY_TIMEOUT：实际helper未在原2秒内就绪，SIGKILL后已回收，233项通过、八项Linux专用检查跳过，失败日志完整保留。签名校验正常、无扩展属性；后续20个新可执行路径副本的实际采样/清理均通过，最慢就绪844.107ms，但操作系统缓存未清除，未复现原条件，根因未确认，也不宣称修复。未修改源码、产物或期限的独立全量重跑234项通过、八项平台跳过；这不抹去首次失败，更不是采样器自动重试或对旧值放行。

此处完成列明的PSS/cgroup基础设施和短负载门禁，捕获、映射、传输及正式Chromium/Broker未改。完整Session创建销毁/跨站/物理内存增长、N1长期和独立八小时继续；当前没有八小时进程，也没有八小时通过。41项仍9完成/12部分/20待做，无关修改、旧失败与缓存保留，没有提交或推送。


## 实际 Session 创建销毁与跨站内存试跑

[三Session试跑](evidence/session-memory-lifecycle-pilot.json)使用正式B1 Linux ARM64 Source/Cpp/Rust Gateway及真实CanvasKit CPU主线程Viewer，每个Session消费400次独立噪声PNG/字体更新、超过64MiB工作集、25次resize、13次实际输入和一次跨站document token/renderer PID更换。共1200次更新、75次resize、39次输入，图像270,718,131字节；实际原生image cache均发生淘汰，默认路径Node map/publish/捕获awaitPromise为0。

Source浏览器后代及Broker在启动、工作集加热和跨站后通过已打开的proc目录FD绑定身份；每个Session八个身份均在关闭后返回ESRCH/ENOENT，合计24个，父进程或UID变化不会被当作退出。Source最新帧/生产者/需求、Broker缓冲与RPC所有者、Gateway peers及HTTP/流端口均核对关闭，夹具仅保留活动Session的标量统计。Source家族加热PSS约670至675MiB；关闭Source及该Session Viewer上下文后，整个观测后代组PSS分别下降约964/795/806MiB。该下降包含Viewer上下文，未冒称全部归于Source。控制器还包含PNG夹具和观察器；三轮关闭后的控制Node PSS约207.5/209.0/161.6MiB，分配器驻留按实记录，不要求瞬间归零。

此处为可复用Session所有者与真实生命周期的独立试跑。三个样本不证明大量Session增长平台；Viewer浏览器虽持续存活，各Session页面上下文明确重建，不能替代三个主Viewer VM持续八小时。接下来先按本试跑数据冻结多Session物理增长门槛，再接入长存活主Viewer的跨站/附加Session负载。完整B10/C5/N1长期和八小时继续；41项仍9完成/12部分/20待做，无提交或推送。


## 预先冻结物理门槛的20次完整Session循环

[20次实际循环](evidence/session-memory-many.json)从三轮试跑预先生成并挂载只读物理门槛，使用固定源码/正式B1产物在独立容器执行797.09秒。每次400次实际图像/字体更新、25次resize、13次输入、一次跨站document token及renderer更换，工作集均超过64MiB且原生image cache真实淘汰。合计8000次更新、500次resize、260次输入、1,804,787,054字节PNG，160个绑定proc目录FD的Source/Broker/浏览器身份均通过ESRCH/ENOENT确认退出；关闭后Source家族为空，RPC所有者/缓冲/peers/端口清理核对，过期夹具路由返回410。

每次Source及Viewer上下文关闭后的控制Node PSS上限273.02MiB、观测后代组上限512.90MiB、cgroup anon上限358.34MiB均在运行前冻结，分别来自试跑最大值加64/128/128MiB余量；实际最大值为205.53/381.74/226.95MiB。末五轮与首五轮中位数相比，Node PSS下降2,375,680字节、组PSS下降2,289,664字节，anon增加8,380,416字节，均低于预先门槛。FD每轮固定26，进程数未超过冻结增长上限，cgroup未发生OOM kill，观测树之外仅有已知init PID1，没有新孤儿/不可见成员。没有强制GC或运行后放宽门槛；节点采集与cgroup仍使用原有5秒截止。

每轮完整Source/Viewer上下文关闭后，观测组PSS下降至少789,907,456字节。该下降包含Viewer上下文，控制Node仍含PNG夹具与观察器；PSS和cgroup各自记录，不混为独占内存或会话密度承诺。TCP端口关闭探测不创建每Session的HTTP客户端池；夹具与Source引用释放、FD关闭、字节缓存和逻辑客户端预算均单独核对。此处证明所列20轮Linux CPU场景中的回收及冻结增长门槛，不表示永久平台、不替代主Viewer VM八小时，也不完成全部B10/C5/N1。41项仍9完成/12部分/20待做，无提交或推送。


## 长存活主Viewer与附加Session控制端

[六项实际控制端合同](evidence/session-longload-source-contract.json)验证独立文件通道的主/附加Source所有者。三个Linux实际CPU Viewer在整个合同期间保持页面nonce不变；两个Worker的CDP target ID在首尾完全一致。附加Session消费400次真实PNG更新、90,014,739字节工作集并发生原生缓存淘汰，同时主Viewer继续收到像素；主Source跨站更换document token、epoch及真实renderer，三个客户端没有重建。附加Session关闭后七个身份、主Source最终八个身份均通过绑定FD确认退出，旧附加Session命令被拒绝，最终创建数/关闭数均为2，Fixture及Source/Broker/浏览器关闭。

控制端对已附着并ready的真实Viewer peer调用正常acquire API，但明确不投递ControlGranted token，模拟调用方放弃授予结果，使客户端无法续租。保持默认ttl=30000ms、不导航或resize打断该窗口，实际timer在30002ms完成expired清理并恢复Agent，期间续租数0。此为明确的放弃授予合同，不当作自然丢包或物理键盘测试。首轮在创建附加Session前因初始状态未规范而失败，日志及源码快照保留；修正后完整路径通过，并补强Worker身份见证和创建/关闭计数核对，没有缩短TTL或放宽工作集/截止门槛。

此处只完成Linux CPU控制端基础。Mac GPU Worker/CPU Worker/CPU主线程长期存活、周期附加Session、设备物理增长门槛与N1长期窗口仍需接入和试跑；没有启动八小时，也没有八小时通过。此前20循环及三轮试跑按各自冻结版本保存，不累计为长时验收；41项保持9完成/12部分/20待做，没有提交或推送。


## 三个Mac主VM持续存活与附加Session试跑

[硬件Mac试跑](evidence/session-longload-mac-pilot.json)使用冻结575文件版本和正式B1 Linux Source，三个主Viewer为Apple M2 Max Metal GPU Worker、CPU Worker与CPU主线程。主VM实际运行268.12秒（总驱动276.12秒），501次图像/字体更新、42次resize、30次输入、两次实际跨站；六个样本中三个页面nonce与两个Worker target ID均保持相同，GPU模式和零呈现读回检查通过。另有三个CPU主线程Viewer附加Session在后台各消费400次更新、25次resize、12次输入，合计270,043,429字节图像，每次都超过64MiB并发生原生缓存淘汰。主负载未因附加Session完整循环而停止。

每个附加Session七个身份退出，主Source最终八个已绑定身份退出；最终Source创建/关闭均为4，所有fixture/浏览器/Broker/peers及观察器关闭，两端驱动退出0。默认30秒放弃授予探测重复三次，实际在30003/30003/30004ms完成expired并恢复Agent，未把短TTL或自然丢包充作该证据。观测器续租计数只在真实renew成功后增加，拒绝旧token的尝试不冒充续租。

采样覆盖间隔最大62.164秒；原2秒helper就绪/请求、250ms回收、5秒阶段、90秒覆盖及所有逻辑Wasm/JS/render/GPU预算保留。采样期间仅与附加页面创建/关闭做短生命周期协调，普通绘制更新继续；helper没有自动重启/ps回退或旧值补零。RSS、Darwin physical footprint、Linux PSS和cgroup anon/file仍分列，进程组为有身份见证的实时观测，非原子独占内存总量。

此轮无附加Session的physical footprint观测最大约1.81GiB，有附加时约2.33GiB；Linux PSS观测最大分别约0.85/1.27GiB。这只是制定设备物理门槛的试跑数据，本轮未施加该新物理门槛，不作增长平台或八小时验收。接下来须在长测前冻结物理策略、验证更长负载，并集成N1真实网络/帧龄/丢弃窗口。C5/B10/N1完整长期及八小时仍未完成；41项保持9完成/12部分/20待做，无提交、推送或缓存清理。

## Mac持续Session的运行前物理门槛

新增独立物理策略校验与失败取证：缺失/非有限测量、未知域、缺失状态、重叠的前后中位数窗口均拒绝；8小时必须含增长门槛。超上限时先保存完整实测值与门槛，不静默丢弃失败样本。三个策略契约测试通过。

Apple M2 Max硬件pilot之后、独立30分钟验证之前冻结 `tests/fixtures/session-longload-physical-m2max.json`：主VM3×compact640MiB加共享256MiB的footprint门槛2176MiB，有附加VM时2816MiB；单独RSS和Linux PSS/anon/node域均有明确门槛及实测pilot依据。前后各5个同状态、burst之后样本互不重叠，要求每状态至少10个；允许增长192/256/128/128/64MiB。它们是待真实验证的测试验收门槛，非已证明的产品承诺。未强制GC、未替换主VM、未放宽原采样deadline。

本小任务仅完成策略与失败记录实现及运行前冻结；30分钟结果、8小时、N1长测仍待验收。继续不提交、不推送。

## 真实Linux到Mac的Native时钟适配

跨主机校准现在接受明确的Native probe回调，直接返回真实当前Source的scheduler回复、binding/document/producer及epoch/viewport见证。Mac performance.now区间覆盖完整私有文件通道往返，不伪造Source/capture对象，不采用Linux Node时钟替代Mac时钟。默认同机严格PID/epoch/viewport门槛保留，host参数默认仍为loopback。12个时钟契约通过，包括异步通道区间与跨状态拒绝。

独立硬件pilot v2通过：25.190秒、121次更新、三窗口201个成功CPUWorker提交全部与其自身像素读取及正常frame事件配对；同一Worker/页面跨真实resize及跨站持续存活，校准PID从78换为102时另开严格窗口。三个窗口帧龄p95为67.307/68.166/73.658ms，各自最大时钟不确定度13.697/14.055/14.102ms；这是包含同步读像素开销的观测值，非无观察器性能或物理显示scanout。

v1把异步图片和DOM标记所有过渡帧强制视为相等，错误断言导致失败；旧副本及失败/正常清理结果保留。v2逐点核验已发出的合法cycle、恒定Session身份，并逐次等待最终PNG/DOM像素收敛，实际记录24个中间标记差异；每个原始窗口先持久化再校验。

每个窗口分别前后校准，导航/resize及校准间隔不属于帧龄覆盖；此项只验收跨主机适配，不是连续长时全帧覆盖，也未施加网络损伤。Source创建/销毁1/1、8个已知Source身份退出、Broker请求/响应owner与逐帧Node调用为0。N1长测、8小时与全部41项仍未完成。

## 真实Mac路径的单向Gateway丢包试跑

新增测试专用eth0分层qdisc，严格只匹配本次独立NET_ADMIN容器主Gateway TCP源端口，拒绝替换现存qdisc；Source→Mac方向delay40ms/jitter2ms/loss1%/20Mbit，反向未整形。配置不写成对称RTT80ms。每窗口删除本次qdisc并核验恢复noqueue，Source停止路径也负责清理。内核计数必须是实测非空整数，未知/重复队列不能通过。

硬件v3通过：66.553秒、121次更新、三个严格窗口259次成功CPUWorker提交全部自身像素/正常事件配对；实际内核累计100942321bytes、83drops。Mac经同一真实Gateway的额外ACK-only display peer完成30次ping/pong，实际RTT约40.35–127.92ms；其流量及读像素开销包含在本次试跑中。12次文本输入按真实WebSocket.send(seq)与InputAck精确配对，dispatch到ACK最大147.70ms，源文本最终像素均核验；3s输入ACK、5s提交ACK、15s资源进度inactivity、32KiB chunk、16MiB/6帧credit保持原值。恢复事件为0仅指本观测窗口的Worker恢复，不代表TCP或快照无丢失。

三窗口帧龄p95分别460.74/463.50/738.05ms，最大时钟不确定度约14.47ms，且窗口之间导航/resize/校准没有全帧龄覆盖。创建/销毁1/1、8个已知Source身份退出、进程实际exit0、每窗口qdisc移除、清理错误为0。

v1因基础runtime没有tc在施加损伤前失败，保留原记录；另建runtime-netem镜像只安装iproute2并记录镜像ID/构建日志，未改基础镜像或清理缓存。v2的ACK门槛断言失败；旧代码用Source已处理计数寻找ACK，不能保证对应刚发送文本，且当时未保存具体失败数值。v3改为实际send(seq)/text匹配并先保存每条ACK再断言，未放宽3s门槛。旧失败副本均保留。

此项只完成Mac路径网络测试适配与独立pilot；长期连续帧龄、长时丢包/8小时仍待验收，41项计数仍9/12/20。

## Linux跨渲染进程单调时钟前置核验

为连续观测跨站窗口补充测试专用Linux clock probe：真实当前Native scheduler戳必须处于Linux controller hrtime的调用区间内，仅允许整数微秒1us舍入；proc目录FD固定renderer PID/startTicks/parent/UID，前后两次身份核验且renderer/controller time namespace一致，boot ID与namespace组成域哈希。单次5s、并发1，FD始终关闭；未知/变更/跨域/超界时间均不能得到共享时钟声明。源码依据保留实际本地Chromium time_now_posix/time.h/time.cc的SHA与快照并对照已提交对象内容，Linux TimeTicks底层为CLOCK_MONOTONIC、IsConsistentAcrossProcesses返回true。原Capture/Broker/浏览器二进制未改。

真实硬件pilot通过：35.323秒、跨站前后两个实际renderer、72个Native戳全部通过同Linux单调区间及固定身份/namespace检查，一个Worker持续存活，三旧式严格窗口仍独立按PID验收。新增1个区间门槛契约通过；此前12个时钟契约沿用父检查点。此步只是共享时钟前置依据，尚未允许跨PID连续帧龄验收，也不证明任意后续时钟覆盖/非线性漂移或其他平台。Source与Viewer实际exit0、8个已知Source身份退出、清理错误0。

冻结时read-only git diff触发长时索引刷新，仅终止本次自建git子进程；随后直接读取3个HEAD对象并与工作文件/快照SHA对照完成核验，未清理缓存、未暂存或提交代码。8小时/N1长时仍未通过。

## 跨导航与丢包的连续有界帧龄窗口

新增测试专用atomic rotate：同一真实Worker在主线程消息顺序边界上关闭旧窗口并立即开启下一窗口，过程中enabled不关闭；每窗口4096样本/512协议事件/32socket事件，累计ordinal持续核对、原始窗口先落盘再校准/校验，页面只保留当前窗口，Node保留6次真实校准与最多1024个producer证明。Linux共享时钟路径显式启用并验证每个当前renderer的真实区间/固定身份/namespace，未伪造或重标PID。旧式严格PID/epoch/viewport窗口默认保持；两者共用原区间数学，未知renderer/域不匹配/提交缺失/替换Worker/ordinal断裂都会失败。19个数学、边界、物理策略、网络计数契约通过。

真实无损伤pilot51.485秒：400图片更新/90,015,365bytes、13resize、2跨站、10文本输入、同页同Worker跨3个真实Source renderer，6个有界窗口（末窗口真实0提交也保留）连续配对660次成功提交，首尾Worker.all差值正好660且缺失0。包含跨epoch/PID/viewport的单个窗口。实际出现一次commit-resources-unavailable恢复及一次真正排队的keyframe request，随后最终像素收敛；未注入诊断故障。点估计最低-2.223ms处于校准不确定区间内，上界仍非负，原样保留，不裁成0或解释成真实负延迟。

独立单向Gateway netem pilot209.212秒，同一方法连续配对770次成功提交，2次真实跨站仍在enabled窗口内，缺失0；一次网络配置覆盖全部窗口及转换，实测内核丢包/RTT/输入ACK和每窗口原始帧见独立evidence。协议恢复事件0不表示TCP或Source快照没有丢失。两试跑的算法完全相同，网络副本仅多持久化实际served-module SHA receipt；生产Worker、Source、Broker与浏览器二进制均未改。最新590文件副本另通过三旧式严格窗口实机兼容检查。

所有Source与Viewer实际exit0，最终cohort完整、同一容器cgroup内观测cohort之外只有init PID1，已固定的8个Source身份均退出；中间renderer只做了在世身份/时钟证明，尚未全部持有FD至销毁，因此不宣称完整历史身份退休集合。仍需把连续观测、Source/Gateway/native-rejection有界窗口、精确输入marker/watermark及每次导航前固定身份并入三个主VM/附加Session/默认租约长测，再验收物理门槛和8小时。全部41项仍9/12/20，不提交、不推送。

## 独立30分钟物理增长门槛失败

运行前冻结的579文件副本与49254837…策略完成真实30分钟压力后，Viewer命令按增长断言exit1；Source和容器exit0，清理无错误。3主页面nonce/2Worker IDs全程稳定，31次实际采样、21个附加Session完整生命周期，最终创建/销毁22/22；全cohort PSS完整、同一容器cgroup内观测cohort之外只有init PID1。单次绝对物理门槛均通过，但这不足以验收长期增长。

主VM独占状态13个burst后样本，footprint前5中位数1,638,843,648→后5的2,011,464,600bytes，+372,620,952bytes（约355MiB）；带附加Session状态17个样本，2,108,969,984→2,430,047,376，+321,077,392bytes（约306MiB）。两者均超过事前192MiB允许增长，真实保存为失败；RSS/PSS/anon/node其余8个增长域通过，未调整或重算门槛。8小时不启动。

失败归因尚未完成。逐次像素校验在每次poll创建新临时Canvas/context，可能影响Chrome native footprint；已保存逐PID中位数与逻辑ledger/retiredWasm对照，不能把它直接断言为产品泄漏或唯一观察器原因。下一步只复用测试小画布、保持所有物理策略/工作负载/主VM/采样deadline不变，独立重跑检验假设；不强制GC、不替换主VM、不修改生产代码、不清理缓存。此前连续帧龄/网络适配的短时通过不抵消本次物理失败。

## 单页复用像素校验小画布

针对观察器开销假设，只修改长测driver：每个Viewer页在初始化创建一个4×1验证Canvas/context，PNG/DOM/Session与输入marker检查重复使用同一对象；逐页nonce、创建数1、尺寸与read counter纳入每次采样门槛，主页probe identity全程固定。物理超限时多保存完整Native/heap/ledger/source实测值，不改变原断言或deadline。未改生产文件、未强制GC。

为避免夹带后续Source观察模块变化，新验证完整复制失败run原始579文件、原dependency/browser/runtimeimage，只替换这一份driver；1800秒/400burst/2s/导航40/附加Session40×400及物理policy SHA49254837…完全一致。实现已独立冻结，实际复验尚未通过；不能从代码改动推断原因或验收8小时。

## 每次导航前固定全部已观测Source进程身份

长时Source owner现在在每次实际navigate前完成原有严格Root/proc/PSS采样并固定本次Source cohort所有进程目录FD，明确验证当前producer属于该Source family，再记录navigation ordinal与实际producer PID/start/parent/UID fence。历史FD最多1024、导航最多1024；直到Session close都保留，单次采样与销毁的原5s/15s约束保持。Source测试文件改变，生产Source/C++/Rust/Viewer不变。

独立真实Linux合约5.611秒通过：12次交替localhost/127跨站，每次Source doc token/epoch/PID与最终PNG/DOM/Session像素核验，实际共13个历史renderer身份全部保留至销毁；共19个固定Source身份最后均由ESRCH确认退休（包含6个其他进程），全部端点/Source/Broker状态关闭，cohort PSS完整，cgroup内观测cohort之外只有init PID1。Root控制器FD从19回到19，逐帧Node map/publish/awaitPromise为0。未假定每次导航必然新PID；若复用，仍按真实PID/start身份核验。

这补齐后续多次导航长测的历史身份记录，不追溯修改此前只固定初始/最终cohort的结果，也不把当前复验579旧副本变为新owner版本。8小时与N1完整合并仍待验收。

## 原生拒绝事件的有界排空窗口

测试observer新增显式drainable模式：每窗口最多256条真实NativeFrameRejected，按独立observationOrdinal连续排空，累计recorded/received与当前retained分开；空窗口半开区间(after,through]两端相等，不假造事件。溢出/非法事件保留首个失败信息并使drain失败，不把异常抛入Source事件处理器；普通旧模式的边界与行为保持。Source/Gateway统计仅各自异步见证，不能与内核packet drop或Worker恢复直接合成原子丢帧账。Source actor工作窗口与实际关闭后最后尾部窗口落盘，detach listener防止持有废Source。

22个纯契约通过。实际Linux Native hash retry正例与legacy各一轮通过：5次明确诊断空map与正常resourceBudget回收触发真正同scope原生cache miss，真实Retry后自动full resend，蓝PNG/绿DOM及input2经Gateway/CanvasKit验证；drain模式首窗口1条、后空窗口0条且累计仍1，legacy保留1条。这是显式诊断故障，不算自然丢包；对应Node map5仅诊断阶段，retry没有额外控制evaluate。

实际Source actor长期控制合约也通过：3个CPU主VM保持、附加Session400图片/>64MiB、真实30s废弃租约、跨站、关闭与stale命令拒绝；两工作窗口及Source实际关闭后的第三尾部窗口ordinal连续，未漏Native拒绝事件，创建/销毁2/2。Parent测试Viewer在Source actor cohort之外是既定边界，未声称它们已在Source receipt时消失。3个独立容器均实际exit0。完整三VM/N1合并、物理增长门槛和8小时仍未完成。

## 历史身份探针真正关闭后的控制器FD门槛

owner.after的原metrics在finally关闭历史procFD之前采集，不能当探针关闭后的FD回落证明。Source actor现在在Source/历史探针/fixture/network/拒绝observer全部清理后，重新实读自身/proc/self/fd，与创建Source前（已有fixture）的baseline比较，最多允许8额外FD；失败写入正常清理错误，不忽略。

一次独立真实Source actor7项合约通过，三CPU主VM保持/第二Session400图片/>64MiB/真实30s租约/跨站/3拒绝窗口与正常销毁全部完成；控制器baseline20→after19，进程实际exit0。此次只重复Source actor合约，冻结manifest继承父任务的retry工作负载说明另写clarification，未宣称此次重跑Native hash retry。未改生产文件、未修改旧失败记录或放宽物理策略。

## 输入send/ACK与像素水印的有界观察器

新增测试专用输入观察器：仅成功WebSocket.send(Input)后记录实际seq/epoch/viewport/kind与单页performance时间，接收ACK时匹配自身seq；不保留lease token、URL或输入文本。最多64pending/128ACK环形记录/32错误及1个活动文本probe，dispatch起3s门槛，累计sent/acked/texts标量。迟到或无对应send的ACK不能被用作当前文本确认，观察器错误保持可见。

独立真实Linux合约11.126秒通过：130次正常Viewer beforeinput文本请求，全部真实发送/注入ACK<3s并逐次等待实际最终input marker与Native lastProcessedInputSeq≥该seq；包含resize及跨站。总520次实际Input send/ACK、pending0/rejected0，超过128记录边界后仍只保留128，页面observer nonce保持，Source输入最终x40与末epoch累计长度一致；Source/Viewer正常关闭，实际固定的8个Source身份均退休，逐帧map/publish/awaitPromise0。单页像素检测时间在ACK后poll，包含检测/传输开销，不当作最早显示或物理scanout。

此项只为组合长测提供边界稳定的输入证据，尚未验收Mac同算法/所有输入模式/8h，也不替代CPUWorker连续窗口中的输入前缀与epoch因果校验。

## 复用验证画布后的同门槛复验仍失败

原579文件/runtime/依赖/browser/workload/物理policy完全保留，仅换测试driver复用4×1探针的独立30分钟复验完成。31次采样中三个主页面/两个Worker/probe nonce均持续相同，每页创建数1；所有绝对内存上限保持，但主VM独占footprint前后中位数仍+313,852,336bytes（约299MiB）>事前192MiB，因此Viewer按原断言exit1。带附加Session状态+115,179,832bytes（约110MiB）通过，其余8域增长通过。Source与容器exit0，清理无错误。

复用画布不足以解决门槛失败，不能声称找到唯一原因。原失败与复验均单独保存，未合并时长、未改预算或强制GC、未改生产代码。补充诊断看到部分末期样本仍带未GC的旧Wasm arena，属于混杂状态而非充分解释：原失败在无retired arena的主VM样本中也有约298MB中位数增长；复验的同类样本不足10个，不能选样改判。需要继续定位native footprint/分配器/arena归属，或以明确理论和独立验证完善物理观测方案，不能把现有失败重写成通过。8小时/N1完整合并仍未验收。

## 退休Wasm预算跟随真实backing的生命周期

发现并实际复现独立记账漏洞：ClientMemory.retire原先finalizer注册modulewrapper，wrapper被收集时即移除retiredWasm charge，但其他typed view仍可能持有可读的线性backing。隔离Node GC回归证明旧代码在16MiB实际Wasm backing仍可读时错误记为0；修正为register实际ArrayBuffer之后，wrapper已收集仍记16MiB，最后view释放且backing收集后才归0。生产代码不调用GC；--expose-gc只用于独立生命周期回归，不是长测通过证据。

单任务603文件副本完成相关22项测试，以及完整JS每平台255项：Mac247通过/8Linux-only跳过，Linux251通过/4Mac-only跳过；两平台真实CanvasKit main+Worker重建、旧generation取消、FrameGate、销毁检查通过。原生C++/Rust/capture/二进制与所有预算不变，此次有1个生产protocol/client-memory.mjs修改，不能继续泛称全部113生产文件未改。

完整Mac首次运行再次触发既有helper新路径2s ready超时，pid95392被SIGKILL后真实回收；原失败保留，相同代码/门槛独立复验通过，原因仍未查明，不宣称修复启动问题。Linux首次失败为自建测试工作目录的宿主绝对链接在容器内无效，修正容器工作目录链接后通过，冻结代码未改。

此修复确保内存账不会因wrapper提前收集而少计，不证明前两次footprint增长全部由此造成，也不代表内存已物理归还。独立VM分类取证仍运行旧579文件副本，结果不会被此改动混淆。8小时与N1完整组合仍未通过。

## Mac原生内存类别的独立取证

使用原579文件不可变副本（不含后续退休Wasm记账修复），完成600秒请求、623.250秒总运行：660次更新、52次resize、38次输入、6次跨站、7个secondary与7次真实30秒租约到期；三个主页面/两个Worker身份持续保留，Source创建与关闭8/8，清理无错误。

独立只读采样器围绕每次系统工具调用核验3个自有renderer的PID/start/UID/parent。6轮18份footprint有效；vmmap12份成功、6份在原1500ms上限超时，dyld/PartitionAlloc警告与错误原样保留。记录实际Mac Chrome155.0.8059.84。主要变化位于PartitionAlloc/V8标签及未标记VM_ALLOCATE，普通MALLOC_SMALL/TINY各轮不变；类别变化不能确定具体对象或独占物理内存，虚拟保留量不能计为物理占用。

本轮无物理增长策略，属于归因诊断，不是C5增长通过。没有强制GC、替换主VM、放宽门槛或删除缓存；此前两次30分钟增长失败继续保留。证据见`docs/evidence/session-memory-forensics.json`；8小时与完整N1仍未通过。

## 有界且不强制GC的原生分配器转储

在含退休Wasm记账修复的607文件副本上完成600秒请求、612.059秒总运行。三个主页面与两个Worker身份持续保留，11份轻量转储均在5000ms请求/7000ms含结束总预算、每份32MiB上限内完成，覆盖实际自有renderer并通过前后PID/start/UID/parent核验。Mac完整JS258项250通过8平台跳过，Linux独立运行254通过4平台跳过；首次Linux可写产物目录配置错误的2项失败日志保留。

显式关闭周期转储，每份独立追踪仅一次不强制GC的实际请求；保留CDP请求GUID和Perfetto导出表编号两个原值。精确Chrome155 DEPS固定的Perfetto源码确认导出编号来自快照表、periodic_interval名称为常量，因此不拿其名称推断周期请求，也不伪造GUID对应。四份初期诊断失败分别涉及错误汇总逐对象路径、请求超时、结束追踪超时及错误GUID匹配，原始副本与记录均保留。

记录各分配器active/resident字段，父子层级不相加。此诊断与完整JS运行有重叠、无物理增长策略，不能代替物理增长验收；自然GC仍可能发生，未发送强制GC命令。原两次30分钟增长失败、8小时与N1组合未通过的状态不变。证据见`docs/evidence/session-memory-infra.json`。

## 三个持续Mac Viewer的实际输入因果证据

607文件副本独立请求180秒、总运行190.471秒，三个主页面与两个Worker身份持续保留；27次主文字输入逐次记录真实WebSocket.send序号与3000ms内的accepted/input-injected ACK，并等待GPUWorker、CPUWorker、CPUmain全部显示同epoch/viewport、lastProcessedInputSeq至少该ACK序号及对应文字数像素（共81份逐Viewer证明）。secondary另有24次相同输入检查。

每页观察器保持64 pending/128 ACK环/32错误上限与单个文本探测，记录落盘后释放；主观察器nonce在采样间不变。延迟仅用发送页自身performance原点计算dispatch→测试读像素，包含轮询/读回开销，不跨页面减时间，不声称物理呈现。Source/历史ownership FD/Viewer/helper正常清理，默认30秒放弃租约仍由真实到期检测验证。首次容器相对挂载路径在启动前被拒绝，原记录保留，修正绝对路径后使用同一607文件源码。实际出现的输入epoch/viewport集合单独记录，不把跨站后没有输入的epoch算作输入验证。此轮无物理策略，也未组合连续frame-age/轻微丢包；原30分钟失败、8小时与N1未通过状态不变。证据见`docs/evidence/session-longload-input.json`。

## 跨站新epoch上的三个Mac Viewer输入因果证据

609文件副本独立请求180秒、总运行187.035秒，三个主页面与两个Worker身份持续保留；28次主文字输入逐次记录真实WebSocket.send序号与3000ms内的accepted/input-injected ACK，并等待GPUWorker、CPUWorker、CPUmain全部显示同epoch/viewport、lastProcessedInputSeq至少该ACK序号及对应文字数像素（共84份逐Viewer证明）。secondary另有24次相同输入检查。

每页观察器保持64 pending/128 ACK环/32错误上限与单个文本探测，记录落盘后释放；主观察器nonce在采样间不变。延迟仅用发送页自身performance原点计算dispatch→测试读像素，包含轮询/读回开销，不跨页面减时间，不声称物理呈现。Source/历史ownership FD/Viewer/helper正常清理，默认30秒放弃租约仍由真实到期检测验证。前轮首epoch验收、最初挂载路径错误与其修复记录均保留。每次跨站完成后、下一次放弃租约前立即从GPU输入，实际主输入ACK至少覆盖两个epoch，并在三个Viewer分别核验新epoch/viewport、水印序号及输入像素；两个编号集合原样记录。此轮无物理策略，也未组合连续frame-age/轻微丢包；原30分钟失败、8小时与N1未通过状态不变。证据见`docs/evidence/session-longload-input-crosssite.json`。

## 原生分配栈与CanvasKit字节交接缺陷

612文件副本完成真实600秒工作循环（总运行614.209秒）：660次更新、52次resize、44次主输入、6次跨站、7个secondary与7次默认租约到期。三个主页面、两个Worker保持身份；36份原生分配快照在每页5000ms/8MiB/16384样本/256帧/512模块约束内完成，首份为空、后续有真实样本，采样器各停止一次，Source创建/关闭8/8，清理无错误。完整JS每平台260项，Mac252通过8跳过，Linux256通过4跳过。

按实际模块UUID和偏移保存栈；未伪造页面对应OS PID，只声明页面target/frame/nonce与前后相同自有进程集合。公开精确dSYM/Breakpad入口不可用，离线LLDB只读取安装二进制、不附加进程，确认采样调用分配blink::StringImpl并加12字节头，上一层计算Base64长度。单块10,990,560字节恰为8,242,911字节Wasm的Base64长度加头；其观测数量与arena重建数相关。该相关性和加权样本不是独占物理内存或唯一根因证明。

实际Node及Mac浏览器复现发现：固定CanvasKit0.42胶水忽略wasmBinary及instantiateWasm选项。传入无效四字节Wasm、会抛错的钩子仍初始化成功，真实浏览器经locateFile产生一次HTTP Wasm请求；原Viewer预取校验的字节未通过这些选项交给实例化路径。这是新确认的集成缺陷，尚未修复。下一步应在不修改依赖缓存的前提下使用实际受支持的字节交接或受SHA守卫的胶水适配，不能在被忽略的instantiateWasm上假定编译缓存生效。

组合追踪最初超过既定7秒结束总预算的失败保留，后续分离原生采样；未提高原采样预算、强制GC、替换主VM或修改物理增长策略。离线反汇编曾忽略范围参数产生过大输出，命令已自然结束且无产品进程被终止，相关记录保留；本诊断不作性能验收。原两次30分钟增长失败、8小时及完整N1未通过状态不变。证据见`docs/evidence/session-native-sampling.json`与`docs/evidence/canvaskit-binary-handoff-bug.json`。

## 固定CanvasKit胶水实际消费已校验Wasm字节

修复原生采样后复现的交接缺陷：在Node生成资源包时校验固定0.42胶水SHA，只为该精确版本增加wasmBinary直接实例化入口；未知胶水构建拒绝启动，不盲目匹配未来压缩变量。提供字节无效时直接拒绝，不通过HTTP替换；不提供字节时保留原加载分支。主线程、Worker版本化资源与静态Viewer统一使用适配后的服务字节；原node_modules、Wasm二进制、Native Broker和Chromium均未修改。

实际Mac/Linux的主线程与Worker都验证：无效字节拒绝且不回退请求；有效预取字节初始化与arena重建时HTTP Wasm请求为零；蓝色像素、旧generation/commit抑制、清理时scene元数据持有、初始化中dispose及最终owner归零检查通过。完整JS每平台262项，Linux258通过4跳过，Mac独立复测254通过8跳过。首次Mac仍有原2秒助手启动超时（PID63085已SIGKILL并回收），253通过/8跳过/1失败日志保留；未放宽门槛或声称此故障根因已修复。

本项只验收字节交接功能。后续同负载原生分配比较、原192MiB增长策略的独立30分钟复测及8小时/N1组合仍须各自取得证据，不能由此推定通过。证据见`docs/evidence/wasm-binary-handoff.json`。

## 已校验字节交接后的同负载原生分配比较

使用相同600秒工作循环参数、相同原生采样上限，修复后总运行615.598秒，三个主页面和两个Worker持续保留；Source创建/关闭8/8、无清理错误。完整原始profile和前后OS进程身份集合均保留，未强制GC。

逐Viewer记录修复前后约11MB（Wasm Base64长度加StringImpl头）大块采样数量及实际arena重建数：`[{"label": "gpu-worker", "beforeFinalLargeSamples": 8, "beforeArenaRecycles": 8, "afterFinalLargeSamples": 0, "afterMaxLargeSamples": 0, "afterArenaRecycles": 8}, {"label": "cpu-worker", "beforeFinalLargeSamples": 9, "beforeArenaRecycles": 9, "afterFinalLargeSamples": 0, "afterMaxLargeSamples": 0, "afterArenaRecycles": 9}, {"label": "cpu-main", "beforeFinalLargeSamples": 9, "beforeArenaRecycles": 9, "afterFinalLargeSamples": 0, "afterMaxLargeSamples": 0, "afterArenaRecycles": 9}]`。该比较是采样分配证据，不能直接换算为独占物理内存或替代物理增长门槛；统计、原始数据和实例重建均未省略。

原两次30分钟增长失败继续保留；接下来独立使用同一492548策略和192MiB增长上限复测，停用原生分配/内存转储诊断，不合并此前运行时长。8小时和完整N1尚未通过。证据见`docs/evidence/wasm-binary-handoff-profile.json`。

## 三主Viewer连续帧龄、输入与丢包窗口的合并实现

长载驱动新增可选观测：CPUWorker的四点提交像素与原生时钟连续配对，主GPU实际文本ACK经epoch、viewport、输入水位及文本像素连接到该CPUWorker帧。主输入与窗口轮换使用既有生命周期互斥，先保存ACK和原始窗口；128条输入待配对上限、4096帧/512协议/32连接事件窗口、256条原生拒绝窗口及6组时钟历史保持有界。Source/Gateway计数、原生拒绝事件与内核丢包按各自边界保存，不拼成原子丢帧账本，不跨页面减时钟。基线与netem都使用相同第四个ACK-only peer测真实RTT。

兼容新的CanvasKit胶水服务字节后，观察器仍先检查完整资产包与生产构建一致；实际disable回复后立即标记停止，即使后续校准或落盘失败也不重复发送disable，仍保留失败。五项纯逻辑合同通过，覆盖陈旧scope/水位/像素、缺失提交、写盘失败、队列边界及停止后时钟不可用；这些合同不是实际浏览器验收。

冻结620文件的两份180秒试跑清单，尚未启动。独立30分钟物理增长复测正在运行旧的冻结副本，保持492548策略与192MiB上限；新试跑脚本要求其实际结束后才可启动。后续仍须双平台完整JS、实际Mac基线与丢包合并试跑、物理增长及8小时；41项保持9完成/12部分/20待做。证据见`docs/evidence/session-long-observation-implementation.json`。

## 合并观测的启动失败清理与试跑时长修正

新增独立启动失败合同：实际本地TCP/WebSocket完成1次FrameAck和10次ping/pong，随后合成Source scheduler不可用；Worker尚未enable，合成网络配置仅撤销一次、连接正常关闭、清理错误0，输出没有保存测试key。Source与网络命令为明确合成夹具，因此不是Rust Gateway、真实netem或浏览器/N1验收。

两份180秒计划尚未启动即被600秒计划替代，固定620文件源码完全相同；20Mbit单向瓶颈需承载三个Viewer及相同第四ACK-only peer，400次256KiB更新可能占满180秒，导致预热后调度的附加Session和导航未被覆盖。增加两组相同的请求运行时长，未放宽3秒输入ACK、5秒采样阶段、默认30秒租约或额度。600秒基线与netem、完整JS均准备完毕但未启动，等待独立原策略物理复测真实结束。证据见`docs/evidence/session-long-observation-preflight.json`。

## 字节交接修复后的原物理增长策略复验

独立使用固定616文件、原492548策略及192MiB footprint增长上限运行1800秒；关闭原生分配与memory-infra诊断，不强制GC或替换主VM。本次通过。三个页面与两个Worker身份、4×1测试画布、Source跨站历史身份与关闭、附加Session400图像及默认30秒放弃租约均单独核验，Python直接从原始样本复算全部10个域的早晚中位数并与驱动报告逐字段一致。

primary-only：burst后16个样本，footprint前后中位数1499643480→1353121416bytes，增长-146522064bytes，原允许201326592bytes。

with-secondary：burst后14个样本，footprint前后中位数1878544520→1926418736bytes，增长47874216bytes，原允许201326592bytes。

原两次30分钟增长失败和旧助手启动超时保留，不累计时长。此项仅验证列明的物理增长策略；连续帧龄/输入/网络合并试跑、独立8小时和其余41项仍需后续证据，状态保持9完成/12部分/20待做。证据见`docs/evidence/wasm-binary-handoff-physical.json`。

## 固定完整JS检查的测试文件并发上限

620文件默认完整Mac检查保留两次不同失败：首次native helper原2秒ready超时（PID2039已SIGKILL回收）；独立复测该项通过，但legacy RSS双挂起故障合同超过原5秒阶段预算，测试报告约6.93秒。两个原始日志均保留。隔离原采样器两文件后14项通过，实际两次挂起/杀死/回收共约4.02秒，当前精确故障夹具进程清单无残留。

标准test脚本设置测试文件进程并发上限4，未修改采样器、原2秒ready/request、250ms回收、5秒阶段或任何原断言。独立复制623文件后的完整检查：Mac257通过/8平台跳过、Linux261通过/4平台跳过，每端265项，实际退出0。源码相对620副本除文档仅package.json脚本变化，不把降低单测并发解释为运行负载或采样门槛放宽，也不声称证明旧启动失败的唯一系统原因。真实30分钟物理复测独立使用原负载/原策略通过；600秒连续观测基线与netem仍需运行。证据见`docs/evidence/test-runner-concurrency.json`。

## 连续窗口并发更新的周期上界

独立合同复现：调用轮换时主周期100，实际下一次更新101先于Worker关闭窗口完成，窗口含101像素；用调用时固定100会错误拒绝有效样本。观察器改从驱动实际cycle闭包分别读取调用前、窗口完成后的上界，在检查像素前保存两个实测计数。仍逐帧检查全部四点，未来周期、错误Session、无效RGBA和计数回退继续拒绝，不过滤样本、不改原始窗口或时钟。

四项纯合同通过（含既有输入水位/像素/持久化边界）；运行中的623文件基线保持原样，尚未观察到它实际触发该并发失败。此处是新副本的测试观测修正，生产运行代码、内存策略与超时门槛均未修改，仍需新版本硬件试跑及完整JS。证据见`docs/evidence/session-marker-cycle-bound.json`。

## 组合基线与周期边界新版本完整检查

623文件的首轮600秒实际基线通过：总驱动620.190秒，660次更新、52次resize、44次主输入、6次跨站、7个400次更新的附加Session及7次默认30秒租约到期，12个连续窗口的2142帧全部配对、44次输入均有独立CPUWorker同水位和像素证明。三个主页面及两个Worker身份保持，Source创建/关闭8/8，清理错误0。该版本仍用调用时周期界限，尚未在本次实际数据中触发静态分析发现的并发误判，不当作新修正版已经实跑。

补全后625文件新副本完整JS每端267项：Mac259通过8平台跳过，Linux263通过4平台跳过，实际退出0。测试文件并发4、原2秒ready/request/250ms回收/5秒阶段与全部原断言保持；新增周期边界合同与实际本地WS启动失败清理合同通过。生产运行模块及Native二进制相对623副本不变，新的基线和netem各600秒仍需实际验收，8小时和41项总体仍未完成。证据见`docs/evidence/session-long-observation-v3-baseline.json`和`docs/evidence/session-long-observation-v4-js.json`。

## RTT附加连接使用只读消费确认

核对C10语义发现，既有RTT负载夹具虽然明确不绘制画面，仍使用display连接和旧式FrameAck；这些旧记录不能作为该额外连接scene-submitted的证明。新夹具复用已有Native生产消费票据，选recording生命周期以跨导航持续连接，校验Welcome的consumer-released、input=false、inputFeedback=false、control=null和renderer，再发送明确的consumer-released。它只消费并释放数据，不宣称录制了文件或绘制了像素。三个真实Viewer及其实际输入/像素/提交验证保持原样。

修改仅限四个测试所有者/控制器/观察器/合同文件，生产Node/C++/Rust和原超时额度未改；五项纯合同通过。实际本地TCP/WebSocket合同完成1次释放ACK、10次ping/pong及合成Source时钟失败后的网络/连接清理，并在另一例拒绝伪造显示端Welcome且不发ACK。票据与display key未保存到日志。这些票据/Source/网络为合成夹具，真实Native授权和组合硬件负载仍须新628文件副本独立验证。旧625文件丢包试跑继续，原样保存；八小时入口已改为要求新只读副本的完整JS与两组实际试跑，不会用旧夹具直接启动。C10和41项整体状态仍未完成。证据见`docs/evidence/session-rtt-consumer.json`。

## 修正版单向丢包试跑与只读RTT新副本完整检查

625文件的单向40ms/2ms抖动/1%配置丢包/20Mbit Gateway试跑通过：请求600秒，总驱动608.695秒，498次更新、43次resize、32次主输入、2次跨站、3个400更新附加Session及3次默认租约到期。11个连续窗口1782帧全部配对、32次输入均连接到实际CPUWorker水位/像素，缺失0；内核末窗口记录907449922bytes、1534drops，真实Gateway43次ping/pong的RTT为41.12–2677.18ms。Source/Viewer实际退出0，qdisc移除、清理无错误。

原始个体样本的帧龄估计p50约202.82ms、p95约737.97ms、最大1887.09ms，最大时钟不确定度13.99ms，最高同步像素观察成本11.90ms；保留时钟/观察器限制，不把配置40ms当实际RTT，也不把各层计数拼成同一丢帧账本。该副本仍用明确的旧ACK-only负载连接，不证明额外连接已绘制画面或完成C10语义，不用它直接放行八小时。

新增只读消费语义的628文件新副本已完成全JS每端268项：Mac260通过8平台跳过，Linux264通过4平台跳过，实际退出0，测试文件并发仍4且原采样期限未改。生产Node/C++/Rust、浏览器/Wasm字节与物理策略均未修改；新的真实基线和丢包试跑仍须独立验收。证据见`docs/evidence/session-long-observation-v4-netem.json`与`docs/evidence/session-long-observation-v5-js.json`。

## 只读RTT的两组600秒实际组合验收

同一628文件副本在真实Mac三主Viewer/两个Worker、Linux ARM64 Native Source上完成基线及单向40ms/2ms抖动/1%配置丢包/20Mbit试跑，均保持原窗口、采样、3秒输入ACK/RTT与默认30秒租约期限。基线总驱动630.455秒、661更新、2188帧、44次主输入、6次跨站、7个400更新附加Session与7次租约到期；丢包总驱动609.772秒、499更新、1788帧、32次主输入、2次跨站、3个附加Session与3次到期。全部成功CPUWorker提交均与自身四点像素/正常frame事件配对，缺失0；所有主输入均连接到独立CPUWorker的同epoch/viewport/水位和输入像素。三个页面与两个Worker身份保持，两端实际退出0，清理无错误。

附加RTT连接实际通过Native一次性recording生命周期票据，欢迎消息无输入权限/控制票据，使用consumer-released；Source窗口实际只有三个display及一个recording角色。它采用明确的原生消费协议释放字节，不声称解码、绘制或产出录像。额外连接仍使用既有legacy资源传输默认，基线和丢包均相同；这些结果不是仅三个现代Viewer、无观察器或物理scanout性能。

丢包末窗口内核记录910898394bytes/1556drops；个体观测帧龄估计p95约696.68ms，最大1929.68ms，时钟区间与同步读像素成本限制保留。各层丢弃/恢复/内核包数独立保存，不合并单位。

原物理策略30分钟及新版268项每端JS已独立通过。八小时前置检查核对四份检查点、同副本两组负载、19个浏览器文件、依赖及二进制、Mac14,6/M2 Max/64GiB/Chrome155.0.8059.84、原492548物理策略与磁盘余量；尚未把检查完成当成八小时通过。准备独立冻结28800秒，仍不累计旧失败时长，41项9完成/12部分/20待做。证据见`docs/evidence/session-long-observation-v5-baseline.json`与`docs/evidence/session-long-observation-v5-netem.json`。

## 八小时预热失败与接管就绪状态修复

首个633文件独立八小时请求在预热cycle16失败：首次文本探测超过原3秒期限，但发送观察器sent/acked/pending均0，Source inputSeq也为0；Source实际human holder已是该Viewer。Source与Viewer实际退出0/1，清理错误0，唯一已完成采样时间跨度0秒，不能算八小时或并入任何其他运行。原冻结副本、日志与失败检查点全部保留，未重启或放宽期限。

确定性合同在该原633冻结版ViewerInput上复现：只收到自身持有ControlState时active仍false，界面却提前显示“你正在操作”，因此真实授权尚未到达的交错会让输入被忽略。修复为此时显示“正在接管”并禁用按钮，只有有效ControlGranted后显示可操作；原active/租约/作用域和ACK期限均保留。完全相同的新合同在旧版失败、修复后输入17项合同通过。原八小时失败没有保存逐条控制消息时序，因此暂不宣称该交错是唯一原因；仍需真实Native延迟授权复现、完整双平台检查、新两组负载与独立八小时。证据见`docs/evidence/control-grant-readiness.json`。

## 控制权就绪竞态的真实 Native 前后对照

主动延迟实际 ControlGranted 的独立诊断已在 Linux Native Source/Rust Gateway 与实际 Mac GPUWorker、CPUWorker、CPUmain 上各完成三项前后对照。旧版在没有凭据、输入发送为0时显示“你正在操作”；修复后保持“正在接管”并禁用接管按钮，收到有效凭据才启用。三种路径授予后的实际文本 ACK 均低于原始3秒期限，并验证同 epoch/viewport 的输入水位与 Source 文本像素。两个版本的 Source/Viewer 均实际退出0，清理无错误。

这是显式控制消息延迟诊断，不证明它是先前8小时失败的唯一原因；原失败未记录控制消息逐条顺序。原8小时失败及其时间仍独立保留，不累计为通过时长。修复副本还需完整JS及新的600秒基线/丢包验收。证据见`docs/evidence/control-grant-native.json`。

## 附加 Session 存活期采样覆盖失败与修正

636文件的丢包试跑在607.018秒、第496轮最终断言失败：11份实际样本全部为primary-only，虽然三个附加Session均完成400次更新、超过64MiB图片压力并正确销毁。32次主输入及1789个配对帧通过已完成窗口校验，缺失0；Source退出0、Viewer退出1，Native采样助手退出0，qdisc移除、清理无错误。这次不授予验收，也不推断不存在的with-secondary内存数据。

新副本增加每个附加Session关闭前的真实完整采样，采样记录绑定同一个仍存活的Source与Viewer及其负载；该检查点不重置独立60秒周期时钟。两项合同覆盖周期时钟不被连续短生命周期饿死，以及错误身份、缺失Viewer、压力不足或伪造采样种类被拒绝。原始内存策略、采样阶段/ACK/租约期限均未放宽。新的采样分布与旧试跑不同，必须按新冻结版本分别验收基线和丢包。

## Mac完整检查失败与测试IPC归属修复

642文件副本完整JS：Linux267通过、4平台跳过，实际退出0；Mac260通过、3失败、8平台跳过，实际退出1。Broker部分输出未在原5秒内达到预期，两次Native助手启动超过原2秒；两名助手均被SIGKILL并回收。一个分配夹具在异步助手初始化之前fork、却在其之后才进入try/finally，初始化失败因此留下IPC进程。保存归属/停滞快照后，已只清理这个确切夹具PID2535，使失败检查自然报告终态；记录的全部进程已消失。日志总423.889秒包含等待该遗留夹具的时间，不作为正常吞吐数据。

修复用外层作用域在初始化前持有真实夹具。3项针对性合同通过；真实Node IPC夹具先就绪，再显式拒绝异步初始化，原错误在SIGKILL、close和IPC断开后才返回，36.755ms完成。生产Source/Viewer/Gateway、Native采样器和原2秒/5秒期限未修改。宿主同期1分钟load约244、12逻辑CPU，保存了有界只读快照，不将其直接解释为244核CPU或唯一原因，也未操作其他工作与系统安全设置。新的完整检查仍须独立执行，见`docs/evidence/session-long-observation-v7-js-failure.json`及`docs/evidence/owned-native-fixture.json`。

## 清理修复新副本完整检查

646文件新副本的Mac/Linux完整JS各272项均通过，实际退出0；Mac264通过8平台跳过，Linux268通过4平台跳过。Mac检查与Linux顺序运行，测试文件并发仍为4。旧642副本的三项Mac失败保留，不将后来的通过解释为高负载是唯一原因或只改夹具归属就解决了助手冷启动期限问题。生产Source/Viewer/Gateway、采样器与原始期限均未修改；新的真实基线正在验证每个附加Session关闭前取得实际同归属样本，尚不授予8小时或完整N1验收。见`docs/evidence/session-long-observation-v8-js.json`。

## 同归属采样新基线

646文件副本的新基线请求600秒，实际驱动618.522秒，660次更新、52次resize、44次主输入、6次跨站、7个附加Session及7次默认租约到期。18份实际样本中11份周期采样、7份关闭前生命周期采样；独立验证每个关闭记录都对应同一存活Source/Viewer、超过64MiB图像压力的真实样本。2152个帧/像素全部配对，44次主输入关联实际水位/像素，缺失0。Source/Viewer实际退出0，清理无错误。观察采样分布与旧副本不同，这次独立验收不替代8小时物理策略；同版丢包正在执行。见`docs/evidence/session-long-observation-v8-baseline.json`。

## 新采样版本丢包验收与独立八小时v2启动

646文件副本丢包试跑请求600秒，实际605.282秒，498次更新、43次resize、32次主输入、2次跨站、3个附加Session及3次默认租约到期。14份实际样本包含11份周期采样与3份关闭前采样，每个已关闭附加Session都通过同归属Source/Viewer/负载核对；1780个帧/像素全部配对、32次输入关联实际水位/像素，缺失0。Gateway实际内核计数907785040bytes、1577drops；Source/Viewer实际退出0，qdisc移除和清理均通过。见`docs/evidence/session-long-observation-v8-netem.json`。

原始个体样本帧龄估计p50约197.748ms、p95约768.213ms、p99约997.188ms、最大1681.262ms，保留时钟/观察器开销与误差范围，不作为物理扫描或业务成功承诺。全部前置哈希、浏览器/硬件与磁盘检查通过后，新649文件副本独立8小时v2已启动：新目录、容器与40096–40099端口，原492548物理策略、原输入/采样期限、持续三主Viewer/两Worker、真实租约及Source单向netem均保持；新增每个附加Session关闭前真实采样，独立周期时钟继续。历史30分钟物理证据使用旧采样分布，本次8小时须独立验证原上限及两种状态全部增长域。此前失败时长不累计；当前仅启动，尚无8小时通过。见`docs/evidence/session-coupled-eight-hour-v2-start.json`。

## K1 会话生命周期核心第一步

新增`service/session-registry.mjs`，在第一次异步provider调用前原子预留配额并绑定租户/幂等键；并发重试和完成后重试均返回同一操作，同键不同请求拒绝。初始化失败时必须收到明确closed回执才归还配额，清理失败/不确定保留资源槽。会话与操作公开快照不暴露provider句柄、页面URL、租户或异常凭据，已有幂等记录在容量满时仍可查询，新的记录按容量拒绝。8项轻量内存provider合同通过。

这是K1的部分实现；当前进程内记录在重启后不持久，尚缺TTL/释放、持久恢复、传输/SDK及真实Native整合与验收。未声明可发布的稳定公共SDK。新代码未加入正在运行的649文件冻结长测副本，未改其Native/Viewer/采样代码，也未运行其他浏览器负载或重型测试。41项当前为9项按范围完成、13项部分实现、19项待实现；8小时仍未通过。

## K1 生命周期核心：TTL与释放

独立源码快照通过22项轻量合同，实际退出0。TTL从就绪开始，用单调时钟计时；一个注册表只保留最近到期计时器，墙钟回退不延长会话寿命，计时器尚未投递时readiness查询也会同步隔离过期ID。释放先撤销可用状态，等待创建完成后才关闭晚到的资源；确认closed才归还配额。关闭失败保留隔离槽和可查询失败操作，再次显式释放会创建新操作但不改写旧终态，关闭尝试次数有界。

初始化与关闭的完成等待点在通知provider取消之前建立，直接/间接重入shutdown仍等待真实归属收尾。尚缺持久化/重启恢复、HTTP/SDK与认证票据和真实Native适配验证；没有把内存provider合同当成这些能力的验收。正在运行的649文件八小时副本保持原样，只运行轻量纯逻辑合同检查。见`docs/evidence/session-registry-lifecycle.json`。

## K1 独立持久账本组件

新增`service/session-store.mjs`，用SQLite原子事务保存会话、操作及租户/幂等键hash/默认参数绑定；排他所有权在提交之间保持，同库第二个活服务实例拒绝启动。历史绑定、会话身份与操作终态不允许重写，容量/跨租户外键/引用不一致会整批回滚；已有空文件、丢表、外来/损坏数据或非私有权限文件均拒绝重新初始化，不用空账本覆盖未知历史。模块需要Linux/macOS上的Node22.13+及node:sqlite；前端SDK平台支持另行验收。

同一五文件快照在Mac与固定Linux/arm64镜像中各10项检查通过，均无跳过、实际退出0；Linux镜像实际Node22.23.3/SQLite3.51.3。真实独立写进程提交后被SIGKILL，已提交数据可恢复、锁释放；被杀写进程未提交的更新回滚。这里只验证进程终止/重启场景，不作硬件断电/文件系统认证。

账本尚未接入SessionRegistry，不能据此宣称整个API已经具备重启幂等或计费不重复保证。下一步是受理意图先持久化、存储失败/提交结果不确定时停止新分配、重启仅隔离/核对原资源而不自动重发create；HTTP/TypeScript SDK、认证连接票据与真实Native整合仍待完成。见`docs/evidence/session-store-ledger.json`。

## 独立八小时v2的中途物理观察

当前运行的已完成样本前缀覆盖1977.946秒、47份样本，按原492548策略独立重算：无绝对上限超标，两种状态各自预热后首5/当前末5的全部10个增长域都在原界限内。这是运行中前缀观察，不是最终平台期或28800秒验收，未修改驱动的最终physical-growth输出、采样或策略；完整八小时继续。

## K1 注册表与账本集成

同一十文件源码快照在Mac及固定Linux/arm64镜像中各49项轻量合同通过，实际退出0，无跳过。新创建的会话、操作与原始区域/TTL默认值及租户幂等键hash必须先原子提交并取得递增修订号确认，provider.create才可执行；账本缺少确认、确认丢失或提交后确认异常都阻止再次分配。已知幂等键在服务默认参数改变后仍查回原操作；已有空/损坏账本不回退成空内存状态。

重启后旧活动记录变为recovery-required，不重置TTL、不重新调用create；核对/关闭原资源后才归还配额，原操作ID和终态保持。创建中、就绪后、释放中三个真实Node进程SIGKILL夹具均验证外部文件资源只分配一次；释放中重启继续原pending释放操作。失败或结果不确定的存储写入使分配与确认查询暂停，清理仍继续，晚到的创建结果收尾后才能移交账本。单库排他锁加注册表所有权令牌拒绝并发控制者与旧令牌写入。

早期两项恢复夹具误把键做JSON字符串哈希，已保留失败源码与说明后修正为接口约定的原始键哈希。以上provider是明确的内存/文件夹具，不等于实际Native资源或真实计费验收。HTTP、TypeScript SDK、认证票据与Native适配仍待完成，K1保持部分实现；正在运行的649文件长测副本未改动。见`docs/evidence/session-registry-persistence.json`。

## K1 后端HTTP控制边界

新增明确配置的HTTP服务工厂与后端key认证器，创建/读取/释放分别授权；租户仅取可信认证结果。工厂要求已确认的持久注册表，异步认证完成及正文完整接收后再次确认状态；请求超时、正文中止或迟到的认证成功均不能启动创建。未结束认证调用在请求超时后仍占额度，避免无界积累。错误只映射固定公开代码/消息，每次响应生成requestId，不回显原始认证/provider异常。

同一13文件快照在Mac与固定Linux/arm64镜像中各62项测试通过，实际退出0且无跳过；真实loopback HTTP响应在持久受理后被客户端故意丢弃，原键重试仍找到同一操作/Session，仅一次夹具资源分配。HTTP parser本身拒绝的报文可能由Node关闭或返回自身响应。可选初始URL默认精确about:blank，不接受其他about变体及file/data/javascript。尚无实际Native provider、Viewer票据或完整SDK发布验收，K1仍部分实现；649文件长测副本未改，八小时未完成。详见`docs/evidence/session-http.json`及`docs/session-control-api.md`。

## K1/K9 后端客户端与类型合同

新增Node ESM客户端及匹配.d.mts声明。prepared创建对象先捕获原始正文/幂等键，调用方修改输入不会改变后续发送；默认不自动重试，显式重试最多三次且保持原键/正文。取消前未派发与派发后结果未知分开，取消不能撤回受理后的资源。响应按流限制大小、校验UTF8/JSON及精确schema/ID/操作类型/状态，请求ID须与header一致；管理请求拒绝重定向，不把原始传输异常/响应凭据附到公开错误。

18文件快照在Mac与固定Linux/arm64镜像中各72项测试通过，无跳过，实际退出0；TypeScript5.9.3同版strict/exactOptionalPropertyTypes/NodeNext/noEmit正反向类型合同也在两平台实际退出0。真实客户端至HTTP/SQLite链路在受理后销毁第一次响应socket，自动重试加手动重发仍仅创建一个夹具Session/操作，查询和释放完成；真实redirect目标未收到管理请求。K9因此从待实现推进为部分实现，41项当前9完成/14部分/18待实现。尚缺Native资源接入、Viewer票据、独立包/Python和完整兼容发布，未把类型和夹具当作这些验收。正在运行的649文件八小时副本不含本轮SDK代码，保持原样。见`docs/evidence/session-client.json`。

## K9 Python asyncio后端客户端

新增Python3.11+带py.typed的独立包源码及不可变dataclass/NewType模型，HTTPX固定0.28.1。原始请求/幂等键捕获后，手动或显式有界重试不改变；默认无自动重试。每次尝试总期限覆盖headers与流读取，取消保留asyncio Task语义并报告未派发/结果未知；客户端自有请求Task、响应流与连接池显式关闭，关闭single-flight，活动请求数有界。不跟随重定向，不传回服务cookie，不使用环境代理；响应逐流限字节并验证schema/ID/类型/状态。

初次严格类型检查发现NoReturn函数残留return语句；另一个真实故障注入发现HTTPX在aiter_raw迭代尾自动关闭时，关闭异常会被泛化为传输异常，后续aclose幂等调用掩盖失败。均已保留原始源码/日志并修复：跟踪实际流关闭结果，清理不确认后禁止新请求，报告固定错误，取消仍保留原Task语义。26文件快照在MacPython3.14.6与Linux/arm64Python3.11.2各16项实际通过，无跳过，退出0；Macmypy1.19.1严格以Python3.11为目标，含正/反向类型合同的3源码文件退出0。原Node72/TypeScript证据按未变源码hash复用。

两个真实Python到Node HTTP/SQLite夹具场景含受理后第一次响应socket销毁：自动重试加手动重发共3次HTTP，仅一次Session分配，原操作ID保持，租户隔离/查询/释放通过；每个夹具进程明确退出0、账本关闭确认且无保留资源。并非实际Native或计费资源验证。包尚未独立构建安装/公开发布，Viewer票据、长任务事件与版本兼容继续；41项保持9完成/14部分/18待实现。Native源码审查确认目前display仍共享可输入授权，真正read/control显示角色需在长测结束后修改Gateway并验证真实呈现。八小时649文件副本不含本轮SDK代码，未修改。见`docs/evidence/session-python-client.json`。

## K9 私有客户端包与安装合同

Node包保留private:true，根与backend ESM导出共享实现及.d.mts类型；Python包明确固定构建后端setuptools80.9.0与py.typed/依赖元数据。已生成4文件tgz和7文件py3-none-any wheel，逐文件比对源码hash，归档不含服务/Native/测试凭据。首次安装夹具把同一空npmrc同时作为用户/全局配置，npm拒绝；原v1失败已保留，v2改为独立文件，SDK包本身未改，复用原构建产物。

31文件v2快照将产物离线装入新npm consumer与Python venv，验证实际import来自安装位置且consumer无SDK源码目录；仅将两处Node合同import改为公开包名，测试主体保持。Mac与Linux/arm64各74项Node/HTTP/SQLite及16项Python实际通过，无跳过、实际退出0；TypeScript通过已安装exports解析且两平台退出0。Mac的mypy通过venv PEP561发现安装包，正反向类型合同退出0；Linux本轮未执行Python安装包类型编译，未把Mac结果冒称双平台类型结果。测试仍为明确provider夹具，Native/Viewer角色/票据、完整长任务/Agent集成、兼容矩阵与公开发布继续。开发预览ZIP保存相同已验证包、说明和校验和；不代表全目标或八小时通过。见`docs/evidence/session-sdk-packages.json`。

## K1 Native worker 生命周期边界

新增私有worker控制通道、Native异步资源包装器及待接入的Linux入口：固定Session/租户/区域/owner-hash在启动前校验，默认32KiB固定输入缓冲，三种有限命令，无URL/key/底层异常回显。资源对象先建立再异步初始化，关闭等待真实启动结果，晚到资源回收且不发布Ready；abort通知前建立single-flight关闭等待点，初始化仍可能分配时的提前closed回执拒绝。owner EOF、信号、失联和独立owner心跳租约触发清理。

关闭中stdout被父端关闭的竞态实际复现：旧版本先撤错误处理器，资源已关闭仍因最后状态写入EPIPE而异常退出；22项中21通过1失败已保留。修复为进程存续期内不捕获Session对象的错误接收器，并改为固定缓冲/解析后清除。测试夹具setup抛错时worker会被回收，叶子也在继承stdin失联后自动结束，避免Root被杀留下测试资源。

同一8文件快照在MacNode26.4与Linux/arm64Node22.23.3各23项合同实际通过，无跳过，退出0；生产Native入口仅语法检查退出0。实际运行的是Node/叶子进程与模拟Native逻辑资源，不是Chromium或完整内核进程集合验收；worker Closed只表示资源close逻辑回执，外层runtime仍必须用持久资源身份核对整个容器/namespace退役。尚未接Registry的实际Native provider、TTL/健康传播、恢复、真实Viewer权限/票据；K1保持部分实现，41项仍9完成/14部分/18待实现。当前649文件独立8小时副本未改，不把本轮合同当作八小时或Native通过。见`docs/evidence/session-worker-boundary.json`及`docs/session-native-worker.md`。

## K1 父端worker通道与8小时v2失败

父端通道已接真实Node worker，固定请求/身份、等待Hello后只发一次Start、自动owner心跳、启动中与Ready后取消、关闭和真实客户端退出分别记录。关闭超时保持uncertain，terminal继续等待真实退出；客户端退出0没有worker Closed不算逻辑关闭，整组Native进程仍需外层runtime证明。首次40项中38通过2失败（退出回调被提前清除、关闭后重复start复用历史Ready）已保留并修复。同一11文件快照Mac/Linux各40项实际通过、无跳过、退出0，Native入口仍仅语法检查；未接实际provider/TTL/健康持久化或Viewer票据。见`docs/evidence/session-worker-channel.json`。

独立8小时v2已真实结束失败，Viewer1/Source0，Docker退出0；第3575轮resize对应的时钟探针前置条件失败。之前/之后viewport254到255、Source仍健康且同一producer，提示重绑定短窗竞态，但原失败未记录binding/PID各字段，尚不认定唯一原因。失败后流停止暴露第二个已确认问题：raw239已旋转到240，后置校准失败使本地previous未前移，disable240又与239比较。三份原始窗口238/239/240均保留，失败窗118帧与清理窗6帧不冒称已校准。

238样本按原492548物理策略重算：绝对上限及两状态共10增长域均在原界内，只是失败前缀分析，不是8小时/最终平台验收。Source81创建81关闭且无Source清理错误，FD19相对baseline20；Mac观察助手39824明确退出0。连续观察清理错误仍作为失败证据保留。下一步修复/真实复现时钟获取与窗口停止；新版本须重新完整检查、600秒基线/丢包预验和独立8小时，不合并旧时间，不替换旧证据。见`docs/evidence/session-coupled-eight-hour-failure-v2.json`及`docs/evidence/session-coupled-eight-hour-v2-completed-prefix-physical.json`。


## 大消息Pong、挂载表读取与当前复验

v11轻丢包试跑的Source退出0、Viewer退出1、容器退出0，原始3秒Ping失败未改成通过。相同实际Rust Gateway在8MiB合成SKP头资源、只读recording票据且不协商资源分块时复现：Pong被未完成的大WS帧挡住，随后原15秒进度看门狗关闭连接。该夹具只证明传输问题，不是网页或像素验收。候选版本保留一个完整逻辑消息的共享所有者，按64KiB片段逐次推进，允许Pong穿插且阻止应用数据插队；片段发送进展用于刷新原看门狗。匹配Pong约131.717ms返回，早于约10.847秒的完整资源接收，内容SHA和后续提交保持，内核记录21次丢包。见[实际弱网收据](evidence/gateway-fragment-kernel-netem.json)。

Mac与实际Linux ARM64各157项Rust通过，固定4线程，保留原200ms关闭上限。此前默认并发的3项失败及两个测试夹具修正均保留，未认定宿主负载是唯一原因。13项原生回归覆盖真实Source、时钟与像素、直播、六消费者、资源池和关闭；14档真实约11MiB图像弱网均通过，含80ms/1%/2Mbit低带宽场景，最慢输入确认约510.6ms，仍低于原3秒。CPU与GPU Viewer均确认黑框中的精确“WebGL 无法显示”字形，普通DOM和Canvas2D更新与删除恢复正常。参见[原生证据](evidence/gateway-fragment-native.json)及[本地产物更新](evidence/gateway-fragment-publication.json)。这些结果不替代持续600秒、8小时、真实公网或全部N1验收。

Linux全量JS回归先因夹具缺少可写产物挂载失败，修正后又复现4369字节mountinfo被内核分成4053和316字节返回。原通用读取器把合法续读误报超限；专用挂载表读取器现在在一个已打开描述符上读到EOF，仍限64KiB并受原5秒期限控制，cgroup采样还比较前后完整挂载表。smaps_rollup及其他进程记录保持单次读取规则。20项相关合同在Mac为11通过/9平台跳过、Linux全部通过；新增UTF8夹具初版提前给EOF的失败也保留。随后同一717文件版本的400项完整JS在Mac为391通过/9平台跳过、Linux为396通过/4平台跳过，实际均退出0，见[读取修复](evidence/linux-mountinfo-short-read.json)与[全量回归](evidence/gateway-fragment-full400.json)。

本轮不改变41项状态：9项在列明范围完成、14项部分实现、18项待实现。实际Native provider的持久资源身份、完整namespace回收、Registry TTL/健康传播、真实只读/控制Viewer票据及SDK公共发布仍待接通；worker逻辑关闭或CLI退出0不能作为整组Native进程已回收的证明。


## K1 共享SQLite运行时意图

新增同库schema v2运行时身份/派发记录，合法v1数据先完整验证再事务迁移，原Session修订号保留，运行时使用独立修订号。固定区域deployment/daemon、私有排他owner、一个Session一个不可改绑容器身份；恢复后原记录只能关闭，不重发create或Ready。已派发但ID不明不能凭查无对象写成已退役，Session的就绪和配额归还要与运行时记录一致。退役记录本身只保存受信任内部证据hash，真实Docker/内核事实仍须后续driver验证。

最终737文件快照在Mac与Linux各46项定向合同通过、无跳过；完整419项均无失败，分别410/415通过及9/4平台跳过。实际Node进程SIGKILL覆盖intent、requested、created、Ready与未提交事务，Ready后的Registry恢复不重复创建；测试资源是明确的外部文件和模拟容器身份。初版错误地查询不存在的Session.region列、其后夹具误用Registry.get的失败均保留并修正。见[运行时意图证据](evidence/session-runtime-intent-store.json)及[worker说明](session-native-worker.md)。

运行时driver/完整namespace退役、实际Native provider及Registry TTL/取消/健康传播、真实read/control显示票据与完整SDK仍未接通。当前720文件独立8小时副本保持原样，不含本服务层修改；没有把数据库或文件夹具当作真实Native关闭证明。41项保持9项列明范围完成、14项部分实现、18项待实现。


## K1 Docker 读取与运行配置基础

新增只读Unix Engine元数据客户端及规范化运行配置/归属/隔离校验，固定daemon、镜像和来源指纹，完整匹配合并环境与私有namespace、只读挂载、能力和资源限制。743文件最终快照的Mac/Linux完整437项均无失败，18项定向合同也全部通过。实际引擎接受配置，元数据夹具从未启动进程，完整ID删除和最终SQLite证据文件原字节hash均确认；全部5次夹具ID已核对不存在。不能据此声明实际进程或Native namespace退役。

首版Mac完整回归有一次原2秒助手启动超时，已回收并保留失败；8个全新路径副本对照均正常，但唯一原因未证明，未修改观察助手或延长期限。最终原4并发回归通过。中间环境补丁编辑未应用的旧版本结果、证据JSON字节hash修正也如实保留，详见[本轮检查点](evidence/session-docker-foundation.json)和[worker边界](session-native-worker.md)。

下一步是B1b实际派发、私有通道、未知创建结果隔离与Node子进程生命周期证明；实际Native集成仍需完整内核/容器回收、Registry TTL/取消/健康和Viewer角色票据。正在运行的720文件独立8小时副本未修改，尚未通过；41项保持9/14/18。

### Session 容器操作会话检查点（B1b1）

新增同一Unix连接上的daemon检查与一次create/start/remove，持久回执先于实际操作、原总期限与限额、断线不重连、结果不确定不重试。20项新合同及实际Node主进程/脱离进程组叶子的私有namespace、安全状态和完整ID移除见证已建立；证据先落盘、账本后退役、配额最后释放。冻结版本和双平台回归见[操作检查点](evidence/session-docker-effects.json)。实际Native provider、私有attach、未知创建恢复、Registry生命周期与Viewer票据仍未完成；独立720文件8小时副本继续运行，不受新增服务代码影响，41项完成计数维持9/14/18。

### Session 私有 attach 前置合同（B1b2a）

新增完整帧后才交付的64KiB有界stdout/stderr复用解码，以及单容器local日志有限轮转配置；实际夹具可写3MiB并留存真实已轮转复用字节，由独立检查器核对。修复本轮发现的嵌套日志配置比较和绝对截止时间timer早触发问题，失败保留，原5秒期限保持。版本与完整结果见[attach前置检查点](evidence/session-docker-attach-foundation.json)。HTTP Upgrade代理、实际worker握手及Native provider尚未接入，不改变41项9/14/18计数，也不改变独立720文件8小时负载。

### Session 私有 attach 代理（B1b2b）

实现有界、实际宿主子进程持有的私有代理；固定同一Unix连接检查daemon/完整ID/隔离后升级，接现有SessionWorkerChannel，真实ChildProcess close与worker确认、完整namespace退役分别处理。19项故障/背压/终止合同通过后，实际Node Docker夹具验证正常关闭、代理丢失及容器移除，完整记录见[代理检查点](evidence/session-docker-attach-proxy.json)。尚待生产provider未知创建恢复、持久回收、Registry生命周期和Native/Viewer集成；41项状态不变，独立8小时未被本次新增代码替代。

### Session 启动前内核见证（B1c0）

固定Linux内核见证接入私有WorkerHello和Native入口，父端在同一Hello期限内核对容器启动代次并持久化后才发Start。私有不可覆盖文件绑定CID/来源/owner哈希及StartedAt，支持不持有原key的关闭恢复核对；异步处理晚到、关闭重入和损坏证据均不能启动资源。结果见[见证检查点](evidence/session-runtime-witness.json)。实际Node夹具与Native浏览器验收分开；生产控制器及41项9/14/18未完成计数保持，独立720文件8小时副本不变。

### 独立8小时v3失败（2026-10-19）

第3200周期Source PSS completeObservedCohort断言失败，Source/Viewer/Docker均实际退出1；最后完整样本8632.77秒、211份样本不能替代28800秒。原RPC只保留异常栈，失败逐进程数据缺失，唯一原因未证明。完整保存[失败证据](evidence/session-coupled-eight-hour-v3-failure.json)，保持原物理/群组/期限门槛且未重启；先补诊断和定位。新服务层765文件首版已独立通过Node合同，随后补齐证据目录创建的父目录fsync边界并重新冻结；Native浏览器集成及41项仍待最终验收。
