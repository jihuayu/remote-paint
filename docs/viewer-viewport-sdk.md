# 公开远端 viewport API

`createViewer` 组件和 `ViewerFrameConnection` 均提供 `resizeViewport({width,height}, {signal?,timeoutMs?})`。调用需要 controller 票据及已授予的当前控制租约。尺寸为两个自有 CSS 整数字段，范围 1–4096；不接受 DPR、任意 CDP 或多余字段。总超时默认 5000ms，可设 50–10000ms。并发视口请求在发请求前拒绝。

本地 `resize()` 只调整宿主 CSS；远端 `resizeViewport()` 等待原 Source 的有限视口协议，不改宿主 CSS，不索取新票据或重连。成功结果只有六个冻结字段：scope=viewport、changed、width、height、pageEpoch、viewportVersion。改变尺寸会使旧租约停用，下一次接管需等新控制状态与已提交 frame 代次相符；同尺寸 no-op 也经过 Source 输入清理，再续租恢复原输入序号下界。Source 已应用与 Viewer 已提交新画面是两个不同时间点，这个 Promise 只确认前者。

失败抛出公开 `ViewerViewportError`，它继承 `ViewerChannelError`，只包含固定 code、固定消息和 outcome=`not-applied` / `unknown`。验证失败、预先取消及通道在发出前拒绝为 not-applied。发出后取消、超时、断线、不可验证回执为 unknown；仅有限 Source 回执可以确认已发出请求的 not-applied。unknown 关闭旧连接，Source 已进入的实际工作继续占用队列直到结束，不承诺回滚，也不自动重试。

父子端口新增有限 resize-viewport 动词和仅对应视口请求的错误 outcome。保持16KiB报文、单调ID、原有出入站额度、128/s速率和心跳/空闲限制；取消的非协作处理仍占实际入站额度。迟到的有限回执可被忽略，不保留无界请求历史。普通控制请求不能接收额外 outcome。未知字段、未知 outcome 或视口请求缺少 outcome 会关闭通道，原始异常诊断和任意字段不外传。

Source/Child 可以先发连接失败事件，宿主会同步销毁 iframe。Frame 在通知宿主前先保留当前视口操作的固定错误和 unknown，避免它被普通 close/abort 覆盖。iframe 重载、角色切换、销毁后，旧端口结果不能更新新代次。

实际 MessageChannel、Node HTTP/WebSocket/SQLite/ControlLease、保存的 Window/Worker 和真实 ViewerInput 验证这条链路。DOM/ShadowRoot/CanvasKit/呈现器/Worker调度、Source.resize/CDP 为明确夹具；没有以这些合同证明真实 Browser/Native capture、新尺寸像素、公共控制优先级或物理资源验收。公开性能/首帧事件、实际 Native 视口和原8小时增长验收仍须继续。证据见[SDK视口检查点](evidence/viewer-viewport-sdk.json)。

后续已完成真实 Native/跨源浏览器的 GPU Worker、CPU Worker 与 CPU 主线程短周期验证，包含实际视口像素、WebGL文字、控制优先级、超时未知结果和回收，见[Native验证及剩余矩阵](viewer-viewport-native.md)。上文保留本SDK协议检查点的原始范围；公开性能/首帧API及完整长期验收仍须继续。
