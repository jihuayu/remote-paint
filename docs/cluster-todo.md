# 集群部署 TODO

用户已授权设计、开发和本地隔离验收；公开新功能、真实集群/NAS 部署、付费或新凭据/权限不在当前范围。

- [x] 核对 Registry、Docker provider、Worker 通道与部署绑定，记录复用边界。
- [x] 持久归属、区域/架构/版本匹配、容量、排空、启动世代、epoch 与 Worker 租约。
- [x] 重启隔离、占额保留、退役验证门槛、操作结果未知与禁止自动重放。
- [x] 真实 SQLite、双进程 IPC、定时失效、跨租户/旧归属/迟到响应合同。
- [x] 最小真实 Chromium 多 Worker 本地验收：Source/路由及失效或退役隔离；两个独立进程组合共享一个容器内核，未宣称跨机或每 Session 独立容器。
- [ ] 经过认证的 Worker 传输与现有 DockerSessionProvider/SessionRegistry 适配。
- [ ] 原部署绑定、Engine/镜像身份、Native 全进程退役证据接入，真实网络分区/迟到回执。
- [ ] 独立运行时的 Agent/Viewer/CDP 路由与故障验收，保留原租户授权和 Agent fence。
- [ ] 私有部署装配、健康/容量/清理指标、排空/滚动升级工具、有界历史归档。
- [ ] 多控制器 HA 与持久权威选型；不能把复制 SQLite 或增加 Gateway 副本视为完成。
- [ ] 明确发布范围与真实环境后，才发布或部署。

8 小时 secondary Viewer 内存项仍暂缓。
