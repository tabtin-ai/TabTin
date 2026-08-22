import pytest
from unittest.mock import patch


class _FakeAtomic:
    """Mock for django.db.transaction.atomic context manager."""
    def __init__(self, *args, **kwargs):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def __call__(self, func):
        return func


@pytest.fixture(autouse=False)
def mock_db_transaction():
    """Mock transaction.atomic and on_commit for tests that don't need real DB access.

    Usage: Add this fixture to test classes/functions that call code with transaction.atomic.
    """
    with patch("django.db.transaction.atomic", side_effect=_FakeAtomic) as mock_atomic, \
         patch("django.db.transaction.on_commit", side_effect=lambda fn, **kw: fn()) as mock_on_commit:
        yield {"atomic": mock_atomic, "on_commit": mock_on_commit}
