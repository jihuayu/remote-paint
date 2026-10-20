# Python SSE 解析核心与冻结消息

K8c2b1 先完成冻结消息模型和私有增量解析组件；下一独立任务继续实际HTTPX流的池、计时器、鉴权重连、Task取消及真实close容量。此处不声称Python SSE客户端或K8已完成。

公开 `AgentEventMessage` 联合区分ready/event/heartbeat/checkpoint，event含原AgentEvent，控制帧含对应冻结data。请求ID精确关联，控制游标不推进事件游标；`AgentClientError.cursor` 可携带最后已交付位置。事件和缺口DTO复用既有严格公共校验，冻结slotted dataclass/tuple保持，解析不接触动作参数、私有Source权限或Source操作。

解析器最多保留一份原始bytes chunk、一帧4096字节和一条待交付消息，没有消息队列；一次pull最多扫描8192字节，无消息而仍有缓冲时，后续IO owner必须先协作yield再继续。LF/CRLF、任意UTF8分片和有界注释支持；重复/未知SSE字段、多data、重复JSON键、非法UTF8/JSON常量、前置消息、身份/来源改变、事件序号跳跃及不规范游标均拒绝。

解析和交付分离。只有确认原待交付对象才提交从真实字节捕获的cursor和eventId；即使调用方绕过Python冻结标记改写消息，也不能伪造前进位置。丢弃未交付消息不进入seenID、不推进cursor，重续可再交付原事件。窗口、原始字节和事件计数不随重连续置；最多4窗口、每窗口64事件、总256事件和256个已交付ID，默认262144原始字节、可配4096..1048576。计数包括注释/控制/framing及实际收到的超预算chunk，超预算chunk不入保留缓冲。缺口或畸形协议是不可重置失败，记录仅保存有界错误元数据，不保留输入异常traceback。

EOF只有在checkpoint之后、无待交付/未消费字节/半帧时才表示本解析窗口完整；缺失checkpoint或截断帧明确中断、可由后续IO层有限重连，cursor不修复。`discard_window`和解析EOF都不能归还实际fetch/read/close额度，真正的IO清理门槛将在下一任务实现。

24项组件合同通过。包含一个真实HTTP/SQLite生产者的100ms有界窗口，真实输出Run和Invocation共6个事件，再以17字节碎片喂给解析器；该夹具在测试进程收集完整有界body，属于协议生产者兼容资格，不是SDK HTTPX生命周期或Native端到端证明。先前162项Python回归与8份包源码/公开类型预检通过，生产者随后扩展到Invocation后新增24项再通过。最终同一v2候选双平台完整1584项通过（macOS1569通过/15跳过，Linux1578通过/6跳过），原时限零失败/取消、原1584名称保留；隔离包两端各202项Node/162项Python通过，24新项和原138项均实际运行无跳过，严格TypeScript两端及macOS安装后4份类型样例/8份源码mypy通过，见[证据](evidence/python-agent-event-parser.json)。

HTTPX流迭代器/上下文管理、绝对期限覆盖暂停、真实未结束工作计数、独立连接池、退出与aclose、密钥撤销重连和完整Native效果仍需实现及验证。Node SDK与Python有限接口范围保持；签名Webhook、41项原范围及原8小时失败不因本组件而通过。Native470项和五调用方编译仅继承，Chromium输入与缓存保留。

冻结v1后补充坏RequestId边界，复现后续窗口错误误用前窗口ID；现在在校验新窗口头前清空旧关联，修复后24项通过。旧候选/轮子、失败用例精确源和日志均保留，v2重新冻结全量/安装包资格。游标和额度规则未放宽。
