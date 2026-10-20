# 生产 Native 的运行中代理丢失与外部移除

固定Engine、canonical Native worker、合格broker、真实浏览器和生产provider/Registry，完成两个运行中故障。每项在故障前核对实际Native版本、Ready、完整内核见证和私有端点解析成功；未发布容器端口，没有Node资源替身或Source CDP测试接口。

代理丢失项只检查本项已知代理PID，要求它是控制器的直接子进程，完整命令恰为固定Node和冻结项目中的attach代理，核对后SIGKILL。通道以CHANNEL_OUTPUT_CLOSED失败；provider和Registry撤回Ready，端点被拒绝，随后按真实namespace证明删除容器，退役种类container-removed。

外部移除项先用完整CID、spec及所有权检查验证本项容器，再由测试actor精确执行rm --force。通道同样失效；退役依赖原持久typed启动见证和完整CID的404探测，种类container-absent，absenceProbe.effectAttempted为false。测试actor的删除确认不被当作生产退役凭据。

两项在unavailable和retired事件到来时都仍持有配额1，随后才为0，终态closed/worker-unavailable；原创建操作保留成功，既有Session不可重新使用。独立关闭并重新打开原SQLite、核对同一identity与deployment binding，再读有效退役哈希，均为retired。根Node实际0；外层再次查询两个完整CID均不存在，根Node和两个代理PID均ESRCH，清理错误为空。

原942文件与253依赖逐字节保持，新增一个opt-in脚本；精确继承双平台952项JS和77 Node/16 Python、严格TSC与Mac Mypy安装合同，不宣称新完整回归或安装。最终945文件包括两份新增范围文档。实际故障不等于物理延迟或N1验收。

冷控制器恢复、Page/renderer真实崩溃、SDK会话终止重试策略、全部Agent/CDP栅栏、N1/物理时延、更多设备和原8小时增长仍待验收。41项9/15/17及原8小时失败和192MiB门槛保持；未强制浏览器GC、自动重跑8小时、修改公共演示/采样器或暂存提交推送。见[范围收据](evidence/production-native-runtime-loss.json)。
