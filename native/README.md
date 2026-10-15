# Native Remote Paint on one macOS device

The complete custom `headless_shell` builds and passes native capture, scene, input and streaming acceptance on Apple Silicon macOS. The source page executes JS/DOM/layout in Chromium; the Viewer receives SKPs and actual aggregated Viz composition. It does not receive source HTML/JS, cookies or the comparison screenshot.

Pinned versions: Chromium `a49e2e3d4addfd84e765b52afe230bedb81096db` (155.0.8059.79), Skia `29ed1e87a0a50f3d8347e988842d9d59e7573efa`, SKP 110, CanvasKit 0.42.0. Live protocol 4 and the Wasm hash are checked in the handshake.

## Build and run

Use a pinned Chromium checkout with `gclient sync` / hooks completed, full Xcode with Metal Toolchain, Node.js 22+, and Ninja. Keep the same Ninja version for incremental builds (this checkout uses Homebrew Ninja 1.13.2).

```sh
npm ci
npm run native:chromium -- --source /path/to/chromium/src --jobs 6
export REMOTE_PAINT_CHROMIUM=/path/to/chromium/src/out/RemotePaint/headless_shell
npm run demo
```

The build command applies the four patches in `patches/`, copies `chromium/` into `components/remote_paint`, generates GN, builds the browser and serializer tests, then runs the latter. Preparation checks the exact source revision and patch hashes. Do not use a changed patch over an already patched checkout without reviewing/resetting that patch first.

Open the complete Viewer URL printed by `npm run demo`, including its fragment key. The default test page contains live counters, a compositor animation, incremental Chinese/rare-glyph/Emoji text, authenticated/blob images, editable fields and a scrollable list. `--url http://127.0.0.1:3000` selects another ordinary page.

The harness uses `--in-process-gpu`: GPU/Viz run in the browser process, while Renderer processes remain separate. On this host a separate GPU child stalls in dyld before Chromium main; that mode has not passed acceptance. The capture hook, renderer boundary and bounded Unix IPC are real in the accepted configuration. See [startup evidence](../docs/evidence/native-frame-startup-report.json).

## Capture and composition

A per-browser token enables `captureRemotePaint` in a CDP isolated world. The launcher omits `--enable-gpu-benchmarking`, leaving the capture/debug API absent from source-page JavaScript. Incorrect tokens are rejected. Capture runs only while subscribed, allows one request in flight, and discards records invalidated by navigation or detachment.

Recording uses the active compositor tree immediately after `GenerateCompositorFrame`. Full immutable layer SKPs are copied on the owning thread; font subsetting and image encoding run on ThreadPool. No raster canvas, DOM pointer or V8 handle crosses to the encoding worker. A capture is limited to 256 resources / 64 MiB.

An opaque capture ID travels through `CompositorFrameMetadata` and Mojo to `SurfaceAggregator`. Actual aggregated passes, quad transforms, clips, opacity, content origins, stable layer IDs and remapped texture IDs travel over a length-prefixed Unix socket. The directory is 0700, the socket 0600, and writes have a timeout and at most two tasks in flight.

`capture/scene.mjs` pairs only equal capture IDs. Resource identity includes page epoch / producer / Surface namespace / local stable ID / revision. Viz texture IDs are diagnostic rather than permanent resource identities. Content revisions remain reusable when only composition changes; retired mappings are released.

The Viewer replays pass order, clipping, opacity and nested passes. It applies Viz's rebased content origin before drawing a scaled SKP and isolates picture clears with `saveLayer`. CPU CanvasKit surfaces use `dispose()` to release their allocated pixel buffers on success, error and resize.

## Fonts and images

Outline text preserves source glyph IDs, positions, variations and validated advances. HarfBuzz creates subsets; if CoreText cannot reload a macOS UI subset, Chromium Fontations reads the same subset bytes. There is no anticipated character list or client-side font matching/reflow.

Bitmap-only glyphs, including Apple Color Emoji, retain pixels rendered with the original source typeface and strike, encoded as local PNGs on the worker. Limits are 1024 × 1024 per glyph, 4096 glyphs / 16 million pixels per picture. RSXform text mixed with bitmap glyphs is explicitly unsupported. Ordinary text blobs remain intact when they need no bitmap extraction.

Images are serialized from browser-resident pixels; authenticated and blob images do not require Viewer access to source URLs or cookies. GPU-backed images explicitly fail. Images and glyphs embedded in SKPs are reused through immutable picture hashes; separately externalized image/font caches are not implemented.

The standalone helper is available with `npm run native:build -- --skia-root /path/to/skia`. It requires the pinned source, CMake/Ninja, Homebrew `harfbuzz-subset` and `libpng`. Its ignored `native/bin` output is rebuilt locally. Helper compilation alone is not browser acceptance.

## Runtime evidence

| Gate | Result and report |
|---|---|
| Native serializer | Four passing Chromium-toolchain tests: original glyphs/Arial exact pixels, original bitmap-glyph PNG exact pixels, budget refusal, nested picture coverage. [Report](../docs/evidence/native-serializer-report.json) |
| Fonts/images | New Chinese/Emoji, zero missing source glyphs, authenticated/blob image interiors exact. Report explicitly scopes the stock Chrome exporter plus native helper. [Report](../docs/evidence/font-image-report.json) |
| Native capture | Main-world API absent, isolated API present, incorrect token rejected, zero no-demand captures, different recording/encoding threads, paired native/Viz IDs. [Report](../docs/evidence/native-capture-report.json) |
| Native scene | Scroll 0 / 700 / 0, fixed header, content hash/revision reuse and actual compositor animation; whole-page pixels over 24/255 error about 1.37% / 3.00% / 1.37%. [Report](../docs/evidence/native-scene-report.json) |
| Native input | 83 events covering mouse, wheel, Chinese composition, repeated IME commits, replacement, paste/delete, rich text, Tab, CSS scaling, lease handoff, stale tags and held-pointer cleanup. Input/save region error 5.38%, below the unchanged 6% threshold; rainbow color pixels match within the declared neighborhood. [Report](../docs/evidence/native-input-report.json) |
| Complete dynamic stream | 91 captures; live text/content changes, resource reuse during compositor animation, slow peer 1013 while normal Viewer progresses, reconnect, navigation, resize and actual dropped-SKP keyframe recovery. No source-origin Viewer requests or page errors. [Report](../docs/evidence/native-live-report.json) |
| Surface lifetime | Actual Wasm allocator: 100 two-pass frames plus error handling, 202 pixel-buffer allocations / 202 frees / zero outstanding. [Report](../docs/evidence/surface-lifecycle-report.json) |

The complete dynamic pixel comparison measures 1.37% of pixels over 24/255 channel difference, under the 6% gate. Final streamed text has 2345 strong source ink pixels, all covered within one pixel; removing text fails the negative control. These measurements are replay similarity, not universal pixel identity. Two in-flight captures were invalidated during intentional navigation/resize; later frames recovered and the final error state is empty. The report records both failures instead of suppressing them.

Run `verify:native`, `verify:scene`, `verify:input` and `verify:live` with `REMOTE_PAINT_CHROMIUM` set to reproduce the real drawing gates. Without that path, the separate input-contract test uses an explicitly marked drawing fixture. Earlier fixture reports retain their original scope.

Rounded target-space clips preserve the normal composited input caret. The
[latest Mac latency and live report](../docs/evidence/mac-direct-presentation.json)
records sixteen successful keydown-to-pixel samples, the exact browser and
Viewer source hashes, a visible caret, and zero capture errors during input.
Premultiplied pass surfaces and direct Canvas pixel presentation reduced
Viewer replay from about 54 to 6.3 ms. Final input latency was 148.5 ms median /
191.9 ms p95, compared with the periodic baseline's 222.5 / 278.0 ms. Measurements
ran under concurrent Linux compilation; physical keyboard/scanout are excluded.
The final Viewer also passed 83 input events and the complete dynamic recovery
suite. Its one capture cancellation during navigation is recorded and later
frames recovered. These measurements establish the Mac path; Linux acceptance
remains separate.

The Linux ARM64 browser build and Mac-to-Linux acceptance harness are described
in [docker/README.md](../docker/README.md). The browser is still compiling;
serializer tests and a stock BeginFrame clock probe do not prove the complete
native Linux path.

Physical OS IME candidate-window/caret placement, independent GPU-process startup on Mac, GPU raster paths, child Surfaces/iframes, gradient masks/complex filters/3D, cross-device use, Steel/Gateway integration and production SKP decoder isolation are outside the current acceptance. Unsupported composition fails explicitly. The managed Agent input API enforces leases; arbitrary external CDP is not isolated by that lease.

## Attribution

The font-subsetting policy adapts BSD-licensed Chromium Paint Preview code (Copyright 2019 The Chromium Authors), with license in `LICENSE.chromium`. HarfBuzz and Skia retain their upstream licenses. macOS system fonts are used for local verification; captures grant no redistribution rights for those fonts. Test fonts use `tests/fixtures/OFL.txt`.
