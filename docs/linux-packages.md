# Linux packages

Download `remote-paint-linux-arm64` or `remote-paint-linux-x86_64` from the
**Artifacts** section of a successful **Linux packages** GitHub Actions run.
x86 means 64-bit x86_64/amd64, not 32-bit i386. Unzip the Actions artifact,
verify the outer checksum with `sha256sum -c *.tar.gz.sha256`, then extract
the tar archive. Executable permissions are preserved inside the tar.

The package includes the patched Chromium headless browser, serializer tests,
native Rust Broker, Node.js 22, application dependencies, CanvasKit/Viewer,
demo fixtures, build provenance and checksums. No build tools or npm install
are required at runtime. Linux glibc distributions are supported; Alpine/musl
is not. Use Debian 12+ or Ubuntu 24.04+.

Install the system libraries once (Debian 12; Ubuntu 24.04 uses the equivalent
`t64` packages where applicable):

```sh
sudo apt-get update
sudo apt-get install -y libnss3 libglib2.0-0 libdbus-1-3 libatk1.0-0 \
  libatk-bridge2.0-0 libx11-6 libx11-xcb1 libxcomposite1 libxdamage1 \
  libxext6 libxfixes3 libxrandr2 libxkbcommon0 libdrm2 libgbm1 \
  libpango-1.0-0 libasound2 libatspi2.0-0 libudev1 libcups2 \
  fonts-dejavu-core fonts-noto-cjk fonts-noto-color-emoji
cd remote-paint-linux-*
sha256sum -c SHA256SUMS
./start.sh --port 4176
# Or capture another ordinary page:
./start.sh --port 4176 --url https://example.com
```

Open the full Viewer URL printed by the launcher, including its fragment key.
The default bind address is loopback. For Docker, map both 4176 and 4177 and
pass `--host 0.0.0.0`. Use `docker/Dockerfile.runtime` for a matching Debian
runtime with dependencies installed. The current browser harness disables its
sandbox and is an experimental development runtime; use disposable containers
for untrusted source pages. Physical display/IME and GPU raster are outside
the software-compositing acceptance scope.

`BUILD.json`, `browser/remote-paint-build.json`, and `SHA256SUMS` identify the
source revision and actual browser, Broker and Node executables. A successful
build alone is separate from the Linux-to-Mac latency acceptance results.

## GitHub Actions builds

The public workflow uses two independent x86_64 build runners to cross-build
ARM64 and build x86_64 natively with Debian 12 toolchains. Extracted packages
then receive serializer, native browser, and dynamic Broker/Worker Viewer checks on their matching
`ubuntu-24.04-arm` / `ubuntu-24.04` runners. The package artifacts remain
available if a later smoke test fails; check the complete run result.

The workflow explicitly passes CHROMIUM_OUTPUT=out/RemotePaintLinux to checkout, compilation and packaging so its existing architecture-specific cache is reused intentionally. Local builds should choose their own out/name. prepare.mjs, Linux receipt generation and package-linux.mjs require --output; new format-2 receipts bind that selection, and packaging rejects an unbound legacy receipt. Historical format-1 runtime receipt validation remains available. This plumbing does not qualify the current uncommitted source set as a release or replace any retained local browser.

Both compilation and the final no-pending-work receipt use checksum-pinned
Ninja 1.13.2. Debian 12's system Ninja 1.11.1 repeatedly schedules unchanged
generators behind GN phony input groups and cannot reliably finish that check.
Keep the build image's `/usr/local/bin` ahead of depot_tools and `/usr/bin`.
The build and receipt entry points reject other Ninja versions before opening
the output graph, since even an incompatible dry run can discard its build log.

Start **Linux packages → Run workflow**, or push a `v*` tag. Artifacts are kept
for 30 days. A fresh patched Chromium build can exceed a hosted runner's
six-hour job limit. Compilation stops at 245 minutes to allow saving the
architecture-specific Ninja output through `actions/cache`, even on failure.
Rerun the workflow to continue from that cache; incomplete builds never produce
a release package. The next run shallow-syncs the same pinned sources and
normalizes unchanged upstream timestamps before reusing the incremental graph.
Fallback caches also work across native code changes: project-owned and patched
inputs receive fresh timestamps so Ninja rebuilds them and their dependents.
The v2 cache namespace uses Ninja 1.13.2; older system-Ninja logs are not mixed
into it. Output caches are separated by architecture and build/toolchain profile.
Caches are subject to GitHub quota/eviction and are separate from this Mac's
persistent build volume, which the workflow does not access or modify.
