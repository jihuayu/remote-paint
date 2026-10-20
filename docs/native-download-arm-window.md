# Native 请求创建时的 arm 身份与实际准入

第32补丁把内部不可猜测arm身份在NativeDownloadRequestContext创建时一次写入const字段。浏览器既有NavigationRequest/显式请求捕获位置仍在异步检查及IO之前；响应阶段不查当前arm/current frame补身份。arm之前捕获的请求为空身份，旧窗口请求保留旧身份，即使响应后来到达新arm也不能升级。

进程静态注册表固定最多4个活动窗口，锁保护原Page process/routing/document（token至多64字节）、独立UnguessableToken、开始/期限、最大内容字节和已消费位。窗口最多30秒、内容仍限4MiB，同一活动Page拒绝第二窗口；过期可清理，关闭后可重新使用新ID。请求只保存ID，不强留注册表。没有重置API或以终生额度耗尽代替清理。

NativeDownloadBudget在delegate/item分配前验证不可变原文档/窗口，且每个arm只消费一个新下载。全局真实lease配额仍4、每文件仍4MiB；配额已满不消费arm。只有先临时Reserve、尚未创建任何lease而窗口消费失败时才回滚本次预留，既有lease的实际文件/URL/item/map预约仍按原退休流程归还。registry失效、释放、到期、析构先关闭窗口再运行外部取消回调；窗口关闭不返真实额度。Offer还核对原arm ID及既有Page/lifetime claim。

实际DownloadItem续传刻意走无RFH路径。现在仅原item/lease能生成NativeDownloadResumeRequest：新的请求nonce、原始arm和三份frame见证，不查询新arm或current frame。manager在异步检查前验证原guid、仍存活的lease/窗口，再保留这份原始context；无见证或失效即失败。见证只弱持有lease，避免参数对象延长已退休对象图；item在delegate返回后复查weak存活。可重试的INTERRUPTED item在原arm期限内等待，非可重试或取消仍退休。

21项新用例包括：arm前请求/旧窗口/不同Page字段拒绝；精确到期且不依赖UI timer先运行；4窗口、重复Page及循环复用；并发只能消费一次；窗口关闭时真实文件/URL/item预约仍为1；全局真实配额满时arm不消费，真实退休一个后可再用；实际manager准入先于item/stream；真实item生成续传见证并经实际manager/item/file接收同一lease；新nonce/原arm/guid检查，关闭原窗口不借新arm续传；参数仍保留时实际退休后lease只剩测试外部单一引用；同Page12轮拒绝旧快照并完成真实清理；同一实际registry跨中断保留arm，原item续传后再次ready、实际读出数据并完整释放。

最终Linux ARM64 ELF无过滤436项全部RUN/COMPLETED，零失败/禁用，与编译列表逐项一致；新增21项从父版差分确认、旧用例名无移除，139项既有Native和276项上游/竞态保留，4份既有子进程各1项通过。夹具明确分开“模拟请求创建”（先开fixture自有真实窗口，再在URL handler/响应前捕获）与“交付已捕获快照”（绝不补身份），没有生产绕过或reset。既有unknown/重复arm用例按更严格准入合同更新，原指针传播断言仍精确比较实际请求快照。

首轮因两处冗余测试别名遮蔽编译失败，未运行旧ELF；第二候选435项中两个旧夹具失败（导航测试未先arm、访问器把owner种子当请求快照），新增20项已全通过；修正为显式真实arm及实际请求指针后第三候选全435通过。第三候选435通过后补充同registry全链路用例，第四候选436项全通过；四份候选、失败日志和输入保留；第32已应用补丁及收据未改写，未放宽期限/内存门槛。

实际manager、NavigationRequest、WebContents owner、PageHandler、事件instrumentation五个依赖TU按真实命令编译ARM64对象，浏览器GN依赖检查通过；补充的第21项仅改测试，生产源码逐项相同，继承该实际编译结果。原生成Page/Blink协议字节未变并核对继承证明。Mac/Linux源码专项各13项通过，未重跑完整1435项或SDK。没有整浏览器链接/运行、真实RFH/cookies/HTTP续传/PW会话断开或Native Mac验收；本步续传是实际item/manager/file配合模拟网络响应，不能作为真实浏览器网络/cookie证明。

32补丁/68路径/35 Native组件完整回放与实际源码一致；自有容器终态/PID0/无OOM后删除，缓存/正式浏览器19文件/观察器hash和身份保留，未访问禁止输出或演示，未提交/推送/使用子代理。Native未arm准入拒绝已实现，Source私有目录和桥接尚未接，预算开关仍关闭、transfersReady=false。下一步完成Source接线及私有spool，再用单独完整浏览器验收实际请求身份、原Page/cookies/realm、PW元数据、认证/断开/envelope、导航/续传/期限/复用和物理退休。41项10完成/17部分/14待办、K6部分、未知启动与原8小时增长失败保持。

见[结构化证据](evidence/native-download-arm-window.json)、[旧事件隔离](native-download-legacy-events.md)与[进度](optimization-progress.md)。
