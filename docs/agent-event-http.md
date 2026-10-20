# K8b1：公开 Agent 事件页与 SSE

本检查点将 [K8a 持久事件内核](agent-event-journal.md)接入实际后端 HTTP。实际 SQLite、鉴权、TCP HTTP 与持久执行器接线已实现；Source provider 在新增合同中使用夹具。原生页面效果、完整取消副作用报告、Node/Python 流 SDK 和签名 Webhook 仍待，K8 继续部分实现。

## 公开协议

仅后端 Bearer API key，要求独立 `agents:read`；原 Origin 拒绝策略、可信认证租户、精确 Registry/Executor 与存储确认保持。`agents:observe`、写入或 end 权限均不自动授予事件读取。

- `GET /v1/agent-runs/{agentRunId}/events` 返回 `{data,requestId}`。data.schema=`agent-event-http-page-v1`，固定最多4个实际事件，稳定事件ID/序号及原Run/Session/region/version。`after`、`nextCursor`、`oldestCursor`、`latestCursor` 是公开游标。
- `GET /v1/agent-runs/{agentRunId}/events/stream` 返回 `text/event-stream; charset=utf-8`。两路均允许唯一 `?after=<cursor>` 或一个 `Last-Event-ID` 请求头，同时出现、重复头、空/非规范/跨Run/未来游标均拒绝。只有这两路允许该单一查询参数，其他管理路径仍拒绝查询。URL百分号、片段、额外参数与歧义路径拒绝。
- 游标为 `aec1.arun_UUID.SEQUENCE`，序号为0或无前导零的安全整数。它绑定原Run但不授予权限，也不是签名或秘密；实际认证租户始终独立核对。缺省从0开始，不默认跳到最新状态。

SSE先发送不带id的 `ready`，包含保留窗口/来源及起始游标。每个 `agent` 帧携带原 `agent-event-v1` JSON，`id` 为该事件的Run游标。`heartbeat`、`checkpoint`、`gap` 均不携带SSE id。心跳只表示连接观察仍在工作，不追加持久事件、不进入Source RPC，也不修改Run、Invocation或额度。

消费者仅在自己处理完 `agent` 帧后保存其id，并用它重新鉴权续接。通知可能在客户端尚未提交处理进度时丢失，因此消费者仍需按稳定eventId去重。心跳及checkpoint中的服务端传输游标不证明客户端处理完毕，不能替代消费者保存的游标。input-injected不代表业务成功，Run closed也不是完整浏览器namespace退休证明。

## 缺口与恢复

每Run仍只保留64条。过旧游标在响应头前返回409 `AGENT_EVENT_GAP`，`error.details` 含 `agent-event-gap-v1`、原after、oldestCursor、latestCursor、historyOrigin及missingHistory=true；没有事件和默认推进。流开始后若客户端慢写期间发生淘汰，最后发送无id的gap帧并结束，after仍为此前实际发送事件的游标，不发送成功checkpoint。

消费者必须显式处理缺失历史：查询原Run当前状态，使用自己原有Invocation ID查询最终结果，或用相同幂等键恢复原调用记录，不能重放一个新副作用请求。只有在应用接受缺口并自行核对后，才可主动从oldestCursor读取尚存窗口，或选择latestCursor只观察后续；这都无法补回已淘汰历史。此事件检查点不含完整业务快照；后续[取消效果报告](agent-cancellation.md)可用固定版本分页枚举原Run当前Invocation结果，供缺口核对，仍不能无损恢复已丢弃的中间历史。旧库显式migration-snapshot来源仍保留，不能当作新创建历史。

## 有界连接与清理

公开服务新增 `maxAgentEventStreams`，默认8、范围1..64，事件页与SSE共同使用独立请求/鉴权通道；普通请求和优先end各自原有通道保持。即使认证忽略AbortSignal且已超出HTTP观察期限，其事件鉴权配额仍占用至实际认证Promise结束，不能用新请求无限替代。已通过认证的流采用当时租户/权限，连接有有限窗口；每次重连重新认证，密钥撤销在后续请求生效。

可信服务配置 `agentEventStream` 默认：pollIntervalMs=250、heartbeatMs=10000、maxDurationMs=30000、writeTimeoutMs=5000、maxEvents=64、maxBytes=262144。最大时长配置60000ms、单写10000ms、事件64、响应体262144字节；参数必须为自身普通数据字段及范围内整数。身份/请求体读取仍受原requestTimeoutMs限制，SSE在完成认证和首个页验证后切换到自己的有限窗口。终止checkpoint写入和实际response finish额外各受单写期限约束，主机事件循环停顿不构成硬实时保证。

每次最多保留一个4事件页和一份不超过4096字节的编码帧；流不累计全历史。写入为串行，必须等真实write callback，若write返回false还必须等drain，之后才能发送下一个帧/读取下一页。迟到callback不重新推进。字节上限包含SSE字段、心跳及最终checkpoint，预留1024字节结束余量。到时长/事件/字节上限发送checkpoint后等待真实HTTP finish；慢写超时或故障销毁该reader，明确断开而不生成成功结果。TCP/HTTP framing、内核socket、全进程及SQLite物理预算不属于此逻辑响应体上限。

断连/Abort只撤销HTTP观察和对应监听器，不向实际Source工作传递取消，不归还其未结束的普通RPC或writer额度。真正停止后续输入仍需单独授权的end；end不能撤回已注入或结果未知的副作用。完整公共取消结果摘要将在下一独立检查点处理。

## 验证与范围

22项新增合同实际运行，全部通过：公开页与SSE稳定事件、重连续接、真实SQLite close/reopen后新HTTP服务保持原eventId、缺口前409及流中gap、心跳/事件/字节/时长上限、独立配额和非合作鉴权、Origin/租户/权限/游标严格输入、存储身份故障、实际待定Source工作不因断连释放、独立end、慢写超时、等待真实response finish及callback/drain双条件清理。慢写/finish的决定性边界由真实HTTP响应上的测试写回调拦截控制，单元背压用受控Writable；不能当作真实公网TCP拥塞或浏览器资源退休证据。

原首轮19项18通过/1夹具失败：fetch发送前规范化了原始URL，错误期待服务器看到片段/空查询；改用node:http原始path与重复header验证后，新旧HTTP55项通过。扩展104项也通过（已含慢写/finish）；随后补充实际冷重开，最终新增22项通过。原始日志与早期源保留，限制没有放宽。最终同一候选macOS完整1535项=1520通过/15平台跳过，Linux1535项=1529通过/6平台跳过，两端0失败/取消；22新项均实际运行无跳过，原1513名称保留。最终候选完整双平台结果见[结构化证据](evidence/agent-event-http.json)，本检查点仅取得实际HTTP/SQLite与夹具provider资格，未取得Native浏览器端到端资格。

未修改Chromium108份输入、下载预算开关、readiness、缓存、正式浏览器、受保护采样器或无关peer；无提交/推送/子代理，没有启动8小时或新的浏览器构建。上次自有完整浏览器构建v2实际143/PID0并移除，缓存输出保留，仍未通过。41项10范围内完成/18部分/13待办；原8小时失败、物理/设备/N1剩余门槛保持。
