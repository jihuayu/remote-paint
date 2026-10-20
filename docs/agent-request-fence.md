# 显式 Agent 输入请求的版本栅栏

新增Source内部接口ControlLease.agentFence()，只在Agent模式且页面不处于切换时返回冻结、可JSON传输的四字段：controlSessionId、controlVersion、pageEpoch、viewportVersion。controlSessionId是此Source控制器实例的UUID，不是管理API的Session ID。controlVersion在人工接管、释放或失效时前进，后两项绑定当前文档与viewport。

调用agent(event,{fence})要求选项恰有一个fence，fence恰有上述四个自有data字段；拒绝未知/继承/访问器/Symbol字段及错误类型/范围，不调用getter或toString。入队前复制冻结这个版本戳并比对当前控制器、控制版本、页面、viewport和切换状态；旧请求返回STALE_AGENT_FENCE，先于读取输入或发送CDP。排队执行时继续复查，保留先前STALE_AGENT_PAGE与AGENT_PAUSED的队列语义。调用方后续修改原版本对象不会改变已准入请求的快照。

```js
const fence = source.control.agentFence();
// 保留原动作对应的版本；不要在重试时默默换成当前版本。
await source.control.agent({kind: 'text', text: 'example'}, {fence});
```

该戳不是认证凭据、许可令牌或幂等键。服务仍须独立绑定租户、管理Session、target和Agent run，并验证写权限。受信任的本地agent(event)兼容入口保留，不带选项；显式给空选项或缺fence会拒绝，不能由受管外部工具悄悄降级到兼容入口。本项没有新增公共WebSocket命令，也没有把ControlLease/CDP对象交给浏览器页面。网络中的重复请求、业务幂等和结果未知分类仍需工具与服务层完成。

7项新合同在之前实现实际1（6失败1通过；包括新接口尚不存在的预期失败），之后实际0、7通过。覆盖人工接管再释放但页面/viewport未变的旧请求、跨控制器/文档/viewport拒绝、JSON数据与冻结、getter和输入读取边界、原对象后续修改及排队接管、切换/人工/关闭时不发戳、旧受信任入口兼容。不能把全部6个预期失败都称为已有公共API的漏洞。

同一个真实Linux Native Source脚本做因果验收。旧实现没有显式请求约束，人工输入H并释放后，带原controlVersion0的迟到调用仍注入LATE，独立页面HTTP报告A→AH→AHLATE，根实际1。新实现拒绝该旧戳，当前戳输入F得到AHF；实际Source resize后拒绝旧viewport戳，当前戳输入V得到AHFV；实际导航到新文档后拒绝旧页面戳，当前戳输入N得到新文档N。三条旧动作均在CDP之前返回STALE_AGENT_FENCE，没有发送LATE/R/OLD。页面自己的ready/focus/input HTTP报告独立确认真实效果，根实际0。导航/resize是测试控制器设置夹具状态，不能冒充已完成受管Playwright接口。

两个Source容器分别以1/0终止，无OOM、PID0；有效Linux根见证及各自已知browser/broker的PID+start身份退出核对通过，Source、浏览器、broker和HTTP fixture全部关闭。4个已知Mac测试/CLI进程均ESRCH。双平台109文件完整962项重新通过：Mac947通过15跳过，Linux956通过6跳过，失败/取消0，Linux完整回归容器0退出。SDK源码及包合同输入未变，按精确字节继承先前双平台78 Node/17 Python、严格TSC和Mac Mypy，没有新打包/安装或本项新Viewer像素运行的宣称；显示相关源码及指定WebGL黑框文字保持。

下一步是强制使用该版本戳、捕获动作参数的受限工具facade，再接入有权限约束的Native worker/服务/SDK。只有本地Core入口完成，显式远端请求/全部Playwright/CDP路径仍未验收，K5保持部分完成。未知启动见证隔离、N1/物理时延、更多设备与原8小时增长继续待完成；41项9/15/17、原8小时失败/192MiB门槛保持，未强制浏览器GC、自动重跑8小时、修改公共演示或暂存提交推送。最终967文件；见[范围收据](evidence/agent-request-fence.json)。
