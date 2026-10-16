# 早期实施路线与阶段验收

下表保留最初单台 macOS 阶段的路线和证据，编号 1–10 区别于后续性能优化 1–8。当前 Linux ARM64 完整构建、原生 Broker/Gateway 与 Mac Viewer 已通过[最终验收](native-final-acceptance.md)；当前性能工作见[原生数据面](native-data-plane.md)，下一阶段见[完整优化清单](optimization-backlog.md)。初始路线中的同 revision CanvasKit 构建、复杂页面回退、Steel 集成和生产解码隔离仍需分别推进，不能将后续性能验收解释成这些能力已全部完成。

每一行作为独立实现/验收/提交检查点。本次单台 Apple Silicon macOS 的 **3–7 已完成真实定制 Chromium 动态验收**；1–2 和 8–10 留待后续。当前运行使用浏览器进程内 GPU/Viz 和独立 Renderer，只验收普通网页软件路径。

| 已完成 | 运行证据 |
|---|---|
| 3 | [字体/图片](evidence/font-image-report.json)、[原生序列化 4 项测试](evidence/native-serializer-report.json)、[动态流式字形](evidence/native-live-report.json) |
| 4 | [真实捕获、token、线程与 Viz IPC](evidence/native-capture-report.json) |
| 5 | [0/700/0 滚动、固定头部、资源复用与像素对照](evidence/native-scene-report.json) |
| 6 | [完整动态、慢客户端、导航/resize、丢资源恢复](evidence/native-live-report.json)、[实际 CanvasKit 缓冲释放](evidence/surface-lifecycle-report.json) |
| 7 | [原生动态显示下的 83 条输入与控制交接](evidence/native-input-report.json) |

| 顺序 | 独立任务 | 可检查的完成条件 |
|---|---|---|
| 1 | Linux 构建锁定与同源 CanvasKit | 固定 Chromium/Skia SHA、编译器、构建选项、Wasm hash；CI 实际构建并重放同一 fixture |
| 2 | 在隔离机器复跑阶段 A | 把样例发至第二台机器或容器，用无源站网络访问权限的 Viewer 重放并保存对照证据 |
| 3 | 字体子集与图片序列化 | 页面逐步新增中文、Emoji；子集无缺字/错 glyph；认证图片及 blob 图片不由 Viewer 重请求 |
| 4 | 原生捕获组件与受控 IPC | 无 Viewer 时不序列化；有 Viewer 时输出不可变全图块记录；编码不阻塞 raster 关键线程 |
| 5 | 内容资源与 Viz 合成映射 | producer/epoch/local resource/revision 映射跨进程 remap 与 release；固定层+滚动层不串图、不残影 |
| 6 | 全场景提交、增量、慢客户端 | 丢失依赖帧必须请求关键帧；队列有界；重连回到新快照；不可直接跳过有依赖的中间帧 |
| 7 | 受管输入与租约 | CDP 鼠标/滚轮/键盘/中文 composition；CSS坐标正确；旧 epoch/viewport/lease/seq 被拒绝 |
| 8 | iframe、复杂滤镜与光栅回退 | 聚合目标 Surface 子树；backdrop/blend 回退覆盖完整依赖区域；视觉对照确认 |
| 9 | Steel Worker 与 Gateway 接入 | 原有会话与 Agent 继续用原通道；Broker 绑定同一页面；跨 Session 不串流；人工接管有交接点 |
| 10 | 解码隔离与性能测量 | 原生图片尺寸/字体/复杂度预算和模糊测试；实际网站测 CPU、内存、输入延迟、带宽、回退比例 |

## Chromium 实现范围

在 `cc/raster/raster_source.cc` 的 `RasterSource::PlaybackToCanvas()` 附近保留原软件 raster 路径，给独立组件加旁路捕获。这个函数现有代码负责裁剪、矩阵和 `PlaybackDisplayListToCanvas()`。补丁前先确定重放坐标系、整个 tile 的矩形以及 partial raster 的旧内容语义；远程资源必须是完整 tile 的替换记录。

不能把传入的 raster canvas、DisplayItemList 或 GPU 对象的裸指针交给后台编码线程。先在允许的线程拿到所有权明确的不可变记录，序列化/压缩再由独立任务处理。图像读取可能受 GPU context 和线程约束，软件路径成功不代表 GPU 路径覆盖。

原生补丁只覆盖这个已锁定的软件路径。资源提交和 Viz remap 传递路径已接入。`SurfaceAggregator` 输出真实合成关系，资源生命周期提前关联本模块生成的 ID；最终 texture id 仅供诊断。

已有 pinned Chromium checkout、工具链、四个按顺序应用的补丁、完整 headless_shell 和运行验收。四个补丁在 14 个上游文件上完成逆向/正向 round-trip 检查。完整动态验收含源页面与 CanvasKit 像素对照，未以 fixture 或编译成功代替原生证据。复杂网页覆盖和性能优化不由该验收推断。

## Steel / Gateway 的接入契约

现有原型没有访问、修改或启动 Steel。用户提供的 `CHROME_EXECUTABLE_PATH` 接入方式需要在实际部署使用的 Steel revision 上再次确认；本次上游仓库 tree 查询被 HTTP 403 阻挡，不能作为该版本配置已经验证的证据。

建议 Worker 内的 Broker 接受可信控制面的：session ID、page target ID、page epoch、viewport version、viewer demand。它为浏览器内部 IPC 提供资源通道，Gateway 只做鉴权和按 Session 转发，不逐条解析 SKP 绘制操作。

绘图连接与 Agent CDP 必须绑定同一个 target。当前调试原型自行创建临时浏览器，**没有**绑定现有 Steel 会话，不能作为集成实现直接替换。

租约通过受管 Agent 操作通道执行：申请人工接管时阻止新的 Agent 操作，并等待已提交操作达到交接点。关闭 CDP 连接不能撤销网页已执行的 JS。输入的 `lastProcessedInputSeq` 只确认注入/处理，不确认业务动作成功。
