# Native 下载读取会话与文件寿命

第25顺序补丁增加NativeDownloadReadSession，由现有NativeDownloadLease创建。只接受已完成的真实下载：creator已结算，文件清理无pending或失败，full path等于target；每份lease终生最多一个reader，后续下载可在真实退休后复用全局额度。请求内容上限1字节至4MiB；每次读取最多3072字节，open/read从排队到回调返回只允许一个在途操作。非法范围或忙碌请求在排队前拒绝。

文件只在选定文件序列打开、访问和销毁。POSIX使用O_RDONLY、O_CLOEXEC、O_NOFOLLOW、O_NONBLOCK并fstat确认普通文件，避免跟随最终路径的符号链接或阻塞FIFO；其他平台明确不可用，尚未验证Native Mac。先检查长度，再以固定8192字节缓冲流式计算SHA256，返回小写十六进制；hash和后续chunk共用同一FD，读取前后检查长度及修改时间。4MiB用例验证实际边界、摘要及读取，固定缓冲来自源代码合同，未用内存采样器证明整个进程内存上限。这里也不证明父目录私有或可防所有外部路径竞争；Source私有目录仍待处理。

reader在投递任务前计入现有DownloadFileCleanupState.pending。Close按FIFO排在已接收open/read后，显式销毁完整IOState及其成员和文件，再向原线程投递独立ACK；ACK首先结算文件状态，随后才通过weak指针通知仍存在的reader。销毁UI会话也保留独立结算链。文件被unlink时实际FD仍持有inode，其内容继续占用同一lease预约，不能凭路径不存在归还额度。

Close返回bool仅表示关闭投递接受、已请求或已结束，不是物理退休凭证。closed与关闭回调只在ACK后完成；即使reader已经关闭，完整lease仍要等其他文件任务、URL owner和item/map删除结算。关闭投递拒绝标记失败且保留pending；回执丢失也保持pending，不在进程内重置额度。回退删除即便成功，也不能替代丢失的独立回执。

新增17项覆盖真实文件hash/空文件/4MiB/请求上限、未完成item与第二reader拒绝、非法范围及在途回调拒绝、unlink后FD与额度、文件关闭和origin ACK分离、在途读取关闭丢弃数据、销毁会话、终态期限关闭、截断自动关闭、符号链接/目录/FIFO拒绝、open投递拒绝后的空owner真实销毁，以及12次下载复用。期限用mock time推进31秒，文件/线程/销毁任务真实执行。Linux仅枚举测试自身进程/proc/self/fd，以device/inode计数实际引用。

两项故障在独立真实子进程隔离：实际停止文件base::Thread后，FD仍持有且pending/failed保留；另一项在活着的origin上明确注入关闭ACK投递拒绝，实际FD已归零但pending和全局预约保留。后者不是实际origin线程退出。父进程等待子进程真正退出，不在子进程内清零全局额度，也不把退出称作独立容器命名空间退休。另有既有失败清理子进程1项。

最终Linux ARM64 ELF无过滤365项（17新reader、72既有Native、276上游及竞态）全部RUN/COMPLETED、零失败/禁用；编译列表与执行逐一相同。17项从父版本源码差分得到、无移除、全部执行。三份子进程报告各1项通过。Mac/Linux JS专项各13项通过，未重跑完整1435项或SDK。

本轮组件GN/Ninja首次构建30步通过；准备脚本曾在实际运行前因过期delta断言拒绝，未改候选、实际源码或创建运行容器。最初未应用草稿将ACK放在析构体内，应用前改为完整对象及成员销毁后ACK；已应用第25补丁和收据未被覆盖。真实DownloadManagerImpl和NavigationRequest按实际编译命令产生ARM64对象，content/browser:browser依赖检查通过。未链接或运行整浏览器，未验证真实Page/RFH、cookies、成功恢复或完整传输。

25补丁完整回放和55实际修改路径、35个Native组件逐一比对。自有容器在实际终态、PID0和无OOM后删除，专用输出及Go缓存保留；原浏览器包19文件、观察器hash/文件身份保持。未访问禁止旧输出或演示，未提交、推送或使用子代理。

Source仍未接线或启用预算第二开关，Page描述符仍为transfersReady=false。后续连接原Page/document拥有的有界arm/ticket/info/read/release registry，处理原Playwright会话元数据、私有目录与unarmed策略，再做整浏览器运行验收。早期IO、远端网络服务物理退休、未知启动和原8小时增长失败未通过；K6部分、41项10完成/17部分/14待办保持不变。

见[结构化证据](evidence/native-download-read-session.json)、[原始请求见证](native-download-request-context.md)、[文件清理任务](native-download-task-settlement.md)及[进度](optimization-progress.md)。
