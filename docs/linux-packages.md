# Linux packages

For the additional loadable Docker server image and private Agent CDP endpoint,
see [Docker/private CDP delivery](docker-private-cdp.md). Image qualification
and NAS deployment are separate from archive upload.

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

Pull requests touching this packaging workflow, Docker recipes or Native build
inputs also run the two package builds. Draft PRs can therefore qualify their
own code without merging or creating a Release. Each successful build adds its
actual artifact download link to the run summary. A successful architecture's
smoke job runs independently even if the other build fails; an uploaded archive
does not by itself mean that architecture's runtime checks passed.

The smoke jobs execute the archive's own ELF64 Node, patched browser,
serializer tests and Rust Broker on the matching CPU. They check `start.sh`
with a real source page, loopback HTTP, packaged Viewer/Wasm assets and graceful
shutdown, then run native capture and dynamic Viewer/input/recovery acceptance.
No Playwright browser download or replacement system Chromium is used. The
Node runtime and build/runtime container share pinned Node 22.23.3; downloaded
runtime archives are verified against the official version's SHA256 list.

Both compilation and the final no-pending-work receipt use checksum-pinned
Ninja 1.13.2. Debian 12's system Ninja 1.11.1 repeatedly schedules unchanged
generators behind GN phony input groups and cannot reliably finish that check.
Keep the build image's `/usr/local/bin` ahead of depot_tools and `/usr/bin`.
The build and receipt entry points reject other Ninja versions before opening
the output graph, since even an incompatible dry run can discard its build log.

Start **Linux packages → Run workflow**, or push a `v*` tag. Artifacts are kept
for 30 days. A fresh patched Chromium build can exceed a hosted runner's
six-hour job limit. There is no fixed 245-minute compilation step timeout.
The workflow records the job start, then gives compilation the remaining time
up to 335 minutes from that start. This soft stop reserves 25 minutes for the
15-minute packaging step, cache preservation and diagnostic uploads before
GitHub's 360-minute hard limit. Checkout and source-sync time count against the
same budget. The `timeout` command stops compilation with a failing status;
`always()` steps preserve architecture-specific Ninja output even on failure.
Rerun the workflow to continue from a matching, validated cache; incomplete
builds never produce a release package. The v3 CI path no longer assigns a
constant old timestamp to a fresh source tree or touches every Native header
on each run. After checkout, hooks, pinned tool updates and preparation, it
hashes the source files, link values and permission modes, excluding all output
directories, Git internals and Python bytecode caches. Before GN or Ninja, a
fresh output records those input timestamps in
`remote-paint-source-inputs-v1.json.gz`. Compilation may then time out while the
receipt and completed objects remain available together.

On the next fresh checkout, **every** recorded input and the build recipe must
match before the script restores any timestamp. The recipe binds the target,
selected args, build/prepare scripts, Native inputs, patches, Docker recipes,
installed host package versions, actual host tool binaries and depot_tools
revision. Changed, missing, malformed or recipe-mismatched metadata is rejected
before timestamp mutation; existing output without a receipt is never adopted.
There is no fallback across Native/toolchain profiles. Downloaded compilers and
sysroots within the source tree are covered by the same byte comparison.
Local builds keep their existing behavior: this path requires the CI-only
`REMOTE_PAINT_CI_SOURCE_TIMES=1` flag.

The v3 namespace starts cold and leaves v2 caches untouched. Its first hosted
compile may still require several runs. For an explicitly rejected receipt or a
changed host package profile, select **fresh_cache** in Run workflow to skip
restoring output and seed a new cache; this does not delete prior cache entries.
Full-tree hashing cost and exact reproducibility on real hosted Chromium
checkouts remain unqualified until this change runs there. Fresh-source
fingerprints alone are not proof that a Chromium object was reused.

The first hosted v3 run exceeded the original one-million-entry manifest
limit before Ninja started. The manifest now admits up to three million
entries and 768 MiB of decoded JSON, with progress every 250,000 hashed inputs.
It still hashes and compares every input; capacity errors leave an existing
receipt unchanged. These are CI metadata bounds, separate from Viewer budgets,
runtime limits and the hosted runner's execution limit.

The workflow also runs real C++/Ninja fixtures and retains a dry-run diagnostic
before compilation: up to 128 KiB of `ninja -n -d explain`, with a 90-second
observation limit and explicit truncation/timeout status. A diagnostic timeout
is not a compile result. Source sync remains bounded at 65 minutes and the
whole build job at 360 minutes; compilation uses the remaining budget above.
Actual hosted reuse must be established from a completed resumed run and its
object/command evidence, not cache restore success alone.

Caches are subject to GitHub quota/eviction and are separate from this Mac's
persistent build volume, which the workflow does not access or modify.

The first resumed hosted run rejected reordered internal CIPD package slots
under `third_party/depot_tools/.cipd_bin`. Before the original checker runs,
`ci/restore-cipd-layout.py` matches fixed package identities and verifies every
projected payload byte, permission and symlink against the existing receipt.
Only an identical projection can restore the old slot numbering and links.
It never changes the receipt or backdates inputs; the original whole-tree and
recipe checks still run afterwards. Different payloads or package identities
remain failures. This avoids invalidating compiled objects for an installer's
internal slot ordering without accepting changed tools.

### ccache trial

The pinned Chromium revision supports GN's `cc_wrapper = "ccache"` in
[`build/toolchain/cc_wrapper.gni`](https://github.com/chromium/chromium/blob/a49e2e3d4addfd84e765b52afe230bedb81096db/build/toolchain/cc_wrapper.gni).
Adding that prefix to retained Ninja commands would recompile existing objects,
which were never inserted into a compiler cache. Keep the current continuation
on its original commands. A cold ccache cannot speed those first compilations
or the linker, and six hours is not yet a proven full-build completion time.

An isolated CI trial uses the same pinned Clang to produce the requested CPU's
ELF64 object. Debian's pinned ccache 4.7.5 lives in a separate container so the
attested build image and recipe stay unchanged. Compiler caches are separate
from Ninja output, keyed by architecture/configuration and actual compiler
content, capped at 1 GB per architecture, and saved for subsequent trials.
Fixed container paths and `compiler_check = content` are used; `sloppiness`
remains empty. No header or timestamp correctness checks are disabled.

`ccache-probe-linux-*` artifacts record first-use/restored and immediate-repeat
hit/miss deltas, elapsed seconds, identical object checksums and CPU identity.
A changed header must miss and produce a different object. These small C++
fixtures establish mechanism correctness and compatibility, not a Chromium
speedup. Full Chromium `cc_wrapper` adoption needs a separate fresh output/cache
profile after the present incremental build has delivered its package; it is
not enabled on the retained output in this workflow.
