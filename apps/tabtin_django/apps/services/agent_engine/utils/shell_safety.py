"""
Shell 命令安全校验 — 共享于 ai_classifier 快速路径和 tool_batch_partitioner 只读判断。

使用 shlex.split 做 token 级分析，而非前缀字符串匹配，
防止 `git status && rm -rf /` 等管道/链式注入绕过。

安全哲学：fail-close — 任何无法明确判定为安全的命令均返回 False。
"""

from __future__ import annotations

import logging
import re
import shlex

logger = logging.getLogger(__name__)

_SHELL_METACHAR_RE = re.compile(r"[;&|`$(){}]|&&|\|\|")

_ALLOWED_EXECUTABLES = frozenset({
    "ls", "cat", "head", "tail", "grep", "find", "wc",
    "which", "whereis", "file", "stat", "du", "df",
    "echo", "pwd", "date", "whoami", "uname",
})

_GIT_SAFE_SUBCOMMANDS = frozenset({
    "status", "log", "diff", "show", "branch", "remote", "tag",
})

_SENSITIVE_PATH_RE = re.compile(
    r"/etc/(passwd|shadow|sudoers)"
    r"|/dev/"
    r"|[~.]?/\.ssh/"
    r"|\.env(\.|$)"
    r"|\.pem$"
    r"|\.key$"
    r"|id_rsa"
    r"|id_ed25519"
)


def is_safe_shell_command(command: str) -> bool:
    """基于 token 分析判断命令是否为只读安全命令。

    Returns:
        True  — 可以被快速路径放行或归为并行安全
        False — 需要走完整审批链路或视为串行不安全
    """
    cmd = command.strip()
    if not cmd:
        return False

    if "\n" in cmd or "\r" in cmd:
        return False

    if _SHELL_METACHAR_RE.search(cmd):
        return False

    try:
        tokens = shlex.split(cmd)
    except ValueError:
        return False

    if not tokens:
        return False

    exe = tokens[0].lower()

    if exe == "git":
        return len(tokens) >= 2 and tokens[1] in _GIT_SAFE_SUBCOMMANDS

    if exe not in _ALLOWED_EXECUTABLES:
        return False

    return not any(_SENSITIVE_PATH_RE.search(t) for t in tokens[1:])
