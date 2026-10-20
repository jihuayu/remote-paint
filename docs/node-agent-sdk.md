# Node Agent SDK 独立检查点

Node后端新增AgentClient/AgentClientError及/agent导出，完整.d.mts和七工具判别联合。Session/Agent共用内部传输层；默认不重试，显式重试固定body/key，单次send重试序列中的unknown不能被后续拒绝抹去。真实fetch/body取消未结束时继续占普通名额；独立Agent end名额避免普通请求占满后不能发结束请求。配置/请求/响应精确校验、字节上限、重定向/浏览器拒绝与凭据错误脱敏保留。

runs提供prepareCreate/create/get/context/end，invocations提供prepareCreate/create/get。context需要调用方的逻辑Run及预期Session，校验后加SDK本地agentRunId标签，线上body剥离该标签。准备好的请求捕获原始body/key/context/fence；重复send固定返回操作ID与createdAt，不自动刷新fence。注入只报告input-injected原语收据；unknown返回记录，不自动重放或宣称业务完成。请求/响应校验不能代替服务端授权。

19项新合同覆盖不可变重试、拒绝/unknown、schema/阶段/身份/Location/原语收据、取消和不合作fetch/body名额、独立end以及真实HTTP/SQLite丢响应。Mac/Linux完整120测试文件各1139项，零失败；Mac1124通过15平台跳过，Linux1133通过6跳过。新19成员私有tgz双平台独立离线安装后各97Node/17Python/TSC通过，Mac另有Mypy；38个当前测试/后端输入逐一同hash，没有SDK源码回退。Python wheel重新构建但字节未变，尚无Python Agent API。

安装版Node SDK实际经独立read/write/end key访问公共HTTP→持久执行器→标准Native私有RPC→SourceControl/真实Page。七工具、无人观看80px滚动、旧fence拒绝、准备后修改调用方对象不改变L、实际丢HTTP响应后同ID且页面只生效一次、50ms RPC观察超时unknown且不重放、独立end、人工grant跨Agent end保留和最终B拼LHFZ通过。继续实际Viewer只读/票据tenant/audience/刷新/撤销/到期矩阵。执行fixture保留原准入授权，新增动作仍重新检查。关闭/reopen确认3逻辑Run closed、13injected/2rejected/1unknown、Session closed不占配额、runtime retired及namespace退役文件hash一致；无Source宿主发布端口，已知控制/代理进程退出。

范围仅上述Node SDK与既有七工具。Python Agent SDK是下一独立任务；整体publicAgentSdkQualified仍false。K1/K5/K7/K9仍部分，41项仍10完成、16部分、15待做。业务后置条件、Playwright/文件/事件取消、可恢复任务与完整故障、unknown Engine Start隔离、N1/物理/设备和原8小时增长仍待验收；productionNativeFullyQualified/eightHourPassed均false。WebGL“WebGL 无法显示”黑框与其他显示源码未变。未暂存、提交、推送、修改演示、强制浏览器GC、放宽门槛或重启8小时。

见[证据](evidence/node-agent-sdk.json)。
