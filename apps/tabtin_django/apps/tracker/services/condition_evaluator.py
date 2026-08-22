"""条件求值器 — 对事件 payload 进行条件匹配。

trigger_config.conditions 格式：
[
    {"field": "status", "op": "eq", "value": "completed"},
    {"field": "amount", "op": "gt", "value": 1000},
    {"field": "title", "op": "contains", "value": "Q1"},
]

多条 condition 之间为 AND 关系（全部满足才触发）。
field 支持嵌套路径，如 "metadata.category"。

支持的 op:
  eq        — 相等（字符串不区分大小写）
  neq       — 不等
  gt        — 大于（数值）
  gte       — 大于等于
  lt        — 小于
  lte       — 小于等于
  contains  — 包含子串（字符串）
  not_contains — 不包含
  in        — 值在列表中
  not_in    — 值不在列表中
  exists    — 字段存在（value 忽略）
  not_exists — 字段不存在
  regex     — 正则匹配
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_SENTINEL = object()


def _resolve_field(data: dict, field_path: str) -> Any:
    """按点号分隔的路径从 dict 中取值。找不到返回 _SENTINEL。"""
    current = data
    for part in field_path.split("."):
        if isinstance(current, dict):
            current = current.get(part, _SENTINEL)
            if current is _SENTINEL:
                return _SENTINEL
        else:
            return _SENTINEL
    return current


def _to_number(val: Any) -> float | None:
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        try:
            return float(val)
        except (ValueError, TypeError):
            return None
    return None


def _eval_single(condition: dict, payload: dict) -> bool:
    """求值单个 condition。无法求值时返回 False（安全策略：不满足则不触发）。"""
    field = condition.get("field", "")
    op = condition.get("op", "eq")
    expected = condition.get("value")

    actual = _resolve_field(payload, field)

    if op == "exists":
        return actual is not _SENTINEL
    if op == "not_exists":
        return actual is _SENTINEL

    if actual is _SENTINEL:
        return False

    if op == "eq":
        if isinstance(actual, str) and isinstance(expected, str):
            return actual.lower() == expected.lower()
        if actual == expected:
            return True
        a_num, b_num = _to_number(actual), _to_number(expected)
        if a_num is not None and b_num is not None:
            return a_num == b_num
        return str(actual) == str(expected)

    if op == "neq":
        if isinstance(actual, str) and isinstance(expected, str):
            return actual.lower() != expected.lower()
        if actual == expected:
            return False
        a_num, b_num = _to_number(actual), _to_number(expected)
        if a_num is not None and b_num is not None:
            return a_num != b_num
        return str(actual) != str(expected)

    if op in ("gt", "gte", "lt", "lte"):
        a = _to_number(actual)
        b = _to_number(expected)
        if a is None or b is None:
            return False
        if op == "gt":
            return a > b
        if op == "gte":
            return a >= b
        if op == "lt":
            return a < b
        return a <= b  # lte

    if op == "contains":
        return isinstance(actual, str) and isinstance(expected, str) and expected.lower() in actual.lower()

    if op == "not_contains":
        return isinstance(actual, str) and isinstance(expected, str) and expected.lower() not in actual.lower()

    if op == "in":
        if isinstance(expected, list):
            return actual in expected
        return False

    if op == "not_in":
        if isinstance(expected, list):
            return actual not in expected
        return True

    if op == "regex":
        _MAX_REGEX_LEN = 200
        _MAX_REGEX_INPUT_LEN = 10_000
        _REGEX_TIMEOUT_SECONDS = 2
        if isinstance(actual, str) and isinstance(expected, str):
            if len(expected) > _MAX_REGEX_LEN:
                logger.warning("[condition_evaluator] regex too long (%d chars), rejected", len(expected))
                return False
            try:
                compiled = re.compile(expected, re.DOTALL)
            except re.error:
                logger.warning("[condition_evaluator] invalid regex: %s", expected)
                return False
            truncated = actual[:_MAX_REGEX_INPUT_LEN]
            try:
                import concurrent.futures
                pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
                future = pool.submit(compiled.search, truncated)
                try:
                    result = future.result(timeout=_REGEX_TIMEOUT_SECONDS)
                    return bool(result)
                except concurrent.futures.TimeoutError:
                    logger.warning("[condition_evaluator] regex execution timeout: %s", expected)
                    return False
                finally:
                    pool.shutdown(wait=False, cancel_futures=True)
            except (re.error, RecursionError):
                logger.warning("[condition_evaluator] regex execution error: %s", expected)
                return False
        return False

    logger.warning("[condition_evaluator] unknown op: %s", op)
    return False


def evaluate_conditions(conditions: list[dict], payload: dict) -> bool:
    """对条件列表求值。空列表 → True（无条件即通过）。AND 语义。"""
    if not conditions:
        return True
    return all(_eval_single(c, payload) for c in conditions)
