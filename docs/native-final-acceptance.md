# 完整原生链路验收（2026-10-16）

本次使用完整 Ninja 图链接的 Linux ARM64 Chromium，已通过无待构建项检查；不是早先三个对象重链的探针。Node 保留 Session、鉴权、控制租约、CDP 输入和页面生命周期；C++ 采集经常驻二进制 IPC 直接进入 Rust SceneMapper、资源缓存和 WebSocket Gateway，再由 Mac CanvasKit Worker 重放。

- [Linux 七项套件、构建收据和运行代码哈希](evidence/native-linux-arm64-final.json)：serializer、BeginFrame、native、scene、input、live、latency 均退出 0。
- [正式 Mac 完整报告](evidence/native-mac-final.json)：实际 Linux 源页面与 Mac ARM64 Chrome Worker，含完整运行指标。
- [原生 serializer 6/6](evidence/native-final-serializer.log)、[Rust 协议、资源、tile、Gateway 契约](evidence/native-final-contracts.log)：后者的绘图输入是 fixture，单独标明范围。
- 60 个单元测试分别在 Mac 与 Linux Node.js 22 全部通过。

`headless_shell` SHA-256 为 `eaaaf5f70f6e8b1e9fc94a727827e13a5f00d295b2748d60d08c251e0a465426`；运行容器中的文件与收据一致。Broker SHA-256 为 `f1dc5ccc2ec23cf9db544f44d3394f7a879a22be390906212b0ec9d19c3fee99`。构建使用 pinned Ninja 1.13.2、9 个编译槽、48 GiB 上限，完整 source/output/Cargo 缓存仍保留在宿主机。

| 要求 | 代码与证据 | 实际证明的范围 |
| --- | --- | --- |
| 1 自适应 BeginFrame | `capture/begin-frame.mjs`、BeginFrame 单测、正式 Linux 时钟和 live 报告 | 单个 ACK 在途；无损伤降频，输入唤醒，无 Viewer 停止；正式运行 ACK 错误为零 |
| 2 输入关键路径并行化 | `live/input.mjs`、`capture/live.mjs`、input 单测、正式 Mac 输入报告 | CDP 接受输入后请求采集；可选 DOM 观察并行；先确认渲染进程登记，再驱动帧；实际像素测量使用输入水位和颜色匹配 |
| 3 Viewer 增量重绘 | `viewer/scene-renderer.mjs`、scene-renderer 单测、Mac rendererStats | 未变化 pass 与不可变 picture 栅格复用；依赖变化使父 pass 失效；实际合成动画 pictureRasterHits 增长 |
| 4 选择性 saveLayer | `native/chromium/serializer.cc`、serializer 原生测试、透明 clear 回归 | 安全 picture 直接绘制，破坏性 blend 保留隔离；字形、透明和嵌套合成回归通过 |
| 5 变化文字/资源增量化 | `native/chromium/cc_capture.inc`、`capture_state.cc`、`serializer.cc`，native 报告与 tile 契约 | 256×256 损伤 tile 录制，线程池编码，字体/图片缓存和独立块复用；稳定帧重复序列化/字体/图片耗时为零，强制重发复用已有编码 |
| 6 CanvasKit Worker / OffscreenCanvas | `viewer/stream-worker.mjs`、正式 Mac `worker:true` 及呈现指标 | WS、校验、缓存门控、重放在 Worker；主线程负责 DOM/输入；实际 canvas 图文、缩放和输入可见 |
| 7 常驻二进制 Viz IPC | `socket_transport.h`、`viz_capture.cc`、Rust Viz/资源契约与正式数据面计数 | RVB2 场景、RPA2 原始 SKP 直接从 C++ 到 Rust；Node 绘图资源记录、Viz 场景均为零 |
| 8 多 Viewer 复用 | Rust `scene.rs` / `gateway.rs`、Gateway 契约、Mac 单/双 Viewer 指标 | Arc/Bytes 共享资源与完整场景编码；相同 ACK 基线的 delta 缓存；每 Peer 独立引用、ACK、恢复和超时，慢 Peer 以 1013 关闭 |
| 原生 Broker/Gateway 边界 | 正式 Mac `source.dataPlane` | 465 次原生采集回执，legacy 回执、进入 Node 的资源与 Viz 场景均为零；Node 控制元数据仍存在 |
| 恢复与生命周期 | 正式 Linux live、Mac 完整流程 | 导航、断线、800/960/800 缩放、Broker 缓存主动清空、丢资源关键帧恢复通过；没有 Viewer 时额外采集为零 |

## 正式性能结果

| 指标 | 单 Viewer | 双 Viewer |
| --- | --- | --- |
| 实际 Mac 呈现 FPS | 47.6 | 各 47.1 / 47.6 |
| 源采集 FPS | 49.1 | 47.1 |
| 每 Peer 字节/秒 | 1,016,504 | 976,146 / 995,383 |
| Node CPU 核当量 | 0.179 | 0.208 |
| Broker CPU 核当量 | 0.108 | 0.115 |
| Chromium CPU 核当量 | 0.486 | 0.550 |
| 最近一次 Worker 重放耗时 | 2.3 ms | 2.3 / 2.4 ms |

Mac 真实输入到匹配的远端像素 p50/p95 为 **48.8/57.8 ms**（16 次输入），没有达到 30 ms。乐观 DOM 反馈为 0.2/18.2 ms，单独记录，不替代真实像素延迟。完整画面的像素中，任一通道差异超过 24/255 的比例约 0.973%；认证图片、blob 图片和文字墨迹另有断言。移除文字后的负向检查会失败。

Linux 套件中源与 Viewer 均在软件合成的 Linux 浏览器运行，输入 p50/p95 为 85.4/516.4 ms，包含冷启动异常样本；它与 Mac Viewer 结果分别保存。Mac 报告的 baseline 关闭输入触发并设 120 ms 采集节奏，同时保留自适应时钟；其 549.9/589.8 ms 不是上一版发布的性能，不以该差值宣称产品加速倍数。

帧率和 CPU 为两秒窗口；RSS 是进程总和，会重复计算共享页。物理键盘、显示扫描、物理系统 IME 候选窗、任意复杂网页效果、生产解码隔离和 Steel 接入不在这次优化验收范围内。字体布局和 glyph ID 来自源 Chromium，客户端缓存/解码资源，不重新执行 shaping。

## GitHub 打包

公开仓库的 Linux ARM64/x86_64 Actions 安装包是独立交付项。以上本机 ARM64 与 Mac 验收不证明 GitHub 两个架构的构建或提取包 smoke 已通过；包与最终工作流状态以 [Linux packages](https://github.com/jihuayu/remote-paint/actions/workflows/linux-packages.yml) 的运行页面为准。
