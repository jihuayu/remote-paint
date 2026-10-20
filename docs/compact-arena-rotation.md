# Compact 模式提前轮换渲染器

Compact 的自动轮换触发点从 Wasm 硬上限的 70%（179.2 MiB）提前到 144 MiB。当前固定 CanvasKit 构建从 128 MiB 起步，原长测已观察到 153.625 MiB 的中间堆。提前触发旨在避免继续增长到 184.375 MiB 后再退休，减少尚未回收旧堆的成本。

144 MiB 是轮换触发点，不是分配硬上限，也不能约束单次操作的全部瞬时增长。Wasm 硬上限保持 256 MiB，总预算保持 640 MiB；旧堆继续完整记账到 backing 被回收。更小的自定义 Wasm 预算仍采用更严格的 70% 点；standard 和 large 保持原行为。没有强制 GC、清除退休账目或替换长期页面/Worker。

独立真实 Native 基线中，三个 secondary 各处理 400 轮图片变化，分别退休 5 个 184.375 MiB 堆。正常空闲 5 秒后仍分别有 0、2、1 个旧模块/backing，账本一致。这说明提前轮换有必要控制单个旧堆的成本，但不能据此判断是强引用还是 GC 时机。

验证使用相同 Native Source、Linux Broker、三个长期 Viewer、两个长期 Worker，以及 secondary 图片/resize/输入/缓存周转。实际退休堆大小、轮换次数、正确像素、上下文连续性、全部采样绝对上限和清理均需对照。结果由 [冻结检查点](evidence/compact-arena-rotation.json)所指收据记录；在完成该对照和最终长测前，不宣称原物理增长已解决。

原独立 8 小时仍为失败：带 secondary 的 Viewer footprint 中位数增长约 207.2 MiB，门槛 192 MiB。原样本、门槛与成功验收器保持不变，失败时长不累计。
