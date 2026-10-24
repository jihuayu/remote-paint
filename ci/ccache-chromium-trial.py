"""Measure GN cc_wrapper on a fresh, bounded Chromium serializer target.

The retained production output and its commands are not changed. This runs only
after publishing a server archive and only with sufficient hosted-job budget.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import time
spec = importlib.util.spec_from_file_location('ccache_probe', pathlib.Path(__file__).with_name('ccache-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    target = os.environ['TARGET_CPU']
    if target not in ('x64', 'arm64'):
        raise ValueError('Unsupported trial target')
    source = pathlib.Path('/chromium/src')
    production = source / os.environ['CHROMIUM_OUTPUT']
    if (production.parent != source / 'out' or production.name == 'RemotePaintCcacheTrial'
            or production.is_symlink() or not production.is_dir()):
        raise ValueError('Expected a separate production out/name directory')
    output = source / 'out/RemotePaintCcacheTrial'
    if output.exists() or output.is_symlink():
        raise ValueError('ccache trial requires its own new output directory')
    compiler = source / 'third_party/llvm-build/Release+Asserts/bin/clang++'
    compiler_sha = sha(compiler)
    cache = pathlib.Path('/ccache') / target / compiler_sha
    cache.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith('CCACHE_')}
    env.update(CCACHE_DIR=str(cache), CCACHE_CONFIGPATH='/project/ci/ccache.conf',
               CCACHE_SLOPPINESS='', CCACHE_NAMESPACE='chromium-tools')
    proof = pathlib.Path('/proof')
    proof.mkdir(exist_ok=True)
    report = {'scope': 'Chromium remote_paint_tools target; not full headless_shell',
              'target': target, 'compilerSha256': compiler_sha, 'wrapper': 'ccache',
              'productionOutputUnchanged': None, 'measurements': [], 'status': 'started'}
    production_names = ('args.gn', 'build.ninja', '.ninja_log', '.ninja_deps',
                        'remote-paint-patches.json', 'remote-paint-source-inputs-v1.json.gz',
                        'remote-paint-source-recipe-v1.json', 'remote-paint-build.json',
                        'headless_shell', 'serializer_tests')
    before_production = {name: sha(production / name) for name in production_names}

    def record():
        report['recordedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        (proof / 'chromium-ccache.json').write_text(json.dumps(report, indent=2) + '\n')

    def run(*args):
        return subprocess.check_output(args, cwd=source, env=env, text=True)

    record()
    try:
        subprocess.check_call(['node', '/project/native/prepare.mjs', str(source), 'linux-' + target,
                               '--output', 'out/RemotePaintCcacheTrial', '--patch-state-from',
                               os.environ['CHROMIUM_OUTPUT']], env=env)
        args = output / 'args.gn'
        with args.open('a') as stream:
            stream.write('\ncc_wrapper = "ccache"\n')
        subprocess.check_call([str(source / 'buildtools/linux64/gn'), 'gen', str(output),
                               '--script-executable=' + str(source / 'third_party/cpython3/linux-amd64/bin/python3')],
                              cwd=source, env=env)

        def compile_one(phase):
            before = probe.counters(run('ccache', '--print-stats'))
            report['status'] = phase
            record()
            started = time.monotonic()
            subprocess.check_call(['ninja', '-C', str(output), '-j4', 'remote_paint_tools'],
                                  cwd=source, env=env)
            measurement = {'phase': phase, 'seconds': time.monotonic() - started,
                           'delta': probe.delta(before, probe.counters(run('ccache', '--print-stats')))}
            report['measurements'].append(measurement)
            record()
            return measurement

        first = compile_one('fresh-output-cold-or-restored-cache')
        old = {p.relative_to(output).as_posix(): sha(p) for p in output.rglob('*.o') if p.is_file()}
        if not old:
            raise ValueError('The real Chromium trial did not produce C++ objects')
        for name in old:
            (output / name).unlink()
        executable = output / 'serializer_tests'
        if executable.is_symlink():
            raise ValueError('Unexpected serializer executable link')
        executable.unlink()
        second = compile_one('object-removal-warm-replay')
        hits = second['delta']['direct_cache_hit'] + second['delta']['preprocessed_cache_hit']
        if hits <= 0:
            raise ValueError('No ccache hits observed for real Chromium C++ commands')
        matched = sum((output / name).is_file() and sha(output / name) == digest for name, digest in old.items())
        if matched != len(old):
            raise ValueError('Replayed Chromium objects differ from the first compilation')
        raw = executable.read_bytes()[:20]
        expected = 183 if target == 'arm64' else 62
        if raw[:6] != b'\x7fELF\x02\x01' or int.from_bytes(raw[18:20], 'little') != expected:
            raise ValueError('Wrong serializer executable architecture')
        report.update(status='passed', objectCount=len(old), identicalReplayedObjects=matched,
                      serializerElfMachine=expected,
                      measuredTargetReplayRatio=first['seconds'] / second['seconds'],
                      fullBrowserSpeedupProven=False)
        record()
    except Exception as error:
        report.update(status='failed', error=str(error))
        record()
        raise
    finally:
        after_production = {name: sha(production / name) for name in production_names}
        report['productionOutputUnchanged'] = before_production == after_production
        report['productionFileSha256'] = after_production
        record()
        if not report['productionOutputUnchanged']:
            raise ValueError('The isolated trial modified production output')
        (proof / 'chromium-ccache-stats.txt').write_text(run('ccache', '--show-stats'))
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
