# 原页面下载公开 HTTP 与二进制结果

本检查点把已验收的Source/私有RPC接入同一个Registry和DurableAgentExecutor，公开以下五个agents:observe POST接口，均不要求输入幂等键：

| 路径后缀（/v1/agent-runs/:id/） | 请求 | 返回 |
| --- | --- | --- |
| download-arms | context、可选limits/rpcTimeoutMs | 原Page下一事件窗口的download-armed句柄 |
| download-observations | context、downloadId、可选rpcTimeoutMs | pending或ready元数据 |
| download-chunks | context、downloadId、offset、可选maxBytes/rpcTimeoutMs | 小块base64结果 |
| download-releases | context、downloadId、可选rpcTimeoutMs | 原句柄释放结果 |
| download-files | context、downloadId、sha256、byteLength、completedAt、可选rpcTimeoutMs | 原文件二进制 |

JSON结果200、无Location、no-store，严格增加原逻辑Agent Run与管理Session关联。context必须完整匹配原logicalRun/Session/version/tenant/target/workerRun/controlSession/Native文档；不接收URL、路径、选择器、脚本、写fence或额外数据。Source结果6KiB和公开8KiB分别验证，底层块最多3072字节且base64规范；空文件有效。read/write/end/session旧权限均不隐含observe，observe不能提交输入、结束Run、释放Session或授予Viewer；跨租户路由在Source调用前拒绝。Source陈旧句柄/窗口忙/超限/失败/超时/取消有固定脱敏HTTP分类。

arm、info、chunk、release复用实际read admission，开始前、Provider异步返回后和公开结果包装处均核对原归属。可观察同一owner已确认binding的recovery-required Run，不能升级unknown输入历史、解除隔离或重放；未知begin、冷启动旧owner、ending/closed/非Ready不可接管。文件内容、摘要与名字不写输入intent/SQLite历史。arm是一次有界Source资源操作；HTTP超时可能失去新ticket回执，不自动重arm，仍以原Source窗口超时或显式end结束资源。

二进制固定application/octet-stream及dl_UUID.bin附件名，使用精确Content-Length、Content-Digest、no-store/nosniff、requestId、原ticket/hash/completedAt及base64url完整公开context响应头；文件显示名不进入附件头。拒绝Range/If-Range。每次只获取一个私有块、完成真实异步write后才请求下一块，无服务端整文件拼接。增量摘要在最后一块写出前验证；首块也是末块时验证失败不发送二进制头，后续摘要失败扣住最后一块并关闭连接，正文不能完整成功。零文件也先通过Source原句柄与空摘要验证。

普通执行器容量覆盖整个分块及可信sink实际工作，HTTP容量等待finish/close；end使用独立容量。HTTP deadline/断连只终止观察，不向Source转发取消信号，真实Provider/sink工作未结算仍计入，晚到结果不能采用已关闭Run。rpcTimeoutMs保持50..120000的私有回包观察语义；若私有观察期结束，其Channel仍持有未结算的Source槽，不宣称撤回页面效果。这里没有原始接收前分配或浏览器物理预算资格。

26项新合同首轮通过，覆盖严格身份/权限/模式/脱敏、真实临时文件与空/1字节文件、摘要篡改、SQLite不变、unknown/cold-owner、非配合Source/sink、deadline/disconnect及实际TCP消费者暂停。4MiB响应的Source块请求在EOF前连续至少75ms停止，普通HTTP容量仍被占用、独立end通过。最终137文件1398项JS双平台零失败：Mac1383通过15平台跳过、Linux1392通过6跳过。

离线SDK映射补齐新下载模块：66个当前输入逐hash验证，双平台新目录安装152Node/95Python/TypeScript通过，Mac公共与源码Mypy通过。SDK28个源码和依赖、20成员Node包与10成员Python wheel字节保持；这是既有SDK兼容性资格，实际页面下载Node/Python SDK仍待实现。

真实HTTP→DurableExecutor→DockerProvider→Worker→canonical Native首轮通过：原cookie网络8999字节且只请求一次，Blob5001字节、空文件、超限413、块与binary摘要/完整关联头、旧文档与旧Run拒绝、慢下载end关闭真实连接。公开Viewer真实FrameCommit/grant的人控点击下载及read/release/end保留held key与原grant；已实际发生一次的未知输入之后可读取下载，历史与隔离保持，同key不重放、新输入拒绝。实际Native主线程各阻塞1秒期间HTTP408/断连，后端实际槽仍在，独立end202，晚结果不采用closed Run。这是夹具阻塞而非物理网络/N1证明。6个逻辑Run全部closed，8injected/1unknown/0rejected；Session关闭不占quota，重开账本及独立namespace证据均退休。

完成文件保留最多4MiB仍不是Chromium写盘前硬上限；取消partial spool独立退休与Playwright保留Download元数据的物理预算继续。Linux broker只在执行副本沿用既定构建并逐hash列出偏差，未覆盖仓库或缓存。

下一步分别实现Node、Python实际页面下载SDK并各自安装/真实Native验收/审阅ZIP；K6仍部分、41项保持10范围内完成/17部分/14待做。完整定位/frame/按句柄写、上传/Profile、K7/K8/K4、unknown Engine Start、N1/设备及原8小时增长失败继续。WebGL“WebGL 无法显示”黑框及其他显示保持；未重跑8小时、放宽门槛、强制浏览器GC、修改采样器/演示/无关peer，未暂存、提交或推送。

见[证据](evidence/public-agent-download.json)、[私有RPC](agent-download-rpc.md)及[进度](optimization-progress.md)。
