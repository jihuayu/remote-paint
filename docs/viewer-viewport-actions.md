# 远端视口动作的超时与结果

Child 的 `ViewerControlActions.resizeViewport(size, options)` 复用 ViewerInput/Source 租约流水线。尺寸为两个自有 CSS 整数字段，1–4096；options 只接受 AbortSignal 和 50–10000ms 超时，默认 5000ms。接管、交还和视口操作共用一个待办额度。无权限、无能力、未持有租约、错误配置或预先取消在发请求前拒绝，结果为 `not-applied`。

Source 可以在 resize 屏障完成前广播新 epoch/version 或 handoff。动作层保留待办，等待对应 Source 回执，不能把这个正常状态变化误判为操作过期。成功只返回六个冻结字段：`scope=viewport`、changed、width、height、pageEpoch、viewportVersion；不暴露 requestId、Source 私有身份、CDP 或诊断内容，也不宣称 Viewer 已提交新尺寸的画面。

Source 的有限拒绝被映射为固定公开 code 与 `not-applied`/`unknown`。总超时、发出后的取消、断线、不可验证的错误及异常回执均报告 unknown。取消、超时或 unknown 关闭旧公共连接，让 Source 撤销旧租约；已经进入 Source 的实际工作仍占队列额度，直到它真正结束。此处理不承诺远端操作回滚。仅 Source 确认 not-applied 时保留连接，并交还旧租约。

协议错误在同步回收连接前向动作层发有限通知，避免 Worker 的 teardown 将已知协议失败覆盖成普通取消。原始错误消息和未知 code 不外传；无法验证的输入错误即使声称 not-applied，也按 unknown 处理。

15 条新合同覆盖实际 Node HTTP/WebSocket/SQLite/ControlLease、保存的 Window/Worker 及真实 ViewerInput：等待屏障、no-op、权限/配置、排队和进入 Source 后的取消/超时、断线、异常成功与异常回执回收。DOM/CanvasKit/调度、Source.resize/CDP 仍是明确夹具。Frame/DOM SDK 的父子协议和公开 resizeViewport API 尚未接入，实际 Native viewport、像素及控制优先级仍待验收。见[动作层证据](evidence/viewer-viewport-actions.json)。
