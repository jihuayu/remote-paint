# 公共票据 Viewer 运行时（开发中）

现有 `viewer/live.mjs` 和 `viewer/stream-worker.mjs` 已共享 `sdk/viewer-connection.mjs` 的公共票据连接。它们继续使用原 FrameGate、资源校验、CanvasKit 渲染和输入租约，不再为公共连接拼接私有 Source key。原本地演示链接仍可使用私有密钥路径。

这个阶段提供票据连接与生命周期接线，以及独立[公开资源服务](session-viewer-assets.md)的 CSP/allowlist 配置。iframe 宿主组件、父子消息协议、resize/接管公共 API 及真实浏览器的 CSP/资源验收仍待完成；不能将这些接线测试当作 K2 全部完成。

## 当前 Viewer 入口

在 Viewer 自己的 Window 内调用：

```js
await window.remotePaintViewer.ready;
window.remotePaintViewer.connect({
  gatewayOrigin: 'https://viewer-gateway.example',
  sessionId: 'ses_your_session',
  role: 'readonly',
  getTicket: async ({signal, reason, previousGrantId}) => {
    // This application route calls the management API from your backend.
    const response = await fetch('/my-app/viewer-ticket', {
      method: 'POST', signal,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({reason, previousGrantId}),
    });
    if (!response.ok) throw new Error('Ticket unavailable');
    return response.json(); // only the grant data, not {data, requestId}
  },
});
```

公开入口必须先 await ready 加载无凭据的同源配置；gatewayOrigin 还必须与资源服务配置完全一致。原本地入口的 ready 返回 null，保留原行为。

浏览器中不配置管理 API key。应用后端负责认证自己的用户、核对目标 Session/角色，并通过[票据接口](session-viewer-access.md)签发或刷新；不能信任浏览器自行提供的租户或权限。当前 Window API 将 audience 固定为 Viewer frame 的 `location.origin`。跨域宿主页面需等后续安全父子消息桥接，不能直接调用另一个 Origin 的 Window。

`gatewayOrigin` 必须是规范化的 HTTPS Origin；HTTP 仅允许 loopback 开发。回调不能改换网关、Session、角色或 audience；首份票据的版本随后固定。可配置 `version` 进一步预先固定版本，票据回调期限默认 5 秒，可设 50ms 到 10 秒。未知配置字段、管理 key、getter 或继承的配置字段会被拒绝；支持来自普通跨 realm 数据对象的配置。

Worker 模式由主 Window 保有应用回调；Worker 通过有界、可取消的请求桥取得票据。主线程和 Worker 重启共用该回调来源，旧回调忽略取消时继续占用其唯一额度，迟到票据不能分配 WebSocket。`window.remotePaintViewer.disconnect()` 会终止渲染器/Worker/连接，后续 resume/pageshow/online 事件不会自动恢复，需显式再次 connect。正在返回的应用回调可能仍在应用后端产生票据，回调应响应 AbortSignal；SDK 会丢弃迟到结果。

## 连接、刷新和错误

包导出 `@remote-paint/session-client/viewer-connection` 提供 `ViewerTicketSource`、`ViewerConnection`、`ViewerConnectionError` 及相邻 TypeScript 声明。根导出和 `/backend` 仍仅用于 Node 后端。`ViewerConnection` 是底层连接控制器，需要 `onSocket` 接入显示协议；现有 Viewer 已完成该接入。

控制器在接受 Welcome 前核对公开的 Session ID、版本、grant ID 和角色；原 Source 控制 Session ID 留给租约协议。只读 Welcome 还必须明确禁止输入、反馈和私有控制配对。正式连接后在期限前刷新：默认提前 5 秒，短票据在剩余时间一半处刷新；每次回调携带上份 `previousGrantId`，应用后端可据此刷新并撤销旧 grant。刷新不会延长原 Session TTL。

临时传输或回调故障最多连续重试 3 次，可配 0 到 5 次，间隔从 250ms 增加至最多 2 秒；有效 Welcome 后重新计算连续失败次数。握手总期限默认 10 秒。服务端 1008 授权/协议拒绝、客户端 4008 校验失败和正常终止不会静默签发新授权。主动撤销后应由应用决定是否再次授权。关闭理由与回调异常不直接显示为错误详情，状态/error 只带固定 code，不包含票据或私有 URL。

Window 会派发 `remote-paint-connection` 事件，`detail` 为状态快照；也可读取 `window.remotePaintViewer.state`。这是连接状态接口，尚不等同完整嵌入组件的错误、租约与性能事件契约。

## 验证范围

真实 loopback HTTP/WebSocket、SQLite、Node Source 和原控制租约验证实际协议连接、提前刷新、撤销、重连、身份/角色核对，以及超时后有限并发。另执行保存的两个 Viewer 入口脚本，使用真实票据/网络和 FrameGate，但 DOM、CanvasKit、呈现器与 Worker realm 调度为明确夹具。覆盖首帧、刷新、断开/恢复、迟到回调及夹具呈现器释放；它们不证明真实 GPU/CanvasKit/浏览器资源无泄漏。

冻结候选、双平台 Node 结果及离线安装包/类型检查由[运行时检查点](evidence/viewer-ticket-runtime.json)记录。真实 Native、真实宿主多次挂载卸载和整份候选全量回归，仍等待原始 8 小时测试退出。
