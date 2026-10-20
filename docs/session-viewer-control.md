# 公开 Viewer 接管与租约（开发中）

`createViewer` 和底层 `ViewerFrameConnection` 提供 `takeControl()`、`releaseControl()`、只读 `control` 快照。DOM 组件支持 `on('control', listener)`，两层都可配置 `onControl`。这条路径复用原 `ViewerInput`、Window/Worker 控制消息和 Source `ControlLease`，不增加输入队列或任意执行通道。

```js
const viewer = createViewer(container, {
  viewerOrigin: 'https://viewer.example',
  gatewayOrigin: 'https://data.example',
  sessionId: 'ses_your_session',
  role: 'controller',
  getTicket: applicationControllerTicketProvider,
  onControl: control => updateTakeoverUI(control),
});
await viewer.connect();
// Wait for a displayed frame and a control snapshot with mode === 'agent'.
const control = await viewer.takeControl({timeoutMs: 5000});
// control.held === true: an actual Source lease has been granted.
await viewer.releaseControl();
// Source cleanup has completed and its mode is now 'agent'.
```

只读角色拒绝控制操作，调用不会向 Source 发送 AcquireControl。`connected` 与可接管分开：首次显示帧与 Source 控制状态尚未到达时，操作返回 `VIEWER_CONTROL_UNAVAILABLE`；显示代次与最新控制状态不匹配时返回 `VIEWER_CONTROL_STALE`。其他 Viewer 持有租约，或已有一个控制操作在等待时，返回 `VIEWER_CONTROL_BUSY`。服务端其他拒绝统一为 `VIEWER_CONTROL_DENIED`。

## 实际确认与快照

接管先进入 handoff，等待已排队的受管 Agent 操作和清理栅栏，再由 Source 发出实际 ControlGranted。API 不会在请求发出或收到“正在接管”时宣称成功。交还请求发出后立即停止本地输入、清空旧队列，Promise 继续等待 Source 清理完成、实际回到 agent 状态。已提交的工具工作不能由取消撤回。

快照只有 8 个固定字段，整体冻结：

| 字段 | 含义 |
| --- | --- |
| mode | unavailable / agent / handoff / human |
| holder | none / self / other；不暴露 peer ID |
| held | 当前 Viewer 是否实际持有有效代次的授予 |
| lease | 自己持有时的原 Source 租约能力；否则 null |
| fencingToken | 自己持有时的原 ControlLease 版本（feedbackEpoch）；否则 null |
| expiresAt | 当前租约期限；无期限时 null |
| pageEpoch / viewportVersion | 当前 Source 控制代次；不可用时 null |

租约能力只通过已授权的父子端口传递，不放在 iframe URL、状态错误或日志里。其他持有者的 lease/fencingToken 不转交。快照不包含 Source 私有控制 Session ID、后端 key、私有 Source URL/key、配对 ticket、编辑器内容或任意服务器异常。

fencingToken 在当前 Source 控制实例中递增，续租不改变它；应结合 Session/版本、页面/viewport 代次及不透明 lease 理解，不能单独当作通用执行凭据。本阶段仅验证已有 `source.control.agent()` 路径的交接栅栏；所有 Playwright/CDP/Agent 写路径的独立授权与统一栅栏仍属 K3/K5 未完成工作。

## 取消、超时与生命周期

每个子 Viewer 至多一个实际等待的控制操作，默认 5 秒，可设 50ms–10 秒。未知、继承或 accessor 操作参数被拒绝。预先取消不发送请求，不影响连接。已发送操作取消或超时会关闭端口并终止显示连接，防止迟到授予落在已放弃的旧 peer；失败保持到显式 connect。Source 失联撤销仍需等待先前已提交工具结束及清理栅栏完成，不能理解为立即撤回业务动作。

刷新、断开、页面代次变化和销毁都会使旧控制快照失效；旧租约输入由 Source 拒绝。Frame/组件关闭会发布 unavailable，已在途的旧控制事件不能恢复已断开的宿主。协议畸形的控制事件或成功回复会关闭通道。控制快照和状态监听器异常不会阻断清理。

## 验证边界

17 条公开控制合同使用真实 MessageChannel、HTTP/WebSocket、SQLite、Node Source 与原 ControlLease，执行保存的主线程/Worker 入口及真实 ViewerInput。覆盖双控制者、旧租约拒绝、只读拒绝、续租、等待 Agent/清理栅栏、取消/超时、页面失效、异常协议回复及 4 次持有租约后销毁。DOM/ShadowRoot/MutationObserver/CanvasKit/呈现器/realm 调度、Session provider 和 CDP 执行结果仍为明确夹具。

双平台范围回归、私有安装包及类型结果见[公开控制检查点](evidence/viewer-public-control.json)。实际跨域浏览器、CSP、Native 端点、物理资源退役、[角色切换](session-viewer-roles.md)已完成 Node 合同范围接线，resize/性能事件、全部 Agent/CDP 写栅栏和整份候选回归继续后续验收；41 项仍为 9 完成、15 部分、17 待实现。
