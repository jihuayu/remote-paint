# 公共 Agent DOM 观察接口

在既有 Source 结构化观察核心上新增独立 `agents:observe` 权限与两个公开接口：`GET /v1/agent-runs/{agentRunId}/observation-context`、`POST /v1/agent-runs/{agentRunId}/observations`。POST 请求为 `{context, query, limits?, rpcTimeoutMs?}`，不需要幂等键；每次是独立瞬时读取，成功为 200，无 Location，统一 no-store 和 requestId。context 包含逻辑 agentRunId、Session、当前版本及固定 Source binding/document，不提供写 fence/controlVersion。query 仍限 snapshot、locate(id/tag/testId)、element；不接受任意 JS/CDP/CSS。显式 limits 必须是对象，rpcTimeoutMs 为 50..120000。

受信服务固定同一个 Registry、tenant、逻辑 Run、确认的原 Source worker/target/controlSessionId 和版本。仅 observe 的凭据不能创建 Run、读取写上下文或 Run 管理元数据、注入、结束、释放 Session 或签 Viewer 票；旧 read/write/end 和 Session 权限不隐含 observe。外租户返回 404。known-bound、同一 executor 所有的 recovery-required Run 仍可读取实际页面，输入继续隔离且原 unknown 历史保持。未知 begin 没有确认 binding、冷重启旧 owner、结束中/closed 或失去 Ready 均不能通过观察接管。

读取与输入共享每 Run 一个及全局有界的实际 ordinary 名额，end 独立。取消、断开、HTTP deadline 仅结束调用方等待，不向 Source 传调用方取消、不提前释放实际名额。实际 provider 结算后重检 Registry/Run，晚到数据不能变成 closed Run 的成功观察。只读错误、错误响应、显式私有 RPC 超时不修改写隔离或 Run error；真正资源/Registry 生命周期故障保留自身处理。原输入 context 读取路径的生命周期规则保持，不扩张本检查点范围。DOM、查询和读结果不写持久账本。

22 项新合同随 125 文件全量测试执行：Mac 1187 项，1172 通过/15 平台跳过；Linux 1187 项，1181 通过/6 跳过；均退出 0、无失败。原 Node/Python 包内容未变，重建同 hash 后双平台离线安装；44 个当前服务/消费者输入核对，各 97 Node、37 Python、TSC，以及 Mac 公共类型和 4 源码 Mypy 通过。这些只证明旧七工具 SDK 回归，观察 SDK 尚未加入。

真实标准 Native 验收全程通过公开 Agent HTTP 观察和持久注入，Session 生命周期使用已安装 SDK。独立观察凭据与外租户隔离、伪造逻辑 context 事前拒绝通过；DOM、版本/target/epoch/time、密码遮蔽、main light DOM 边界、4000 中文截断到 1024 后句柄可读通过。替换/改文拒绝旧句柄，同 Page 导航 epoch 1→2 后拒绝旧上下文、句柄及写 fence。人控期间仍可读、写暂停，读和 Agent end 保留原 grant，页面输入 OBSHF。3000 节点场景只访问 32 并标记截断，公开大快照 4813 字节，小于 8192 上限；Source 原 6144 字节和通道 8192 字节限制保持。

真实慢点击私有 RPC 超时后 Invocation 为 unknown，页面实际点击一次；公开观察读到该实际结果，但 Run 继续 recovery-required、Invocation 继续 unknown，同 key 不重放、新输入拒绝，显式 end 结束。真实 read 的 Source 回包被受控延迟：HTTP 408/断开后实际 executor 槽保持，原 writer 不被改写，独立 end 可在等待中结束，晚到读取不能重新接管。重开账本确认 4 个逻辑 Run closed、7 injected/2 rejected/1 unknown；Session closed 不占配额，runtime retired 与 namespace 退役证据 hash 一致，已知 Node/代理 PID 退出，Source 无宿主发布端口。

初轮相关合同 75/76 通过，唯一失败为 fetch 测试客户端不允许 GET 请求体；改为底层 HTTP 验证服务端拒绝后 76/76 通过。封存前审查还收紧显式 null/数组 limits 拒绝，加入同项边界合同，冻结新候选并重新完整双平台、安装包和实际 Native 全部通过。保留旧候选和执行证据，不将早期结果冒充最终候选。

41 项仍为 10 完成/17 部分/14 待做，K6 部分。下个独立检查点为 Node 观察 SDK，再做 Python 对等接线；随后 AX、截图/下载、完整定位/跨 frame、写句柄、业务后置条件、事件/取消、Playwright/文件/Profile、兼容矩阵、unknown Engine Start、N1/物理/设备及原 8 小时门槛。原 8 小时增长失败未修复、未重跑；本次没有放宽门槛、强制浏览器 GC、动采样器或演示，也未暂存/提交/推送。WebGL“WebGL 无法显示”黑框及其他显示保持。

见[可校验证据](evidence/public-agent-observation.json)与[Source 范围](agent-observation-core.md)。
