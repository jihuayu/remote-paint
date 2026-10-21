# SDK 安装包 CI

`SDK package contracts` 在独立的 Linux ARM64 GitHub runner 上运行，不依赖本机 Docker、Chromium 构建目录或受保护采样器。使用 Node22.23.3/Bookworm 和 Python3.11，先准备固定版本工具及带 SHA256 的七个 SDK runtime wheels，再运行完整1645项 JS 和隔离安装包202项 Node/194项 Python、严格 TypeScript 与公共/包源码 mypy。

实际安装阶段离线：npm不执行安装脚本，pip只读取验证过的wheelhouse。安装消费目录没有SDK源码，真实HTTP/SQLite夹具按相对import闭包显式复制并记录哈希；没有下载或启动浏览器。源码清单绑定实际checkout commit，执行前后哈希相同才允许成功；结果、阶段退出码、失败日志和归档成员校验均保存为Actions artifact。新入口先在声明的本机冻结快照验证，远端执行结果仍需单独核实。

工作流只读仓库权限，main相关路径push或手动触发；不会触发耗时的浏览器打包，也不会发布npm/PyPI包。15分钟job和120秒子阶段上限保留失败收据。JS平台跳过仍为macOS15/Linux6，其余0失败/取消；新功能增加合同数时需要明确更新门槛，不能放宽当前失败条件。

本机冻结快照通过完整1584项（1569通过/15平台跳过）、隔离202项Node/194项Python及类型检查；Node归档与Python wheel哈希均与SSE实现候选相同。固定工具的Linux ARM64/Python3.11 wheels已实际下载，七个runtime wheel已从索引按原哈希重新下载核对。最终工作流额外将同一Node镜像tag固定到Docker官方registry返回的index digest，运行器代码与依赖文件不变；远端实际Linux结果仍待核实。

首个远端作业39485030782成功准备ARM64容器及全部依赖，但Git在测试前因checkout所有权退出128；原失败日志保留。checkout action的临时HOME设置未传到后续容器shell。运行器现在对每条只读Git命令仅信任明确解析的workspace目录，不写全局配置，仍严格核对实际commit和干净源码；远端复验尚待执行。

第二个作业39490733953已运行完整JS阶段，36秒后实际退出1；其源码清单、阶段收据和失败JSON保留。host的runner.temp上下文与容器实际RUNNER_TEMP不同，导致首次artifact漏掉详细log，尚不能解释测试失败原因。收集步骤现从实际环境变量路径复制有限日志/归档到workspace的相对artifact目录，失败阶段另向job控制台输出有限摘要；所有测试时限和1584/202/194门槛保持，等待带完整日志的实际复验。

第三个作业39494297596保留完整日志：1584项中1577通过、6跳过，唯一失败是setup rejection之后owned leaf在原3秒内未消失。新CI容器未配置原冻结Linux验证一直使用的`--init`；这与孤儿进程回收有关，但失败现场没有进程状态证据，不能直接宣称已证明zombie根因。现补齐init，并保存有限的PID1及孤儿/僵尸状态清单；不改测试、3秒期限或回收判定，最终结果继续待实际复验。

本入口用于补齐SDK与完整JS的Linux证据；它不替代原Native事件/取消端到端、浏览器完整构建、原8小时失败或全部41项验收。

最终作业[39496883279](https://github.com/jihuayu/remote-paint/actions/runs/39496883279)绑定56abfb3的1242源码，实际docker-init为PID1：Linux完整1584项1578通过/6跳过，202项Node/194项Python隔离包与严格TypeScript、安装后5公共/9源码mypy全部通过；原测试名称和194个Python用例逐项核对，两个SDK归档与macOS哈希一致。原3秒叶进程消失合同通过，前三次失败均保留。此前缺失的详细日志不补造，第三次完整失败及第四次全部日志均已下载校验。浏览器构建、原Native事件/取消、Webhook和八小时验收继续待做。

Webhook原字节认证核心新增20项后，入口明确更新为147个根测试文件/1604项（macOS1589通过15跳过、Linux1598通过6跳过），202Node/194Python与类型门槛保持。[作业39519469785](https://github.com/jihuayu/remote-paint/actions/runs/39519469785)的1246源码与macOS候选逐项相同，20新项及原1584名称保留，两个SDK归档未变化；此处仍不是完整Webhook投递/持久去重或原Native验收。

持久捕获队列新增18项后，入口为148个根测试文件/1622项（macOS1607通过15既有跳过、Linux1616通过6既有跳过）。[作业39522907367](https://github.com/jihuayu/remote-paint/actions/runs/39522907367)绑定6504d0e与同一1250源码，18新项和原1604名称保留；各202Node/194Python及类型检查通过，SDK归档哈希不变。此处仅完成原事件持久捕获，实际投递/确认/去重及原Native/八小时仍待。

持久尝试与确认日志新增23项后，入口为149个根测试文件/1645项（macOS1630通过15既有跳过、Linux1639通过6既有跳过）。[作业39551778361](https://github.com/jihuayu/remote-paint/actions/runs/39551778361)绑定ce76596与同一1255源码，23新项和原1622名称保留；各202Node/194Python及类型检查通过，SDK归档哈希不变。主机早期超时不丢弃，恢复后同输入100项定向约3秒通过，最终完整约32秒通过；仅确认持久存储/栅栏，未确认实际HTTPS或接收去重/原Native/八小时。
