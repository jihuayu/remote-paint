# Source 原页面下载核心

本检查点加入本地受信任 Managed Agent Run 的 armDownload、downloadInfo、readDownload、releaseDownload。它接收原 Page 在显式窗口内的下一次浏览器 download 事件，读取浏览器真正生成的文件，支持网络和 Blob；不接受下载 URL、任意本地路径、选择器、脚本或 HTTP 重抓取。它不保证该事件由某个输入动作因果触发，窗口之外的下载沿用浏览器既有行为。

入口在返回 Promise 前捕获严格 own-data 的 context/limits/id/offset。读取独立使用 agent:observe，固定 tenant/管理 Session/target/Run/Page、Native world/documentToken/subscription、controlSession/pageEpoch/viewportVersion/version。arm、info、块和 release 进入既有实际读取 admission，并验证 Native 文档；下载本身作为单个 Run 资源独立跟踪，允许随后提交点击。人控授权和输入历史不会因读取而改变；没有新增私有或公开操作入口。任一 Page frame 导航都会保守地取消等待中的下载，未承诺跨 frame 归属。

每 Run 仅一个 ticket，释放后才能重新 arm。文件默认最多保留1MiB，允许1..4MiB；窗口默认10秒、允许50..30000ms。path() 在真实下载完成后返回受信任浏览器路径，O_NOFOLLOW/O_NONBLOCK 打开描述符，要求普通文件、单硬链接及有界大小，然后分配一个等文件大小的 Buffer。每次最多3072字节、增量 SHA256，检查精确 EOF 及描述符身份/大小/时间；读完关闭描述符、unlink 已知 spool 并完成 Playwright artifact 删除后才公布 ready。零字节文件有效。块结果最多6144字节 JSON、原始块最多3072字节。文件名为有界显示元数据，媒体固定 application/octet-stream，不能作为调用方路径。

超时、导航、原 Page/capture/CDP 更换、权限撤销和 Run end 阻止晚到数据发布。release/end 会取消并等待实际 browser path/cancel、描述符和删除工作；观察者结束不会假装真实工作已结算。end 先取消下载再等待当前读取，晚到 release receipt 也重新验证权限和文档。失败关闭/删除报告错误并保留未确定清理状态。成功文件读完即删除已知 spool，内存结果只在原 Run 保留；显式 release/end 清除它。

这里的4MiB是完成文件的保留缓冲限制。Playwright 在 path() 前已让 Chromium 写临时目录，因此不是写盘前硬上限；浏览器临时目录预算、取消后 partial spool 的独立退休证据、原始协议接收前分配及 Playwright BrowserContext 保留 Download 元数据的物理上限仍是明确未完成门槛。没有修改既有下载策略，也没有把额外下载事件自动纳入此 ticket。

新增19项合同，最终135文件1358项JS双平台零失败：Mac1343通过15平台跳过，Linux1352通过6跳过。覆盖真实临时文件/空文件/摘要/分块/删除、超限、符号链接/硬链接、异步删除/取消/结束竞态、权限/原对象/Native文档失效、精确模式与人控授权。SDK28个源码路径与依赖全部保持；本检查点没有重装 SDK 或宣称实际页面下载 SDK 已实现。

隔离的 Linux canonical Native Source 首次探针在删除 artifact 后查询 path 失败，第二次在导航后无显示帧的人控门槛失败；均保留失败、进程退休和容器退出证据。最终探针修正后真实网络下载保留原 Page cookie 且只请求一次；Blob、空文件、超限删除、慢下载导航/结束取消，以及人控点击下载、读取、释放和 end 保留原 grant 均通过。5个已知浏览器/Broker进程身份全部退休、Source/fixture 关闭，容器停止/PID0/无OOM后删除。Linux broker 仅执行副本使用既定 viewport 协议构建，偏差逐 hash 列明，未覆盖仓库或构建缓存。

K6仍为部分，41项保持10项范围内完成、17项部分、14项待做。下一检查点是私有 RPC/Native resource/provider/channel，再分别实现公开 HTTP 与 Node/Python SDK、浏览器写盘/元数据预算；所有余项及原8小时增长失败继续。WebGL黑框“WebGL 无法显示”和其他显示行为保持。未重跑8小时、放宽门槛、强制浏览器GC、改采样器/演示/无关peer，未暂存、提交或推送。

见[证据](evidence/agent-download-core.json)、[既有截图SDK](python-screenshot-sdk.md)和[进度](optimization-progress.md)。
