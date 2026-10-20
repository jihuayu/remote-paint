# 指针与公开文本反馈

输入仍由源浏览器执行。`InputAck` 只表示 CDP 已接受注入，包含 `stage: input-injected` 和输入序号，不包含输入框正文、光标或业务成功结论。正文和指针反馈使用独立的 `FeedbackState`，可选 DOM 读取不会阻塞输入确认或控制权回收。

## 页面接入与隐私

正文预览默认关闭。仅在应用确认可公开显示的普通文本编辑器上设置 `data-remote-paint-preview="plain-text"`。属性也可设置在编辑器祖先上；更近的属性覆盖祖先。支持 text/search input、textarea 和仅含文本节点的 contenteditable。

即使有此标记，密码框、其他 input 类型、带用途提示的 autocomplete（包括验证码和支付字段）、敏感命名、`data-remote-paint-sensitive` 祖先或后代、CSS 文字遮挡、不可见/透明/滤镜与非平移变换也禁止正文反馈。判定发生在读取 value/innerText 之前。输入长度上限为 8192 UTF-16 单元，样式仅返回有界白名单。业务语义无法仅凭 DOM 推断，应用仍须正确设置公开与敏感标记。

只有当前控制者、且协商 `input-feedback-v1` 的 Viewer 接收反馈；旧客户端继续输入但不接收新消息。新输入的本地预览始终使用圆点，避免源脚本切换焦点后将刚输入的敏感文本显示到旧编辑器叠层。已经由源端确认、且明确允许的公开正文可显示。普通调试状态只记录序号、时间和阶段。指针只返回内置 cursor 枚举与几何范围，自定义 cursor URL 不发送给 Viewer。

## 版本、排队与校正

源端最多一个并行探测，最多 10 Hz，重复状态不重发；输入版本在探测期间变化则丢弃结果。`FeedbackState` 携带 session、控制代数、page epoch、viewport version、单调反馈 revision、已处理输入序号，以及最低原生画面版本。主线程控制连接负责接收反馈，Worker 只提交画面版本。

Viewer 拒绝旧会话、租约、页面、viewport、反馈 revision 和焦点屏障前的状态。点击、滚轮、Tab 与快捷键立即撤销旧编辑器预览，尚未发出的焦点变化也设置屏障。最低原生画面尚未显示时只保留最新一份状态。源端返回 null 立即撤销正文预览；匹配画面到达后清除覆盖图。预览使用源端滚动位置与文本换行样式，本地预测时将 caret 保持在编辑器裁剪范围内。已预测的 composition 基线可保留用于后续撤销，新源端状态校正文本与选区。

状态提示区分“输入待确认”“本地预览 · 输入待确认”和“输入已注入 · 等待画面”。帧输入水位达到对应序号时清除提示。它们均不表示网页业务完成，也不代表物理屏幕扫描完成。此实现不预测滚动结果。

## 验证与剩余限制

`tests/verify-input-feedback.mjs` 用真实 custom Chromium、Gateway 与 CanvasKit 的 Worker/主线程路径检查显式公开文本、8 类不允许预览的字段及 value getter 探针、源端格式化、焦点竞态、延迟 DOM 探测期间的 ACK、composition、Tab、内置 cursor、自定义 URL 剥离、hover 裁剪与取消清理。单测覆盖旧 ACK、排队焦点变化、旧反馈/租约/画面、组合撤销和滚轮合并。

物理系统输入法候选窗与辅助功能属于 C8，尚未验收。独立 CDP 实验发现：当组合输入替换非空选区时，`imeSetComposition` 的空文本取消会删除候选而不恢复原选区；Escape 和 undo 也没有恢复它。测试保留这一发现，验证本地撤销预览随后接受源端实际结果，不把它描述为完整系统 IME 支持。
