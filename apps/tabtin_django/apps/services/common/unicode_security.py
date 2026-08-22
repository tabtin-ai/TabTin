"""
Unicode 安全防护工具

防范通过不可见 Unicode 字符（零宽字符、方向控制符、Hangul Filler、Tag Characters、
Variation Selectors、Interlinear Annotation 等）制造的指令混淆攻击。
攻击者可利用这些字符绕过规则匹配、URL 校验等安全策略。

策略：检测 + 清除 + 日志（不阻断正常输入），兼容合法的中日韩文和 Emoji。

码点清单同步来源：support/app/specs/unicode-dangerous-codepoints.json
参考：Hangul Filler 转义硬化；Pliny Tag Characters 攻击向量。
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import FrozenSet, Optional, Tuple

logger = logging.getLogger(__name__)

# ── 危险不可见字符集 ────────────────────────────────────────────

_ZERO_WIDTH: FrozenSet[int] = frozenset({
    0x200B,  # Zero Width Space
    0x200C,  # Zero Width Non-Joiner
    0x200D,  # Zero Width Joiner
    0xFEFF,  # BOM / Zero Width No-Break Space
})

_BIDI_CONTROL: FrozenSet[int] = frozenset({
    0x200E,  # Left-to-Right Mark
    0x200F,  # Right-to-Left Mark
    0x202A,  # Left-to-Right Embedding
    0x202B,  # Right-to-Left Embedding
    0x202C,  # Pop Directional Formatting
    0x202D,  # Left-to-Right Override
    0x202E,  # Right-to-Left Override
    0x2066,  # Left-to-Right Isolate
    0x2067,  # Right-to-Left Isolate
    0x2068,  # First Strong Isolate
    0x2069,  # Pop Directional Isolate
})

_HANGUL_FILLER: FrozenSet[int] = frozenset({
    0x3164,  # Hangul Filler
    0xFFA0,  # Halfwidth Hangul Filler
})

_OTHER_INVISIBLE: FrozenSet[int] = frozenset({
    0x00AD,  # Soft Hyphen
    0x034F,  # Combining Grapheme Joiner
    0x061C,  # Arabic Letter Mark
    0x180E,  # Mongolian Vowel Separator
    0x2060,  # Word Joiner
    0x2061,  # Function Application（不可见数学运算符）
    0x2062,  # Invisible Times
    0x2063,  # Invisible Separator
    0x2064,  # Invisible Plus
    0x2800,  # Braille Pattern Blank（视觉空白）
})

_TAG_CHARACTERS: FrozenSet[int] = frozenset(range(0xE0001, 0xE0080))

_INTERLINEAR_ANNOTATION: FrozenSet[int] = frozenset({
    0xFFF9,  # Interlinear Annotation Anchor
    0xFFFA,  # Interlinear Annotation Separator
    0xFFFB,  # Interlinear Annotation Terminator
})

_VARIATION_SELECTORS: FrozenSet[int] = (
    frozenset(range(0xFE00, 0xFE10))       # VS1–VS16
    | frozenset(range(0xE0100, 0xE01F0))   # VS17–VS256 (Supplement)
)

DANGEROUS_INVISIBLE_CODEPOINTS: FrozenSet[int] = (
    _ZERO_WIDTH | _BIDI_CONTROL | _HANGUL_FILLER | _OTHER_INVISIBLE
    | _TAG_CHARACTERS | _INTERLINEAR_ANNOTATION | _VARIATION_SELECTORS
)

# ── Emoji 安全豁免集 ────────────────────────────────────────────
# 以下码点虽属于"危险不可见"范畴，但在 Emoji 渲染中有合法用途：
# - U+FE0F (VS16)：Emoji 变体选择符，几乎所有彩色 Emoji 依赖它（❤️ vs ❤）
# - U+E0061-U+E007A：Tag lowercase letters，用于 Emoji Flag Sequences（🏴󠁧󠁢󠁥󠁮󠁧󠁿）
# - U+E007F：Cancel Tag，终止 Tag 序列
EMOJI_SAFE_CHARS: FrozenSet[int] = frozenset(
    {0xFE0F}   # Variation Selector-16（Emoji 样式选择）
    | {0x200D}  # Zero Width Joiner（Emoji ZWJ 序列：👨‍💻 👨‍👩‍👧‍👦 🏳️‍🌈）
    | set(range(0xE0061, 0xE007B))  # Tag lowercase letters（Flag Sequences）
    | {0xE007F}  # Cancel Tag
)

_CONTENT_SAFE_CODEPOINTS: FrozenSet[int] = DANGEROUS_INVISIBLE_CODEPOINTS - EMOJI_SAFE_CHARS
"""内容场景下需要清除的码点：排除了 Emoji 合法使用的 VS16 和 Tag 子集。"""


def _build_char_class(codepoints: FrozenSet[int]) -> re.Pattern:
    """构建高效的正则字符类，对连续码点使用范围语法。"""
    sorted_cps = sorted(codepoints)
    parts: list[str] = []
    i = 0
    while i < len(sorted_cps):
        start = sorted_cps[i]
        end = start
        while i + 1 < len(sorted_cps) and sorted_cps[i + 1] == end + 1:
            end = sorted_cps[i + 1]
            i += 1
        if end - start >= 2:
            parts.append(f"{chr(start)}-{chr(end)}")
        elif end > start:
            parts.append(chr(start) + chr(end))
        else:
            parts.append(chr(start))
        i += 1
    return re.compile("[" + "".join(parts) + "]")


_DANGEROUS_CHARS_RE = _build_char_class(DANGEROUS_INVISIBLE_CODEPOINTS)
_CONTENT_SAFE_RE = _build_char_class(_CONTENT_SAFE_CODEPOINTS)

# 按类别分组，用于日志描述
_CATEGORY_NAMES = {
    "zero_width": _ZERO_WIDTH,
    "bidi_control": _BIDI_CONTROL,
    "hangul_filler": _HANGUL_FILLER,
    "other_invisible": _OTHER_INVISIBLE,
    "tag_characters": _TAG_CHARACTERS,
    "interlinear_annotation": _INTERLINEAR_ANNOTATION,
    "variation_selectors": _VARIATION_SELECTORS,
}


# ── 核心 API ────────────────────────────────────────────────────


def contains_invisible_unicode(
    text: str,
    *,
    preserve_emoji: bool = True,
) -> bool:
    """检测文本中是否包含危险的不可见 Unicode 字符。

    不会误报合法的 CJK 文字、Emoji 或普通空白符。

    Args:
        preserve_emoji: 为 True 时豁免 VS16 和 Emoji Tag 序列码点（默认）。
            安全校验场景应传 False 以检测所有危险码点。
    """
    if not text:
        return False
    pattern = _CONTENT_SAFE_RE if preserve_emoji else _DANGEROUS_CHARS_RE
    return bool(pattern.search(text))


def detect_invisible_unicode(
    text: str,
    *,
    preserve_emoji: bool = True,
) -> Optional[Tuple[str, list]]:
    """检测并返回详细信息：(类别描述, [(字符, 位置, Unicode名称)])。

    无危险字符时返回 None。

    Args:
        preserve_emoji: 为 True 时豁免 VS16 和 Emoji Tag 序列码点（默认）。
    """
    if not text:
        return None

    effective = _CONTENT_SAFE_CODEPOINTS if preserve_emoji else DANGEROUS_INVISIBLE_CODEPOINTS
    findings: list = []
    categories_hit: set = set()

    for i, ch in enumerate(text):
        cp = ord(ch)
        if cp in effective:
            for cat_name, cat_set in _CATEGORY_NAMES.items():
                if cp in cat_set:
                    categories_hit.add(cat_name)
                    break
            try:
                char_name = unicodedata.name(ch, f"U+{cp:04X}")
            except ValueError:
                char_name = f"U+{cp:04X}"
            findings.append((f"U+{cp:04X}", i, char_name))

    if not findings:
        return None

    return ", ".join(sorted(categories_hit)), findings


def strip_invisible_unicode(
    text: str,
    *,
    preserve_emoji: bool = True,
) -> str:
    """移除文本中的危险不可见 Unicode 字符。

    Args:
        preserve_emoji: 为 True 时保留 VS16 和 Emoji Tag 序列码点（默认），
            适用于用户消息、Agent 回复等内容场景。
            为 False 时清除所有危险码点，适用于命令校验、URL 检查等安全场景。
    """
    if not text:
        return text
    pattern = _CONTENT_SAFE_RE if preserve_emoji else _DANGEROUS_CHARS_RE
    return pattern.sub("", text)


def normalize_for_matching(text: str) -> str:
    """规范化文本用于安全比较。

    1. NFC 规范化（合成同一字符的不同编码形式）
    2. 清除危险的不可见字符

    适用于规则匹配、权限检查等需要精确比较的场景。
    """
    if not text:
        return text
    normalized = unicodedata.normalize("NFC", text)
    return strip_invisible_unicode(normalized, preserve_emoji=False)


def sanitize_url_unicode(url: str) -> str:
    """清除 URL 中的不可见 Unicode 字符并 NFC 规范化。

    应在 SSRF / 域名校验之前调用，防止不可见字符绕过域名黑名单。
    """
    if not url:
        return url
    return normalize_for_matching(url)


_RE_SURROGATES = re.compile(r'[\ud800-\udfff]')


def sanitize_text_for_storage(value: str) -> str:
    """清理文本以安全写入数据库。

    合并三重防御：
    1. 移除 null 字节（防止 PostgreSQL 报错）
    2. 替换孤立代理对为 U+FFFD（防止 psycopg2 崩溃，保留正常 emoji）
    3. 移除危险不可见 Unicode 字符（防止 prompt injection）

    替代各模块独立实现的 _sanitize_text 函数。
    """
    if not value:
        return value
    value = value.replace('\x00', '')
    value = _RE_SURROGATES.sub('\ufffd', value)
    return strip_invisible_unicode(value)


# ── 同形字检测 ────────────────────────────────────────────────────

# 常见视觉混淆脚本对：Latin 字母与 Cyrillic / Greek 等字符外观相同但码点不同
_CONFUSABLE_SCRIPTS: frozenset[str] = frozenset({
    "LATIN", "CYRILLIC", "GREEK",
})


def _script_of(ch: str) -> str | None:
    """通过 Unicode category 和码点范围推断字符所属脚本。

    使用 unicodedata.name() 而非第三方库，保持零依赖。
    仅覆盖同形字检测所需的主要拉丁/西里尔/希腊脚本。
    """
    try:
        name = unicodedata.name(ch, "")
    except ValueError:
        return None
    if not name:
        return None
    for script in ("LATIN", "CYRILLIC", "GREEK", "CJK", "HANGUL",
                   "HIRAGANA", "KATAKANA", "ARABIC", "HEBREW",
                   "DEVANAGARI", "THAI"):
        if script in name:
            return script
    return None


def detect_homoglyphs(text: str) -> list[dict]:
    """检测文本中的同形字混用（混合脚本攻击）。

    当同一个字符串中混合使用了视觉上容易混淆的 Unicode 脚本（如 Latin + Cyrillic）
    时返回检测信息。这是域名欺骗、文件名混淆的常见手法。

    仅用于告警，不强制拦截。

    Returns:
        检测到的混合脚本信息列表，每项包含:
        - scripts: 检测到的脚本集合
        - sample_chars: 各脚本的示例字符 {script: [(char, position)]}
        - risk: 风险等级 "high" | "medium"
    """
    if not text:
        return []

    script_chars: dict[str, list[tuple[str, int]]] = {}
    for i, ch in enumerate(text):
        if not ch.isalpha():
            continue
        if ch.isascii():
            script = "LATIN"
        else:
            script = _script_of(ch)
        if script:
            script_chars.setdefault(script, []).append((ch, i))

    # 仅当混合了容易混淆的脚本对时才告警
    detected_scripts = set(script_chars.keys())
    confusable_hit = detected_scripts & _CONFUSABLE_SCRIPTS

    if len(confusable_hit) < 2:
        return []

    sample_chars = {
        s: chars[:5] for s, chars in script_chars.items()
        if s in confusable_hit
    }

    risk = "high" if {"LATIN", "CYRILLIC"} <= confusable_hit else "medium"

    return [{
        "scripts": confusable_hit,
        "sample_chars": sample_chars,
        "risk": risk,
    }]


# ── BiDi 控制字符检测 ─────────────────────────────────────────────


def detect_bidi_controls(text: str) -> list[tuple[str, int]]:
    """检测文本中的 BiDi 方向控制字符。

    Returns:
        [(码点名称, 位置)] 列表。无 BiDi 控制字符时返回空列表。
    """
    if not text:
        return []
    findings = []
    for i, ch in enumerate(text):
        if ord(ch) in _BIDI_CONTROL:
            cp = ord(ch)
            try:
                name = unicodedata.name(ch, f"U+{cp:04X}")
            except ValueError:
                name = f"U+{cp:04X}"
            findings.append((name, i))
    return findings


def sanitize_and_log(
    text: str,
    *,
    context: str = "",
    max_detail_chars: int = 200,
    preserve_emoji: bool = True,
) -> str:
    """检测不可见字符 → 记录 warning 日志 → 返回清洗后的文本。

    适用于 Agent 指令拼接、tool_call 参数等入口点。
    不阻断执行，仅记录供安全审计。

    Args:
        text: 待检查的文本
        context: 调用方描述，用于日志定位
        max_detail_chars: 日志中原文摘录最大长度
        preserve_emoji: 为 True 时保留 VS16 和 Emoji Tag 序列码点（默认）
    """
    if not text:
        return text

    result = detect_invisible_unicode(text, preserve_emoji=preserve_emoji)
    if result is None:
        return text

    categories, findings = result
    log_ctx = f" [{context}]" if context else ""
    preview = text[:max_detail_chars] + ("..." if len(text) > max_detail_chars else "")
    logger.warning(
        "[UnicodeSecurityWarning]%s invisible_chars detected: "
        "categories=%s count=%d findings=%s text_preview=%r",
        log_ctx,
        categories,
        len(findings),
        findings[:10],
        preview,
    )

    return strip_invisible_unicode(text, preserve_emoji=preserve_emoji)
