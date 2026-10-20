# 结束 Agent run 保留人工控制

修复本地 managed-agent-run.close() 在 human/handoff 模式仍无条件调用 ControlLease.revoke() 的错误。结束 Agent 任务不能替人释放人控，也不能取消已经排队的人控交接。现在先同步停止该 run 的后续动作，只有当前处于 agent 模式才撤销并清理 Agent 输入；human/handoff 模式沿用已有队列和交接清理栅栏，不改人的控制版本、holder、lease、expiresAt、输入序号或按键/按钮。仍等待实际队列结束，才返回 run-closed。

三个同脚本单测前实际 1（三失败）、后实际 0（三通过），分别验证：人持有键/鼠标时结束 run，原租约仍能继续；真实队列处于人工交接时，结束 run 不取消 grant；人的 keyDown 正在执行时，run close 等它结束但不自动释放该人的键。原有 Agent 模式停止与清理、外层控制器先关闭时等待实际输入的合同仍由完整回归覆盖。

两份 980 文件 Native 执行快照仅 managed-agent-run.mjs 不同。真实页面收到人工 H，KeyH 仍按下时结束 Agent run：旧实现在 CDP 发出组合清空/KeyH keyup 两个命令，版本 1→2、human→agent、lease 失效，原 grant 后续操作返回 STALE_LEASE，根实际 1。新实现没有发送任何 CDP 清理，版本仍 1、human holder/lease/序号和 KeyH 保持；同一个 grant 主动 keyup 再输入 F，页面独立 HTTP 报告 H→HF。人明确归还后新 Agent run 输入 Z 得到 HFZ，根实际 0。记录不包含原 lease 字符串，仅保存是否匹配的布尔值。

在同一最终候选上重新跑原组合工具 Native 验证，双按钮、全选/组合、拖动/滚动、部分输入途中接管、run 关闭 keyup、新 run 以及外层控制器先关闭的边界全部通过。完整 113 个 JS 文件在 Mac/Linux 各 999 项零失败/取消，分别 984/993 通过、15/6 平台跳过。三次 Native 容器及 Linux 回归容器均终止、PID0、无 OOM；各自已知浏览器/broker PID+startTicks 退役、Source/HTTP fixture 关闭，已知宿主子进程退出。只在冻结执行快照使用已验收 Linux broker，canonical 构建不覆盖。

这仍是本地受管 run 与人控的优先级验证。管理 Session ID 是夹具值，未实现 Native worker/channel/服务HTTP/SDK 的真实 Agent 授权传输，也不是公共 Viewer 的新像素验收。SDK 27 个输入与归档不变，按精确字节继承双平台 78 Node/17 Python、严格 TSC 与 Mac Mypy。原 WebGL“WebGL 无法显示”黑框及其他显示代码不变。

最终仅补充文档成为 982 文件检查点。K5 保持部分实现；41 项 9 完成、16 部分、16 待做，N1、物理/设备、未知启动收敛和原 8 小时增长仍未完成。未放宽策略、强制浏览器 GC、自动重跑 8 小时或修改演示；未暂存、提交、推送。见[范围收据](evidence/agent-run-human-priority.json)。
