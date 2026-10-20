# 远端视口操作的输入清理屏障

Viewer 在请求远端 viewport 时暂停旧输入。即使尺寸不变，也可能在暂停期间错过 keyup、mouseup 或组合输入结束事件。Source 因此在同一有界输入队列中，等待先前注入完成，清理按键、鼠标和组合输入，再重新验证租约并执行尺寸变更或返回 no-op。

鼠标先移到页面外再释放，沿用控制权交还时避免误触点击的行为。no-op 保留租约、控制 fencing token、epoch 和输入序号；它清理旧按下状态，并使此前已开始的语义反馈读取失效。后续 Viewer 可以从确认的序号恢复，而不会携带旧按键状态。

严格清理任一命令失败时，不进入 `Source.resize`，返回固定 `VIEWPORT_INPUT_RESET_FAILED`、`outcome=not-applied`，并撤销旧租约。已知按下集合保留到撤销屏障以便重试释放；原交还/关闭的尽力清理行为不变。该结果描述 viewport 未应用，不表示已发生的输入注入被撤销，也不宣称所有 Agent/CDP 写路径已受控制。

Node 合同检查实际 `ControlLease` 排队、持有状态、撤销竞态、失败分类及迟到反馈；CDP/Source resize 为明确夹具。Mac/Linux Rust TCP 合同还验证 inline/paired 路径中按下输入→no-op 清理并保留租约→实际 resize 回复。实际 Native、SDK 调用、像素与完整取消语义仍须后续验收。证据见 [输入屏障收据](evidence/viewport-input-barrier.json)。
