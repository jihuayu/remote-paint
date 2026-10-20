# Viewer 与页面活动的生命周期

显示消费者使用 source.setDemand(count)。源页面的采集、序列化只由显示需求触发。Agent 的 DOM、输入、截图或业务流程可能需要 rAF/layout 继续推进，即使没有 Viewer；这类调用应持有独立页面活动租约：

```js
const releaseActivity = source.acquirePageActivity();
try {
  await performAgentWork(source.page);
} finally {
  releaseActivity();
}
```

租约可以嵌套，每个释放函数幂等，只释放自己的活动。source.activityDemand 用于观察活动数量。resize 暂停源时钟并排空旧捕获后，会按当前显示/活动需求恢复；最后一个 Viewer 离开不会终止仍有租约的 Agent 活动。Agent-only 模式不生成显示场景。Source 关闭会清理活动，禁止新租约，迟到释放安全。

这是显式调用协议，不会自动判断任意外部 CDP 客户端是否工作。Viewer 已在隐藏/freeze时关闭显示及控制连接、释放渲染资源；可见/resume后以新渲染实例和完整基线恢复。Worker 未捕获异常、消息错误或10秒无心跳时，重建画布并进入主线程兼容路径；不会自动重新接管输入。15秒以上的可见页面时钟中断会重连并放弃旧基线。Worker 替换期间连接代数保持递增。

实际 Chrome 隐藏/冻结与 Worker 故障通过，物理系统休眠、BFCache及移动设备矩阵仍待验收，C11尚未完成。实际 Linux 原生浏览器验收见 [活动租约证据](evidence/page-activity.json)。
