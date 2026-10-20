# Node 截图与 PNG 下载 SDK

新增observations.screenshot(context,input?,options?)、screenshotChunk(context,{screenshotId,offset,maxBytes?,rpcTimeoutMs?},options?)、releaseScreenshot(context,{screenshotId,rpcTimeoutMs?},options?)、downloadScreenshot(context,{screenshotId,sha256,byteLength,observedAt,rpcTimeoutMs?},options?)。所有方法在返回Promise之前同步复制严格普通自有数据，固定逻辑Run/Session/version、Source binding/document和原文件参数；options只接受signal，每次固定一次HTTP，不受mutation retries影响，不自动刷新context、重绑、重新截图或重放动作。Node根入口/backend/agent类型一致，shot ID与Run/Element类型分开。

前三种JSON结果验证200无Location、精确字段/原逻辑及Source/document/file关联、stage/scope/time/revision/尺寸/hash/限制和分块偏移/长度/complete；Source6144/公开8192记录预算独立于原JSON传输cap。结果深度冻结。新增的PNG分支共用现有BackendTransport ordinary容量和实际fetch/body/cancel占用，end保持独立；没有旁路第二套无界下载客户端。

AgentClientConfig.maxScreenshotBytes默认1MiB，允许57..4MiB，与JSON maxResponseBytes独立；原文件长度超过该cap在fetch前拒绝。响应必须200、image/png、无Location/encoding、精确长度/hash/time/id、safe UUID attachment、no-store/nosniff、Content-Digest和requestId；base64url header中的公开context必须完整精确匹配。先验证头再分配一个有界最终Uint8Array，流式复制和增量SHA，不拼多份图片；极细碎stream周期让出事件循环以保持deadline/cancel可观察。完整长度、摘要、PNG签名/IHDR/尺寸均通过才返回，截断/超量/损坏/坏头不返回部分文件。JSON错误仍走原有严格/脱敏错误合同，不重试。

下载返回对象与context/metadata冻结，bytes明确为新分配的调用方所有Uint8Array，允许调用方修改；不宣称typed array被冻结，不与fetch chunk或Source Buffer共享别名，SDK不保留重试图片。调用方长期保留图片属于其自身内存。取消/超时先结束等待，真实fetch/read/cancel未结算继续占用原容量；坏头后的慢取消也计入。这里不是原始fetch接收前分配或整个进程/浏览器物理内存证明。

20项新Node合同覆盖同步捕获、冻结/字节所有权、严格DTO/header/PNG/hash/时间/版本/身份/记录预算、截图独立cap、单次请求、碎片流、非合作fetch/body/cancel、独立end，以及真实HTTP权限、无账本写入、known unknown历史隔离保留、408/取消实际backend槽和旧文件失效。首轮84/85通过，发现binary header context未知字段被投影忽略，收紧完整schema后85/85。最终134文件1339项双平台零失败：Mac1324通过15跳过，Linux1333通过6跳过。

新Node包仍20成员、无运行时第三方依赖；Python10成员wheel字节保持。61当前服务/合同输入逐hash核对，ws/pngjs仅作为冻结的控制服务/PNG测试依赖复制；双平台全新目录离线152Node/73Python/TypeScript通过，Mac公共2文件与5源码模块Mypy通过，无仓库SDK回退。

真实Native由新安装Node SDK提供所有正常截图、块、释放与PNG下载，既有Python包继续验证DOM/AX/输入，Node包提供Session生命周期。960x640、26685字节PNG的重拼与SDK下载hash/像素一致，SDK内部严格验证关联响应头，下载后PNG消费者实际解码。替换/释放/预算失败保留/旧Run/导航拒绝、人控读/end保留grant与OBSHF、known unknown截图下载不恢复隔离或重放均通过。真实Source回包被可信Provider夹具延迟时，Node SDK收到REQUEST_TIMEOUT/408或CLIENT_ABORTED，实际executor槽仍在，独立end可关闭。最终4closed Run/10injected/2rejected/1unknown、Session无配额、runtime/namespace退役，Node/Python/代理PID退出，Source无宿主发布端口；Linux broker执行副本偏差单列。

第一次Native安装包已完成PNG正常流程，但验证器还延迟旧DOM/AX op，未触发download超时门，实际exit1、3closed Run/9injected/2rejected；保留该失败，不计资格。只修正验证器为read-screenshot后重新冻结并完成上述最终流程，SDK运行代码未因此改变；首次namespace与已知PID均已退役。

Node截图SDK资格只覆盖上述范围，Python截图/下载SDK下一步独立实现与验收。截图是Source视口像素，未声称某个Viewer提交帧；Viewer“WebGL 无法显示”黑框与其他显示保持。K6部分、41项10完成/17部分/14待做；真实页面download/upload/Profile、完整locator/frame/write-by-handle、raw CDP/browser AX物理、K7/K8/K10/K4、unknown Engine Start、N1/设备与原8小时全部目标继续。原8小时增长失败未修复/未重跑，未放宽门槛、强制浏览器GC、改采样器/演示/无关peer，未暂存/提交/推送。

见[证据](evidence/node-screenshot-sdk.json)、[公共截图](public-agent-screenshot.md)和[原始清单](optimization-backlog.md)。
