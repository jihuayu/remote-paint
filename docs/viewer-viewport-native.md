# 公开视口 API 的真实 Native 验证

本次将已离线安装的 SDK 经跨源 iframe、公开票据网关、实际 Rust Broker 接入 Linux 定制 Chromium 的 NativeSource。两次独立成功运行累计八次挂载使用 Mac Chrome：实际 Metal GPU Worker、CPU Worker、CPU 主线程各两次常规挂载，以及 Native 已应用后超时和随后重新挂载。CPU 两条路径通过关闭 GPU 明确选择；CPU 主线程还禁用 transferControlToOffscreen 能力，实际渲染和网络未替换。

960×640、640×400、720×480，以及超时后 800×500 的 Source DOM 尺寸、viewportVersion、已提交 Viewer frame 及独立像素探针相符。窗口尺寸编码色块、随视口移动的右下角标记、原图 PNG 编码像素、普通 Canvas2D 和真实远端输入计数均校验。尺寸 no-op 严格释放已按下的键/鼠标，保留原租约和输入序号下界，再续租恢复。

Source WebGL2 实际读回绿色 `[26,191,64,255]`，Viewer 中为黑框及精确的“WebGL 无法显示”字形。六次常规挂载的独立文字参考像素，在允许一像素栅格边缘差异的比较中 precision/recall 均为 1；普通 DOM、图像及蓝色 Canvas2D 保持正常。

真实 Native 图像进入客户端 SHA 校验后，用明确的测试 gate 暂停校验。视口 no-op 回执和交还均在释放 gate 前完成，新图像像素则在校验释放后出现。较早排队的帧可以完成，所以不能把“帧号不变”当作校验阻塞的判据。首轮确实因该错误断言退出1，失败和完整回收收据已封存；修正后的合同改查对应图像的编码像素，没有修改生产队列或阈值。控制耗时仅用于这个暂停场景的先后关系，不是物理呈现延迟或 N1 指标。

另一测试 gate 放在实际 Native resize 屏障之后、回执完成之前。此时 Source 确已成为 800×500；客户端超时返回固定 CHANNEL_TIMEOUT/unknown，旧 iframe 被回收，Source 待办保持占用直到 gate 释放。随后重新挂载获得新尺寸像素，没有声称取消回滚了 Native 变更。

允许的宿主实际通过生产 CSP；改用未列入 allowlist 的 localhost Origin 后，Chrome 报告 frame-ancestors 拒绝，未分配票据。每次销毁后，Source peer/控制权及 Worker targets 回收。最终三组采样到的 Mac 浏览器 PID 均 ESRCH；两个独立 Linux owner 各七个已固定进程身份退休，Source/Broker/公开服务/工作负载关闭，容器退出0、PID0。捕获路径没有 Node map/publish/Runtime.awaitPromise 调用。

原始 v1 失败、v2 成功及 v3 CPU Worker 补充成功、实际退出码和哈希独立保留；三次运行的生产模块、Native Source 实现、SDK 包及二进制字节相同，修改仅在测试验证器及说明。当前三条支持渲染路径均通过此 Mac Chrome / Linux Source 矩阵；更多设备/物理 IME、完整长期物理内存与丢包/延迟矩阵仍待继续。Session provider 是只服务这一真实 Native owner 的测试适配器，不替代尚未完成的生产 Docker Native 端点集成。原8小时失败和192MiB增长门槛保持，未自动重跑或强制GC。见[本次收据](evidence/viewer-viewport-native.json)。
