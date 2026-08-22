"""测试 config 模块——token 存取、文件权限。"""

import json
import stat

from cli.config import clear_config, get_access_token, load_config, save_config


def test_save_and_load_roundtrip():
    data = {"access_token": "ghp_test123", "scope": "repo"}
    save_config(data)
    loaded = load_config()
    assert loaded["access_token"] == "ghp_test123"
    assert loaded["scope"] == "repo"


def test_get_access_token_present():
    save_config({"access_token": "ghp_abc"})
    assert get_access_token() == "ghp_abc"


def test_get_access_token_missing():
    assert get_access_token() is None


def test_get_access_token_empty_string():
    save_config({"access_token": ""})
    assert get_access_token() is None


def test_clear_config():
    save_config({"access_token": "ghp_xyz"})
    assert get_access_token() == "ghp_xyz"
    clear_config()
    assert get_access_token() is None


def test_load_config_corrupt_json(tmp_path, monkeypatch):
    from pathlib import Path
    fake_home = tmp_path / "bad_home"
    fake_home.mkdir()
    monkeypatch.setattr("cli.config.Path.home", lambda: fake_home)
    cfg_dir = fake_home / ".tabtin-demo-app"
    cfg_dir.mkdir()
    (cfg_dir / "config.json").write_text("{invalid json", encoding="utf-8")
    assert load_config() == {}


def test_config_file_permissions():
    save_config({"access_token": "ghp_secret"})
    from cli.config import _config_path
    path = _config_path()
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600, f"Config file should be 0600, got {oct(mode)}"
