# 单机独立容器验收

2026-10-25 15:27:51 UTC，最终源码完成验收，退出码 0，用时 4.662 秒。它验证单机独立容器，不能替代跨机器或 HA 验收。

## 环境与结果

使用已有 ARM64 镜像 `sha256:c75c58487264d5350a7b83eb6a5f11449dd0e1c49be81cedde3ace6c9ea7dd29`，Chromium 155.0.8059.79、原 Rust Broker、Node 22.23.3，以及已有依赖归档。最终 JavaScript 以只读输入解包到任务容器，不重建镜像或 Chromium，也未发布新镜像。

Gateway 和两个 Worker 为三个任务自有容器。Worker PID namespace 不同；各一份真实 Source/Chromium/Broker、独立 Profile、内存与进程限制。使用现有 Docker bridge、非 root、只读根、cap-drop ALL/no-new-privileges，无宿主端口、Docker socket 挂载或系统网络设置更改。每个 Worker 只获得自己的短生命周期测试 TLS 身份，没有控制器私钥。

验证了以下完整路径：

1. 控制器证书正常认证，CA 信任但不在 allowlist 的客户端拒绝。
2. 公共 Session API 创建两个会话，按节点/架构/完整版本分配，原 Registry 进入 Ready；其他租户查询返回 404。
3. 公共持久 Agent 经认证 RPC 在两个真实页面分别点击，测试 HTTP 页面实际记录对应事件。
4. 公共 Agent 截图分三块返回，合并后 7,648 字节，SHA256 为 `f160b2929c91f3017f5757da04cdf1f1add53da3a763094f17f657afd9396fec`，与元数据一致并正常释放。
5. Viewer 短票据经原 Gateway/resolver 到各自原生 Source，各收到真实 FrameCommit 及两个二进制资源包。
6. 宿主只对 ID/标签已核对的任务 Worker A 实际执行 Docker pause，A 的路由失效且清理未确认时继续占额；B 的公共 Agent 仍能再次点击。
7. 实际 unpause 后 Worker 租约保护关闭原 Native 资源；显式 release/retryClose 取得已认证的退役回执才释放占额。两个 Worker 的创建计数始终各 1，旧 Session 没有重放。
8. 正常关闭 B，Registry 与 placement 最终占额均为 0；最终 controller cleanup 回执 closed。测试容器退出和移除另有宿主清理回执。

数据版本中的 Wasm SHA256 为 `aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959`。结果、输入哈希和命令回执摘要见 `docs/evidence/cluster-rpc-qualification.json`。PNG 与原始日志仅在本地任务验收目录，不包含用户页面或 Profile。

## 可复现入口与故障协调

准备匹配架构的既有镜像和当前源码/依赖。Worker 使用 `tests/fixtures/cluster-container-worker.mjs`，Gateway 执行 `tests/verify-cluster-containers.mjs`。测试 PKI 由 `tests/fixtures/cluster-test-pki.mjs` 生成一日测试身份，显式使用 SHA256，不能用于生产。

输入 `/input/containers.json` 明确列出从已知任务 CID inspect 得到的私有地址、nodeId 与本次启动 incarnation；不得猜测用户服务器地址。Gateway 写 `/results/control-phase.json` 的 `ready-for-pause` 后，宿主核对目标 CID/标签再暂停 A 并写 matching case 的 `host-phase.json`；出现 `ready-for-unpause` 后恢复并确认。协调等待有界为 120 秒，不改变业务 RPC 或租约期限；整组执行有 260 秒上限。宿主故障注入器 finally 会解除自己施加的暂停。

保留首次测试失败：宿主工具往返超过最初 15 秒协调窗口，因此未执行暂停，业务路径通过但整组失败。修复仅延长测试协调等待并自动衔接，未把该轮算作通过。早期测试 PKI 的 LibreSSL 默认摘要过弱也曾被 TLS 正确拒绝，改为显式 SHA256，未放宽验证。

## 边界

Worker 的真实 Native 资源关闭及已观测自有进程退役通过；它不是原 DockerSessionProvider 的完整 Engine namespace 证明。原 Docker provider 的真实类、原 SQLite 外键和回执验证以结构 Engine 夹具另测。跨机器、私有数据面网络、真实持久身份、证书轮换、生产部署、多控制器一致性与 HA 均未验收。8 小时内存项仍暂停。
