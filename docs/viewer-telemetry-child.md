# Viewer 子页面性能采集

本检查点只实现公开 Viewer 子页面内部采集器、有限数据合同及 Window/Worker 接入。宿主 Frame/DOM 的性能与首帧 API、父子消息校验和真实 Native 浏览器遥测仍待后续检查点；不能据此完成 K2。

首帧在当前验证通过的 Welcome 授权下，首个场景提交结果到达 UI 时产生。固定 13 字段标记 stage=scene-submitted、clock=viewer-ui-receipt；初次开始点为 renderer-init，重新连接为 connection-attempt，Worker 路径包含返回 UI 的消息跳转。它不是物理显示、Source 捕获帧龄或业务成功；不将不同进程的时钟直接相减。

性能快照固定 22 字段，包含连接代次、frame/pageEpoch/viewportVersion、尺寸、Worker 与有限呈现模式、提交计数及局部吞吐、距 UI 收到结果的时间、重放耗时、接收/资源字节及资源数、Wasm heap 和 GPU/总驻留估算。内存统一标记 client-estimate，缺失或非法可选测量为 null，不虚构进程物理内存。每次性能发布至少间隔 250ms，重连仍保持间隔；空闲时报告结果年龄及零新提交吞吐。

采集器只保存一个当前授权绑定、固定字段首帧/最新投影及一个计时器。严格有限自有数据字段验证拒绝额外字段、访问器、非有限数与不一致空状态；测量提取不执行原始对象 getter。完整场景、DOM/编辑内容、Source 身份/URL/密钥、原始异常、渲染器和内存对象均不保留或发布。授权标识仅存在内部传输信封，快照不含它。旧连接代次、较旧 frame 命名空间、取消计时器、旧 Worker 与销毁后的结果不能更新当前状态；暂停和断线立即清空。

新增 13 项合同在实现前全部失败，之后通过；相关 199 项 Viewer 回归通过。实际 Node HTTP/WS/SQLite/ControlLease/ViewerInput 验证主线程与 Worker 保存入口，但 DOM/CanvasKit/呈现器/Worker 调度为明确夹具。首次双平台 872 项完整回归各有两项失败，暴露帧龄观察器复制资源清单遗漏新模块；补齐模块并增加字节相等断言，保留生产构建一致性门槛和原失败日志。最终 101 文件/872 项：Mac 857 通过、15 平台跳过；Linux 866 通过、6 平台跳过，无失败或取消。

新私有 Node 安装包含 16 文件，Mac/Linux 各离线安装后通过 77 Node、16 Python 合同与严格 TypeScript；Mac 安装版 Mypy 也通过。观察器修复只改两份测试文件，安装包/验证器字节与已验证包相同。未发布包。旧 Native 三种路径的视口证据不冒充此次新增遥测的真实浏览器证明。

下一步先验证 ChildBridge、实际签发授权绑定和宿主有限 API，再做 GPU Worker/CPU Worker/CPU 主线程实际 Native 验收。41 项仍 9 完成（范围内）、15 部分、17 待做；原 8 小时失败和 192MiB 增长门槛保持，未自动重跑、未改演示或采样器，未暂存、提交或推送。机器收据见[范围证据](evidence/viewer-telemetry-child.json)。
