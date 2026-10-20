# 下载拒绝后的 Artifact 清理

本检查点修复一个错误路径：download.path() 已成功返回、浏览器已完成文件时，超出保留预算或 context/文件元数据校验失败仍必须执行并等待 Playwright download.delete()。此前只 unlink 真实文件，因 r.error 存在而跳过 delete，留下 Artifact 通道。现在用独立 pathResolved 标记已确认的成功完成；unlink 后仍等待真实 delete，并在它结算前保留 Run 的实际清理占用。

已确认完成的文件不再发多余 cancel，避免在 Artifact 删除期间对完成对象发取消。取消请求失败且没有成功 path 证明时，清理失败保守保留：release 失败、ticket 不释放、不允许重 arm，Run.close 不能伪报成功。若之后真实 path 成功、文件与 Artifact 均删完，则可据实际完成事实退休，不把先前 cancel 失败变成永久误报。删除失败同样保守阻断。

新增4个故障合同：超限文件的真实 delete 未结算时 release 必须等待且不 cancel；delete 失败不能 release/rearm/成功退休；cancel 与 path 均失败时保持清理失败；cancel 失败但随后 path 与 delete 确认完成时可正常退休。23项下载核心测试最终全通过。首轮21通过2失败来自通用测试清理钩子重复抛出预期的 close 失败，现显式配置预期错误并始终清理 control；原失败日志保留。

真实 Linux Native 专项 v4 通过：13个已完成原Page文件含8次连续超限拒绝及1次受信任文件名校验故障，全部恰好一次实际 Playwright delete，真实文件消失，固定版本 driver 的只读通道注册表确认原 Artifact 已移除；Page仍存活、同文档继续工作。路径观察在原 download 事件内先于 Agent 清理发起，避免测试在对象删除后才取路径。内部注册表仅用于固定依赖版本的测试，不成为产品接口。网络cookie/Blob/空文件、导航/实际慢下载取消/end和人工接管回归保留，5个已知原生进程身份确认退休。

前三版 Source 专项未通过，实际退出分别143/137/137，均已保留并清理各自容器，不能合并成通过时长。最初把等待归因于 Playwright 已销毁通道回复竞态，证据不足。随后 v2/v3 都在已有4次下载及6次重复之后停住；Chromium LocalFrame::ShouldThrottleDownload 的真实代码规定同 frame 1秒最多10次，之后请求直接丢弃，不会延期触发 download 事件。原验证器无期限等待一次事件，因此挂起。v4只在测试 click 前间隔150ms并将事件等待限制15秒，保留浏览器突发限制，不重放同次动作、不改生产超时。原诊断原文及明确更正一并封存，未把推断作为已证实结论。

同一产品候选的138文件1425项JS双平台零失败：Mac1410通过15平台跳过，Linux1419通过6跳过。当前70服务/合同输入双平台全新目录离线175Node/118Python/TypeScript通过，Mac公共2文件及源码6文件Mypy通过；Node21成员包、Python11成员wheel与父检查点字节一致。公共新装Python进程另一次完整Native首次通过：原文件、人控、unknown历史/隔离不变、408/取消保留实际槽、独立end、6Run关闭8injected/1unknown及namespace退休。后续v2..v4仅独立Source验证脚本变化，全部产品、138个根测试和70个安装验证输入逐hash证明与实际执行版本相同；没有把非执行脚本的变化描述为全部测试重新运行。

本次没有完成总物理预算。Playwright Download 构造时仍加入 BrowserContext._downloads，Artifact删除不会移除此集合中的Download；失败/cancelled path 的公开 delete 又会因原失败抛出，不能据此获得成功退休收据。Chromium Browser.cancelDownload 只 Cancel(true)，不是 DownloadManager item Remove。现有/tmp tmpfs256MiB和cgroup2GiB是整个Session外层上限，不是逐文件写前预算；fstat完成文件的cap更不是写盘前硬限额。

下一步需要原浏览器内写入前准入及完整item/partial spool/Playwright元数据生命周期：限制必须覆盖实际append、并行/sparse offset、重试、rename和未arm/额外下载；失败和取消也需确认退休。使用固定原BrowserContext/Page和窄版本化受信任能力，不重新抓URL、不换context、不开放公网CDP或原始Agent控制。任何新浏览器构建须单独输出并保留现有缓存和固定产物。源码调查及hash见证据，设计尚未实施，不提升门槛状态。

K6仍部分，41项保持10范围内完成/17部分/14待做；完整定位/frame/按句柄写、上传/Profile、K7/K8/K4、unknown Engine Start、N1/设备及原8小时增长失败继续。WebGL“WebGL 无法显示”黑框和其他显示保持；没有重跑8小时、放宽门槛、强制浏览器GC、修改采样器/演示/无关peer，没有暂存、提交或推送。

见[证据](evidence/download-artifact-cleanup.json)、[下载SDK](python-page-download-sdk.md)与[进度](optimization-progress.md)。
