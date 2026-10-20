# K8a：Agent持久事件日志

实际Run和Invocation的状态写入现在在原SQLite事务内追加事件：状态、事件、每Run序号与64条保留窗口共同提交或回滚。每条事件有稳定`aevt_`ID、固定Run/Session/region/version及单调序号；`observedAt`为本机记录时间，排序使用序号，不用不同机器时钟相减。事件仅投影状态、调度标记、固定错误和`input-injected`计数，不存动作参数、页面内容、私有控制绑定或证据hash；注入回执不表示业务成功。

受信任后端可调用`executor.events({tenantId,agentRunId,after?,limit?})`读取独立于Source普通请求的持久页。`after`是必须和原Run引用一起保存的内部序号，默认0；每页1–4条、序列化最多16384字节，每事件最多3072字节。返回最早/最新序号、下一序号及hasMore。超前游标明确拒绝且不毒化执行器；过旧游标返回`gap=true`和空events，不静默跳过或推进游标。客户端稍后需要通过公开流/快照协议明确处理缺口。

事件窗口每Run最多64条，控制与Invocation原记录仍按原策略保留。窗口删除不释放Run、Writer、Session或Native额度；现有数据库max_page_count门槛不变。这些是逻辑记录和响应上限，不是整个SQLite文件及回滚日志的物理占用证明。

在v4账本中注册独立`remote-paint-agent-events-v1`扩展，主Session格式/版本及既有记录、inode、instance和三类revision保持。旧v4先完整验证原Agent记录，再在单事务内建表、写明确的run.snapshot/invocation.snapshot及扩展标记；缺失的历史不补造为实际过往事件。事件origin标注migration-snapshot。未知扩展、缺失表及额外第11表明确拒绝；旧程序会拒绝新增表，本步骤没有提供降级迁移。v2/v3迁移夹具显式移除扩展，继续覆盖原Engine Start见证和未知恢复。

17项新增测试使用实际私有SQLite文件和原DurableAgentExecutor，覆盖事务内追加、原ID/游标重开、幂等不重复注入、64条保留/缺口、原租户/控制器、严格自有数据/无getter、插入失败时原状态/裁剪/游标/revision共同回滚、Unicode上限、旧v4快照迁移及畸形拒绝。5个真实自有子进程覆盖迁移建表后与快照写完后/COMMIT前SIGKILL、原intent及恢复结果未提交、已提交unknown与事件共同幸存。未知恢复不变成injected。实际普通请求未返回时，后端事件读取不发送Source RPC，也不清除普通占位。

首轮原72项中4失败：3项为旧v3夹具未移除新增扩展，一项为缺失metadata表需保留原STATE_SCHEMA分类；修正后72通过。新增17首轮16通过，Unicode测试未同步原幂等绑定的region导致正确引用拒绝，配齐夹具后17通过。随后扩展113项及加强后的17专项通过，失败日志与旧夹具保留；生产限制未放宽。最终同一候选macOS完整1513项=1498通过/15平台跳过，Linux1513项=1507通过/6平台跳过，两端0失败/取消；17新项均实际运行且无跳过，原1496名称保留。首候选macOS1513亦通过；复查补强旧v1/v2/v3携带扩展标记须在基础迁移前拒绝后，最终候选重新完成双平台全量。Mac完整测试沿用原时限，将自有构建临时降为0.5核后恢复原4核、实际PID不变；全部原日志保留。完整双平台结果见[证据](evidence/agent-event-journal.json)。

本项仅持久事件内核和受信后端读取，HTTP流/心跳/重连与缺口恢复、Node/Python SDK、公开取消语义及签名Webhook仍须后续独立完成。K8改列部分实现，41项为10范围内完成/18部分/13待办，K6和原8小时失败保持未完成。完整浏览器v2在封存复核期间因主机进程启动阻塞和资源争用停止：实际退出143/PID0、无OOM、自有容器已移除，原输出与缓存保留，32GiB门槛未触发或放宽，108份Chromium输入保持。首次资格脚本的Docker观察超时记录保留，不算测试失败或浏览器成功；本项不prepare或改写Chromium。预算默认关闭、readiness=false，正式浏览器与采样器不执行/复制/替换，缓存和无关peer保持，未提交/推送、无子代理。
