# 公开性能与首帧 API

DOM Viewer 和 ViewerFrameConnection 提供只读 performance、firstFrame，以及配置回调 onPerformance / onFirstFrame。DOM 还提供 on('performance', listener) 与 on('first-frame', listener)，每种事件最多64个监听器，返回取消订阅函数。performance 立即重放最新快照（可为 unavailable）；first-frame 只重放当前连接已有首帧。ready 元数据和 connect 网络授权均独立于首帧。

首帧确认当前验证通过的授权下，场景提交结果到达子页面 UI；固定 stage=scene-submitted、clock=viewer-ui-receipt。connectToReceiptMs 从 renderer-init 或后续 connection-attempt 开始，Worker 路径含回到 UI 的消息跳转。它不确认物理显示、业务成功或 Source 捕获帧龄。性能样本在子页面至少间隔250ms；空状态重置通知不是新样本。内存为 client-estimate，缺失测量为 null。

父子桥只携带两个固定内部字段 grantId 与有限 snapshot；宿主与它实际签发的当前授权匹配后才发布快照，公开数据不含 grantId。握手前、未授权、不同授权、旧连接代次、较旧 frame 命名空间与倒退提交数被丢弃，空闲时同一帧的新年龄样本允许更新。未知字段、非法范围、非法必需数值或不一致状态均关闭为固定 CHANNEL_PROTOCOL。原16KiB报文、128/s通道额度、出入站并发与心跳策略不变。

断线/刷新/重连、授权替换、iframe重载、换角色、失败与销毁清空首帧和性能；旧授权/iframe/Worker结果及已取消回调不能复活它们。首帧只在每个当前连接代次产生一次，监听器显式注册时可重放当前结果。公开API的重放、空状态回调和同步销毁均有重入边界；回调中销毁不会恢复状态或创建另一个iframe。所有新增监听器随子桥/组件销毁移除。

公开保存入口的 CanvasKit 初始化或场景重放失败，现在立即通过现有 state/error 回传固定 VIEWER_PROTOCOL_ERROR，并停止当前连接。已知连接错误仍保留既有有限 code，宿主异常只有固定消息 Viewer channel unavailable；原始渲染异常文本、Source身份、URL、票据、场景、渲染器和内存对象不外传。Worker自身故障的原有兼容模式恢复流程保持。

最初10项新合同在实现前全失败，实施后通过；另补主线程/Worker初始化失败及空状态回调销毁，共新增13项。实际MessageChannel对不同授权、旧代次、额外字段、命名空间倒退、重复首帧和重入关闭做验证。实际Node HTTP/WS/SQLite/ControlLease/ViewerInput配合保存的Window/Worker入口，验证只读显示、重连、iframe重载、角色切换、销毁、init/draw固定失败及清理。DOM/CanvasKit/呈现器/Worker调度和故障为明确夹具，未以其证明真实浏览器像素。

相关214项通过。103文件/885项完整回归：Mac870通过、15平台跳过；Linux879通过、6平台跳过，实际均0、无失败或取消。新的16文件私有SDK双平台离线安装各77 Node/16 Python、严格TSC及Mac安装版Mypy均通过，公开遥测类型、readonly与私有字段不存在、初始/销毁状态均覆盖；未发布。

新接口仍须实际Native GPU Worker、CPU Worker、CPU主线程公开浏览器验证。此前三模式视口证据不代替此次遥测验收。生产Native端点、全部Agent/CDP栅栏、物理时延与N1轻微丢包、物理IME、多设备及原8小时增长验收均待继续。41项仍9完成（范围内）/15部分/17待做，原8小时失败与192MiB门槛保持，未自动重跑、强制浏览器GC、修改演示/采样器或暂存提交推送。见[有限证据](evidence/viewer-telemetry-host.json)。

后续计时器品牌问题经真实失败定位/修复后，新安装包的GPU Worker、CPU Worker与CPU主线程实际Native公开遥测通过，见[真实Native范围与清理](viewer-telemetry-native.md)。上述Node合同原始范围保留，物理时延/8小时和生产端点仍未完成。
