# 公共后端 Agent HTTP API

`createSessionControlServer({registry,authenticate,agentExecutor,...})` 现在可把 `DurableAgentExecutor` 作为独立授权的后端 Agent API。executor 必须绑定同一个 Registry；未配置时，已授权的 Agent 请求明确503/AGENT_NOT_CONFIGURED。服务仍由调用方绑定TLS/反向代理并管理Registry/执行器关闭，没有在公网部署或公开发布SDK。

| 方法与路径 | 独立权限 | 请求与结果 |
| --- | --- | --- |
| POST /v1/sessions/:ses/agent-runs | agents:write | Idempotency-Key；JSON region/version，可选rpcTimeoutMs；返回Run与Location |
| GET /v1/agent-runs/:arun | agents:read | Run状态，不含内部hash/worker binding |
| GET /v1/agent-runs/:arun/context | agents:read | 显式获取固定run的binding与四字段fence |
| POST /v1/agent-runs/:arun/invocations | agents:write | Idempotency-Key；JSON tool/params/context，可选rpcTimeoutMs；返回Invocation与Location |
| GET /v1/agent-invocations/:ainv | agents:read | 注入/拒绝/未知状态，无原始参数或凭据 |
| POST /v1/agent-runs/:arun/end | agents:end | 空body；内在一次派发标记，同一run结束可查询重试 |

三个Agent scope与Session/Viewer scope分别检查，互不隐含。创建/提交不自动授予读取，读取不能写或结束，结束不自动授予读取；请求返回自身已接收操作的基本状态。Session管理员原有释放整个Session的权限保持。租户仅来自可信 `authenticate({token,signal})`，body中的tenantId等身份、未知字段、原始Page/CDP/JavaScript/Source地址或key均拒绝。跨租户资源与不存在资源同样不可读写。服务只暴露七个既有受管输入工具，perform必须携带原始context/fence，没有自动换成当前版本或降级为无戳输入。

Agent创建/调用先落盘才返回202和相应GET资源的Location；重复键返回同一ID/原状态，改动作、目标或fence冲突409。intent/requested等仍在途状态返回202，injected/rejected/unknown终态重试返回200。Run和Invocation与Session/worker/Page ID分别命名。injected只表示输入注入，不能当作订单、付款、邮件等业务成功；业务后置条件API和完整可恢复分类仍未实现。unknown保持原记录、不自动重放，新动作被隔离，调用方不得仅因超时改新键重复未确认业务操作。

`rpcTimeoutMs` 是私有RPC的观察期限，允许50至120000毫秒，未指定使用执行器默认值；它不是HTTP期限或完整任务取消。相同幂等键改变该观察选项只查询原操作，不产生新动作。Agent body默认32768字节，可配置128至32768；原Session body默认16384字节保持。JSON只接受无压缩UTF-8，ID、body字段、媒体类型和重复敏感header均有限制。响应no-store并带requestId；只输出固定metadata和有界code/outcome，不反射原始错误message、stack或私有capability。

HTTP超时/断线是响应观察者结束，不取消已同步接收的持久创建或输入。GET context也不把HTTP AbortSignal传给私有RPC：只读调用者断开不能借此让正常writer永久进入recovery-required；实际context工作仍占执行器名额到真实RPC结束。普通HTTP请求与实际认证pending默认各64；end各有独立8个名额，不能被普通请求/慢认证占满而失去停止入口。认证请求即使HTTP期限已过，实际resolver尚未结束时继续占认证名额，不通过超时反复增加悬挂调用。

可信认证器每个新请求重新检查，因此实时撤销会阻止后续请求。已经授权并接收的操作保留此次接收的权限；撤销APIkey不撤回已执行副作用，也不暗中取消已接收工作。要停止后续组合步骤需要明确end或Session退役，原私有owner/Ready/人控/每步版本栅栏继续生效。完整任务事件、取消结果、游标/Webhook和所有Playwright/CDP修改路径仍属未完成的K5/K8/K10。

新增24合同，最终双平台119文件1120项零失败/取消：Mac1105通过15平台跳过，Linux1114通过6跳过。真实HTTP/SQLite/Registry/执行器覆盖双向scope隔离、全部跨租户资源、JSON/媒体/ID/header/32KiB限制、同键pending/终态/unknown、丢失创建与动作HTTP响应后同ID/一次效果、只读观察超时/断线、实际认证pending不被超时释放、独立end通道、动态认证撤销、数据库身份故障和部分body期限。先前22个新合同所在64项范围回归实际0；后补两项配置/反向权限合同在最终全量中通过。

标准Native worker的两次实际运行均0：独立read/write/end后端key完成七工具及查询，Session/Viewer权限和跨租户/伪造tenant/任意CDP被拒绝。页面独立HTTP报告B拼、按钮一次、拖动430/130、无人观看滚动80。人为在持久接收后丢弃HTTP响应，重试返回原Invocation，页面只输入一次L。旧controlVersion进入受管Source后记STALE_AGENT_FENCE/rejected。400ms mousedown工作夹具使50ms RPC观察超时，unknown不重放、新动作拒绝、独立HTTP end等待实际收尾，只有一次mousedown且无普通click。已有公开Viewer接管后Agent记AGENT_PAUSED，HTTP end保留原人控grant，归还后最终B拼LHFZ。两个正常账本重开均3个closed run、13 injected/2 rejected/1 unknown，Session closed/quotaFree、原namespace移除、runtime retired与退役文件hash一致，已知控制/代理PID退出；Source无宿主发布端口。

为核验原清单K3，还在同一真实Native页面上验证只读Viewer可接收帧、AcquireControl以1008关闭，controller发票须独立viewers:control；外租户发票/刷新、错误audience与篡改token拒绝。刷新保留原readonly/audience、关闭旧连接并使旧ticket不可重连；显式撤销关闭活连接；1秒ticket到期时Session仍Ready且过期ticket不可重连。Viewer只用短票据/Origin连接，没有管理key。当前全量还验证公开静态资源无私有凭据、模块图闭合；浏览器Viewer SDK图不导入backend/service，后端客户端明确拒绝浏览器运行。这些证据逐项覆盖原K3的公共授权合同，故K3标为该合同范围完成；这不是整个平台安全认证或所有未来Agent工具的授权声明。

现有SDK包字节未改；新后端依赖闭包34个输入双平台独立离线安装，78Node/17Python/TSC及Mac Mypy通过，最终候选34输入逐一同hash。真实Node安装版SDK仍仅用于Session生命周期，Agent通过测试用原始HTTP消费者调用，不冒充公共Agent SDK。上一检查点的Native控制进程死亡关闭式恢复继续按原限定范围继承；本轮executor只添加Registry身份关联，未重跑该死亡专项。下一独立检查点才提供Node/Python Agent SDK及其类型、安装和真实Native合同。

K3按原公共授权合同完成，K7更新为部分实现；41项现在10完成、16部分、15待做。K1/K5/K9仍部分，K6业务观察、完整Playwright/文件集成、任务事件/取消、原未知Engine Start隔离、N1/物理/设备及8小时增长仍待完成。allAgentCdpFenced=false，productionNativeFullyQualified=false，eightHourPassed=false。WebGL“WebGL 无法显示”黑框与其他显示源码保持。未暂存、提交、推送、修改演示、强制浏览器GC、放宽门槛或重启8小时。

见[证据与K3审计](evidence/public-agent-http.json)。
