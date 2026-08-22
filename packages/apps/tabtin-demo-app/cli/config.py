"""OAuth token 存储——读写 ``~/.tabtin-demo-app/config.json``。

与第三方 CLI 的 ``~/.<cli-name>/config.json`` 模式一致：
- access_token: GitHub OAuth token
- token_type: "bearer"
- scope: OAuth scope（如 "repo"）
- created_at: ISO 8601
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

CONFIG_DIR_NAME = ".tabtin-demo-app"
CONFIG_FILE_NAME = "config.json"


def _config_dir() -> Path:
    return Path.home() / CONFIG_DIR_NAME


def _config_path() -> Path:
    return _config_dir() / CONFIG_FILE_NAME


def load_config() -> dict[str, Any]:
    path = _config_path()
    if not path.is_file():
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_config(data: dict[str, Any]) -> None:
    d = _config_dir()
    d.mkdir(parents=True, exist_ok=True)
    with _config_path().open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.chmod(_config_path(), 0o600)


def get_access_token() -> Optional[str]:
    cfg = load_config()
    token = cfg.get("access_token")
    return token if isinstance(token, str) and token else None


def clear_config() -> None:
    path = _config_path()
    if path.is_file():
        path.unlink()
