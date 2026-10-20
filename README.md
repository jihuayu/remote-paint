# Remote Paint：原生网页远程绘制

源 Chromium 执行网页 JS、DOM 和布局；原生组件录制光栅化前的 SKP，按同一 captureId 与真实 aggregated Viz 场景配对；独立 Viewer 用 CanvasKit 重放。绘图流只包含 SKP 和场景元数据，源 HTML、JS、URL、Cookie 及对照截图不发送给 Viewer。

本项目覆盖路线 **3–7**，并扩展到 Mac 本机 Docker 中的 Linux ARM64、BeginFrame 和下述 1–8 项优化。升级前完整验收保留为[历史基线](docs/evidence/linux-arm64-mac-acceptance.json)，新版验证进度见下一节。iframe/复杂效果回退、Steel/Gateway 接入和生产解码隔离尚未实现。

WebGL 区域暂显示黑框和“WebGL 无法显示”，其余 DOM 可正常显示和更新。该路径已通过真实 Linux 原生链路；WebGL 图像本身尚未传输，其他未知纹理仍明确报错。证据及后续兼容范围见 [WebGL 兼容性边界](docs/webgl-boundary.md)。

## 原生数据面升级（2026-10-16）

1–8 项优化和原生 Broker/Gateway 已落到代码，设计、协议和每项验证入口见 [原生数据面说明](docs/native-data-plane.md)。默认使用 Rust SceneMapper/资源去重/WS Peer，Chromium 通过常驻二进制 IPC 直接传送场景和原始 SKP；Node 负责控制面。Viewer 的 WS、校验、CanvasKit 和 OffscreenCanvas 在 Worker 中运行。

完整 Ninja 图已编译、链接并通过无待构建项检查，Linux ARM64 的 serializer、BeginFrame、native、scene、input、live、latency 七项验收全部返回 0；60 个单元测试在 Mac 和 Linux Node.js 22 均通过。正式浏览器的完整 Mac Worker 验收也通过，含单/双 Viewer、图文像素、真实输入、IME/CDP、滚动、导航/resize、重连及丢资源恢复。[最终验收及逐项核对](docs/native-final-acceptance.md)链接完整收据和报告。

正式产物中，16 次真实输入到 Mac CanvasKit 像素的 p50/p95 为 **48.8/57.8 ms**，单 Viewer **47.6 FPS**，双 Viewer 各 **47.1/47.6 FPS**；每 Peer 约 **0.98–1.02 MB/s**。Node/Broker/Chromium 分别约 **0.18–0.21 / 0.11–0.12 / 0.49–0.55 核**。Node 中的绘图资源记录和 Viz 场景均为零，稳定输入和 BeginFrame 错误均为零。**尚未达到 30 ms**；两秒帧率窗口和 16 次输入不能代表所有网页或物理显示延迟。[正式 Mac 报告](docs/evidence/native-mac-final.json)与早先[登记时序探针](docs/evidence/native-capture-registration.json)分别保留，**下方报告均为升级前基线**。

先执行 `npm run native:broker` 构建当前宿主机的 Broker。Linux 版本必须单独构建为 AArch64 ELF，通过 `REMOTE_PAINT_BROKER` 指定；运行容器需要同时映射 UI 4176 和原生 WS 4177。`REMOTE_PAINT_DATA_PLANE=node` 可切换兼容路径，`?mainThread` 可切换主线程 Viewer。

Rust Broker 的共享资源分配池默认768MiB，可通过 `REMOTE_PAINT_RESOURCE_POOL_BYTES` 设置64MiB至2GiB的字节数；较小配额可能拒绝默认支持的大工作集。额度随缓存、快照及发送别名的最终资源引用释放，压力时暂停显示采集并等待回收，页面时钟继续。该池不包含输入解析、Snapshot JSON、WebSocket发送复制或完整进程内存，验收边界见[资源池证据](docs/evidence/broker-resource-pool.json)。

Viz/RPA 输入另有默认256MiB的共享池，`REMOTE_PAINT_INPUT_POOL_BYTES` 可设置1MiB至1GiB。完整包分配前准入，元数据在解析前预留保守额度，raw SKP 在复制前进入资源池；压力拒绝会排空对应包并保持连接与其他已完成捕获。该范围不含 stdin RPC、Node 请求队列或完整进程内存，见[输入池证据](docs/evidence/viz-input-pool.json)。

Node 请求路径默认保留512MiB数据额度和4MiB控制额度，分别由 `REMOTE_PAINT_NODE_REQUEST_BYTES`（1MiB至2GiB）和 `REMOTE_PAINT_NODE_CONTROL_BYTES`（256KiB至16MiB）配置。序列化前准入，直接生成单个独立包 Buffer；最多48个数据归属、64个总归属。包保留至管道写完，入参估计保留至响应处理后；只接受无 getter、`toJSON` 或 Proxy 的普通 JSON 数据，id/op 为保留字段。控制额度不代表能越过已进入同一 stdin FIFO 的字节，VM/GC与响应解析仍不在本范围，见[Node请求证据](docs/evidence/node-request-budget.json)。

Node 响应接收与解析临时区默认保留768MiB数据、8MiB控制额度，分别由 `REMOTE_PAINT_NODE_RESPONSE_BYTES`（1MiB至2GiB）和 `REMOTE_PAINT_NODE_RESPONSE_CONTROL_BYTES`（256KiB至16MiB）配置。到达的完整底层缓冲区另受2MiB上限约束；单个响应使用一个精确大小的独立Buffer，解析前按字节和结构节点预留保守额度。数据拒绝后排空该包并保留后续RPC；控制预留不改变stdout FIFO。调用者继续持有的场景/字符串、Readable内部和VM/GC不在此临时区范围，见[Node响应证据](docs/evidence/node-response-transients.json)。

Rust Snapshot另有默认256MiB预算，`REMOTE_PAINT_SNAPSHOT_BYTES` 可配置1MiB至1GiB。构造前保留场景/元数据、Mapper逻辑条目与暂存估计，快照额度随最后一个Arc引用归还；reset不会提前释放Peer在途或ACK基线的引用。scene JSON先有界计数，再写入一个精确大小的缓冲区。该池尚不包含RPC/Gateway输出副本、asset临时JSON或完整进程内存，见[Snapshot归属证据](docs/evidence/snapshot-graph-pool.json)。

Rust RPC输出另有128MiB数据、8MiB控制包预算，分别由 `REMOTE_PAINT_RPC_OUTPUT_BYTES`（1MiB至2GiB）和 `REMOTE_PAINT_RPC_OUTPUT_CONTROL_BYTES`（256KiB至16MiB）配置。映射回复直接借用快照字段，先有界计数，再分配含包头的单个精确缓冲区，额度保持至实际写入和释放完成。数据准入失败可用预留控制额度返回关联错误；此时Mapper可能已提交。该范围不含已有控制/Gateway对象的构造、Node流或完整进程内存，见[RPC输出证据](docs/evidence/rpc-output-packets.json)。

Broker关闭时还会丢弃已排队的stdout/stderr缓冲：先停止流，再按小块读取清空，不解析或交付丢弃数据。Mac Node26与Linux Node22下，保留已关闭Broker/流对象的强制GC验证通过；这不代表自然GC或整体RSS归还，见[流关闭证据](docs/evidence/node-readable-close.json)。

资源清单直接借用已校验的chunk元数据序列化，先申请精确UTF-8缓冲区额度，再分配和写入；描述升级共享原始数据并保持旧快照不变。范围检查不再构造临时section列表，见[资源清单证据](docs/evidence/asset-manifest-owners.json)。

原生Control、PeerStats与Viz事件直接借用调用方字段，不再复制包装用的JSON对象；字段和错误码保持兼容，已有输出包预算仍保持到实际写入完成，见[事件序列化证据](docs/evidence/borrowed-native-events.json)。

WebSocket JSON解析另有默认128MiB共享额度，由 `REMOTE_PAINT_WEBSOCKET_JSON_BYTES`（1MiB至1GiB）配置。解析前计价，额度随解析图释放；额度不足时关闭该连接为1013，握手图在校验后释放。该范围不含Tungstenite原始缓冲区和发送队列，见[解析图证据](docs/evidence/websocket-json-graphs.json)。

待发送控制命令只借用原RPC对象，序列化一次进入精确UTF-8缓冲区。默认32MiB普通额度、1MiB关闭额度，分别由 `REMOTE_PAINT_COMMAND_QUEUE_BYTES`（64KiB至256MiB）和 `REMOTE_PAINT_COMMAND_CLOSE_BYTES`（64KiB至16MiB）配置；64个普通槽之外保留独立关闭槽。内部库缓冲另行计费，见[发送队列证据](docs/evidence/outgoing-command-owners.json)。

WebSocket库缓冲另有默认512MiB共享额度，由 `REMOTE_PAINT_WEBSOCKET_BACKING_BYTES`（8MiB至2GiB）配置；HTTP解析前预留固定额度，发送缓冲按容量增长余量预留到连接销毁，收包别名保持独立额度。角色额度不足返回HTTP503，读额度不足关闭1013；固定额度不足会在HTTP解析前关闭TCP。该范围不含OS、线程栈、其他Gateway构造或完整RSS，见[库缓冲证据](docs/evidence/websocket-library-backing.json)。

Gateway场景、delta和通知直接借用原字段生成一次最终UTF-8包；默认128MiB数据、8MiB控制额度，分别由 `REMOTE_PAINT_GATEWAY_PACKET_BYTES`（64KiB至2GiB）和 `REMOTE_PAINT_GATEWAY_CONTROL_BYTES`（64KiB至32MiB）配置。delta缓存内容和固定后备保持收费；压力查询会淘汰可回收内容，reset清内容，stop释放后备。发送包见[Gateway发送包证据](docs/evidence/gateway-packet-owners.json)。Gateway长期config改为移动原图；registry、路由和每peer容器/临时索引预留额度，默认512MiB状态池，由 `REMOTE_PAINT_GATEWAY_STATE_BYTES`（1MiB至2GiB）配置，现有peer继续捕获与新peer准入分别报告。密集小分段可使用已有完整资源格式，正常分块共享保留。见[Gateway状态证据](docs/evidence/gateway-state-owners.json)；普通2Dcanvas记录已补齐；完整Session/RSS仍待补。

Mapper首次映射前为持久缓存索引、Weak目标分配块和有界哈希/排序/统计临时分配预留16MiB；默认64MiB池由 `REMOTE_PAINT_MAPPER_INDEX_BYTES`（1MiB至1GiB）配置。小于16MiB会在首次保留前明确拒绝。clear保留后备和额度，reset真正释放哈希桶后归还；既有Mapper的就绪与新Mapper准入分别报告。见[Mapper索引证据](docs/evidence/mapper-index-owners.json)。这不代表原生、VM或完整Session物理内存验收。

客户端内存准入改为增量计数，普通固定buffer路径不再遍历全部owner。快照校准backing，压力前复核，可变buffer每次检查；新增聚合索引元数据单独计费，原档位上限不变。release回调也会解除返回buffer的引用，避免关闭后句柄继续保留数据。见[增量记账证据](docs/evidence/client-memory-incremental-ledger.json)。微基准不代表帧延迟或完整物理内存验收。

普通 Canvas 2D 已增加同帧 SharedImage/SKP采集，保留透明度、变换、裁剪和层级。像素副本每renderer默认256MiB，REMOTE_PAINT_CANVAS_PIXEL_BYTES可设32MiB至2GiB；单图保留8192维度/64MiB解码上限。超限后重试且页面时钟持续运行，临时图像不进长期图片缓存。见[Canvas采集证据](docs/evidence/canvas-native-capture.json)。ANGLE SwiftShader GPU API已验，物理GPU/Mac原生与同步回读性能待验。

映射前 tile/WebGL 展开新增分配也已先准入：REMOTE_PAINT_EXPANSION_BYTES 默认128MiB，可设1MiB至1GiB。完整额外字段复制、生成字段和输出向量按保守布局收费，ExpandedCapture 持有到映射结束；原始输入/SKP、Snapshot和完整VM另计。最后一个可见tile移动原quad，输出Vec直接移动，保留2048quad上限。见[展开归属证据](docs/evidence/capture-expansion-owners.json)。

原生录制缓存现只保留标量录制键，不再长期持有RasterSource、SkPicture及其图片/字体引用。索引默认每渲染进程8MiB，REMOTE_PAINT_RECORDING_INDEX_BYTES可设64KiB至256MiB，每个宿主先准入64KiB；额度不足仍完整重录。编码被淘汰后从当前Source恢复，活跃Source/瞬时编码和完整VM另计。见[录制索引归属证据](docs/evidence/native-recording-index-owners.json)。

原生RPA与CDP timing合并现在直接移动已有键和值，保持浅层覆盖；畸形目标对象返回错误并保留Mapper状态，不再令Broker退出。旧复制样本本已受输入额度覆盖，本轮不新增预算或修改额度。见[timing归属与异常恢复证据](docs/evidence/native-timing-owner-transfer.json)。


消费需求分为显示、观察、录制和页面运行。服务端可用 `live.source.acquirePageRun({signal})` 取得可重复释放的页面运行租约（最多128个）；Linux外部BeginFrame模式下，它推进RAF而不编码绘图流。受管 `source.control.agent()` 输入在执行期间自动持有该租约。全部租约和绘图消费者退出后，外部时钟停止。

原生数据面提供服务端 `await live.createConsumerTicket('observation')` 或 `await live.createConsumerTicket('recording')`，返回单次、10秒有效、绑定Source和Origin的只读WS凭据，不包含Viewer主密钥。签发本身不触发采集，完成Hello后才增加对应需求；观察只接收请求后的新captureOrdinal及已处理输入，页面或viewport改变时以1012关闭，录制可跨导航/resize。保留4个显示端额度，另有合计2个观察/录制端；待用票据最多8个，沿用既有字节预算。只读端不能接管、注入输入或接收编辑反馈；消费完成后以 `consumer-released` ACK归还在途帧额度，仍须保留当前delta基线所引用的资源。该ACK不代表屏幕呈现或网页业务完成。关闭WS释放消费需求；关闭Live撤销待用票据和活动连接。Node兼容数据面明确拒绝此接口。完整Session/租户SDK另按清单实施。

## 后续优化与产品化

客户端、SDK、服务器与公网优化的验收标准见 [完整优化清单](docs/optimization-backlog.md)，本地实现及实测状态见 [实施进度](docs/optimization-progress.md)。

云端任务、Steel 接入、账号凭据、多 Agent、人工接管、隔离与计费，以及首版上线顺序，见 [云 Agent 产品路线](docs/cloud-agent-product.md)。

## Linux 双架构安装包

公开仓库的 [Linux packages Actions](https://github.com/jihuayu/remote-paint/actions/workflows/linux-packages.yml) 支持手动运行和 `v*` 标签触发，分别编译 ARM64、x86_64，并把包含定制 Chromium、Rust Broker、Node.js 和 Viewer 的完整包上传到运行页面的 Artifacts。校验、启动、缓存续编和系统依赖见 [Linux 安装包说明](docs/linux-packages.md)。工作流是否通过与实际下载产物以对应运行页面为准。

## 升级前验收基线

- **3 字体和图片**：真实动态页面新增中文、罕见字、Emoji；原 glyph/位置和字体子集重放，bitmap 字形保留源像素，认证/blob 图片内部像素一致。
- **4 原生捕获**：完整定制 Chromium 已构建并运行。隔离世界 API、错误 token 拒绝、无 Viewer 零采集、后台编码和真实 Unix IPC 均通过。[原生捕获报告](docs/evidence/native-capture-report.json)
- **5 内容与合成映射**：实际 Viz 场景配对，固定头部与 0/700/0 滚动正确，内容 hash/revision 复用；全页超过 24/255 通道误差的像素约 1.37%–3.00%。[场景报告](docs/evidence/native-scene-report.json)
- **6 动态增量和恢复**：原生 SKP 经真实 WS 重放；计数和流式文字更新、合成动画资源复用、慢客户端隔离、重连、导航、resize 和实际丢 SKP 后关键帧恢复通过。[完整动态报告](docs/evidence/native-live-report.json)
- **7 输入与控制租约**：真实源页面和动态 Viewer 通过鼠标、滚轮、键盘、中文 composition、粘贴、删除、选区替换、富文本、CSS 坐标缩放、交接及旧标签拒绝，83 条输入。[原生输入报告](docs/evidence/native-input-report.json)

完整动态对照全页差异为 1.37%；流式文字区域 2345 个强墨迹像素全部获得邻域覆盖，并验证去掉文字会失败。导航/resize 中断了两次在途捕获，后续新 epoch/viewport 均恢复，最终错误状态为空。CanvasKit 实际像素缓冲分配/释放为 202/202、残留 0。[资源生命周期报告](docs/evidence/surface-lifecycle-report.json) 保留的 fixture 报告仍只证明各自契约。

最新 Mac 原生测试修复了合成光标继承圆角裁剪时持续停帧的问题，并优化输入触发采集和 CanvasKit 的 Alpha 合成。正常 6 px 圆角和可见光标下，16 次输入均成功显示，采集错误为零；Viewer 重放从约 54 ms 降到约 6.3 ms。最终输入到像素中位数为 148.5 ms、p95 为 191.9 ms，周期采集基线为 222.5 / 278.0 ms。测试期间 Linux 编译占用九核，物理键盘和显示扫描不在测量范围。[最终 Mac 延迟与动态验收](docs/evidence/mac-direct-presentation.json) 同时记录了 83 条输入、91 次动态采集和丢资源恢复；[重放画面](docs/evidence/mac-direct-presentation-replay.png) 只证明 Mac 链路。Linux 构建、缓存与独立验收命令见 [Docker 说明](docker/README.md)。

最新 Linux ARM64 运行收据确认 ELF/AArch64 `headless_shell` 已链接，Linux serializer、BeginFrame、原生 Viz、场景、输入、live 和 latency 套件全部返回 0。Mac ARM64 Viewer 动态重放 Linux ARM64 输出，增量帧、输入、导航/resize、断线恢复和丢资源关键帧恢复均通过；本次跨平台输入延迟优化后 p50/p95 为 152.5/226.9 ms，CanvasKit 重放约 6.9 ms。Linux demo 由 watcher 保持在 `http://127.0.0.1:4176/`，构建产物和缓存位于宿主机挂载的 `work/linux-build/`。

## 构建与启动动态版本

需要 Apple Silicon macOS、完整 Xcode（含 Metal Toolchain）、Node.js 22+ 和已同步依赖的 pinned Chromium checkout。原生构建说明见 [native/README.md](native/README.md)。

```sh
npm ci
npm run native:chromium -- --source /absolute/path/to/chromium/src --jobs 6
export REMOTE_PAINT_CHROMIUM=/absolute/path/to/chromium/src/out/RemotePaint/headless_shell
npm run demo
# 或绑定自己的普通网页
npm run demo -- --url http://127.0.0.1:3000
```

打开终端输出的完整 Viewer 链接（含 `#key=`）。默认测试页含动态计数、CSS 合成动画、中文/Emoji 流式追加、认证及 blob 图片、表单、富文本和长列表。点击“接管操作”后操作画面；“交还 Agent”恢复受管 Agent 输入。没有绘图消费者时停止额外采集；页面运行租约可单独推进RAF。

默认动态Source使用自编译浏览器的私有 `remotePaintSubscription` v2 与 cadence v1 API，由浏览器持续采集、Rust自主映射发布；Node继续驱动Linux页面时钟和处理输入/生命周期，不再逐帧登记捕获或调用map/publish。`REMOTE_PAINT_DATA_PLANE=node` 显式选择沿用 `captureRemotePaint` 的Node回退，普通Chrome仍不支持这些私有接口。本机使用 `--in-process-gpu`，GPU/Viz 位于浏览器进程，Renderer 保持独立进程；独立 GPU 子进程启动在本机未通过。项目保留软件 raster 对照路径；图片以浏览器驻留像素编码进 SKP，不从 Viewer 访问源站。GPU 图片、子 Surface、3D 排序、复杂 masks/filters 会明确拒绝，未声称覆盖所有网页。

当前正式运行验收覆盖Linux ARM64受管Source：76项C++、Mac/Linux各221项JS及正式浏览器/Broker的完整直播、Node回退、WebGL占位、大资源和清理合同通过，见[正式产物证据](docs/evidence/native-source-default-acceptance.json)。Linux Broker需使用[对应平台的路径](docker/README.md#rust-broker-binary)。Mac Broker的协议和JS检查不等于Mac Source浏览器验收；标准构建图/双架构发布及其他兼容、完整内存和八小时条件见[优化进度](docs/optimization-progress.md)。

## 验证

```sh
npm test                # 协议、缓存、IPC、场景合成、控制权并发及旧输入检查
npm run verify:fonts    # 活页面新增字形 + 原生字体/图片序列化与像素对照
npm run native:broker   # 构建当前平台的 Rust 数据面
npm run verify:viewer   # 实际 Viewer/WS 生命周期（明确的绘图 fixture）
npm run verify:input    # 实际输入/CDP边界；设置原生路径则使用动态绘图
# 以下要求上面的 REMOTE_PAINT_CHROMIUM
npm run verify:native   # token、需求门控、异步编码与 Viz 配对
npm run verify:scene    # 固定头部、0/700/0滚动、合成动画与 Chrome 像素对照
npm run verify:live     # 完整动态链路、字形更新、动画复用、慢客户端、导航/重连/resize
npm run verify:latency  # 正常圆角/光标，按键到真实重放像素的延迟
```

文字重放沿用服务器的 glyph 和字形位置。字体子集与原字体存在已测量的抗锯齿容差；[字体/图片报告](docs/evidence/font-image-report.json) 标明其普通 Chrome 导出与原生 helper 范围，完整动态证据见上方独立报告。中文 IME 验证使用真实本地及远端 CDP composition；物理系统候选窗口和光标定位尚未验收。`lastProcessedInputSeq` 表示已处理的输入，不保证业务操作成功。

## 版本和边界

固定 Chromium `a49e2e3d4addfd84e765b52afe230bedb81096db`、Skia `29ed1e87a0a50f3d8347e988842d9d59e7573efa`、SKP 110、CanvasKit 0.42.0 和 Wasm SHA-256。Wasm 随本机服务发布，握手不匹配会拒绝。

HTTP仅监听loopback，WS检查随机密钥和同源Origin，最多4个显示Viewer，另有2个受票据与目标栅栏约束的只读消费槽位。支持的客户端协商最多6帧、16MiB与512项资源窗口，单个大关键帧可独占窗口并受原帧预算约束；最老未ACK帧默认5秒超时，旧客户端保留单帧兼容。控制连接独立于32KiB资源块，重连建立新基线。资源、帧、pass、quad、解码缓存和输入队列都有边界。见 [动态协议](docs/live-protocol.md)。

此原型使用临时浏览器 Profile 和调试开关，不作为生产 Worker 启动配置。受管 Agent 接口为 `source.control.agent(event)`；外部任意 CDP、现有 Steel 会话与跨 Session 鉴权尚未接入。SKP 原生解码隔离及模糊测试属于后续路线 10。

## 保留的阶段 A

```sh
npm run demo:static     # 已验证的静态单层样例
npm run capture         # 普通 Chrome 导出简单静态页面
npm start               # 展示 artifacts/capture
npm run verify          # 静态链路回归
```

静态导出仍限定无 iframe、无滚动偏移、单绘制层；它与动态 API 分开。测试字体遵循 `tests/fixtures/OFL.txt`；其他依赖与系统字体授权说明见 [原生说明](native/README.md)。


Rust stdin RPC还可配置 `REMOTE_PAINT_RPC_INPUT_BYTES`（默认512MiB，1MiB–2GiB）及 `REMOTE_PAINT_RPC_CONTROL_BYTES`（默认4MiB，256KiB–16MiB）。控制池内保留64KiB固定扫描余量；90MiB数据/256KiB控制包上限保持不变。额度包含实际raw Vec容量和保守serde解析余量；不包括Snapshot、输出复制或整个进程。完整坏JSON/不支持的孤立UTF16会按请求ID拒绝并保留后续包；中断字节帧无法重同步。预留控制额度不改变单stdin FIFO和串行处理语义。
