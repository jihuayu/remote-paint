# 探索结论：跨端 SKP 重放可行，实时远程网页尚未实现

2026-10-15 在 macOS arm64 上，从真实 Chrome 页面导出 SKP，在另一个浏览器实例的 CanvasKit Wasm 中完成重放。源页面服务在 Viewer 启动前已经关闭。Viewer 没有源页面 DOM，也不请求源页面图片或字体。

本次验证使用受控的静态 HTML 页面，包含中文、英文、SVG 路径、圆角边框、PNG、输入框和按钮的视觉内容。它证明这一类绘制内容可以跨端重放；页面中的输入框只是画面，尚不能操作。没有测任意生产网站、第二台物理机器或 Linux。

## 为什么这次不需要先编译 Chromium

Chrome 的调试 API `chrome.gpuBenchmarking.printToSkPicture(directory)` 能导出每个绘制层的 SKP。检查 [Chrome 155 源码](https://github.com/chromium/chromium/blob/155.0.8059.79/content/renderer/gpu_benchmarking_extension.cc) 中的 `SkPictureSerializer::Serialize` 和 `GpuBenchmarking::PrintToSkPicture`，可见它遍历层树、调用 `layer->GetPicture()` 并序列化。图像回调编码 PNG；GPU 纹理图像的读取可能失败。

这与把截图描摹成矢量不同。本例网页文字、路径和边框实际保存在 SKP 中，字体和 PNG 由序列化器嵌入。

这个接口只导出每层文件，**不导出足以可靠恢复最终画面的合成关系**，也没有稳定的文件名到 Viz 资源映射。因此工具在多层、iframe、非零原点/超视口 picture 等情况下拒绝，而不是猜测层顺序。即使一个网页通过这些检查，也不能据此证明它所有效果均已覆盖。

## 字体是第一项实际成本

最初的中文与 Emoji 页面导出了 219,690,413 字节（约 209.5 MiB）的 SKP。删除字体子集中缺少的标点也曾让大小从约 12.6 MiB 降到 33 KiB：极少数缺字就可能触发巨大系统字体的嵌入。

最终测试字体是预先生成、随项目提供的 Noto Sans SC 子集，**不是为任意网页实现了字体子集化**。完整 SKP 为 33,594 字节，其中含字体和 PNG。真实网站的动态字符和 Emoji 仍需原生字形收集、子集化及 glyph ID 重映射。

## 本次结果

| 指标 | 观察结果 |
|---|---|
| Chromium | Chrome/155.0.8059.79 |
| Chromium revision | a49e2e3d4addfd84e765b52afe230bedb81096db |
| Chromium DEPS 中的 Skia revision | 29ed1e87a0a50f3d8347e988842d9d59e7573efa |
| SKP 格式版本 | 110 |
| CanvasKit | npm 0.42.0，完整构建，软件 Canvas Surface |
| 画布 | 960 × 640 CSS px，捕获 DPR=1 |
| SKP 资源 | 33,594 bytes / 32.8 KiB |
| 首个绘制帧的全部 WS 应用消息 | 34,495 bytes（不含协议/TLS开销） |
| Viewer 额外静态依赖 | CanvasKit Wasm 约 7.9 MiB，另有 JS/CSS；不计入上述 SKP/WS 体积 |
| 平均绝对 RGB 通道误差 | 1.184 / 255 |
| 最大 RGB 通道误差超过 16 的像素 | 11,993 / 614,400，约 1.952% |
| PNG 内部测试区域 | 与服务器截图 RGB 像素完全相同 |
| 断线重新连接 | 重建结果与首次画布 PNG 字节相同 |
| 客户端 700px 视口、DPR=2 | 内部画布重放结果与首次 PNG 字节相同 |

具体时间读数与完整网络清单见 [report.json](evidence/report.json)。这些是本机单次测量，包含冷启动与初始化的影响，不是吞吐量或远程延迟基准。当前 CanvasKit 初始化会请求 Wasm 两次，仍有约束传输开销的优化空间。

对照图：[服务器](../examples/verified-capture/server.png)、[重放](evidence/replay.png)、[差异](evidence/diff.png)、[Viewer](evidence/viewer.png)。差异集中于文字边缘，符合平台字体光栅化差异的表现；尚未将字体后端、抗锯齿与 Skia 版本各自的影响独立定位，不能宣称逐像素一致。验证预算是此 fixture 的通道均值 <1.5/255、超过16/255的像素占比 <2%，不作为通用保真标准。

## 验证了哪些失败行为

7 项 Node 测试覆盖二进制截断/长度/版本、缺资源不提交、完整帧恢复、过期 epoch/frame、资源释放约束、缓存预算、错误 Origin/连接密钥/Wasm、两个并发连接、产物被篡改以及不暴露截图/manifest 的 HTTP 路由。传输单测使用合成 envelope，浏览器端到端验证使用真实 SKP。

实际浏览器验证还包括 iframe 拒绝、多合成层拒绝、原站离线时重放、独立 Viewer 网络请求清单、重连和不同客户端 DPR。测试成功不表示已测真实多租户隔离或所有恶意 SKP。

## 版本和安全的真实边界

Chrome 的 Skia 与 npm CanvasKit 不是同 revision 构建。本次成功是一个已测兼容样例，不能推导出跨版本 SKP 的稳定性。握手检查协议、CanvasKit 版本和 Wasm SHA-256，仅防止使用与捕获 manifest 不一致的 Viewer 构建。生产仍需从 Chromium 锁定的 Skia revision 构建 CanvasKit。

Viewer 无原页面 JS，但 SKP 会进入 Wasm 原生字体/图片/绘图解码器。当前只实现传输和缓存预算，没有原生解码的时间、图片尺寸、递归复杂度等硬限制。捕获器用禁用沙箱的调试浏览器，仅供本机实验。不能把当前启动参数和连接密钥方案直接用于公网服务。

## 下一步判断

这条路线值得进入下一阶段；现在最需要验证的是 **内容资源与最终合成帧的稳定映射**，其次是动态字体子集、同 revision 构建以及真实输入。不要直接把当前文件导出接口循环调用来冒充实时合成器。

源码依据：[Chrome 155 DEPS](https://github.com/chromium/chromium/blob/155.0.8059.79/DEPS)、[RasterSource](https://github.com/chromium/chromium/blob/155.0.8059.79/cc/raster/raster_source.cc)、[Paint Preview](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.79/components/paint_preview/)、[CanvasKit](https://skia.org/docs/user/modules/canvaskit/)。
