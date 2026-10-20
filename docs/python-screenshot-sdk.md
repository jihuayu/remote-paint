# Python 截图与 PNG 下载 SDK

新增observations.screenshot(context,AgentScreenshotInput(...))、screenshot_chunk(context,AgentScreenshotChunkInput(...))、release_screenshot(context,AgentScreenshotFileInput(...))、download_screenshot(context,AgentScreenshotDownloadInput(...))。模型使用snakecase、独立AgentScreenshotId、冻结/slotted结构，下载内容是不可变bytes字段content。所有入口先同步校验并复制typed context/binding/document/限制/原文件参数，再返回协程；精确类型拒绝dict、属性getter子类、错ID、bool限制及未知参数。私有rpc_timeout_ms仍50..120000，每次固定一次HTTP，不自动刷新context、重新截图、重绑或重放输入。

JSON结果验证200无Location、原逻辑Run/Session/version/Source binding/document、screenshot ID和严格stage/scope/time/revision/hash/限制/尺寸/块偏移及complete；Source6144/公开8192记录与外层JSON预算分别执行。全部嵌套模型冻结，无__dict__；输入和下载结果的Mypy类型与py.typed保留。release删除原文件引用，过期文件错误保持显式，不自动获取替代图片。

AgentClient.max_screenshot_bytes默认1MiB，允许57..4MiB，与max_response_bytes独立，超cap原文件引用在HTTP前拒绝。二进制分支共用既有BackendTransport Task集合、普通容量和独立end连接池。响应必须匹配PNG媒体/完整长度、文件id/hash/time、safe attachment、no-store/nosniff、Content-Digest和requestId；base64url header context须完整精确匹配。边读边复制进有界bytearray、增量SHA，完整长度/摘要/PNG签名/IHDR/尺寸通过才生成不可变bytes；不返回部分数据。转换时最多同时持有一个bytearray及一个bytes副本，不能称为单缓冲或总进程物理内存上限。极细碎流周期让出事件循环；受信任HTTPX预缓冲Mock也执行大小和完整校验。

超时/调用方Task取消只终止等待；真实fetch/body/aclose尚未结算仍占普通容量，end独立。原有1秒单flight aclose观察保持，非配合实际任务未结算返回CLIENT_CLOSE_PENDING并继续清理；坏头后的慢close仍计入，close失败使客户端closed，错误消息脱敏。Python取消为AgentClientCancelledError/CLIENT_CANCELLED，不假装撤回已经发送的读取。这里尚未证明HTTPX原始接收前分配、浏览器或物理内存预算。

新增22项Python合同首轮通过，合计95项Python；覆盖同步捕获/冻结/bytes不可变、typed/schema/关联/边界/PNG/header/摘要、私有deadline、单次请求、片段和预缓冲、非配合Task/body/close/aclose、独立end，以及真实SQLite/HTTP权限、known unknown不恢复历史或重放、408/取消实际backend槽、旧文件失效。新Python wheel仍10成员、HTTPX0.28.1依赖保持；Node包20成员及全部Node SDK源码字节保持。63个当前服务/合同输入逐hash核对，双平台新目录离线152Node/95Python/TypeScript通过，Mac公共2文件及5源码Mypy通过，无SDK源码回退。

完整134文件1339项JS双平台零失败：Mac1324通过15平台跳过，Linux1333通过6跳过。真实Native首轮通过：新安装Python SDK完成全部截图/块/release/PNG下载，Python driver确认真实bytes及冻结slotted metadata；960x640、26685字节PNG重拼和下载hash/像素一致，SDK严格关联响应头。替换/释放/失败保留/旧Run/导航拒绝、人控期间读可用且读/end保留原grant与OBSHF、known unknown截图下载不清历史/隔离、不重放均通过。真实Provider延迟read-screenshot回包时，SDK收到REQUEST_TIMEOUT/408或CLIENT_CANCELLED，backend实际槽仍在、独立end完成；4closed Run/10injected/2rejected/1unknown，Session无配额、runtime/namespace退役，Node/Python/代理PID退出，Source无宿主发布端口。执行副本Linux broker偏差单列，未覆盖仓库或Chromium缓存。

Node与Python截图SDK在上述范围均已验收，K6仍部分。Source浏览器视口截图不冒充Viewer提交帧，Viewer“WebGL 无法显示”黑框及其他内容显示保持。实际页面download/upload/Profile、完整locator/frame/write-by-handle、业务后置条件/分类、事件/取消、K10/K4、raw CDP/browser AX物理、unknown Engine Start、N1/设备及原8小时仍全部继续。41项10完成/17部分/14待做；原8小时增长失败未修复/未重跑，未放宽门槛、强制浏览器GC、改采样器/演示/无关peer，未暂存/提交/推送。

见[证据](evidence/python-screenshot-sdk.json)、[Node对等范围](node-screenshot-sdk.md)、[公共接口](public-agent-screenshot.md)及[原始清单](optimization-backlog.md)。
