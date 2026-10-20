# Viewer 的有限远端视口请求

`ViewerInput.resizeViewport({width,height})` 是内部输入流水线方法。本步骤尚未向 Frame/DOM SDK 暴露远端 viewport API。它仅接受两个自有数据字段，CSS 整数范围 1–4096；需要 Welcome 的 `viewportControl` 能力及当前已授予的控制租约。一次只允许一个请求，requestId 在当前 peer 内单调递增。

发出请求前停止旧输入、清空本地待发/在途输入和编辑预览，并停止续租。Source 的排队清理屏障负责释放远端已按下的键、鼠标和组合状态。调整进行中忽略迟到的 ControlGranted，避免恢复旧坐标输入；不提前发送 ReleaseControl，使 Source 能在原租约下验证请求。

只有对应 requestId、有限字段、请求尺寸及有效 epoch/version 的 Source 回执才能完成 Promise。改变尺寸后旧 lease/fence 持续作废，输入保持暂停；重新接管需等控制状态与已提交 frame 的新代次一致。这个回执只确认 Source 屏障已应用，不证明 Viewer 已提交新画面。尺寸 no-op 保留 Source 租约，客户端另发 RenewControl 并等授予后恢复，已发送的输入序号不回退。

拒绝只保留固定 code 和 `not-applied` / `unknown`。not-applied 后交还旧租约；unknown、断线或异常回执保持输入暂停。匹配异常或未来 requestId 在主线程及 Worker 路径均关闭旧公共连接；迟到的旧 requestId 不可完成新请求。内部方法的总超时、取消及公共错误类型仍由下一步 ControlActions/SDK 集成完成，不能直接当作完整公开 API 使用。

Window/Worker 和独立 ControlLink 的 viewport 回执走原有有界控制元数据通道，绕过场景处理队列。19 条新合同包括真实 Node HTTP/WebSocket/SQLite/ControlLease 的主线程/Worker 请求、严格清理、no-op 续租及异常回执回收。DOM、CanvasKit、呈现器、Worker realm 调度、Source.resize/CDP 为明确夹具，没有启动浏览器或测量像素。真实 Native、公共控制优先级、全量取消/未知结果与性能事件仍须后续验收。

后续动作层与公开父子桥已接入，当前API及剩余验收范围见[SDK视口说明](viewer-viewport-sdk.md)；上文描述本输入模块检查点的独立范围。
