"""``compute_known_binaries`` 单元测试（A5 启动包 / A1-L4 收口）。

覆盖：

- happy
  - 显式 manifest_root 注入：识别 demo App 的 cli.binary
  - cache 命中：第二次调用走缓存（不重复扫盘）
- error / fail-safe
  - 不存在的 manifest_root：回退到 KNOWN_BINARIES
  - 不可读 / 损坏的 app.json：跳过该条目，扫描其他正常条目
  - 顶层非 dict / cli 非 dict / cli.binary 非 string / 空：跳过
- edge
  - cache_invalidate 后重新扫描（marketplace App 安装后失效场景）
  - frozenset 不可变（防御性）
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apps.services.agent_engine.cli.spec import (
    KNOWN_BINARIES,
    compute_known_binaries,
    invalidate_known_binaries_cache,
)


# ───────────────────────── helpers ───────────────────────────────


def _write_manifest(root: Path, app_id: str, manifest: dict) -> None:
    app_dir = root / app_id
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "app.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8",
    )


def _make_simple_app_manifest(app_id: str, binary: str) -> dict:
    return {
        "id": app_id,
        "name": app_id,
        "kind": "app",
        "version": "1.0.0",
        "distribution": "marketplace",
        "cli": {
            "binary": binary,
            "version": "1.0.0",
            "downloadUrl": "https://example.com/{platform}/{arch}",
            "platformMap": {"darwin": "darwin", "linux": "linux", "win32": "windows"},
            "archMap": {"x64": "amd64", "arm64": "arm64"},
        },
    }


@pytest.fixture(autouse=True)
def _clean_cache():
    """每个 case 清掉 module-level cache，避免相互污染。"""
    invalidate_known_binaries_cache()
    yield
    invalidate_known_binaries_cache()


# ───────────────────────── happy ─────────────────────────────────


def test_happy_default_baseline_contains_known_binaries():
    """真实仓库 manifest 扫描：基线 KNOWN_BINARIES（仅 ``tabtin``）始终在合并白名单中。"""
    binaries = compute_known_binaries()
    # KNOWN_BINARIES 全部在并集中
    assert KNOWN_BINARIES <= binaries
    # baseline 至少包含平台自身的 ``tabtin``
    assert "tabtin" in binaries


def test_happy_explicit_manifest_root_picks_up_demo_app(tmp_path: Path):
    """显式注入扫描根：识别假 demo App 的 cli.binary。"""
    _write_manifest(tmp_path, "tabtin-demo-app", _make_simple_app_manifest(
        "tabtin-demo-app", "demo-cli",
    ))
    binaries = compute_known_binaries(manifest_root=tmp_path)
    assert "demo-cli" in binaries
    # 基线 KNOWN_BINARIES 仍在并集
    assert KNOWN_BINARIES <= binaries


def test_happy_multiple_marketplace_apps_all_picked(tmp_path: Path):
    """多个 marketplace App 的 binary 全部进入白名单。"""
    _write_manifest(tmp_path, "demo-a", _make_simple_app_manifest("demo-a", "a-cli"))
    _write_manifest(tmp_path, "demo-b", _make_simple_app_manifest("demo-b", "b-cli"))
    _write_manifest(tmp_path, "demo-c", _make_simple_app_manifest("demo-c", "c-cli"))
    binaries = compute_known_binaries(manifest_root=tmp_path)
    assert {"a-cli", "b-cli", "c-cli"} <= binaries


def test_happy_cache_hit_on_second_call():
    """连续两次调用：第二次必须走缓存（同一个 frozenset 实例）。"""
    first = compute_known_binaries()
    second = compute_known_binaries()
    # frozenset 是不可变的；缓存命中时返回同一对象（``is`` 比较）
    assert first is second


# ───────────────────────── fail-safe / error ───────────────────────


def test_fallback_when_manifest_root_missing(tmp_path: Path):
    """不存在的扫描根：fallback 到 KNOWN_BINARIES，绝不抛异常。"""
    nonexistent = tmp_path / "nope"
    binaries = compute_known_binaries(manifest_root=nonexistent)
    assert binaries == KNOWN_BINARIES


def test_skip_corrupt_json(tmp_path: Path):
    """损坏的 app.json：跳过本条目，其他正常条目不受影响。

    用自装 handler 捕获日志（caplog 在 Django settings 干扰下不稳）。
    """
    import logging
    _write_manifest(tmp_path, "good", _make_simple_app_manifest("good", "good-cli"))
    bad_dir = tmp_path / "bad"
    bad_dir.mkdir()
    (bad_dir / "app.json").write_text("not valid json{", encoding="utf-8")

    captured: list[str] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record.getMessage())

    target_logger = logging.getLogger("apps.services.agent_engine.cli.spec")
    handler = _Capture(level=logging.DEBUG)
    target_logger.addHandler(handler)
    prev_level = target_logger.level
    target_logger.setLevel(logging.DEBUG)
    try:
        binaries = compute_known_binaries(manifest_root=tmp_path)
    finally:
        target_logger.removeHandler(handler)
        target_logger.setLevel(prev_level)

    # 好的条目被采纳，坏的条目被跳过
    assert "good-cli" in binaries
    # 必须有 warning 级日志记录"解析失败"且包含 bad 路径
    assert any("解析" in msg and "bad" in msg for msg in captured), captured


def test_skip_non_dict_top_level(tmp_path: Path):
    """app.json 顶层是 list / string：跳过该条目。"""
    bad_dir = tmp_path / "weird"
    bad_dir.mkdir()
    (bad_dir / "app.json").write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")

    binaries = compute_known_binaries(manifest_root=tmp_path)
    assert binaries == KNOWN_BINARIES  # 仅 fallback


def test_skip_when_cli_section_not_dict(tmp_path: Path):
    """``cli`` 不是 dict：跳过条目。"""
    _write_manifest(tmp_path, "weird", {
        "id": "weird", "name": "Weird", "kind": "app",
        "version": "1.0", "cli": "not-a-dict",
    })
    binaries = compute_known_binaries(manifest_root=tmp_path)
    assert binaries == KNOWN_BINARIES


def test_skip_when_cli_binary_missing_or_empty(tmp_path: Path):
    """``cli.binary`` 缺失 / 空字符串 / 非 string：跳过。"""
    _write_manifest(tmp_path, "no-binary", {
        "id": "no-binary", "name": "No", "kind": "app",
        "version": "1.0", "cli": {"version": "1.0"},
    })
    _write_manifest(tmp_path, "empty-binary", {
        "id": "empty-binary", "name": "E", "kind": "app",
        "version": "1.0", "cli": {"binary": ""},
    })
    _write_manifest(tmp_path, "non-string-binary", {
        "id": "non-string-binary", "name": "N", "kind": "app",
        "version": "1.0", "cli": {"binary": 123},
    })
    binaries = compute_known_binaries(manifest_root=tmp_path)
    assert binaries == KNOWN_BINARIES  # 三个 invalid 都被跳过


def test_no_app_json_in_subdir(tmp_path: Path):
    """子目录无 app.json：跳过（不抛 FileNotFoundError）。"""
    (tmp_path / "without-manifest").mkdir()
    binaries = compute_known_binaries(manifest_root=tmp_path)
    assert binaries == KNOWN_BINARIES


def test_skips_non_directory_entries(tmp_path: Path):
    """根目录下非目录文件（如 README）：跳过。"""
    (tmp_path / "README.md").write_text("hi", encoding="utf-8")
    _write_manifest(tmp_path, "good", _make_simple_app_manifest("good", "good-cli"))
    binaries = compute_known_binaries(manifest_root=tmp_path)
    assert "good-cli" in binaries


# ───────────────────────── edge ──────────────────────────────────


def test_invalidate_cache_forces_rescan(tmp_path: Path, monkeypatch):
    """主动 invalidate cache 后下次调用重新扫描。"""
    _write_manifest(tmp_path, "first", _make_simple_app_manifest("first", "first-cli"))
    monkeypatch.setenv("TABTIN_APPS_MANIFEST_ROOT", str(tmp_path))

    binaries1 = compute_known_binaries()
    assert "first-cli" in binaries1

    # 新增一个 App 后，cache 命中时不会被识别
    _write_manifest(tmp_path, "second", _make_simple_app_manifest("second", "second-cli"))
    binaries_cached = compute_known_binaries()
    # cache 命中：second-cli 不在
    assert "second-cli" not in binaries_cached

    # invalidate → 重新扫描 → second-cli 被识别
    invalidate_known_binaries_cache()
    binaries_fresh = compute_known_binaries()
    assert "second-cli" in binaries_fresh


def test_explicit_root_bypasses_cache(tmp_path: Path):
    """显式 manifest_root 总是绕过 cache（测试用，避免相互污染）。"""
    other = tmp_path / "other"
    other.mkdir()
    _write_manifest(other, "alt", _make_simple_app_manifest("alt", "alt-cli"))
    # 第一次走 cache（默认 root）
    default = compute_known_binaries()
    assert "alt-cli" not in default
    # 显式 root：不读 cache，独立扫描
    explicit = compute_known_binaries(manifest_root=other)
    assert "alt-cli" in explicit
    # 默认 cache 不被显式 root 污染
    default2 = compute_known_binaries()
    assert "alt-cli" not in default2


def test_use_cache_false_bypasses_read_and_write(tmp_path: Path, monkeypatch):
    """``use_cache=False`` 既不读也不写 cache（实现约定，避免测试 cache 污染主流程）。"""
    _write_manifest(tmp_path, "x", _make_simple_app_manifest("x", "x-cli"))
    monkeypatch.setenv("TABTIN_APPS_MANIFEST_ROOT", str(tmp_path))

    # 第一次默认调用：写 cache（含 x-cli）
    first = compute_known_binaries()
    assert "x-cli" in first

    # 新增 y 条目；use_cache=False 强制扫盘且不写 cache
    _write_manifest(tmp_path, "y", _make_simple_app_manifest("y", "y-cli"))
    bypass = compute_known_binaries(use_cache=False)
    assert "y-cli" in bypass
    assert "x-cli" in bypass

    # cache 仍是第一次的快照（不含 y-cli），保持无副作用
    cached = compute_known_binaries()
    assert cached is first
    assert "y-cli" not in cached


def test_returns_frozenset_immutable():
    """compute_known_binaries 必须返回 frozenset（不可变）。"""
    binaries = compute_known_binaries()
    assert isinstance(binaries, frozenset)
    with pytest.raises(AttributeError):
        binaries.add("evil")  # type: ignore[attr-defined]


def test_env_var_manifest_root_takes_precedence(tmp_path: Path, monkeypatch):
    """``TABTIN_APPS_MANIFEST_ROOT`` 环境变量优先于默认仓库扫描根。

    通过"假 binary 仅在 env-root 出现"来证明 env 生效；同时验证 baseline
    ``KNOWN_BINARIES``（仅 ``tabtin``）始终保留在合并结果中。
    """
    _write_manifest(tmp_path, "envroot", _make_simple_app_manifest("envroot", "env-cli"))
    monkeypatch.setenv("TABTIN_APPS_MANIFEST_ROOT", str(tmp_path))
    binaries = compute_known_binaries()
    assert "env-cli" in binaries
    # baseline 始终保留
    assert "tabtin" in binaries
    # env 指向 tmp_path，真实仓库的其他 marketplace App 不会在结果中：
    # binaries 严格等于 KNOWN_BINARIES ∪ {env-cli}
    assert binaries == frozenset(KNOWN_BINARIES | {"env-cli"})
