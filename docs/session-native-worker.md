# Session Native worker 边界（开发中）

`service/session-worker.mjs` 实现一进程、一Session的私有控制通道，`native-session-resource.mjs` 持有异步Native启动结果并清理，`native-session-worker.mjs` 是待接入受管Linux容器的入口。当前尚未接通SessionRegistry的实际Native provider和容器归属账本，真实Chromium/Browser进程集合及Viewer票据验收继续待做。

## 启动与通道

worker配置固定的sessionId、tenantId、region与随机owner key的SHA-256。启动前先安装输入、失联、信号和关闭处理，发WorkerHello；在收到绑定同Session且owner key匹配的Start之前不构造资源。owner key与初始页面URL只走私有stdin，Ready只返回协议、Session ID及版本。该key不充当管理API key、Viewer ticket或人工控制租约。

一行一个严格UTF-8 JSON帧，最多32 KiB，使用固定缓冲区，解析后清除缓冲内容。只有Start、OwnerHeartbeat、Close三种命令；Start只允许一次，region与固定配置一致，初始URL/TTL有界。无任意CDP、文件路径或JS执行接口。无效身份、重复Start、额外字段、畸形/超大帧均关闭当前worker，不回显页面URL、key或底层异常。

启动握手默认5秒，总初始化期限60秒。资源所有者先同步建立，后执行initialize；关闭等待真正的启动结果，晚到的资源仍须关闭，不能在Close之后发布Ready。资源在初始化尚可能继续分配时提前返回closed会被拒绝。Native wrapper要求实际nativeAutopublish、Broker、控制面、连接的Browser及Renderer hash；其版本由实际Browser版本和Wasm hash组成。仅有fixture模型验证了这些检查，生产入口本轮只做语法检查。

## 失联与关闭

owner EOF、控制流错误、进程disconnect、SIGTERM/SIGINT与owner租约到期都会先建立同一个关闭等待点，再通知AbortSignal，避免同步abort回调重入时重复清理。owner租约默认30秒，由可信父端心跳维持，独立于人工输入租约和SessionRegistry TTL。Session的实际过期传播/健康丢失与Registry状态同步须随Native provider接入另行验收。

关闭最多等待10秒。资源close不确认、启动结果未知或关闭超时，会返回CleanupIncomplete并退出1；启动异常不暴露原错误。Native启动抛错且没有返回可检查的live句柄时，worker不会据异常断言所有外部资源已消失。外层运行时仍须按持久的资源身份核对并关闭整个进程/容器集合，然后才能向Registry确认归还配额。不能只凭启动器PID退出或worker的逻辑Closed消息宣称整个Native进程集合已退休。

每个worker进程退出前，stdio保留不捕获Session对象的错误接收器，防止最终Closed通知遇EPIPE后变成未处理异常。资源关闭与最后一条通知送达分别判断。外层运行时负责完整namespace退役，入口在关闭结束后有限刷新并退出；整个进程不用于复用下一个Session。

## 当前证据与剩余条件

轻量合同运行真实Node worker与叶子子进程，验证认证前无分配、重复启动、同批Start/Close、父端EOF与租约失效、心跳、晚启动收尾、提前关闭假回执、abort同步重入、失败脱敏、UTF-8分片/限长和期限。stdout在释放中关闭的失败已保留：此前移除了错误处理器，资源虽关闭仍因EPIPE退出1；修复后正常完成关闭。测试夹具自身在setup失败时回收worker，叶子同时在继承stdin失联后结束，避免重复历史上的测试进程泄漏。

下一步需要持久的运行时资源身份/排他归属、真实容器或等效内核集合的创建与退役证明、Registry取消/TTL/恢复/健康变化接入，以及Native Gateway真实read/control显示角色和单次票据。Native集成及浏览器负载在当前独立8小时长测结束后执行。没有把本轮进程夹具或Native入口语法检查当作这些验收。
