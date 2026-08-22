"""
AuthorizationPolicy — 安全硬底线 + 工具分类（Hilt 重写）

Hilt W4：旧授权预设（cautious/collaborative/full_auto/server_auto）、
resolve_authorization_rules、should_require_review 全部删除。
授权判决统一由 TS 侧 judge() 完成。

保留：
  - check_safety_hardline（平台硬底线，被 approval_rules_service 等消费）
  - _TOOL_CATEGORY_OVERRIDES（被 rule_engine.py 消费的显式工具类别覆盖表）

#5394 Phase 1：resolve_tool_category 已删除——全仓零生产调用
（docstring 曾写「被 tools/base.py 消费」已过时）。
"""

import logging
import re
from typing import Any, Dict, List, Literal, Optional, Tuple

logger = logging.getLogger(__name__)

OperationCategory = Literal['read', 'write', 'install', 'delete_system', 'script']

_TOOL_CATEGORY_OVERRIDES: Dict[str, OperationCategory] = {
    'execute_in_terminal': 'script',
    'write_to_terminal': 'script',
    'ssh_execute': 'script',
    'delete_file': 'delete_system',
}


# =====================================================================
# S17(a): 安全硬底线 — 无论任何预设都不可绕过
# =====================================================================

SafetyVerdict = Literal["confirm", "block"]

_FORCE_CONFIRM_PATTERNS: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"\.env$"), "写入 .env 文件"),
    (re.compile(r"\.env\."), "写入 .env 变体文件"),
    (re.compile(r"\.ssh/"), "操作 .ssh 目录"),
    (re.compile(r"\.pem$"), "操作 PEM 密钥文件"),
    (re.compile(r"\.key$"), "操作密钥文件"),
    (re.compile(r"credentials\."), "操作凭证文件"),
    (re.compile(r"\.secret$"), "操作 secret 文件"),
    (re.compile(r"\.token$"), "操作 token 文件"),
    (re.compile(r"id_rsa"), "操作 SSH 私钥"),
    (re.compile(r"id_ed25519"), "操作 SSH 私钥"),
]

_FORCE_BLOCK_PATTERNS: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"rm\s+(-\w+\s+)*-r\w*\s+/(\s|$)"), "rm -rf /"),
    (re.compile(r":\(\)\s*\{"), "fork bomb"),
    (re.compile(r"mkfs\."), "格式化磁盘"),
    (re.compile(r"dd\s+if=.*of=/dev/"), "dd 写入设备"),
    (re.compile(r">\s*/dev/sd[a-z]"), "重定向到磁盘设备"),
    (re.compile(r"chmod\s+(-\w+\s+)*0?777\s+/(\s|$)"), "递归 chmod 777 /"),
    (re.compile(r"curl\s.*\|\s*(ba)?sh\b"), "curl pipe to shell"),
    (re.compile(r"wget\s.*-O\s*-\s*\|\s*(ba)?sh\b"), "wget pipe to shell"),
]

_SENSITIVE_ARG_FIELDS = ("command", "cmd", "path", "file_path", "content", "destination", "target")


def _extract_matchable_strings(tool_name: str, tool_args: Optional[Dict]) -> List[str]:
    """从 tool_args 中提取可用于正则匹配的字符串值。"""
    candidates: List[str] = []
    if not tool_args:
        return candidates
    for field in _SENSITIVE_ARG_FIELDS:
        val = tool_args.get(field)
        if isinstance(val, str) and val:
            candidates.append(val)
    if not candidates:
        for val in tool_args.values():
            if isinstance(val, str) and val:
                candidates.append(val)
    return candidates


def check_safety_hardline(
    tool_name: str,
    tool_args: Optional[Dict],
) -> Optional[Tuple[SafetyVerdict, str]]:
    """S17(a) 安全硬底线检查 — 在所有权限评估之前调用。

    无论 server_auto 还是任何预设都无法绕过此检查。

    Returns:
        None — 通过（不触发硬底线）
        ("confirm", reason) — 强制要求用户确认
        ("block", reason) — 无条件阻断
    """
    candidates = _extract_matchable_strings(tool_name, tool_args)
    if not candidates:
        return None

    for text in candidates:
        for pattern, reason in _FORCE_BLOCK_PATTERNS:
            if pattern.search(text):
                logger.warning(
                    "[SafetyHardline] BLOCK: tool=%s reason=%s text=%.100s",
                    tool_name, reason, text,
                )
                return ("block", f"安全硬底线阻断: {reason}")

        for pattern, reason in _FORCE_CONFIRM_PATTERNS:
            if pattern.search(text):
                logger.info(
                    "[SafetyHardline] CONFIRM: tool=%s reason=%s text=%.100s",
                    tool_name, reason, text,
                )
                return ("confirm", f"安全硬底线确认: {reason}")

    return None


__all__ = [
    "OperationCategory",
    "SafetyVerdict",
    "check_safety_hardline",
]
