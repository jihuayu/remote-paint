# 拥有的 Native 端点元数据

本小步新增只读网络检查与纯投影，还没有接入生产 provider 的 Source 解析。inspectNetwork 只接受完整64位 network ID，在同一有限期限内先后核对固定 Unix Engine daemon；保留响应大小、实际请求并发、取消和关闭限制，不重定向、不重试。完整404只在第二次身份检查后返回。

投影要求拥有的 Native worker 规格、fullCID/spec、当前持久 Ready/version、有效启动见证及实际见证文件字节哈希一致；Engine 必须 Running、PID有效、StartedAt匹配，且 Paused/Restarting/Dead/OOMKilled 都明确为 false。网络只能是已有 bridge 配置，完整 sandbox/network/endpoint 标识、容器逐网络地址及独立 network inspect 中的对应成员、IP/前缀/网关/规范子网必须一致。可配置的198.19段通过，弃用的顶层IPAddress不作回退。返回冻结的15个字符串，不保留原网络文档、其他容器、标签或密钥。

网络字段依据[固定 Engine API1.45](https://raw.githubusercontent.com/moby/moby/v26.1.5/api/swagger.yaml)。[OrbStack网络说明](https://docs.orbstack.dev/docker/network)支持Mac直接访问容器IP，但本机开关为true只说明配置：本小步未证明实际容器路由。固定内部Origin为127.0.0.1:4175，流端口4176；地址来自拥有容器的逐网络记录。

新增19合同，相关51项通过。初版16项先失败，补充Engine状态位约束先失败再修复。Unix HTTP服务、代理子进程和fsync见证文件读取是真实执行；Engine和内核记录是明确结构夹具。对已有停止的自有容器只读观察了实际Engine状态字段，不能当作运行中端点或Native验收。

首次106文件/919项完整回归：Linux913通过6平台跳过，Mac903通过1失败15平台跳过。失败是既有attach合同在2010ms、尚未发送Start时出现CHANNEL_INPUT_CLOSED；相关生产模块和该合同当时与900项已通过检查点字节相同，但唯一原因没有证明。原失败完整保留。后续只增加失败时的有限测试诊断，生产代码、断言、期限和并发度未调整。12个新JS路径的串行启动对照均完成、代理实际退出0且已回收；根Node退出收据未捕获，不虚构其退出码。最初对照因Mac Unix socket路径过长在第11例listen失败，其前10例和失败记录分别保留。这些对照不证明原完整负载失败的唯一原因。

补诊断后的同期限完整回归：Mac904通过15平台跳过、Linux913通过6平台跳过，实际均0，无失败取消。单次新通过不意味着原不稳定现象已修复，后续集成仍需关注。SDK、类型、验证器及所有已记录安装合同输入字节未变，继承精确的77 Node/16 Python、双平台严格TSC和Mac Mypy收据，没有伪造新打包或新安装。

下一检查点需要生产provider在每次await后校验当前生命周期，读取实际见证并比对持久绑定，持有并在关闭时清除私有派生密钥；随后验证实际自有容器HTTP/WS路由及真实Native生命周期/健康传播。当前投影不授权调用者、不读取文件、不证明物理健康或连通性。生产Native、全部Agent/CDP栅栏、N1丢包/物理时延和原8小时增长均未完成。41项9/15/17，原失败和192MiB增长门槛不变，未自动重跑8小时、强制浏览器GC、改演示/采样器或暂存提交推送。见[范围收据](evidence/owned-endpoint-metadata.json)。
