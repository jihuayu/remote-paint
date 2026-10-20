# 父端 Session worker 通道（开发中）

`service/session-worker-channel.mjs` 管理一个已归属的私有worker字节通道。调用方先取得真实启动客户端及其stdin/stdout，并传入来自ChildProcess close事件的clientDone；之后才能交给通道。完整运行时身份、容器/namespace与Native进程集合仍由外层provider持有，尚未接入本模块。

配置固定Session ID、region、随机owner key和私有流。`start({url,region,ttlSeconds},{signal?})` 在有效WorkerHello之后才写Start；先校验并捕获请求、使用fingerprint约束重复调用，同请求在启动中共享同一promise，不会重发Start。已关闭或退出的通道拒绝再次start，不能把先前已解析的Ready当成当前可用状态。

owner key与URL只写私有控制帧，状态与错误均不回显；请求/输入帧有界，发送完成和清理时清除缓冲，响应帧最多2KiB。仅接受同Session与同协议的Hello、Ready和关闭回执，以及启动前的固定配置失败。响应字段、版本、原因、限长及帧数受检查；畸形、重复、跨Session或未知消息关闭通道。写入受阻时不堆积心跳，只保留有限的关闭命令。

默认Hello期限5秒、Ready期限65秒、关闭等待12秒，owner心跳间隔5秒。signal绑定整个owner生命周期，包含Ready之后；取消会停止心跳并关闭通道，晚到Ready不使其重新可用。同一输入批次的Ready/Closed会在start返回前再次核对当前状态。缺少有效退出观测只记为未知，不把观测失败当成进程终态。

`close()`为single-flight，结果分别提供workerClose、workerCode、transportExit、closeTimedOut、startSent、failure，不提供provider的`status:closed`。关闭等待超时后phase为uncertain，terminal仍等待真实客户端退出；迟到的真实退出可更新状态，但不会改写已经返回的超时快照。退出0没有worker Closed回执仍不确认逻辑关闭；worker Closed加客户端退出也不证明全部Native子进程已退役。外层运行时必须独立核对完整资源身份与namespace，再给Registry归还配额。

意外退出/协议失败会在建立关闭等待点和撤销可用状态后通知onUnavailable一次，允许回调重入close。回调异常不恢复可用性，也不把其原错误暴露给外部。首次合同发现两个问题，已保留失败并修复：直接退出路径先清除了回调而漏报健康丢失；关闭后重复start复用了历史Ready。当前通道未直接连接Registry的Native provider，Session TTL/健康持久化传播、实际容器归属、真实Native角色/票据继续待验收。

合同含真实Node worker的认证、心跳、启动途中/Ready后取消、异常退出与逻辑清理结果；流模型覆盖同批Ready/Closed、背压、限长/畸形、期限及迟到真实退出。Native入口仍未执行，不能将这些合同当作真实Browser、Viewer或整组进程验收。关于close与exit事件的区别见[Node子进程文档](https://nodejs.org/download/release/latest-v22.x/docs/api/child_process.html#event-close)。


## Native资源失效的提前通知

Hello和Start之后新增精确四字段私有Unavailable报文：protocol、sessionId、type、code，其中type为Unavailable、code固定WORKER_RESOURCE_UNAVAILABLE。channel立刻产生CHANNEL_RESOURCE_UNAVAILABLE并关闭，父端同步撤销Ready/密钥；随后Closed/CleanupIncomplete允许resource-unavailable原因。通知不含原始故障参数，不能当作transport退出或完整namespace退役。公共Ready仍只返回版本。见[健康通知及真实故障对照](native-health-notification.md)。
