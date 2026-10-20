# 公开 Viewer 资源服务（开发中）

`service/viewer-assets-http.mjs` 提供独立的 `createPublicViewerServer`。它只提供 Viewer 静态资源和无凭据的配置；数据连接仍使用[票据网关](session-viewer-access.md)。此阶段已验证实际 HTTP 行为及保存入口脚本的等待/接线；iframe 父子授权消息、宿主组件和真实浏览器 CSP/资源验收仍待完成。

```js
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {createPublicViewerServer} from '../service/viewer-assets-http.mjs';

const preparedAssets = await prepareViewerAssets({mode:'public'});
const server = await createPublicViewerServer({
  gatewayOrigin:'https://data.example',
  allowedParentOrigins:['https://app.example'],
  preparedAssets,
});
server.listen(4180, '127.0.0.1'); // caller owns TLS/reverse-proxy binding
```

`gatewayOrigin` 必须为规范化 HTTPS Origin；开发可使用 HTTP loopback。`allowedParentOrigins` 必须明确提供，最多 32 个规范化 HTTPS/loopback Origin，不接受通配符、重复值、凭据、路径、查询或片段。空数组生成 `frame-ancestors 'none'`。Origin 字节总量最多 8192。工厂复制配置，之后修改原数组不改变已运行服务。参数 `requestTimeoutMs` 默认 10 秒，可设 50ms 到 60 秒；`maxConnections` 默认 64，可设 1 到 1024。

省略 preparedAssets 时工厂自行准备 public 资源；传入时必须使用 `mode:'public'`。工厂返回尚未 listen 的 Node HTTP server，由调用方负责监听、TLS、停止连接与关闭。它不持有 Registry、Source resolver、管理 key、私有端口或资源所有权，不执行会话分配。

## 配置与公开入口

`GET /viewer-config` 返回且只返回 `schema:'public-viewer-v1'`、`gatewayOrigin`、`allowedParentOrigins` 和 `viewerBuild`。该配置公开可读，不含 Session、票据、Source URL/key 或 Native 端口。入口与配置均使用 `Cache-Control:no-store`。服务不提供 `/session-config`、管理 API、任意文件读取或 WebSocket upgrade；查询参数也不用于启动或授权。

public HTML 添加固定启动标记。与同版本 private 入口共用原有不可变模块、Wasm 和 Viewer build，公开/私有握手无需绕过版本检查。入口变体有独立 ETag，且不进入不可变根路径缓存。模块改动仍改变 build；过期的不可变资源路径返回 410。

公开入口在宿主授权前冻结生命周期，不初始化 Worker/呈现器、不读私有 hash key、不请求 `/session-config`，也不自动连接。它以不带凭据、拒绝重定向、no-store 的同源请求加载 `/viewer-config`，总等待默认 5 秒、正文最多 16KiB，UTF-8/字段/Origin/build 均须有效。

`await window.remotePaintViewer.ready` 返回冻结后的公开配置。失败时返回固定错误码并保持停止，页面不会转入私有连接路径。显式 `connect` 还核对 gateway 与加载配置完全一致；调用方式见[运行时说明](session-viewer-runtime.md)。未来宿主消息桥必须同时验证父 Window 和 allowlist，不能因配置公开就跳过票据或父窗口授权。

## CSP 与静态资源

每个响应包含配置生成的 `frame-ancestors` 和仅允许自身资源、指定数据网关的 `connect-src`；不配置会与跨域 allowlist 冲突的 X-Frame-Options。脚本仅自身及 Wasm 编译，Worker 仅自身，禁止对象、base URI、表单提交。固定 Referrer-Policy、nosniff 和 same-origin 资源策略随响应返回，不提供 CORS 允许 header。

逻辑资源路径使用 no-cache，`/assets/:build/...` 使用一年 immutable 缓存，保留 gzip 协商、独立编码 ETag、HEAD 和条件请求。只接受 GET/HEAD；不存在、带查询或有请求正文的路径被拒绝。上述为已核对的响应契约；浏览器实际执行 CSP、iframe sandbox 与跨域父子消息的完整效果仍需真实浏览器验收。

## 观察器与验证范围

新增模块纳入帧龄观察器复制的原资源清单，复制结果必须与当前生产 build 完全一致后才允许插桩。Worker 连接代码重构后，诊断启动记录改从实际 WebSocket URL 读取目标端口，消除旧局部 config 引用。插桩、故障、streaming 模式的 provenance 和原始阈值保持约束；这不改变运行中的原始 8 小时冻结副本。

检查点保留修正前两条 build 失配、一条实际 `config is not defined` 失败，以及修正后的 Node 合同结果。保存 Worker 脚本用真实 Node 网络和 FrameGate 验证接线，DOM/CanvasKit/呈现器/realm 调度为明确夹具；未执行原生像素年龄采样，也不证明真实浏览器资源退役。证据见[公开资源检查点](evidence/viewer-public-assets.json)。
