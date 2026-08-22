from __future__ import annotations

from django.db.utils import OperationalError
from django.test import SimpleTestCase

from apps.tabdata.api_helpers import retryable_write_sqlstate


class _DriverError(RuntimeError):
    pass


class TestRetryableWriteSqlstate(SimpleTestCase):
    def _wrapped_error(self, sqlstate: str, *, attribute: str) -> OperationalError:
        cause = _DriverError("driver detail must stay server-side")
        setattr(cause, attribute, sqlstate)
        error = OperationalError("database write failed")
        error.__cause__ = cause
        return error

    def test_walks_driver_cause_chain_for_supported_contention_states(self):
        cases = (
            ("55P03", "pgcode"),
            ("40P01", "sqlstate"),
            ("40001", "pgcode"),
        )

        for sqlstate, attribute in cases:
            with self.subTest(sqlstate=sqlstate, attribute=attribute):
                self.assertEqual(
                    retryable_write_sqlstate(
                        self._wrapped_error(sqlstate, attribute=attribute),
                    ),
                    sqlstate,
                )

    def test_does_not_classify_unrelated_database_states_as_contention(self):
        for sqlstate in ("23505", "57014", "08006"):
            with self.subTest(sqlstate=sqlstate):
                self.assertEqual(
                    retryable_write_sqlstate(
                        self._wrapped_error(sqlstate, attribute="pgcode"),
                    ),
                    "",
                )

        self.assertEqual(retryable_write_sqlstate(OperationalError("unknown")), "")

    def test_handles_cause_cycles(self):
        first = _DriverError("first")
        second = _DriverError("second")
        first.__cause__ = second
        second.__cause__ = first

        self.assertEqual(retryable_write_sqlstate(first), "")
