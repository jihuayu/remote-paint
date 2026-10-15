# Linux ARM64 browser build on Apple Silicon

This build runs Chromium's Linux x86_64 host toolchain in an amd64 Docker builder (OrbStack/Rosetta on this Mac) and produces an ARM64 Linux browser for a native ARM64 runtime container. It never runs the macOS executable inside Linux.

Use an **independent** checkout of Chromium `a49e2e3d4addfd84e765b52afe230bedb81096db`, with its pinned dependencies synced for Linux. The LLVM/Rust packages and sysroots are platform specific: do not mount the active Mac checkout here. The browser and tests use `out/RemotePaintLinux`, separate from `out/RemotePaint`.

```sh
docker build --platform linux/amd64 -t remote-paint-build:linux-arm64 -f docker/Dockerfile.build .
docker run --name remote-paint-linux-build --platform linux/amd64 --init \
  --shm-size=2g --memory=12g --cpus=8 \
  -v /absolute/independent/chromium:/chromium \
  -v /absolute/remote-paint:/project:ro \
  remote-paint-build:linux-arm64 /project/docker/build-linux.sh
```

`BUILD_JOBS` defaults to four and can be set to reduce memory pressure. The script downloads the pinned Linux toolchain, GN and both host/target sysroots, applies the existing Remote Paint patches, generates GN and builds `headless_shell` plus the serializer tests. The ARM64 test binary must execute in the ARM64 runtime rather than the x86_64 builder. The standalone macOS/CoreText helper is not used.

This is the build harness. Runtime/BeginFrame acceptance is recorded separately; preparing an image or generating the build graph does not establish that the Linux drawing path works.
