from __future__ import annotations

import unittest

from django.core.management import call_command
from django.core.management.base import CommandError

from apps.tabdoc.management.commands.tabdoc_benchmark import _percentile, _summarize


class TabDocBenchmarkCommandTests(unittest.TestCase):
    def test_percentile_linear_interpolation(self):
        values = [10.0, 20.0, 30.0, 40.0]
        self.assertAlmostEqual(_percentile(values, 0.50), 25.0)
        self.assertAlmostEqual(_percentile(values, 0.95), 38.5)

    def test_summarize_empty_samples(self):
        summary = _summarize([])
        self.assertEqual(summary.count, 0)
        self.assertEqual(summary.p95_ms, 0.0)

    def test_summarize_non_empty_samples(self):
        summary = _summarize([5.0, 10.0, 15.0])
        self.assertEqual(summary.count, 3)
        self.assertAlmostEqual(summary.avg_ms, 10.0)
        self.assertGreater(summary.p95_ms, 0.0)

    def test_command_rejects_invalid_iterations(self):
        with self.assertRaises(CommandError):
            call_command("tabdoc_benchmark", "--iterations", "0")
