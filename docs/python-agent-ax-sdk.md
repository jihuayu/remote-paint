# Python computed AX SDK

新增 `client.observations.accessibility(context, AgentAccessibilityInput(element_id, AgentAccessibilityLimits(max_chars=256), rpc_timeout_ms=None))`。入口为同步函数，先校验并复制原context/binding/document/元素/限制/期限，再返回协程；0..512 UTF16字符预算与50..120000私有RPC期限沿用公共AX合同。仅接受精确类型，拒绝dict、带getter子类、非元素ID、bool预算和未知参数；Python取消使用原asyncio Task语义。每次读取固定一次HTTP，即使mutation retries=3也不自动重试、刷新context、重绑元素或重放动作。

公开导出冻结/slotted模型：Input、Limits、States、Projection、Visible/Redacted，以及以redacted Literal布尔区分的Observation联合。redacted:true固定ax=None；visible固定redacted:false并提供computed角色/名字/描述/字符串值与状态。未提供的可选状态模型值为None，线上仍只接受既定布尔及checked/pressed mixed白名单。结果、嵌套binding/document/limits/ax/states全部冻结，无__dict__；Mypy可据redacted分支收窄，不把输入fence当读context。根包类型与py.typed保留。

响应仅200无Location，严格验证逻辑Run/Session/version、原Source tenant/worker/target/controlSession、document、element/budget、stage/scope/time/UUID/revision及投影字段。UTF16文字总长不得超预算，Source6144/公开8192字节独立于传输外层上限；拒绝raw CDP节点、来源、关系或数值未投影value。AX复用现有实际transport Task/body/aclose名额：超时或取消停止调用方等待，真实任务直到结算仍占ordinary，end独立；不改变Source缓存、writer隔离或动作账本。

新增17项Python合同，覆盖同步捕获、精确类型/getter拒绝、冻结/判别、零/最大/emoji预算、关联/元数据/状态/红线字节/HTTP envelope、单次与错误脱敏、非配合Task/body.close/aclose、独立end，以及真实SQLite/HTTP权限、遮蔽、unknown历史隔离保留、stale不隔离writer、408实际executor槽。首轮72/73通过，字节夹具未实际超过6144，修正夹具角色/URL后73/73；验证脚本旧56计数更新为73，SDK运行代码未因此放宽。最终双平台离线新目录均132Node/73Python/TypeScript通过，Mac公共2文件与5源码模块Mypy通过；54当前服务/合同输入逐hash核对，未回退仓库SDK。Node20成员包字节保持，新Python wheel10成员。完整130文件1265项JS双平台零失败：Mac1250通过15跳过，Linux1259通过6跳过。

安装后的Python SDK驱动所有正常Agent输入、DOM和AX请求，Node安装包仅提供Session生命周期，raw HTTP仅用于故意无权限/伪造请求。实际canonical Native验证Shipping address/Confirm delivery/value123/textbox/readonly/required、Place order嵌套名与checked；相同句柄变预算、元素替换/外部label变更拒绝旧句柄、512中文截断、超大AX拒绝、密码遮蔽、导航旧epoch失效。人控时读可用写暂停，读/end保留原grant，页面值OBSHF。已执行一次但回执unknown的输入后AX读到Unknown action observed，历史unknown和writer隔离保持，同key不重放、新写拒绝。Python收到408或CLIENT_CANCELLED后实际executor名额仍在，独立end结束；4closed Run/10injected/2rejected/1unknown，Session无配额、runtime/namespace退役，Python/Node/代理实际PID退出。Source无宿主发布端口；执行副本Linux broker偏差单列，不覆盖仓库或Chromium缓存。

Node/Python computed AX SDK在上述范围均已验证，K6仍部分。截图/下载、完整locator/frame/write-by-handle、业务后置条件、raw CDP接收前分配及浏览器AX物理内存仍待做；32KiB raw AX检查位于Playwright解码之后。41项仍10完成/17部分/14待做，K7/K8/K10/K4、unknown Engine Start、N1/物理/设备和原8小时全部目标保留。原8小时增长失败未修复/未重跑，未放宽门槛、强制浏览器GC、改采样器/演示/无关peer，未暂存/提交/推送。WebGL保持“WebGL 无法显示”黑框，其他内容正常显示。

见[证据](evidence/python-agent-ax-sdk.json)、[Node对等范围](node-agent-ax-sdk.md)、[公共接口](public-agent-ax.md)及[原始清单](optimization-backlog.md)。
