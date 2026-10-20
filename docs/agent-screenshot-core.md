# Source 截图文件与私有分块读取

受管Run新增 screenshot(context,limits)、readScreenshot(id,offset,context,maxBytes)、releaseScreenshot(id,context)，均独立使用agent:observe权限；输入不允许任意format、fullPage、clip、路径、selector或脚本。原Page/capture/CDP发送函数、Native隔离world/document token、tenant/Session/target/workerRun及document的controlSession/pageEpoch/viewportVersion在异步前后校验。固定Page.captureScreenshot的PNG、fromSurface:true、captureBeyondViewport:false、optimizeForSpeed:false，viewport最大2048边/4Mi像素，DPR1。截图观察的是Source浏览器视口像素，未声称是某个Remote Paint Viewer提交帧；Viewer的WebGL黑框文字占位保持。

默认PNG预算1MiB，调用方可收紧或放大至4MiB。Playwright返回字符串后先检查编码长度、base64语法和解码长度，再创建有界Buffer；检查PNG签名、IHDR尺寸/常规头字段、块长度/CRC/最多2048块、IDAT/IEND和无尾随字节，不在Source解码像素。这里明确仍在Playwright接收/JSON解码之后，不能当作raw CDP接收前分配或浏览器/截图临时物理内存预算通过。

一个Run最多保留一份成功文件；后续截图成功后替换原文件，失败保留原文件，最大保留4MiB。捕获期间另有一个有界候选Buffer及已解码CDP字符串，不能把4MiB说成总进程峰值。成功返回opaque shot UUID、obs UUID、按截图递增revision、observedAt/version/原binding/document、source-pixels scope、URL/title截断标志、mimeType/尺寸/实际字节/sha256及请求预算；不在控制帧塞整张图、不写Source文件系统或动作账本。

读取带原context、shot ID、offset和每次最多3072字节；返回固定原文件hash/time/version/context、偏移、实际长度/总长、base64和complete。EOF允许0字节完整结果，越过EOF拒绝；严格请求/回包关联和6144字节记录上限，原8192 Worker帧/32768 pending输出保持。内部Buffer不交给调用方，返回有界字符串，不暴露可变别名。新截图替换、显式release、Run结束后旧ID拒绝；新document不能借旧ID读取其他目标。释放仅作用于当前原文件；owner close清除引用，不把逻辑清理等同为RSS立即归零。

截图/分块/release与DOM/AX共享Source实际pending名额；任务包括Native元数据身份检查、实际CDP等待、PNG检查、最终身份复核和文件记录提交。外层超时/取消不提前释放真实worker槽，end使用独立通道并等待Source真实工作；close后晚到结果拒绝并清理截图。读取不改写fence、不恢复writer隔离、不重放未知动作；人控期间可读，结束保留原人工grant。独立agent-screenshot-v1私有能力必须与agent-rpc-v1/agent-observe-v1协商，旧worker或小接收帧在派发前拒绝；Source/通道/provider验证原版本和结果关联。

新增25项合同，相关60项通过。首轮58项有一处新夹具残留AX stage预期，修正为screenshot-observed并补上块/release/最大帧合同后通过；完整回归首轮1290项有一项旧受管Run精确方法清单未包含三个新增方法，按新显式接口补齐后132文件双平台1290项零失败：Mac1275通过15跳过，Linux1284通过6跳过。未放宽任意CDP方法拒绝。离线55当前服务/合同输入逐hash核对，132Node/73Python/TypeScript双平台通过，Mac公共2文件和5源码Mypy通过；Node包20成员字节保持、Python10成员仅README删去过时AX待做描述，SDK运行代码和类型均未改变。

真实标准Native通过可信私有Provider→Worker→原Source执行截图，而既有Agent输入/DOM/AX仍使用安装后的Python SDK、Session使用Node包。960x640 PNG实际26685字节，重新拼装所有<=3072字节块后长度/hash一致，PNG消费者真实解码并核对页面色块[17,83,151,255]；1字节预算拒绝并保留上一文件，新截图使旧ID失效，显式release后不能读。新Run/导航旧document拒绝旧截图，人控可读且原grant和OBSHF保持；已知unknown输入后截图可读但动作历史和writer隔离不变，同key不重放。重开账本4closed Run/10injected/2rejected/1unknown，Session无配额、runtime和namespace退役，Node/Python/代理PID退出，Source无宿主发布端口；执行副本Linux broker偏差单列。

本检查点只确立私有Source截图及文件读取合同，公开截图executor/HTTP、文件下载响应与Node/Python截图SDK下一步单独完成；真实页面download/upload/Profile、完整locator/frame/write-by-handle仍待做。K6部分、41项10完成/17部分/14待做，保留K7/K8/K10/K4、unknown Engine Start、N1/物理/设备及原8小时全部目标。原8小时增长失败未修复/未重跑，未放宽门槛、强制浏览器GC、改采样器/演示/无关peer，未暂存/提交/推送。

见[证据](evidence/agent-screenshot-core.json)、[Python AX范围](python-agent-ax-sdk.md)及[原始清单](optimization-backlog.md)。
