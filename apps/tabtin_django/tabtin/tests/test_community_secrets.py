from __future__ import annotations

import logging
from pathlib import Path
import shutil
import stat

from cryptography.fernet import Fernet
import pytest

from tabtin.community_secrets import (
    APPLICATION_SECRET_NAMES,
    CENTRIFUGO_CONFIG_NAME,
    DATABASE_SECRET_NAMES,
    ensure_installation_secrets,
    initialize_community_installation,
    read_secret_file,
    secret_file_paths,
)


_CENTRIFUGO_TEMPLATE = """{
  "client": {"token": {"hmac_secret_key": "__CENTRIFUGO_TOKEN_SECRET__"}},
  "http_api": {"key": "__CENTRIFUGO_API_KEY__"},
  "proxy_secret": "__CENTRIFUGO_PROXY_SECRET__"
}
"""


def test_installation_secrets_are_file_backed_unique_and_persistent(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    first_root = tmp_path / "installation-a"
    second_root = tmp_path / "installation-b"

    with caplog.at_level(logging.INFO):
        first = ensure_installation_secrets(first_root)
        repeated = ensure_installation_secrets(first_root)
        second = ensure_installation_secrets(second_root)

    expected_names = set(APPLICATION_SECRET_NAMES) | set(DATABASE_SECRET_NAMES)
    assert set(first) == expected_names
    assert first == repeated
    assert first != second
    assert len(set(first.values())) == len(first)
    assert len(set(second.values())) == len(second)

    for name, path in secret_file_paths(first_root).items():
        assert path.is_file()
        assert path.read_text(encoding="utf-8") == first[name]
        assert stat.S_IMODE(path.stat().st_mode) == 0o440

    Fernet(first["CREDENTIAL_ENCRYPTION_KEY"].encode("ascii"))
    log_text = caplog.text
    assert all(value not in log_text for value in first.values())
    assert all(value not in log_text for value in second.values())


def test_removed_installation_data_generates_new_secrets(tmp_path: Path) -> None:
    installation_root = tmp_path / "installation"
    original = ensure_installation_secrets(installation_root)

    shutil.rmtree(installation_root)
    regenerated = ensure_installation_secrets(installation_root)

    assert original.keys() == regenerated.keys()
    assert all(original[name] != regenerated[name] for name in original)


def test_invalid_or_missing_secret_file_fails_without_mutation(tmp_path: Path) -> None:
    missing = tmp_path / "missing"
    with pytest.raises(ValueError, match="missing runtime secret"):
        read_secret_file(missing, label="runtime")

    invalid = tmp_path / "invalid"
    invalid.write_text("unsafe\nsecret", encoding="utf-8")
    before = invalid.read_bytes()
    with pytest.raises(ValueError, match="invalid runtime secret"):
        read_secret_file(invalid, label="runtime")
    assert invalid.read_bytes() == before


def test_existing_secret_set_is_validated_before_generating_missing_files(
    tmp_path: Path,
) -> None:
    installation_root = tmp_path / "installation"
    paths = secret_file_paths(installation_root)
    installation_root.mkdir(parents=True)
    paths["SECRET_KEY"].write_text("invalid secret with spaces", encoding="utf-8")

    with pytest.raises(ValueError, match="invalid SECRET_KEY secret"):
        ensure_installation_secrets(installation_root)

    assert set(installation_root.iterdir()) == {paths["SECRET_KEY"], installation_root / ".lock"}


def test_installer_assigns_runtime_and_one_shot_secret_ownership(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "installation"
    template = tmp_path / "centrifugo.template.json"
    template.write_text(_CENTRIFUGO_TEMPLATE, encoding="utf-8")
    ownership: dict[Path, tuple[int, int]] = {}

    monkeypatch.setenv("TABTIN_COMMUNITY_RUNTIME_UID", "10001")
    monkeypatch.setenv("TABTIN_COMMUNITY_RUNTIME_GID", "10001")
    monkeypatch.setenv("TABTIN_COMMUNITY_POSTGRES_UID", "999")
    monkeypatch.setenv("TABTIN_COMMUNITY_POSTGRES_GID", "999")
    monkeypatch.setenv("TABTIN_COMMUNITY_CENTRIFUGO_TEMPLATE", str(template))
    monkeypatch.setattr(
        "tabtin.community_secrets.os.chown",
        lambda path, uid, gid: ownership.__setitem__(Path(path), (uid, gid)),
    )

    initialize_community_installation(root)
    first = {path.name: path.read_bytes() for path in root.iterdir() if path.is_file()}
    initialize_community_installation(root)
    repeated = {path.name: path.read_bytes() for path in root.iterdir() if path.is_file()}

    assert first == repeated
    assert stat.S_IMODE(root.stat().st_mode) == 0o755
    paths = secret_file_paths(root)
    assert ownership[paths["PG_INIT_PASSWORD"]] == (999, 999)
    assert stat.S_IMODE(paths["PG_INIT_PASSWORD"].stat().st_mode) == 0o400
    assert ownership[paths["PG_MIGRATOR_PASSWORD"]] == (0, 0)
    assert stat.S_IMODE(paths["PG_MIGRATOR_PASSWORD"].stat().st_mode) == 0o400
    for name in (*APPLICATION_SECRET_NAMES, "PG_RUNTIME_PASSWORD"):
        assert ownership[paths[name]] == (10001, 10001)
        assert stat.S_IMODE(paths[name].stat().st_mode) == 0o440

    config = root / CENTRIFUGO_CONFIG_NAME
    assert ownership[config] == (10001, 10001)
    assert stat.S_IMODE(config.stat().st_mode) == 0o440
    config_text = config.read_text(encoding="utf-8")
    assert "__CENTRIFUGO_" not in config_text
    assert read_secret_file(paths["CENTRIFUGO_API_KEY"], label="api") in config_text
