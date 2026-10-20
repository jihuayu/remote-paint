# createViewer 宿主组件（开发中）

实验性 `@remote-paint/session-client/viewer` 提供原生 JS 的 DOM 宿主组件，接入已有公开 Viewer 及父子端口桥。宿主容器必须具有可用宽高：

```js
import {createViewer} from '@remote-paint/session-client/viewer';

const viewer = createViewer(document.getElementById('remote-page'), {
  viewerOrigin: 'https://viewer.example',
  gatewayOrigin: 'https://data.example',
  sessionId: 'ses_your_session',
  role: 'readonly',
  getTicket: applicationTicketProvider,
  onState: state => updateConnectionStatus(state),
  onError: error => showConnectionError(error.code),
});
await viewer.ready;
await viewer.connect();
// Later:
await viewer.disconnect();
await viewer.destroy();
```

`viewerOrigin` 是精确规范化 Origin，使用其 `/` 根入口，拒绝路径、query、hash、用户名和密码。HTTPS 可用，HTTP 只允许 loopback 开发。`gatewayOrigin` 必须与公开资源服务的固定网关一致；服务端父 Origin allowlist 还必须包含实际宿主。短票据 audience 由 Viewer Origin 派生，管理 key 不进入浏览器配置。角色默认只读，Session 和版本在实例中固定；[角色切换](session-viewer-roles.md)显式重建连接并重新取得匹配票据。

组件追加一个独立宿主，保留容器原有子节点。宿主使用 closed ShadowRoot，内部 iframe 占满容器，设置 `no-referrer` 和 `sandbox="allow-scripts allow-same-origin"`。本地尺寸默认跟随容器，可用 [resize](session-viewer-display.md) 指定请求的 CSS 宽高；它不修改远端 Source viewport，带租约的远端 viewport 操作仍待后续完成。iframe 资源、渲染器、FrameGate 和输入队列均沿用原 Viewer。真实浏览器 CSS、sandbox 和 CSP 行为仍待验收。

## 连接与重载

`ready` 是当前 iframe 代次的公开元数据 Promise；加载完成不索取票据。`connect({signal?})` 才请求授权，并等待实际 Welcome 的 connected 状态。连接成功与首帧、交互结果或业务完成分别处理，当前组件尚未开放首帧/性能事件。[公开接管与租约](session-viewer-control.md)提供实际确认的 takeControl/releaseControl 以及只读 control 快照。并发 connect 共用进行中的连接；初始调用者取消会停止该连接，后续调用者取消只结束自己的等待。

iframe load/reload 会关闭旧端口、生成新 nonce，旧状态不能更新新代次。连接仍被应用要求时，正常重载会重新授权；一份中心 `ViewerTicketSource` 跨重载保存版本、grant 历史和实际回调额度。即使旧应用回调不响应取消，重建 iframe 也不能再次进入回调，迟到结果不能分配旧连接。

任一终止失败会移除当前 iframe 并保留 failed 状态，只能显式 connect 重试；online、resume、pageshow 不会自动再授权。状态快照包含固定 state、Session、角色、版本、generation 和可选错误码，错误信息不含原始回调异常、票据 URL 或私有 Source key。

## 结束与界限

`disconnect()` 中止当前连接并等待子窗口断开确认，保留中心票据来源。没有确认时，父窗口到期直接关闭端口和移除 iframe；下一次 connect 创建新 iframe。`destroy()` 可重复调用且共用同一个 Promise，停止票据等待、关闭端口、移除 iframe/宿主和监听器。远端 Session 仍由后端显式释放或 TTL 管理。

默认加载期限 20 秒（50ms–60 秒），connect 总期限 45 秒（50ms–120 秒），断开确认期限 1 秒（50ms–10 秒），destroy 等待 250ms（0–1000ms）。底层端口 ready 和 connect 仍分别遵守最多 30/60 秒的限制。所有期限结束都不会释放尚未实际结束的应用回调额度。

宿主 pagehide 会断开；页面离开且不进入 BFCache 时销毁。组件观察已挂载宿主从文档移除，自动销毁；框架卸载仍应显式 await destroy。`on('state', listener)` 会立即交付当前快照，`on('error', listener)` 交付后续错误；各最多 64 个监听器，返回取消订阅函数，应用监听器异常不会阻断清理。

## 验证范围

12 条组件合同通过真实 MessageChannel 转移、HTTP/WebSocket、SQLite 和 Node Source 执行保存的主线程/Worker 入口，覆盖刷新、重载、撤销、取消、迟到回调、加载/connect/断开/destroy 界限、宿主移除和 8 次重复挂载卸载。既有 14 条保存入口合同在提取共享夹具后保留原语义。DOM、ShadowRoot、MutationObserver、CanvasKit、呈现器及 realm 调度是明确夹具，不能替代真实跨域浏览器、GPU 或 Native 资源退役证据。

冻结版本、双平台范围回归和私有离线安装包结果记录在[组件检查点](evidence/viewer-dom-component.json)。完整 Agent/CDP 写栅栏、resize/性能事件、Native 私有端点桥接及真实浏览器验收继续下一阶段；41 项仍为 9 完成、15 部分、17 待实现。
