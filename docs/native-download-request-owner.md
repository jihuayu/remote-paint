# Native 浏览器侧 URL 持有者退休回执

文件清理回执不能证明底层 URL handler 已经结束。InProgressDownloadManager 原本只从容器移除带 OnTaskRunnerDeleter 的指针，真正析构稍后才发生在 IO 序列；取消回调或容器中没有条目都不是实际退休凭据。本次为 UrlDownloadHandler 加入 Native 开关快照状态，并将同一状态句柄放入该请求的 DownloadCreateInfo，供后续准入 lease 在 item 分配前持有。

状态依次为 Active、Queued、OwnerDestroyed、Acknowledged；失败为 Failed。退休入口接管实际持有者，在其原 IO 序列显式析构完整派生对象和成员，然后才向调用序列发送回执。自然停止、取消所用的停止回调以及 manager 销毁都进入这条路径。调用方移除 handler 后仍能保留句柄；只有 Acknowledged 表示这份浏览器侧持有者回执已完成。未走退休包装器的删除记为失败；投递拒绝不伪造回执，原线程退出导致的回执丢弃停留在 OwnerDestroyed。非Native对象不分配该状态，继续使用原OnTaskRunnerDeleter。

9个新用例使用真实线程、实际Mojo句柄与对象。覆盖阻塞析构时端点仍打开、析构后的端点关闭与原线程回执分离、注入退休投递拒绝后即使实际IO兜底销毁成功也保留失败、真实原线程退出后的回执丢弃、未受跟踪删除、开关快照及非Native deleter。另有3个实际ResourceDownloader导航响应拦截与InProgressDownloadManager用例，验证DownloadCreateInfo携带同一状态、真实Mojo完成消息驱动自然退休、显式停止回调以及manager销毁。没有借用模拟成功回执代替实际析构和端点状态。

投递拒绝用例是对存活IO线程的明确故障注入，其原deleter仍能实际完成兜底销毁；没有把它称为真实IO线程已经停止的运行验收。真实已停止IO无法再销毁持有者时仍依赖外层进程/命名空间退休，不能据此归还额度。这一回执也不证明远端网络服务的请求或缓冲已经释放；没有HTTP或网络服务物理退休验收。

最终ARM64 ELF无过滤315项全部RUN/COMPLETED、无失败/禁用：9新增、30既有Native文件合同、276上游与竞态。编译出的用例列表与结果逐一相同。最终双平台输入/输出收据/打包专项各13项通过。没有重跑完整1435项JS或SDK，也未编译运行新的headless浏览器。

保留三次候选和构建：第一次被Chromium复杂构造函数内联检查拒绝；第19个顺序补丁将构造/析构移到cc，未改写已应用第18补丁的收据。第二次生产对象通过，但夹具的安全策略签名、manager公开基类回调调用方式及弱引用成员顺序不正确；仅修正夹具，第三次GN/Ninja2步和315项测试通过。前两次未执行旧测试ELF。所有自有容器终态后移除，原自有输出与Go缓存保留；禁止的旧输出、演示和采样器未访问/改动，canonical浏览器保持原hash。

仍未实现：真正的item分配前准入、总字节/数量预留、文件/URL回执与item移除的联合lease释放、网络服务退休、文件身份/其他句柄、Playwright元数据上限、原页面的受信任版本化下载桥和unarmed策略协调。没有用一个永久耗尽的下载计数器代替这些要求。本次仅补齐可复用准入需要的浏览器侧持有者回执。K6仍部分，41项保持10完成/17部分/14待办，生产Native、原8小时增长失败和整体目标仍未通过。未提交、推送或启动子代理。

见[证据](evidence/native-download-request-owner.json)、[文件任务回执](native-download-task-settlement.md)及[进度](optimization-progress.md)。
