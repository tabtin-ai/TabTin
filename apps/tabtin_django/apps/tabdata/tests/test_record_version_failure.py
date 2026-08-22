import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.tabdata.services.record_service import next_record_version  # noqa: E402


def test_postgres_version_error_does_not_fallback_inside_aborted_transaction():
    connection = MagicMock()
    connection.vendor = "postgresql"
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.execute.side_effect = RuntimeError("lock timeout")

    with (
        patch("apps.tabdata.services.record_service.router.db_for_write", return_value="tabdata"),
        patch("apps.tabdata.services.record_service.connections") as mock_connections,
        patch("apps.tabdata.services.record_service.Table.objects") as mock_objects,
    ):
        mock_connections.__getitem__.return_value = connection

        with pytest.raises(RuntimeError, match="lock timeout"):
            next_record_version(uuid.uuid4())

    mock_objects.using.assert_not_called()
