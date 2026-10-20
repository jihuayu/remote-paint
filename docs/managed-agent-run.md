# 本地受管 Agent run 与组合输入

`createManagedAgentRun(source.control, {tenantId, sessionId, authorize})` 是 Source 内部可信入口，返回冻结的 `context()`、`perform(tool, params, context)`、`close()`。管理 Session ID 来自调用方可信配置，run ID 由工厂生成；target ID 是控制器创建时绑定 Page 对象的不透明 API ID，与管理 Session、run、控制 session 和 Chromium 私有 Target ID 分开。关闭后不能用替换的 Page 对象复用旧控制器/CDP。此处尚无远端 Run 创建、持久化、认证或公共 SDK。

context 恰含 binding 与四字段 fence；binding 恰含 tenantId/sessionId/targetId/runId。每个动作必须显式带请求形成时的 context，拒绝跨租户、Session、目标或 run 的上下文和旧控制/页面/viewport 版本，先于读取动作参数。不会替调用方更新版本戳。每个 ControlLease 同时只接受一个该 facade 的 run；关闭期间仍占有写者名额，直到实际输入队列和清理栅栏结束。close 幂等，返回 run-closed 只表示该本地 run 停止，不是浏览器或 namespace 退役证明。

支持 move、click、drag、scroll、press、insertText、composition 七个坐标/键盘输入工具。click 为移动/按下/抬起三步，press 为按下/抬起两步，drag 最多 16 个插值移动；组合动作最多 32 个规范化事件，共用原有 64 项队列上限。一个动作只占一个队列项，不能被另一个动作交错。参数在准入时复制并冻结，拒绝 getter、继承/额外/Symbol 字段、嵌套数据及越界值。默认按钮为 left，拖动默认 4 步；坐标是源 CSS 像素。composition 为更新，提交使用 insertText。没有 Page、CDP、control、goto、evaluate 或 locator 出口；通用 Playwright/Steel、导航及其他修改能力仍需受管实现。

同步 authorize 回调接收冻结的 `{binding,permission:'agent:write',action}`；action 为空时检查基础权限，否则含本次冻结的 tool/params。它必须读取独立可信状态、严格返回 true；异步、抛错和其他返回均拒绝。准入、队列执行和每个实际输入前都复查，回调之后再次检查控制版本/目标/run，回调重入不能把已关闭或撤销的动作继续发送。回调可执行多次，不应在其中计费或发起外部副作用。这个合约不是远端认证或动作审批服务，版本戳也不是授权凭据；真实租户/Session/目标/run 与 worker/HTTP/SDK 的绑定仍待完成。Native 验收中的管理 Session ID 明确是本地夹具值。

人工接管、权限撤销或 close 后，尚未发送的动作返回 not-dispatched。若组合动作已发过任何一步，后续停下时返回 AGENT_INPUT_FAILED / unknown，原先已发生的效果不能撤回，也不自动重放。原控制器清理会在实际输入完成后释放按键、组合和鼠标，鼠标在页面外抬起避免普通按钮激活。成功仅返回 input-injected 和绑定/版本/输入数，调用方仍需另行观察业务后置条件。活动 CDP 不返回时仍需外层目标关闭/故障处理；这里没有新加 AbortSignal、强制期限或完整 K8 任务事件。

21 个新合同覆盖单写者、上下文和参数捕获、组合不交错、同步授权及重入、页面替换、排队/部分动作撤销、队列上限和关闭等待。真实 Native 页面独立 HTTP 报告确认：并发 left/right 点击各一次，CDP x 顺序为 60/60/60/220/220/220；文本 A、全选替换 B、组合 B拼、pointer-capture 拖动至 430/130、滚动 80 像素均发生。人工在鼠标按下的 ACK 持有期间接管，剩余动作停下、排队 STALE 未发送、清理未激活按钮；人工 H 后用新版本恢复 F，得到 B拼HF。关闭 KeyX 中的 run 时观察到真实 keyup，再创建不同 run ID 的写者并写入 Z。

补充因果验收发现并修复：外层 ControlLease 已置 closed 时，revoke 会提前返回，原 run.close 误报 run-closed。仅 managed-agent-run.mjs 一处运行时差异的前后快照使用相同 21 合同与相同 Native 脚本；前者均实际 1，后者均实际 0。Native 中 KeyY 已真实写入、CDP 回复仍被夹具持有，修复前 run 已关闭；修复后等实际回复及 KeyY keyup 才结束，最终 B拼HFXZY。失败快照/日志保留，未以首轮未覆盖该边界的通过结果替代。

最终 112 文件完整回归在 Mac/Linux 同一 976 文件执行候选各 996 项、零失败/取消，分别 981/990 通过及 15/6 平台跳过。最后仅增加范围文档成为 978 文件检查点。三次 Native 容器（初版、因果前、因果后）以及两次 Linux 完整回归均终止、PID0、无 OOM；已知 browser/broker PID+startTicks 全部退役，Source/HTTP fixture 关闭，已知宿主子进程退出。执行时仍只在隔离快照中采用先前验收的 Linux broker，canonical 构建不覆盖。

K5 从表中的待实现更新为部分实现；41 项当前 9 项在既定范围完成、16 项部分实现、16 项待做。完整 Playwright/CDP facade、真正 Agent 授权传输、K6 结构化观察与业务验证、未知启动收敛、N1/物理/设备和原 8 小时增长仍未完成，allAgentCdpFenced=false。SDK 27 个合同输入未变，继承双平台 78 Node/17 Python、严格 TSC 和 Mac Mypy；没有新 SDK 打包/发布或公共 Viewer 像素验证。WebGL“WebGL 无法显示”黑框及其他显示代码保持。

见[范围收据](evidence/managed-agent-run.json)。未提交、暂存、推送代码或修改演示进程；未强制浏览器 GC、放宽原增长策略或重跑 8 小时。


补充修复：结束 Agent run 时若处于 human 或 handoff，只停止该 run 并等待现有队列/交接栅栏，不撤销人的租约、不取消交接、不释放人持有的键/按钮。只有 agent 模式主动撤销和清理 Agent 状态。三个合同和真实 Native 前1后0、原组合工具重新通过，见[人工优先级](agent-run-human-priority.md)。
