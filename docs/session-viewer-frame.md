# iframe 父子连接桥（开发中）

公开 Viewer 入口已安装子窗口桥。实验性 `@remote-paint/session-client/viewer-frame` 导出 `ViewerFrameConnection`，可将现有 iframe 接入既有主线程/Worker 渲染器。这个检查点完成通道和连接授权；后续的 [createViewer 组件](session-viewer-component.md)已接入 DOM 生命周期，接管/租约/resize/性能 API 仍在后续阶段；真实 iframe/CSP/资源验收尚未完成。

## 接入现有 iframe

在 iframe 的 load 事件后构造连接，传入可信的固定 Origin 和 Session：

```js
import {ViewerFrameConnection} from '@remote-paint/session-client/viewer-frame';

const connection = new ViewerFrameConnection({
  frameWindow: iframe.contentWindow,
  frameOrigin: 'https://viewer.example',
  gatewayOrigin: 'https://data.example',
  sessionId: 'ses_your_session',
  role: 'readonly',
  getTicket: applicationTicketProvider,
  onState: state => updateConnectionStatus(state),
});
await connection.ready;
await connection.connect();
// Later:
await connection.disconnect();
connection.close();
```

iframe 的 src 使用公开资源入口，不含票据、管理 key 或通道参数。公开服务的 allowedParentOrigins 必须包含实际宿主 Origin。`frameOrigin` 派生短票据 audience；父页面 Origin 是另一项独立校验。网关必须与公开服务配置一致，Session 和角色在连接对象中固定。

`getTicket({signal,reason,previousGrantId})` 只返回短票据 data，由应用后端校验用户并签发/刷新。SDK 不接受管理凭据，不能在浏览器直接调用管理 API。父侧保存版本和 grant 历史，子窗口无法自行选择另一个 grant。未显式 connect 前不调用票据回调。

`ready` 等待已授权的端口及公开 gateway/build 元数据，默认总期限 10 秒，可设 50ms 到 30 秒。`connect()` 等待实际网络 Welcome 所触发的 connected 状态，默认 30 秒，可设 50ms 到 60 秒；它不表示远端业务动作完成，也不表示首帧已呈现。并发 connect 共用进行中的连接，后续调用者取消其等待不取消最初调用者的连接。

`disconnect()` 终止当前显示连接并保留通道、版本及回调额度；再次 connect 仍通过原票据来源。`close()` 结束端口并中止回调，远端 Session 继续由后端释放或 TTL 管理。若端口因超时/导航而关闭，需为当前 iframe 创建新的连接对象。[createViewer 组件](session-viewer-component.md)负责 iframe load/reload 和本地 DOM 生命周期，并跨重载保留中心回调额度。

## 通道约束

初始消息只携带协议号、256 位随机 channel nonce 和一个 MessagePort，targetOrigin 必须明确。子窗口同时校验 `event.source` 是捕获的父 Window、Origin 在服务端 allowlist 内、消息和端口形状有效。元数据尚未完成时最多保留一个候选；允许列表确认后才绑定端口。重复握手不能替换活动通道，旧端口及不同 nonce 的 RPC 无法用于新通道。

绑定后仅接受 JSON 字符串，每条最多 16KiB，有限方法集、单调请求 ID 和至多 8 个出站/8 个尚未完成的入站请求。未知方法、错误 nonce、重放请求、超大报文或超速会关闭通道。完成/取消后的迟到回复按已发送 ID 忽略，不能完成另一请求。

请求可取消并有期限；忽略取消的处理器继续占用入站额度，直至实际 Promise 结束。票据来源额外保留唯一的实际应用回调额度，超时或断开不会绕过它。默认心跳 1 秒、通信空闲期限 15 秒；失联关闭通道并停止子窗口 Viewer。后台长时间暂停可能结束通道，应由宿主在恢复后重新建立连接。

通道只支持连接、断开、查询和内部票据请求；当前不提供 CDP、Agent、任意执行或编辑器内容通道。状态和异常只传固定字段/错误码，不传私有 Source URL/key。完整权限与输入租约仍继续走原票据网关和 ControlLease。

## 失败与恢复

公开连接失败后，Window 生命周期冻结至显式 connect。特别是票据撤销或协议拒绝，不会因为 online、resume 或 pageshow 再索票。修正前保存的主线程、Worker 脚本均实际出现第二次回调；日志保留，修正后和父通道接线均验证不再发生。

连接对象只保存状态快照；已在途的旧 connected 通知不能复活已断开的宿主或完成未经出票的连接。错误回调不包含原始处理器异常内容。源码及 Node 实测见[桥检查点](evidence/viewer-frame-bridge.json)。

## 验证范围

使用真实 MessageChannel/端口转移，验证双向请求、Origin/窗口/nonce、重放、大小、并发、期限、取消、迟到返回和关闭。保存的公开主线程/Worker 脚本通过父端口连接实际 HTTP/WebSocket/SQLite/Node Source，覆盖帧、提前刷新、撤销、断开和晚到票据；FrameGate 使用原实现。DOM、CanvasKit、呈现器和 realm 调度仍是明确夹具。这不证明真实浏览器跨域隔离、CSP、GPU/资源退役或 Native 端点桥接；相关验收在原始 8 小时测试退出后继续。
