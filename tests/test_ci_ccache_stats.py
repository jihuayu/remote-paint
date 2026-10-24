"""Regression: use the pinned ccache 4.7.5 machine-readable counter IDs."""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location(
    'ccache_probe', pathlib.Path(__file__).resolve().parents[1] / 'ci/ccache-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class CcacheStatisticsTests(unittest.TestCase):
    def snapshot(self, direct=0, preprocessed=0, misses=0):
        # IDs from ccache v4.7.5 src/core/Statistics.cpp, not human labels.
        return probe.counters(f'direct_cache_hit\t{direct}\n'
                              f'preprocessed_cache_hit\t{preprocessed}\n'
                              f'cache_miss\t{misses}\n'
                              'local_storage_hit\t2\n')

    def test_real_direct_hit_is_counted(self):
        result = probe.delta(self.snapshot(misses=1), self.snapshot(direct=1, misses=1))
        self.assertEqual(result, {'direct_cache_hit': 1, 'preprocessed_cache_hit': 0, 'cache_miss': 0})

    def test_preprocessed_hit_and_changed_header_miss(self):
        first = self.snapshot(preprocessed=3, misses=4)
        warm = self.snapshot(preprocessed=4, misses=4)
        changed = self.snapshot(preprocessed=4, misses=5)
        self.assertEqual(probe.delta(first, warm)['preprocessed_cache_hit'], 1)
        self.assertEqual(probe.delta(warm, changed)['cache_miss'], 1)

    def test_unknown_counter_names_do_not_silently_become_zero(self):
        old = {'cache_hit_direct': 0, 'cache_hit_preprocessed': 0, 'cache_miss': 0}
        with self.assertRaisesRegex(ValueError, 'Missing ccache statistics IDs'):
            probe.delta(old, old)

    def test_missing_after_counter_is_rejected(self):
        after = self.snapshot()
        del after['preprocessed_cache_hit']
        with self.assertRaisesRegex(ValueError, 'preprocessed_cache_hit'):
            probe.delta(self.snapshot(), after)

    def test_statistics_reset_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'reset'):
            probe.delta(self.snapshot(direct=2), self.snapshot(direct=1))


if __name__ == '__main__':
    unittest.main()
