# Python Agent SDK 独立检查点

Python3.11+后端新增AgentClient、Run/context/Invocation/end、20项新测试、七工具判别TypedDict、独立Run/Invocation NewType及冻结的结果模型。参数使用snake_case，序列化为现有公共HTTP字段；字符串限制和composition selection使用UTF-16单位。准备好的请求固定原始body/key/context/fence及首次返回操作ID/created_at，不刷新fence、不自动重放unknown，也不把input-injected原语收据当作业务完成。与Node同样提供独立read/write/end权限语义；管理key不进入Viewer。

共享Python传输层保持原17项Session合同。实际send/read/close任务在本地超时或Task取消后仍占名额，协作取消清理最多额外等待10ms；忽略取消的任务不会因本地等待结束而丢失计数。end独立名额及独立HTTPX连接池；真实16条普通连接满载时仍可结束。关闭single-flight，本地1秒后CLIENT_CLOSE_PENDING，真实关闭继续且新请求拒绝；调用方可再次await aclose。错误与取消保持固定脱敏字段及asyncio取消语义。单次send显式重试序列中，后续拒绝不能抹去前序unknown。

当前wheel双平台独立离线安装97Node/37Python/TSC零失败，Mac公共正负类型用例及安装包四源码严格Mypy通过。41个消费者/服务输入逐一同hash，没有SDK源码回退。原Node运行时代码/声明逐字节未改，仅README说明Python入口。全量JS在v4执行120文件1139项，Mac1124通过15平台跳过、Linux1133通过6跳过；最终v6仅Python测试清理、负类型注释和验证器Mypy调用修正，全部.mjs/.json及依赖逐字节相同，因此明确继承该次全量。

安装版Python SDK由独立进程加载venv中的wheel，通过测试专用line-RPC驱动公共HTTP→持久执行器→标准Native私有RPC→SourceControl/真实Page；line-RPC不直接发Agent HTTP，也不使用Node AgentClient。七工具、无人观看80px滚动、旧fence拒绝、prepare后修改输入仍注入原L、实际丢HTTP响应后同ID/一次页面效果、50ms RPC观察超时unknown且不重放、独立end、人工原grant跨Agent end保留、B拼LHFZ通过。Node安装版SDK仅负责该fixture的Session生命周期，之前Node Agent Native证明按未改代码范围继承。继续验证Viewer只读/票据tenant/audience/刷新/撤销/到期矩阵。关库/reopen确认3逻辑Run closed、13injected/2rejected/1unknown、Session closed不占配额、runtime/namespace退役文件hash一致；Source无宿主发布端口，已知Node/Python/代理进程退出。

保留失败链：初轮协作流关闭时机回归、一次错误构造器编辑错误、安装版负类型用例注释不匹配、Linux测试驱动stdin未关闭、Mac源码类型检查site-packages路径冲突。最终修复后重新离线安装通过；失败不包装成成功或删除记录。

publicNodeAgentSdkQualified/publicPythonAgentSdkQualified/publicAgentSdkQualified现在仅在上述七工具公共SDK范围为true。K1/K5/K7/K9仍部分；K6 DOM/AX/元素定位/截图/文本/下载及旧句柄隔离、业务后置条件和失败分类、Playwright/文件/Profile、事件游标/取消/Webhook、unknown Engine Start、N1/物理/设备/原8小时增长仍未完成。41项仍10完成、16部分、15待做；allAgentCdpFenced/productionNativeFullyQualified/eightHourPassed均false。WebGL“WebGL 无法显示”黑框与其他显示源码不变。未暂存、提交、推送、修改演示、强制浏览器GC、放宽门槛或重启8小时。

见[证据](evidence/python-agent-sdk.json)。
