"""``cli_rules.yaml`` 规则集加载与匹配（PRD-v3 §5.1 第 3 项）。

设计要点：
- 规则按文件中**声明顺序**匹配，命中即停（first-match-wins）。
- ``pattern`` 形如 ``"<domain>.<verb>"``，支持单段通配符 ``*``（如 ``"*.delete"`` 匹配
  任意 domain 的 delete verb）。
- ``default`` 是解析成功但**所有规则都未命中**时的兜底（≠ 解析失败时的兜底；
  解析失败由 parser 直接打 ``DEFAULT_RISK_LEVEL`` = ``review``）。

A1 范围：
- 仅实现规则匹配，不实现"YAML 重载 / 热更新"（A3 升级 PermissionRuleEngine 时再考虑）。
- 不实现"基于 ``state`` 上下文（如生产 vs 沙盒）的动态切换"（PRD §5.1 第 3 项 ``*.create_in_prod``
  目前依赖 verb 命名约定来表达，不做额外环境检测）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import yaml

from apps.services.agent_engine.cli.spec import (
    DEFAULT_RISK_LEVEL,
    RISK_LEVELS,
)

logger = logging.getLogger(__name__)


_DEFAULT_RULES_PATH = Path(__file__).parent / "cli_rules.yaml"


@dataclass(frozen=True)
class CliRule:
    """单条规则的内存表示。"""

    pattern: str
    risk_level: str
    reason: str = ""

    def matches(self, grammar_key: str) -> bool:
        """通配符匹配，``*`` 匹配单段（不跨 ``.``）。

        例：``"table.*"`` 匹配 ``"table.delete"``，但不匹配 ``"table.row.delete"``。
        """
        pat_parts = self.pattern.split(".")
        key_parts = grammar_key.split(".")
        if len(pat_parts) != len(key_parts):
            return False
        for p, k in zip(pat_parts, key_parts):
            if p == "*":
                continue
            if p != k:
                return False
        return True


@dataclass(frozen=True)
class CliRuleSet:
    """规则集 + 兜底策略。"""

    rules: List[CliRule] = field(default_factory=list)
    default_risk_level: str = DEFAULT_RISK_LEVEL
    version: int = 1

    def match(self, grammar_key: str) -> CliRule:
        """匹配规则；未命中时返回兜底 ``CliRule``（pattern=""）。

        返回 ``CliRule`` 而非 ``str``，方便审计层记录"为什么是这个 risk_level"
        （A2 ``CliAuditEvent`` 写入时把 ``reason`` 也带上）。
        """
        for rule in self.rules:
            if rule.matches(grammar_key):
                return rule

        return CliRule(
            pattern="",
            risk_level=self.default_risk_level,
            reason=f"no rule matched, fallback to default ({self.default_risk_level})",
        )


def _validate_risk_level(value: object, source: str) -> str:
    if not isinstance(value, str) or value not in RISK_LEVELS:
        raise ValueError(
            f"{source} 'risk_level' must be one of {RISK_LEVELS}, got {value!r}"
        )
    return value


def load_rules_from_file(path: Optional[Path] = None) -> CliRuleSet:
    """从 YAML 文件加载规则集。

    YAML schema 见 ``cli_rules.yaml`` 头部注释。
    校验失败时抛 ``ValueError``，由调用方决定是 fail-close 还是 fallback。
    """
    target = path or _DEFAULT_RULES_PATH
    if not target.exists():
        raise FileNotFoundError(f"cli rules file not found: {target}")

    with target.open("r", encoding="utf-8") as fp:
        data = yaml.safe_load(fp) or {}

    if not isinstance(data, dict):
        raise ValueError(f"cli rules root must be a mapping, got {type(data).__name__}")

    version = data.get("version", 1)
    if not isinstance(version, int):
        raise ValueError(f"cli rules 'version' must be int, got {type(version).__name__}")

    raw_rules = data.get("rules") or []
    if not isinstance(raw_rules, list):
        raise ValueError(
            f"cli rules 'rules' must be a list, got {type(raw_rules).__name__}"
        )

    rules: List[CliRule] = []
    for idx, item in enumerate(raw_rules):
        if not isinstance(item, dict):
            raise ValueError(f"rules[{idx}] must be a mapping, got {type(item).__name__}")
        pattern = item.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise ValueError(f"rules[{idx}].pattern must be a non-empty string")
        risk_level = _validate_risk_level(item.get("risk_level"), f"rules[{idx}]")
        reason = item.get("reason", "") or ""
        if not isinstance(reason, str):
            raise ValueError(f"rules[{idx}].reason must be a string if provided")
        rules.append(CliRule(pattern=pattern, risk_level=risk_level, reason=reason))

    default_rl = _validate_risk_level(
        data.get("default", DEFAULT_RISK_LEVEL), "cli rules"
    )

    return CliRuleSet(
        rules=rules,
        default_risk_level=default_rl,
        version=version,
    )


def load_default_rules() -> CliRuleSet:
    """加载本模块自带的 ``cli_rules.yaml``。

    解析失败时降级到一个最小的兜底规则集（仅含 ``review`` 兜底），
    并记 ERROR 日志 — 这样即便 YAML 损坏，CliInvocationParser 也能继续工作（fail-safe），
    不会让整个 agent_engine 启动失败。
    """
    try:
        return load_rules_from_file(_DEFAULT_RULES_PATH)
    except Exception as exc:
        logger.error(
            "[cli.rules] 默认规则集加载失败 (%s: %s)，回退到空规则集 + review 兜底",
            type(exc).__name__,
            exc,
            exc_info=True,
        )
        return CliRuleSet(rules=[], default_risk_level=DEFAULT_RISK_LEVEL, version=1)


__all__ = [
    "CliRule",
    "CliRuleSet",
    "load_rules_from_file",
    "load_default_rules",
]
