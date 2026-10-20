#!/bin/bash
set -euo pipefail
: "${CHROMIUM_OUTPUT:?Set CHROMIUM_OUTPUT to an explicit out/name}"
cd /chromium
cat > .gclient <<'EOF'
solutions = [{
  'name': 'src',
  'url': 'https://chromium.googlesource.com/chromium/src.git',
  'managed': False,
  'custom_deps': {'src/third_party/wayland-protocols/gtk': None},
  'custom_vars': {
    'checkout_pgo_profiles': False,
    'checkout_configuration': 'small',
    'checkout_js_coverage_modules': False,
    'checkout_android': False,
    'checkout_fuchsia': False,
    'checkout_ios': False,
  },
}]
target_os = ['linux']
EOF
if [ ! -d src/.git ]; then
  mkdir -p src
  git -C src init
  git -C src remote add origin https://chromium.googlesource.com/chromium/src.git
  git -C src fetch --depth=1 origin a49e2e3d4addfd84e765b52afe230bedb81096db
  git -C src checkout --detach FETCH_HEAD
fi
gclient sync --no-history --nohooks --jobs=8 --revision src@a49e2e3d4addfd84e765b52afe230bedb81096db
gclient runhooks
# Output may be restored without the source tree. Reapply patches to fresh source.
output_dir=$(node /project/native/chromium-output.mjs /chromium/src "$CHROMIUM_OUTPUT")
rm -f "$output_dir/remote-paint-patches.json"
node /project/native/prepare.mjs /chromium/src "linux-$TARGET_CPU" --output "$CHROMIUM_OUTPUT"
# Restored Ninja objects must see unchanged source headers as unchanged even
# after a fresh shallow sync. Generated output keeps its original timestamps.
find src -type d \( -name .git -o -path src/out \) -prune -o \
  -type f -exec touch -d @1600000000 {} +
# Native/patch inputs may have changed since a fallback output cache. Refresh
# their timestamps after normalization so Ninja cannot reuse stale objects.
python3 /project/docker/ci-source-times.py /chromium/src /project
df -h /chromium
