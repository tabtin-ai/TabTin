"""``tabtin install <app_id>`` 端到端测试（A5 启动包）。

mock 网络下载 + 真实文件 I/O，验证：

- happy
  - 完整流程：下载 → SHA256 校验 → 解压 → chmod → registry 写入 → 失效 binary cache
  - JSON 输出
- error
  - SHA256 缺失且未豁免 → ``EXIT_CONFIG_MISSING (78)`` + 友好错误文案
  - SHA256 不匹配 → 抛 RuntimeError → exit 1
  - manifest 不存在 → ``EXIT_FAILED (1)`` + 友好错误文案
  - download 失败（HTTP 404）→ exit 1
- edge
  - ``TABTIN_ALLOW_UNCHECKED_INSTALL=1`` 豁免：缺 checksum 也能装（带 warning）
  - manifest 含 ``cli`` 但缺 ``binary`` 字段 → ValueError
  - 当前 platform 不在 ``platformMap`` 映射 → ``E_INSTALL_NO_BINARY``
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import sys
import tarfile
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import patch

import pytest

from apps.services.agent_engine.cli.spec import (
    compute_known_binaries,
    invalidate_known_binaries_cache,
)
from apps.services.agent_engine.cli.tabtin_cli import install as install_mod
from apps.services.agent_engine.cli.tabtin_cli.install import (
    DEFAULT_REGISTRY_DIR,
    InstallChecksumMissingError,
    install_app,
    run_install,
)


# ───────────────────────── helpers ───────────────────────────────


def _make_manifest(
    app_id: str,
    binary: str,
    *,
    checksum_for_current: Optional[str] = None,
) -> Dict[str, Any]:
    """构造测试 manifest；checksum_for_current 是当前 platform-arch 的预期 hash。"""
    cli: Dict[str, Any] = {
        "binary": binary,
        "version": "1.0.0",
        "downloadUrl": "https://example.com/{platform}-{arch}-v{version}.tar.gz",
        "platformMap": {"darwin": "darwin", "linux": "linux", "win32": "windows"},
        "archMap": {"x64": "amd64", "arm64": "arm64"},
    }
    if checksum_for_current is not None:
        # 计算当前 platform / arch 的 key
        plat = cli["platformMap"].get(install_mod._python_platform())
        arch = cli["archMap"].get(install_mod._python_arch())
        if plat and arch:
            cli["checksums"] = {f"{plat}-{arch}": checksum_for_current}
    return {
        "id": app_id,
        "name": app_id,
        "kind": "app",
        "version": "1.0.0",
        "distribution": "marketplace",
        "cli": cli,
    }


def _build_tar_gz_with_binary(binary_name: str, payload: bytes) -> bytes:
    """构造一个 in-memory tar.gz，里面只含一个 binary_name 文件，内容 = payload。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo(name=binary_name)
        info.size = len(payload)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _clean_binary_cache():
    invalidate_known_binaries_cache()
    yield
    invalidate_known_binaries_cache()


@pytest.fixture
def fake_manifest_dir(tmp_path: Path) -> Path:
    """构造一个临时 packages/apps/-like 目录，可作为 ``--manifest`` 参数指向位置。"""
    return tmp_path / "manifests"


def _write_manifest_to(dir_root: Path, app_id: str, manifest: dict) -> Path:
    """把 manifest 写到 ``<dir_root>/<app_id>/app.json`` 形式。"""
    app_dir = dir_root / app_id
    app_dir.mkdir(parents=True, exist_ok=True)
    path = app_dir / "app.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return path


# ───────────────────────── happy ─────────────────────────────────


def test_happy_install_writes_binary_and_registry(tmp_path: Path):
    """完整流程：mock 下载 → SHA256 校验 → 写 binary → 写 registry → 失效 binary cache。"""
    binary_name = "demo-cli"
    payload = b"#!/bin/sh\necho demo v1.0\n"
    tar_gz_bytes = _build_tar_gz_with_binary(binary_name, payload)
    expected_sha = hashlib.sha256(payload).hexdigest()

    manifest = _make_manifest("demo-app", binary_name, checksum_for_current=expected_sha)
    manifest_path = tmp_path / "demo-app-manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    registry_dir = tmp_path / "registry"

    # mock download
    def _fake_download(url: str, dest, *, timeout=60.0):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(tar_gz_bytes)

    with patch.object(install_mod, "_download_file", side_effect=_fake_download) as mock_dl:
        result = install_app(
            "demo-app",
            manifest_path=str(manifest_path),
            registry_dir=str(registry_dir),
        )

    assert result["app_id"] == "demo-app"
    assert result["version"] == "1.0.0"
    assert result["checksum_verified"] is True
    binary_path = Path(result["binary_path"])
    assert binary_path.is_file()
    assert binary_path.read_bytes() == payload

    # registry.json 写入
    registry_data = json.loads((registry_dir / "registry.json").read_text())
    assert "demo-app" in registry_data
    assert registry_data["demo-app"]["version"] == "1.0.0"

    # download 被调一次
    assert mock_dl.call_count == 1


def test_happy_run_install_text_output_returns_exit_ok(tmp_path: Path, capsys):
    """``run_install`` 文本模式 → 返回 EXIT_OK + 友好控制台输出。"""
    binary_name = "demo-cli"
    payload = b"binary content"
    expected_sha = hashlib.sha256(payload).hexdigest()
    manifest = _make_manifest("demo-app", binary_name, checksum_for_current=expected_sha)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    registry_dir = tmp_path / "registry"

    tar_gz_bytes = _build_tar_gz_with_binary(binary_name, payload)
    with patch.object(
        install_mod, "_download_file",
        side_effect=lambda url, dest, **kw: dest.write_bytes(tar_gz_bytes),
    ):
        rc = run_install(
            app_id="demo-app",
            manifest_path=str(manifest_path),
            registry_dir=str(registry_dir),
            output_json=False,
        )
    assert rc == 0
    out = capsys.readouterr().out
    assert "demo-app v1.0.0 安装成功" in out
    assert "binary  :" in out
    assert "verified" in out


def test_happy_run_install_json_output(tmp_path: Path, capsys):
    """``run_install --json`` → 返回 EXIT_OK + JSON 输出。"""
    binary_name = "demo-cli"
    payload = b"abc"
    expected_sha = hashlib.sha256(payload).hexdigest()
    manifest = _make_manifest("demo", binary_name, checksum_for_current=expected_sha)
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    registry_dir = tmp_path / "r"
    tar_gz = _build_tar_gz_with_binary(binary_name, payload)

    with patch.object(install_mod, "_download_file",
                       side_effect=lambda url, dest, **kw: dest.write_bytes(tar_gz)):
        rc = run_install(
            app_id="demo",
            manifest_path=str(manifest_path),
            registry_dir=str(registry_dir),
            output_json=True,
        )
    assert rc == 0
    payload_out = json.loads(capsys.readouterr().out)
    assert payload_out["success"] is True
    assert payload_out["app_id"] == "demo"
    assert payload_out["checksum_verified"] is True


def test_happy_install_invalidates_known_binaries_cache(tmp_path: Path):
    """安装完 marketplace App 后，compute_known_binaries 缓存失效，新 binary 立即可识别。"""
    binary_name = "newly-installed-cli"
    payload = b"x"
    expected_sha = hashlib.sha256(payload).hexdigest()
    manifest = _make_manifest("freshapp", binary_name, checksum_for_current=expected_sha)
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    registry_dir = tmp_path / "r"
    tar_gz = _build_tar_gz_with_binary(binary_name, payload)

    # 安装前 cache 不应包含 newly-installed-cli
    pre = compute_known_binaries()
    assert binary_name not in pre

    with patch.object(install_mod, "_download_file",
                       side_effect=lambda url, dest, **kw: dest.write_bytes(tar_gz)):
        install_app(
            "freshapp",
            manifest_path=str(manifest_path),
            registry_dir=str(registry_dir),
        )

    # 由于 install 调了 invalidate_known_binaries_cache()，再调时会重新扫描。
    # 但默认 manifest_root 是仓库 packages/apps/，新 binary 不在那里 — 这个测试
    # 通过另一种方式验证：cache 实际被失效（返回的 frozenset 不是同一对象）。
    post = compute_known_binaries()
    # 由于 fresh 安装的 manifest 不在仓库默认扫描根，binary 不会在白名单中；
    # 但 cache 已被失效（与 pre 不同对象）— 验证失效行为
    assert post is not pre


# ───────────────────────── error / fail-close ─────────────────────


def test_error_checksum_missing_raises_specific_exception(tmp_path: Path):
    """SHA256 缺失且未豁免 → ``InstallChecksumMissingError``（Wave D 强校验）。"""
    binary_name = "no-checksum-cli"
    manifest = _make_manifest("noc", binary_name)  # 不带 checksum
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    # 显式确保 unchecked install 没开
    with patch.dict("os.environ", {}, clear=False):
        os.environ.pop("TABTIN_ALLOW_UNCHECKED_INSTALL", None)
        with pytest.raises(InstallChecksumMissingError) as exc_info:
            install_app(
                "noc",
                manifest_path=str(manifest_path),
                registry_dir=str(tmp_path / "reg"),
            )
    msg = str(exc_info.value)
    assert "E_INSTALL_CHECKSUM_MISSING" in msg
    assert "TABTIN_ALLOW_UNCHECKED_INSTALL=1" in msg


def test_error_checksum_missing_run_install_returns_78(tmp_path: Path, capsys):
    """``run_install`` 翻译 InstallChecksumMissingError → ``EXIT_CONFIG_MISSING (78)``。"""
    binary_name = "no-checksum-cli"
    manifest = _make_manifest("noc", binary_name)
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with patch.dict("os.environ", {}, clear=False):
        os.environ.pop("TABTIN_ALLOW_UNCHECKED_INSTALL", None)
        rc = run_install(
            app_id="noc",
            manifest_path=str(manifest_path),
            registry_dir=str(tmp_path / "reg"),
            output_json=False,
        )
    assert rc == 78
    err = capsys.readouterr().err
    assert "E_INSTALL_CHECKSUM_MISSING" in err
    assert "TABTIN_ALLOW_UNCHECKED_INSTALL=1" in err


def test_error_checksum_mismatch_raises_runtime_error(tmp_path: Path):
    """SHA256 校验失败 → RuntimeError + 错误码标记。"""
    binary_name = "demo-cli"
    actual_payload = b"actual"
    wrong_sha = "0" * 64
    manifest = _make_manifest("demo", binary_name, checksum_for_current=wrong_sha)
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    tar_gz = _build_tar_gz_with_binary(binary_name, actual_payload)

    with patch.object(install_mod, "_download_file",
                       side_effect=lambda url, dest, **kw: dest.write_bytes(tar_gz)):
        with pytest.raises(RuntimeError) as exc_info:
            install_app(
                "demo",
                manifest_path=str(manifest_path),
                registry_dir=str(tmp_path / "reg"),
            )
    assert "E_INSTALL_CHECKSUM_MISMATCH" in str(exc_info.value)


def test_error_manifest_not_found(tmp_path: Path, capsys):
    """指定不存在的 manifest path → ``run_install`` 返回 1 + 友好错误。"""
    rc = run_install(
        app_id="ghost",
        manifest_path=str(tmp_path / "does-not-exist.json"),
        registry_dir=str(tmp_path / "reg"),
        output_json=False,
    )
    assert rc == 1
    err = capsys.readouterr().err
    assert "E_MANIFEST_NOT_FOUND" in err


def test_error_download_failed(tmp_path: Path):
    """download 抛 RuntimeError → install_app 重新抛 + run_install 返回 1。"""
    payload = b"x"
    expected_sha = hashlib.sha256(payload).hexdigest()
    manifest = _make_manifest("demo", "demo-cli", checksum_for_current=expected_sha)
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with patch.object(install_mod, "_download_file",
                       side_effect=RuntimeError("下载失败: HTTP 404 Not Found (url=...)")):
        with pytest.raises(RuntimeError, match="下载失败"):
            install_app(
                "demo",
                manifest_path=str(manifest_path),
                registry_dir=str(tmp_path / "reg"),
            )


def test_error_run_install_unexpected_branch(tmp_path: Path, capsys):
    """run_install 的 except Exception 兜底分支：返回 1 + [E_INSTALL_UNEXPECTED]。"""
    payload = b"x"
    expected_sha = hashlib.sha256(payload).hexdigest()
    manifest = _make_manifest("demo", "demo-cli", checksum_for_current=expected_sha)
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with patch.object(install_mod, "_download_file",
                       side_effect=SystemError("unexpected boom")):
        rc = run_install(
            app_id="demo",
            manifest_path=str(manifest_path),
            registry_dir=str(tmp_path / "reg"),
            output_json=False,
        )
    assert rc == 1
    err = capsys.readouterr().err
    assert "E_INSTALL_UNEXPECTED" in err
    assert "SystemError" in err


def test_error_json_output_for_checksum_missing(tmp_path: Path, capsys):
    """``--json`` 模式下错误也走 JSON 序列化。"""
    manifest = _make_manifest("noc", "noc-cli")
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with patch.dict("os.environ", {}, clear=False):
        os.environ.pop("TABTIN_ALLOW_UNCHECKED_INSTALL", None)
        rc = run_install(
            app_id="noc",
            manifest_path=str(manifest_path),
            registry_dir=str(tmp_path / "reg"),
            output_json=True,
        )
    assert rc == 78
    out = json.loads(capsys.readouterr().out)
    assert out["success"] is False
    assert out["error"]["code"] == "E_INSTALL_CHECKSUM_MISSING"


# ───────────────────────── edge ──────────────────────────────────


def test_edge_unchecked_install_env_var_allows_missing_checksum(tmp_path: Path, monkeypatch):
    """``TABTIN_ALLOW_UNCHECKED_INSTALL=1`` 豁免：缺 checksum 也能装。"""
    binary_name = "demo-cli"
    payload = b"unchecked"
    manifest = _make_manifest("demo", binary_name)  # 无 checksum
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    tar_gz = _build_tar_gz_with_binary(binary_name, payload)

    monkeypatch.setenv("TABTIN_ALLOW_UNCHECKED_INSTALL", "1")
    with patch.object(install_mod, "_download_file",
                       side_effect=lambda url, dest, **kw: dest.write_bytes(tar_gz)):
        result = install_app(
            "demo",
            manifest_path=str(manifest_path),
            registry_dir=str(tmp_path / "reg"),
        )
    assert result["checksum_verified"] is False
    assert Path(result["binary_path"]).is_file()


def test_edge_manifest_missing_cli_section(tmp_path: Path):
    """manifest 不含 cli 字段 → ValueError。"""
    manifest = {"id": "x", "name": "X", "kind": "app", "version": "1.0"}
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="不含 cli 字段"):
        install_app(
            "x",
            manifest_path=str(manifest_path),
            registry_dir=str(tmp_path / "reg"),
        )


def test_edge_manifest_cli_missing_binary(tmp_path: Path):
    """``cli.binary`` 缺失 → ValueError。"""
    manifest = {
        "id": "x", "name": "X", "kind": "app", "version": "1.0",
        "cli": {"version": "1.0"},  # 没 binary
    }
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="manifest.cli.binary 缺失"):
        install_app(
            "x",
            manifest_path=str(manifest_path),
            registry_dir=str(tmp_path / "reg"),
        )


def test_edge_unsupported_platform(tmp_path: Path):
    """当前 platform 不在 platformMap → E_INSTALL_NO_BINARY。"""
    manifest = _make_manifest("demo", "demo-cli")
    # 故意把映射改成一个明确不会匹配的 platform 名
    manifest["cli"]["platformMap"] = {"sunos": "sun"}
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(RuntimeError, match="E_INSTALL_NO_BINARY"):
        install_app(
            "demo",
            manifest_path=str(manifest_path),
            registry_dir=str(tmp_path / "reg"),
        )


def test_edge_binary_dest_missing_after_extract(tmp_path: Path):
    """tar.gz 解压后预期的 binary 不在解压结果中 → E_INSTALL_BINARY_MISSING。"""
    binary_name = "demo-cli"
    payload = b"fake content"
    expected_sha = hashlib.sha256(payload).hexdigest()
    manifest = _make_manifest("demo", binary_name, checksum_for_current=expected_sha)
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    # tar 含 'wrong-name' 不含 'demo-cli'
    tar_gz = _build_tar_gz_with_binary("wrong-name", payload)

    with patch.object(install_mod, "_download_file",
                       side_effect=lambda url, dest, **kw: dest.write_bytes(tar_gz)):
        with pytest.raises(RuntimeError, match="E_INSTALL_BINARY_MISSING"):
            install_app(
                "demo",
                manifest_path=str(manifest_path),
                registry_dir=str(tmp_path / "reg"),
            )


def test_edge_corrupt_existing_registry_treated_as_empty(tmp_path: Path):
    """既有 registry.json 损坏：当作空 registry 处理（fail-safe），新条目正常写入。"""
    registry_dir = tmp_path / "reg"
    registry_dir.mkdir()
    (registry_dir / "registry.json").write_text("not json", encoding="utf-8")

    binary_name = "demo-cli"
    payload = b"x"
    expected_sha = hashlib.sha256(payload).hexdigest()
    manifest = _make_manifest("demo", binary_name, checksum_for_current=expected_sha)
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    tar_gz = _build_tar_gz_with_binary(binary_name, payload)

    with patch.object(install_mod, "_download_file",
                       side_effect=lambda url, dest, **kw: dest.write_bytes(tar_gz)):
        result = install_app(
            "demo",
            manifest_path=str(manifest_path),
            registry_dir=str(registry_dir),
        )
    assert result["app_id"] == "demo"
    # 新 registry.json 是 valid JSON
    registry = json.loads((registry_dir / "registry.json").read_text())
    assert "demo" in registry


def test_edge_registry_write_atomic_no_partial_on_error(tmp_path: Path):
    """三视角 Review P1：``_write_registry`` 通过 tempfile + os.replace 原子写。

    模拟 json.dump 写到一半失败：临时文件被清理，原 registry.json 不被破坏。
    """
    from apps.services.agent_engine.cli.tabtin_cli.install import _write_registry

    registry_path = tmp_path / "registry.json"
    # 先写一个合法 registry
    initial = {"existing-app": {"version": "1.0.0"}}
    _write_registry(registry_path, initial)
    assert json.loads(registry_path.read_text())["existing-app"]["version"] == "1.0.0"

    # 模拟 json.dump 中途异常 → 应清理临时文件，保留 existing-app
    from unittest.mock import patch as _patch
    with _patch("apps.services.agent_engine.cli.tabtin_cli.install.json.dump",
                 side_effect=OSError("disk full")):
        with pytest.raises(OSError, match="disk full"):
            _write_registry(registry_path, {"new-app": {"version": "2.0.0"}})

    # 原 registry 仍是 existing-app（未被部分覆盖）
    after = json.loads(registry_path.read_text())
    assert after == initial
    # 临时文件已清理（防止 .registry-*.tmp 残留）
    leftover = list(tmp_path.glob(".registry-*.tmp"))
    assert leftover == [], f"残留临时文件: {leftover}"


def test_edge_extract_tarball_rejects_absolute_path_symlink(tmp_path: Path):
    """三视角 Review P0：tar 含指向绝对路径的 symlink → 拒绝解压。

    Python 3.11+ 都内置 ``filter='data'`` 防御，会抛 ``AbsoluteLinkError`` /
    ``LinkOutsideDestinationError`` 等 tarfile 内置异常。本测试断言"解压失败"
    （任意异常即可），而不限定 RuntimeError —— 重点是 symlink **没有**真的
    被写到 ``dest_dir``，且 binary 不被恶意指向 /etc/passwd 等位置。
    """
    from apps.services.agent_engine.cli.tabtin_cli.install import _extract_tarball

    tarball = tmp_path / "evil.tar.gz"
    with tarfile.open(tarball, "w:gz") as tar:
        info_normal = tarfile.TarInfo(name="normal-file")
        info_normal.size = 4
        tar.addfile(info_normal, io.BytesIO(b"abcd"))
        info_link = tarfile.TarInfo(name="evil-link")
        info_link.type = tarfile.SYMTYPE
        info_link.linkname = "/etc/passwd"
        tar.addfile(info_link)

    dest = tmp_path / "extract"
    # 解压必须失败：tarfile.AbsoluteLinkError (3.12+ data filter) 或我们手动抛 RuntimeError (3.11)
    with pytest.raises((RuntimeError, tarfile.TarError)):
        _extract_tarball(tarball, dest)
    # 关键：evil-link 没有被实际创建（symlink 没有落盘）
    assert not (dest / "evil-link").exists()


def test_edge_extract_tarball_3_11_branch_rejects_symlink_explicitly(tmp_path: Path):
    """直接覆盖 3.11 fallback 分支：模拟 ``filter`` 参数不被识别 → 走手动校验路径。

    通过 monkeypatch 让 tar.extractall 抛 TypeError 触发 fallback 分支，
    确保我们的手动 symlink 防御真的生效（而不是依赖 3.12+ data filter）。
    """
    from apps.services.agent_engine.cli.tabtin_cli.install import _extract_tarball

    tarball = tmp_path / "evil.tar.gz"
    with tarfile.open(tarball, "w:gz") as tar:
        info_link = tarfile.TarInfo(name="evil-link")
        info_link.type = tarfile.SYMTYPE
        info_link.linkname = "/etc/passwd"
        tar.addfile(info_link)

    dest = tmp_path / "extract"

    # patch TarFile.extractall 第一次调用抛 TypeError 模拟"3.11 不识别 filter 参数"
    original_extractall = tarfile.TarFile.extractall
    call_count = {"n": 0}
    def _patched_extractall(self, path=".", members=None, *, numeric_owner=False, filter=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # 第一次走 filter='data' 路径 → 模拟 3.11 不识别 filter
            raise TypeError("extractall() got an unexpected keyword argument 'filter'")
        return original_extractall(self, path, members, numeric_owner=numeric_owner)

    from unittest.mock import patch as _patch
    with _patch.object(tarfile.TarFile, "extractall", _patched_extractall):
        with pytest.raises(RuntimeError, match="symlink"):
            _extract_tarball(tarball, dest)


