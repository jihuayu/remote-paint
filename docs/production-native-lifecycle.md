# 生产 Native 的 TTL 与启动取消

固定Engine、canonical Native worker、合格broker、真实浏览器及生产provider/Registry/内核见证/启动journal完成8项实际验收：2秒TTL；在intent、created、engine-started、见证文件落盘、见证绑定、私有Ready，以及真实页面导航尚未提交时取消。根Node实际0，所有项通过。共7个真实容器和1个未分配intent；启动前取消不宣称已分配Native页面。

TTL先等待provider真实retired事件，之前只读取operation，不调用会触发过期检查的Session getter，也不以轮询代替定时器。其最终状态expired、closeReason为ttl-expired。7项取消的原create operation始终failed/SESSION_CREATE_CANCELLED，release成功，未变成迟到成功；包含私有Ready已产生但公共Ready尚未提交的窗口。

Engine刚启动就取消时，实际附着关闭专用通道、采集并绑定Linux内核见证，closeOnly为true、startSent为false，没有重放Start。文件已落盘但尚未绑定时，关闭路径采用已有文件，持久startDispatch最终为有效typed witness。此类3项启动前关闭没有Closed ACK，不拿它当作完成清理；依赖外层严格的完整namespace退役证明。

晚到初始化项让真实Native浏览器的HTTP导航保持未提交，核对channel已发送Start但不可用后取消，再释放受控HTTP commit。worker等待实际晚到资源关闭，Closed确认，未出现Ready、运行记录version仍null。没有Source CDP接口、测试资源替身或生产代码修改。

8项在实际retired事件到来时仍保留配额1，之后才观察保留配额0。独立重新打开8份持久运行记录均retired，1个not-dispatched、7个container-removed；精确CID再次查询7容器均消失，根Node及6个自有attach/关闭见证代理PID均ESRCH，所有清理错误为空。

原939文件的生产/测试/SDK输入逐字节保持，新增一个opt-in脚本，精确继承双平台952项完整JS、77 Node/16 Python安装合同、严格TSC和Mac Mypy；没有冒充新完整回归或包安装。本项直接调用生产Registry接口；已安装SDK的HTTP与真实像素证据在前一检查点，二者范围不混用。

接下来仍需真实Native私有proxy丢失/整个runtime外部移除、冷恢复与重试矩阵、Page/renderer实际崩溃、SDK会话终止策略，以及全部Agent/CDP栅栏、N1轻微丢包/物理时延、更多设备和原8小时增长。41项9/15/17、原8小时失败与192MiB门槛保持，未自动重跑、强制浏览器GC、改演示/采样器或暂存提交推送。见[范围收据](evidence/production-native-lifecycle.json)。
