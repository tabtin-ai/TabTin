"""中文身份搜索键生成。展示仍以 nickname 为唯一真源。"""

from pypinyin import Style, lazy_pinyin


def build_pinyin_search_keys(value: str) -> tuple[str, str]:
    normalized = ''.join(value.strip().lower().split())
    if not normalized:
        return '', ''
    full = ''.join(lazy_pinyin(normalized, style=Style.NORMAL, errors='keep'))
    initials = ''.join(lazy_pinyin(normalized, style=Style.FIRST_LETTER, errors='keep'))
    return full, initials
