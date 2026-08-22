"""选项值提取工具 — select/multi_select 字段的 choices 解析公共模块"""

from typing import Any, Dict, Iterable, List, Tuple

# 默认调色板：浅色底友好的强调色（前端会再混白做胶囊底）
_DEFAULT_PALETTE = [
    '#3B82F6', '#22C55E', '#F97316', '#8B5CF6', '#EF4444',
    '#14B8A6', '#EAB308', '#6366F1', '#F43F5E', '#0EA5E9',
]

# 与 field_target_validators.MAX_OPTIONS_COUNT 对齐；此处避免循环 import
DEFAULT_MAX_OPTIONS_COUNT = 200


def iter_select_cell_values(value: Any, field_type: str = 'select') -> List[str]:
    """从单元格值抽出可用于 choices 的字符串（按出现顺序，去空）。"""
    if value is None or value == '':
        return []

    if field_type == 'multi_select' or isinstance(value, list):
        items = value if isinstance(value, list) else [value]
        result: List[str] = []
        seen = set()
        for item in items:
            if item is None or item == '':
                continue
            text = str(item)
            if text in seen:
                continue
            seen.add(text)
            result.append(text)
        return result

    return [str(value)]


def merge_select_choice_values(
    existing_choices,
    new_values: Iterable[Any],
    *,
    max_options: int = DEFAULT_MAX_OPTIONS_COUNT,
) -> list:
    """把新选项值并入已有 choices，保留已有顺序/颜色，新值追加在末尾。

    返回归一化后的 ``[{value, label, color}, ...]``。
    """
    existing = list(existing_choices or [])
    existing_values = extract_choice_values(existing)
    merged_raw = list(existing)
    for raw in new_values or []:
        for value in iter_select_cell_values(raw):
            if value in existing_values:
                continue
            if len(existing_values) >= max_options:
                break
            merged_raw.append(value)
            existing_values.add(value)
        if len(existing_values) >= max_options:
            break
    return normalize_select_choices(merged_raw)


def normalize_select_choices(choices) -> list:
    """将 choices 归一化为统一的 [{value, label, color}] 对象格式。

    输入可以是:
    - 纯字符串列表: ["A", "B"]
    - 对象列表: [{"value": "A", "label": "A", "color": "#xxx"}]
    - 混合列表
    """
    if not choices or not isinstance(choices, list):
        return []
    result = []
    seen = set()
    for idx, c in enumerate(choices):
        if isinstance(c, dict):
            value = None
            for key in ('value', 'id', 'name', 'label'):
                v = c.get(key)
                if v is not None:
                    value = str(v)
                    break
            if value is None:
                continue
            if value in seen:
                continue
            seen.add(value)
            result.append({
                'value': value,
                'label': str(c.get('label', '') or c.get('name', '') or value),
                'color': str(c.get('color', '') or _DEFAULT_PALETTE[idx % len(_DEFAULT_PALETTE)]),
            })
        else:
            value = str(c)
            if value in seen:
                continue
            seen.add(value)
            result.append({
                'value': value,
                'label': value,
                'color': _DEFAULT_PALETTE[idx % len(_DEFAULT_PALETTE)],
            })
    return result


def extract_choice_values(choices) -> set:
    """从 choices 列表中提取有效值集合，兼容字符串列表和 [{value, label, color}] 对象列表。
    统一转为 str，因为前端 select 值约定为字符串。

    优先级与前端一致：value > id > name > label；
    用 is not None 判断避免 0/"" 被 falsy 跳过。
    """
    if not choices:
        return set()
    result = set()
    for c in choices:
        if isinstance(c, dict):
            for key in ('value', 'id', 'name', 'label'):
                v = c.get(key)
                if v is not None:
                    result.add(str(v))
                    break
        else:
            result.add(str(c))
    return result


def build_select_choice_value_renames(old_choices, new_choices) -> Dict[str, str]:
    """按同位编辑推断选项 value 重命名映射（old_value → new_value）。

    字段设置 UI 以「选项列表」编辑：用户改某一行的文案时，前端通常提交整份
    string[] choices。后端 normalize 后 value 随之变化，但记录仍存旧 value，
    表格会显示不同步。这里用位置对齐识别「旧值消失 + 新值新增」为重命名。

    不会把重排 / 纯删除 / 纯新增误判为重命名：
    - 旧值仍出现在新列表 → 不是 rename
    - 新值本就存在于旧列表 → 不是 rename
    """
    old_norm = normalize_select_choices(old_choices)
    new_norm = normalize_select_choices(new_choices)
    if not old_norm or not new_norm:
        return {}

    old_values = [item['value'] for item in old_norm]
    new_values = [item['value'] for item in new_norm]
    old_set = set(old_values)
    new_set = set(new_values)

    renames: Dict[str, str] = {}
    for index in range(min(len(old_values), len(new_values))):
        old_value = old_values[index]
        new_value = new_values[index]
        if old_value == new_value:
            continue
        if old_value in new_set or new_value in old_set:
            continue
        # 同一旧值只接受第一次映射，避免歧义覆盖
        if old_value in renames:
            continue
        renames[old_value] = new_value
    return renames


def apply_select_choice_renames(
    value: Any,
    renames: Dict[str, str],
    field_type: str = 'select',
) -> Tuple[Any, bool]:
    """把单元格里的旧选项 value 替换为新 value；无命中则原样返回。"""
    if not renames or value is None or value == '':
        return value, False

    if field_type == 'multi_select' or isinstance(value, list):
        items = value if isinstance(value, list) else [value]
        changed = False
        next_items = []
        for item in items:
            if item is None or item == '':
                next_items.append(item)
                continue
            text = str(item)
            mapped = renames.get(text, text)
            if mapped != text:
                changed = True
            next_items.append(mapped)
        return next_items, changed

    text = str(value)
    mapped = renames.get(text, text)
    return mapped, mapped != text
