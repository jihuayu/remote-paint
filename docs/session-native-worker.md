# Session Native worker 边界（开发中）

`service/session-worker.mjs` 实现一进程、一Session的私有控制通道，`native-session-resource.mjs` 持有异步Native启动结果并清理，`native-session-worker.mjs` 是待接入受管Linux容器的入口。同库运行时身份/分配意图账本已通过独立合同，但尚未接通SessionRegistry的实际Native provider与容器驱动，真实Chromium/Browser进程集合及Viewer票据验收继续待做。

## 启动与通道

worker配置固定的sessionId、tenantId、region与随机owner key的SHA-256。启动前先安装输入、失联、信号和关闭处理，发WorkerHello；在收到绑定同Session且owner key匹配的Start之前不构造资源。owner key与初始页面URL只走私有stdin，Ready只返回协议、Session ID及版本。该key不充当管理API key、Viewer ticket或人工控制租约。

一行一个严格UTF-8 JSON帧，最多32 KiB，使用固定缓冲区，解析后清除缓冲内容。只有Start、OwnerHeartbeat、Close三种命令；Start只允许一次，region与固定配置一致，初始URL/TTL有界。无任意CDP、文件路径或JS执行接口。无效身份、重复Start、额外字段、畸形/超大帧均关闭当前worker，不回显页面URL、key或底层异常。

启动握手默认5秒，总初始化期限60秒。资源所有者先同步建立，后执行initialize；关闭等待真正的启动结果，晚到的资源仍须关闭，不能在Close之后发布Ready。资源在初始化尚可能继续分配时提前返回closed会被拒绝。Native wrapper要求实际nativeAutopublish、Broker、控制面、连接的Browser及Renderer hash；其版本由实际Browser版本和Wasm hash组成。仅有fixture模型验证了这些检查，生产入口本轮只做语法检查。

## 失联与关闭

owner EOF、控制流错误、进程disconnect、SIGTERM/SIGINT与owner租约到期都会先建立同一个关闭等待点，再通知AbortSignal，避免同步abort回调重入时重复清理。owner租约默认30秒，由可信父端心跳维持，独立于人工输入租约和SessionRegistry TTL。Session的实际过期传播/健康丢失与Registry状态同步须随Native provider接入另行验收。

关闭最多等待10秒。资源close不确认、启动结果未知或关闭超时，会返回CleanupIncomplete并退出1；启动异常不暴露原错误。Native启动抛错且没有返回可检查的live句柄时，worker不会据异常断言所有外部资源已消失。外层运行时仍须按持久的资源身份核对并关闭整个进程/容器集合，然后才能向Registry确认归还配额。不能只凭启动器PID退出或worker的逻辑Closed消息宣称整个Native进程集合已退休。

每个worker进程退出前，stdio保留不捕获Session对象的错误接收器，防止最终Closed通知遇EPIPE后变成未处理异常。资源关闭与最后一条通知送达分别判断。外层运行时负责完整namespace退役，入口在关闭结束后有限刷新并退出；整个进程不用于复用下一个Session。

## 持久运行时意图

`SqliteSessionStore` 现使用同一私有SQLite文件保存运行时记录，schema为v2。打开合法v1账本时先验证全部Session、操作、幂等绑定与引用，再事务迁移，保留原Session修订号；空、外来或损坏账本不会被重建。运行时有独立修订号，避免破坏Registry对逐次写入确认的要求，排他锁、0600文件、外键及FULL同步保持。

内部接口为 `claimRuntimeProvider`、`loadRuntime`、`commitRuntime`、`releaseRuntimeProvider`。每区域先固定deployment和daemon身份，以私有Symbol令牌排他持有；已有活动Session却没有原运行时绑定时拒绝直接接管。每Session只保留一个运行时身份，记录owner key哈希、配置哈希、固定镜像ID及不可改绑的容器名/ID，不保存初始URL或原始key。

普通阶段为 `intent → requested → created → ready → closing → retired`。派发意图只能确认一次，必须早于真实创建；重获所有权后的原记录只能向关闭/退役推进，不能重新派发或发布Ready。关闭开始后拒绝晚到的派发与Ready，允许把恢复查明的原容器ID绑定到关闭中的记录。已派发却没有已知ID的分配，不能仅凭暂时查无对象或“没有效果”的猜测写成退役。Native Session的Ready和配额归还受对应账本状态约束。

退役字段只保存受信任内部provider提供的证据种类与hash，账本本身不执行或验证Docker/内核回收。后续driver必须真正取得并验证相应证据后才能写retired；测试中的容器ID、hash与外部文件效果均是明确夹具。45项初版合同通过后补充了实际Ready进程SIGKILL及Registry恢复，最终同737文件快照在Mac/Linux各46项定向合同全部通过；完整回归各419项无失败，Mac410通过/9平台跳过，Linux415通过/4平台跳过。错误SQL字段查询和夹具API名称问题的初版失败均保留。见[账本检查点](evidence/session-runtime-intent-store.json)。

当前独立8小时仍运行先前冻结的720文件副本，不包含这个新增服务层；它的结果不能代替Native provider、TTL/健康传播、整组namespace回收或Viewer角色/票据验收。

## 当前证据与剩余条件

轻量合同运行真实Node worker与叶子子进程，验证认证前无分配、重复启动、同批Start/Close、父端EOF与租约失效、心跳、晚启动收尾、提前关闭假回执、abort同步重入、失败脱敏、UTF-8分片/限长和期限。stdout在释放中关闭的失败已保留：此前移除了错误处理器，资源虽关闭仍因EPIPE退出1；修复后正常完成关闭。测试夹具自身在setup失败时回收worker，叶子同时在继承stdin失联后结束，避免重复历史上的测试进程泄漏。

下一步需要把已验证的持久运行时意图接到真实分配，补真实容器或等效内核集合的创建与退役证明、Registry取消/TTL/恢复/健康变化接入，以及Native Gateway真实read/control显示角色和单次票据。Native集成及浏览器负载在当前独立8小时长测结束后执行。没有把本轮进程夹具或Native入口语法检查当作这些验收。
