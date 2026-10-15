#!/bin/sh
set -eu
# Mount an independent pinned checkout at /chromium, and this repo at /project.
# Do not share a Mac checkout's platform-specific toolchain directories.
cd /chromium/src
python3 tools/clang/scripts/update.py --host-os linux
python3 tools/rust/update_rust.py
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
node /project/native/prepare.mjs /chromium/src linux-arm64
mkdir -p out/RemotePaintLinux
cp /project/native/linux-arm64.args.gn out/RemotePaintLinux/args.gn
buildtools/linux64/gn gen out/RemotePaintLinux \
  --script-executable=/chromium/src/third_party/cpython3/linux-amd64/bin/python3
ninja -C out/RemotePaintLinux -j"${BUILD_JOBS:-4}" remote_paint_tools
ninja -C out/RemotePaintLinux -j"${BUILD_JOBS:-4}" headless_shell
