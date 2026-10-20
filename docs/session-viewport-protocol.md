# 带租约的远端 viewport 协议层（开发中）

这是远端 resizeViewport 的 Source/网关协议阶段。宿主本地 `resize()` 继续只设置 CSS 显示尺寸；SDK、Window/Worker 请求与真实 Native capture/像素验收仍是下一阶段，不能从本协议测试推定已经完成。

控制通道增加有限的 `ResizeViewport` 消息：type、单调正整数 requestId、width/height（1–4096 的整数）、原有 sessionId/pageEpoch/viewportVersion/lease。没有任意 CDP、代码、URL 或 DPR 参数。Source 只支持现有 DPR=1 路径，公开只读票据不能发送此消息。

`ControlLease` 在入队前和输入队列实际执行时都验证租约及页面/viewport 代次。每 Source 最多一个实际未结束的 resize；断开或取消等待不能释放这份额度。requestId 在 peer 生命周期内严格递增，记录随 detach/close 删除。操作与旧输入经过同一个有界队列，旧请求被撤销后不能继续修改 viewport。

尺寸相同也先向 Source 验证并经过队列，再返回 changed=false；客户端缓存不能冒充当前 Source 状态。需要变更时调用已有 Source.resize，等待其完成，核对实际尺寸、新 viewportVersion 和有效 pageEpoch。成功回复 `ViewportResized` 只含 requestId、changed、代次与实际 viewport，不含私有 Session/peer/key/lease。它确认 Source 应用结果，不等于下一帧、像素呈现或业务完成。

Source resize/invalidate 会撤销旧租约；若实现漏发 invalidate，控制层仍会撤销。清理在现有栅栏后完成，不能在自己占据的队列任务中等待同一条 tail 而形成死锁。旧输入停止后，已提交工具与清理仍须实际结束，Agent 才可继续。

拒绝回复 `ViewportResizeDenied` 带固定 code 和 outcome。尚未进入 Source.resize 的拒绝为 not-applied；一旦进入后出现传输、CDP/capture 异常或结果被覆盖，只能报告 unknown，并撤销旧租约。原始异常、私有 URL/key 不外传。结果未知时不能自动重试写操作；重新连接后应先查询当前实际 viewport/帧。

Node 网关和 Rust 的内联/配对控制通道共享同一有限消息集合。Welcome 的 viewportControl 只有 Source 支持且控制角色可用时才为 true，旧 Native binary 缺字段按 false 处理。只读下行也过滤新增操作回复。Rust 不直接执行 CDP，仍把有限控制请求交给原 Node ControlLease。

## 当前证据与剩余范围

9 条 Node 合同覆盖应用屏障、同尺寸/重放、schema/能力/代次拒绝、输入栅栏、单一实际额度、未知结果及实际 HTTP/WebSocket/SQLite 的角色限制。Source.resize 与 CDP/capture 结果是明确夹具。独立编译的 macOS Rust Broker 另通过 2 条控制策略、9 条包/内存合同，以及真实内联/配对 TCP 请求和通用执行拒绝，子进程均实际退出。初次 TCP 夹具漏带配对 URL 必需的 key 导致 403，日志保留，修正夹具后通过，生产认证规则未放宽。

SDK 请求/取消/迟到续租保护、真实 Linux Native Source/capture/像素/资源验证及公开控制数据优先级继续后续。原 8 小时运行也只针对原冻结版本，不能替代新协议和完整 SDK 的验收。结果见[viewport 协议检查点](evidence/viewport-control-protocol.json)。41 项仍 9 完成、15 部分、17 待实现。
