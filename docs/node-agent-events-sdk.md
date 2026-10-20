# Node Run 事件与显式取消 SDK

K8c1 为可信 Node 后端增加事件页、有限 SSE 异步迭代器、原 Run 取消与效果报告。原有 Session/Agent 接口保持；事件 SDK 不进入 Viewer，不暴露 CDP、动作参数或私有运行标识。Python 事件接口、签名 Webhook、完整原生浏览器验收继续待做，K8 仍部分实现。

`runs.eventPage(id, {after?, signal?, retries?})` 每页最多四条，返回冻结 DTO。事件序号连续，精确绑定原 Run、Session、region/version；固定 64 条保留窗口。过旧游标的 `AGENT_EVENT_GAP` 附带经过验证的冻结 details，SDK 不自动跳到最新事件。事件与取消分页游标使用不同格式。

`runs.events(id, {after?, signal?, reconnects?})` 懒建立连接，按需读取，最多一份原始 chunk、一帧 4096 字节和一个在途 next，不建立后台事件队列。返回 ready/event/heartbeat/checkpoint；仅 event 推进最后已交付游标。调用方应在自身处理完成后保存该游标，交付不等于业务确认。支持 UTF8 分片、LF/CRLF，拒绝多 data、重复字段、未知字段、序号跳跃、伪造控制游标和身份改变。

重连默认三次、最多四个有限连接，只在之前 fetch/read/cancel 真实结束后继续，间隔 50 毫秒并重新认证。checkpoint 后须读到真实 EOF，传输中断可有限重连；gap、认证拒绝和协议错误终止，保留最后交付 cursor。默认 60 秒、262144 原始字节覆盖所有连接，不随重连重置；可配 100..120000ms、4096..1048576 字节。每连接最多 64 条事件、迭代器最多 256 条。容量默认 8、范围 1..64；事件通道独立于普通和 end 通道，原 `transportStatus()` 形状保持，另用 `eventTransportStatus()` 报真实 stream 数。

Abort、return、throw、for-await break 仅关闭读取器，不偷偷 end 原 Run。即使调用方暂停在两次 next 之间，绝对期限也直接清理原读取器。停止等待不释放真实在途 fetch/read/cancel；取消与释放失败保留未知容量。return 的观察等待受原普通 timeoutMs 限制，迟到的原清理完成后才可释放；重连清理与超时清理复用同一个 Promise，只释放一次 reader。真实 reader 的取消先于 fetch abort，防止正常 break 被误报成清理失败。

`runs.cancel(id, {signal?, retries?})` 使用既有幂等 end，和 `runs.end` 共用独立 end 容量。GET `runs.cancellation(id, {after?, signal?, retries?})` 返回每页四个原调用，固定原 Run 事件 generation。改变则 409 `AGENT_CANCELLATION_CHANGED`，调用方显式重读，不混合版本。第一页且无后页才是 completeRun；closed 但仍有真实工作时仍是 settling，input-injected/unknown/not-dispatched 效果分别保留。rollbackSupported、rollbackPerformed、businessSuccessConfirmed 始终 false，HTTP200 也不推导成功或回滚。

新增 27 项专用合同与原有客户端共 57 项初步回归通过，严格类型检查通过；最终同一v2候选双平台完整1584项通过（macOS1569通过/15跳过，Linux1578通过/6跳过），原时限0失败/取消，27新项均实际执行；双平台隔离包各202项Node、118项既有Python回归及严格TypeScript通过，macOS另通过安装后与包源码严格mypy。Python轮子复用并核对七份原文件，未实现Python事件接口。首次专用测试暴露重复 reader 释放和真实 HTTP break 清理误报，两处均已修复，原失败日志保留。完整执行结果及范围见 [证据](evidence/node-agent-events-sdk.json)。

真实控制服务/SQLite 属于本检查点范围，Source provider 仍为明确的夹具。Native 470 项与五个调用方编译仅继承既有范围，完整 Chromium 构建仍继续，默认下载预算/readiness 关闭。41 项仍为 10 项在列明范围内完成、18 项部分、13 项待做；原八小时失败不因 SDK 测试而改变。

首次Linux隔离包执行因控制服务夹具未显式复制Playwright版本元数据而失败（8个测试文件在导入时退出，非SDK协议失败）；原失败包、日志及容器终态保留。验证器现复制并核对固定1.64.1的package.json，SDK本身仍无外部依赖且不启动浏览器。该修复进入新候选，重新执行双平台完整与隔离包验收。

首次Linux完整1584项有一项既有下载用例在进入TCP背压断言前，4MiB文件准备超过原3秒期限；当次1577通过/1失败/6跳过，27新项均通过。其他验证结束后，相同v2候选、并发4和原时限复跑为1578通过/6跳过、零失败。原失败和成功日志均保留，未证明唯一根因，也未修改旧用例、生产下载逻辑或期限。
