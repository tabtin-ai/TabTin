"""Wave 10 i18n 横向扩展 — tabslide app 错误响应 i18n key 守护。

参见 apps/scheduler/tests/test_i18n_keys.py(Wave 9 SOP 模板)。
本文件守护 tabslide/api.py 错误响应不再含中文硬编码。

跑法::

    cd apps/tabtin_django && source venv/bin/activate
    python -m pytest apps/tabslide/tests/test_i18n_keys.py -v
"""
from __future__ import annotations

import pytest

# Wave 10 治理范围内,tabslide app 真实使用的 i18n key 清单
TABSLIDE_I18N_KEYS = [
    # 既有 key(api.py 已使用)
    "tabslide.project_not_found",
    "tabslide.no_permission_to_import",
    # Wave 10 新增 — tabslide/api.py
    "tabslide.agent_space_not_found",
    "tabslide.import_task_not_found",
    "tabslide.no_permission_to_access_project_space",
    "tabslide.page_not_found_with_id",
    "tabslide.page_save_payload_required",
    "tabslide.pptx_invalid_zip_signature",
    "tabslide.export_format_not_pptx",
    "tabslide.slide_project_id_required",
    "tabslide.updates_required",
    "tabslide.batch_update_limit_exceeded",
]


@pytest.mark.parametrize("key", TABSLIDE_I18N_KEYS)
def test_tabslide_i18n_key_resolves_in_zh_cn(key: str) -> None:
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    text = get_text(key, language=SupportedLanguage.ZH_CN)

    assert text != key, (
        f"i18n key {key!r} 在 zh-CN 翻译缺失。"
        f"请在 apps/i18n/locales/zh-CN.json 'tabslide' 节点下补齐。"
    )
    assert text, f"i18n key {key!r} 在 zh-CN 翻译为空"


@pytest.mark.parametrize("key", TABSLIDE_I18N_KEYS)
def test_tabslide_i18n_key_resolves_in_en_us(key: str) -> None:
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    text = get_text(key, language=SupportedLanguage.EN_US)

    assert text != key, (
        f"i18n key {key!r} 在 en-US 翻译缺失。"
        f"请在 apps/i18n/locales/en-US.json 'tabslide' 节点下补齐。"
    )
    assert text, f"i18n key {key!r} 在 en-US 翻译为空"


def test_tabslide_i18n_zh_en_keys_are_consistent() -> None:
    """zh-CN 与 en-US 的 tabslide.* 键集合必须一致。"""
    from apps.i18n.manager import i18n_manager
    from apps.i18n.language import SupportedLanguage

    zh_tabslide = (
        i18n_manager.translations.get(SupportedLanguage.ZH_CN, {}).get("tabslide", {})
    )
    en_tabslide = (
        i18n_manager.translations.get(SupportedLanguage.EN_US, {}).get("tabslide", {})
    )

    zh_keys = set(zh_tabslide.keys())
    en_keys = set(en_tabslide.keys())

    missing_in_en = zh_keys - en_keys
    missing_in_zh = en_keys - zh_keys

    assert not missing_in_en, (
        f"zh-CN tabslide.* 有 key 但 en-US 缺失: {sorted(missing_in_en)}"
    )
    assert not missing_in_zh, (
        f"en-US tabslide.* 有 key 但 zh-CN 缺失: {sorted(missing_in_zh)}"
    )


def test_tabslide_api_no_chinese_hardcoded_in_responses() -> None:
    """死字段防线 — tabslide/api.py 不应再有 *_response(中文) 硬编码。"""
    import re
    from pathlib import Path

    tabslide_root = Path(__file__).resolve().parents[1]
    suspect_files = [
        tabslide_root / "api.py",
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
        "Wave 10 i18n 治理后 tabslide app 不应再有 *_response(中文字面量) 硬编码:\n"
        + "\n".join(f"  {p}:{ln}  {snippet}" for p, ln, snippet in offenders)
    )


def test_tabslide_parameterized_keys_substitute() -> None:
    """带模板参数的 key 应当能正确替换。"""
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    # page_not_found_with_id 模板含 {page_id}
    text = get_text(
        "tabslide.page_not_found_with_id",
        language=SupportedLanguage.ZH_CN,
        page_id="page-001",
    )
    assert "page-001" in text, f"模板参数未被替换。实际: {text!r}"

    # batch_update_limit_exceeded 模板含 {count}
    text = get_text(
        "tabslide.batch_update_limit_exceeded",
        language=SupportedLanguage.EN_US,
        count=350,
    )
    assert "350" in text, f"模板参数未被替换。实际: {text!r}"

    # export_format_not_pptx 模板含 {format}
    text = get_text(
        "tabslide.export_format_not_pptx",
        language=SupportedLanguage.ZH_CN,
        format="pdf",
    )
    assert "pdf" in text
