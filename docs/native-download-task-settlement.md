# Native 下载文件任务结算

Native DownloadItem 在创建时按进程开关快照分配 `DownloadFileCleanupState`。受信任 C++ 调用方可在 item 移除前取得并持有这个句柄；状态不依赖 item 的弱引用存活，因此 Remove 或 manager 删除 item 不能伪造文件任务已经结束。非 Native 下载保留原分支，不分配这个状态。

取消和保留文件两条路径把文件对象实际交给下载序列。取消使用 DownloadFileImpl → BaseFile 的真实关闭/删除结果；其他不支持确认的 DownloadFile 实现执行原 Cancel 后返回 false。文件对象在任务体中显式析构，包含其 timer、stream 和弱回调，然后才将结果回送原线程。pending 只在原线程收到任务回执后减少；失败持续保留，后续成功不会清除之前的失败。Detach 等待持有者析构，但保留可恢复路径，因此 pending 为零不等于路径已删除。

部分文件与已完成文件的 Native 删除都跟踪真实任务。旧 DeleteDownloadedFile 会跳过目录并返回 true，新路径保留并拒绝目录；已完成文件也不把缓存的 externally-removed 标志当作实际文件删除凭据。投递被拒绝时报告失败，不能把“没有任务在跑”当成成功。序列绑定文件用 OnTaskRunnerDeleter 防止在原线程错误析构；下载序列已退出且拒绝销毁时会保守保留对象，必须通过外层实际进程/命名空间退休处理，不能归还资源预算。原线程回执若被丢弃，代码保留 pending，未伪造结算。

13个新增用例使用真实 DownloadFileImpl、DownloadItemImpl、文件系统和任务线程：包括取消、阻塞析构、worker已完成但原线程尚未接收回执、失败持续保留、目录拒绝、真实已停止线程拒绝投递、不支持确认的取消、Detach保留文件、item移除后状态存活、实际item取消失败、已完成文件缓存标志及非Native分支。析构阻塞仅在测试夹具等待处显式使用测试专用同步许可。真实“已停止线程”用例验证路径删除投递拒绝；拥有文件对象的投递拒绝和丢失原线程回执的分支尚未做运行时故障注入，不冒充已覆盖。

完整 ARM64 ELF 无过滤运行306项：13新增、17既有Native写前/删除结果、276上游BaseFile/DownloadFile/DownloadItem与参数化竞态回归；全部RUN/COMPLETED、无失败、无禁用。实际编译出的 gtest_list_tests 与结果中的306个用例逐项一致。双平台输出/输入收据/打包合同最终各13项通过。

第一次GN因本地与上游同名测试对象冲突退出1，分离source_set后第二次GN/Ninja27步通过；随后真实C++执行因夹具未声明同步等待许可退出1。只修正夹具等待作用域，第三次GN/Ninja2步和306测试退出0，生产源码/限制不变。三次冻结候选、构建和两次测试证据均保留。所有自有容器终态后删除，仍使用原自有新输出和Go缓存，未访问禁止旧输出/演示，未重建canonical浏览器。

最终文档版本只相对实际执行的1147文件候选增加文档、结构化证据和进度。没有重跑完整1435项JS、SDK、网络或浏览器；历史证据保持原版本范围。这是原生文件任务的内部状态，尚未暴露新CDP/HTTP能力，也没有实现下载前item准入、总字节/数量预留、网络取消任务退休、文件身份/其他句柄、item maps或Playwright集合上限。Native/unarmed策略协调、K6、生产Native与原8小时增长失败继续待办，41项保持10完成/17部分/14待办。未提交、推送或运行子代理。

见[证据](evidence/native-download-task-settlement.json)、[前一取消结果范围](native-download-deletion-result.md)和[进度](optimization-progress.md)。
