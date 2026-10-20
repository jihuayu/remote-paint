# K8b2：取消与原调用效果报告

本检查点提供原Run的显式停止入口和有界效果报告。它使用实际SQLite读事务、持久执行器的实际待定任务和已有end，不提供页面副作用回滚。当前通过实际HTTP/SQLite及夹具provider合同，真实Native端到端、Node/Python流SDK和签名Webhook仍待；K8继续部分实现。

## 停止与只读查询

`POST /v1/agent-runs/{arun_UUID}/cancel` 要求独立 `agents:end`，无请求体，调用同一原Run的已有幂等end，再返回第一份 `agent-cancellation-v1` 报告及Location指向 `/cancellation`。cancel与end共用原独立请求/实际鉴权配额，不占普通读或事件流配额。断开或丢失HTTP回复不撤销已承认的停止，相同Run重试不重复end或副作用。HTTP 202表示pending/settling；200也可能报告reconciliation-required，只说明已获得当前报告，不能当作停止成功。

`GET /v1/agent-runs/{arun_UUID}/cancellation` 要求 `agents:read`，只读观察，不调用Source、不启动停止。原Bearer/可信租户、Origin拒绝、精确Registry/Executor及存储确认保持。read不自动授予停止，end不自动授予读取；有end权限的POST可取得自身停止的安全结果投影。未知租户与Run返回同一404。此GET只允许唯一after查询，Last-Event-ID不适用于这两个接口，POST不能附加游标或隐藏选项。

报告固定原Run/Session/region/version、观察时间、Run state/holdsWriter/beginDispatch/endDispatch/关闭证据种类/固定错误，及本executor内真实ordinaryPending/endPending、是否恢复隔离与关停。scope固定original-agent-run，不证明整个Browser/Engine namespace或远端未知工作已退休。没有转出动作参数、页面内容、幂等密钥/摘要、私有worker/target/control身份或证据hash。

status含义：not-requested为当前Run尚未关闭/关闭中；pending为关闭中或实际end仍未结束；settling为持久Run虽已closed、本executor实际普通/end任务仍挂起；closed为原Run已closed且本executor两条实际任务均已结束；reconciliation-required为未知/恢复隔离且当前没有正在执行的关闭可证实结果。closed不清除未知副作用，也不升级为业务成功。未知begin/end或恢复隔离时仍保留实际holdsWriter状态，不凭报告、HTTP200或容器缺席释放任何额度。

## 明确哪些副作用无法由取消撤回

每个原Invocation返回固定ID、tool、state、dispatchStarted、裁剪的input-injected回执/错误和更新时间，并给出effect：

| 持久状态 | effect | 取消的含义 |
| --- | --- | --- |
| intent | not-dispatched-yet | 尚无派发标记；仍需等待实际队列记录最终拒绝，不能提前称作已经取消。 |
| requested | unknown | 已进入可能发送边界，可能仍在执行；end不能证明它没有产生效果。 |
| injected | input-injected | 已确认输入注入；不会因end而撤回，仍不等于业务成功。 |
| rejected | not-dispatched | 经原类型化边界确认没有派发该动作；dispatchStarted可能只是已尝试RPC。 |
| unknown | unknown | 发送后超时/回执丢失/原owner丢失；保持未知，不重放，也不当作注入成功或未执行。 |

rollbackSupported=false、rollbackPerformed=false、businessSuccessConfirmed=false明确保留在每页。已注入/结果未知的动作不能由本取消接口回滚；应用如需补偿，须在重新观察业务状态后单独发起新的显式操作，不能盲目重试旧副作用。Run的实际关闭与调用结果各自独立：已closed后迟到的真实注入回执可以使原requested变成injected，报告会观察这次变化；实际任务未结束前仍为settling，不伪造额度返还。

## 固定版本分页与缺口核对

每页最多4个原Invocation及16384字节公开投影，按原invocationId排序。读取使用原owner授权、实际SQLite BEGIN/COMMIT读事务；Run、事件序号、所选行/原绑定在同一快照验证，失败回滚，不增加Agent revision/事件或改变行/文件。SQL最多返回5个索引ID作向后探测，验证并投影4条，不把全部调用加载到JS后计数。配置总调用上限可达160万，因此不在每个请求里逐条扫描验证全部历史，也不编造全局汇总；数据库查询成本仍受原配置规模/索引与主机影响，本逻辑页预算不是硬实时或全进程物理保证。

page.generation使用原Run的持久事件序号（`aec1.arun_UUID.SEQUENCE`），而不是泄露其他租户活动的全局Agent revision。page.nextCursor为 `acc1.arun_UUID.SEQUENCE.ainv_UUID`，绑定Run、该版本与最后一条原调用。只要原Run任何状态/调用改变，旧版本继续分页返回409 AGENT_CANCELLATION_CHANGED，调用方须从第一页重新枚举；跨Run、未来版本、虚构或不属于原Run的锚点400，错误不毒化executor。其他Run的更新不使该游标失效。

page.completeRun仅在第一页且hasMore=false时为true，说明本页覆盖该快照所有原调用，不代表结果全已知。多页消费者须保存同一generation，逐页累积至hasMore=false，任何409都丢弃旧组合重读；不能把最后一页误当整个Run的报告。没有跨页冻结的历史快照/服务端大数组保留。

即使事件64条保留窗出现gap，原Invocation持久行仍可按此接口完整枚举当前结果，结合原Run状态和已知幂等记录进行缺口核对；这不能补回已淘汰的所有中间事件，也不能重造缺失时间线。事件SSE的稳定eventId与游标仍按原协议使用，Node/Python流客户端接线待后续。

## 验证与未完成项

22项新增合同及扩展157项通过：实际owner/只读事务/字节未变、4条分页与全原调用枚举、同Run变化栅栏/其他Run不影响、Unicode上界、原意图尚未派发与实际begin挂起、Run已closed但原调用仍挂起、迟到注入/未知结果保留、失败end继续保留writer、独立scope/租户/Origin/请求体、独立cancel鉴权容量、HTTP回复丢失/幂等停止、实际账本身份丢失，以及两个真实自有SIGKILL（文件效果后未回执、实际回执后）。恢复后分别报告unknown/injected，不执行新begin或重放；文件夹具不是Native页面效果证据。

首19项18通过/1夹具失败：损坏测试试图在独占打开的真实数据库旁另开写者，正确触发database is locked；修正为关闭后篡改并验证恢复claim拒绝，生产独占锁和限制不变。早期源码/失败日志保留。最终同一候选macOS完整1557项=1542通过/15平台跳过，Linux1557项=1551通过/6平台跳过，两端0失败/取消，22新项均实际运行无跳过、原1535名称保留；两端各两个真实SIGKILL。最终候选完整双平台结果见[结构化证据](evidence/agent-cancellation.json)，仅取得实际HTTP/SQLite与夹具provider资格，原Native端到端继续待验收。

独立完整浏览器v3本轮复用原缓存/允许输出，108份输入及args/patchState不变，改为Ninja单任务与Docker单核、8GiB上限及32GiB磁盘门槛保持；实际容器/PID已观察运行，尚未完成/执行验收。不得因观察超时重启，也不得prepare/改变运行中Chromium输入。正式浏览器/受保护采样器只读核对、无关peer与未知启动证据保留，无提交/推送/子代理，没有重跑8小时或放宽原门槛。全41项仍10范围内完成/18部分/13待办，K8/K6、Native下载readiness与原8小时失败不变。
