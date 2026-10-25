"""Real compiler/Ninja fixtures for CI cache rehydration; no Chromium checkout."""
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

MODULE = pathlib.Path(__file__).resolve().parents[1] / 'docker/ci-source-times.py'
spec = importlib.util.spec_from_file_location('ci_source_times', MODULE)
times = importlib.util.module_from_spec(spec)
spec.loader.exec_module(times)


class CacheInputs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if subprocess.check_output(['ninja', '--version'], text=True).strip() != '1.13.2':
            raise RuntimeError('Fixtures require the production-pinned Ninja 1.13.2')
        cls.compiler = shutil.which('c++')
        if not cls.compiler:
            raise RuntimeError('A real C++ compiler is required')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ci-input-times-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.source = self.root / 'src'
        self.source.mkdir()
        (self.source / 'components/remote_paint').mkdir(parents=True)
        self.main = self.source / 'main.cc'
        self.header = self.source / 'components/remote_paint/value.h'
        self.header.write_text('#define MESSAGE "before"\n')
        self.main.write_text('#include <cstdio>\n#include "alias.h"\nint main(){puts(MESSAGE);}\n')
        (self.source / 'alias.h').symlink_to('components/remote_paint/value.h')
        # All initial source dates precede the fixture's actual compiled products.
        for path in (self.main, self.header, self.source / 'alias.h'):
            os.utime(path, ns=(1600000000000000000,) * 2, follow_symlinks=False)
        self.output = self.new_output('fixture')
        self.profile = {'target': 'fixture', 'compilerSha256': times.digest_file(pathlib.Path(self.compiler).resolve()),
                        'ninjaSha256': times.digest_file(pathlib.Path(shutil.which('ninja')).resolve())}

    def new_output(self, name):
        output = self.source / 'out' / name
        output.mkdir(parents=True)
        (output / 'args.gn').write_text('# actual fixture output, never production\n')
        return output

    def sync(self, output=None, profile=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return times.synchronize(self.source, output or self.output, profile or self.profile)

    def graph(self, output=None, paused=False):
        output = output or self.output
        command = self.compiler + ' -MMD -MF $out.d -c ../../main.cc -o $out && echo $out >> compiled'
        text = 'rule compile\n  command = ' + command + '\n  depfile = $out.d\n  deps = gcc\n'
        text += 'rule link\n  command = ' + self.compiler + ' $in -o $out\n'
        text += 'build main.o: compile ../../main.cc\nbuild app: link main.o\n'
        if paused:
            helper = self.root / 'hold.py'
            helper.write_text('import pathlib,time\np=pathlib.Path(__file__).with_name("gate")\n'
                              'p.with_name("entered").touch()\nwhile p.exists():time.sleep(.01)\n')
            text += ('rule resume\n  command = ' + sys.executable + ' ' + str(helper)
                     + ' && ' + command + '\n  depfile = $out.d\n  deps = gcc\n'
                     'build second.o: resume ../../main.cc || app\nbuild app2: link second.o\n')
        (output / 'build.ninja').write_text(text)

    def ninja(self, *args, output=None):
        return subprocess.check_output(['ninja', '-C', str(output or self.output), *args],
                                       text=True, stderr=subprocess.STDOUT)

    def result(self, output=None, binary='app'):
        return subprocess.check_output([str((output or self.output) / binary)], text=True).strip()

    def recheckout(self):
        # Recreate regular files and a symlink, as a new shallow checkout would.
        for path in (self.main, self.header):
            raw = path.read_bytes()
            path.unlink()
            path.write_bytes(raw)
        link = self.source / 'alias.h'
        link.unlink()
        link.symlink_to('components/remote_paint/value.h')

    def test_unchanged_fresh_checkout_reuses_real_object_and_header_dependencies(self):
        self.assertEqual(self.sync()['mode'], 'seeded')
        self.graph()
        self.ninja('app')
        self.assertEqual(self.result(), 'before')
        stamp = {name: (self.output / name).stat().st_mtime_ns for name in ('main.o', 'app')}
        log = (self.output / '.ninja_log').read_bytes()
        self.recheckout()
        # Establish the original failure mechanism using Ninja's real scanner.
        planned = self.ninja('-n', '-d', 'explain', 'app')
        self.assertIn('older than most recent input', planned)
        self.assertEqual(self.sync()['mode'], 'restored')
        self.assertEqual((self.output / '.ninja_log').read_bytes(), log)
        self.assertIn('no work to do', self.ninja('app'))
        self.assertEqual({name: (self.output / name).stat().st_mtime_ns for name in stamp}, stamp)
        self.assertEqual((self.output / 'compiled').read_text().splitlines(), ['main.o'])

    def test_manifest_capacity_limits_reject_without_replacing_existing_receipt(self):
        self.sync()
        receipt = self.output / times.RECEIPT
        original = receipt.read_bytes()
        with mock.patch.object(times, 'MAX_INPUTS', 1):
            with self.assertRaisesRegex(ValueError, 'Invalid source timestamp inputs'):
                self.sync()
            with self.assertRaisesRegex(ValueError, 'Too many CI source inputs'):
                times.source_inputs(self.source)
        self.assertEqual(receipt.read_bytes(), original)
        with mock.patch.object(times, 'MAX_RECEIPT_BYTES', 16):
            with self.assertRaisesRegex(ValueError, 'Source timestamp receipt too large'):
                self.sync()
        self.assertEqual(receipt.read_bytes(), original)

    def test_interrupted_build_receipt_resumes_only_unfinished_original_target(self):
        self.sync()
        original = (self.output / times.RECEIPT).read_bytes()
        self.graph(paused=True)
        (self.root / 'gate').touch()
        with (self.root / 'interrupted.log').open('w') as log:
            child = subprocess.Popen(['ninja', '-j1', '-C', str(self.output), 'app2'],
                                     stdout=log, stderr=log, start_new_session=True)
            try:
                deadline = time.monotonic() + 15
                while not (self.root / 'entered').exists():
                    if child.poll() is not None or time.monotonic() > deadline:
                        self.fail('Fixture did not enter its original second command')
                    time.sleep(.01)
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=5)
        self.assertNotEqual(child.returncode, 0)
        self.assertEqual(self.result(), 'before')
        completed = {name: (self.output / name).stat().st_mtime_ns for name in ('main.o', 'app')}
        self.assertFalse((self.output / 'app2').exists())
        self.assertEqual((self.output / times.RECEIPT).read_bytes(), original)
        self.recheckout()
        self.sync()
        (self.root / 'gate').unlink()
        self.ninja('-j1', 'app2')
        self.assertEqual(self.result(binary='app2'), 'before')
        self.assertEqual({name: (self.output / name).stat().st_mtime_ns for name in completed}, completed)
        self.assertEqual((self.output / 'compiled').read_text().splitlines(), ['main.o', 'second.o'])

    def test_changed_native_header_is_rejected_then_fresh_output_compiles_new_bytes(self):
        self.sync()
        self.graph()
        self.ninja('app')
        receipt = (self.output / times.RECEIPT).read_bytes()
        self.recheckout()
        self.header.write_text('#define MESSAGE "after"\n')
        untouched = self.main.stat().st_mtime_ns
        with self.assertRaisesRegex(ValueError, 'Source bytes/path/mode changed'):
            self.sync()
        self.assertEqual(self.main.stat().st_mtime_ns, untouched)
        self.assertEqual((self.output / times.RECEIPT).read_bytes(), receipt)
        self.assertEqual(self.result(), 'before')
        fresh = self.new_output('changed-native')
        self.sync(fresh)
        self.graph(fresh)
        self.ninja('app', output=fresh)
        self.assertEqual(self.result(fresh), 'after')

    def test_changed_upstream_file_added_removed_mode_and_symlink_are_not_backdated(self):
        for mutation in ('bytes', 'added', 'removed', 'mode', 'symlink'):
            with self.subTest(mutation=mutation):
                fresh = self.new_output('mutation-' + mutation)
                self.sync(fresh)
                before = times.source_inputs(self.source)
                if mutation == 'bytes':
                    self.main.write_text(self.main.read_text() + '// changed upstream\n')
                elif mutation == 'added':
                    (self.source / 'new-header.h').write_text('new shadowing input\n')
                elif mutation == 'removed':
                    self.header.unlink()
                elif mutation == 'mode':
                    self.main.chmod(0o700)
                else:
                    (self.source / 'alias.h').unlink()
                    (self.source / 'alias.h').symlink_to('main.cc')
                current = times.source_inputs(self.source)
                with self.assertRaisesRegex(ValueError, 'Source bytes/path/mode changed'):
                    self.sync(fresh)
                self.assertEqual(times.source_inputs(self.source), current)
                # Each subcase retains its own invalidated receipt, then starts
                # from the current tree; none is adopted by the old cache.
                self.assertNotEqual(before, current)
                if mutation == 'removed':
                    self.header.write_text('#define MESSAGE "before"\n')

    def test_changed_recipe_never_updates_old_timestamps_or_receipt(self):
        self.sync()
        self.recheckout()
        before = times.source_inputs(self.source)
        receipt = (self.output / times.RECEIPT).read_bytes()
        with self.assertRaisesRegex(ValueError, 'Build recipe changed'):
            self.sync(profile={**self.profile, 'target': 'another-cpu'})
        self.assertEqual(times.source_inputs(self.source), before)
        self.assertEqual((self.output / times.RECEIPT).read_bytes(), receipt)

    def test_missing_corrupt_duplicate_and_unsafe_receipts_cannot_adopt_old_objects(self):
        self.sync()
        self.graph()
        self.ninja('app')
        path = self.output / times.RECEIPT
        original = path.read_bytes()
        log = (self.output / '.ninja_log').read_bytes()
        raw = gzip.decompress(original)
        for invalid in (None, b'truncated gzip', gzip.compress(b'{"format":1,"format":1}'),
                        gzip.compress(raw.replace(b'"main.cc"', b'"../escape.cc"'))):
            with self.subTest(invalid=invalid is None):
                path.unlink(missing_ok=True)
                if invalid is not None:
                    path.write_bytes(invalid)
                self.recheckout()
                before = times.source_inputs(self.source)
                with self.assertRaises((ValueError, OSError, EOFError)):
                    self.sync()
                self.assertEqual(times.source_inputs(self.source), before)
                self.assertEqual((self.output / '.ninja_log').read_bytes(), log)
                self.assertEqual(self.result(), 'before')
                path.write_bytes(original)

    def test_output_vcs_and_interpreter_cache_are_excluded_without_traversal(self):
        for name in ('out/another-output/private', '.git/private', '__pycache__/private'):
            p = self.source / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('retained independent state\n')
        original_walk = os.walk
        def checked_walk(*args, **kwargs):
            for parent, dirs, files in original_walk(*args, **kwargs):
                relative = pathlib.Path(parent).relative_to(self.source).parts
                self.assertFalse(relative and relative[0] in ('out', '.git', '__pycache__'))
                yield parent, dirs, files
        with mock.patch.object(times.os, 'walk', checked_walk):
            self.sync()
        inputs = times.load_receipt(self.output / times.RECEIPT)['inputs']
        self.assertEqual(set(inputs), {'main.cc', 'alias.h', 'components/remote_paint/value.h'})

    def test_real_dry_run_diagnostics_bound_output_and_reap_timed_out_observation(self):
        self.sync()
        self.graph()
        with contextlib.redirect_stdout(io.StringIO()):
            result = times.diagnose(self.output, targets=('app',), limit=64)
        self.assertEqual(result['exitCode'], 0)
        self.assertFalse(result['timedOut'])
        self.assertTrue(result['truncated'])
        self.assertEqual(result['retainedBytes'], 64)
        self.assertFalse((self.output / 'app').exists())
        with contextlib.redirect_stdout(io.StringIO()):
            expired = times.diagnose(self.output, targets=('app',), timeout=.000001, limit=64)
        self.assertTrue(expired['timedOut'])
        self.assertTrue(expired['truncated'])
        self.assertLessEqual(expired['retainedBytes'], 64)
        # A diagnostic timeout did not start/kill a compiler or qualify output.
        self.ninja('app')
        self.assertEqual(self.result(), 'before')

    def test_receipt_symlink_and_wrong_ninja_are_rejected_before_cache_mutation(self):
        self.sync()
        path = self.output / times.RECEIPT
        saved = self.root / 'saved.gz'
        path.rename(saved)
        path.symlink_to(saved)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            self.sync()
        with mock.patch.object(times, 'run', return_value='1.11.1'):
            with self.assertRaisesRegex(ValueError, 'Ninja 1.13.2'):
                times.recipe(self.root / 'nonexistent', self.root, self.output, 'arm64')
        self.assertEqual(path.resolve(), saved)


if __name__ == '__main__':
    unittest.main(verbosity=2)
