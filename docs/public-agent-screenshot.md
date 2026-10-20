# 公共截图与 PNG 下载

新增4个POST端点：`/v1/agent-runs/{agentRunId}/screenshot-observations` 请求context/limits?/rpcTimeoutMs?；`screenshot-chunks` 请求context/screenshotId/offset/maxBytes?/rpcTimeoutMs?；`screenshot-releases` 请求context/screenshotId/rpcTimeoutMs?；`screenshot-downloads` 请求context/screenshotId/sha256/byteLength/observedAt/rpcTimeoutMs?。均独立使用agents:observe，严格普通自有数据、逻辑Run/Session/tenant/Registry/原worker/target/controlSession/version/document绑定，无读幂等键、Location、写fence、路径或脚本。前三者200且返回逻辑ID与严格Source DTO，Source6144/公开8192记录及原8KiB Worker帧保持。

下载必须显式给出原文件ID/hash/字节长度/时间与同一读context。最多4MiB、PNG，整次下载共用一个实际executor ordinary名额，包含每个顺序3072字节私有RPC和可信sink的真正异步写入；不在服务器拼整图。每次读取前后核对Ready/Run/版本与原document/file，禁止替换截图、输入、DOM或AX插进同一Run下载；end仍独立。最初块核对文件元数据、PNG签名/IHDR与尺寸后才发二进制头；增量SHA在最后一块写出前比较，损坏时扣住最后一块并中断连接，避免生成完整的错误Content-Length文件。Source PNG块名也改用保留高位的latin1检查，新增有效CRC但高位伪装IHDR拒绝用例。

下载响应为image/png、准确Content-Length、固定UUID文件名attachment、Content-Digest sha-256、no-store/nosniff/requestId、screenshot ID/hash/time。原公开context用base64url JSON响应头关联，避免把任意版本字符串直接写进HTTP头；没有裸源地址、API key或CDP对象。Range/If-Range不接受。每个HTTP写Buffer最多3072，等待实际write回调；HTTP容量到finish/close才归还。超时/断开停止调用方等待并关闭已开始响应，实际Source或非配合sink未结算时backend槽仍持有；不向Source传播调用方signal、不恢复writer隔离、不改动作历史。已经写出的字节不能因取消收回，后续读取/写入在取消或end后停止。

28项新公共合同加1项PNG严格性合同，相关67项通过。覆盖权限、外租户、逻辑/Source/context伪造、字节/偏移/版本/时间/hash/PNG坏回包、不可恢复旧owner、known unknown输入、单次读取、原账本不写像素或文件ID、取消/非配合Source/sink、end独立、头前408与头后截断。真实TCP暂停消费者时，EOF前Source块请求停止增长至少75ms、普通HTTP容量保持，独立end可结束传输；错误最后块使HTTP body无法完整读取。首轮65/67通过，两处夹具把普通headers对象当成Fetch Headers，修正后67/67，运行时规则未放宽。

完整133文件1319项双平台零失败：Mac1304通过15跳过、Linux1313通过6跳过。全部SDK源码、类型与Node20/Python10包字节保持；57当前服务/合同输入逐hash核对，新目录双平台离线132Node/73Python/TypeScript及Mac公共2文件/5源码Mypy通过。新截图API并未冒充截图SDK资格。

真实canonical Native所有正常截图/块/release通过公开HTTP→DurableExecutor→私有Provider/Worker/Source。960x640、26685字节PNG重新拼块后hash和像素[17,83,151,255]一致；另经真正二进制下载，长度/hash/Content-Digest/context/requestId/no-store等响应头及PNG解码通过。1字节预算失败保留旧文件，替换/释放/新Run/导航旧document拒绝旧ID；人控仍可读且读/end保留原grant和OBSHF。实际执行但回执unknown的动作后公开截图和下载可用，原历史仍unknown、writer隔离、同key不重放、新写拒绝。既有AX/DOM/输入依旧经安装Python SDK，Session用Node包。4closed Run/10injected/2rejected/1unknown、Session无配额、runtime/namespace退役，Node/Python/代理退出，Source无宿主发布端口；执行副本Linux broker偏差继续单列。

这里观察Source浏览器视口像素，未声称某个Viewer提交帧；Viewer“WebGL 无法显示”黑框及其他显示保持。4MiB只约束文件与候选的明确范围，CDP字符串已经由Playwright接收/解码，浏览器/网络/物理内存和raw接收前分配未验收。下一步各自独立Node/Python截图与下载SDK；真实页面download/upload/Profile、完整locator/frame/write-by-handle、K7/K8/K10/K4、unknown Engine Start、N1/物理/设备与原8小时继续。K6仍部分，41项10完成/17部分/14待做；原8小时增长失败未修复/未重跑，未放宽门槛、强制浏览器GC、改采样器/演示/无关peer，未暂存/提交/推送。

见[证据](evidence/public-agent-screenshot.json)、[Source文件范围](agent-screenshot-core.md)及[原始清单](optimization-backlog.md)。
