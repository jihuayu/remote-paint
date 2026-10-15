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
node /project/native/prepare.mjs /chromium/src linux-arm64
mkdir -p out/RemotePaintLinux
cp /project/native/linux-arm64.args.gn out/RemotePaintLinux/args.gn
buildtools/linux64/gn gen out/RemotePaintLinux \
  --script-executable=/chromium/src/third_party/cpython3/linux-amd64/bin/python3
ninja -C out/RemotePaintLinux -j"${BUILD_JOBS:-4}" remote_paint_tools
ninja -C out/RemotePaintLinux -j"${BUILD_JOBS:-4}" headless_shell
