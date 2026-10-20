# 原页面下载私有 RPC

本检查点把原Page下载核心接入原管理Session的Docker Provider、Worker和NativeSessionResource，增加 arm-download、download-info、read-download、release-download。现有公开Agent HTTP、Durable Executor和SDK没有新增下载操作。浏览器真实文件仍由原Page的显式下一事件窗口接收，未改成URL重抓取，也不承诺某个输入与下载事件的因果关联。

请求同步捕获严格own-data的op/run/context/limits/ticket/offset，拒绝URL、路径、CDP对象、写fence、额外字段、getter及错误Run。arm返回新dl_句柄，info只允许pending/ready，read为小块，release仅原句柄。新结果验证器也在Source返回处执行，严格检查原tenant/管理Session/target/workerRun、Native文档、version、ticket、scope、ISO时间、限制、安全显示文件名、generic binary类型、字节数与SHA256。空文件和EOF有效，零字节摘要必须正确；块最多3072字节、base64必须规范且偏移/完整标志精确，JSON最多6144字节。

独立能力agent-download-v1依赖agent-observe-v1及agent-rpc-v1，Ready能力上限从4变5；旧Worker、缺依赖、重复/未知能力或小于8KiB的接收通道在写请求前拒绝。Worker也对认证后的原始调用检查下载能力，不能只依赖Channel。Worker在初始化保存真实版本，在输出任何成功观察结果前验证版本；Channel再以Ready版本、请求期望和固定租户/Session独立核验，Provider在异步调用前后重查原allocation并再次验证。帧8KiB、Source结果6KiB、待写总量32KiB均保持。

Native资源持有原Run和页面时钟；等待下载票据独立于一次普通读取，允许后续点击或轮询。实际RPC已发送后的deadline/abort仍为unknown，普通槽保留到真实关联回复，end使用独立槽。没有超时后自动重arm、换页、刷新上下文、重放输入或恢复未知写历史。结束与释放继续等待Source的真实浏览器取消、文件和对象组清理。

14项新合同首轮通过，邻近59项回归通过；最终136文件1372项JS双平台零失败：Mac1357通过15平台跳过、Linux1366通过6跳过。初始未冻结代码的一次通道private-field替换语法错误已修复，诊断日志保留；该次shell包装未保存子进程退出码，不作为通过证据。后续所有资格运行显式保存真实退出码。

真实DockerProvider→Worker→canonical Native 首轮通过：原cookie网络8999字节只请求一次、Blob5001字节、空文件、超限释放、旧文档和旧Run句柄拒绝、跨tenant/Session/version拒绝、慢下载end关闭实际连接。公开Viewer取得真实FrameCommit和人控grant后点击下载，私有读取/release/end保留原held key和grant，随后同grant keyup才触发页面事件。页面主线程各阻塞1秒时，Native文档读取确实超时或取消，私有普通槽仍busy，独立end完成后真实工作结算；这是夹具阻塞，不是物理时延/丢包证明。Session关闭不占quota，重开Runtime账本为retired，独立namespace退休证据为container-removed，原路由拒绝继续调用。

SDK28个源码路径和依赖保持，已安装Node包20文件逐hash相符，只用于既有Session生命周期；未重跑整套SDK安装测试，未宣称实际页面下载SDK完成。Linux broker仅执行副本沿用既定构建并单列hash偏差。

完成文件保留最多4MiB仍不是Chromium写盘前硬上限；partial spool取消后的独立退休证据及Playwright BrowserContext保留Download元数据的物理预算仍待做。下一步是带原逻辑Run/Session/worker/version/document/ticket关联、观察权限及真实背压/取消/end生命周期的公开HTTP，再分开实现Node/Python SDK并各自产出审阅包。

K6仍部分、41项保持10范围内完成/17部分/14待做。WebGL“WebGL 无法显示”黑框及其他显示保持。其余定位/frame/按句柄写、上传/Profile、K7/K8/K4、unknown Engine Start、N1/设备及原8小时增长失败继续；未重跑8小时、放宽门槛、强制浏览器GC、修改采样器/演示/无关peer，未暂存、提交或推送。

见[证据](evidence/agent-download-rpc.json)、[Source下载核心](agent-download-core.md)及[进度](optimization-progress.md)。
