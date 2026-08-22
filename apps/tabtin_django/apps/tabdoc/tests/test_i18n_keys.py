"""Wave 10 i18n 横向扩展 — tabdoc app 错误响应 i18n key 守护。

背景(Wave 9 任务 2 已建立 SOP,Wave 10 复用):
  Wave 9 在 scheduler app 建立 i18n 治理 SOP,Wave 10 把同一套规则复制到
  tabdoc(api.py / api_share.py)。错误响应不再使用裸中文字面量,统一走 i18n key。

本文件守护:
  1. 治理范围内的 i18n key 在 zh-CN.json / en-US.json **同时存在**(防漏键)
  2. zh-CN / en-US 的翻译都不退化为返回 key 本身
  3. 死字段防线 — `apps/tabdoc/api.py` `apps/tabdoc/api_share.py` 不应再有
     `*_response("中文字面量")` 硬编码

跑法::

    cd apps/tabtin_django && source venv/bin/activate
    python -m pytest apps/tabdoc/tests/test_i18n_keys.py -v
"""
from __future__ import annotations

import pytest

# Wave 10 治理范围内,tabdoc app 真实使用的 i18n key 清单
TABDOC_I18N_KEYS = [
    # api.py / api_share.py 治理后用到的 key
    "tabdoc.document_not_found",
    "tabdoc.html_block_not_found",
    "tabdoc.auth_required",
    "tabdoc.invalid_base64_data",
    "tabdoc.version_or_version_id_required",
    "tabdoc.share_not_found",
    "tabdoc.active_share_not_found",
    "tabdoc.share_invalid_or_expired",
    "tabdoc.share_expired",
    "tabdoc.share_password_required",
    "tabdoc.share_password_incorrect",
    "tabdoc.share_permission_denied",
    "tabdoc.invalid_share_type",
    "tabdoc.invalid_share_permission",
    "tabdoc.organization_required_for_organization_share",
    "tabdoc.public_exposure_ack_required",
]


@pytest.mark.parametrize("key", TABDOC_I18N_KEYS)
def test_tabdoc_i18n_key_resolves_in_zh_cn(key: str) -> None:
    """每个 key 在 zh-CN 下必须有真翻译,不能返回 key 字符串本身。"""
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    text = get_text(key, language=SupportedLanguage.ZH_CN)

    assert text != key, (
        f"i18n key {key!r} 在 zh-CN 翻译缺失(返回了 key 本身)。"
        f"请在 apps/i18n/locales/zh-CN.json 'tabdoc' 节点下补齐。"
    )
    assert text, f"i18n key {key!r} 在 zh-CN 翻译为空"


@pytest.mark.parametrize("key", TABDOC_I18N_KEYS)
def test_tabdoc_i18n_key_resolves_in_en_us(key: str) -> None:
    """每个 key 在 en-US 下必须有真翻译。"""
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    text = get_text(key, language=SupportedLanguage.EN_US)

    assert text != key, (
        f"i18n key {key!r} 在 en-US 翻译缺失(返回了 key 本身)。"
        f"请在 apps/i18n/locales/en-US.json 'tabdoc' 节点下补齐。"
    )
    assert text, f"i18n key {key!r} 在 en-US 翻译为空"


def test_tabdoc_i18n_zh_en_keys_are_consistent() -> None:
    """zh-CN 与 en-US 的 tabdoc.* 键集合必须一致(无单边遗漏)。"""
    from apps.i18n.manager import i18n_manager
    from apps.i18n.language import SupportedLanguage

    zh_tabdoc = (
        i18n_manager.translations.get(SupportedLanguage.ZH_CN, {}).get("tabdoc", {})
    )
    en_tabdoc = (
        i18n_manager.translations.get(SupportedLanguage.EN_US, {}).get("tabdoc", {})
    )

    zh_keys = set(zh_tabdoc.keys())
    en_keys = set(en_tabdoc.keys())

    missing_in_en = zh_keys - en_keys
    missing_in_zh = en_keys - zh_keys

    assert not missing_in_en, (
        f"zh-CN tabdoc.* 有 key 但 en-US 缺失: {sorted(missing_in_en)}"
    )
    assert not missing_in_zh, (
        f"en-US tabdoc.* 有 key 但 zh-CN 缺失: {sorted(missing_in_zh)}"
    )


def test_tabdoc_api_no_chinese_hardcoded_in_responses() -> None:
    """死字段防线 — tabdoc app 错误响应不应再有中文硬编码字面量。

    扫描:
      - apps/tabdoc/api.py
      - apps/tabdoc/api_share.py

    匹配模式:
      *_response("...中文..."[, "..."]) — 包括 1 参或 2 参形式
      *_response(f"...中文...") — f-string 形式
      error_response("...", "...中文...", ...) — 带 code 的 2 参形式
    """
    import re
    from pathlib import Path

    tabdoc_root = Path(__file__).resolve().parents[1]
    suspect_files = [
        tabdoc_root / "api.py",
        tabdoc_root / "api_share.py",
    ]

    # 模式 1:*_response("...中文...") / *_response(f"...中文...")
    chinese_in_response_re = re.compile(
        r"(?:permission_denied_response|not_found_response|validation_error_response|error_response)"
        r"\(\s*f?\"[^\"]*[一-鿿][^\"]*\""
    )
    # 模式 2:error_response("CODE", "...中文...", ...)
    chinese_in_error_response_re = re.compile(
        r"error_response\(\s*\"[A-Z_]+\"\s*,\s*\"[^\"]*[一-鿿][^\"]*\""
    )

    offenders: list[tuple[str, int, str]] = []
    for path in suspect_files:
        if not path.exists():
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if chinese_in_response_re.search(line) or chinese_in_error_response_re.search(line):
                offenders.append((str(path), lineno, line.strip()))

    assert not offenders, (
        "Wave 10 i18n 治理后 tabdoc app 不应再有 *_response(中文字面量) 硬编码:\n"
        + "\n".join(f"  {p}:{ln}  {snippet}" for p, ln, snippet in offenders)
    )


def test_tabdoc_parameterized_key_substitutes() -> None:
    """tabdoc 的 invalid_uuid 等带模板参数的 key 应当正确替换变量。"""
    from apps.i18n import get_text
    from apps.i18n.language import SupportedLanguage

    # invalid_uuid 模板含 {value}
    text_zh = get_text(
        "tabdoc.invalid_uuid",
        language=SupportedLanguage.ZH_CN,
        value="abc-123",
    )
    assert "abc-123" in text_zh, (
        f"模板参数未被替换。实际消息: {text_zh!r}"
    )
