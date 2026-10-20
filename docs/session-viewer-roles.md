# Viewer 角色与只读切换（开发中）

DOM 组件提供 `await viewer.setRole('readonly'|'controller', {signal?})`，以及布尔别名 `setReadonly(true|false, options?)`。构造时仍默认只读。角色切换是显式操作，不把只读票据升级为控制票据，也不授予 Agent 权限。

```js
await viewer.connect();
await viewer.setReadonly(false); // requires a new controller grant
// Wait for a displayed frame/control readiness before takeControl().
await viewer.setReadonly(true);  // stops the old human input/connection
```

切换先使旧代次失效，停止旧输入/连接并移除旧 iframe；随后创建新的父子通道，用目标角色取得新票据。新 Welcome 仍须匹配 Session、角色、版本和 grant。进行中只有一个切换，不排队；同时调用 connect、接管、交还或另一次切换会返回 `CHANNEL_BUSY`。应 await 切换结果后再执行下一操作。

同角色调用没有副作用。原来有显式连接意图时，成功返回等待新角色实际 connected；这不等于首帧、业务成功或 Source 物理退役。原来暂停或已终止失败时，只改变角色并保持 paused，不索票、不创建新 iframe，随后需显式 connect。此时 ready 等待下一代 iframe 的元数据。

## 应用后端仍决定授权

所有浏览器票据回调现在收到冻结的 `{signal, reason, role, previousGrantId, previousRole}`。role 是该来源固定要求的目标角色；previousRole 来自上一份已验证票据，与 previousGrantId 一同跨刷新、重载和角色切换保留。第一份合法票据固定版本，换角色不能重置版本约束。

应用回调应把角色请求交给自己的后端。后端认证用户、核对租户/Session 与当前权限，按实际存储校验旧 grant；不能仅相信浏览器传入的 role 或 previousRole。不同角色需要撤销旧 grant 并签发新的匹配票据，同角色可使用现有 refresh。已撤销/过期 grant 的 404 与权限拒绝要分别处理，是否重新签发仍由当前应用授权决定。原 refresh 路由保持原角色，不能用它直接升级权限。

SDK 不缓存旧角色票据来回退，也不在浏览器放管理 key。客户端切换只影响这个 Viewer，不能代替服务端全局权限撤销；独立票据仍由后端撤销或到期。信任的应用回调必须签发新票据并正确处理 AbortSignal，迟到回调仍可能在应用后端产生未被使用的票据。

中心 `ViewerTicketSource` 跨切换保留唯一实际回调额度。即使旧回调不响应取消，重建 iframe 或连续切角色都不能进入第二个实际应用回调。迟到旧结果不能更新版本/grant 历史或建立旧 socket。新连接可能因额度仍被占用而在有界重试后失败；回调实际结束后，应用可显式重连。

低层 `ViewerTicketSource.setRole(role)` 只改变后续回调/票据验证策略，并中止旧等待，保留实际回调额度、版本和历史；它不负责外部 socket，也不调用管理 API。`ViewerFrameConnection` 实例仍固定角色，DOM 组件负责更换整个 Frame 实例和旧连接。

## 取消与 Source 栅栏

预取消、无效角色、未知/继承/accessor 参数在副作用前拒绝。切换开始后取消、disconnect 或 destroy 都停止该流程，不恢复旧授权。若在提交新角色前取消，state.role 保持原角色；提交后取消则保留目标角色并停止显示，以最终 state 为准。destroy 之后不能重新创建 ready Promise 或 iframe。切换完成后，原启动 signal 不再控制后续连接生命周期。

降级会立即清空旧的人类输入队列和租约快照。Source 失联撤销仍须等待已提交工具及清理栅栏，期间已有 `source.control.agent()` 路径继续被暂停。新只读显示可以先 connected；这不宣称 Agent 已恢复。需要等待 Source 完成交还时，先使用 releaseControl 的实际 agent 确认。所有 Playwright/CDP/Agent 写路径统一栅栏仍属 K5 未完成验收。

## 验证范围

16 条角色合同用保存的主线程/Worker、真实 ViewerInput、MessageChannel、HTTP/WebSocket、SQLite、Node Source 与原 ControlLease，覆盖只读↔控制、持有租约降级、旧票据撤销、刷新历史、唯一回调额度、版本/角色不匹配、暂停/失败、并发和取消/销毁。

初期夹具错误把已撤销票据的 404 当成异常，保留 13 条中 1 条失败后修正。另实际复现“切换后立即 destroy 会重新创建永不完成的 ready”竞态，保留 1 条失败并修正销毁检查顺序。双平台冻结候选和安装包证据见[角色检查点](evidence/viewer-role-transition.json)。DOM/CanvasKit/realm 和 CDP 结果仍为明确夹具，真实浏览器/CSP/Native/物理资源及全部 Agent 写路径尚未完成，41 项仍为 9/15/17。
