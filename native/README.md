# Native serializer (macOS checkpoint 3)

Pinned Skia: `29ed1e87a0a50f3d8347e988842d9d59e7573efa` (Chromium 155.0.8059.79).

`npm run native:build -- --skia-root /path/to/skia` builds a CPU/CoreText helper with CMake/Ninja, Homebrew `harfbuzz-subset` and `libpng`. The source must already be downloaded at the pinned revision. The build intentionally does not silently choose another revision. `native/bin` is ignored and rebuilt locally.

`npm run verify:fonts` captures live Chrome before and after adding previously unseen Chinese and Emoji. It runs the native serializer and decodes its output with CanvasKit. No list of anticipated characters, client font matching, image URL or browser cookie is needed in the Viewer. Glyph IDs and positions are retained; every referenced glyph advance is checked against the original typeface after restoring variation coordinates. Images are serialized from browser-resident pixels.

The Arial self-test is pixel-exact. CoreText rendering of the original and subset Chinese/Emoji fonts differs at 22 / 77 pixels of 614400, maximum channel error 6 / 11. The verification budget is at most 0.1% changed pixels and 16/255 channel error; this is an antialiasing tolerance, not a claim of byte-identical fonts. The authenticated and blob image interiors match source Chrome pixels exactly. See `docs/evidence/font-image-report.json` for measured sizes.

This checkpoint only adds the reusable native serializer and a command-line harness around the existing synchronous Chrome exporter. It does not yet claim demand gating, asynchronous browser capture, compositor mapping or real-time streaming. GPU-backed images explicitly fail instead of silently disappearing.

`chromium/` can be copied into the pinned Chromium tree using `node native/prepare.mjs /path/to/chromium/src`; its GN integration is separate from the standalone helper. Chromium-integrated compilation is not established by the standalone build.

The font subset policy is adapted from the BSD-licensed Chromium Paint Preview implementation (Copyright 2019 The Chromium Authors); license in `LICENSE.chromium`. HarfBuzz/Skia dependencies keep their respective upstream licenses. macOS system fonts are used only for local verification; these test captures do not grant redistribution rights for those fonts.

## Asynchronous capture interface checkpoint

`npm run native:chromium -- --source /path/to/chromium/src` applies the narrow opt-in renderer patch, builds `headless_shell` and native tests, and runs the tests. Run normal Chromium `gclient sync` / hooks before this command. This build configuration requires Apple Silicon macOS and a system Xcode installation.

The interface uses a per-browser `--remote-paint-token`, forwarded only to renderer processes, with requests evaluated in a CDP isolated world. `capture/live.mjs` only schedules capture while subscribed, allows one request in flight, and discards results invalidated by navigation or detachment. The browser copies full immutable layer SKPs on its owning thread and moves those records to ThreadPool for subsetting/image encoding. No raster canvas, DOM pointer or V8 handle crosses to the encoding worker. The renderer emits at most 256 resources / 64 MiB per capture.

At this checkpoint the reusable serializer objects compile with Chromium's toolchain, GN generation passes, and the demand/concurrency test passes. Full renderer compilation and `verify:native` execution are still in progress; these source changes are not runtime acceptance evidence. `REMOTE_PAINT_CHROMIUM=/path/to/out/RemotePaint/headless_shell npm run verify:native` will check secret refusal, thread IDs, live updates, source event-loop pulses and subscription gating on the actual binary. Compositor/Viz synchronization follows separately.
