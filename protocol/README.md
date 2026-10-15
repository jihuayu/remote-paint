# Phase A protocol v1

WebSocket ordered messages:

1. Client `Hello { protocol: 1, renderer: { canvaskit, wasmSha256 } }`.
2. Server `Welcome { protocol, producer, renderer, mode: "static-keyframe", input: false }`.
3. Binary ResourcePut: magic `RPNT`, u8 version=1, u8 kind=1 (SKP), two reserved zero bytes, u32 big-endian payload length, 32 raw SHA-256 bytes, SKP bytes.
4. JSON `SceneUpdate { frame }` containing epoch/frame, full scene, viewport, required resource IDs.
5. JSON `FrameCommit { pageEpoch, frameId }`.
6. Client `FrameAck { pageEpoch, frameId }`, only after rendering; missing resources trigger `RequestKeyframe`.

No deltas: `baseFrameId` must be null. One identity-transformed, fully opaque layer at DPR=1. Other scenes fail closed. `ResourceRelease` is supported by the viewer gate but not emitted by this static server. Resource keys are scoped to the loaded capture/server; hashes are never exposed via an HTTP resource lookup API.

Limits: 16 MiB/resource, 32 MiB resource cache, 8 resources, 64 KiB/JSON message, 4096 px/viewport dimension. These bound the transport/cache, not decoded typeface/image complexity or execution time inside `MakePicture`. The exporter and viewer are a trusted local experiment, not a hardened untrusted-SKP decoder. Production needs matched builds, decode isolation, image/font budget instrumentation, restricted effects and fuzzing.

The producer and consumer Skia revisions are **not** matched. The handshake prevents using a different local Wasm from the one recorded during capture; it does not establish arbitrary SKP compatibility. `MakePicture` failure is surfaced, with no screenshot fallback or silent conversion.
