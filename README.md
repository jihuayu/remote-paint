# Remote Paint：原生网页远程绘制

源 Chromium 执行网页 JS、DOM 和布局；原生组件录制光栅化前的 SKP，按同一 captureId 与真实 aggregated Viz 场景配对；独立 Viewer 用 CanvasKit 重放。绘图流只包含 SKP 和场景元数据，源 HTML、JS、URL、Cookie 及对照截图不发送给 Viewer。

本次范围为路线 **3–7**，并扩展到 Mac 本机 Docker 中的 Linux ARM64、BeginFrame 和输入延迟优化。Linux 浏览器正在编译，完整 Linux 及 Mac Viewer 远控验收仍待运行；现有 Mac 结果在下方单独标明。iframe/复杂效果回退、Steel/Gateway 接入和生产解码隔离尚未实现。

## 当前验收状态

- **3 字体和图片**：真实动态页面新增中文、罕见字、Emoji；原 glyph/位置和字体子集重放，bitmap 字形保留源像素，认证/blob 图片内部像素一致。
- **4 原生捕获**：完整定制 Chromium 已构建并运行。隔离世界 API、错误 token 拒绝、无 Viewer 零采集、后台编码和真实 Unix IPC 均通过。[原生捕获报告](docs/evidence/native-capture-report.json)
- **5 内容与合成映射**：实际 Viz 场景配对，固定头部与 0/700/0 滚动正确，内容 hash/revision 复用；全页超过 24/255 通道误差的像素约 1.37%–3.00%。[场景报告](docs/evidence/native-scene-report.json)
- **6 动态增量和恢复**：原生 SKP 经真实 WS 重放；计数和流式文字更新、合成动画资源复用、慢客户端隔离、重连、导航、resize 和实际丢 SKP 后关键帧恢复通过。[完整动态报告](docs/evidence/native-live-report.json)
- **7 输入与控制租约**：真实源页面和动态 Viewer 通过鼠标、滚轮、键盘、中文 composition、粘贴、删除、选区替换、富文本、CSS 坐标缩放、交接及旧标签拒绝，83 条输入。[原生输入报告](docs/evidence/native-input-report.json)

完整动态对照全页差异为 1.37%；流式文字区域 2345 个强墨迹像素全部获得邻域覆盖，并验证去掉文字会失败。导航/resize 中断了两次在途捕获，后续新 epoch/viewport 均恢复，最终错误状态为空。CanvasKit 实际像素缓冲分配/释放为 202/202、残留 0。[资源生命周期报告](docs/evidence/surface-lifecycle-report.json) 保留的 fixture 报告仍只证明各自契约。

最新 Mac 原生测试修复了合成光标继承圆角裁剪时持续停帧的问题。正常 6 px 圆角和可见光标下，两种采集模式各 16 次输入均成功显示，采集错误为零。输入触发采集的中位延迟为 203.5 ms，周期采集为 222.5 ms；p95 为 340.1 / 278.0 ms，本次尾延迟未改善。测试期间 Linux 编译占用九核，物理键盘和显示扫描不在测量范围。[独立对照报告](docs/evidence/mac-input-latency-rounded-clip.json) 与 [重放画面](docs/evidence/mac-input-latency-rounded-replay.png) 只证明 Mac 链路；Linux 的构建、缓存与独立验收命令见 [Docker 说明](docker/README.md)。

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

打开终端输出的完整 Viewer 链接（含 `#key=`）。默认测试页含动态计数、CSS 合成动画、中文/Emoji 流式追加、认证及 blob 图片、表单、富文本和长列表。点击“接管操作”后操作画面；“交还 Agent”恢复受管 Agent 输入。没有 Viewer 时停止额外采集，源网页继续运行。

动态版本必须使用自编译的 `captureRemotePaint` API，普通 Chrome 会明确报错。本机使用 `--in-process-gpu`，GPU/Viz 位于浏览器进程，Renderer 保持独立进程；独立 GPU 子进程启动在本机未通过。项目保留软件 raster 对照路径；图片以浏览器驻留像素编码进 SKP，不从 Viewer 访问源站。GPU 图片、子 Surface、3D 排序、复杂 masks/filters 会明确拒绝，未声称覆盖所有网页。

## 验证

```sh
npm test                # 协议、缓存、IPC、场景合成、控制权并发及旧输入检查
npm run verify:fonts    # 活页面新增字形 + 原生字体/图片序列化与像素对照
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

HTTP 仅监听 loopback，WS 检查随机密钥和同源 Origin，最多 4 个 Viewer；每个 Viewer 仅一帧等待 ACK，超时关闭后从关键帧重连。资源、帧、pass、quad、解码缓存和输入队列都有边界。见 [动态协议](docs/live-protocol.md)。

此原型使用临时浏览器 Profile 和调试开关，不作为生产 Worker 启动配置。受管 Agent 接口为 `source.control.agent(event)`；外部任意 CDP、现有 Steel 会话与跨 Session 鉴权尚未接入。SKP 原生解码隔离及模糊测试属于后续路线 10。

## 保留的阶段 A

```sh
npm run demo:static     # 已验证的静态单层样例
npm run capture         # 普通 Chrome 导出简单静态页面
npm start               # 展示 artifacts/capture
npm run verify          # 静态链路回归
```

静态导出仍限定无 iframe、无滚动偏移、单绘制层；它与动态 API 分开。测试字体遵循 `tests/fixtures/OFL.txt`；其他依赖与系统字体授权说明见 [原生说明](native/README.md)。
