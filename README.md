# Remote Paint：单台 macOS 上的动态网页重放

源 Chromium 执行网页 JS、DOM 和布局；原生组件录制光栅化前的 SKP，按同一 captureId 与真实 aggregated Viz 场景配对；独立 Viewer 用 CanvasKit 重放。绘图流只包含 SKP 和场景元数据，源 HTML、JS、URL、Cookie 及对照截图不发送给 Viewer。

本次范围为路线 **3–7**。Linux、跨设备、iframe/复杂效果回退、Steel/Gateway 接入和生产解码隔离不在本次范围。

## 当前验收状态

- 动态字形子集及认证/blob 图片：真实 Chrome + 原生序列化器 + CanvasKit 对照通过。
- 原生捕获与 Viz 配对：相关 C++ 文件全部通过 pinned Chromium 编译，cc/renderer GN 头文件依赖检查通过；**完整浏览器构建及原生运行验收仍在进行**。
- 增量、原子提交、缓存释放、慢客户端、重连：实际 WebSocket 和浏览器 Viewer 通过，绘图输入为明确声明的 SKP fixture。
- 输入与控制租约：真实源 Chrome 和 Viewer 通过鼠标、滚轮、键盘、中文 composition、粘贴、删除、选区替换、富文本、CSS 坐标缩放、交接及旧标签拒绝；这次输入边界验收的显示仍使用 fixture。

以上边界分别记录于 [验收证据](docs/evidence/)；fixture 验证不代表原生动态显示已经验收完成。

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

动态版本必须使用自编译的 `captureRemotePaint` API，普通 Chrome 会明确报错。项目保留软件 raster 对照路径；图片以浏览器驻留像素编码进 SKP，不从 Viewer 访问源站。GPU 图片、子 Surface、3D 排序、复杂 masks/filters 会明确拒绝，未声称覆盖所有网页。

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
```

文字重放沿用服务器的 glyph 和字形位置。字体子集与原字体存在已测量的抗锯齿容差；具体像素阈值和结果见 [字体/图片报告](docs/evidence/font-image-report.json)。中文 IME 验证使用真实本地及远端 CDP composition；物理系统候选窗口和光标定位尚未验收。`lastProcessedInputSeq` 表示已处理的输入，不保证业务操作成功。

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
