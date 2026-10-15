# Linux ARM64 browser build on Apple Silicon

This build runs Chromium's Linux x86_64 host toolchain in an amd64 Docker builder (OrbStack/Rosetta on this Mac) and produces an ARM64 Linux browser for a native ARM64 runtime container. It never runs the macOS executable inside Linux.

Use an **independent** checkout of Chromium `a49e2e3d4addfd84e765b52afe230bedb81096db`, with its pinned dependencies synced for Linux. The LLVM/Rust packages and sysroots are platform specific: do not mount the active Mac checkout here. The browser and tests use `out/RemotePaintLinux`, separate from `out/RemotePaint`.

```sh
docker build --platform linux/amd64 -t remote-paint-build:linux-arm64 -f docker/Dockerfile.build .
docker run --name remote-paint-linux-build --platform linux/amd64 --init \
  --shm-size=2g --memory=48g --memory-swap=48g --cpus=9 -e BUILD_JOBS=12 \
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

Keep the same source mount and output directory to retain the incremental
cache. Object files, static libraries, generated sources, `.ninja_log` and
`.ninja_deps` live in `src/out/RemotePaintLinux` on the Mac. Downloaded LLVM,
Rust, GN and sysroots also live in this mounted checkout. Stopping or replacing
the builder container preserves these files. Resume a stopped builder with
`docker start -a remote-paint-linux-build`; do not clean the output directory or
prune the mounted checkout. This is Ninja's persistent incremental cache, not a
configured ccache/sccache service. Docker image/build layers are retained too.

This is the build harness. Runtime/BeginFrame acceptance is recorded separately; preparing an image or generating the build graph does not establish that the Linux drawing path works.

## Native runtime and Mac acceptance

Build the runtime for ARM64 and mount the entire output directory, including
Chromium's data files. Publish only the Viewer port on Mac loopback:

```sh
docker build --platform linux/arm64 -t remote-paint-runtime:linux-arm64 -f docker/Dockerfile.runtime .
mkdir -p artifacts/linux-mac
docker run --name remote-paint-linux --platform linux/arm64 --init --shm-size=2g \
  -p 127.0.0.1:4176:4176 \
  -v /absolute/independent/chromium/src/out/RemotePaintLinux:/browser:ro \
  -v /absolute/remote-paint:/project:ro \
  -v /absolute/remote-paint/artifacts:/project/artifacts \
  remote-paint-runtime:linux-arm64 node tests/serve-linux-proof.mjs
# Run this on the Mac host, in the project directory:
npm run verify:linux-mac
```

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
Reports are written under `artifacts/linux-mac`; the physical OS IME candidate
window is outside the automated test's scope.

For an ordinary demo without the private proof channel, use the image's default
command instead of `node tests/serve-linux-proof.mjs`.
