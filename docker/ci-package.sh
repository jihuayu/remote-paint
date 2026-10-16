#!/bin/bash
set -euo pipefail
cd /project
case "$TARGET_CPU" in
  arm64) triple=aarch64-unknown-linux-gnu; node_arch=arm64 ;;
  x64) triple=x86_64-unknown-linux-gnu; node_arch=x64 ;;
  *) exit 2 ;;
esac
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
export CARGO_TARGET_DIR=/chromium/broker-target
npm ci
npm test
npm run native:broker -- --target "$triple"
cd /chromium/src
buildtools/linux64/gn gen out/RemotePaintLinux \
  --script-executable=/chromium/src/third_party/cpython3/linux-amd64/bin/python3
ninja -C out/RemotePaintLinux -j"${BUILD_JOBS:-4}" generate_headless_shell_license_file
# These are cross-built on x64; the matching-architecture smoke job executes them.
mkdir -p /chromium/node-runtime
cd /chromium/node-runtime
curl --fail --location --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o SHASUMS256.txt
archive=$(awk -v arch="$node_arch" '$2 ~ ("^node-v22[.][0-9.]+-linux-" arch "[.]tar[.]xz$") { print $2 }' SHASUMS256.txt)
test -n "$archive"
curl --fail --location --retry 3 "https://nodejs.org/dist/latest-v22.x/$archive" -o "$archive"
awk -v file="$archive" '$2==file' SHASUMS256.txt | sha256sum --check
tar -xJf "$archive"
node_dir="/chromium/node-runtime/${archive%.tar.xz}"
cd /project
node native/package-linux.mjs --source /chromium/src --cpu "$TARGET_CPU" \
  --broker "/project/native/bin/$triple/remote-paint-broker" \
  --node-dir "$node_dir" --destination /packages
