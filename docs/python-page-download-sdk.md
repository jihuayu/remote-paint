# Python 原页面下载 SDK

本检查点为后端 AgentClient.observations 增加 arm_download、download_info、download_chunk、release_download、download_file，至此 Node/Python 两种 SDK 的实际页面下载接口均在约定范围内通过。原 Page 显式窗口只捕获下一次 download 事件，仍不承诺与某次输入的因果关联；同 Run 保留一个 ticket，需 release 后重新 arm。不接受 URL、路径或重新请求文件。

新 _download.py 提供 opaque NewType AgentDownloadId、limits/四种输入，以及 armed/pending/ready/chunk/released/file 等冻结且 slots 的模型。info 可按 AgentDownloadReady 判别，pending 没有 byte_length；nested context/limits 同样冻结。五个普通 def 入口在返回 coroutine 前同步捕获完整原观察 context 和输入副本，精确类型检查先于属性读取，拒绝子类/getter、错误 ID、bool 数字、额外 wire/超界字段。输入更改不能影响已准备请求。调用固定一次 HTTP，不自动重试、刷新 context、重 arm 或重放输入。

JSON 严格验证逻辑 Run、管理 Session、版本、tenant/target/workerRun、controlSession/文档、原 ticket、stage/scope、limits、规范 ISO 时间、安全文件显示名、generic binary、大小/摘要。Source 6144 字节及公开 8192 字节和外层接收 cap 分别执行。块最多 3072 字节，base64、offset/byteLength/totalBytes/complete 必须精确关联，空文件及 EOF 有效且空摘要必须正确。

max_download_bytes 默认 1MiB，允许 1..4MiB；与 max_response_bytes、截图预算独立，零字节文件仍可读，文件引用超本地 cap 在 HTTP 前拒绝。二进制严格核验 200/noLocation/noEncoding、application/octet-stream、精确 Content-Length/Content-Digest、原 dl_UUID.bin 安全附件、no-store/nosniff、requestId、downloadId/hash/completedAt 及规范 base64url 完整原 context，header context 不做投影丢字段。空文件和单字节文件不依赖 PNG 格式或最小长度。

头部通过后分配有界 bytearray，逐块复制并增量 SHA，每128片段让出事件循环；只有完整长度及摘要通过后返回不可变 bytes，元数据冻结，无部分结果。bytes(buffer) 转换会短暂同时保留 bytearray 和 bytes 两份文件大小的数据；该预算不是网络接收前、浏览器写盘前或进程总物理上限。

真实 HTTPX Task/body/aclose 沿用现有 transport 的普通占用及独立 end 连接池。timeout/asyncio 取消仅停止等待，非配合 Task/关闭未结算仍占普通容量；坏头后慢关闭同样计入，关闭失败保守封锁。HTTP 错误、requestId/outcome、AgentClientCancelledError 的 asyncio.CancelledError 语义保持。rpc_timeout_ms 为原私有 RPC 观察期限，不会撤销实际页面效果。

23 项专项最终通过：同步捕获、精确类型/getter拒绝、frozen/slots/ready判别、规范 JSON/base64/元数据、严格响应头/完整原 context、独立 cap、空/1字节/碎片/预缓冲、截断/超长/坏摘要无部分结果、一次发送、非配合 Task/取消/慢关闭/aclose/end；另含真实 SQLite/HTTP 权限、已发生未知输入历史不变、408/取消保留后端真实槽、旧 ticket 不自动重 arm。首轮23项全部因真实实现错误 NameError 失败：cast 运行时求值了仅 TYPE_CHECKING 导入的模型；已改延迟类型引用并保留失败日志，未隐藏或归因为 fixture。

新 Python wheel11成员逐字节对应，Node21成员包及源码与父检查点保持。70个当前服务/合同输入逐 hash 核对，新目录离线安装双平台各175 Node/118 Python/TypeScript零失败，Mac公共2文件和源码6文件 Mypy 通过。138文件全量1421项 JS 双平台零失败：Mac1406通过15平台跳过，Linux1415通过6跳过。

真实 Native 首轮通过。独立 Python 进程只导入新 venv 安装包，五种下载正向操作全部走该 SDK；driver 在 Python 内断言 content 是 bytes、返回模型无 __dict__ 且修改抛 FrozenInstanceError。原 cookie 网络文件8999字节只请求一次、Blob5001字节、空文件、块与二进制摘要一致；释放、旧 Run、导航、超 cap 和权限拒绝通过。人控下载 read/release/end 保留已按住的按键及原 grant；真实发生一次的未知输入后下载可读，unknown 历史/隔离不变，同 key 不重放、新输入拒绝。

实际 Native 页面主线程各阻塞1秒时，新装 SDK 分别收到 HTTP408/REQUEST_TIMEOUT 与 CLIENT_CANCELLED，后端真实槽仍占用、独立 end 返回202，晚结果不采用 closed Run。Node Session SDK 只管理生命周期；raw HTTP 只用于既有 context/输入/生命周期及故意负向 wire 检查。6个逻辑 Run 全部关闭，8 injected/1 unknown/0 rejected；Session 不占 quota，重开账本及独立 namespace 退休证据通过，Python与Node已退出，容器有确认退休证据。既定 Linux broker 仅在执行副本替换并单列 hash 偏差。

Node/Python 页面下载 SDK 在上述范围内验收，K6仍部分：Chromium写盘前预算/取消后的partial spool退休、Playwright保留Download元数据物理预算、完整定位/frame/按句柄写仍待做。41项保持10范围内完成/17部分/14待做。上传/Profile、K7/K8/K4、unknown Engine Start、N1/设备及原8小时增长失败继续。WebGL黑框文字占位与其他显示保持；未重跑8小时、放宽门槛、强制浏览器GC、修改采样器/演示/无关peer，未暂存、提交或推送。

见[证据](evidence/python-page-download-sdk.json)、[Node下载SDK](node-page-download-sdk.md)、[公开协议](public-agent-download.md)及[进度](optimization-progress.md)。
