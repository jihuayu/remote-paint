# 实际 Native 会话终止后的 Viewer 策略

当前已安装私有SDK、canonical Native worker、生产provider/Registry和真实Mac Chrome完成GPU Worker、CPU Worker和CPU主线程的真实Canvas像素、输入/viewport、角色重连与CSP验证。WebGL仍为黑框和精确文字“WebGL 无法显示”，Canvas2D、图片、文字和输入保持正常。此后让CPU主线程controller与另外一个实际运行中的CPU Worker readonly同时显示同一Native Session，再通过已安装管理SDK释放该Session。

应用没有调用destroy时，两条显示路径都自动进入failed，实际错误码VIEWER_TICKET_UNAVAILABLE；普通票据回调错误按现有有限重试策略耗尽后停止。firstFrame归null、performance为unavailable、控制不可用，iframe与实际Worker已退出。终态后2200ms观察没有新票据调用。原生Session已完成有效namespace退役、完整CID消失且配额释放，旧端点不能再解析。

可信应用后端通过已安装管理SDK读取当前Session，只有在明确closing/closed/expired/failed/cleanup-failed/recovery-required时给浏览器安全的SESSION_ENDED。浏览器回调将其映射为已有类型化终止错误，跨host/frame/child链路保留VIEWER_ACCESS_ENDED。CPU主线程与Worker能力上下文各只请求1次票据，直接failed，之后2200ms无新调用，也没有额外Source解析；显示与遥测所有者清空。不能把所有409、票据超时或未知异常都当成会话结束，creating等状态需要由应用自己的当前状态策略判断。

```js
import { ViewerConnectionError } from '@remote-paint/session-client/viewer-connection';
// value来自本应用可信后端，SESSION_ENDED已核对当前会话状态。
if (!response.ok && value.code === 'SESSION_ENDED') {
  throw new ViewerConnectionError('VIEWER_ACCESS_ENDED');
}
```

自动停止不禁止应用主动重试。显式connect()会按组件设计创建新一轮有界尝试；本次原会话已关闭，4次普通票据回调后再次失败。第一轮测试错误地要求显式connect也不能重新请求，实际失败1；其之前自动停止断言通过。该错误预期、冻结输入及全部清理证据保留，不能称为SDK自动重试缺陷。第二轮扩大到同时存在的真实Worker与主线程后实际0；最终将显式普通回调失败码断言独立于前次断线原因，再次实际0。无需修改SDK库行为。

三个实际轮次分别1/0/0，所有3个Native完整CID独立确认消失，运行记录有效retired；根测试、attach代理与各自Mac浏览器采样PID共45个已知宿主PID均ESRCH，所有测试服务停止、清理错误为空。两次通过轮次各19个票据请求、7次Source解析；已知终止分支没有新增Source连接。主线程与真实CPU Worker是实际会话释放终止验收范围，不能扩大为全部浏览器/设备或8小时证明。

生产代码、SDK全部字节、108个完整单测与已安装包合同输入未变，只扩展一个opt-in验证器。精确继承前项本轮已新跑的双平台953项、离线安装78 Node/17 Python、严格TSC双平台和Mac Mypy，不宣称这项又完整重跑或重新打包。最终候选960文件。仍需未知启动隔离恢复收敛、全部Agent/CDP栅栏、N1/物理时延、更多设备和原8小时增长；41项9/15/17、原8小时失败/192MiB门槛保持，未强制浏览器GC、自动重跑8小时、改公共演示或暂存提交推送。见[范围收据](evidence/production-native-sdk-end.json)。
