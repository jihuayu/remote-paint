"""Exercise the pinned Clang/target through ccache without changing Ninja args.

This is a mechanism/compatibility measurement, not a full Chromium benchmark.
Keep the restored Ninja objects on their original compiler command. Enabling
GN's cc_wrapper on those objects would rebuild them with a cold compiler cache.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import time

COUNTER_IDS = ('direct_cache_hit', 'preprocessed_cache_hit', 'cache_miss')


def counters(text):
    result = {}
    for line in text.splitlines():
        key, value = line.split('\t')
        result[key] = int(value)
    return result


def delta(before, after):
    # ccache 4.7.5 core/Statistics.cpp exposes these exact --print-stats IDs.
    # An unknown schema must fail rather than turn genuine hits into zeros.
    for snapshot in (before, after):
        missing = set(COUNTER_IDS) - snapshot.keys()
        if missing:
            raise ValueError('Missing ccache statistics IDs: ' + ', '.join(sorted(missing)))
    result = {key: after[key] - before[key] for key in COUNTER_IDS}
    if any(value < 0 for value in result.values()):
        raise ValueError('ccache statistics reset during a measurement')
    return result


def main():
    target = os.environ['TARGET_CPU']
    if target not in ('x64', 'arm64'):
        raise ValueError('Unsupported probe target')
    compiler = pathlib.Path('/chromium/src/third_party/llvm-build/Release+Asserts/bin/clang++')
    compiler_sha = hashlib.sha256(compiler.read_bytes()).hexdigest()
    cache_dir = pathlib.Path('/ccache') / target / compiler_sha
    cache_dir.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith('CCACHE_')}
    env.update(CCACHE_DIR=str(cache_dir), CCACHE_CONFIGPATH='/project/ci/ccache.conf', CCACHE_SLOPPINESS='')
    root = pathlib.Path('/tmp/remote-paint-ccache-probe')
    root.mkdir()
    (root / 'probe.cc').write_text('#include "value.h"\nextern "C" long long probe(){return VALUE;}\n')
    header = root / 'value.h'
    header.write_text('#define VALUE 17\n')
    time.sleep(1.1)  # Keep strict protection against newly-created headers.
    triple = 'aarch64-linux-gnu' if target == 'arm64' else 'x86_64-linux-gnu'
    command = ['ccache', str(compiler), '--target=' + triple, '-std=c++20', '-O2',
               '-MMD', '-MF', 'probe.d', '-c', 'probe.cc', '-o', 'probe.o']

    def run(*args):
        return subprocess.check_output(args, cwd=root, env=env, text=True)

    config = run('ccache', '--show-config')
    if not any(line.rstrip().endswith('sloppiness =') for line in config.splitlines()):
        raise ValueError('Probe requires empty sloppiness')
    measurements = []
    proof = pathlib.Path('/proof')
    proof.mkdir(exist_ok=True)
    (proof / 'ccache-config.txt').write_text(config)
    report = {'target': target, 'compilerSha256': compiler_sha,
              'compilerVersion': run(str(compiler), '--version').splitlines()[0],
              'ccacheVersion': run('ccache', '--version').splitlines()[0],
              'measurements': measurements, 'scope': 'isolated C++ fixture; full Chromium wrapper unchanged',
              'mainChromiumAccelerationProven': False, 'sloppiness': '', 'maxSize': '1G',
              'status': 'running'}

    def compile_one(label):
        before = counters(run('ccache', '--print-stats'))
        started = time.monotonic()
        subprocess.check_call(command, cwd=root, env=env)
        elapsed = time.monotonic() - started
        after = counters(run('ccache', '--print-stats'))
        # Retain raw IDs even if schema or acceptance checks fail.
        (proof / f'{label}-counters.json').write_text(json.dumps(
            {'before': before, 'after': after}, indent=2) + '\n')
        raw = (root / 'probe.o').read_bytes()
        expected = 183 if target == 'arm64' else 62
        if raw[:6] != b'\x7fELF\x02\x01' or int.from_bytes(raw[18:20], 'little') != expected:
            raise ValueError('ccache returned an object for the wrong architecture')
        measurement = {'phase': label, 'seconds': elapsed, 'delta': delta(before, after),
                       'objectSha256': hashlib.sha256(raw).hexdigest(), 'elfMachine': expected}
        measurements.append(measurement)
        return measurement

    try:
        first = compile_one('restored-or-cold')
        second = compile_one('warm-repeat')
        if sum(second['delta'][k] for k in ('direct_cache_hit', 'preprocessed_cache_hit')) != 1:
            raise ValueError('Repeated identical compilation did not hit ccache')
        if first['objectSha256'] != second['objectSha256']:
            raise ValueError('Cached output differs from the first compilation')
        changed_value = 100 + int(os.environ['GITHUB_RUN_ID']) * 1000 + int(os.environ['GITHUB_RUN_ATTEMPT'])
        header.write_text(f'#define VALUE {changed_value}LL\n')
        time.sleep(1.1)
        changed = compile_one('changed-header')
        if changed['objectSha256'] == first['objectSha256'] or changed['delta']['cache_miss'] != 1:
            raise ValueError('Changed header failed to invalidate the cache')
        report['status'] = 'passed'
    except Exception as error:
        report.update(status='failed', error=str(error))
        raise
    finally:
        report['verifiedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        (proof / 'ccache-probe.json').write_text(json.dumps(report, indent=2) + '\n')
        (proof / 'ccache-stats.txt').write_text(run('ccache', '--show-stats'))
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
