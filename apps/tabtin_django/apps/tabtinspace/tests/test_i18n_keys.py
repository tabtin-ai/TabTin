"""Wave 10 i18n 横向扩展 — tabtinspace app 错误响应 i18n key 守护。

参见 apps/scheduler/tests/test_i18n_keys.py(Wave 9 SOP 模板)。
本文件守护 tabtinspace 全部 routers + admin_api 不再含中文硬编码。

跑法::

    cd apps/tabtin_django && source venv/bin/activate
    python -m pytest apps/tabtinspace/tests/test_i18n_keys.py -v
"""
from __future__ import annotations

import pytest

# Wave 10 治理范围内,tabtinspace app 真实使用的 i18n key 清单
TABTINSPACE_I18N_KEYS = [
    # 既有(Wave 10 之前已在 locales)
    "tabtinspace.no_organization_access",
    # Wave 10 新增 — routers/space.py
    "tabtinspace.space_get_failed",
    "tabtinspace.space_update_failed",
    "tabtinspace.space_create_failed",
    "tabtinspace.space_archive_failed",
    "tabtinspace.space_restore_failed",
    "tabtinspace.space_delete_failed",
    "tabtinspace.space_trash_failed",
    "tabtinspace.space_permanent_delete_failed",
    "tabtinspace.space_stats_failed",
    # Wave 10 新增 — routers/device.py + remote_server.py
    "tabtinspace.device_not_found",
    "tabtinspace.space_or_device_not_found",
    "tabtinspace.server_not_found",
    # IA Phase 1·1C 新增 — routers/mcp_connection.py
    "tabtinspace.mcp_connection_not_found",
    # Wave 10 新增 — routers/app_catalog.py + organization.py
    "tabtinspace.admin_required",
    "tabtinspace.permission_denied",
    # Wave 10 新增 — routers/agent.py
    "tabtinspace.agent_or_device_not_found",
    # Wave 10 新增 — routers/collection.py
    "tabtinspace.collection_create_failed",
    "tabtinspace.collection_update_failed",
    "tabtinspace.collection_not_found",
    "tabtinspace.collection_delete_failed",
    "tabtinspace.collection_reorder_failed",
    # Wave 10 新增 — routers/tabfiles.py
    "tabtinspace.tabfile_upload_failed",
    "tabtinspace.tabfile_archive_failed",
    "tabtinspace.tabfile_not_found",
    "tabtinspace.tabfile_trashed",
    "tabtinspace.tabfile_restored",
    "tabtinspace.tabfile_permanently_deleted",
    # Wave 10 新增 — routers/capability.py
    "tabtinspace.no_space_access",
    # Wave 10 新增 — routers/context_item.py
    "tabtinspace.context_item_create_failed",
    "tabtinspace.context_item_not_found",
    "tabtinspace.context_item_update_failed",
    "tabtinspace.context_item_archive_failed",
    #  ContextItem.parent
    "tabtinspace.parent_item_not_found",
    "tabtinspace.parent_item_invalid_type",
    "tabtinspace.parent_item_trashed",
    "tabtinspace.parent_item_cross_host",
    "tabtinspace.parent_item_cycle",
    "tabtinspace.parent_item_max_depth",
    # Wave 10 新增 — routers/share.py
    "tabtinspace.share_grant_failed",
    "tabtinspace.share_revoke_failed",
    # Wave 10 新增 — admin_api.py
    "tabtinspace.organization_not_found",
    "tabtinspace.trash_resource_not_found",
    "tabtinspace.unsupported_resource_type",
    "tabtinspace.related_resource_not_found",
]


@pytest.mark.parametrize("key", TABTINSPACE_I18N_KEYS)
def test_tabtinspace_i18n_key_resolves_in_zh_cn(key: str) -> None:
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    text = get_text(key, language=SupportedLanguage.ZH_CN)

    assert text != key, (
        f"i18n key {key!r} 在 zh-CN 翻译缺失。"
        f"请在 apps/i18n/locales/zh-CN.json 'tabtinspace' 节点下补齐。"
    )
    assert text, f"i18n key {key!r} 在 zh-CN 翻译为空"


@pytest.mark.parametrize("key", TABTINSPACE_I18N_KEYS)
def test_tabtinspace_i18n_key_resolves_in_en_us(key: str) -> None:
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    text = get_text(key, language=SupportedLanguage.EN_US)

    assert text != key, (
        f"i18n key {key!r} 在 en-US 翻译缺失。"
        f"请在 apps/i18n/locales/en-US.json 'tabtinspace' 节点下补齐。"
    )
    assert text, f"i18n key {key!r} 在 en-US 翻译为空"


def test_tabtinspace_i18n_zh_en_keys_are_consistent() -> None:
    """zh-CN 与 en-US 的 tabtinspace.* 键集合必须一致。"""
    from apps.i18n.manager import i18n_manager
    from apps.i18n.language import SupportedLanguage

    zh_ts = (
        i18n_manager.translations.get(SupportedLanguage.ZH_CN, {}).get("tabtinspace", {})
    )
    en_ts = (
        i18n_manager.translations.get(SupportedLanguage.EN_US, {}).get("tabtinspace", {})
    )

    zh_keys = set(zh_ts.keys())
    en_keys = set(en_ts.keys())

    missing_in_en = zh_keys - en_keys
    missing_in_zh = en_keys - zh_keys

    assert not missing_in_en, (
        f"zh-CN tabtinspace.* 有 key 但 en-US 缺失: {sorted(missing_in_en)}"
    )
    assert not missing_in_zh, (
        f"en-US tabtinspace.* 有 key 但 zh-CN 缺失: {sorted(missing_in_zh)}"
    )


def test_tabtinspace_api_no_chinese_hardcoded_in_responses() -> None:
    """死字段防线 — tabtinspace 全部 routers + admin_api 不应再有
    `*_response(中文字面量)` 硬编码。
    """
    import re
    from pathlib import Path

    tabtinspace_root = Path(__file__).resolve().parents[1]
    suspect_files = [
        tabtinspace_root / "admin_api.py",
        tabtinspace_root / "routers" / "space.py",
        tabtinspace_root / "routers" / "device.py",
        tabtinspace_root / "routers" / "agent.py",
        tabtinspace_root / "routers" / "collection.py",
        tabtinspace_root / "routers" / "context_item.py",
        tabtinspace_root / "routers" / "remote_server.py",
        tabtinspace_root / "routers" / "share.py",
        tabtinspace_root / "routers" / "tabfiles.py",
        tabtinspace_root / "routers" / "capability.py",
        tabtinspace_root / "routers" / "app_catalog.py",
        tabtinspace_root / "routers" / "organization.py",
    ]

    chinese_in_response_re = re.compile(
        r"(?:permission_denied_response|not_found_response|validation_error_response|error_response)"
        r"\(\s*f?\"[^\"]*[一-鿿][^\"]*\""
    )

    offenders: list[tuple[str, int, str]] = []
    for path in suspect_files:
        if not path.exists():
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if chinese_in_response_re.search(line):
                offenders.append((str(path), lineno, line.strip()))

    assert not offenders, (
        "Wave 10 i18n 治理后 tabtinspace app 不应再有 *_response(中文字面量) 硬编码:\n"
        + "\n".join(f"  {p}:{ln}  {snippet}" for p, ln, snippet in offenders)
    )


def test_tabtinspace_parameterized_key_substitutes() -> None:
    """带模板参数的 key 应当能正确替换变量。"""
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    # unsupported_resource_type 模板含 {item_type}
    text = get_text(
        "tabtinspace.unsupported_resource_type",
        language=SupportedLanguage.ZH_CN,
        item_type="weird_type",
    )
    assert "weird_type" in text, f"模板参数未被替换。实际: {text!r}"

    text = get_text(
        "tabtinspace.unsupported_resource_type",
        language=SupportedLanguage.EN_US,
        item_type="bogus",
    )
    assert "bogus" in text
