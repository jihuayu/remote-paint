"""Keep optional cache experiments from recompiling retained Chromium."""
import importlib.util
import pathlib
import subprocess
import unittest

root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ccache_prepare', root / 'ci/ccache-prepare-only.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.script = (root / 'docker/build-linux.sh').read_text()

    def test_actual_pinned_bootstrap_is_valid_shell_without_main_compilation(self):
        prefix = prepare.preparation(self.script)
        subprocess.run(['sh', '-n'], input=prefix, text=True, check=True)
        self.assertNotIn('ninja -C', prefix)
        self.assertIn('ci-source-times.py', prefix)
        self.assertIn('update_rust.py', prefix)

    def test_missing_boundary_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'boundary'):
            prepare.preparation('#!/bin/sh\necho incomplete\n')

    def test_duplicate_boundary_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'boundary'):
            prepare.preparation(self.script + self.script)

    def test_earlier_compile_command_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'earlier Ninja'):
            prepare.preparation('ninja -C /tmp/unsafe headless_shell\n' + self.script)


if __name__ == '__main__':
    unittest.main()
