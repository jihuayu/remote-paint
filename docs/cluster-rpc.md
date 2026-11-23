# 集群认证传输与 provider 接线

本地实现，未公开推送或部署。控制器仍为单所有者 SQLite；本次没有引入共享数据库、多主或外部持久依赖。

## 模块与权限

- `cluster-rpc.mjs`：使用 Node HTTPS 的双向证书链验证、固定服务名、服务证书 SHA256 和控制器证书摘要 allowlist。调用方必须提供已有的 key/cert/CA；生产代码不创建凭据、发现地址、自动发布端口或自动重试。TLS 名称检查与摘要检查同时保留，见 [Node TLS](https://nodejs.org/api/tls.html)、[Node HTTPS](https://nodejs.org/api/https.html)。
- `cluster-worker-service.mjs`：原 provider 的可信私有包装器，先核对节点租约、Session/租户/版本与 placement，再执行创建、解析、Agent 或关闭。异步操作后再次核对归属，Agent context 的租户/Session 在控制器和 Worker 两端均于实际输入前核对。支持在活跃租约下为旧世代隔离会话或因网络丢包未送达的 `create` 建立关闭墓碑（`#closeTarget`），拒绝迟到的 `create` 请求并委托底层 provider 核对退役收据。错误不返回原始配置或凭据。
- `cluster-session-provider.mjs`：直接实现原 Registry 的 create/close/retryClose/subscribeUnavailable、Viewer resolver 的 resolveSource 和 Agent executor 的 agent 合同。按固定节点元数据调度、续租，节点失联后撤销路由并通知原 Registry；支持 `reconnectWorker` 在分区恢复或节点重启（新 incarnation）后重新建立租约，并在控制器重启后从 `ClusterPlacementStore` 恢复未结清 placement 的关闭路径。不因失联释放不确定资源占额，也不自动重放 Agent 副作用。
- `cluster-docker-worker.mjs`：绑定实际 DockerSessionProvider、它原来的 Session store、部署与退役证据链。原 Engine/namespace/witness 校验保留，支持跨节点进程重启后重读已持久化的 `.retirement.json` 回执或对未派发会话出具 `owned-provider-not-dispatched-v1` 摘要，不能使用“closed”字符串生成物理证明。
- `cluster-ops.mjs`：提供 `assembleClusterDockerWorker`、`assembleClusterGateway`、`assemblePrivateCluster` 与 `ClusterOperations`（`reconnectWorker`、`reconcileQuarantined`、`unresolvedSessions`、`planRollingUpgrade`、`archiveClosedSessions`、`removeNode`），将公共 Gateway 控制栈、mTLS 远程 Worker 与原 `DockerSessionProvider` 装配为可恢复闭环。

Source endpoint 必须由可信节点配置与 `validateSource` 校验，不能使用公共请求传入的地址。控制流 mTLS 不自动建立数据面隧道；跨机器仍须由已确认的私有网络提供源传输可达性。公共 API 没有新增裸 CDP、内部 key 或管理凭据返回。

## 两份账本各自的职责

Gateway 的 Registry/Agent journal 与 placement store 持有全局受理、幂等和归属；每个 Docker Worker 继续拥有原来的本地 Session/runtime journal。不是把同一个 SQLite 文件跨节点共享。

原 runtime journal 外键要求 Node 本地先有同 ID Session，因此 Docker 工厂通过原 SessionRegistry 的完整 intent/Ready/release 流程持久记录控制器授权的 ID，再调用原 Docker provider。内部 `sessionIdFactory` 是可信构造参数，默认仍生成 UUID；公共 HTTP 请求 schema 没有新增指定 Session ID 的字段。非规范 ID、异步结果和碰撞在资源效果前拒绝。

本地创建绑定包含 placement 与规范请求的摘要，原 Session ID 不会因旧请求、新 epoch 或重启而重复创建。Node 恢复先执行原 Registry recover 并隔离/关闭旧资源，`await worker.initialize()` 成功前不应开放 RPC。关闭只在本地 Registry 和原 runtime 退役确认后返回证据。`DockerSessionProvider.retirementEvidence` 重新核对原不可变回执字节及原归属，只返回摘要；不存在 runtime intent 的情况只能由原拥有者确认确未派发。

## 装配顺序

1. 在 Worker 的既有受信任环境中配置 Engine metadata/effect/attach 客户端、原部署绑定、witness/retirement store，初始化原 DockerSessionProvider。此步骤需要已有 Engine 连接与权限，本次未创建或扩张。
2. 调用 `assembleClusterDockerWorker({provider, store: nodeStore, nodeId, incarnation, region, version, leaseMs, maxSessions, tls, clientSha256})`（内部封装 `createDockerClusterWorker` 与 `createClusterRpcServer`）；incarnation 每次进程启动不同。等待 `initialize()` 核对本地恢复，再由调用方选择已批准的私有监听地址启动 HTTPS 服务。
3. 控制器调用 `assembleClusterGateway({placementPath, registryPath, region, arch, version, leaseMs, heartbeatMs, actionKey, authenticate, controllerTls, workers})`，为每个固定节点配置 `ClusterRpcClient`、完整 descriptor 与 Source allowlist，并装配 `ClusterPlacementStore`、`ClusterSessionProvider`、`SessionRegistry`、`DurableAgentExecutor`、`ViewerAccess` 与 `createSessionControlServer`。
4. 等待 `await gateway.initialize()` 完成节点初始租约握手与本地恢复；运行中若节点发生网络分区或跨世代重启，通过 `gateway.operations.reconnectWorker(nodeId, {incarnation, client})` 与 `await gateway.reconcile()` 对账隔离会话、核验不可变退役回执并恢复节点 `active` 容量。
5. 停止接入后调用 `await gateway.shutdown()`（按顺序停止 HTTP 接入、关闭 `DurableAgentExecutor` 与 `SessionRegistry`、关闭 `ViewerAccess`、等待 `ClusterSessionProvider` 关闭并释放两个 SQLite 账本），再关闭 Worker 服务、HTTPS listener 和原账本；任何 unconfirmed 都保留记录并核对，不能当作进程已退役。

RPC 正文/响应默认各 2 MiB、8 个实际在途调用、64 个连接；请求处理虽已超时或观察者断开，真实 handler 未结算前仍占 admission。客户端无重试；派发后的断线为 unknown。创建的观察预算为 70 秒，Agent 沿用原 50 ms–120 s 请求预算；心跳预算由固定客户端配置给出，建议显著短于租约。服务器默认 75 秒，可按最长已批准操作配置到 120 秒。延长观察预算不会延长 Worker 租约，不能替代清理确认。

## 验收与尚未覆盖

受影响集群与 Docker provider 合同测试（含 `tests/cluster-full-chain.test.mjs`）全部通过：覆盖真实 mTLS、固定名称/摘要拒绝、公共 Gateway → mTLS Worker → 原 `DockerSessionProvider` 整链路（Session 创建、Viewer 票据与 WebSocket 流、持久 Agent 执行、不可变退役回执与有界 NDJSON 归档）、`create` 在途取消与迟到回执、丢包未达 Worker 后的关闭墓碑与迟到 `create` 拒绝、Agent 在途分区 `unknown` 结算与禁止重放、Worker 租约过期与跨世代重启（`boot-2`）对账恢复，以及控制器重启全量隔离与跨节点对账恢复。这组测试中的 Docker Engine/namespace 效果使用明确的结构夹具，不能冒充真实跨机器 Engine 验收。

另有真实单机三容器验收：两个独立 Worker 使用现有 NativeSessionResource、Chromium 和 Broker，通过本次 mTLS/provider 接入真实 Gateway/Registry/Agent/Viewer；包含原生帧、真实点击、公共截图分块校验、暂停/恢复与占额结算。详见 [独立容器回执](cluster-container-qualification.md)。

后续宿主适配器直接使用现有 Unix socket，实际完成原 DockerSessionProvider 的两套 Chromium/Broker 创建、私有 Source/Agent、故障保留配额、显式重试与不可变退役证据重开，见 [真实 Engine 验收](cluster-engine-qualification.md)。未把 socket 挂入容器或新增 Engine 凭据。跨机器网络、远程 Engine 身份、真实凭据轮换/撤销、生产部署和 HA 仍需独立环境与验证。
