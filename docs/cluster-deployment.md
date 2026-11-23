# 集群基础：设计与验收

本地开发阶段。第一步采用单个持久控制器管理多个 Worker，不预设 Kubernetes、云厂商或 NAS 地址；不承诺浏览器热迁移、任务无损恢复或副作用恰好执行一次。

## 复用与接线

| 现有模块 | 已有职责 | 集群补充 |
| --- | --- | --- |
| `service/session-registry.mjs` | 租户、区域 provider、幂等、TTL、配额、恢复隔离 | 区域内节点选择和固定 Session 归属 |
| `service/docker-session-provider.mjs` | 固定 Engine 配置、资源身份、启动/健康/退役与 Source 解析 | 多个可信节点适配器的调度和路由 |
| `service/session-worker-channel.mjs` | 私有 owner 通道、心跳、Ready/Unavailable、关闭结算 | 经过认证的跨节点传输和节点世代租约 |
| `service/runtime-deployment-binding.mjs` | 固定部署和账本绑定 | 远程节点配置/身份连续性 |
| `service/viewer-access.mjs` | Session/角色票据和经过认证的 Source 代理 | 接入验证后的 Worker resolver 与 mTLS 数据面流能力 |

原 owner 凭据、Agent fence、Engine 身份与物理退役合同继续有效，集群租约号不能替代这些能力。认证传输、原 provider/Registry 接线和单机独立容器验收已进一步完成，见 [RPC 装配与边界](cluster-rpc.md)；尚未部署生产集群。

## 已实现的控制基础

`service/cluster-placement.mjs` 是单所有者 SQLite 账本，要求真实私有文件数据库、父目录 0700、文件 0600、同一用户及稳定文件/目录身份。内存库、其他格式、第二个独占所有者或路径替换被拒绝。SQLite 事务提交前后核对文件身份，存储故障后停止受理；不支持复制数据库热接管。

节点注册包括 nodeId、每次启动的 incarnation、区域、架构、完整数据版本与容量。只选择健康、未排空且区域/架构/版本匹配的节点，按已保留槽位比例分配；创建中或清理不确定的资源都占额。版本保持现有 `chromium:...;wasm:...` 格式，不能用其他架构/版本替代。

每个 Session 固定绑定节点世代与持久递增 epoch。同 ID 同请求返回原归属，跨租户不可见，变更请求冲突。路由必须匹配原租户、Session、版本与 Ready。关闭/超时不会释放槽位，原归属必须经过可信同步退役验证器；摘要本身不是退役证明。当前虚拟夹具验证器不能用于生产 Native 退役。

`service/cluster-worker-fence.mjs` 在心跳请求前记录本地单调时钟，响应延迟消耗租约预算，不需要跨节点时钟同源。迟到响应、旧世代和错误启动身份不能续命。定时器撤销 owner 信号；操作前后核对租户/Session/节点/世代/epoch。操作发出后丢失归属返回 `unknown`，不能当作未执行并重放。owner 信号取消与实际清理结束是不同事件。

控制器重启将全部活动归属持久隔离，保留槽位。新 Worker 世代同样先核对旧资源，确认退役后才允许新 Session。旧 Session 不会静默重建或迁移。

## 运维、指标、归档与私有装配

扩容先准备匹配架构、固定镜像和数据版本的可信节点，核对原部署绑定/运行时证据，再注册、续租、开放容量。缩容先 drain，保留既有路由，等待会话结束或显式释放，确认完整退役再停节点。不会自动创建机器、启用付费资源或强制终止长期会话。

网络分区时 Worker 关闭 owner 资源并拒绝新操作，控制器继续保留不确定资源占额。浏览器可能已经向外部网站发出副作用，无法承诺撤销或安全重放。节点/Session 历史保留有界，满额拒绝新增；现已提供受控指标、排空、滚动升级规划、有界历史归档、节点删除、整链路装配、跨机私有数据面 mTLS 隧道、X.509 身份材料审计/在线轮换与部署环境预检工具（`service/cluster-ops.mjs`）：

- **健康/容量/清理指标**：`ClusterPlacementStore.metrics()` 与 `ClusterSessionProvider.metrics()` 返回按节点与集群聚合的容量、剩余槽位、各状态 Session 计数（`reserved`/`ready`/`closing`/`quarantined`/`closed`）、租约余量、`safeToStop`/`removable` 及未确认关闭计数。
- **操作者排空与滚动升级规划**：`ClusterPlacementStore.drainNode(nodeId, enabled)` 与 `ClusterSessionProvider.drainWorker(nodeId, enabled)` 允许操作者在保留既有路由的前提下停止节点新分配；`ClusterOperations.planRollingUpgrade()` 要求目标版本已有足够的活跃容量后才建议排空旧版本节点，并区分待排空、排空中、被隔离阻塞、待归档与可移除节点。
- **有界历史归档与节点删除**：`ClusterPlacementStore.archiveClosedSessions()` 仅归档已具备 64 位 SHA-256 退役收据的 `closed` 会话，绝不删除未解决或隔离会话；同步 `onArchive` 回调失败或返回异步值时事务完整回滚。`ClusterOperations.archiveClosedSessions()` 与 `verifyClusterArchive()` 在 `0700` 私有目录中写入 `0600` NDJSON 与 `.manifest.json`（含 `fsync` 与双层 SHA-256 校验）。`ClusterPlacementStore.removeNode()` 仅允许删除非活跃、零活跃会话且已归档历史的节点，并在 `cluster_ops_meta` 中持久维护单调递增 `generationFloor`，确保同 `nodeId` 重新注册不会复用旧世代号。
- **整链路装配、网络分区/迟到回执与重启对账恢复**：
  - `assembleClusterDockerWorker()` 将已初始化的 `DockerSessionProvider` 与节点本地 `SqliteSessionStore` 通过 `createDockerClusterWorker()` 封装为双向 mTLS 认证的 `createClusterRpcServer`；
  - `assembleClusterGateway()` 在 `assemblePrivateCluster()` 之上装配完整公共控制栈（`SessionRegistry`、`DurableAgentExecutor`、`ViewerAccess`、`createSessionControlServer`）；
  - `ClusterSessionProvider.reconnectWorker()` 与 `ClusterOperations.reconcileQuarantined()` / `gateway.reconcile()` 支持节点分区恢复或跨世代重启（`incarnation` 变更）后重新握手租约，向恢复中的节点核对旧世代隔离或未派发会话的不可变 `.retirement.json` / `owned-provider-not-dispatched-v1` 退役收据，在确认退役后自动将节点从 `recovering` 提升回 `active` 并释放控制器与 `SessionRegistry` 占额；若延迟的 `create` 包在关闭栅栏之后到达 Worker，Worker 将直接以 `CLUSTER_WORKER_CONFLICT`（`not-dispatched`）拒绝，不会产生幽灵容器。
- **跨机器私有数据面 mTLS 隧道、受管 Agent/CDP 隔离、X.509 身份校验与在线轮换/吊销**：
  - **跨机私有数据面隧道（`GET /v1/cluster/stream`）**：当 Gateway 与 Worker 部署在不同主机且容器 bridge IP（如 `198.19.192.x:4176`）仅在 Worker 宿主机本地可达时，`ClusterSessionProvider.resolveSourceStream()` 与 `ClusterRpcClient.openStream()` 通过固定证书指纹绑定的 mTLS 升级请求（`wss://<worker_ip>:<port>/v1/cluster/stream`，携带 `x-cluster-stream` 绑定信封）将 `ViewerAccess` 数据面桥接至目标 Worker；Worker 端 `ClusterWorkerService.openStream()` 核对控制器证书、placement fence、活跃租约及常量时间（`timingSafeEqual`）64 位派生 Source `key` 后再连接本机容器 `/stream`，并在会话关闭或租约到期时立即中断流。
  - **受管 Agent/观察路由与裸 CDP 隔离**：DOM 观察（`observation-context`/`observe`）、无障碍树（`observe-ax`）、截图分块与下载均经由 mTLS RPC 路由至 Worker 本地 `DockerSessionProvider` 的 Unix socket `attach` 通道；公共 Gateway 与 Worker RPC 端点严格拒绝 `/json`、`/json/version`、`/devtools/...` 等裸 CDP HTTP/WebSocket 路径。
  - **真实 X.509 身份材料校验、在线轮换与部署预检**：`loadPrivateTlsMaterial()` 与 `verifyTlsIdentityMaterial()` 强制校验 `0700`/`0600` 私密文件权限、CA `basicConstraints`（`CA:TRUE`）、叶证书签名、私钥配对、有效期窗口与 SAN 主机名；`worker.rotatePeers()` 与 `gateway.operations.rotateWorkerTls()` 支持双信任窗口平滑轮换控制器/Worker 证书并在吊销旧指纹时立即断开被吊销证书的在途流与连接；`verifyClusterDeploymentEnvironment()` 对账本/归档权限、身份材料、角色指纹分离及禁止裸 CDP 端口（`4175`/`4176`/`9222`/`9229`）生成可复核的预检摘要回执。

生产配置应明确单控制器私有持久卷、Worker allowlist、已有身份材料、固定镜像/版本/容量、每 Session 原有 Docker/网络/Profile 隔离，以及 Native 全进程退役证据入口。CDP 保持私有网络或节点 loopback；公共 API 不返回内部 Source URL、owner 凭据或裸 CDP。

本模块不创建凭据、不配置 TLS/防火墙、不增加 Docker socket 挂载，也不修改现有服务。多控制器 HA 另需一致性权威、控制器 fencing、持久幂等与票据归属；现有内存 Viewer 票据不是无状态多副本网关，复制 SQLite 或增加副本并不能取得 HA。

## 本地运行与证据边界

要求 Node 22.13+ 的 node:sqlite。在已准备源码/依赖的目录执行：

```sh
node --test tests/cluster-placement.test.mjs tests/cluster-worker-fence.test.mjs tests/cluster-control-integration.test.mjs tests/cluster-rpc.test.mjs tests/cluster-gateway.test.mjs tests/cluster-ops.test.mjs tests/cluster-full-chain.test.mjs tests/cluster-data-plane-pki.test.mjs
```

本次复用已交付 ARM64 镜像、Node 22.23.3，容器网络 none，无宿主端口，零 Docker/Chromium 编译。合同使用真实 SQLite、两个独立 Node IPC Worker 和真实租约定时器；其资源为明确的虚拟夹具。真实 Chromium 多 Worker 结果另行记录，不等同于跨机器集群或独立内核隔离。

历史共享容器 Native 验收见 [首阶段记录](cluster-native-qualification.md)。后续独立容器、真实公共 Agent/Viewer、暂停恢复及截图回执见 [容器验收](cluster-container-qualification.md)。待办见 [cluster-todo.md](cluster-todo.md)。
