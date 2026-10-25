"""Recreate an attested CIPD package-slot layout before strict input checking.

CIPD's parallel installer assigns numeric slots nondeterministically. This does
not waive any input check: every projected file byte/mode/link must match the
old receipt before moving anything, and build-linux.sh checks the whole tree
again before timestamp restoration. The old receipt/output are never edited.
"""
import hashlib
import datetime
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import tempfile

spec = importlib.util.spec_from_file_location(
    'ci_source_times', pathlib.Path(__file__).resolve().parents[1] / 'docker/ci-source-times.py')
times = importlib.util.module_from_spec(spec)
spec.loader.exec_module(times)
PREFIX = 'third_party/depot_tools/.cipd_bin/'
SLOTS = PREFIX + '.cipd/pkgs/'
MARKER = 'third_party/depot_tools/.disable_auto_update'
MARKER_COPY = 'remote-paint-depot-tools-disabled-v1.txt'


def restore_marker(source, output, inputs):
    """Restore the exact attested generated comment, never ignore its hash.

    The pinned toggler writes a wall-clock timestamp in this presence marker.
    A legacy receipt has only its SHA and filesystem time. Recover that public
    timestamp comment within a bounded one-second window and accept it only on
    an exact SHA match. Future caches retain the verified bytes directly.
    """
    record = inputs.get(MARKER)
    if record is None:
        return False
    path = source / MARKER
    if record[0] != 'file' or not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('Expected a regular depot_tools disable marker')
    if stat.S_IMODE(path.lstat().st_mode) != record[2]:
        raise ValueError('Disable marker mode changed')
    if path.stat().st_size > 512:
        raise ValueError('Unexpected disable-marker size')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() == record[1]:
        return False
    toggler = source / 'third_party/depot_tools/update_depot_tools_toggle.py'
    toggler_record = inputs.get(toggler.relative_to(source).as_posix())
    if (toggler.is_symlink() or not toggler_record or toggler_record[0] != 'file'
            or times.digest_file(toggler) != toggler_record[1]):
        raise ValueError('Pinned disable-marker generator changed')
    prefix = ('Disabled by ' + str(toggler) + ' at ').encode()
    if len(raw) > 512 or not raw.startswith(prefix) or not raw.endswith(b'\n'):
        raise ValueError('Unexpected disable-marker contents')
    try:
        datetime.datetime.fromisoformat(raw[len(prefix):-1].decode('ascii'))
    except (ValueError, UnicodeError):
        raise ValueError('Unexpected disable-marker timestamp') from None
    copy = output / MARKER_COPY
    if copy.exists() or copy.is_symlink():
        if not stat.S_ISREG(copy.lstat().st_mode) or copy.stat().st_size > 512:
            raise ValueError('Invalid saved disable-marker bytes')
        payload = copy.read_bytes()
        if hashlib.sha256(payload).hexdigest() != record[1]:
            raise ValueError('Saved disable-marker hash mismatch')
    else:
        center = record[3] // 1000
        payload = None
        for distance in range(1_000_001):
            for offset in ((0,) if distance == 0 else (-distance, distance)):
                seconds, micros = divmod(center + offset, 1_000_000)
                stamp = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
                if micros:
                    stamp += f'.{micros:06d}'
                candidate = prefix + stamp.encode() + b'\n'
                if hashlib.sha256(candidate).hexdigest() == record[1]:
                    payload = candidate
                    break
            if payload is not None:
                break
        if payload is None:
            raise ValueError('Cannot recover exact attested disable-marker bytes; refusing reuse')
        times.atomic_file(copy, payload)
    fd, temporary = tempfile.mkstemp(prefix='.disable-marker-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), record[2])
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def identities(inputs):
    slots = {}
    for key in inputs:
        if key.startswith(SLOTS):
            parts = key[len(SLOTS):].split('/')
            if len(parts) >= 3:
                number, identity = parts[:2]
                if not number.isdecimal() or not re.fullmatch(r'[A-Za-z0-9_-]{10,128}', identity):
                    raise ValueError('Unexpected CIPD slot path')
                slots.setdefault(number, set()).add(identity)
    if not slots or any(len(ids) != 1 for ids in slots.values()):
        raise ValueError('Ambiguous CIPD package slots')
    result = {next(iter(ids)): number for number, ids in slots.items()}
    if len(result) != len(slots):
        raise ValueError('Duplicate CIPD package identity')
    return result


def rewrite(value, mapping):
    def replace(match):
        if match[3] not in mapping:
            raise ValueError('Unknown CIPD slot')
        return match[1] + match[2] + mapping[match[3]]
    return re.sub(r'(^|/)(\.cipd/pkgs/)([0-9]+)(?=/|$)', replace, value)


def restore(source, output):
    source, output = pathlib.Path(source), pathlib.Path(output)
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Source must be a real directory')
    if not re.fullmatch(r'out/[A-Za-z0-9][A-Za-z0-9._-]{0,95}', output.relative_to(source).as_posix()):
        raise ValueError('Pass explicit out/name')
    if (source / 'out').is_symlink() or output.is_symlink():
        raise ValueError('Output must be a real directory')
    receipt = output / times.RECEIPT
    if not receipt.exists() and not receipt.is_symlink():
        return {'mode': 'fresh', 'slotsReordered': 0, 'linksRewritten': 0}
    inputs = times.load_receipt(receipt)['inputs']
    old = {k: v for k, v in inputs.items() if k.startswith(PREFIX)}
    if not old:
        return {'mode': 'no-cipd-inputs', 'slotsReordered': 0, 'linksRewritten': 0}
    root = source
    for part in (PREFIX + '.cipd/pkgs').split('/'):
        root = root / part
        if root.is_symlink() or not root.is_dir():
            raise ValueError('CIPD store must contain real directories')
    packages = root
    root = source / PREFIX
    current = {PREFIX + k: v for k, v in times.source_inputs(root).items()}
    before, after = identities(old), identities(current)
    if before.keys() != after.keys():
        raise ValueError('CIPD package identities changed; refusing layout restoration')
    mapping = {after[identity]: before[identity] for identity in before}
    if {p.name for p in packages.iterdir()} != set(mapping):
        raise ValueError('Unexpected CIPD package store entries')
    for number in mapping:
        if (packages / number).is_symlink() or not (packages / number).is_dir():
            raise ValueError('CIPD slot must be a real directory')
    projected, links = {}, []
    for key, record in current.items():
        changed_key = rewrite(key, mapping)
        item = record.copy()
        if record[0] == 'link':
            value = os.readlink(source / key)
            changed_value = rewrite(value, mapping)
            item[1] = hashlib.sha256(os.fsencode(changed_value)).hexdigest()
            if value != changed_value:
                links.append((changed_key, changed_value))
        if changed_key in projected:
            raise ValueError('CIPD layout collision')
        projected[changed_key] = item
    different = sorted(set(old) ^ set(projected))
    different += [key for key in old.keys() & projected.keys() if old[key][:3] != projected[key][:3]]
    if different:
        raise ValueError('CIPD bytes/modes/projected links differ: ' + ', '.join(sorted(different)[:8]))
    moved = sum(key != value for key, value in mapping.items())
    if moved:
        with tempfile.TemporaryDirectory(prefix='remote-paint-layout-', dir=packages.parent) as stage:
            stage = pathlib.Path(stage)
            for number in mapping:
                os.rename(packages / number, stage / number)
            for number, destination in mapping.items():
                os.rename(stage / number, packages / destination)
    for key, value in links:
        path = source / key
        fd, temporary = tempfile.mkstemp(prefix='.cipd-link-', dir=path.parent)
        os.close(fd)
        os.unlink(temporary)
        try:
            os.symlink(value, temporary)
            os.replace(temporary, path)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)
    # No timestamps are changed here; the original strict checker owns that.
    marker = restore_marker(source, output, inputs)
    return {'mode': 'validated-layout', 'slotsReordered': moved, 'linksRewritten': len(links),
            'sentinelRestored': marker}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: restore-cipd-layout.py SOURCE OUTPUT')
    print(json.dumps(restore(*sys.argv[1:])), flush=True)
