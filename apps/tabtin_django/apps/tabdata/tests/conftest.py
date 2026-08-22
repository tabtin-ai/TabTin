"""tabdata 测试共享 conftest。

Fix 5 / Wave 2：`_get_confirm_token_secret()` 在 pytest 下 `RUNNING_TESTS`
为 False（`'test' not in sys.argv`），若 `DEBUG` 也为 False 则误抛
`ImproperlyConfigured`。通过 pytest_configure + autouse fixture 双重保障。
"""

import pytest


def pytest_configure(config):
    import os
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

    import django
    django.setup()

    from django.conf import settings
    if not getattr(settings, "TABDATA_CONFIRM_TOKEN_SECRET", ""):
        settings.TABDATA_CONFIRM_TOKEN_SECRET = (
            "tabdata-test-confirm-token-secret-do-not-use-in-prod"
        )


@pytest.fixture(autouse=True)
def _set_confirm_token_secret(settings):
    """每个测试函数执行前确保 TABDATA_CONFIRM_TOKEN_SECRET 已设置。"""
    settings.TABDATA_CONFIRM_TOKEN_SECRET = "test-secret"
