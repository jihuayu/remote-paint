#!/bin/sh
set -eu
# Older Ninja versions can discard a newer cached build log even on -n.
# Reject them before updating inputs or opening the retained output graph.
if [ "$(ninja --version)" != 1.13.2 ]; then
  echo 'Linux builds require pinned Ninja 1.13.2 from docker/Dockerfile.build' >&2
  exit 2
fi
# Mount an independent pinned checkout at /chromium, and this repo at /project.
# Do not share a Mac checkout's platform-specific toolchain directories.
project=${PROJECT_ROOT:-/project}
source=${CHROMIUM_SOURCE:-/chromium/src}
target=${TARGET_CPU:-arm64}
: "${CHROMIUM_OUTPUT:?Set CHROMIUM_OUTPUT to an explicit out/name}"
output_dir=$(node "$project/native/chromium-output.mjs" "$source" "$CHROMIUM_OUTPUT")
case "$target" in arm64|x64) ;; *) echo "Unsupported TARGET_CPU: $target" >&2; exit 2 ;; esac
cd "$source"
python3 tools/clang/scripts/update.py --host-os linux
python3 tools/rust/update_rust.py
if [ ! -f third_party/llvm-libclang/lib/libclang.so ]; then
  curl --fail --location --retry 3 \
    'https://storage.googleapis.com/chromium-browser-clang/Linux_x64/rust-libclang-1edd55dcfcd573872c727fa3e086369a71661ee0-1-llvmorg-24-init-7747-g62397f8b.tar.xz' \
    -o /tmp/remote-paint-libclang.tar.xz
  printf '%s  %s\n' bddbd5de33e5289703e61a65d51de735fd6b589a81c8db47f98b3f7894600577 /tmp/remote-paint-libclang.tar.xz | sha256sum --check
  mkdir -p third_party/llvm-libclang
  tar -xJf /tmp/remote-paint-libclang.tar.xz -C third_party/llvm-libclang
fi
python3 build/linux/sysroot_scripts/install-sysroot.py --arch amd64
python3 build/linux/sysroot_scripts/install-sysroot.py --arch arm64
mkdir -p buildtools/linux64
if [ ! -x buildtools/linux64/gn ]; then
  curl --fail --location --retry 3 'https://chrome-infra-packages.appspot.com/dl/gn/gn/linux-amd64/+/git_revision:cfcd774b98f3433e18b722f9a7ff06119825b8eb' -o /tmp/remote-paint-gn.zip
  unzip -o /tmp/remote-paint-gn.zip gn -d buildtools/linux64
  chmod +x buildtools/linux64/gn
fi
# Crubit's generated C++ headers depend on the DEPS-pinned Linux formatter.
# A checkout synced on macOS does not fetch this host-only GCS dependency.
format_path=buildtools/linux64-format/clang-format
format_sha=5d384f2a3e72f01c5c61dd07e3a2577723cfa20c8c019131467f00fb6da8a75c
if ! printf '%s  %s\n' "$format_sha" "$format_path" | sha256sum --check --status; then
  curl --fail --location --retry 3 \
    'https://storage.googleapis.com/chromium-clang-format/f5485c39451137ee943021a0fb63738b306c5026' \
    -o /tmp/remote-paint-clang-format
  printf '%s  %s\n' "$format_sha" /tmp/remote-paint-clang-format | sha256sum --check
  mkdir -p buildtools/linux64-format
  install -m 755 /tmp/remote-paint-clang-format "$format_path"
fi
if [ ! -x third_party/gperf/cipd/bin/gperf ]; then
  curl --fail --location --retry 3 \
    'https://chrome-infra-packages.appspot.com/dl/infra/3pp/tools/gperf/linux-amd64/+/version:3@3.2' \
    -o /tmp/remote-paint-gperf.zip
  mkdir -p third_party/gperf/cipd
  unzip -o /tmp/remote-paint-gperf.zip -d third_party/gperf/cipd
  chmod +x third_party/gperf/cipd/bin/gperf
fi
# DevTools pins a patched esbuild in its own DEPS. A Mac-synced checkout
# contains a Mach-O binary here even when Chromium's Linux Node is present.
esbuild_dir=third_party/devtools-frontend/src/third_party/esbuild
esbuild_sha=5b354621aca49a8b134cb339ea00d666bff3b35afd4f7a1e516fe7a2c0fae4f7
if ! printf '%s  %s\n' "$esbuild_sha" "$esbuild_dir/esbuild" | sha256sum --check --status; then
  curl --fail --location --retry 3 \
    'https://chrome-infra-packages.appspot.com/dl/infra/3pp/tools/esbuild/linux-amd64/+/version:3@0.28.2.chromium.2' \
    -o /tmp/remote-paint-esbuild.zip
  mkdir -p "$esbuild_dir"
  unzip -o /tmp/remote-paint-esbuild.zip -d "$esbuild_dir"
  printf '%s  %s\n' "$esbuild_sha" "$esbuild_dir/esbuild" | sha256sum --check
  chmod +x "$esbuild_dir/esbuild"
fi
node "$project/native/prepare.mjs" "$source" "linux-$target" --output "$CHROMIUM_OUTPUT"
buildtools/linux64/gn gen "$output_dir" \
  --script-executable="$source/third_party/cpython3/linux-amd64/bin/python3"
ninja -C "$output_dir" -j"${BUILD_JOBS:-4}" remote_paint_tools
ninja -C "$output_dir" -j"${BUILD_JOBS:-4}" headless_shell
node "$project/native/linux-receipt.mjs" "$source" --output "$CHROMIUM_OUTPUT"
