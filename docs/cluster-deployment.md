# 集群基础：设计与验收

本地开发阶段。第一步采用单个持久控制器管理多个 Worker，不预设 Kubernetes、云厂商或 NAS 地址；不承诺浏览器热迁移、任务无损恢复或副作用恰好执行一次。

## 复用与接线

| 现有模块 | 已有职责 | 集群补充 |
| --- | --- | --- |
| `service/session-registry.mjs` | 租户、区域 provider、幂等、TTL、配额、恢复隔离 | 区域内节点选择和固定 Session 归属 |
| `service/docker-session-provider.mjs` | 固定 Engine 配置、资源身份、启动/健康/退役与 Source 解析 | 多个可信节点适配器的调度和路由 |
| `service/session-worker-channel.mjs` | 私有 owner 通道、心跳、Ready/Unavailable、关闭结算 | 经过认证的跨节点传输和节点世代租约 |
| `service/runtime-deployment-binding.mjs` | 固定部署和账本绑定 | 远程节点配置/身份连续性 |
| `service/viewer-access.mjs` | Session/角色票据和经过认证的 Source 代理 | 接入验证后的 Worker resolver |

原 owner 凭据、Agent fence、Engine 身份与物理退役合同继续有效，集群租约号不能替代这些能力。认证传输、原 provider/Registry 接线和单机独立容器验收已进一步完成，见 [RPC 装配与边界](cluster-rpc.md)；尚未部署生产集群。

## 已实现的控制基础

`service/cluster-placement.mjs` 是单所有者 SQLite 账本，要求真实私有文件数据库、父目录 0700、文件 0600、同一用户及稳定文件/目录身份。内存库、其他格式、第二个独占所有者或路径替换被拒绝。SQLite 事务提交前后核对文件身份，存储故障后停止受理；不支持复制数据库热接管。

节点注册包括 nodeId、每次启动的 incarnation、区域、架构、完整数据版本与容量。只选择健康、未排空且区域/架构/版本匹配的节点，按已保留槽位比例分配；创建中或清理不确定的资源都占额。版本保持现有 `chromium:...;wasm:...` 格式，不能用其他架构/版本替代。

每个 Session 固定绑定节点世代与持久递增 epoch。同 ID 同请求返回原归属，跨租户不可见，变更请求冲突。路由必须匹配原租户、Session、版本与 Ready。关闭/超时不会释放槽位，原归属必须经过可信同步退役验证器；摘要本身不是退役证明。当前虚拟夹具验证器不能用于生产 Native 退役。

`service/cluster-worker-fence.mjs` 在心跳请求前记录本地单调时钟，响应延迟消耗租约预算，不需要跨节点时钟同源。迟到响应、旧世代和错误启动身份不能续命。定时器撤销 owner 信号；操作前后核对租户/Session/节点/世代/epoch。操作发出后丢失归属返回 `unknown`，不能当作未执行并重放。owner 信号取消与实际清理结束是不同事件。

控制器重启将全部活动归属持久隔离，保留槽位。新 Worker 世代同样先核对旧资源，确认退役后才允许新 Session。旧 Session 不会静默重建或迁移。

## 运维与故障策略

扩容先准备匹配架构、固定镜像和数据版本的可信节点，核对原部署绑定/运行时证据，再注册、续租、开放容量。缩容先 drain，保留既有路由，等待会话结束或显式释放，确认完整退役再停节点。不会自动创建机器、启用付费资源或强制终止长期会话。

网络分区时 Worker 关闭 owner 资源并拒绝新操作，控制器继续保留不确定资源占额。浏览器可能已经向外部网站发出副作用，无法承诺撤销或安全重放。节点/Session 历史保留有界，满额拒绝新增；归档和节点删除工具仍待实现。

生产配置应明确单控制器私有持久卷、Worker allowlist、已有身份材料、固定镜像/版本/容量、每 Session 原有 Docker/网络/Profile 隔离，以及 Native 全进程退役证据入口。CDP 保持私有网络或节点 loopback；公共 API 不返回内部 Source URL、owner 凭据或裸 CDP。

本模块不创建凭据、不配置 TLS/防火墙、不增加 Docker socket 挂载，也不修改现有服务。多控制器 HA 另需一致性权威、控制器 fencing、持久幂等与票据归属；现有内存 Viewer 票据不是无状态多副本网关，复制 SQLite 或增加副本并不能取得 HA。

## 本地运行与证据边界

要求 Node 22.13+ 的 node:sqlite。在已准备源码/依赖的目录执行：

```sh
node --test tests/cluster-placement.test.mjs tests/cluster-worker-fence.test.mjs tests/cluster-control-integration.test.mjs
```

本次复用已交付 ARM64 镜像、Node 22.23.3，容器网络 none，无宿主端口，零 Docker/Chromium 编译。合同使用真实 SQLite、两个独立 Node IPC Worker 和真实租约定时器；其资源为明确的虚拟夹具。真实 Chromium 多 Worker 结果另行记录，不等同于跨机器集群或独立内核隔离。

历史共享容器 Native 验收见 [首阶段记录](cluster-native-qualification.md)。后续独立容器、真实公共 Agent/Viewer、暂停恢复及截图回执见 [容器验收](cluster-container-qualification.md)。待办见 [cluster-todo.md](cluster-todo.md)。
