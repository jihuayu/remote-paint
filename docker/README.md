# Linux ARM64 browser build on Apple Silicon

This build runs Chromium's Linux x86_64 host toolchain in an amd64 Docker builder (OrbStack/Rosetta on this Mac) and produces an ARM64 Linux browser for a native ARM64 runtime container. It never runs the macOS executable inside Linux.

Use an **independent** checkout of Chromium `a49e2e3d4addfd84e765b52afe230bedb81096db`, with its pinned dependencies synced for Linux. The LLVM/Rust packages and sysroots are platform specific: do not mount the active Mac checkout here. The example explicitly selects `CHROMIUM_OUTPUT=out/RemotePaintLinux`. Choose a dedicated output name for a new local build; the scripts require the selector and use it for preparation, GN, Ninja, receipts and packaging. They do not probe another platform output for patch receipts.

```sh
docker build --platform linux/amd64 -t remote-paint-build:linux-arm64 -f docker/Dockerfile.build .
docker run --name remote-paint-linux-build --platform linux/amd64 --init \
  --shm-size=2g --memory=48g --memory-swap=48g --cpus=9 -e BUILD_JOBS=12 -e CHROMIUM_OUTPUT=out/RemotePaintLinux \
  -v /absolute/independent/chromium:/chromium \
  -v /absolute/remote-paint:/project:ro \
  remote-paint-build:linux-arm64 /project/docker/build-linux.sh
```

`BUILD_JOBS` defaults to four and can be set to reduce memory pressure. The script downloads the pinned Linux toolchain, GN and both host/target sysroots, applies the existing Remote Paint patches, generates GN and builds `headless_shell` plus the serializer tests. The ARM64 test binary must execute in the ARM64 runtime rather than the x86_64 builder. The standalone macOS/CoreText helper is not used.

The example allocates 75% of this Mac's 12 CPUs and 64 GiB RAM: nine CPUs and a
48 GiB container limit, with 12 compiler jobs to fill CPU time during I/O waits.
The VM also needs enough RAM. OrbStack was restarted with its memory setting
at 48 GiB; Docker now reports 50,500,259,840 usable bytes (about 47.03 GiB after
VM overhead). The builder retains its nine-CPU quota and 48 GiB container limit.
Its existing mounted output directory is reused for incremental compilation.
Monitor actual memory before increasing concurrency further.

The Linux development profile disables `use_v8_context_snapshot`. Chromium's
context-snapshot generator otherwise builds Blink again for the x64 host. An
independent GN/Ninja graph comparison removed 24,432 reachable object outputs
(38.4%) while retaining the exact same 33,526 ARM64 object outputs, including
native Viz capture and serialization. The ordinary V8 startup snapshot remains
enabled. New V8 contexts use normal initialization, which can increase context
creation time; runtime and input latency still require the complete acceptance
suite. The [graph evidence](../docs/evidence/linux-context-snapshot-graph.json)
establishes dependency reduction, not measured build-time savings or runtime
acceptance. Existing objects stay in the mounted cache, including completed
host objects that are no longer needed by this profile.

The same container and cache were then resumed with this profile. Pending
headless build actions fell from 39,422 to 14,821, and compilation advanced
under the existing nine-CPU, 48 GiB limits. The copied native sources, revisions,
arguments and patch receipts passed preflight. The [resume evidence](../docs/evidence/linux-context-snapshot-resume.json)
records these observations; complete browser/runtime acceptance is still pending.

Keep the same source mount and output directory to retain the incremental
cache. Object files, static libraries, generated sources, `.ninja_log` and
`.ninja_deps` live in `src/out/RemotePaintLinux` on the Mac. Downloaded LLVM,
Rust, GN and sysroots also live in this mounted checkout. Stopping or replacing
the builder container preserves these files. Resume a stopped builder with
`docker start -a remote-paint-linux-build`; do not clean the output directory or
prune the mounted checkout. This is Ninja's persistent incremental cache, not a
configured ccache/sccache service. Docker image/build layers are retained too.

On this Mac's case-insensitive bind mount, Clang can see SwiftShader's `Vulkan`
directory as `vulkan` after an unrelated lowercase header lookup. The Linux
preparation adds `-Wno-error=nonportable-include-path` only to SwiftShader's
config. It keeps the diagnostic visible and retains all other error checks;
the upstream include spelling stays intact.

Preparation also points this independent checkout's `.gn` at the pinned
`cpython3/linux-amd64` interpreter. V8 metagen invokes a nested `gn desc`, which
does not inherit the outer `gn gen --script-executable` override. Leaving the
Mac-synced `cpython3/host` default would run Mach-O in the Linux builder. The
downloaded Mac and Linux interpreter directories are both retained.

This is the build harness. Runtime/BeginFrame acceptance is recorded separately; preparing an image or generating the build graph does not establish that the Linux drawing path works.

The current rounded-clip Viz exporter has also passed a separate compilation
with the generated Chromium Linux ARM64 command. Its output is a 29,776-byte
ELF64 AArch64 object, and its source hash matches the project. See the
[scoped report](../docs/evidence/linux-viz-compile-report.json) and
[compiler log](../docs/evidence/linux-viz-compile.log). The object was written
outside the running build's output, so this check does not establish that the
complete browser is linked or that Linux runtime acceptance has passed.

## Native runtime and Mac acceptance

Build the runtime for ARM64 and mount the entire output directory, including
Chromium's data files. Publish the Viewer HTTP and native Gateway ports on Mac loopback:

```sh
docker build --platform linux/arm64 -t remote-paint-runtime:linux-arm64 -f docker/Dockerfile.runtime .
mkdir -p artifacts/linux-acceptance
docker run --rm --platform linux/arm64 --init --shm-size=2g \
  -v /absolute/independent/chromium/src/out/RemotePaintLinux:/browser:ro \
  -v /absolute/remote-paint:/project:ro \
  -v /absolute/remote-paint/artifacts/linux-acceptance:/project/artifacts \
  remote-paint-runtime:linux-arm64 npm run verify:linux
mkdir -p artifacts/linux-mac
docker run --name remote-paint-linux --platform linux/arm64 --init --shm-size=2g \
  -p 127.0.0.1:4176:4176 -p 127.0.0.1:4177:4177 \
  -v /absolute/independent/chromium/src/out/RemotePaintLinux:/browser:ro \
  -v /absolute/remote-paint:/project:ro \
  -v /absolute/remote-paint/artifacts:/project/artifacts \
  remote-paint-runtime:linux-arm64 node tests/serve-linux-proof.mjs
# Run this on the Mac host, in the project directory:
npm run verify:linux-mac
```

`verify:linux` first checks ARM64 ELF headers, hashes, build arguments and patch
receipts. The build also writes `remote-paint-build.json` after an incremental
Ninja dry run confirms there is no pending work. It binds the actual Chromium
and Skia revisions, copied native source hashes, patched Chromium file hashes,
Linux host configuration and both executable hashes. Runtime acceptance
compares this receipt against the mounted binaries and current native project;
an older Viz exporter with matching build arguments cannot pass preflight.
It then runs the serializer, external BeginFrame clock, native
capture, scene, input, live recovery and input latency checks in order. Each command has a
five-minute limit and its own log in `artifacts/linux-suite`; a failure stops
the suite and leaves a failed report. Linux results do not establish that the
Mac Viewer works, so the host acceptance is still required separately.

The proof server uses the normal native SKP/Viz transport and BeginFrame driver.
Its private bind-mounted file channel exports source observations and accepts a
fixed set of test operations; it exposes no HTTP test API or CDP port. Source
screenshots are acceptance comparisons only. Viewer pixels always come from
CanvasKit replay. The Mac test checks native dynamic frames, image/text pixels,
animation resource reuse, keyboard/IME/paste, scrolling, reconnect, navigation,
resize, dropped-resource recovery, and zero capture demand after disconnect.
Mac input also exercises a CSS-scaled Viewer and rich-text editing; saved input,
edited text and streamed new glyphs receive separate source/replay ink checks
that must reject an erased replay.
The Mac latency check retains the ordinary input radius and visible caret.
It compares the 120 ms periodic baseline with input-triggered capture on the
same Linux source and Mac Viewer. Sixteen keydown-to-actual-pixel samples per
mode produce p50/p95/maximum values in `input-latency.json`; median improvement
and zero native capture errors during the input measurements are required.
Intentional navigation/resize can cancel an in-flight capture; the report
retains those errors and requires later recovery to a clear final error state.
InputAck alone cannot satisfy
the check. Physical keyboard and display scanout delay are outside its scope.
Reports are written under `artifacts/linux-mac`; the physical OS IME candidate
window is outside the automated test's scope.

For an ordinary demo without the private proof channel, use the image's default
command instead of `node tests/serve-linux-proof.mjs`.


## Rust Broker binary

The browser builder and ARM64 runtime require a separate ARM64 Linux Broker;
the Mac `native/bin/remote-paint-broker` is a Mach-O executable. One native
Docker build option (run in the project) is:

```sh
mkdir -p ../../work/broker-target
docker run --rm --platform linux/arm64 \
  -v "$PWD:/project:ro" -v "$PWD/../../work/broker-target:/target" \
  -w /project -e CARGO_TARGET_DIR=/target rust:1.96-bookworm \
  cargo build --release --locked --target aarch64-unknown-linux-gnu --manifest-path native/broker/Cargo.toml
```

Mount that cache at `/broker:ro` in both runtime commands and pass
`-e REMOTE_PAINT_BROKER=/broker/aarch64-unknown-linux-gnu/release/remote-paint-broker`.
Cargo's target directory must persist just like the Chromium output. A Mac
cross build is also supported by `npm run native:broker -- --target
aarch64-unknown-linux-gnu` with Rust's target standard library, an ARM64 Linux
sysroot and `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER` configured. It writes
a separate binary and SHA-256 receipt under
`native/bin/aarch64-unknown-linux-gnu/`, leaving the Mac binary available.
The current cross-built ELF has been executed in the ARM64 runtime; full
browser acceptance is recorded separately after the Chromium rebuild.

## Optional Mac host compiler for Linux C/C++

On this Apple Silicon host, a current AArch64 `capture_state.cc` compilation
was 15.75 seconds in the x86 container, 2.84 seconds using the same-revision
Mac ARM64 Clang cross compiler, and 3.46 seconds through the Docker-to-Mac
relay. All three ELF objects had the exact same SHA-256. This is a scoped
translation-unit measurement, not a promise of full-build speed; see
[the measurement](../docs/evidence/host-cross-compile.json).

The optional `linux-arm64-host-cc` profile adds an explicit GN `cc_wrapper`.
It sends explicit AArch64 and x64 Linux `-c` commands to Mac. The x64 host-tool
profile was also checked with a protobuf C++ translation unit: its object was
byte-identical to the container's Linux compiler output. Generator execution,
Rust, PCM module compilation (`-emit-module`), other targets and linking remain on the container's
pinned Linux toolchain. The source and output remain in the same mounted
checkout. Existing cache files are retained; changing the GN wrapper can
invalidate compiler command hashes and require recompilation.

```sh
python3 docker/host-cc-server.py \
  --source /absolute/independent/chromium/src \
  --compiler-dir /absolute/mac/chromium/src/third_party/llvm-build/Release+Asserts/bin \
  --control /absolute/host-cc-control --jobs 9
```

The service binds Mac loopback and generates a private connection key. Add
`-e REMOTE_PAINT_HOST_CC=1 -v /absolute/host-cc-control:/cc-control:ro` to the
builder and use `BUILD_JOBS=9`. The service must remain running while the
builder uses this profile. `native/prepare.mjs` selects the exact checked-in
arguments; the build receipt records the profile, Mac compiler SHA/version,
actual ARM64 browser/test hashes and native source hashes. Runtime acceptance
recognizes both explicit profiles and still checks the actual ELF binaries.
The normal Linux profile is available by omitting `REMOTE_PAINT_HOST_CC`.
