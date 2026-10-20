# Node 原页面下载 SDK

本检查点在Node后端AgentClient的observations增加armDownload、downloadInfo、downloadChunk、releaseDownload、downloadFile。调用使用完整原公开观察context；同Run只保留一个ticket，release后才可重新arm。arm捕获原Page显式窗口的下一次download事件，仍不承诺与某次输入的因果关联。Python实际页面下载SDK在下一检查点继续。

新增agent-download.mjs独立模块和AgentDownloadId/limits/输入、armed/pending/ready/chunk/released/file等类型，root/backend/agent入口均可取类型。info用stage区分pending和ready，pending不暴露byteLength；所有元数据readonly并运行时深冻结。五个入口均在返回Promise前同步捕获严格own-data的context、原ticket、limits/offset/hash/size/completedAt和rpcTimeoutMs，不接受URL、路径、selector/CDP/write fence、getter及额外字段。每次固定一次HTTP，配置的mutation retries不会触发读重试，不自动重arm、刷新context或重放输入。

JSON严格验证原logicalRun/管理Session/version/tenant/target/workerRun/controlSession/文档、phase/scope、原ticket、限制、规范ISO时间、安全显示名、generic binary、字节数和SHA。Source6KiB、公开8KiB和外层JSON接收预算分别执行。分块最多3072字节，base64必须规范，offset/大小/complete精确关联，空文件/EOF有效且空摘要必须正确。

maxDownloadBytes默认1MiB，允许1..4MiB，独立于maxResponseBytes和maxScreenshotBytes；零字节文件仍能使用正数cap，超cap的文件引用在HTTP前同步拒绝。二进制复用共享transport的实际fetch/body/cancel集合和独立end池，严格验证200/noLocation/noEncoding、application/octet-stream、精确长度/摘要、safe dl_UUID.bin附件、no-store/nosniff、requestId、原ticket/hash/completedAt和规范base64url完整context；拒绝额外或变更的header context字段。空stream或无body的零文件都支持。

响应头通过后分配一个精确有界Uint8Array，边读边复制并增量SHA，每128个片段让出事件循环；完整长度/摘要通过才返回download-delivered。元数据冻结，bytes明确是新建、可变、由调用者拥有的数组，不与网络/Source缓冲别名，不返回部分数据。空文件不借用PNG格式或最小长度假设。该缓冲cap不表示原始网络接收前分配或浏览器/进程总物理内存上限。

客户端timeout/abort仅结束等待；真实fetch/body/cancel未结算仍计入普通容量，end独立。坏头之后的非配合cancel同样保留真实占用。结构化HTTP错误与requestId/outcome保持，错误文本脱敏；私有RPC观察期限仍50..120000，HTTP本地期限50..60000。无法因deadline推断页面输入未发生。

最终新增23项合同通过，包括同步捕获/模式/类型/冻结/新数组无别名、独立caps、规范JSON/响应头/摘要/截断/超长/空/1字节、细碎流、单次发送、非配合fetch/body/cancel与独立end，以及真实SQLite/HTTP观察权限、unknown历史不变、408/取消后端真实槽、旧ticket失效。首轮22项有1个fixture错误：把已有Response再次包成JSON，严格parser正确拒绝；修正后22项通过，再加Source字节预算合同形成最终23项。失败日志保留。

新Node包21成员，68个当前服务/合同输入逐hash核对，双平台新目录离线175Node/95Python/TypeScript通过，Mac公共和源码Mypy通过。Python源码与10成员wheel字节保持。完整138文件1421项JS双平台零失败：Mac1406通过15平台跳过，Linux1415通过6跳过。

真实新安装Node SDK首轮Native通过：五个下载正向操作均使用该21文件安装包，完成原cookie网络8999字节且一次请求、Blob5001字节、空文件、规范块和binary身份/完整摘要；释放/旧Run/导航拒绝。实际人控点击的下载read/release/end保留held key及原grant；真实已发生一次的未知输入之后下载可读，历史/隔离不变，同key不重放、新输入拒绝。实际Native主线程各阻塞1秒时安装SDK收到HTTP408/REQUEST_TIMEOUT或CLIENT_ABORTED，后端实际槽仍在、独立end202，晚结果不采用closed Run。RawHTTP仅既有生命周期/context/输入和故意的负向wire检查，不是新下载SDK替代。

6个逻辑Run全部closed、8injected/1unknown/0rejected，Session关闭不占quota，重开账本及独立namespace退休证据通过，Node runner退出。Linux broker只在执行副本沿用既定构建并单列hash偏差，未覆盖仓库或缓存。

Node页面下载SDK在上述范围内验收；Python页面下载SDK、Chromium写盘前预算/partial spool退休和Playwright保留Download元数据物理预算继续。K6仍部分、41项保持10范围内完成/17部分/14待做。完整定位/frame/按句柄写、上传/Profile、K7/K8/K4、unknown Engine Start、N1/设备及原8小时增长失败继续。WebGL“WebGL 无法显示”黑框和其他显示保持；未重跑8小时、放宽门槛、强制浏览器GC、修改采样器/演示/无关peer，未暂存、提交或推送。

见[证据](evidence/node-page-download-sdk.json)、[公开下载协议](public-agent-download.md)及[进度](optimization-progress.md)。
