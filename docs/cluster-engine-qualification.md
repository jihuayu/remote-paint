# 原 Docker provider 的真实 Engine 验收

2026-10-25 15:55:28.256–15:55:34.354 UTC，宿主适配器退出 0。当前 Mac 的既有 OrbStack Engine 29.8.2 / Linux ARM64 执行了真实 Docker 创建、启动、私有 attach、删除和缺失确认；没有用结构 Engine 夹具替代这轮运行。

## 运行组件与权限边界

宿主 Node 26.4.0 直接使用现有 Docker Unix socket。调用链为 `ClusterWorkerService` → `createDockerClusterWorker` → 原 `SessionRegistry`/私有 SQLite → 原 `DockerSessionProvider` → metadata/effect/attach 客户端 → Engine。没有启动宿主 TCP/HTTP 监听器、挂载 Docker socket 到容器、修改 daemon/系统网络设置或新增身份凭据。

按项目原 provider 的部署设计，使用已有 `remote-paint-runtime:linux-arm64` 镜像（`sha256:ba52f926ae3c951e29dc1625d70537c18db389cf166f4465a1e5b836d802c133`，Node 22.23.3），只读绑定冻结 `/project` 和 `/browser`。浏览器与 Broker 从已交付的 `remote-paint:linux-arm64` 镜像（`sha256:c75c58487264d5350a7b83eb6a5f11449dd0e1c49be81cedde3ace6c9ea7dd29`）中提取，没有重建或替换架构。它不是把交付镜像直接作为原 provider 的运行底座：交付镜像的 Node 路径与原 provider 固定 `node` 入口约定不同。

Chromium 为 155.0.8059.79，`headless_shell` SHA256 为 `c36a056a98625bb36030bc3ee33a859d13b1e52d7ff1f16443af00d49d969146`。保留完整运行资源、库和 angle 数据；仅从本次临时副本移除不参与运行的 `gen`/`pyproto` 编译生成文件。20 个浏览器文件与 1,585 个项目/依赖文件均列入原 source manifest 并经 provider 校验；依赖直接复用已有归档。本轮 Docker 构建与 Chromium 编译次数均为 0。

原隔离合同保持不变：每 Session 一个私有 PID namespace，init、只读根、cap-drop ALL、no-new-privileges、默认 seccomp、内存/CPU/PID 上限、无宿主端口。原合同在容器内使用 UID 0，已观测有效与边界 capabilities 均为 0；没有声称这轮使用非 root 容器。

## 实测断言

1. 两个全局 Session ID 通过真实工厂投影到原本地 Session/runtime 外键账本，分别实际启动 Chromium/Broker，进入相同完整版本的 Ready；private PID namespace 不同。
2. 两个 Source 解析都走实际 container/network inspect 和原 witness 复读。私有 Source key 只在内存中核验，不写入报告。跨租户解析拒绝。
3. A 的 Agent begin、observation-context、截图分块、释放和 end 经原私有 attach 执行。故障前后截图均为 3,143 字节、两块，SHA256 `bdafd15b097d22a6c0283efe025096e0aff473611205589f334e04515ad5ca66`，与元数据一致。
4. 故障注入前核对 B 的完整 runtime 所有权/隔离规格，再从宿主仅移除该任务 CID。临时移走其本次 namespace 证据，模拟历史证明暂不可读。旧 B Source/Agent 拒绝；即使 Engine 已确认 CID 不存在，本地 Session 仍为 `cleanup-failed` 且保留配额，两会话共保留 2 槽。
5. A 在 B 清理未确认时继续完成独立 Agent 截图。恢复原证据字节，显式 retryClose 后 B 才返回已核对的证据摘要；没有重新创建旧 Session。
6. A 正常关闭，实际删除与 404 缺失确认通过。关闭工厂后独立重开退役读取器：A 为 `container-removed` / v1，B 为 `container-absent` / v2；B 的缺失探测为 HTTP 404、`effectAttempted:false`，并重新核验原历史 namespace 文件和摘要。
7. SQLite 中两个 runtime 均 retired、两个 Session 均 closed，重开账本占额为 0。两任务容器均已移除，attach proxy 和 effect 会话均为 0；原有 5 个运行服务保留。

首次运行的业务与清理步骤已通过，但最终测试断言误读 `witness.namespace` 而非 `witness.self.pidNamespace`，故保留为失败。仅修正验收适配器后重新运行，以上结果取自第二轮；没有修改生产 provider 或降低证据校验。

## 复现与证据

入口为 `tests/verify-cluster-docker-engine.mjs`，显式 opt-in：

```sh
REMOTE_PAINT_CLUSTER_ENGINE_MANIFEST=/absolute/operator-input.json \
  node tests/verify-cluster-docker-engine.mjs
```

输入由受信任操作者准备，字段为 `socketPath`、`daemonId`、固定 digest 的 `imageId` 与 `deliveryImageId`、`projectPath`、`browserPath`、`projectManifest`、`browserManifest`、两 manifest 的 SHA256、`browserVersion`、全新 `results` 目录。项目目录需包含与源码锁文件匹配的依赖、原 Native Worker 入口及配套 ARM64 Broker；浏览器目录包含实际定制浏览器及运行资源。测试验证当前镜像为 ARM64，不能用其他架构二进制冒充。复用已安装运行时和缓存，不自动安装、不拉取浮动镜像。

程序不接受或创建生产凭据、不会配置网络或部署。它会创建两套任务 Session，故障时仅移除由自身原 provider 创建且完整规格验证通过的 CID，并在 finally 请求原 provider 清理；若报告 unconfirmed，须检查自己的 cleanup 回执，不能把结果未知当作移除成功。

仓库摘要为 `docs/evidence/cluster-engine-qualification.json`。本地原始材料位于任务目录 `followup-cluster-engine-validation/`：`engine-qualified.log`、`results-qualified/result.json`、`runtime-a.json`、`runtime-b.json`、`quota-held.json`、`session-ledger.json`、`retirement-reopened.json` 和 `cleanup.json`；初次失败日志另留存。运行身份、私有账本、完整 witness、截图和引擎连接地址均不作为仓库交付文件。

## 覆盖边界

这轮补齐了**宿主直接调用集群 Worker 工厂时，原 Docker provider 的真实 Engine / namespace / 本地 Session / 退役链路**。15:27 的三容器验收另覆盖 mTLS、公共 HTTP/持久 Agent/Viewer、真实页面点击及暂停恢复；它使用直接 Native 资源。两套验收不能合称为“公共 Gateway → 跨机器 mTLS → 远程 Engine”单次端到端。

本轮页面为 `about:blank`，验证真实 Agent 截图和生命周期，没有重复页面导航/点击、Viewer 帧或全部故障矩阵。跨机器私有数据面、远程 Engine 认证、网络分区/迟到回执、真实证书运维、生产部署与多控制器 HA 仍未验收。8 小时内存项继续暂缓。
