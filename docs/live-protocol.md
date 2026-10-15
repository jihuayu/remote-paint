# Live protocol v3

The live entry point is `REMOTE_PAINT_CHROMIUM=/path/to/headless_shell npm run demo`. It starts a real changing source page on the same device and the Viewer at a separate origin. A stock browser cannot provide the native capture API. `--url` binds another ordinary page to the same source/Viewer session.

The resource envelope remains binary RPNT v1 (SHA-256 + a self-contained SKP); the live scene envelope is protocol 3. Hello strictly matches protocol, CanvasKit version and Wasm hash. Resources are session-scoped and have no public hash lookup endpoint. Source HTML, JavaScript, DOM, cookies, image URLs and screenshots are not part of the Viewer stream.

A full SceneUpdate has `baseFrameId: null` and a complete render-pass graph. A delta has an explicit acknowledged base and ordered pass upserts/removals. FrameCommit does not advance the visible/dependency state until every required resource is present and CanvasKit decoding/replay succeeds. Releases cannot remove displayed or staged dependencies. The Viewer frees retired resources after a successful atomic display.

Each Viewer has one frame in flight. Source captures arriving during that window replace only the unsent latest snapshot; the next delta is recomputed against the last acknowledged scene. No dependent intermediate wire frame is skipped. On missing dependencies/base, RequestKeyframe clears the assumed client cache and sends a fresh complete scene. ACK deadlines close slow connections with 1013; automatic reconnection starts with the latest complete snapshot. Other Viewers and the browser keep progressing.

Limits: 16 MiB/resource; 64 MiB of resources/frame; 256 KiB of scene metadata; 128 MiB/512 entries in a client cache; 64 render passes / 2048 quads / 32 million intermediate surface pixels; four local Viewers. Client messages are limited to 32 KiB. Native capture and socket queues are separately bounded.

`npm test` covers base loss, absent resources, decode failure before commit, revision release, coalescing and slow-client bounds. `npm run verify:viewer` runs CanvasKit in an actual browser over WebSocket, proving dynamic scene replay, resource reuse, a slow connection alongside a fast Viewer, reconnect recovery and no source-origin requests. Its input is explicitly the checked-in capture fixture (`docs/evidence/live-viewer-contract-report.json`); it is protocol/Viewer evidence, not acceptance of the custom native browser. Native scene and end-to-end page verification are separate scripts.

## Managed input and control handoff

Welcome advertises `input`, a per-control session UUID and the connection peer ID. `AcquireControl` uses session/page/viewport tags from the displayed frame. The broker fences accepted Agent operations, releases held state, then sends a random lease only to its owner. Other Viewers receive public ControlState only. Renew every 10 seconds; authority expires after 30 seconds. Disconnect, release, navigation and viewport changes revoke it. A shared serial queue fences inflight CDP work before resuming Agent input. Already executed JavaScript is not undone. Only `source.control.agent(event)` is governed; external unrestricted CDP/Steel integration is outside this checkpoint.

Each Input carries sessionId/pageEpoch/viewportVersion/lease/seq. Strictly increasing sequences are checked before queueing and authority is checked again before CDP dispatch. The queue accepts at most 64 operations. Revocation cleanup bypasses the ordinary queue admission limit so a full queue cannot prevent releasing keys, mouse buttons and composition. InputAck reports CDP processing, not business-operation success.

The Viewer uses source CSS coordinates, one InputAck in flight, at most 60 queued events, movement coalescing and a local textarea for real composition events. Text/IME/paste are forwarded to Input.insertText / Input.imeSetComposition; no source DOM or clipboard access is granted to the Viewer. Queue overflow releases control visibly. Chinese IME verification drives the local and remote browsers through actual CDP composition; physical operating-system candidate windows and caret anchoring are not covered.

`npm run verify:input` exercises real source and Viewer Chrome with a declared drawing fixture. Set REMOTE_PAINT_CHROMIUM to repeat it against native dynamic drawing. The report records which boundary was tested.

Picture quads carry `contentOrigin`, the origin of the complete layer recording in rebased quad coordinates. Chromium shifts tile rectangles by the visible-layer origin to avoid floating-point precision loss, compensating the shared transform. The Viewer clips in quad coordinates, translates by `contentOrigin`, then applies the recording scale. Omitting this field repeats the page top when scrolling. Version 3 requires the field and rejects older scene handshakes. The immutable resource hash and revision remain unchanged for geometry-only scrolling.

Each picture is replayed into an isolated transparent layer. Native recording preambles may use `clear`/Src; drawing them directly into a composed pass would erase earlier quads through transparent corners. The picture layer is blended back over the pass after replay. A raster regression covers a clearing circle over an opaque background.

CanvasKit CPU surfaces own a separate Wasm pixel allocation. Scene pass cleanup, Viewer resize and page exit use `surface.dispose()`, which frees that allocation and then deletes the native surface. A test intercepts the actual CanvasKit `_malloc`/`_free` calls: 100 two-pass frames plus a failing render allocate and free all 202 pixel buffers, retaining zero after each completed frame/error (`docs/evidence/surface-lifecycle-report.json`).
