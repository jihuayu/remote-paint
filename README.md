# Remote Paint：阶段 A 原型

真实 Chromium 执行网页，导出一层 Skia Picture，独立 CanvasKit 重放。当前捕获工具限定静态、单绘制层、无 iframe、无滚动偏移的视口；发现不支持的层结构会拒绝导出。

直接打开已验证样例（不需要在服务端安装 Chrome）：

```sh
npm ci
npm run demo
```

打开终端输出的完整 Viewer 链接。此样例来自真实 Chrome 导出，不是合成 SKP；捕获文件在 `examples/verified-capture/`，对照结果在 `docs/evidence/`。

重新捕获和运行：

```sh
npm ci
# macOS 自动使用已安装 Chrome；其他系统先设置路径，或 npx playwright install chromium
export CHROME_EXECUTABLE_PATH=/path/to/chrome
npm run capture
npm start
# 打开终端输出的带 #key=... 的 Viewer 链接
```

不设置浏览器路径时，macOS 优先使用 Google Chrome，其余使用 Playwright 的 Chromium。产物位于 `artifacts/capture/`：`manifest.json`、内容寻址的 `.skp` 和服务端 `server.png`。可以用 `--url http://... --output artifacts/custom` 捕获自己的简单页面。

捕获通过真实 `chrome.gpuBenchmarking.printToSkPicture()` 完成，非截图转矢量。调试导出需要 `--enable-gpu-benchmarking --no-sandbox`；工具启动临时、独立的浏览器 Profile，仅用于本机实验，不作为生产 Worker 的启动配置。

字体和 PNG 内嵌 SKP。测试页的 Noto Sans SC 字体子集随项目分发，遵循 `tests/fixtures/OFL.txt`。系统中文、Emoji 字体可能让 SKP 膨胀至数百 MiB，因此导出设有 16 MiB 上限。原生字体子集化尚未实现。

锁定 CanvasKit npm 版本及 Wasm SHA-256，记录实际 Chromium revision 与 SKP 格式版本；这是不同 Skia 构建间的实验，不能替代生产环境的同 revision 构建。

Viewer 的 Wasm、脚本、样式全部由本机服务提供。HTTP 仅监听 `127.0.0.1`，WebSocket 检查随机连接密钥和同源 Origin。每条连接独立进行握手、资源传输和整帧提交；断线后“重新连接”重建完整快照。当前不提供公网入口、Steel 会话鉴权或用户输入。

服务端只发送 SKP 二进制与场景元数据；不向 Viewer 发送源页面 HTML、JS、URL 或对照截图。SKP 内的字体、图片解析仍是原生 Wasm 解码面，大小限制和 SHA-256 不等于已实现安全隔离。

验证命令：

```sh
npm test        # 协议原子提交、错误输入、连接密钥、版本、资源校验
npm run verify # 实际 Chrome → 文件 → WebSocket → 浏览器 Wasm → PNG 对照
```

完整结果和证据限制见 [探索结论](docs/findings.md)，实时捕获和 Steel 的后续拆分见 [实施路线](docs/roadmap.md)。
