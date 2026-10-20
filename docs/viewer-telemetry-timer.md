# 浏览器计时器接收者修复

首次新API真实Native运行失败：GPU Worker初次首帧/性能与画面通过，但Source真实改为640×400后，宿主性能等待20s超时，浏览器反复Illegal invocation。Source实际退出0、Viewer实际1；七个Linux身份、一组Mac采样PID、Worker、容器与服务均回收，无清理错误。原907文件运行、日志和失败ZIP保留；没有把初次首帧当作三模式验收完成。

采集器将Window.setTimeout/clearTimeout存为私有函数后，以this.#set / this.#clear调用，实际接收者成为ViewerTelemetry实例。Node计时器和原调度夹具接受任意接收者，掩盖了浏览器全局API约束。新增同时检查安排和取消接收者的回归，修复前14项中13通过/1失败，直接证明实例被当作this。

构造器现在用词法包装以普通函数调用安排/取消计时器。单计时器、250ms采样间隔、固定字段/授权代次和公开API保持；不通过屏蔽浏览器错误或跳过指标来放宽测试。相关215项通过，103文件886项完整回归Mac871通过15平台跳过、Linux880通过6平台跳过，实际均0。新16文件私有SDK双平台离线安装各77 Node/16 Python、严格TSC及Mac Mypy通过，未发布。

这仍是修复的Node/保存入口合同检查点；必须使用新安装包重跑真实Native GPU Worker、CPU Worker、CPU主线程，才可确认浏览器故障已消除。原失败不能被本回归覆盖。N1物理时延/轻微丢包、生产Native端点/全部Agent栅栏和8小时增长仍未通过；41项9/15/17，原失败与192MiB门槛保持，未自动重跑8小时、强制浏览器GC、改演示/采样器或暂存提交推送。见[证据](evidence/viewer-telemetry-timer.json)。
