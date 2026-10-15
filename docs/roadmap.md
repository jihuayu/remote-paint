# 下一阶段实施拆分

每一行作为独立实现/验收/提交检查点。当前已完成阶段 A 的本机跨实例实验；后续各项尚未实现。

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

## Chromium 的首个真实补丁如何限定

在 `cc/raster/raster_source.cc` 的 `RasterSource::PlaybackToCanvas()` 附近保留原软件 raster 路径，给独立组件加旁路捕获。这个函数现有代码负责裁剪、矩阵和 `PlaybackDisplayListToCanvas()`。补丁前先确定重放坐标系、整个 tile 的矩形以及 partial raster 的旧内容语义；远程资源必须是完整 tile 的替换记录。

不能把传入的 raster canvas、DisplayItemList 或 GPU 对象的裸指针交给后台编码线程。先在允许的线程拿到所有权明确的不可变记录，序列化/压缩再由独立任务处理。图像读取可能受 GPU context 和线程约束，软件路径成功不代表 GPU 路径覆盖。

首个补丁只覆盖这个已锁定的软件路径。后续才修改资源提交和 Viz remap 的传递路径。`SurfaceAggregator` 的输出可作为合成依据，但不能凭最终 texture id 还原文字绘制；必须在资源生命周期上提前关联本模块生成的 ID。

没有 Chromium checkout、工具链和编译验证前，本项目不提供看似可应用但未经验证的 C++ diff。

## Steel / Gateway 的接入契约

现有原型没有访问、修改或启动 Steel。用户提供的 `CHROME_EXECUTABLE_PATH` 接入方式需要在实际部署使用的 Steel revision 上再次确认；本次上游仓库 tree 查询被 HTTP 403 阻挡，不能作为该版本配置已经验证的证据。

建议 Worker 内的 Broker 接受可信控制面的：session ID、page target ID、page epoch、viewport version、viewer demand。它为浏览器内部 IPC 提供资源通道，Gateway 只做鉴权和按 Session 转发，不逐条解析 SKP 绘制操作。

绘图连接与 Agent CDP 必须绑定同一个 target。当前调试原型自行创建临时浏览器，**没有**绑定现有 Steel 会话，不能作为集成实现直接替换。

租约通过受管 Agent 操作通道执行：申请人工接管时阻止新的 Agent 操作，并等待已提交操作达到交接点。关闭 CDP 连接不能撤销网页已执行的 JS。输入的 `lastProcessedInputSeq` 只确认注入/处理，不确认业务动作成功。
