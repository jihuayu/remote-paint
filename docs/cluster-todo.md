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
- [ ] 公共 Gateway → 认证远程 Worker → 原 Engine 的整链路外部部署验收；跨机器网络分区/迟到回执与完整故障矩阵。
- [ ] 跨机器私有数据面与 CDP 路由、真实身份材料和部署环境验收。
- [ ] 私有部署装配、健康/容量/清理指标、排空/滚动升级工具、有界历史归档。
- [ ] 多控制器 HA 与持久权威选型；不能把复制 SQLite 或增加 Gateway 副本视为完成。
- [ ] 明确发布范围与真实环境后，才发布或部署。

8 小时 secondary Viewer 内存项仍暂缓。
