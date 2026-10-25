# 持久缓存本地验收（2026-10-25）

基于已合并主分支 `2d886d33b541431982baeb3be3ebd6400d73758d`，将原目录已有 C6 实现按文件归属复制到独立本地分支 `codex/persistent-cache-20261025`。原目录 25 个相关文件的 SHA256 保持不变。本阶段未公开推送缓存功能。

## 当前结果

- 27 个相关合同文件：290/290 通过，无 skip/cancel。覆盖权限、公开代理、主线程/Worker、内存计费、资源与静态资产。
- 真实 IndexedDB 基础验收：32 项通过。真实请求阻塞、事务错误/回滚、迟到终态结算验收通过；未在实际 abort 前释放计费或重复受理清理。
- 容量：512×128 KiB 达 64 MiB，512×256 B 单独验证条数上限，64×1 MiB 单独验证字节上限。溢出时正确按写入顺序淘汰，元数据与 Blob 数量一致，最终物理清理归零，1,118 项断言通过。
- 满容量 offer 使用原 150 ms 预算，三组实测约 29.5、30.2、5.7 ms；单次受控样本，不是生产延迟或内存指标。
- 实际公开代理协商，无人工丢包 relay：主线程/Worker 冷连接各接收一个 SKP，重连从 IndexedDB 恢复，分别少传 33,638 字节；Source 仍向代理发送原资源，不代表 Source CPU 降低。PNG 一致。
- 真正终止 Source/代理 WebSocket 后客户端自动重连，两条路径均恢复持久缓存。物理破坏 Blob 后经原 keyframe 机制恢复；退出后数据库两表及 Worker 归零。
- 实际 Viewer 模块构建切换及回退：保持同一 Wasm 摘要、同一私有浏览器 Profile，明确杀死测试自己创建的浏览器子进程后重启，旧数据确实物理保留。兼容的新静态构建直接命中；创建新的真实 Registry Session 后旧 realm 被清除，首次资源重新传输。主线程与 Worker 共六个场景通过。
- Viewer TypeScript 声明与使用合同：缓存 TypeScript 5.9.3 严格检查通过。

## 本次修复

缓存模块加入生产资产后，帧龄观察器的复制清单缺少 `persistent-resources.mjs` 与 `resource-cache.mjs`，诊断插入点也与带异步缓存恢复的新 Worker 不符。首次相关回归 288/290，通过保留原资产摘要和唯一插入点断言修复后 290/290。没有启动长期 soak。

新增浏览器选择辅助仅读取可信测试配置 `REMOTE_PAINT_TEST_BROWSER`，默认仍使用原 macOS Chrome 路径。Linux 验收复用已交付 ARM64 定制 Chromium，不下载新浏览器、不改变生产配置。

## 证据边界与保留失败

使用真实 Chromium 155.0.8059.79、CanvasKit 0.42.0、IndexedDB、HTTP/SQLite 权限和 WebSocket。Source 是明确的虚拟 Node Source，使用已有 SKP；未完成真实 Native chunk 路径、跨 CanvasKit/Chromium 版本升级、整个生产性能/SLO 或长期 RSS 验收。

尝试另一 npm 缓存 CanvasKit 变体时，生产胶水摘要保护返回 `Unsupported CanvasKit glue build`；未放宽保护。最初的人工 `Page.crash` 驱动触发 Chromium 致命检查并达到 120 秒测试上限，之后改为终止精确归属的测试子进程，不把第一次算作通过。原日志保留在工作区验收目录。

运行使用既有 `remote-paint:linux-arm64` 镜像、Node 22.23.3、46 MB 依赖归档及已有 TypeScript 工具缓存，Docker/Chromium 编译次数均为零。容器网络为 `none`，仅容器内部 loopback，无宿主端口或用户浏览器资料。

可复现入口：`tests/verify-persistent-capacity.mjs`、`tests/verify-cache-offer-viewer.mjs`、`tests/verify-persistent-version.mjs`、`tests/verify-persistent-resources.mjs`、`tests/verify-persistent-settlement.mjs`。参数为独立输出目录；需先准备已固定的项目依赖和可执行浏览器。机器可读回执见 `docs/evidence/persistent-cache-qualification.json`。
