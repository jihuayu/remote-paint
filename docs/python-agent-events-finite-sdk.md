# Python 有限事件页与原 Run 取消报告

K8c2a 为既有 asyncio SDK 增加 `runs.event_page`、`runs.cancellation`、`runs.cancel`，以及根包公开的冻结 slotted dataclass/tuple 模型。事件与取消游标为不同 NewType，方法在返回 coroutine 前严格捕获原 Run、游标和重试参数。下一独立小任务继续 Python SSE 生命周期；K8 整体保持部分实现。

事件页每次至多四条、每事件3072字节、公共页16384字节，沿用每Run64条保留窗口；sequence 连续，Run/Session/region/version/eventId和全部状态/派发/收据字段严格核对。事件模型分 Run/Invocation 两类，无动作参数、私有Source和input fence。时间只校验格式，因果顺序依赖序号，不以墙钟回退为错误。所有嵌套结果冻结，数组转tuple。

`AgentClientError.details` 仅允许明确409 `AGENT_EVENT_GAP` 的冻结 `AgentEventGap`，严格绑定原请求游标和真实缺口，异常原消息/路径/密钥不进入SDK错误。显式有限重试保留合法details与之前unknown，不自动跳过缺失历史。其余错误保持既有格式。

取消沿用幂等end，和 `runs.end` 共用独立实际HTTPX池与ending占位；普通调用阻塞不能占掉end连接。调用方Task取消或本地超时只结束观察，原send/read/close未结算时继续占位；关闭失败fence新请求，沿用既有单飞aclose。取消报告每页四个原调用，按固定Run事件generation分页，变化409需显式重读。原Run已closed但真实工作未结束时仍settling，input-injected/unknown/not-dispatched不相互升级，不声称回滚或业务成功。

20项新增合同包含四个真实HTTP/SQLite受控provider路径：历史缺口/tenant和read/end权限、固定版本分页及409、unknown效果、原任务迟到结算。原118项Python回归通过；新增20项修正夹具后通过，严格mypy包源码7文件及公开新类型样例通过。首次新增测试的四个子进程stdin未关闭导致清理等待失败、一个rejected派发标志约束误写，以及初次mypy参数/类型诊断，均保留记录；未据此放宽生产协议或期限。

最终同一候选双平台完整1584项通过（macOS1569通过/15跳过，Linux1578通过/6跳过），原时限零失败/取消、保留原全部1584名称；隔离包两端各202项Node和138项Python通过，20新项及原118项均实际运行无跳过，严格TypeScript两端及macOS安装后3份类型样例/7份包源码mypy通过，见[证据](evidence/python-agent-events-finite-sdk.json)。Node SDK保持既有已发布范围，Python SSE、签名Webhook和完整原Native端到端尚待。Native470项和五个调用方编译仅继承，原八小时失败未解决，41项仍10项在列明范围内完成/18项部分/13项待办。
