# 公开性能/首帧的真实 Native 验证

使用计时器修复后的实际安装SDK，Mac Chrome跨源iframe连接Linux真实Native Source/Rust，完成GPU Worker、CPU Worker、CPU主线程三条支持路径。GPU为实际硬件，CPU路径明确关闭GPU，CPU主线程额外抑制transfer能力。不是DOM/CanvasKit夹具。

8次挂载和额外9次同组件重连/readonly/controller切换，共17条实际签发授权后的连接路径，均检查当前首帧及有限性能快照。重连首帧连接代次增大，换角色新iframe的宿主代次增大，首帧次数与相应生命周期一致；销毁清空快照并移除iframe/Worker。首帧保持scene-submitted / viewer-ui-receipt，含Worker回到UI的消息跳转，不等于物理显示或业务成功。

六次普通挂载均在Source尺寸回执后，再等待真实Canvas新像素和宿主性能的pageEpoch/viewportVersion/尺寸匹配，采样frameId不早于对应画面。640×400与720×480均通过；实际图像、Canvas2D、输入及尺寸编码/右下角像素正常。绿色Source WebGL在Viewer呈黑框及精确“WebGL 无法显示”，六次字形precision/recall均1（1px邻域）。

性能22字段、首帧13字段冻结且不含授权/Source私有身份；实际观测六次初始Wasm heap均128MiB，GPU/驻留仍标记client-estimate，不声称进程物理资源。验证器只保留有界观察数组。noop远端按下状态清理、租约/序号、真实资源SHA暂停时公开控制优先级、Native已应用后测试回执延迟的unknown超时和新挂载画面均再次通过。暂停是测试干预，不是N1网络或物理延迟。

首次真实运行的Illegal invocation失败、原907文件、Source0/Viewer1与清理已独立保存；带接收者检查的Node回归定位计时器this，词法调用修复和独立886项/安装包检查点完成后，才用新包重跑本次实际矩阵。原失败不删除，本次实际Source/Viewer均0，浏览器无pageerror。

Source七个固定拥有身份回收，三组共12个所采样Mac PID均ESRCH；Worker、端口、公开/夹具服务均关闭，无清理错误，容器停止/PID0，Source逐帧Node map/publish/awaitPromise均0。未改生产运行时代码，仅新增范围文档；886项/103文件双平台与16文件包77 Node/16 Python、严格TSC/Mac Mypy继承相同已验证字节，不伪称重跑。

只资格化当前Mac Chrome/Linux Source矩阵；实际Source仍由单行测试provider拥有，不是生产Native端点集成。更多设备、物理IME、全部Agent/CDP授权栅栏、同步Wasm重放优先级、N1轻微丢包/物理时延和原8小时增长仍待验收。41项仍9完成（范围内）/15部分/17待做，原8小时失败与192MiB门槛保持，未自动重跑、强制GC、改演示/采样器或暂存提交推送。见[机器收据](evidence/viewer-telemetry-native.json)。
