"""pytest conftest for tabtin-demo-app tests."""

import sys
from pathlib import Path

import pytest

APP_ROOT = Path(__file__).resolve().parent.parent
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))


@pytest.fixture(autouse=True)
def _clean_config(tmp_path, monkeypatch):
    """每个测试用独立的 config 目录，不污染用户 home。"""
    fake_home = tmp_path / "fakehome"
    fake_home.mkdir()
    monkeypatch.setattr("cli.config.Path.home", lambda: fake_home)
    yield
