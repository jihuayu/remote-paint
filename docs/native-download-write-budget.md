# Native BaseFile 单文件写入边界

本检查点只验收 Linux ARM64 上实际 download::BaseFile 的单文件逻辑长度上限。进程命令行存在 remote-paint-token 时，构造函数一次性捕获受限模式；固定上限为4MiB，空值或错误值不能取消限制，构造后删改开关也不能扩大既有文件权限。无该开关的普通 Chromium 文件保留原行为。

WriteDataToFile 在稀疏状态修改、哈希更新与实际写入前检查整个范围：offset 必须在0到4MiB之间，data.size 不得超过4MiB减offset。先检查offset再做减法，避免带符号溢出；超限整次拒绝，不写入允许的前缀。空文件、恰好4MiB与边界内重叠/稀疏写有效。Open 在哈希、seek和truncate前同时检查实际文件长度和恢复游标；超限文件、负游标和极大游标返回FILE_TOO_LARGE，保留原清理所有权。该检查不限制文件创建数量，也不限制文件系统元数据开销。

独立GN目标直接链接实际BaseFile实现与原上游测试。实际ARM64 ELF在单独Linux容器执行未过滤的完整目标：35项上游测试与10项新增边界测试全部RUN/COMPLETED，45通过、0失败、0禁用，实际退出0。新增测试覆盖空/精确上限、无允许前缀、稀疏offset和整数边界、超限恢复不截断、非法游标、命令行快照、非Native行为及取消后的真实文件删除。本轮1135文件候选还完成138个根测试文件的双平台1425项JS回归：Mac1410通过15平台跳过，Linux1419通过6跳过，均实际退出0。

前两次构建实际退出1，C++测试未启动：第一次Go缓存默认落到只读/root/.cache；第二次Go程序已编译，但默认/tmp的noexec阻止执行。错误日志完整保留。修复只涉及构建环境：专用可写Go缓存、独立显式exec的Go临时tmpfs；离线依赖检查通过，实际挂载和执行探针确认默认目录拒绝13、专用目录执行0，同一Tint生成命令实际退出0并生成26文件。第三次复用本轮已有对象缓存，完整GN/Ninja构建退出0。没有因观察超时重启构建、降低测试范围或过滤失败项。

这不是浏览器下载资源预算的完整验收。现有固定19文件浏览器未替换；此处只有新编译的独立测试程序。4MiB是BaseFile文件extent外层上限，不是Agent每次arm请求的较低maxBytes、总spool、网络接收缓冲、常驻内存或所有临时文件上限。进程级开关会覆盖通过BaseFile的非arm下载；原文档“窗口之外沿用浏览器既有行为”的合同须在新浏览器部署前明确协调。完整浏览器capability/来源绑定、创建item之前准入、取消/失败partial spool实际删除与任务结算、Chromium item移除和Playwright Download集合生命周期仍待完成。单独deny目标路径发生在item创建之后，Remove返回也不能冒充异步文件删除已完成。

Node/Python SDK源码及70个安装验证输入逐hash与父检查点相同；175Node/118Python安装与类型证据仍引用原父版本，本轮没有重新运行这些安装验证。最终快照相对实际执行候选只增加文档和证据，清除继承的历史freshFullJs/postRunDocumentationOnly歧义字段，并显式绑定本轮JS/C++执行清单。

K6仍部分，41项保持10范围内完成/17部分/14待做。全量Native、unknown Engine Start、其余41/N1/设备与原8小时增长失败继续；未自动重跑8小时、放宽门槛、强制浏览器GC、改采样器或演示，未暂存、提交或推送。构建和测试容器均确认停止/PID0/退出0/无OOM后移除，原输出与构建缓存保留。

见[证据](evidence/native-download-write-budget.json)与[进度](optimization-progress.md)。
