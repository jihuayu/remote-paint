# Python SSE 实际传输 SDK

K8c2b2 新增 `runs.events(run_id, after=..., reconnects=0..3)` 惰性异步迭代器与上下文管理器，公共 frozen/slotted 消息沿用解析核心。入口同步捕获并校验原 Run/游标，第一次 `anext` 才发送。最多四个窗口，fresh Bearer/原 last-delivered cursor 重连，只有实际交付的 agent 事件推进游标；控制消息和 Source 状态不构成业务成功。缺口明确终止，由调用方决定如何对账。

默认独立8路事件池，硬范围1..64；绝对60秒期限范围0.1..120，覆盖暂停消费、首包、正文与重连；默认262144原始字节范围4096..1048576，跨窗口统计 SSE 和 JSON 错误正文。每连接最多64事件、每迭代器256，解析器一chunk/4096字节帧/一个待交付，扫描8192字节协作yield；没有后台消息队列。HTTPX实际接收chunk的分配属于底层库，解析器计数不冒充内核或解码前物理内存门槛。

实际 send/read/response-close/iterator-close 各有原任务所有权。局部超时或调用Task取消仅结束观察，开始一次真实清理；非合作任务未结算和close失败继续占事件额度，不把 `response.is_closed` 当完成证明。普通/end/cancel容量独立。重连必须等上一窗口真实close/read全部完成，50ms退避可被停止信号唤醒。正常上下文退出等有界close观察，异常退出保留原应用异常并继续后台清理；全局client close单飞并覆盖事件池。读取关闭不会结束Source Run。

32项新增合同涵盖非合作send/read/close、暂停期限、取消游标、并发pull、跨attempt字节预算、初始/流内缺口、严格header、late response和全局close。8项实际HTTP/SQLite夹具覆盖多窗口六事件、reader break不结束Source、实际普通任务未结算时独立cancel、重连重新鉴权撤销、两种retention gap、一次确实执行的TCP断开与同端口HTTP重启、独立read/end权限。该夹具不使用原Native provider，不代表完整Native事件或Webhook验收。

保留首轮32项的两个错误：关闭client的同步异常断言写错；停止后重连worker仍等待50ms而导致close observer超时，后者已修复且未放宽时限。后续补强drops计数揭示夹具错误：生产者先写id，原startsWith(event)从未触发TCP断开；修复为逐行匹配并要求drops==1，旧日志保留，不把早期绿色误称TCP故障验收。

最终同一冻结候选的完整双平台、202项Node/194项Python隔离包及类型资格尚待执行。签名Webhook、原Native端到端与完整K8继续待做。41项保持10完成/18部分/13待实现，原八小时失败保持，不自动重跑。
