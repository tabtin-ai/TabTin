"""``CliInvocationSpec`` — 运行时 CLI 调用三元组（PRD-v3 §5.1 第 1 项）。

将"用户实际调用的命令字符串"解析后得到的结构化执行 spec。**调用态**。

字段（7 个，对应 PRD §5.1 第 1 项）：
- ``binary``         — 顶层入口可执行（如 ``"tabtin"`` 或第三方 marketplace App 声明的 CLI 名）
- ``domain``         — 业务域（如 ``"table"`` / ``"users"`` / ``"records"``）
- ``verb``           — 动作（如 ``"delete"`` / ``"send"`` / ``"query"``）
- ``resource``       — typed URI 资源标识（如 ``"<kind>:<id>"``，可空）
- ``resource_label`` — 人类可读的资源名（HITL UI 用，A1 默认 None，A4 时由 label 解析器填充）
- ``raw_args``       — 已 PII 脱敏的原始 argv 列表
- ``risk_level``     — ``safe`` / ``review`` / ``strict``（与 ``capabilities.RegisteredTool.risk_level`` 词表完全对齐，PRD §5.1 第 3 项 K8 决议）

与既有 ``apps.extensions.base.CliCommandDescriptor`` 的关系（避免命名冲突）：
- ``CliCommandDescriptor`` = Extension 静态注册时的 CLI 子命令 schema。**声明态**。
- ``CliInvocationSpec``    = 运行时实际调用解析结果。**调用态**。
- 桥接：``parser.wrap_as_cli_invocation_spec(extension_id, descriptor)`` 把 descriptor 适配为 spec。
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import FrozenSet, Iterable, List, Optional

logger = logging.getLogger(__name__)


RISK_SAFE = "safe"
RISK_REVIEW = "review"
RISK_STRICT = "strict"

RISK_LEVELS = (RISK_SAFE, RISK_REVIEW, RISK_STRICT)
"""与 ``apps.capabilities.models.RiskLevel`` 三档对齐（K8 / PRD §5.1 第 3 项）。

不引入 ``capabilities`` 包的 import，是为了让 ``cli`` 模块保持"可被任何上下文解析、不触发 Django app 加载"。
任一处词表变更必须同步两侧 + 增加跨模块 lint 检查（A3 接入 PermissionRuleEngine 时由该 PR 兼跑）。
"""

DEFAULT_RISK_LEVEL = RISK_REVIEW
"""解析失败 / 规则未命中时的兜底（fail-safe，PRD §5.1 第 2 项）。"""

KNOWN_BINARIES = frozenset({"tabtin"})
"""H1 治理范围的入口 binary 白名单（**fallback / baseline**）。

任何不在 ``compute_known_binaries()`` 结果中的 binary 会被打 ``RISK_STRICT``，
HITL 强制阻断（PRD §5.1 第 2 项）。

**A5 启动包升级（A1-L4 收口）**：
本常量保留为基线（仅覆盖平台自身的 ``tabtin``），运行时实际白名单由
:func:`compute_known_binaries` 函数动态合并 ``packages/apps/<id>/app.json``
中声明了 ``cli.binary`` 的 marketplace App。这样新增 marketplace App 时无需改本文件，
自动进入治理白名单。``parser.py`` 内已切换为 ``compute_known_binaries()``。
"""

REDACTED_FLAGS = frozenset({
    "--text",
    "--message",
    "--content",
    "--body",
    "--password",
    "--secret",
    "--token",
    "--api-key",
    "--apikey",
    "--key",
    "--auth",
    "--bearer",
    "--cookie",
})
"""PII 脱敏的敏感参数清单（PRD §5.1 第 5 项）。

命中后 value 替换为 ``<redacted len=N hash=XXXXXXXX>`` 形式（保留长度 + sha256 前 8 位）。
仅作用于解析输出 ``CliInvocationSpec.raw_args``，不影响实际 fork 子进程的真实 argv。

A1 决策：只识别长选项（``--xxx``）；短选项（``-t``）映射依赖 manifest cliGrammar 提供的 alias 表，
A1 不引入该表（避免和未来 manifest schema 设计耦合），列入交付报告遗留项。
"""


def compute_grammar_key(binary: str, domain: str, verb: str) -> str:
    """统一计算规则匹配键（PRD §5.1 第 3 项）。

    返回形态：``"<domain>.<verb>"`` 二段，匹配 ``*.delete`` / ``*.query`` /
    ``*.create_in_prod`` 等通配规则。

    对 ``binary='tabtin'`` 的命令，``parser`` 已经在 ``parse(...)`` 中剥离 ``"tabtin"`` 前缀
    （以便 ``tabtin table query`` 解析为 ``domain='table'`` ``verb='query'``，命中 ``*.query`` 规则），
    所以 grammar_key 不会冒出 ``"tabtin."`` 前缀，避免与二段通配规则冲突。

    ``parser`` 与 ``wrap_as_cli_invocation_spec`` 都通过本函数计算 grammar_key，
    保证两条路径使用同一公式（消化 A1 三视角 Review 的 P0 共识：grammar_key 不一致问题）。
    """
    return f"{domain}.{verb}"


@dataclass(frozen=True)
class CliInvocationSpec:
    """运行时 CLI 调用三元组。

    PRD-v3 §5.1 第 1 项；不可变（``frozen=True``）。所有字段均可序列化为 JSON
    （``CliAuditEvent.spec_json`` 在 A2 启动包写入时复用同一序列化）。

    审计扩展字段（A1 三视角 Review P1 反馈，A2 写 ``CliAuditEvent`` 时直接复用）：
    - ``matched_rule_pattern`` — 命中的规则 pattern（如 ``"*.delete"`` / ``"*.query"`` / ``""`` 兜底）
    - ``matched_rule_reason``  — 规则 reason 文案，便于审计页"为什么是这个 risk"反查
    """

    binary: str
    domain: str
    verb: str
    risk_level: str
    resource: Optional[str] = None
    resource_label: Optional[str] = None
    raw_args: List[str] = field(default_factory=list)
    matched_rule_pattern: str = ""
    matched_rule_reason: str = ""

    def __post_init__(self) -> None:
        if self.risk_level not in RISK_LEVELS:
            raise ValueError(
                f"CliInvocationSpec.risk_level must be one of {RISK_LEVELS}, "
                f"got {self.risk_level!r}"
            )
        if not self.binary:
            raise ValueError("CliInvocationSpec.binary must not be empty")
        if not self.domain:
            raise ValueError("CliInvocationSpec.domain must not be empty")
        if not self.verb:
            raise ValueError("CliInvocationSpec.verb must not be empty")

    @property
    def grammar_key(self) -> str:
        """``cli_rules.yaml`` 匹配 key；形态见 ``compute_grammar_key`` docstring。"""
        return compute_grammar_key(self.binary, self.domain, self.verb)

    def to_dict(self) -> dict:
        """序列化（A2 ``CliAuditEvent.spec_json`` 写入时复用）。"""
        return {
            "binary": self.binary,
            "domain": self.domain,
            "verb": self.verb,
            "resource": self.resource,
            "resource_label": self.resource_label,
            "raw_args": list(self.raw_args),
            "risk_level": self.risk_level,
            "matched_rule_pattern": self.matched_rule_pattern,
            "matched_rule_reason": self.matched_rule_reason,
        }


# ---------------------------------------------------------------------------
# A5 启动包：从 manifest 动态合并 binary 白名单（A1-L4 收口）
# ---------------------------------------------------------------------------

# 默认 manifest 扫描根目录：仓库 ``packages/apps/`` 下所有 ``<id>/app.json``。
# 计算路径：spec.py → cli/ → agent_engine/ → services/ → apps/ → tabtin_django/ → apps/ → 仓库根
# 该 fallback 仅在 Django settings 不可用 / 调用方未显式覆盖时使用。
_REPO_PACKAGES_APPS_DIR: Path = (
    Path(__file__).resolve().parent.parent.parent.parent.parent.parent.parent
    / "packages"
    / "apps"
)

# 进程级缓存，避免每次解析 CLI 都扫一遍 40+ 个 app.json。
# 通过 ``invalidate_known_binaries_cache()`` 主动清理（测试用 + 未来热更新）。
_known_binaries_cache: Optional[FrozenSet[str]] = None
_known_binaries_cache_lock = threading.Lock()


def _resolve_manifest_root() -> Path:
    """解析 manifest 扫描根目录。

    优先级：
    1. 环境变量 ``TABTIN_APPS_MANIFEST_ROOT``（测试 / 容器 / 自定义部署用）
    2. Django settings ``TABTIN_APPS_MANIFEST_ROOT``（如有定义）
    3. 仓库默认 ``<repo>/packages/apps/``

    任意路径不可读 / 不存在时返回 ``Path``，调用方按文件存在性兜底（不抛异常）。
    """
    env_path = os.environ.get("TABTIN_APPS_MANIFEST_ROOT")
    if env_path:
        return Path(env_path)
    try:
        from django.conf import settings as _settings  # type: ignore[import-not-found]

        configured = getattr(_settings, "TABTIN_APPS_MANIFEST_ROOT", None)
        if configured:
            return Path(configured)
    except Exception:
        pass
    return _REPO_PACKAGES_APPS_DIR


def _scan_manifest_binaries(root: Path) -> FrozenSet[str]:
    """扫描 ``<root>/<id>/app.json``，提取 ``cli.binary`` 字段。

    fail-safe：
    - 目录不存在 / 不可读 / JSON 解析失败 → 跳过该 manifest（warn 日志）
    - 任何异常都不应让 ``compute_known_binaries`` 抛错，否则会拖垮所有 CLI 解析
    """
    binaries: set[str] = set()
    if not root.exists() or not root.is_dir():
        logger.debug(
            "[cli.spec] manifest root %s 不存在或不是目录，跳过动态合并", root
        )
        return frozenset(binaries)
    try:
        manifest_iter: Iterable[Path] = root.iterdir()
    except OSError as exc:
        logger.warning(
            "[cli.spec] 读取 manifest 根目录 %s 失败: %s; 仅使用 KNOWN_BINARIES fallback",
            root, exc,
        )
        return frozenset(binaries)

    for app_dir in manifest_iter:
        if not app_dir.is_dir():
            continue
        manifest_path = app_dir / "app.json"
        if not manifest_path.is_file():
            continue
        try:
            with manifest_path.open("r", encoding="utf-8") as fp:
                manifest = json.load(fp)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                "[cli.spec] 解析 %s 失败: %s; 跳过", manifest_path, exc,
            )
            continue
        if not isinstance(manifest, dict):
            continue
        cli_section = manifest.get("cli")
        if not isinstance(cli_section, dict):
            continue
        binary = cli_section.get("binary")
        if isinstance(binary, str) and binary:
            binaries.add(binary)
    return frozenset(binaries)


def compute_known_binaries(
    *,
    manifest_root: Optional[Path] = None,
    use_cache: bool = True,
) -> FrozenSet[str]:
    """运行时白名单 = ``KNOWN_BINARIES`` ∪ manifest 中所有 ``cli.binary``。

    PRD-v3 §5.1 第 2 项 + A1-L4 收口：

    - **基线**：``KNOWN_BINARIES``（仅 ``tabtin``）保证 H1 治理路径在
      manifest 扫描失败时仍可用（fail-safe）。
    - **动态合并**：扫 ``packages/apps/<id>/app.json`` 中声明了 ``cli.binary`` 的 marketplace App，
      自动进入白名单。新增 marketplace App 无需改本文件。
    - **缓存**：进程级 frozenset 缓存（``compute_known_binaries.cache_clear()`` 风格的清理由
      :func:`invalidate_known_binaries_cache` 提供）。manifest 文件几乎不会运行时变更，
      cache 命中走 O(1) 查询。

    参数：
    - ``manifest_root`` — 显式覆盖扫描根（测试用）；未传时由 :func:`_resolve_manifest_root` 决议
    - ``use_cache``     — ``False`` 时强制重新扫描（绕过缓存，测试用）

    返回：``frozenset[str]``，至少包含 ``KNOWN_BINARIES`` 全部元素。

    扫描失败 / 不可读 → fallback 到 ``KNOWN_BINARIES`` 单独，**绝不抛异常**
    （避免拖垮 ``CliInvocationParser.parse``，让 CLI 治理路径整个挂掉）。
    """
    global _known_binaries_cache

    # 显式 root 总是绕过缓存（测试用），保证测试相互隔离。
    if manifest_root is not None:
        scanned = _scan_manifest_binaries(manifest_root)
        return frozenset(KNOWN_BINARIES | scanned)

    if use_cache and _known_binaries_cache is not None:
        return _known_binaries_cache

    with _known_binaries_cache_lock:
        if use_cache and _known_binaries_cache is not None:
            return _known_binaries_cache
        root = _resolve_manifest_root()
        scanned = _scan_manifest_binaries(root)
        merged = frozenset(KNOWN_BINARIES | scanned)
        if use_cache:
            _known_binaries_cache = merged
        return merged


def invalidate_known_binaries_cache() -> None:
    """主动清理 :func:`compute_known_binaries` 的进程缓存。

    使用场景：
    - 单元测试：测试间清理避免相互污染
    - 未来热更新：marketplace App 安装后调用本函数让下次 CLI 解析读到新 binary

    线程安全：使用与 ``compute_known_binaries`` 同一把锁。
    """
    global _known_binaries_cache
    with _known_binaries_cache_lock:
        _known_binaries_cache = None


__all__ = [
    "CliInvocationSpec",
    "compute_grammar_key",
    "RISK_SAFE",
    "RISK_REVIEW",
    "RISK_STRICT",
    "RISK_LEVELS",
    "DEFAULT_RISK_LEVEL",
    "KNOWN_BINARIES",
    "REDACTED_FLAGS",
    "compute_known_binaries",
    "invalidate_known_binaries_cache",
]
