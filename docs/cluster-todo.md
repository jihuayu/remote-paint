# 集群部署 TODO

用户已授权设计、开发和本地隔离验收；公开新功能、真实集群/NAS 部署、付费或新凭据/权限不在当前范围。

- [x] 核对 Registry、Docker provider、Worker 通道与部署绑定，记录复用边界。
- [x] 持久归属、区域/架构/版本匹配、容量、排空、启动世代、epoch 与 Worker 租约。
- [x] 重启隔离、占额保留、退役验证门槛、操作结果未知与禁止自动重放。
- [x] 真实 SQLite、双进程 IPC、定时失效、跨租户/旧归属/迟到响应合同。
- [x] 最小真实 Chromium 多 Worker 本地验收：Source/路由及失效或退役隔离；两个独立进程组合共享一个容器内核，未宣称跨机或每 Session 独立容器。
- [x] 经过认证的 Worker 传输与现有 DockerSessionProvider/SessionRegistry 适配，保留本地 Session/runtime 外键与原回执核验。
- [x] 单机独立容器的公共 Agent/Viewer 路由、真实点击/截图、认证拒绝、暂停恢复与占额/退役结算。
- [x] 原 Docker provider 在现有真实 Engine 上的宿主工厂接线、两套定制 Chromium/Broker、namespace/本地账本、缺失历史证据保留配额与显式退役重试；无 socket 入容器、无新增凭据。见 [Engine 验收](cluster-engine-qualification.md)。
- [x] 私有部署装配、健康/容量/清理指标、排空/滚动升级工具、有界历史归档（本地 SQLite + mTLS 契约与归档校验见 `service/cluster-ops.mjs` 与 `tests/cluster-ops.test.mjs`；不含真实跨机部署或自动创建凭据）。
- [x] 公共 Gateway → 认证远程 Worker → 原 Engine 的整链路装配与契约验收；网络分区/迟到回执、Worker 跨世代重启对账与控制器重启恢复完整故障矩阵（见 `assembleClusterGateway`、`assembleClusterDockerWorker` 与 `tests/cluster-full-chain.test.mjs`；物理跨机器公网/内网环境验收仍随真实部署环境进行）。
- [x] 跨机器私有数据面与受管 Agent/CDP 隔离路由、真实 X.509 身份材料校验/在线轮换/即时吊销和部署环境预检契约（`wss://<worker>/v1/cluster/stream` mTLS 数据面隧道、裸 CDP 路由拒绝、`loadPrivateTlsMaterial`/`verifyTlsIdentityMaterial`、`rotatePeers`/`rotateWorkerTls` 与 `verifyClusterDeploymentEnvironment` 见 `service/cluster-rpc.mjs`、`service/cluster-ops.mjs` 与 `tests/cluster-data-plane-pki.test.mjs`；真实多机物理网络与生产主机验收仍随真实部署环境进行）。
- [ ] 多控制器 HA 与持久权威选型；不能把复制 SQLite 或增加 Gateway 副本视为完成。
- [ ] 明确发布范围与真实环境后，才发布或部署。

8 小时 secondary Viewer 内存项仍暂缓。
