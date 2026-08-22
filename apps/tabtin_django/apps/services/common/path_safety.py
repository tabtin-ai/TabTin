"""
path_safety.py — 路径权限治理：Python 端路径安全判定（isDangerouslyBroadPath
+ matches_sensitive_path）。

**SSoT 同源（W7/B2 codegen 接入）**：

1. `_DANGEROUS_TOPLEVEL_DIRS` / `_DANGEROUS_WINDOWS_ROOTS` ←→ TS 端
   `packages/security-policy/src/path-normalize.ts:DANGEROUS_TOPLEVEL_DIRS` /
   `DANGEROUS_WINDOWS_ROOTS` 字面量保持完全一致（手抄 —— 这一对常量短小，
   未来可独立 codegen 但当前 W7 范围不动）。

2. `SENSITIVE_PATH_RULES` / `SENSITIVE_BASENAME_PATTERNS` ←→ TS 端
   `packages/terminal-core/src/sensitive-paths.generated.ts:SENSITIVE_PATH_RULES`
   **同源 codegen**：SSoT 是 `packages/security-policy/src/hardline-v3-rules.json`
   的 `path_scan_rules` + `path_basename_patterns` 两个字段，由
   `scripts/codegen-hardline.py` 同时输出 Python `generated_hardline.py` +
   TS `terminal-core/sensitive-paths.generated.ts`。

   **codegen 流程（修改一端 → 两端跟）**：
     1. 改 `packages/security-policy/src/hardline-v3-rules.json` 的
        `path_scan_rules` 或 `path_basename_patterns`
     2. 跑 `python scripts/codegen-hardline.py`
     3. 验：`git diff` 应当看到 generated_hardline.py + sensitive-paths.generated.ts
        都更新，调整后再次跑 codegen 应当 0 行 diff
     4. CI mode：`python scripts/codegen-hardline.py --check` 验证一致性

**为什么需要这个**：sandbox_policy.py 的 `_path_in_workspace_allowed_paths`
做 allow short-circuit 时，如果上游 sender（mobile / 受损客户端）在
`workspace_snapshot.allowedPaths` 里塞 `/`、`/Users`、`/etc` 等顶级目录，
short-circuit 会让 Django 对**任何**路径都放行——绕过 deny lists（含
`~/.aws/credentials`、`~/.ssh/*` 等敏感目录）。本模块提供 fail-closed
过滤：危险 root 直接 skip，不参与 short-circuit 判定。

与 TS 端 `isInWorkspace` 走同一防御策略：循环里 `if isDangerouslyBroadPath(dir): continue`。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from apps.services.common.generated_hardline import (
    SENSITIVE_BASENAME_PATTERNS,
    SENSITIVE_PATH_RULES as _GENERATED_SENSITIVE_PATH_RULES,
)


# ─────────────────────────────────────────────────────────────────
# 常量列表 —— 与 TS 端 `path-normalize.ts:DANGEROUS_TOPLEVEL_DIRS` 同源
# ─────────────────────────────────────────────────────────────────

# POSIX 顶级目录字面量。整段当 allowedPath 都是把整树纳入工作区——子路径仍合法。
# /Users / /home 在跨用户家根上保留拦截（多用户机器整段暴露）；单用户家
# 目录 /Users/<name> 不在此列，由调用方判定（M3.1.1 方向 C：放宽家目录）。
_DANGEROUS_TOPLEVEL_DIRS: frozenset[str] = frozenset({
    "/",
    "/Users",
    "/home",
    "/tmp",
    "/var",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/opt",
    "/root",
    "/private",  # macOS firmlink 根
    "/Volumes",  # macOS 外置盘 / 网络挂载根
    "/Applications",  # macOS 应用根
    "/srv",
    "/mnt",
    "/media",
    "/proc",  # Linux 虚拟文件系统
    "/sys",
    "/dev",
    "/System",  # macOS 系统根
    "/Library",  # macOS 库根
    "/boot",  # Linux 引导
    "/run",  # Linux 运行时
    "/snap",  # Ubuntu 包根
})

# Windows 盘符根：C: / C:/ / C:\ / /C:/ 等
_DANGEROUS_WINDOWS_ROOTS: tuple[re.Pattern, ...] = (
    re.compile(r"^[A-Z]:[/\\]?$", re.IGNORECASE),
    re.compile(r"^/[A-Z]:[/\\]?$", re.IGNORECASE),
)

_WINDOWS_ABS_RE = re.compile(r"^[A-Z]:[/\\]", re.IGNORECASE)
_WINDOWS_DRIVE_LETTER_RE = re.compile(r"^[A-Z]:$", re.IGNORECASE)


@dataclass(frozen=True)
class SensitivePathRule:
    """Public 类型 —— `pattern` 来自 codegen 输出的 `re.Pattern`。

    保留这个 dataclass 主要是为对外 API 一致性（旧 caller 用
    `SENSITIVE_PATH_RULES[i].label` / `.pattern` 解构）。codegen 输出的是
    `Tuple[Pattern, str]`（label 第二位），下面的 `SENSITIVE_PATH_RULES`
    将其包装成本 dataclass 形态。
    """

    label: str
    pattern: re.Pattern[str]


# W7/B2 codegen 接入：从 generated_hardline 派生（SSoT =
# packages/security-policy/src/hardline-v3-rules.json:path_scan_rules）。
# generated 端形态是 `List[Tuple[Pattern, str]]`，这里包装成 dataclass tuple
# 以保持外部 API 形状（避免破坏既有 caller `rule.label` / `rule.pattern`
# 解构语义）。
SENSITIVE_PATH_RULES: tuple[SensitivePathRule, ...] = tuple(
    SensitivePathRule(label=label, pattern=pattern)
    for pattern, label in _GENERATED_SENSITIVE_PATH_RULES
)


def is_dangerously_broad_root(allowed_path: object) -> bool:
    """检查 allowedPath 是否"过宽到危险" —— 整段当 workspace 等于把整树暴露。

    与 TS 端 `isDangerouslyBroadPath` 行为完全对齐：
      - 非字符串 / 空白 → True（异常）
      - `/` 字面量 → True（整盘）
      - POSIX 顶级目录字面量（含尾部斜杠也认） → True
      - Windows 盘符根 → True
      - 非绝对路径（相对 / `~` / 空段开头） → True
      - 其他（合法 workspace 路径如 `/Users/<name>` / `/Users/me/proj`） → False

    使用场景：sandbox_policy `_path_in_workspace_allowed_paths` 循环里
    `if is_dangerously_broad_root(dir): continue` 过滤上游可能注入的危险 root。
    """
    if not isinstance(allowed_path, str):
        return True

    trimmed = allowed_path.strip()
    if not trimmed:
        return True

    # NFC 归一保证 Unicode 等价
    try:
        p = unicodedata.normalize("NFC", trimmed)
    except Exception:
        p = trimmed

    # 反斜杠归一
    posix = p.replace("\\", "/")

    # 1. 必须是绝对路径（POSIX or Windows 盘符）
    is_posix_abs = posix.startswith("/")
    is_windows_abs = bool(_WINDOWS_ABS_RE.match(p)) or bool(
        _WINDOWS_DRIVE_LETTER_RE.match(p)
    )
    if not is_posix_abs and not is_windows_abs:
        return True

    # 2. Windows 盘符根
    for pat in _DANGEROUS_WINDOWS_ROOTS:
        if pat.match(p):
            return True

    # 3. POSIX 顶级目录字面量（含尾部 `/` 也认）
    stripped = posix
    if len(stripped) > 1 and stripped.endswith("/"):
        # 去掉所有末尾斜杠（保留单 `/` 根的 stripped == "/" 不变）
        stripped = stripped.rstrip("/")
        if not stripped:
            stripped = "/"

    if stripped in _DANGEROUS_TOPLEVEL_DIRS:
        return True

    # M3.1.1 起：单用户家目录 `/Users/<name>` / `/home/<name>` 视为合法
    return False


def matches_sensitive_path(path: object) -> bool:
    """检查路径是否命中 sensitive 红线。

    覆盖两类规则：
      - 全路径规则：与 TS `SENSITIVE_PATH_RULES` 同源（如 `~/.ssh`、`/etc/shadow`）。
      - basename 规则：文件名级凭证（如 `.env`、`*.pem`、`id_rsa*`）。
    """
    if not isinstance(path, str):
        return False
    raw = path.strip()
    if not raw:
        return False

    try:
        normalized = unicodedata.normalize("NFC", raw)
    except Exception:
        normalized = raw
    normalized = normalized.replace("\\", "/")
    while "//" in normalized:
        normalized = normalized.replace("//", "/")

    basename = normalized.rsplit("/", 1)[-1]
    if any(pattern.fullmatch(basename) for pattern in SENSITIVE_BASENAME_PATTERNS):
        return True
    return any(rule.pattern.search(normalized) for rule in SENSITIVE_PATH_RULES)


__all__ = [
    "is_dangerously_broad_root",
    "matches_sensitive_path",
    "SENSITIVE_PATH_RULES",
    "SENSITIVE_BASENAME_PATTERNS",
    "SensitivePathRule",
]
