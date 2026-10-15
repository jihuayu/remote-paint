# Live protocol v2

The live entry point is `REMOTE_PAINT_CHROMIUM=/path/to/headless_shell npm run demo`. It starts a real changing source page on the same device and the Viewer at a separate origin. A stock browser cannot provide the native capture API. `--url` binds another ordinary page to the same source/Viewer session.

The resource envelope remains binary RPNT v1 (SHA-256 + a self-contained SKP); the live scene envelope is protocol 2. Hello strictly matches protocol, CanvasKit version and Wasm hash. Resources are session-scoped and have no public hash lookup endpoint. Source HTML, JavaScript, DOM, cookies, image URLs and screenshots are not part of the Viewer stream.

A full SceneUpdate has `baseFrameId: null` and a complete render-pass graph. A delta has an explicit acknowledged base and ordered pass upserts/removals. FrameCommit does not advance the visible/dependency state until every required resource is present and CanvasKit decoding/replay succeeds. Releases cannot remove displayed or staged dependencies. The Viewer frees retired resources after a successful atomic display.

Each Viewer has one frame in flight. Source captures arriving during that window replace only the unsent latest snapshot; the next delta is recomputed against the last acknowledged scene. No dependent intermediate wire frame is skipped. On missing dependencies/base, RequestKeyframe clears the assumed client cache and sends a fresh complete scene. ACK deadlines close slow connections with 1013; automatic reconnection starts with the latest complete snapshot. Other Viewers and the browser keep progressing.

Limits: 16 MiB/resource; 64 MiB of resources/frame; 256 KiB of scene metadata; 128 MiB/512 entries in a client cache; 64 render passes / 2048 quads / 32 million intermediate surface pixels; four local Viewers. Client messages are limited to 32 KiB. Native capture and socket queues are separately bounded.

`npm test` covers base loss, absent resources, decode failure before commit, revision release, coalescing and slow-client bounds. `npm run verify:viewer` runs CanvasKit in an actual browser over WebSocket, proving dynamic scene replay, resource reuse, a slow connection alongside a fast Viewer, reconnect recovery and no source-origin requests. Its input is explicitly the checked-in capture fixture (`docs/evidence/live-viewer-contract-report.json`); it is protocol/Viewer evidence, not acceptance of the custom native browser. Native scene and end-to-end page verification are separate scripts.
