# 渲染器轮换前的 Wasm 预算准入

CanvasKit 旧模块释放引用后，正常 GC 不保证在下一次轮换前回收其 backing。退休堆继续计入 `ClientMemory` 的合计预算，不能通过清账或强制 GC 宣称已经释放。

`RendererRuntime` 记录首次初始化实际观察到的堆大小。每次轮换先处置旧 presenter 并退休其堆，再为下一堆保留 `wasmInitialization` 额度；额度不足时不调用 factory。factory 返回后按实际堆大小调整额度，再构造 presenter。这里保留的是已观察到的初始大小，不是任意 factory 的最大分配保证；返回更大的堆仍须检查，失败时如实退休该 backing。

初始化期间取消或销毁，额度保持到实际 Promise 结束。迟到的模块进入退休账本，不重新创建 presenter。factory 拒绝、presenter 构造失败和正常成功均释放临时准入额度。canvas 上下文不可用时，`FramePresenter` 释放已取得的 `wasmBinary` owner。

6 条 Node 合同覆盖初始化前拒绝、factory 拒绝与显式重试、更大堆、presenter 失败、销毁竞态和并发调用共享一次初始化。CanvasKit/DOM 为明确夹具；实际 Chrome 对照则执行保存的旧版与候选版模块，在主线程和 Worker 各验证一次：

| 检查 | 旧版 | 候选版 |
| --- | --- | --- |
| 保留旧模块且耗尽轮换预算后的 factory 次数 | 4 | 3，拒绝下一次调用 |
| 已创建模块数（含初始模块） | 5 | 4 |
| canvas 创建失败后退休的堆数 | 1，遗漏失败的新堆 | 2 |
| 同一失败后销毁仍未释放的 owner | 1 | 0 |
| 初始化期间销毁后累计创建 presenter 上下文次数 | 2 | 1 |

每条渲染路径在拒绝前提交三次正确的蓝色像素。对照使用有界合成分配并刻意保留旧模块，模拟延迟回收；没有强制 GC。它验证预算准入和生命周期，不能作为真实 Native SKP 工作负载或物理增长验收。证据见 [轮换准入收据](evidence/renderer-arena-admission.json)。

原 783 文件独立 8 小时 v5 已失败：710 个样本覆盖约 28813.931 秒；带 secondary 状态下 Viewer footprint 中位数增长 217252008 字节，超过冻结的 201326592 字节门槛。其他九个状态/增长域及绝对上限通过，清理已独立核验。原始样本、策略和成功验收器保持原样。这次准入修复不表示原增长已解决；实际 Native 工作负载归因、物理边界及最终完整候选长测仍待完成。
