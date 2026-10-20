'# 公共 computed AX 观察接口

在 Source computed AX 核心上新增 `POST /v1/agent-runs/{agentRunId}/accessibility-observations`，使用既有独立 `agents:observe` 权限。请求为 `{context, elementId, limits?: {maxChars}, rpcTimeoutMs?}`；context 与公开 DOM 读取共用 observation-context，包含逻辑 Run/Session/version 与原 Source binding/document，没有输入 fence/controlVersion。只接受原opaque元素句柄，不接受selector、脚本、CDP方法、objectId/backendNodeId或外部tenant。limits默认256、最大512；显式null/数组/未知限制字段拒绝，私有RPC期限50..120000。

成功仅200，无Location，不需要读幂等键，统一no-store/requestId。返回逻辑agentRunId/sessionId与经过严格校验的Source AX DTO：accessibility-observed、main-document-element-accessibility、原binding/document/version/time/DOM快照revision、elementId、limits、url/title、ax或redacted null及truncated。再次核对逻辑ID、Session、tenant、原worker/target/controlSession、version和原document/element/budget。Source记录6144字节，公有记录8192字节；raw AX节点/source/关联/backend ID/CDP对象不返回。当前Node/Python包未提供AX方法，本检查点使用明确的HTTP消费者，不把原DOM SDK资格扩大成AX SDK资格。

HTTP必须绑定同一个实际Registry与DurableAgentExecutor。active或同owner、已确认原Source binding的recovery-required Run可读；unknown begin无binding、冷重启旧owner、结束/closed或失去Ready的Session不能读取或接管。已知unknown输入读取实际AX后，原Invocation仍unknown、writer仍隔离、同key不重放，新输入继续拒绝。读取失败/坏回包/超时不改Run error或隔离状态，AX/DOM/句柄不写账本；真正Registry/资源生命周期变化保留自身处理。

AX、DOM和输入共享每Run一个及全局有界ordinary实际任务名额，end独立。Executor选项取消、HTTP deadline/断开只停止等待，不把HTTP signal传入Source、不提前释放provider实际名额；晚到回包再次核对Run/Ready，不能成为已结束Run的成功读取。HTTP认证与请求本身仍沿用有界实际占用及独立end容量。原写context路径和Source缓存/临时对象清理规则保持，AX核心仍以单实际任务等待enable/read/身份复核/disable/group释放。

21项新executor/HTTP合同首轮全部通过，相关67项零失败；覆盖身份/getter/版本/结果、unknown begin/冷owner、权限/foreign tenant、未授权写/结束/Session/Viewer、无payload持久化、结果坏schema/错误脱敏、单次私有期限、取消/结束/Ready丢失/关闭、HTTP408/断开/认证挂起/未完成body等。Mac/Linux完整129文件各1248项零失败，分别1233通过15平台跳过、1242通过6跳过。Node/Python所有SDK源码与开发包字节保持，重建相同hash、50当前服务/消费者输入核对、双平台离线115Node/56Python/TSC及Mac公共/5源码Mypy通过。

真实标准Native流程全程AX通过公开HTTP→DurableExecutor→私有Source，旧安装Node SDK只提供DOM句柄、输入与Session生命周期。独立observe允许AX而read/write/end旧scope拒绝，外租户404、伪造context版本事前拒绝。AX返回附真实逻辑Run/Session/版本，无私有对象。外部label Shipping address、description Confirm delivery、value123、textbox/readonly/required、嵌套按钮Place order和checkbox checked与浏览器一致；替换同id按钮、外部label变化拒绝旧句柄，新定位得到更新数据。800中文AX name截512且truncated，40000字符嵌套名回复超限拒绝，password ax null；导航epoch1→2拒绝旧AX context，人控读可用、写暂停，读/end保留原grant，页面值OBSHF。

真实慢点击成为unknown并实际执行一次后，调用方显式取得新DOM句柄，公开AX读到Unknown action observed；逻辑Run和原Invocation仍隔离/unknown，同key不重放、新输入拒绝、显式end结束。AX真实Source回包受控延迟时HTTP408/断开保留executor实际槽，独立end可结束，晚到结果不能接管closed Run；调用方取消未送入Source。重开账本4closed Run/10injected/2rejected/1unknown，Session closed不占配额、runtime和namespace退役，已知Node/代理PID退出，Source无宿主发布端口。实际执行副本的已单独验证Linux broker偏差继续单列，不改仓库broker/Chromium缓存。

computed AX公开接口在以上范围成立，SDK扩展仍待做。32KiB raw CDP回复检查仍在Playwright解码之后，不证明接收前分配、完整浏览器AX缓存或物理内存上限；公开接线不扩大这项资格。K6仍部分，41项仍10完成/17部分/14待做。下一独立检查点为Node AX SDK，再做Python对等models/类型/安装/Native；随后截图/下载、完整locator/frame/write-by-handle、K7业务后置条件/分类恢复、K8事件取消、K10适配器/文件/Profile、K4兼容、unknown Engine Start、N1/物理/设备和原8小时。原8小时增长失败未修复/未重跑，未放宽门槛、强制浏览器GC、动采样器/演示/无关peer，未暂存/提交/推送；WebGL“WebGL 无法显示”黑框及其他显示保持。

见[证据](evidence/public-agent-ax.json)、[Source computed AX边界](agent-computed-ax.md)和[原始清单](optimization-backlog.md)。
