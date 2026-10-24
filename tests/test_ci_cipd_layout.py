"""A reordered CIPD store must still pass the original byte checks and Ninja."""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
import test_ci_source_times as fixtures

spec = importlib.util.spec_from_file_location(
    'restore_cipd_layout', pathlib.Path(__file__).resolve().parents[1] / 'ci/restore-cipd-layout.py')
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


class CipdLayout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.CacheInputs.setUpClass()

    def setUp(self):
        self.f = fixtures.CacheInputs()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.root = self.f.source / layout.PREFIX
        self.pkgs = self.root / '.cipd/pkgs'
        for number, identity, name, data in (
                ('0', 'AAAAAAAAAAAA', 'value.h', '#define MESSAGE "before"\n'),
                ('1', 'BBBBBBBBBBBB', 'helper', 'fixed helper bytes\n')):
            slot = self.pkgs / number
            payload = slot / identity
            (payload / '.cipdpkg').mkdir(parents=True)
            (payload / '.cipdpkg/manifest.json').write_text(json.dumps({'identity': identity}))
            (payload / name).write_text(data)
            (slot / '_current').symlink_to(identity)
            (slot / 'description.json').write_text(json.dumps({'package': name}))
            (slot / '.lock').write_bytes(b'')
            (self.root / name).symlink_to(f'.cipd/pkgs/{number}/_current/{name}')
        alias = self.f.source / 'alias.h'
        alias.unlink()
        alias.symlink_to(layout.PREFIX + 'value.h')
        toggler = self.f.source / 'third_party/depot_tools/update_depot_tools_toggle.py'
        toggler.write_text('# fixed generator fixture\n')
        self.marker = self.f.source / layout.MARKER
        self.old_marker = f'Disabled by {toggler} at 2026-10-24 06:12:56.096442\n'.encode()
        self.marker.write_bytes(self.old_marker)
        os.utime(self.marker, ns=(1792822376096459448,) * 2)
        self.f.sync()
        self.receipt = self.f.output / fixtures.times.RECEIPT
        self.original = self.receipt.read_bytes()

    def reorder(self):
        with tempfile.TemporaryDirectory(dir=self.pkgs.parent) as stage:
            stage = pathlib.Path(stage)
            os.rename(self.pkgs / '0', stage / '0')
            os.rename(self.pkgs / '1', self.pkgs / '0')
            os.rename(stage / '0', self.pkgs / '1')
        for name, number in (('value.h', '1'), ('helper', '0')):
            path = self.root / name
            path.unlink()
            path.symlink_to(f'.cipd/pkgs/{number}/_current/{name}')
        for path in self.root.rglob('*'):
            if path.is_file() and not path.is_symlink():
                path.write_bytes(path.read_bytes())

    def test_reordered_identical_packages_preserve_real_cpp_object(self):
        self.f.graph()
        self.f.ninja('app')
        stamp = (self.f.output / 'main.o').stat().st_mtime_ns
        self.reorder()
        with self.assertRaisesRegex(ValueError, 'Source bytes/path/mode changed'):
            self.f.sync()
        result = layout.restore(self.f.source, self.f.output)
        self.assertEqual(result, {'mode': 'validated-layout', 'slotsReordered': 2, 'linksRewritten': 2,
                                  'sentinelRestored': False})
        self.assertEqual(self.receipt.read_bytes(), self.original)
        self.assertEqual(self.f.sync()['mode'], 'restored')
        self.assertIn('no work to do', self.f.ninja('app'))
        self.assertEqual((self.f.output / 'main.o').stat().st_mtime_ns, stamp)
        self.assertEqual(self.f.result(), 'before')

    def test_changed_payload_or_mode_is_rejected_before_any_move(self):
        self.reorder()
        value = self.pkgs / '1/AAAAAAAAAAAA/value.h'
        value.write_text('#define MESSAGE "changed"\n')
        with self.assertRaisesRegex(ValueError, 'CIPD bytes/modes/projected links differ'):
            layout.restore(self.f.source, self.f.output)
        self.assertEqual(os.readlink(self.root / 'value.h'), '.cipd/pkgs/1/_current/value.h')
        self.assertEqual(self.receipt.read_bytes(), self.original)
        value.write_text('#define MESSAGE "before"\n')
        value.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'CIPD bytes/modes/projected links differ'):
            layout.restore(self.f.source, self.f.output)

    def test_generated_marker_is_recovered_only_by_exact_attested_hash(self):
        self.f.graph()
        self.f.ninja('app')
        stamp = (self.f.output / 'main.o').stat().st_mtime_ns
        self.marker.write_text(self.old_marker.decode().replace('06:12:56.096442', '11:40:00.123456'))
        result = layout.restore(self.f.source, self.f.output)
        self.assertTrue(result['sentinelRestored'])
        self.assertEqual(self.marker.read_bytes(), self.old_marker)
        self.assertEqual(self.receipt.read_bytes(), self.original)
        self.assertEqual(self.f.sync()['mode'], 'restored')
        self.assertIn('no work to do', self.f.ninja('app'))
        self.assertEqual((self.f.output / 'main.o').stat().st_mtime_ns, stamp)
        self.marker.write_text(self.old_marker.decode().replace('06:12:56.096442', '11:41:00.123456'))
        self.assertTrue(layout.restore(self.f.source, self.f.output)['sentinelRestored'])

    def test_unknown_marker_and_changed_generator_are_not_overwritten(self):
        self.marker.write_text('unexpected data\n')
        with self.assertRaisesRegex(ValueError, 'Unexpected disable-marker contents'):
            layout.restore(self.f.source, self.f.output)
        self.assertEqual(self.marker.read_text(), 'unexpected data\n')
        self.marker.write_text(self.old_marker.decode().replace('06:12:56.096442', '11:40:00.123456'))
        (self.f.source / 'third_party/depot_tools/update_depot_tools_toggle.py').write_text('# changed generator\n')
        with self.assertRaisesRegex(ValueError, 'Pinned disable-marker generator changed'):
            layout.restore(self.f.source, self.f.output)
        self.assertEqual(self.receipt.read_bytes(), self.original)

    def test_changed_package_identity_and_store_links_are_rejected(self):
        self.reorder()
        payload = self.pkgs / '1/AAAAAAAAAAAA'
        payload.rename(self.pkgs / '1/CCCCCCCCCCCC')
        with self.assertRaisesRegex(ValueError, 'CIPD package identities changed'):
            layout.restore(self.f.source, self.f.output)
        (self.pkgs / '1/CCCCCCCCCCCC').rename(payload)
        outside = self.f.root / 'slot'
        (self.pkgs / '1').rename(outside)
        (self.pkgs / '1').symlink_to(outside)
        with self.assertRaises(ValueError):
            layout.restore(self.f.source, self.f.output)
        self.assertEqual(self.receipt.read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main(verbosity=2)
