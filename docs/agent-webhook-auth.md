# Webhook 原始字节签名合同

K8c3a 先实现私有后端 `createAgentWebhookAuthenticator`。它是完整Webhook工作的第一个独立检查点；持久订阅/outbox、实际HTTPS投递/重试、接收方持久去重、管理API/SDK和原Native端到端仍待实现，不能仅凭签名核心宣称Webhook完成。

配置固定端点`awh_UUID`、activeKeyId和最多两个 `{keyId, secret}`。secret必须是32..64字节的本地Uint8Array/Buffer，立即复制；配置/数组/请求拒绝accessor、Proxy、额外字段，原调用方后续改动不改变已经捕获的端点、key或正文。共享backing、错误类型、空正文和超过预算的正文拒绝。正文默认及硬上限4096字节，可配置1..4096；元数据严格ASCII且有界。

签名采用Node HMAC-SHA256，MAC32字节比较使用`timingSafeEqual`，不声称整个验证流程常数时间。见[Node crypto合同](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptotimingsafeequala-b)。下列UTF8前缀之后直接追加原始正文，不解析/重新序列化JSON：

```text
remote-paint-webhook-v1\n
<endpointId>\n
<keyId>\n
<canonical timestamp seconds>\n
<original aevt_UUID>\n
<raw body bytes>
```

各元数据字段本身不能含换行。端点与keyId都进入MAC，因此共享secret时也不能将旧签名换到另一个端点或换key标签。包返回冻结headers和调用方独占的body副本：`content-type: application/json`、`remote-paint-event-id: aevt_UUID`、`remote-paint-signature: t=<seconds>,kid=<keyId>,v1=<64 lowercase hex>`。重复字段、空白、非规范整数、错误版本和合并的重复HTTP头拒绝。

`verify({eventId, signature, body})` 在配置端点下验证MAC，返回冻结端点/原事件ID/key/time元数据与另一个独占body副本。默认时间窗口过去300秒、未来30秒，分别可配置1..3600和0..60，边界包含；近MAX_SAFE_INTEGER使用相减，避免加法溢出。同步可信时钟每操作只读一次；非法时钟不强制转换或回落默认值。async/generator时钟配置拒绝；普通同步wrapper错误返回native Promise时观察其拒绝并返回脱敏错误，不产生未处理拒绝。

签名认证的是原字节和声称的事件ID，**不验证正文是JSON或合法AgentEvent，也不核对body内ID和HTTP头ID**。持久事件生产者下一步须复用既有journal验证结果，编码固定envelope，并绑定同一原eventId；接收方必须先有界读取原字节、验签，再验证严格DTO及其中ID关系。尚未授权、不可信或过期的HTTP连接不能因为MAC工具可用而绕过租户/端点权限。

重复请求在时间窗口内仍可通过MAC，原ID保持；时间窗口不替代持久去重。接收方后续应持久维护可信端点/租户下`eventId`的接收与处理状态，在持久接收/去重后确认投递；外部副作用仍需处理事务、幂等下游或unknown对账，不能仅凭去重插入、HTTP2xx或签名通过宣布业务完成、回滚或Source退役。本核心没有去重表或投递队列。

`close()`幂等地栅栏后续sign/verify，清空并置零自己捕获的key字节；不改调用方key，不宣称V8/crypto已物理清零所有历史临时内存。错误只含稳定code和固定消息，不附原正文/secret/clock异常。此处没有网络投递、后台重试或Source额度改变。

20项新增合同覆盖独立Python HMAC/UTF8 golden vector、端点/原ID/key/time/raw bytes绑定、轮换、时间边界、跨MAX_SAFE_INTEGER、ByteLength shadow accessor、SAB/Proxy/配置拒绝、close和实际loopback HTTP原字节/重复header。HTTP夹具仅测试认证，重复请求照常返回原ID，未冒充持久去重或生产HTTPS投递。

初步20项通过。审查额外复现错误clock wrapper返回rejected Promise会产生未处理拒绝，旧源码与实际探针保留，修复后回归20项通过。最终同一输入完整双平台1604项、202Node/194Python隔离安装及类型资格仍待执行。SDK字节保持父资格版本；41项保持10/18/13、K8仍部分、原八小时失败保持，不自动重跑。
