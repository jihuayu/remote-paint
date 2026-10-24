"""Rehydrate a fresh CI checkout only from byte-checked, recipe-bound input times.

This is intentionally conservative: an incomplete receipt or any differing input
requires a fresh cache namespace. It never adopts old objects by backdating new
or unverified source. Run after all hooks/tool updates and before GN or Ninja.
"""
import gzip
import hashlib
import json
import os
import pathlib
import re
import shutil
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time

RECEIPT = 'remote-paint-source-inputs-v1.json.gz'
MAX_RECEIPT_BYTES = 192 * 1024 * 1024
MAX_INPUTS = 1_000_000
NINJA_VERSION = '1.13.2'


def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def recipe(source, project, output, target):
    # Check before opening the output directory or a retained Ninja graph/log.
    if run('ninja', '--version') != NINJA_VERSION:
        raise ValueError('CI source timestamps require Ninja ' + NINJA_VERSION)
    if target not in ('arm64', 'x64'):
        raise ValueError('Expected TARGET_CPU=arm64 or x64')
    if run('git', 'rev-parse', 'HEAD', cwd=source) != 'a49e2e3d4addfd84e765b52afe230bedb81096db':
        raise ValueError('Expected pinned Chromium revision')
    names = set()
    for pattern in ('docker/*', 'native/*.mjs', 'native/*.args.gn',
                    'native/patches/*.patch', 'native/chromium/*'):
        names.update(p.relative_to(project).as_posix()
                     for p in project.glob(pattern) if p.is_file())
    return {
        'format': 1, 'target': target, 'source': str(source),
        'output': output.relative_to(source).as_posix(),
        'argsSha256': digest_file(output / 'args.gn'),
        'project': {name: digest_file(project / name) for name in sorted(names)},
        # Sources include all downloaded compilers, sysroots and generators.
        # Bind tools/libraries outside that tree as well. An image ID would vary
        # on a fresh Docker build despite identical installed package versions.
        'hostTools': {name: digest_file(pathlib.Path(shutil.which(name)).resolve())
                      for name in ('ninja', 'python3', 'node')},
        'hostPackages': run('dpkg-query', '-W', '-f=${Package}=${Version}\n'),
        'depotTools': run('git', '-C', '/opt/depot_tools', 'rev-parse', 'HEAD'),
        'hostCC': os.environ.get('REMOTE_PAINT_HOST_CC', ''),
    }


def source_inputs(source):
    entries = {}
    for parent, dirs, files in os.walk(source, followlinks=False):
        directory = pathlib.Path(parent)
        # VCS state and interpreter caches are not Chromium build inputs. Never
        # inspect any output directory, including another platform's cache.
        dirs[:] = sorted(name for name in dirs if name not in ('.git', '__pycache__')
                         and not (directory == source and name == 'out'))
        links = [name for name in dirs if (directory / name).is_symlink()]
        dirs[:] = [name for name in dirs if name not in links]
        for name in sorted(files + links):
            if name.endswith(('.pyc', '.pyo')) or name == '.git':
                continue
            path = directory / name
            before = path.lstat()
            key = path.relative_to(source).as_posix()
            if stat.S_ISLNK(before.st_mode):
                kind = 'link'
                digest = hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
            elif stat.S_ISREG(before.st_mode):
                kind = 'file'
                digest = digest_file(path)
            else:
                raise ValueError('Non-file CI input: ' + key)
            after = path.lstat()
            if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                    after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('CI input changed during hashing: ' + key)
            entries[key] = [kind, digest, stat.S_IMODE(before.st_mode), before.st_mtime_ns]
            if len(entries) > MAX_INPUTS:
                raise ValueError('Too many CI source inputs')
    return entries


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate receipt field')
        result[key] = value
    return result


def load_receipt(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('Source timestamp receipt must be a regular file')
    with gzip.open(path, 'rb') as stream:
        raw = stream.read(MAX_RECEIPT_BYTES + 1)
    if len(raw) > MAX_RECEIPT_BYTES:
        raise ValueError('Source timestamp receipt too large')
    value = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(value, dict) or set(value) != {'format', 'recipeSha256', 'inputs'} or type(value['format']) is not int or value['format'] != 1:
        raise ValueError('Invalid source timestamp receipt')
    if not isinstance(value['recipeSha256'], str) or not re.fullmatch('[a-f0-9]{64}', value['recipeSha256']):
        raise ValueError('Invalid recipe digest')
    if not isinstance(value['inputs'], dict) or not 0 < len(value['inputs']) <= MAX_INPUTS:
        raise ValueError('Invalid source timestamp inputs')
    for key, record in value['inputs'].items():
        if (not isinstance(key, str) or not key or key.startswith('/')
                or any(part in ('', '.', '..') for part in key.split('/'))
                or not isinstance(record, list) or len(record) != 4
                or record[0] not in ('file', 'link')
                or not isinstance(record[1], str) or not re.fullmatch('[a-f0-9]{64}', record[1])
                or type(record[2]) is not int or not 0 <= record[2] <= 0o7777
                or type(record[3]) is not int or not 0 < record[3] < 2**63):
            raise ValueError('Invalid source timestamp entry')
    return value


def atomic_file(path, data):
    fd, temporary = tempfile.mkstemp(prefix='.source-evidence-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # Replacing a link replaces that link, never its possible outside target.
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def synchronize(source, output, build_recipe):
    source = pathlib.Path(source)
    output = pathlib.Path(output)
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Source must be a real directory')
    # The shell uses chromium-output.mjs too; enforce its contract independently.
    relative = output.relative_to(source).as_posix()
    if not re.fullmatch(r'out/[A-Za-z0-9][A-Za-z0-9._-]{0,95}', relative):
        raise ValueError('Pass explicit out/name')
    if (source / 'out').is_symlink() or output.is_symlink() or not output.is_dir():
        raise ValueError('Output must be a real directory')
    receipt_path = output / RECEIPT
    recipe_hash = hashlib.sha256(canonical(build_recipe)).hexdigest()
    restored = receipt_path.exists() or receipt_path.is_symlink()
    previous = load_receipt(receipt_path) if restored else None
    if previous is None:
        # Before GN/Ninja, prepare.mjs has only written these two files. Anything
        # else may contain older products and must never acquire a new receipt.
        if any(p.name not in ('args.gn', 'remote-paint-patches.json') or not p.is_file()
               or p.is_symlink() for p in output.iterdir()):
            raise ValueError('Unattested output: use a fresh CI cache namespace')
    elif previous['recipeSha256'] != recipe_hash:
        raise ValueError('Build recipe changed: use a fresh CI cache namespace')
    inputs = source_inputs(source)
    if not inputs:
        raise ValueError('Empty CI source tree')
    if previous is not None:
        old = previous['inputs']
        different = sorted(set(old) ^ set(inputs))
        different += [key for key in inputs.keys() & old.keys()
                      if inputs[key][:3] != old[key][:3]]
        if different:
            raise ValueError('Source bytes/path/mode changed; fresh output required: '
                             + ', '.join(sorted(different)[:8]))
        # Validate the entire receipt and every current byte before any utime.
        for key, record in inputs.items():
            path = source / key
            os.utime(path, ns=(path.lstat().st_atime_ns, old[key][3]), follow_symlinks=False)
            if path.lstat().st_mtime_ns != old[key][3]:
                raise ValueError('Filesystem did not preserve nanosecond timestamp: ' + key)
            record[3] = old[key][3]
    receipt = {'format': 1, 'recipeSha256': recipe_hash, 'inputs': inputs}
    payload = canonical(receipt)
    if len(payload) > MAX_RECEIPT_BYTES:
        raise ValueError('Source timestamp receipt too large')
    fd, temporary = tempfile.mkstemp(prefix='.source-inputs-', dir=output)
    try:
        with os.fdopen(fd, 'wb') as stream:
            with gzip.GzipFile(fileobj=stream, mode='wb', mtime=0) as zipped:
                zipped.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, receipt_path)
        directory_fd = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    atomic_file(output / 'remote-paint-source-recipe-v1.json', canonical(build_recipe))
    result = {'format': 1, 'mode': 'restored' if restored else 'seeded',
              'inputs': len(inputs), 'recipeSha256': recipe_hash,
              'receiptSha256': digest_file(receipt_path)}
    print(json.dumps(result), flush=True)
    return result


def diagnose(output, targets=('remote_paint_tools', 'headless_shell'), timeout=90, limit=128 * 1024):
    """Bound both the observation time and retained output, then reap the dry run."""
    if run('ninja', '--version') != NINJA_VERSION:
        raise ValueError('CI Ninja diagnostics require Ninja ' + NINJA_VERSION)
    output = pathlib.Path(output)
    started = time.monotonic()
    sample = bytearray()
    total = 0
    timed_out = False
    process = subprocess.Popen(['ninja', '-C', str(output), '-n', '-d', 'explain', *targets],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True)
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            while selector.get_map():
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    timed_out = True
                    break
                for key, _ in selector.select(min(remaining, .5)):
                    block = os.read(key.fd, 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        total += len(block)
                        sample.extend(block[:max(0, limit - len(sample))])
        finally:
            if not timed_out:
                try:
                    process.wait(timeout=max(.001, timeout - (time.monotonic() - started)))
                except subprocess.TimeoutExpired:
                    timed_out = True
            if process.poll() is None:
                # A dry run is owned only by this diagnostic, never a compiler.
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
            process.stdout.close()
    # Observation failure never means an existing compile has stopped. The real
    # compile step retains its 245m budget, including preparation and this probe.
    atomic_file(output / 'remote-paint-ninja-diagnostics.log', sample)
    result = {'format': 1, 'ninjaVersion': NINJA_VERSION, 'targets': list(targets),
              'exitCode': process.returncode, 'timedOut': timed_out,
              'totalObservedBytes': total, 'retainedBytes': len(sample),
              'truncated': total > len(sample) or timed_out,
              'seconds': time.monotonic() - started,
              'sampleSha256': hashlib.sha256(sample).hexdigest()}
    atomic_file(output / 'remote-paint-ninja-diagnostics.json', canonical(result))
    print(json.dumps(result), flush=True)
    return result


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--diagnose':
        diagnose(sys.argv[2])
    else:
        if len(sys.argv) != 5:
            raise SystemExit('Usage: ci-source-times.py SOURCE PROJECT out/name arm64|x64')
        source, project = map(pathlib.Path, sys.argv[1:3])
        output = source / sys.argv[3]
        synchronize(source, output, recipe(source, project, output, sys.argv[4]))
