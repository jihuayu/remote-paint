# WebGL 页面当前的兼容性边界

当前按用户要求对 WebGL 使用黑框和“WebGL 无法显示”占位，页面其余内容继续显示。2026 年 10 月 16 日的 [真实原生验收](evidence/webgl-placeholder-live.json)覆盖 Linux ARM64 Chromium → Rust → CanvasKit Worker：源 WebGL2 可运行，占位黑色像素正确，文字可见；其他 DOM 颜色更新正确，移除 WebGL canvas 后正常恢复。

Chromium 仅将 `TextureLayerImpl` 中 `ResourceSource::kDrawingBuffer` 标识为 WebGL，随同一捕获传递稳定 layer ID。Broker 在同一 namespace 内将对应 Viz quad 替换成占位，保留矩阵、可见区域、裁剪、圆角、透明度和层级。没有被明确标识的缺失资源依然拒绝提交，避免把图片丢失误报成 WebGL。

`node tests/verify-webgl-live.mjs` 验证真实像素与生命周期；`node tests/verify-webgl-placeholder.mjs` 验证 Broker 几何和严格的资源失败隔离；`npm test` 覆盖叠加、裁剪与透明度。这些结果不表示已经传输了 WebGL 内容，也不覆盖 iframe、视频、复杂滤镜或所有浏览器。

## 占位实现前的诊断

探针创建一个 320×240 WebGL canvas，清屏为绿色，并分别读取 WebGL 像素和源浏览器截图；随后通过当前 `startLive()` 启动真实 Viewer，等待首帧。

| 变体 | WebGL 源页面 | 源截图中心像素 | Viewer |
| --- | --- | --- | --- |
| 当前默认启动参数 | WebGL2 可用，ANGLE 与 SwiftShader | RGBA 26 191 64 255 | 12 秒内无首帧，Missing native layer |
| 额外启用 SwiftShader 诊断参数 | WebGL2 可用，ANGLE 与 SwiftShader | RGBA 26 191 64 255 | 12 秒内无首帧，Missing native layer |

这证明当时的失败发生在捕获与资源映射阶段。即使服务器软件执行 WebGL，其输出仍然以纹理或 Surface 参与合成，不会自动变成现有的 SKP 录制层。单纯改一个 GPU 启动参数不能补齐资源映射。

[原始诊断报告](evidence/webgl-boundary.json)保存探针 hash、完整浏览器 hash、两组参数、源像素与捕获错误。报告来自同一容器中的源浏览器与 Viewer，未验证物理 GPU、Mac Viewer 或任意复杂 WebGL 页面。

复跑命令为：

```sh
REMOTE_PAINT_CHROMIUM=/path/to/headless_shell \
REMOTE_PAINT_BROKER=/path/to/remote-paint-broker \
node tests/probe-webgl.mjs > webgl-report.json
```

探针输出实际观察，不以进程退出 0 表示 WebGL 已受支持；必须检查 `webgl.available`、`viewerFrame`、捕获错误和像素结果。附加 SwiftShader 参数只是诊断变体，不是生产配置建议。探针创建并关闭自己的浏览器与临时页面，不操作已有演示 Session。

## 原因与扩展方式

普通页面的内容绘制记录可以录成 SKP，Viz 描述这些内容怎样组合。WebGL 的 shader、缓冲、纹理、framebuffer 与 GPU 状态形成另一条路径；最终合成纹理可能没有对应的 Remote Paint 录制层。当前 Mapper 要求可解析的完整资源依赖，缺失时拒绝场景。

建议采用混合显示：普通内容继续走 SKP，WebGL 区域走位图或视频，输入仍由远端页面处理。

| 路径 | 适合内容 | 需要新增的能力 |
| --- | --- | --- |
| WebGL 区域位图 | 图表、地图、低频 3D、偶发效果 | 从正确的合成帧异步读回区域，按损伤更新、编码与缓存，并映射为可重放资源 |
| WebGL 区域视频 | 高频 3D、游戏、持续复杂动画 | 服务端编码、客户端解码、质量与速率控制、硬件能力协商、丢帧和恢复 |
| 整帧图像或视频回退 | 对复杂混合效果优先保证可见性 | 明确回退模式、输入坐标与权限，控制额外计算和带宽 |

混合路径需要统一 `pageEpoch`、viewport、frame token、变换、裁剪、透明度和提交屏障。单独截图后随意贴到最新 SKP 帧，会造成错位或时间不同步。涉及 backdrop、滤镜或复杂混合时，回退区域还要包含完整依赖，必要时回退整个 render pass 或整帧。

将任意 WebGL 指令搬到客户端重放，意味着还要同步 GPU 资源、shader、扩展、同步点及上下文生命周期，并处理不同设备差异。它是另一项较大的工程，当前更适合先把位图和视频回退做正确。

上线前应增加静态与动态 WebGL、resize、滚动、iframe、遮挡、透明合成、context lost 和设备差异的验收。当前普通网页的 1–8 项验收不能推导出这些路径已通过。

## 普通 Canvas 2D

ResourceSource::kCanvas使用同帧像素副本和既有SKP资源，软件与ANGLE SwiftShader GPU API路径均通过。透明、intrinsic/CSS缩放、变换、圆角、混合DOM、动画配对、导航/resize及预算恢复见[Canvas证据](evidence/canvas-native-capture.json)。副本池不覆盖原始Canvas/驱动/完整Session；物理GPU/Mac原生待验。DrawingBuffer WebGL保持原占位规则，未知纹理继续明确拒绝。
