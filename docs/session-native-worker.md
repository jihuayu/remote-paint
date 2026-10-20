# Session Native worker 边界（开发中）

`service/session-worker.mjs` 实现一进程、一Session的私有控制通道，`native-session-resource.mjs` 持有异步Native启动结果并清理，`native-session-worker.mjs` 是待接入受管Linux容器的入口。同库运行时身份/分配意图账本与 DockerSessionProvider 已接通持久 SessionRegistry，并通过真实 Node 容器生命周期/崩溃恢复验证；实际 Native Chromium/Browser 进程集合及 Viewer 票据验收仍待原8小时隔离后进行，不能用 Node 夹具代替。

## 启动与通道

worker配置固定的sessionId、tenantId、region与随机owner key的SHA-256。启动前先安装输入、失联、信号和关闭处理，发WorkerHello；在收到绑定同Session且owner key匹配的Start之前不构造资源。owner key与初始页面URL只走私有stdin，Ready只返回协议、Session ID及版本。该key不充当管理API key、Viewer ticket或人工控制租约。

一行一个严格UTF-8 JSON帧，最多32 KiB，使用固定缓冲区，解析后清除缓冲内容。只有Start、OwnerHeartbeat、Close三种命令；Start只允许一次，region与固定配置一致，初始URL/TTL有界。无任意CDP、文件路径或JS执行接口。无效身份、重复Start、额外字段、畸形/超大帧均关闭当前worker，不回显页面URL、key或底层异常。

启动握手默认5秒，总初始化期限60秒。资源所有者先同步建立，后执行initialize；关闭等待真正的启动结果，晚到的资源仍须关闭，不能在Close之后发布Ready。资源在初始化尚可能继续分配时提前返回closed会被拒绝。Native wrapper要求实际nativeAutopublish、Broker、控制面、连接的Browser及Renderer hash；其版本由实际Browser版本和Wasm hash组成。仅有fixture模型验证了这些检查，生产入口本轮只做语法检查。

## 失联与关闭

owner EOF、控制流错误、进程disconnect、SIGTERM/SIGINT与owner租约到期都会先建立同一个关闭等待点，再通知AbortSignal，避免同步abort回调重入时重复清理。owner租约默认30秒，由可信父端心跳维持，独立于人工输入租约和SessionRegistry TTL。Session的实际过期传播/健康丢失与Registry状态同步须随Native provider接入另行验收。

关闭最多等待10秒。资源close不确认、启动结果未知或关闭超时，会返回CleanupIncomplete并退出1；启动异常不暴露原错误。Native启动抛错且没有返回可检查的live句柄时，worker不会据异常断言所有外部资源已消失。外层运行时仍须按持久的资源身份核对并关闭整个进程/容器集合，然后才能向Registry确认归还配额。不能只凭启动器PID退出或worker的逻辑Closed消息宣称整个Native进程集合已退休。

每个worker进程退出前，stdio保留不捕获Session对象的错误接收器，防止最终Closed通知遇EPIPE后变成未处理异常。资源关闭与最后一条通知送达分别判断。外层运行时负责完整namespace退役，入口在关闭结束后有限刷新并退出；整个进程不用于复用下一个Session。

## 持久运行时意图

`SqliteSessionStore` 现使用同一私有SQLite文件保存运行时记录，schema现为v3。合法v1先验证全部Session、操作、幂等绑定与引用再迁移；v2先验证全部运行时/索引/引用后原子升级，旧 Start 历史标为 legacy-unknown，保留原UUID/文件身份和两类修订号。原Session修订号不因迁移改变；空、外来或损坏账本不会被重建。运行时有独立修订号，避免破坏Registry对逐次写入确认的要求，排他锁、0600文件、外键及FULL同步保持。

内部接口为 `claimRuntimeProvider`、`loadRuntime`、`commitRuntime`、`bindRuntimeClosingWitness`、`releaseRuntimeProvider`。新增关闭专用确认只在 closing/完整CID/保留配额的记录上一次性补齐有效见证，不允许重放 Start/Ready。每区域先固定deployment和daemon身份，以私有Symbol令牌排他持有；已有活动Session却没有原运行时绑定时拒绝直接接管。每Session只保留一个运行时身份，记录owner key哈希、配置哈希、固定镜像ID及不可改绑的容器名/ID，不保存初始URL或原始key。

普通阶段为 `intent → requested → created → ready → closing → retired`。派发意图只能确认一次，必须早于真实创建；重获所有权后的原记录只能向关闭/退役推进，不能重新派发或发布Ready。关闭开始后拒绝晚到的派发与Ready，允许把恢复查明的原容器ID绑定到关闭中的记录。已派发却没有已知ID的分配，不能仅凭暂时查无对象或“没有效果”的猜测写成退役。Native Session的Ready和配额归还受对应账本状态约束。

退役字段只保存受信任内部provider提供的证据种类与hash，账本本身不执行或验证Docker/内核回收。后续driver必须真正取得并验证相应证据后才能写retired；测试中的容器ID、hash与外部文件效果均是明确夹具。45项初版合同通过后补充了实际Ready进程SIGKILL及Registry恢复，最终同737文件快照在Mac/Linux各46项定向合同全部通过；完整回归各419项无失败，Mac410通过/9平台跳过，Linux415通过/4平台跳过。错误SQL字段查询和夹具API名称问题的初版失败均保留。见[账本检查点](evidence/session-runtime-intent-store.json)。

当前独立8小时仍运行先前冻结的720文件副本，不包含这个新增服务层；它的结果不能代替Native provider、TTL/健康传播、整组namespace回收或Viewer角色/票据验收。

## Docker 元数据与固定运行配置

`service/docker-metadata-client.mjs` 目前只读取显式指定的本机Unix Engine API，固定daemon ID、架构和API版本。单次操作总期限5秒、回复128KiB、最多4个活动请求，不排队或隐式重试；拒绝重定向、异常HTTP状态、畸形UTF-8/JSON与身份漂移，关闭时核对自身socket已释放。容器查询前后均核对daemon，这些是时间上分开的元数据见证，不是原子冻结或进程回收证明。

`docker-runtime-spec.mjs` 生成带规范化hash的固定配置：镜像ID、来源指纹、owner哈希及Session/租户/区域标签；合并镜像继承环境后完整核对，禁止额外注入。固定node入口、私有PID/IPC/cgroup配置、init、runc、只读根和两个来源挂载、capDrop ALL、no-new-privileges、有限CPU/内存/PID/tmpfs，不自动重启、不继承镜像healthcheck、不发布宿主端口。归属与隔离校验分开：能确认某个不合规对象属于自己，不等于能确认其隔离或进程集合已退役。

同743文件最终快照在Mac/Linux完整437项均无失败，分别428/433通过及9/4平台跳过；18项定向测试均通过。当前OrbStack29.4.0实际接受最终配置，夹具容器始终未启动、PID为0，按完整ID删除；全部5次元数据夹具的ID已再次确认不存在。最终夹具另行重开SQLite核对退役记录的hash等于实际保存的证据字节，配额标记已释放。早期JSON排版导致hash与文件字节不一致的夹具问题已修正，旧记录保留。这些不证明worker、Chromium或Linux namespace内进程曾实际启动或被回收，见[配置检查点](evidence/session-docker-foundation.json)。

首版437项Mac回归曾有一次原生内存助手启动超过原2秒期限，助手被回收，源/二进制与此前版本相同；失败未删除。固定8个全新路径副本对照均在约0.19–1.23秒启动并正常退出，未证明先前超时的唯一原因，也未宣称修好助手。最终快照保留原4并发、2秒期限后完整回归通过；运行中的8小时冻结副本未修改。

后续B1b2需把现有操作会话接到私有stdio、未知结果隔离及生产恢复；B1b1的独立Node容器验证如下。Linux在私有PID namespace的init终止后会杀死该namespace内其余进程；要用此规则推断清理，必须先证明对应namespace与init确实属于该对象并已终止，参见[Linux手册](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)。[Docker创建](https://docs.docker.com/reference/cli/docker/container/create/)和[移除](https://docs.docker.com/reference/cli/docker/container/rm/)的API结果还需与对象身份、内核见证及持久记录合并；一次CLI退出或当前配置快照不足以完成证明。

## 容器操作会话（B1b1）

`service/docker-effect-session.mjs` 把每次create/start/remove固定到同一条实际Unix连接：先核对daemon及平台，Start另核对完整ID、归属、隔离配置和created/PID0状态；该连接一旦关闭便拒绝重连。每个会话只尝试一次操作，调用方只能取得perform、close与隔离的检查副本，不能直接调用内部HTTP或改写连接配置。总期限默认5秒，含检查、同步授权及实际操作；空闲到期也关闭自己的socket。请求64KiB、回复128KiB、最多4个会话且不排队，不自动重试。

perform要求同步返回同一运行时账本的持久确认，逐字段核对Session、租户、区域、deployment、daemon、owner哈希、配置哈希、镜像、名称、完整ID及阶段。真正的数据库写入必须由受信任的provider完成；回执结构本身不是加密证明，也不能代替provider对恢复状态和并发的检查。异步/抛错/错误回执、关闭或到期均在发操作前拒绝；操作开始后丢回复、超时、取消或异常HTTP保持结果不确定，不伪造成功或自动重放。已知ID的404只返回缺失见证，不自动宣布退役；归属成立但隔离不合规的对象可以按完整ID移除，却不能据此证明namespace隔离。

实际OrbStack夹具通过该模块创建并启动一个Node主进程及detached叶子进程，读取两者的实际/proc身份、PID namespace、init和安全状态。主进程PID7、叶子PID19且进程组分别为7/19，同属一个私有namespace；capEff/capBnd均为0，NoNewPrivs为1、seccomp为2。操作socket关闭后两者仍发心跳，证明客户端关闭不等于进程回收。随后按完整容器ID强制移除取得204，独立且前后固定daemon的查询取得404，两条实际进程见证TCP连接均关闭。根据此前有效namespace/init见证、精确对象移除和Linux规则推断这个夹具namespace退役；这不是宿主机全部进程普查，也没有运行Native或Chromium。

夹具先以0600文件保存证据并fsync文件及目录，再把实际文件字节的SHA-256写入retired，最后归还Session配额；另开SQLite核对落盘记录。20项新合同覆盖持久确认先于真实请求字节、一次使用、字段/状态约束、不重连、不重试、固定总期限、限额、超量、取消与socket回收。冻结版本及双平台完整结果见[操作检查点](evidence/session-docker-effects.json)。私有stdio/attach、未知创建的生产恢复、完整Native provider、Registry TTL/取消/健康传播与Viewer角色/票据仍待接入；Native浏览器负载继续等待当前独立8小时结束。

## 私有 attach 前置合同（B1b2a）

`service/docker-multiplex.mjs` 按固定Docker v1.45非TTY格式解码8字节头，只接受stdout/stderr和为0的保留字节。单帧及单输入块上限均64KiB；解码器只保留固定头和最多一帧未完成内容，整帧收齐后才转移其独立Buffer，不提前把截断payload交给worker协议。异步迭代由调用方逐帧消费，不预取下一个输入块；调用方仍负责下游背压及释放已经转移的Buffer。超限、未知流、原始TTY、截断和来源异常均拒绝，错误不回显原始内容。实际socket适配器需先把读取结果拆成有界输入，不能假设Node异步迭代永远只给64KiB。

固定运行配置新增单容器local日志：max-size=1m、max-file=1、compress=false，均为字符串选项。完整配置校验拒绝继承或扩大日志策略；没有修改全局daemon设置，也没有重启任何既有容器。这是Docker轮转配置，不是精确的磁盘字节硬限额。可选实际夹具写3MiB固定日志，再读取已轮转的真实复用流，核对首标记消失、末标记保留和有界帧；原始复用流另存0600文件，供独立检查器重新解析。参见[Docker API v1.45](https://raw.githubusercontent.com/moby/moby/v26.1.5/api/swagger.yaml)和[local日志驱动](https://docs.docker.com/engine/logging/drivers/local/)。

初版嵌套LogConfig曾错误使用对象引用比较，导致合法配置被拒绝；失败保留后改为规范化内容比较。随后定向测试发现原操作会话的timer偶尔早于performance绝对截止时间触发，误报主动关闭；修正为每次回调检查同一截止时间，只等待剩余间隔。原5秒总预算不变；固定强制早触发的两类回调合同验证不会提前过期，未用加长期限或重试代替。冻结版本、真实日志轮转与双平台回归结果见[attach前置检查点](evidence/session-docker-attach-foundation.json)。实际HTTP Upgrade、私有代理和worker通道集成仍在后续B1b2b，不能用这个解码器或日志读取验收代替。

## 私有 attach 代理（B1b2b）

`DockerAttachClient` 同步持有新建的宿主Node子进程，最多4个活动代理且不排队；名额只在真实ChildProcess close后释放。固定入口、显式精简环境，至多128KiB配置走私有fd3；fd4只回送2KiB内的连接结果，初始URL和owner key继续只走SessionWorkerChannel私有stdin。配置副本不能改变已经捕获的容器/daemon绑定。attached表示运输层升级完成，clientDone严格来自子进程close，不根据socket EOF伪造退出，也不据此宣布容器退役。

子进程在同一实际Unix连接上顺序读取info、完整ID的inspect，然后升级attach。检查daemon、Linux架构、完整归属和固定running配置；要求101、Upgrade tcp及允许的Docker内容类型，拒绝重连、重定向、200降级和原始TTY。启动期限默认5秒且覆盖配置/检查/升级，只按原截止时刻检查剩余时间。每次调用方应先检查持久运行时是否恢复/关闭中；代理不代替provider的账本与并发控制，也不自动重新attach或重发Start。

HTTP升级head也进入同一有界解码器，socket用read(n)逐次取最多64KiB，避免Node异步迭代合并过多缓存。stdout按整帧交付，等实际下游write回调后才清除Buffer；原始输入块和head在消耗后清除。stderr只计数、清除且不转发，生命周期上限1MiB；私有输入只转发完整LF帧，单行最多32768字节。输入EOF保留最多12秒响应收尾，输出EOF会关闭输入读取。停止时先关闭自己的stdio，避免未读stdout阻止真实close，再等SIGTERM最多250ms，必要时SIGKILL再等250ms；未知退出继续报告unconfirmed。这些动作都只涉及宿主代理，运行时进程集合仍需单独回收。

19项代理合同覆盖同连接检查/升级、错误身份/配置、拒绝重连、坏HTTP/升级头/复用帧、输入边界、有限stderr、EOF及总期限、取消、真实SIGKILL、8MiB慢消费背压、stdout阻塞时退出和清除继承Node选项。实际容器夹具复制冻结的runSessionWorker与Node叶子资源，分别测正常关闭、代理丢失和运行时被移除；证据与双平台回归结果见[代理检查点](evidence/session-docker-attach-proxy.json)。该夹具仅验证Node私有控制通道，没有运行Native/Chromium或完成Registry公共Ready、TTL、恢复及Viewer票据。独立720文件8小时保持不变。

## 启动前内核见证与持久文件（B1c0）

`linux-runtime-witness.mjs` 只读固定的Linux proc路径：有限stat/status/boot_id和PID namespace链接，复读self/init出生标识与namespace，拒绝变化、截断或超量。stat最多4KiB、status最多16KiB、boot_id最多64字节；局部读取总检查期限5秒，不执行shell、exec、CDP或任何系统设置。有效见证要求worker是PID1的直接子进程，init为PID1/ppid0，同一PID namespace，出生ticks有序；UID/GID均0、五类capability为0、NoNewPrivs=1、seccomp=2。字段取自实际内核，参见[stat](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)、[status](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html)。它配合已检查的Docker私有PID/init配置使用，不单凭一个namespace字符串证明隔离。

Native入口固定提供实际收集器，读取失败会在资源工厂前退出；本轮Native入口仍只作语法检查，真实浏览器负载继续等当前8小时结束。通用worker可保留旧无见证合同，新私有WorkerHello带runtimeWitness时父端必须显式配置requireRuntimeWitness、已核对的daemon/CID/spec绑定和证据处理器。原Hello总期限覆盖异步元数据核对及落盘，处理器回执绑定Session、daemon、CID、spec及见证/文件hash，通过后才发送Start。关闭先安装同一等待点再abort处理器；晚到回执不再启动，异常与坏回执不回显原始错误。

`RuntimeWitnessStore` 把见证、租户/Session/区域/deployment、完整CID、镜像/来源/owner哈希及Engine StartedAt代次写入私有文件。目录0700、文件0600，目录首次创建时同步父目录，临时文件先fsync，再以不覆盖的link发布并fsync目录；同一文件不能重新持久化。读取限8KiB并拒绝符号链接、宽权限、损坏hash和不匹配的启动代次。已退出的原代次可读，重新启动的同CID不能借用旧见证。恢复读取无需原始owner key，不会重放Start。文件hash与回执本身仍由可信运行时控制器使用，不能单独充当资源已退役的证明；缺失或损坏时保留不确定状态。

结构、存储与私有通道的56项合同通过，包括实际文件写入进程SIGKILL后重读及关闭重入/晚写入/原期限；结构夹具没有被当作真实内核见证。实际Docker Node夹具通过同一收集器和私有代理，在Start前核对固定配置、落盘见证，叶子初次出现时要求证据已存在，之后交叉核对独立/proc见证并无需owner key重新打开文件。冻结版本、三条真实关闭路径及双平台结果见[见证检查点](evidence/session-runtime-witness.json)。生产provider、未知创建恢复、Registry生命周期和实际Native整组回收仍待下一步实现。

## 当前证据与剩余条件

轻量合同运行真实Node worker与叶子子进程，验证认证前无分配、重复启动、同批Start/Close、父端EOF与租约失效、心跳、晚启动收尾、提前关闭假回执、abort同步重入、失败脱敏、UTF-8分片/限长和期限。stdout在释放中关闭的失败已保留：此前移除了错误处理器，资源虽关闭仍因EPIPE退出1；修复后正常完成关闭。测试夹具自身在setup失败时回收worker，叶子同时在继承stdin失联后结束，避免重复历史上的测试进程泄漏。

下一步需要把已验证的持久运行时意图接到真实分配，补真实容器或等效内核集合的创建与退役证明、Registry取消/TTL/恢复/健康变化接入，以及Native Gateway真实read/control显示角色和单次票据。Native集成及浏览器负载在当前独立8小时长测结束后执行。没有把本轮进程夹具或Native入口语法检查当作这些验收。

最新长测状态（2026-10-19）：独立720文件8小时v3已在第3200周期失败，Source/Viewer/Docker均退出1，最后完成样本约8632.77秒。失败断言是Source PSS完整性，不代表本轮新服务层或Native浏览器验收。失败的逐进程PSS指标未被原measure/RPC路径保存，根因仍未证明；未放宽采样条件、未沿用前缀时长、未直接重启。实际helper退出0，最后完成Mac cohort的12个PID现均不存在；Source最终cgroup仅余Node且完整，但primary关闭回执因前置PSS pin失败仍标failed。详见[原始失败检查点](evidence/session-coupled-eight-hour-v3-failure.json)。下一步先补失败指标诊断和定位。


Source 长测的 PSS 失败现在会在原三项断言之前保存完整有界诊断，并经私有 RPC 保留到 Viewer；关闭阶段采样失败也先落盘。实际受控 Native 权限拒绝、真实 Linux 僵尸对照及双平台回归见[诊断证据](evidence/source-memory-diagnostic.json)。它们只验证观察路径：原 v3 缺失逐进程指标的历史事实不变，唯一原因仍未知，未改写失败回执或放宽 PSS 完整性。


## Native私有流密钥启动（Node合同范围）

worker现从认证后的owner Start与固定Session/租户/区域派生独立流密钥，经资源工厂传给固定4175/4176 Native transport；实际启动必须确认同一密钥，Ready仍只返回版本，不通过stdout分发密钥。普通worker没有默认派生能力。Node协议/真实子进程/HTTP+WS通过，Native适配器端口使用stub，实际生产Native worker与拥有端点解析仍待后续。见[私有启动检查点](native-private-bootstrap.md)。


## Native健康订阅

Native资源要求实际Browser/Page/Broker的on/off接口，在Ready之前绑定并复核Browser连接、Page关闭/崩溃及Broker终止状态；单一订阅在终止时锁存失效，不把capture压力当作死亡。私有worker在慢清理前通知父端，关闭仍持有晚到初始化资源，注册期关闭的监听器也在initialize终结后解绑。真实浏览器/broker死亡已撤销Ready和端点；Page实际崩溃、完整生产生命周期和公开SDK像素仍待验收。见[健康范围](native-health-notification.md)。


## 已安装公开SDK的生产Native像素

真正生产provider/端点解析已完成三种SDK绘制路径的实际像素、WebGL中文黑框、输入与视口对照及显式Session释放；没有Source CDP测试接口或Node替身。完整崩溃/TTL/取消/恢复与物理/丢包/8小时仍待验收。见[生产Native像素范围](production-native-viewer.md)。


## 真实TTL与启动取消

canonical Native执行了2秒自动TTL与7个取消窗口，包括实际关闭专用见证、文件见证采用和真实晚到导航后的关闭；8项持久退役与配额释放确认。冷恢复/外部丢失及Page崩溃仍待验收。见[TTL与取消范围](production-native-lifecycle.md)。


## 真实运行中代理丢失和外部移除

canonical Native实际Ready后完成自有attach代理SIGKILL和完整容器外部删除；两项都撤回Ready/端点并经独立持久退役后释放配额。见[范围](production-native-runtime-loss.md)。冷控制器恢复与Page崩溃仍待验收。


## 真实Ready后的控制器死亡与冷恢复

两个自有控制器在真实Native Ready后SIGKILL；新控制器用原SQLite/binding执行关闭专用恢复，拒绝旧授权，不重建私有key或重放Start，原容器保留/消失两条退役路径和配额释放均确认。见[范围](production-native-cold-recovery.md)。全部启动阶段恢复和Page崩溃仍待验收。


## 启动阶段死亡边界

8个生产事件处控制器实际SIGKILL；7项冷恢复退役，无有效见证的engine-start-dispatch保留隔离与配额。关闭专用采集不重放Start，原文件见证采用、公共Ready之前死亡均有实际收据。见[范围](production-native-startup-recovery.md)。未知启动恢复收敛与真实Page崩溃仍未完成。


## 实际renderer崩溃

完整自有CID中对实际renderer SIGKILL后，canonical Native资源不可用消息使provider/Registry撤回Ready与私有端点，随后有效namespace退役。角色探针两次未发信号的失败保留；不用Source CDP测试API。见[范围](native-renderer-health.md)。不宣称完整生产验收。


## 后端SDK的worker失效兼容

Node/Python SDK现接受worker-unavailable关闭原因，包括配额尚保留的closing和退役后的closed。真实Native故障用新安装Node SDK再次核对，双平台新包合同与类型检查通过。见[范围](backend-worker-reason.md)。Viewer终止重试策略另行验收。


## 安装后Viewer的Session终止策略

实际Native Session释放后，CPU主线程与实际Worker自动终止并清空显示所有者；可信应用后端识别会话结束，类型化VIEWER_ACCESS_ENDED每条路径仅取票一次。显式应用connect仍可开启有界尝试。见[范围](production-native-sdk-end.md)，不代表全浏览器/设备验收。
