"""
SandboxPolicyResolver — 沙箱策略解析器

根据 Space.agent_config.sandbox 配置 + 工具名 + 命令内容，
输出执行决策（route / sandbox_level / approval_required）。

集成方式:
  - state_preprocessors 将 sandbox config 加载到 state["_sandbox_config"]
  - FrontendActionService 在 publish_action 时附加 sandbox policy 到 action payload
  - Daemon/Electron 收到 action 后根据 policy 控制 CommandExecutor 行为
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 预设 (presets)
# ---------------------------------------------------------------------------

SANDBOX_PRESETS: Dict[str, Dict[str, Any]] = {
    "cautious": {
        "command_execution": "sandboxed",
        "terminal_mode": "tabtin_only",
        "sandbox_level": "complete",
        "file_access": "strict",
        "custom_write_paths": [],
        "deny_read_paths": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config"],
        "deny_write_paths": [".env", ".env.*", "*.pem", "*.key", "*.pfx", "*.p12", "*.p8", ".git/*"],
        "network_mode": "blocked",
        "allowed_domains": [],
        "denied_domains": [],
        "high_risk_requires_approval": True,
        "sql_mode": "read_only",
        "operation_switches": {
            "git_read": "block", "git_push": "block", "git_destructive": "block",
            "rm": "block", "mv": "confirm",
            "db_write": "confirm", "db_schema": "block",
            "package_install": "block",
            "curl_read": "block", "curl_mutate": "block",
            "docker": "block", "kubectl": "block", "ssh": "block",
        },
        "device_permissions": {
            "read_contacts": "block", "read_sms": "block", "send_sms": "block",
            "read_calendar": "block", "get_location": "block", "read_media": "block",
            "screen_capture": "block", "screen_tap": "block", "launch_app": "block",
            "set_system": "block", "read_call_log": "block", "make_call": "block",
            "read_notifications": "block", "list_installed_apps": "block",
            "device_info": "confirm",
            "force_stop_app": "block",
            "desktop_observe": "confirm",
            "desktop_input": "block",
            "desktop_window": "block",
        },
    },
    "collaborative": {
        "command_execution": "sandboxed",
        "terminal_mode": "sandboxed",
        "sandbox_level": "filesystem",
        "file_access": "organization",
        "custom_write_paths": [],
        "deny_read_paths": ["~/.ssh", "~/.aws", "~/.gnupg"],
        "deny_write_paths": [".env", ".env.*", "*.pem", "*.key", "*.pfx", "*.p12", "*.p8", ".git/*"],
        "network_mode": "allowed",
        "allowed_domains": [],
        "denied_domains": [],
        "high_risk_requires_approval": True,
        "sql_mode": "read_write",
        "operation_switches": {
            "git_read": "allow", "git_push": "confirm", "git_destructive": "confirm",
            "rm": "confirm", "mv": "confirm",
            "db_write": "allow", "db_schema": "block",
            "package_install": "confirm",
            "curl_read": "confirm", "curl_mutate": "block",
            "docker": "confirm", "kubectl": "block", "ssh": "block",
        },
        "device_permissions": {
            "read_contacts": "confirm", "read_sms": "confirm", "send_sms": "confirm",
            "read_calendar": "confirm", "get_location": "confirm", "read_media": "confirm",
            "screen_capture": "confirm", "screen_tap": "confirm", "launch_app": "confirm",
            "set_system": "block", "read_call_log": "confirm", "make_call": "block",
            "read_notifications": "confirm", "list_installed_apps": "confirm",
            "device_info": "allow",
            "force_stop_app": "confirm",
            "desktop_observe": "allow",
            "desktop_input": "confirm",
            "desktop_window": "confirm",
        },
    },
    "full_auto": {
        "command_execution": "regular",
        "terminal_mode": "regular",
        "sandbox_level": "filesystem",
        "file_access": "organization",
        "custom_write_paths": [],
        "deny_read_paths": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube"],
        "deny_write_paths": [".env", ".env.*", "*.pem", "*.key", "*.pfx", "*.p12", "*.p8", ".git/*"],
        "network_mode": "allowed",
        "allowed_domains": [],
        "denied_domains": [],
        "high_risk_requires_approval": True,
        "sql_mode": "read_write",
        "operation_switches": {
            "git_read": "allow", "git_push": "allow", "git_destructive": "confirm",
            "rm": "confirm", "mv": "allow",
            "db_write": "allow", "db_schema": "confirm",
            "package_install": "allow",
            "curl_read": "allow", "curl_mutate": "confirm",
            "docker": "confirm", "kubectl": "confirm", "ssh": "block",
        },
        "device_permissions": {
            "read_contacts": "allow", "read_sms": "allow", "send_sms": "confirm",
            "read_calendar": "allow", "get_location": "allow", "read_media": "allow",
            "screen_capture": "allow", "screen_tap": "confirm", "launch_app": "allow",
            "set_system": "confirm", "read_call_log": "confirm", "make_call": "confirm",
            "read_notifications": "confirm", "list_installed_apps": "allow",
            "device_info": "allow",
            "force_stop_app": "confirm",
            "desktop_observe": "allow",
            "desktop_input": "confirm",
            "desktop_window": "allow",
        },
    },
    "server_auto": {
        "command_execution": "regular",
        "terminal_mode": "regular",
        "sandbox_level": "filesystem",
        "file_access": "organization",
        "custom_write_paths": [],
        "deny_read_paths": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube"],
        "deny_write_paths": [".env", ".env.*", "*.pem", "*.key", "*.pfx", "*.p12", "*.p8", ".git/*"],
        "network_mode": "allowed",
        "allowed_domains": [],
        "denied_domains": [],
        "high_risk_requires_approval": False,
        "sql_mode": "read_write",
        "operation_switches": {
            "git_read": "allow", "git_push": "allow", "git_destructive": "allow",
            "rm": "allow", "mv": "allow",
            "db_write": "allow", "db_schema": "allow",
            "package_install": "allow",
            "curl_read": "allow", "curl_mutate": "allow",
            "docker": "allow", "kubectl": "allow", "ssh": "block",
        },
        "device_permissions": {
            "read_contacts": "allow", "read_sms": "allow", "send_sms": "block",
            "read_calendar": "allow", "get_location": "allow", "read_media": "allow",
            "screen_capture": "allow", "screen_tap": "allow", "launch_app": "allow",
            "set_system": "block", "read_call_log": "allow", "make_call": "block",
            "read_notifications": "allow", "list_installed_apps": "allow",
            "device_info": "allow",
            "force_stop_app": "confirm",
            "desktop_observe": "allow",
            "desktop_input": "confirm",
            "desktop_window": "allow",
        },
    },
}

DEFAULT_SANDBOX_PRESET = "collaborative"

# ---------------------------------------------------------------------------
# 默认敏感目录写保护 — 无论 preset 如何配置、是否有并行 Agent，
# 以下路径始终加入 deny_write_paths，防止 Agent 意外覆盖关键凭证/配置。
# 使用 ~ 前缀，由 _match_path_pattern 负责展开为实际 home 路径。
# ---------------------------------------------------------------------------

_DEFAULT_SENSITIVE_DENY_WRITE_PATHS: List[str] = [
    "~/.ssh/*",
    "~/.gitconfig",
    "~/.tabtin/*",
    "~/.aws/*",
    "~/.gnupg/*",
    "~/.kube/*",
    "~/.netrc",
]

# ---------------------------------------------------------------------------
# relaxed_rules 白名单 — 镜像 TS 端 RELAXABLE_ALLOW_RULES 的 key 集合
# @see packages/terminal-core/src/allowlist.ts RELAXABLE_ALLOW_RULES
# ---------------------------------------------------------------------------

VALID_RELAXED_RULES: frozenset = frozenset({
    "curl-mutating", "wget-write", "curl-basic", "wget-basic",
    "scp", "rsync", "ftp-sftp",
    "python-inline", "node-inline", "python-script", "node-script",
})

# ---------------------------------------------------------------------------
# Home 目录启发式匹配正则（PDC-011 fix）
# ---------------------------------------------------------------------------
# [^/]+ 匹配任意非斜杠字符（包括空格、特殊字符），能正确处理
# 用户名含空格的 home 路径（如 /Users/alice doe/.ssh/id_rsa）。
# 编译为模块级常量避免每次调用时重复编译。

_KNOWN_HOME_RE = re.compile(
    r"^("
    r"/Users/[^/]+"               # macOS
    r"|/home/[^/]+"               # 标准 Linux
    r"|/root"                     # root 用户
    r"|/nix/home/[^/]+"           # NixOS
    r"|/export/home/[^/]+"        # Solaris / 部分企业
    r"|/usr/home/[^/]+"           # FreeBSD
    r"|[A-Za-z]:/Users/[^/]+"     # Windows (归一化后)
    r"|/mnt/[a-z]/Users/[^/]+"    # WSL
    r")",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# 高危命令模式（触发 HITL 审批）— SSOT，@tabtin/security-policy 的 Python 端镜像
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class HighRiskPatternEntry:
    name: str
    pattern: re.Pattern


HIGH_RISK_PATTERNS: List[HighRiskPatternEntry] = [
    HighRiskPatternEntry("git-push",         re.compile(r"\bgit\s+push\b", re.IGNORECASE)),
    HighRiskPatternEntry("docker-build-push", re.compile(r"\bdocker\s+(build|push|run)\b", re.IGNORECASE)),
    HighRiskPatternEntry("kubectl-mutate",   re.compile(r"\bkubectl\s+(apply|create|delete|scale)\b", re.IGNORECASE)),
    HighRiskPatternEntry("npm-publish",      re.compile(r"\b(npm|pnpm|yarn)\s+(publish)\b", re.IGNORECASE)),
    HighRiskPatternEntry("terraform-apply",  re.compile(r"\b(terraform|pulumi)\s+(apply|destroy)\b", re.IGNORECASE)),
    HighRiskPatternEntry("scp",              re.compile(r"\bscp\b", re.IGNORECASE)),
    HighRiskPatternEntry("rsync",            re.compile(r"\brsync\b", re.IGNORECASE)),
    HighRiskPatternEntry("curl-mutate",      re.compile(r"\bcurl\b.*(-X\s*(POST|PUT|DELETE|PATCH)|-d\s)", re.IGNORECASE)),
    HighRiskPatternEntry("rm-recursive",     re.compile(r"\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f|--recursive|--force)\b", re.IGNORECASE)),
    HighRiskPatternEntry("dd",               re.compile(r"\bdd\s+", re.IGNORECASE)),
    HighRiskPatternEntry("sudo",             re.compile(r"\bsudo\b", re.IGNORECASE)),
    HighRiskPatternEntry("chmod-777",        re.compile(r"\bchmod\s+777\b", re.IGNORECASE)),
    HighRiskPatternEntry("mkfs",             re.compile(r"\bmkfs\b", re.IGNORECASE)),
    HighRiskPatternEntry("fork-bomb",        re.compile(r":\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:", re.IGNORECASE)),
    HighRiskPatternEntry("shutdown-reboot",  re.compile(r"\b(shutdown|reboot|halt|poweroff)\b", re.IGNORECASE)),
    HighRiskPatternEntry("kill-force",       re.compile(r"\bkill\s+(-9|-SIGKILL|-KILL)\b", re.IGNORECASE)),
    HighRiskPatternEntry("chown-recursive",  re.compile(r"\bchown\s+(-R|--recursive)\b", re.IGNORECASE)),
    HighRiskPatternEntry("mv-devnull",       re.compile(r"\bmv\s+.*/dev/null\b", re.IGNORECASE)),
    HighRiskPatternEntry("write-device",     re.compile(r">\s*/dev/sd[a-z]", re.IGNORECASE)),
    HighRiskPatternEntry("format-drive",     re.compile(r"\bformat\b.*\b[A-Za-z]:", re.IGNORECASE)),
    HighRiskPatternEntry("iptables-ufw",     re.compile(r"\b(iptables|ufw)\s+", re.IGNORECASE)),
    HighRiskPatternEntry("systemctl-stop",   re.compile(r"\bsystemctl\s+(stop|disable|mask)\b", re.IGNORECASE)),
]


def is_high_risk_command(command: str) -> bool:
    from apps.services.common.unicode_security import normalize_for_matching
    normalized = normalize_for_matching(command)
    return any(e.pattern.search(normalized) for e in HIGH_RISK_PATTERNS)


def _is_tabtin_platform_command(command: str) -> bool:
    """判断命令是否为 tabtin 平台命令。

    tabtin CLI 命令通过 CLI Server（Unix socket）回连本地平台服务，
    天然需要本地能力访问，不适合 OS 级沙箱隔离。
    平台自身的审批机制（approval_required）已提供安全保障。
    """
    stripped = command.strip()
    return stripped == "tabtin" or stripped.startswith("tabtin ")


# ---------------------------------------------------------------------------
# SQL 安全校验 — 镜像 @tabtin/security-policy sql-rules.ts SqlRuleSet
#
# 与 TS 端保持一致，并修复已知缺陷（SQL-001~004）：
#   - RENAME 加入禁止关键字和危险 SQL 正则
#   - DELETE 无 FROM 绕过修复
#   - TCL 语句加入危险 SQL 正则
#   - UNION SELECT 在 read_only 模式下拦截
# ---------------------------------------------------------------------------

FORBIDDEN_SQL_KEYWORDS: frozenset = frozenset({
    "CREATE", "ALTER", "DROP", "TRUNCATE",          # DDL
    "GRANT", "REVOKE",                              # DCL
    "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT",     # TCL
    "RENAME",                                       # SQL-002 fix
})

_DANGEROUS_SQL_RE: re.Pattern = re.compile(
    r"\b("
    r"DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE"
    r"|DELETE(\s+FROM)?"           # SQL-003 fix: DELETE 无 FROM 也拦截
    r"|RENAME\s+TABLE"             # SQL-002 fix
    r"|BEGIN|COMMIT|ROLLBACK|SAVEPOINT"  # SQL-004 fix: TCL 在正则兜底
    r")\b",
    re.IGNORECASE,
)

_CTE_WRITE_RE: re.Pattern = re.compile(
    r"\bWITH\b[\s\S]+?\b(INSERT|UPDATE|DELETE|MERGE)\b",
    re.IGNORECASE,
)

_UNION_SQL_RE: re.Pattern = re.compile(r"\bUNION\b", re.IGNORECASE)

_MULTI_STATEMENT_RE: re.Pattern = re.compile(r";\s*\S")


def validate_sql(sql: str, sql_mode: str) -> Optional[str]:
    """校验 SQL 语句安全性，返回拒绝原因字符串或 None（通过）。

    镜像 TS 端 SqlRuleSet.evaluate() 并修复 SQL-001~004。
    """
    if sql_mode == "blocked":
        return "SQL execution is blocked by security policy."

    from apps.services.common.unicode_security import normalize_for_matching
    sql = normalize_for_matching(sql)
    trimmed = sql.strip()
    if not trimmed:
        return "Empty SQL statement."

    if _MULTI_STATEMENT_RE.search(trimmed):
        return "Multiple SQL statements are not allowed."

    parts = trimmed.split(None, 1)
    first_word = parts[0].upper() if parts else ""

    if first_word in FORBIDDEN_SQL_KEYWORDS:
        return f"SQL keyword '{first_word}' is not allowed."

    if _DANGEROUS_SQL_RE.search(trimmed):
        return "SQL contains dangerous operations."

    if _CTE_WRITE_RE.search(trimmed):
        return "CTE (WITH ... AS) containing write operations (INSERT/UPDATE/DELETE/MERGE) is not allowed."

    if sql_mode == "read_only":
        if first_word not in ("SELECT", "EXPLAIN", "SHOW", "DESCRIBE"):
            return f"SQL mode is read_only but statement starts with '{first_word}'."
        if _UNION_SQL_RE.search(trimmed):
            return "UNION is not allowed in read_only mode."

    return None


# ---------------------------------------------------------------------------
# ExecutionDecision
# ---------------------------------------------------------------------------

@dataclass
class ExecutionDecision:
    route: str          # "sandbox" | "regular" | "blocked"
    sandbox_level: str  # "filesystem" | "complete"
    approval_required: bool
    deny_reason: Optional[str] = None
    review_reason: Optional[str] = None
    network_mode: str = "allowed"  # "allowed" | "blocked" | "custom"
    relaxed_rules: Optional[List[str]] = None
    terminal_mode: Optional[str] = None  # "tabtin_only" | "sandboxed" | "regular" | "blocked"
    operation_switches: Optional[Dict[str, str]] = None
    sql_mode: Optional[str] = None  # "read_only" | "read_write" | "blocked"
    deny_read_paths: Optional[List[str]] = None
    deny_write_paths: Optional[List[str]] = None
    device_permissions: Optional[Dict[str, str]] = None
    high_risk_requires_approval: bool = True
    risk_level: str = "safe"  # "safe" | "review" | "strict"

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        if not d.get("relaxed_rules"):
            d.pop("relaxed_rules", None)
        for key in ("terminal_mode", "operation_switches", "sql_mode",
                     "deny_read_paths", "deny_write_paths", "review_reason"):
            if d.get(key) is None:
                d.pop(key, None)
        if not d.get("device_permissions"):
            d["device_permissions"] = dict(
                SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET]["device_permissions"]
            )
        return d


# ---------------------------------------------------------------------------
# SandboxPolicyResolver
# ---------------------------------------------------------------------------

class SandboxPolicyResolver:
    """根据 sandbox config 解析执行决策。

    PAS-005: 可选接收 authorization_rules（来自 PermissionRuleEngine 体系），
    用于对齐 approval_required 语义。当 authorization_rules 指定某类操作
    需要 confirm 时，即使 sandbox 预设本身不要求审批，也将 approval_required
    设为 True，确保两套体系输出一致的审批信号。
    """

    def __init__(
        self,
        sandbox_config: Optional[Dict[str, Any]] = None,
        device_home_dir: Optional[str] = None,
        authorization_rules: Optional[Dict[str, str]] = None,
        other_agent_workspaces: Optional[List[str]] = None,
    ):
        if sandbox_config:
            self._config = sandbox_config
        else:
            self._config = dict(SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET])
        self._device_home_dir = self._normalize_path(device_home_dir) if device_home_dir else None
        self._authorization_rules: Dict[str, str] = authorization_rules or {}
        self._other_agent_workspaces: List[str] = [
            p for p in (
                self._normalize_path(ws) for ws in (other_agent_workspaces or [])
                if ws and isinstance(ws, str) and ws.strip()
            ) if p and p.strip() and p != "."
        ]

    def _path_in_workspace_allowed_paths(
        self,
        file_path: Optional[str],
        workspace_snapshot: Optional[Dict[str, Any]],
    ) -> bool:
        """判断 file_path 是否落在 workspace_snapshot.allowedPaths 任一目录子树下。

        路径权限治理 Wave 4：v3 SSoT 一致性 helper（与 TS 端
        `@tabtin/security-policy` 的 `isPathInAllowedRoots` 同语义）。

        - file_path 与 allowedPaths 都先 _normalize_path 归一化，避免
          `..` / URL 编码 / 反斜杠绕过
        - allowedPaths 任一条命中前缀（path == root or path.startswith(root + '/')）
          即视为在工作区内
        - workspace_snapshot 缺省 / 形态错误 / allowedPaths 为空 → 返回 False
          （走原有 deny lists 检查）

        P1-6 修复：用 `is_dangerously_broad_root` 过滤"过宽 root"——上游
        sender（mobile / 受损客户端）若在 allowedPaths 里塞 `/` / `/Users`
        / `/etc` 等顶级目录，本函数会让 Django 对**任何**路径都 short-circuit
        放行，绕过 deny lists（含敏感目录）。fail-closed 防御：危险 root
        skip，不参与 short-circuit 判定（与 TS 端 isPathInAllowedRoots 内
        `if isDangerouslyBroadPath(dir) continue` 同款治理）。
        """
        if not file_path or not workspace_snapshot:
            return False
        if not isinstance(workspace_snapshot, dict):
            return False
        allowed_paths = workspace_snapshot.get("allowedPaths")
        if not isinstance(allowed_paths, list) or not allowed_paths:
            return False

        normalized_target = self._normalize_path(file_path)
        if not normalized_target:
            return False

        # 延迟 import 避免循环依赖（path_safety 是独立 leaf 模块）
        from apps.services.common.path_safety import is_dangerously_broad_root

        for raw_root in allowed_paths:
            if not isinstance(raw_root, str) or not raw_root:
                continue
            # P1-6：危险 root（`/` / `/Users` / `/etc` 等）skip
            if is_dangerously_broad_root(raw_root):
                continue
            normalized_root = self._normalize_path(raw_root)
            if not normalized_root:
                continue
            # 二次防御：normalize 后再次过滤（譬如 raw 是 `/Users/` normalize
            # 成 `/Users`，仍要拦）
            if is_dangerously_broad_root(normalized_root):
                continue
            if normalized_target == normalized_root:
                return True
            # 用 '/' 边界判断目录子树，避免 /Users/x/proj 命中 /Users/x/projother
            prefix = normalized_root + "/"
            if normalized_target.startswith(prefix):
                return True
        return False

    def _matches_sensitive_path(self, file_path: Optional[str], *, is_write: bool = False) -> bool:
        """D10：workspace short-circuit 前保留 sensitive 红线。

        用户把 home 或大目录加入 workspace 后，普通项目路径应放行；但
        `~/.ssh` / `~/.aws` / `.env` / key 文件这类敏感路径不能因为
        allowedPaths 命中就绕过 sandbox preset。
        """
        if not file_path:
            return False
        normalized = self._normalize_path(file_path)
        from apps.services.common.path_safety import matches_sensitive_path
        if matches_sensitive_path(normalized):
            return True
        patterns = list(self._config.get("deny_read_paths", []))
        if is_write:
            patterns.extend(self._merge_deny_write_paths(self._config.get("deny_write_paths", [])))
        basename = normalized.rsplit("/", 1)[-1] if "/" in normalized else normalized
        return any(
            self._match_path_pattern(normalized, pattern)
            or self._match_path_pattern(basename, pattern)
            for pattern in patterns
        )

    @staticmethod
    def _normalize_path(p: Optional[str]) -> str:
        """将路径归一化为 POSIX 风格（/ 分隔、解析 .. 和 .、去除尾部 /），确保跨平台比较一致。

        PATH-006 fix: 先 URL 解码再 normpath，防止 %2e%2e 等编码绕过
        路径遍历检测和 deny_read_paths 匹配。

        注意: normpath 会消除 '..'，因此路径穿越检测必须在调用本方法之前
        对原始字符串执行（见 _has_raw_traversal）。
        """
        if not p:
            return ""
        from urllib.parse import unquote
        import posixpath
        decoded = unquote(p)
        return posixpath.normpath(decoded.replace("\\", "/"))

    @staticmethod
    def _has_raw_traversal(raw: str) -> bool:
        """检查原始路径中是否包含 '..' 路径穿越段。

        PATH-006 fix: 先 URL 解码再检测，防止 %2e%2e 绕过。
        必须在 _normalize_path 之前调用，因为 normpath 会解析掉 '..'。
        """
        if not raw:
            return False
        from urllib.parse import unquote
        decoded = unquote(raw)
        return ".." in decoded.replace("\\", "/").split("/")

    @classmethod
    def from_agent_config(
        cls,
        agent_config: Optional[Dict[str, Any]],
        device_home_dir: Optional[str] = None,
        authorization_rules: Optional[Dict[str, str]] = None,
        other_agent_workspaces: Optional[List[str]] = None,
        *,
        requested_agent_mode: str = "agent",
        is_group_space: bool = False,
        organization_settings: Optional[Dict[str, Any]] = None,
    ) -> "SandboxPolicyResolver":
        """从 agent_config（路径 / workspace）+ 组织天花板（yolo gate）派生 SandboxPolicyResolver。

        Hilt 重写：只读 workspace / 路径信息，不再从 authorization_preset
        查 SANDBOX_PRESETS，不再投影 shell/filesystem/network/sql/device overrides。

        yolo 升级到 full_auto preset 需要同时满足三条（ 后 gate 源改为组织）：
          1. 组织已开放 Yolo 准入天花板
             （``organization_settings.allow_member_yolo`` 为 True）
          2. 本次对话请求 yolo 档（``requested_agent_mode == 'yolo'``）
          3. 当前运行时不是群协作上下文（group runtime 强制互斥）

        任一未满足 → 降级为默认 preset（collaborative），并记录
        ``logger.warning`` 以便审计与诊断。

        Args:
            requested_agent_mode: 本次对话请求档位（默认 'agent'）。来自
                客户端消息体 ``body.agent_mode``；fail-safe 默认 'agent' 即不会升级 yolo。
            is_group_space: 当前运行时是否群协作上下文。Space-first Phase 4 后
                不能再从 ``Space.type`` 派生，未来应由 group runtime 配置提供。
            organization_settings: 当前 Space/Agent 所属组织的 ``settings`` dict
                （``space.organization.settings``）。#3836：yolo gate 是组织准入
                天花板，从这里读；缺省 None → gate 关闭（fail-safe）。
        """
        if not agent_config:
            # 无 agent_config（缺路径 / workspace 信息）→ 保守走默认 collaborative
            # preset，不升级 yolo（fail-safe）。
            return cls(
                device_home_dir=device_home_dir,
                authorization_rules=authorization_rules,
                other_agent_workspaces=other_agent_workspaces,
            )

        # yolo gate 走 governance_resolver——组织准入天花板：读
        # ``organization_settings.allow_member_yolo``，不再读 Agent 配置。
        # resolver fail-safe：None / 脏值 → False。
        from apps.services.common.agent_governance_resolver import (
            resolve_allow_yolo_mode,
        )
        gate_open = resolve_allow_yolo_mode(organization_settings)
        requested_yolo = requested_agent_mode == "yolo"
        effective_yolo = requested_yolo and gate_open and not is_group_space
        preset_name = "full_auto" if effective_yolo else DEFAULT_SANDBOX_PRESET
        config = dict(SANDBOX_PRESETS.get(preset_name, SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET]))

        if requested_yolo and not effective_yolo:
            # 区分 fail-safe 触发原因，方便排障与审计。group 优先（group + gate
            # 关都触发时仍记 group_space，因为 group 是硬约束，gate 是软授权）。
            if is_group_space:
                reason = "group_space"
            elif not gate_open:
                reason = "gate_off"
            else:
                reason = "unknown"
            logger.warning(
                "[SandboxPolicy] yolo_mode_rejected: reason=%s requested=%s "
                "gate_open=%s is_group_space=%s",
                reason,
                requested_agent_mode,
                gate_open,
                is_group_space,
            )

        return cls(
            config,
            device_home_dir=device_home_dir,
            authorization_rules=authorization_rules,
            other_agent_workspaces=other_agent_workspaces,
        )

    def _merge_deny_write_paths(
        self,
        base_paths: List[str],
        extra_workspaces: Optional[List[str]] = None,
        agent_workspace: Optional[str] = None,
    ) -> List[str]:
        """合并基础 deny_write_paths、默认敏感目录、以及其他 Agent 工作目录的写保护路径。

        三层合并（按顺序追加）：
        1. base_paths — preset/config 原始 deny_write_paths
        2. _DEFAULT_SENSITIVE_DENY_WRITE_PATHS — 始终保护的敏感目录
        3. 其他 Agent 工作目录 — 多 Agent 并行隔离

        Args:
            base_paths: 原始 deny_write_paths。
            extra_workspaces: 额外的工作目录列表（叠加到实例级 _other_agent_workspaces）。
            agent_workspace: 当前 Agent 自身工作目录（用于从列表中排除自身）。
        """
        merged = list(base_paths)
        existing = set(base_paths)

        for path in _DEFAULT_SENSITIVE_DENY_WRITE_PATHS:
            if path not in existing:
                merged.append(path)
                existing.add(path)

        all_workspaces = list(self._other_agent_workspaces)
        if extra_workspaces:
            for ws in extra_workspaces:
                if ws and ws not in all_workspaces:
                    all_workspaces.append(ws)

        normalized_own = self._normalize_path(agent_workspace) if agent_workspace else None
        for ws in all_workspaces:
            if not ws:
                continue
            if normalized_own and self._normalize_path(ws) == normalized_own:
                continue
            pattern = f"{ws}/*"
            if ws not in existing:
                merged.append(ws)
                existing.add(ws)
            if pattern not in existing:
                merged.append(pattern)
                existing.add(pattern)
        return merged

    def resolve_terminal(
        self,
        command: str,
        *,
        agent_workspace: Optional[str] = None,
        other_agent_workspaces: Optional[List[str]] = None,
    ) -> ExecutionDecision:
        """对终端执行工具（execute_in_terminal）解析执行决策。

        Args:
            command: 待执行的命令。
            agent_workspace: 可选，当前 Agent 自身的工作目录。
                传入时用于从 other_agent_workspaces 中排除自身（防御性过滤）。
            other_agent_workspaces: 可选，其他并行 Agent 的工作目录列表。
                传入时将这些路径合并到 deny_write_paths，阻止当前 Agent
                写入其他 Agent 的工作区。此参数与实例级 _other_agent_workspaces
                叠加使用。
        """
        terminal_mode = self._config.get("terminal_mode")
        execution_mode = self._config.get("command_execution", "sandboxed")
        network_mode = self._config.get("network_mode", "allowed")
        operation_switches = self._config.get("operation_switches") or {}
        sql_mode = self._config.get("sql_mode", "read_write")

        if not terminal_mode:
            if execution_mode == "blocked":
                terminal_mode = "blocked"
            elif execution_mode == "regular":
                terminal_mode = "regular"
            else:
                terminal_mode = "sandboxed"

        high_risk_flag = self._config.get("high_risk_requires_approval", True)

        extra_workspaces = [
            p for p in (
                self._normalize_path(ws) for ws in (other_agent_workspaces or [])
                if ws and isinstance(ws, str) and ws.strip()
            ) if p and p.strip() and p != "."
        ]
        deny_write = self._merge_deny_write_paths(
            self._config.get("deny_write_paths", []),
            extra_workspaces=extra_workspaces or None,
            agent_workspace=agent_workspace,
        )

        if terminal_mode == "blocked" or execution_mode == "blocked":
            return ExecutionDecision(
                route="blocked",
                sandbox_level="complete",
                approval_required=False,
                deny_reason="Terminal execution is blocked by sandbox policy.",
                network_mode="blocked",
                terminal_mode="blocked",
                operation_switches=operation_switches,
                sql_mode=sql_mode,
                deny_read_paths=self._config.get("deny_read_paths", []),
                deny_write_paths=deny_write,
                device_permissions=self._config.get("device_permissions"),
                high_risk_requires_approval=high_risk_flag,
            )

        is_platform_cmd = _is_tabtin_platform_command(command)

        if terminal_mode == "tabtin_only":
            if is_platform_cmd:
                route = "regular"
            else:
                return ExecutionDecision(
                    route="blocked",
                    sandbox_level="complete",
                    approval_required=False,
                    deny_reason="tabtin_only 模式下仅允许执行 tabtin 平台命令。",
                    network_mode=network_mode,
                    terminal_mode=terminal_mode,
                    operation_switches=operation_switches,
                    sql_mode=sql_mode,
                    deny_read_paths=self._config.get("deny_read_paths", []),
                    deny_write_paths=deny_write,
                    device_permissions=self._config.get("device_permissions"),
                    high_risk_requires_approval=high_risk_flag,
                )
        elif terminal_mode == "sandboxed":
            route = "regular" if is_platform_cmd else "sandbox"
        elif terminal_mode == "regular":
            route = "regular"
        else:
            route = "sandbox"

        sandbox_level = self._config.get("sandbox_level", "filesystem")
        approval_required = terminal_mode in ("tabtin_only", "sandboxed")
        review_reason: Optional[str] = None

        if approval_required:
            review_reason = f"Terminal mode is '{terminal_mode}', confirmation required."

        if not approval_required and self._config.get("high_risk_requires_approval", True) and is_high_risk_command(command):
            approval_required = True
            review_reason = "Command classified as high-risk, confirmation required."

        # PAS-005: 与 PermissionRuleEngine 的 authorization_rules 双向对齐。
        if self._authorization_rules.get("script") == "confirm":
            approval_required = True
            if not review_reason:
                review_reason = "Authorization rules require confirmation for script operations."
        elif self._authorization_rules.get("script") == "auto" and approval_required:
            approval_required = False
            review_reason = None

        relaxed = self._build_relaxed_rules()

        risk_level = "safe"
        if high_risk_flag and is_high_risk_command(command):
            risk_level = "strict"
        elif approval_required:
            risk_level = "review"

        return ExecutionDecision(
            route=route,
            sandbox_level=sandbox_level,
            approval_required=approval_required,
            review_reason=review_reason,
            network_mode=network_mode,
            relaxed_rules=relaxed or None,
            terminal_mode=terminal_mode,
            operation_switches=operation_switches,
            sql_mode=sql_mode,
            deny_read_paths=self._config.get("deny_read_paths", []),
            deny_write_paths=deny_write,
            device_permissions=self._config.get("device_permissions"),
            high_risk_requires_approval=high_risk_flag,
            risk_level=risk_level,
        )

    def _build_relaxed_rules(self) -> List[str]:
        """根据当前配置生成需要放行的规则名列表。

        镜像 TS 端 compat.ts buildRelaxedRules：
        - terminal_mode=regular → curl-mutating, wget-write
        - operation_switches 中 allow 的开关 → 对应 denylist 规则
        """
        rules: List[str] = []
        switches = self._config.get("operation_switches") or {}

        # SER-002 fix: 使用 terminal_mode 判断执行模式（与 TS 端 buildRelaxedRules 对齐），
        # fallback 到从 command_execution 派生，复用 resolve_terminal 的同款逻辑。
        terminal_mode = self._config.get("terminal_mode")
        if not terminal_mode:
            execution_mode = self._config.get("command_execution", "sandboxed")
            if execution_mode == "blocked":
                terminal_mode = "blocked"
            elif execution_mode == "regular":
                terminal_mode = "regular"
            else:
                terminal_mode = "sandboxed"

        if terminal_mode == "regular":
            if switches.get("curl_mutate") != "block":
                rules.append("curl-mutating")
            # SER-001 + SER-007 fix: wget-write 受 curl_read 开关控制，与 TS 端对称
            if switches.get("curl_read") != "block":
                rules.append("wget-write")

        if switches.get("curl_read") == "allow":
            rules.append("curl-basic")
        if switches.get("curl_mutate") == "allow":
            rules.append("curl-mutating")
        if switches.get("ssh") == "allow":
            rules.extend(["scp", "rsync"])

        extra = self._config.get("relaxed_rules", [])
        if isinstance(extra, list):
            for rule in extra:
                if rule in VALID_RELAXED_RULES:
                    rules.append(rule)
                else:
                    logger.warning(
                        "[SandboxPolicy] Rejected invalid relaxed_rule '%s' "
                        "(not in VALID_RELAXED_RULES whitelist)",
                        rule,
                    )
        return list(dict.fromkeys(rules))

    def resolve_file(
        self,
        action_type: str,
        file_path: Optional[str] = None,
        workspace_snapshot: Optional[Dict[str, Any]] = None,
    ) -> ExecutionDecision:
        """对 read_file/write_file/edit_file/delete_file 解析执行决策。

        路径权限治理 Wave 4：接受 workspace_snapshot 参数（来自 wire envelope
        `prompt.forward.workspace_snapshot` —— 主控端 Electron 透传上来的 v3
        SSoT）。在 deny lists 之前先做 allow short-circuit：如果 file_path
        在 `workspace_snapshot.allowedPaths` 任一目录下，直接 route='regular'
        返回（即放行）。

        语义与本地 Electron / Daemon path-access-checker 对齐：用户主动在
        TabCode/TabFolder 打开的目录 = 用户已授权该目录内的操作；Space 级
        sandbox preset 在用户授权的 workspace 内放宽，避免"用户打开了 X
        但 LLM 决策被云端 sandbox 不知道 X 的存在拦下"的体验断层（修 01
        图谱 §断层 6 "Django SandboxPolicyResolver 没有 workspace_snapshot
        概念"）。

        系统级红线（`/etc/*`、`/System/*` 等）由 Daemon / Electron 在执行
        前做最终兜底，Django 端不是最后一道防线 —— 这里 short-circuit 信任
        用户的工作区授权。
        """
        is_write = action_type in ("write_file", "edit_file", "delete_file")
        route = "regular"
        sandbox_level = self._config.get("sandbox_level", "filesystem")
        file_path = self._normalize_path(file_path) if file_path else None

        # Wave 4：allow short-circuit —— 在所有 deny 检查之前
        if (
            file_path
            and self._path_in_workspace_allowed_paths(file_path, workspace_snapshot)
            and not self._matches_sensitive_path(file_path, is_write=is_write)
        ):
            return ExecutionDecision(
                route="regular",
                sandbox_level=sandbox_level,
                approval_required=False,
            )

        if file_path:
            if self._matches_sensitive_path(file_path, is_write=is_write):
                return ExecutionDecision(
                    route="blocked",
                    sandbox_level=sandbox_level,
                    approval_required=False,
                    deny_reason=f"Accessing sensitive path '{file_path}' is blocked by sandbox policy.",
                )
            basename = file_path.rsplit("/", 1)[-1] if "/" in file_path else file_path
            if is_write:
                deny_patterns = self._merge_deny_write_paths(self._config.get("deny_write_paths", []))
                for pattern in deny_patterns:
                    # basename 匹配（.env, *.pem 等文件名级模式）
                    if self._match_path_pattern(basename, pattern):
                        return ExecutionDecision(
                            route="blocked",
                            sandbox_level=sandbox_level,
                            approval_required=False,
                            deny_reason=f"Writing to '{basename}' is blocked by sandbox policy.",
                        )
                    # 全路径匹配（workspace boundary 等目录级绝对路径模式，
                    # 以及 ~ 前缀的敏感目录保护模式）
                    if (pattern.startswith("/") or pattern.startswith("~")) and self._match_path_pattern(file_path, pattern):
                        return ExecutionDecision(
                            route="blocked",
                            sandbox_level=sandbox_level,
                            approval_required=False,
                            deny_reason=f"Writing to '{file_path}' is blocked: path is in a protected directory.",
                        )
                deny_read_patterns = self._config.get("deny_read_paths", [])
                for pattern in deny_read_patterns:
                    if self._match_path_pattern(file_path, pattern):
                        return ExecutionDecision(
                            route="blocked",
                            sandbox_level=sandbox_level,
                            approval_required=False,
                            deny_reason=f"Writing to '{file_path}' is blocked: path is in a protected directory.",
                        )
            else:
                deny_patterns = self._config.get("deny_read_paths", [])
                for pattern in deny_patterns:
                    if self._match_path_pattern(file_path, pattern):
                        return ExecutionDecision(
                            route="blocked",
                            sandbox_level=sandbox_level,
                            approval_required=False,
                            deny_reason=f"Reading '{file_path}' is blocked by sandbox policy.",
                        )

        approval_required = False
        review_reason: Optional[str] = None
        if is_write and self._config.get("high_risk_requires_approval", True):
            if action_type == "delete_file":
                approval_required = True
                review_reason = "File deletion requires confirmation."
            elif file_path and self._is_sensitive_write_target(file_path):
                approval_required = True
                review_reason = f"Writing to sensitive path '{file_path}' requires confirmation."

        # PAS-005: 与 PermissionRuleEngine 的 authorization_rules 双向对齐。
        if self._authorization_rules:
            if action_type == "delete_file":
                if self._authorization_rules.get("delete_system") == "confirm":
                    approval_required = True
                    if not review_reason:
                        review_reason = "Authorization rules require confirmation for delete operations."
                elif self._authorization_rules.get("delete_system") == "auto" and approval_required:
                    approval_required = False
                    review_reason = None
            elif is_write:
                if self._authorization_rules.get("write") == "confirm" and not approval_required:
                    approval_required = True
                    review_reason = "Authorization rules require confirmation for write operations."
                elif self._authorization_rules.get("write") == "auto" and approval_required:
                    approval_required = False
                    review_reason = None

        risk_level = "review" if approval_required else "safe"

        return ExecutionDecision(
            route=route,
            sandbox_level=sandbox_level,
            approval_required=approval_required,
            review_reason=review_reason,
            high_risk_requires_approval=self._config.get("high_risk_requires_approval", True),
            risk_level=risk_level,
        )

    def _is_sensitive_write_target(self, file_path: str) -> bool:
        """判断文件是否为敏感写入目标（需要用户审批）。

        file_path 应已经过 _normalize_path 归一化。
        """
        np = self._normalize_path(file_path)
        basename = np.rsplit("/", 1)[-1].lower() if "/" in np else np.lower()
        sensitive_names = {
            "dockerfile", "docker-compose.yml", "docker-compose.yaml",
            "makefile", ".gitignore", ".npmrc", ".yarnrc",
            "package.json", "pyproject.toml", "setup.py", "setup.cfg",
            "tsconfig.json", "webpack.config.js", "vite.config.ts",
        }
        sensitive_extensions = {".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1"}
        dot_pos = basename.rfind(".")
        ext = basename[dot_pos:] if dot_pos >= 0 else ""
        if basename in sensitive_names:
            return True
        if ext in sensitive_extensions:
            return True

        if self._is_under_home_non_project(np):
            return True
        return False

    def _is_under_home_non_project(self, file_path: str) -> bool:
        """判断 file_path 是否在用户 home 目录下但不在项目目录中。"""
        np = self._normalize_path(file_path)
        home = self._resolve_home_prefix(np)
        if not home:
            return False
        PROJECT_INDICATOR = re.compile(
            r"/(projects?|dev|src|code|repos?|organization)/",
            re.IGNORECASE,
        )
        return not PROJECT_INDICATOR.search(np)

    def _resolve_home_prefix(self, file_path: str) -> Optional[str]:
        """判断 file_path 是否在某个 home 目录下，返回 home 前缀或 None。

        file_path 应已经过 _normalize_path 归一化（/ 分隔）。
        优先使用设备上报的 home_dir（精确匹配），
        fallback 到模块级 _KNOWN_HOME_RE 正则启发式匹配。
        """
        np = self._normalize_path(file_path)
        if self._device_home_dir:
            if np.startswith(self._device_home_dir + "/"):
                return self._device_home_dir
            return None

        m = _KNOWN_HOME_RE.match(np)
        if m:
            home = m.group(0)
            if len(np) > len(home) and np[len(home)] == "/":
                return home
        return None

    def _get_unified_fields(self) -> Dict[str, Any]:
        """返回统一策略的公共字段，供各 resolve_* 方法附加到决策中。"""
        terminal_mode = self._config.get("terminal_mode")
        execution_mode = self._config.get("command_execution", "sandboxed")
        if not terminal_mode:
            if execution_mode == "blocked":
                terminal_mode = "blocked"
            elif execution_mode == "regular":
                terminal_mode = "regular"
            else:
                terminal_mode = "sandboxed"
        device_perms = self._config.get("device_permissions")
        if not device_perms:
            device_perms = dict(SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET]["device_permissions"])
        return {
            "terminal_mode": terminal_mode,
            "operation_switches": self._config.get("operation_switches") or {},
            "sql_mode": self._config.get("sql_mode", "read_write"),
            "deny_read_paths": self._config.get("deny_read_paths", []),
            "deny_write_paths": self._merge_deny_write_paths(self._config.get("deny_write_paths", [])),
            "device_permissions": device_perms,
            "high_risk_requires_approval": self._config.get("high_risk_requires_approval", True),
        }

    def resolve(
        self,
        action_type: str,
        params: Optional[Dict[str, Any]] = None,
        workspace_snapshot: Optional[Dict[str, Any]] = None,
    ) -> ExecutionDecision:
        """统一入口：根据 action_type 和参数解析执行决策。

        路径权限治理 Wave 4：透传 workspace_snapshot 给 file / code_search
        分支，让 Django 云端决策与本地 Electron / Daemon path-access-checker
        共享同一份 v3 SSoT。
        """
        params = params or {}

        if action_type == "execute_in_terminal":
            return self.resolve_terminal(params.get("command", ""))

        if action_type in ("read_file", "write_file", "edit_file", "delete_file"):
            file_path = params.get("file_path") or params.get("path")
            return self.resolve_file(action_type, file_path, workspace_snapshot=workspace_snapshot)

        if action_type in ("glob_search", "grep_search"):
            return self._resolve_code_search(params, workspace_snapshot=workspace_snapshot)

        unified = self._get_unified_fields()
        return ExecutionDecision(
            route="regular",
            sandbox_level=self._config.get("sandbox_level", "filesystem"),
            approval_required=False,
            **unified,
        )

    def _resolve_code_search(
        self,
        params: Dict[str, Any],
        workspace_snapshot: Optional[Dict[str, Any]] = None,
    ) -> ExecutionDecision:
        """对 glob_search/grep_search 检查搜索路径是否命中 deny_read_paths。

        支持多种参数键名（path/cwd/target_directory），以及 target_directories 数组。
        还检查 pattern/include/glob 参数的路径穿越与敏感目录访问。

        路径权限治理 Wave 4：在 deny_patterns 检查之前先做 allow short-circuit
        —— 如果 **所有** 搜索根都落在 workspace_snapshot.allowedPaths 内，
        直接放行（与 resolve_file 同语义）。任一搜索根未命中 allowedPaths 时
        退回到原有 deny lists 检查（保守语义：用户授权目录子集触发不放行）。
        """
        import posixpath
        sandbox_level = self._config.get("sandbox_level", "filesystem")
        deny_patterns = self._config.get("deny_read_paths", [])
        if not deny_patterns:
            return ExecutionDecision(route="regular", sandbox_level=sandbox_level, approval_required=False)

        raw_search_root = (
            params.get("path") or params.get("cwd") or params.get("target_directory") or ""
        )
        search_root = self._normalize_path(raw_search_root)

        raw_roots: List[str] = []
        all_roots: List[str] = []
        if raw_search_root:
            raw_roots.append(raw_search_root.replace("\\", "/"))
        if search_root:
            all_roots.append(search_root)
        target_dirs = params.get("target_directories")
        if isinstance(target_dirs, list):
            for td in target_dirs:
                if td:
                    raw_roots.append(td.replace("\\", "/"))
                nd = self._normalize_path(td) if td else ""
                if nd and nd not in all_roots:
                    all_roots.append(nd)

        for key in ("project_root", "current_code_project_path"):
            pr = params.get(key)
            if pr and isinstance(pr, str):
                raw_pr = pr.replace("\\", "/")
                if raw_pr not in raw_roots:
                    raw_roots.append(raw_pr)
                nd = self._normalize_path(pr)
                if nd and nd not in all_roots:
                    all_roots.append(nd)

        from urllib.parse import unquote as _unquote
        for raw in raw_roots:
            decoded_raw = _unquote(raw)
            if ".." in decoded_raw.split("/"):
                return ExecutionDecision(
                    route="blocked",
                    sandbox_level=sandbox_level,
                    approval_required=False,
                    deny_reason=f"Path traversal ('..') detected in search path '{raw}'.",
                )

        # 路径权限治理 Wave 4：allow short-circuit 前置 —— 所有搜索根都落
        # 在 workspace_snapshot.allowedPaths 内时跳过 deny_patterns（含
        # raw_pattern + 敏感目录敏感模式之外的所有目录级 deny）。
        # 任一搜索根未命中 allowedPaths 时走原有保守检查。
        if all_roots and all(
            self._path_in_workspace_allowed_paths(r, workspace_snapshot) for r in all_roots
        ) and not any(self._matches_sensitive_path(r, is_write=False) for r in all_roots):
            return ExecutionDecision(
                route="regular",
                sandbox_level=sandbox_level,
                approval_required=False,
            )

        for root in all_roots:
            for dp in deny_patterns:
                if self._match_path_pattern(root, dp):
                    return ExecutionDecision(
                        route="blocked",
                        sandbox_level=sandbox_level,
                        approval_required=False,
                        deny_reason=f"Searching in '{root}' is blocked by sandbox policy.",
                    )

        # PDC-008 fix: 先对原始 pattern 做路径穿越检测，再 normalize。
        # _normalize_path 内部调用 posixpath.normpath 会消除 '..'，
        # 导致 normalize 后的检测失效。
        raw_search_pattern = (
            params.get("pattern") or params.get("include") or params.get("glob") or ""
        )
        if raw_search_pattern and self._has_raw_traversal(raw_search_pattern):
            return ExecutionDecision(
                route="blocked",
                sandbox_level=sandbox_level,
                approval_required=False,
                deny_reason=f"Path traversal ('..') detected in search pattern '{raw_search_pattern}'.",
            )
        search_pattern = self._normalize_path(raw_search_pattern)

        primary_root = search_root or (all_roots[0] if all_roots else "")
        if primary_root and search_pattern:
            combined = posixpath.normpath(posixpath.join(primary_root, search_pattern))
            normalized_root = posixpath.normpath(primary_root)
            from pathlib import PurePosixPath
            if not PurePosixPath(combined).is_relative_to(normalized_root):
                return ExecutionDecision(
                    route="blocked",
                    sandbox_level=sandbox_level,
                    approval_required=False,
                    deny_reason=f"Search pattern '{search_pattern}' escapes search root '{primary_root}'.",
                )
            for dp in deny_patterns:
                if self._match_path_pattern(combined, dp):
                    return ExecutionDecision(
                        route="blocked",
                        sandbox_level=sandbox_level,
                        approval_required=False,
                        deny_reason=f"Search pattern '{search_pattern}' in '{primary_root}' targets a restricted path.",
                    )
        elif not primary_root and search_pattern:
            # PDC-010 fix: primary_root 为空时，绝对路径 pattern 必须也过 deny 检测，
            # 否则攻击者可构造仅含 pattern 的请求绕过所有路径检测。
            if posixpath.isabs(search_pattern):
                for dp in deny_patterns:
                    if self._match_path_pattern(search_pattern, dp):
                        return ExecutionDecision(
                            route="blocked",
                            sandbox_level=sandbox_level,
                            approval_required=False,
                            deny_reason=f"Search pattern '{search_pattern}' targets a restricted path.",
                        )

        # PDC-009 fix: 统一用 lower() 比较，避免大小写绕过（如 .SSH）。
        # strip("*?.") 会剥除前缀 '.'，所以需要补回 '.' 后再比较。
        SENSITIVE_DIRS = {".ssh", ".gnupg", ".aws", ".kube", ".docker", ".npmrc", ".env"}
        if search_pattern:
            pattern_parts = search_pattern.split("/")
            for part in pattern_parts:
                clean = part.strip("*?.")
                if not clean:
                    continue
                dotted = f".{clean.lower()}"
                if dotted in SENSITIVE_DIRS or clean.lower() in SENSITIVE_DIRS:
                    return ExecutionDecision(
                        route="blocked",
                        sandbox_level=sandbox_level,
                        approval_required=False,
                        deny_reason=f"Search pattern targets sensitive directory '{part}'.",
                    )

        return ExecutionDecision(route="regular", sandbox_level=sandbox_level, approval_required=False)

    def get_config(self) -> Dict[str, Any]:
        return dict(self._config)

    def _match_path_pattern(self, path_str: str, pattern: str) -> bool:
        """路径模式匹配，支持通配符 * 和 ~ 前缀。

        所有路径先归一化为 / 形式再比较。
        ~ 展开优先使用 device_home_dir（从设备上报），fallback 到正则启发。
        """
        import fnmatch
        np = self._normalize_path(path_str)
        npat = self._normalize_path(pattern)

        if fnmatch.fnmatch(np, npat):
            return True

        if npat.startswith("~/"):
            suffix = npat[2:]
            home = self._get_effective_home(np)
            if home:
                home_slash = home + "/"
                if np.startswith(home_slash):
                    relative = np[len(home_slash):]
                    if fnmatch.fnmatch(relative, suffix):
                        return True
                    clean = suffix.rstrip("/*")
                    if clean and relative.startswith(clean):
                        return True
        return False

    def _get_effective_home(self, file_path: str) -> Optional[str]:
        """返回用于 ~ 展开的有效 home 目录。file_path 应已归一化。

        使用模块级 _KNOWN_HOME_RE 正则做启发式推断。
        [^/]+ 匹配任意非斜杠字符（包括空格），能正确处理
        用户名含空格的 home 目录（如 /Users/alice doe）。
        """
        if self._device_home_dir:
            return self._device_home_dir

        np = self._normalize_path(file_path)
        m = _KNOWN_HOME_RE.match(np)
        return m.group(0) if m else None


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def resolve_sandbox_config(agent_config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """从 agent_config（v2 嵌套）解析出完整的扁平 sandbox 配置。

    复用 ``SandboxPolicyResolver.from_agent_config`` 的解析逻辑保证一致性，
    避免两处独立的 v1↔v2 兼容代码漂移。
    """
    if not agent_config:
        return dict(SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET])

    return dict(SandboxPolicyResolver.from_agent_config(agent_config).get_config())


def load_sandbox_config_for_space(
    space_id: Optional[str],
    *,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """加载 sandbox 配置。

    ：优先显式 ``agent_id``；否则从该 workspace 最近会话推断 Agent，
    再读 ``Agent.agent_config``。不再经 ``Workspace.agent`` FK。
    """
    if not space_id and not agent_id:
        return dict(SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET])

    try:
        from apps.agent.models import Agent
        from apps.chat.conversation.models import ChatSession

        resolved_agent_id = agent_id
        if not resolved_agent_id and space_id:
            resolved_agent_id = (
                ChatSession.objects.filter(
                    workspace_id=space_id,
                    agent_id__isnull=False,
                )
                .order_by("-updated_at")
                .values_list("agent_id", flat=True)
                .first()
            )
            if resolved_agent_id:
                resolved_agent_id = str(resolved_agent_id)
        if not resolved_agent_id:
            return dict(SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET])
        agent = Agent.objects.filter(id=resolved_agent_id).only("agent_config").first()
        agent_config = getattr(agent, "agent_config", None) if agent else None
        return resolve_sandbox_config(agent_config)
    except Exception as exc:
        logger.warning(
            "[SandboxPolicy] Failed to load sandbox for space=%s agent=%s: %s, using default",
            space_id, agent_id, exc,
        )
        return dict(SANDBOX_PRESETS[DEFAULT_SANDBOX_PRESET])


__all__ = [
    "SandboxPolicyResolver",
    "ExecutionDecision",
    "SANDBOX_PRESETS",
    "resolve_sandbox_config",
    "load_sandbox_config_for_space",
    "is_high_risk_command",
    "validate_sql",
    "FORBIDDEN_SQL_KEYWORDS",
]
