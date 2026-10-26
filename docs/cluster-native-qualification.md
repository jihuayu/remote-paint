# 真实 Chromium 双 Worker 本地验收

2026-10-25 14:16:28 UTC，`tests/verify-cluster-native.mjs` 通过，实际用时 5.112 秒，退出码 0。本阶段基于本地集群基础提交 `6429951770a62acbeb4ce02c0f1c7e78a8f13f1f`；没有公开推送、部署或创建凭据。

## 实际执行

两个独立 Node IPC Worker 分别通过现有 `NativeSessionResource` 启动独立 Chromium 155.0.8059.79 与 Rust Broker。复用已交付 ARM64 镜像、缓存依赖和已编译二进制，未构建 Docker/Chromium。两个浏览器使用各自的 Playwright 专用 Profile，没有用户浏览器资料。

真实 SQLite 为两个 Session 分配不同节点，完整 Chromium/Wasm 版本匹配后才进入 Ready。按原租户/Session/版本路由到正确 Worker，分别读取不同页面标识、实际点击按钮、取得 Chromium PNG；两张 PNG 的摘要不同。原生私有 WebSocket 路径均收到真实 FrameCommit 和两个二进制资源包，未使用虚拟 Source 或人工绘制资源。

随后停止一个 Worker 续租，另一个持续续租。失效 Worker 的 owner 信号触发原 Native 资源关闭，旧路由与旧操作被拒绝；另一个 Worker 仍可点击、截图并接收原生帧。账本在 Native 清理和 Worker 真实退出之前仍保留两份占额；取得绑定原 Session/fence 的回执后才释放一份。旧 Session 返回隔离/终态，不被自动重建。

失效 Worker 核对了由其自身 Chromium CDP 报告及其自身 Broker 子进程提供的五个 PID；关闭后这些已观测进程不存在、已终止或原 PID 身份已更换。没有查询宿主机进程清单。该观测不证明整个容器 namespace 已清空，不能替代生产 Docker provider 的完整退役合同。两个 Node Worker 最后都真实退出 0，signal 为 null，回执单独记录。

## 可复现入口

在已有匹配架构的私有 Linux 测试容器中准备同一源码与固定依赖，保持网络 none、不映射宿主端口。指定已核实的定制浏览器及 Broker：

```sh
REMOTE_PAINT_CHROMIUM=/opt/remote-paint/browser/headless_shell \
REMOTE_PAINT_BROKER=/opt/remote-paint/app/native/bin/remote-paint-broker \
REMOTE_PAINT_DATA_PLANE=native \
REMOTE_PAINT_TEST_BROWSER_VERSION=155.0.8059.79 \
node tests/verify-cluster-native.mjs /results/cluster-native-qualified
```

执行器使用了 120 秒总上限和 5 秒终止余量。脚本输出 `result.json`、`cleanup.json` 与仅含测试自有进程的 stderr 日志；成功结果在两个 Worker 清理结算后才写入。机器可读摘要及输入哈希见 `docs/evidence/cluster-native-qualification.json`。

## 未覆盖

这是同一个既有 Docker 容器中的独立 Node/Chromium/Broker 进程，仍共享内核与容器网络。没有验收每 Session 独立容器、跨机器网络分区、生产认证 RPC、多控制器 HA、公开 Gateway/Agent API 完整接线、跨节点 Viewer/CDP 访问或生产部署。最小测试适配器直接使用可信 IPC；生产仍需将相同租约/归属检查接入既有 DockerSessionProvider、SessionRegistry 及完整运行时证据链。

本次没有测量生产延迟、容量或长时内存，也没有恢复暂缓的 8 小时 soak。27 项控制合同与本项 Native 验收分别提供证据，不能互相替代。
