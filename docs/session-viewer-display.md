# 宿主显示尺寸（开发中）

DOM 组件的 `viewer.resize({width, height})` 设置自己宿主元素请求的 CSS 像素尺寸；`viewer.resize()` 恢复宽高 100% 跟随容器。它是本地显示操作，Source viewport 保持原尺寸，Canvas 的远端像素和坐标代次不改变。

```js
const size = viewer.resize({width: 640, height: 360});
// {scope: 'display', mode: 'fixed', width: 640, height: 360}
viewer.on('resize', size => updateContainerStatus(size));
viewer.resize(); // {scope: 'display', mode: 'container', width: null, height: null}
```

`displaySize` 是冻结的请求快照。它不表示已测量的 canvas/client box，也不表示首帧、远端页面 resize 或物理呈现完成。宿主自身的父布局/CSS 仍由接入方决定；iframe 和原 Viewer 页面继续处理内部布局。实际布局、输入坐标映射、CSS 隔离和浏览器物理资源需真实浏览器验收。

固定宽高必须都是有限数值，范围 1–16384 CSS px，可带小数；只接受 width/height 两个自有数据字段，拒绝 getter、继承、额外配置和字符串。相同请求不重复通知。`onResize` 配置回调和 `on('resize')` 订阅收到同一种快照，订阅会立即得到当前值；最多 64 个监听器，应用异常不会阻断样式更新和清理。

尺寸可在 ready/connect 前、暂停或角色切换期间设置，并跨 iframe 重载/角色更换保留。resize 不索票、不重连、不改变 Session/角色/租约，也不调用 Source.resize。destroy 后拒绝修改，所有订阅随组件销毁。

## 远端 viewport 是独立操作

本方法不替代修改远端页面布局的 resizeViewport。后者必须使用实际人类控制租约、有限协议和现有 Source resize/invalidate 屏障，并区分“Source 已应用 viewport”和“下一帧已显示”。这一步仍在必须完成的后续计划中，需要 Node 与 Native 网关、取消/未知结果及真实原生验证；不能把这里的 CSS 操作当作远端 viewport 已完成。

## 验证范围

4 条合同经真实 MessageChannel/HTTP/WebSocket/SQLite/Node Source 执行保存的主线程/Worker 和真实 ViewerInput，确认本地 resize 保留原 socket、票据数量、Source viewport/epoch、输入队列及持有租约，另覆盖授权前设置、重载/角色保留、验证与清理。DOM/CSS/CanvasKit/realm 是明确夹具，不提供实际浏览器像素/布局或 Native 物理资源结论。

冻结版本和安装包结果见[显示尺寸检查点](evidence/viewer-display-resize.json)。远端 viewport、性能/首帧事件、真实 browser/CSP/Native、全部 Agent/CDP 写栅栏、原 8 小时和整份候选验收继续后续；41 项仍为 9/15/17。
