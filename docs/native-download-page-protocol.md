# Native 真实 Page 传输命令接线

第29顺序补丁在浏览器 PageHandler 实现 armRemotePaintDownload、getRemotePaintDownloadInfo、readRemotePaintDownload、releaseRemotePaintDownload 四个私有命令。每个命令要求版本1、进程 capability、实际可信会话、活动且非 fenced 的原 primary frame/document。客户端键来自 handler 自身不可变 UnguessableToken，不在参数中。token 32..256 字节、document 至多64字节、ticket固定39字节；错误键仍由文档封装拒绝。

handler 只弱持有原 WebContents owner。析构先废止 handler weak，再清除本地 owner/document 并通知 ClientDetached；SetRenderer 切换目标也先移出旧关系，回调重入后复查 handler、新旧 frame，避免覆盖重入产生的新目标。Page.Disable 事件订阅切换不等同于会话退出。异步回复核对同一 handler、原 owner、实际活动 primary document，使用非变更的 OwnsDocument 查询，不在回复中创建或收养新文档。成功释放已经清除了 ticket/key，故回复核对原 owner/document，而不要求已清掉的 ticket 继续存在。

读取和释放的生成协议回调放入共享的单次回复槽；Native 拒绝时由调用方局部槽明确失败，正常回调先移出槽再发回复。既有文档封装至多一个读取和一个释放等待者，并在失效/析构/期限结算，真实文件/URL/item/map lease 独立保留。断开时会话可能已无法接收网络回复；代码仍清理回调捕获且不以失败回复归还额度。真实 Page 会话这一时序尚未运行验收，不能由组件测试推定已经成立。

元数据使用与既有 Page.downloadWillBegin 相同的 net::GetSuggestedFilename 计算，截取513个UTF-16单元再转UTF-8，保留现有Source先slice(0,512)的行为，包括跨边界代理对。Native 在复制前检查结构有效的UTF-8（允许Unicode非字符码点）、至多1539字节及513个UTF-16单元，只有实际匹配lease成功Offer后才保存；其他Page、重复Offer或错误元数据不能覆盖它，真实释放后清空。未返回路径或下载URL。net文件名计算本身和原PW事件的全部元数据分配尚未证明物理上限。

读取offset限0..4MiB、chunk限1..3072字节，回复检查实际offset、长度、原文档，再用实际protocol::Binary::fromString封装原始字节。协议库把Binary转换为base64，3072字节至多4096编码字符；元数据最坏控制字符JSON转义的组件用例为3080字节。此处记录的是结构与边界设计和组件执行，真实生成协议在网络上的完整6144字节envelope仍待浏览器验收。

Linux ARM64 ELF无过滤415项全部RUN/COMPLETED，零失败/禁用，与编译列表逐一一致。父版本差分新增10项元数据用例、无移除；129项既有Native及276项上游/竞态保留，4份既有子进程报告各1项通过。新用例覆盖UTF-16/UTF-8精确边界、Source截断位置上的代理对、非法UTF-8先拒绝而不消耗lease claim、借用内容复制、其他Page和重复Offer、释放后换客户端及默认名、实际JSON转义大小。第30补丁允许结构合法的Unicode非字符码点；第10个真实lease用例同时证实旧谓词拒绝该输入、新谓词接受且元数据原样保留。第29已应用补丁与收据未改写；第一次414项绿色候选及其证据保留，但不足以验收这个边界。并未新增真实handler认证测试。

Mac/Linux专项各13项通过，未重跑完整1435项或SDK。实际浏览器和Blink协议生成后逐项确认：四个命令在浏览器生成头/源码中存在，在Blink生成头/源码中均不存在。实际owner、PageHandler、生成Page协议、DownloadManagerImpl和NavigationRequest五个TU按实际命令编译ARM64对象，浏览器GN依赖检查通过。没有整浏览器链接或运行，没有真实RFH、PW会话断开、导航/cookies/resume或Native Mac验收。

30补丁/64实际路径/35 Native组件完整回放与实际源码相同；自有容器终态/PID0/无OOM后删除，专用输出和构建缓存保留，原浏览器19文件和观察器hash/身份保持。未访问禁止输出/演示，未提交、推送或使用子代理。准备脚本一次变量替换错误在候选复制/源码准备/构建前纠正，失败记录保留，已应用补丁收据未改写。

Source预算第二开关仍关闭、桥接未接、transfersReady=false。下一步处理原PW浏览器会话下载事件/元数据与Source私有目录/unarmed策略，并用单独完整浏览器验收真实命令认证/回复/断开及cookies/导航/resume/期限/重复下载/物理退休；不能用此编译检查替代。早期IO/远端服务物理退休、未知启动和原8小时增长失败仍待解决；K6部分、41项10完成/17部分/14待办保持。

见[结构化证据](evidence/native-download-page-protocol.json)、[客户端回复](native-download-transfer-client.md)与[进度](optimization-progress.md)。
