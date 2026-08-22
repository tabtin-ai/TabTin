"""``CliInvocationParser`` — 把 CLI 命令字符串解析为 ``CliInvocationSpec``（PRD-v3 §5.1）。

解析 lifecycle（PRD §5.1 第 2 项）：
1. 词法切分（``shlex``，支持引号包裹的参数）
2. 识别 ``binary`` —— 不在 ``KNOWN_BINARIES`` → ``risk_level=strict``，立即返回
3. 识别 ``domain`` / ``verb`` —— 缺失 / 解析异常 → ``risk_level=review``（fail-safe）
4. 提取 ``resource``（typed URI，如 ``doc:doc_abc123`` / ``table:tbl_xyz``）
5. PII 脱敏 ``raw_args``（``REDACTED_FLAGS`` 命中的 value 替换为 hash 摘要）
6. 查 ``CliRuleSet`` 决定 ``risk_level``

A1 范围（不含）：
- 不读 manifest ``cliGrammar``（marketplace App H1 不强制填，B6 demo 完成后再接入）
- 不读 ``CliCommandDescriptor`` 注册表查询（A3 接入 ``ToolHub`` 时再实现 lifecycle ②）
- 不做 ``resource_label`` 解析（由具体 marketplace App resolver 注入，见 ``cli/resource_label.py``）
"""

from __future__ import annotations

import hashlib
import logging
import shlex
from typing import TYPE_CHECKING, Any, Iterable, List, Optional, Sequence, Tuple

from apps.services.agent_engine.cli.rules import CliRule, CliRuleSet, load_default_rules
from apps.services.agent_engine.cli.spec import (
    DEFAULT_RISK_LEVEL,
    KNOWN_BINARIES,
    REDACTED_FLAGS,
    RISK_REVIEW,
    RISK_STRICT,
    CliInvocationSpec,
    compute_grammar_key,
    compute_known_binaries,
)
from apps.services.agent_engine.cli.tabtin_command_risk import (
    lookup_tabtin_command_risk,
)

if TYPE_CHECKING:
    # 只在类型检查阶段需要；运行时 import 会触发 channel_gateway.models 的 Django app load,
    # 让本模块无法在 `python -c` 形式 smoke test 中使用（Django apps not ready）。
    # wrap_as_cli_invocation_spec 实际只读 descriptor 的鸭子类型字段，不需要类符合 isinstance。
    from apps.extensions.base import CliCommandDescriptor

logger = logging.getLogger(__name__)


_TYPED_RESOURCE_PREFIXES: Tuple[str, ...] = (
    "doc_",  # 严格 doc_ 前缀；不接受 "doc"（避免 doctor/document/docker 误判）
    "tbl_",  # 严格 tbl_ 前缀
)
"""通用 typed resource id 前缀。具体 marketplace App 可通过 manifest cliGrammar
扩展自身的 ID 前缀（B6 demo 完成后接入），本基线只保留跨 App 共用的 ``doc_`` /
``tbl_`` 两类（避免 doctor/document 等英文单词误判）。"""


_RESOURCE_FLAGS = {
    "--user": "user",
    "--user-id": "user",
    "--doc": "doc",
    "--doc-id": "doc",
    "--table": "table",
    "--table-id": "table",
}
"""通用 resource flag → kind 映射。具体 marketplace App 通过 manifest cliGrammar
扩展自身 flag（如域专属的 ID 参数），本基线只保留
跨 App 共用的几个。"""


def _redact_value(value: str) -> str:
    """PII 脱敏：保留长度 + sha256 前 8 位（PRD §5.1 第 5 项）。"""
    if value == "":
        return "<redacted len=0 hash=00000000>"
    digest = hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:8]
    return f"<redacted len={len(value)} hash={digest}>"


def _split_flag(token: str) -> Tuple[str, Optional[str]]:
    """把 ``--flag=value`` 拆成 ``("--flag", "value")``；纯 flag 则 value 为 None。"""
    if "=" in token and token.startswith("--"):
        flag, _, value = token.partition("=")
        return flag, value
    return token, None


def redact_sensitive_args(argv: Sequence[str]) -> List[str]:
    """对 ``argv`` 中命中 ``REDACTED_FLAGS`` 的 value 做 PII 脱敏。

    支持两种形式：
    - ``--text=hello world`` → ``--text=<redacted len=11 hash=2e7d2c03>``
    - ``--text hello`` → ``--text <redacted len=5 hash=...>``

    短选项（``-t``）映射依赖 manifest cliGrammar 提供的 alias 表，A1 暂不实现，列入交付报告。
    """
    out: List[str] = []
    i = 0
    n = len(argv)
    while i < n:
        token = argv[i]
        flag, inline_value = _split_flag(token)
        if flag in REDACTED_FLAGS:
            if inline_value is not None:
                out.append(f"{flag}={_redact_value(inline_value)}")
                i += 1
                continue
            # `--flag value` 形式：脱敏下一个 token；下个 token 是另一个 flag 时跳过
            if i + 1 < n and not argv[i + 1].startswith("-"):
                out.append(flag)
                out.append(_redact_value(argv[i + 1]))
                i += 2
                continue
            out.append(flag)
            i += 1
            continue
        out.append(token)
        i += 1
    return out


def _looks_like_resource_id(value: str) -> bool:
    """启发式判断 value 是否是 typed resource id（基线含通用前缀）。"""
    if not value:
        return False
    return any(value.startswith(p) for p in _TYPED_RESOURCE_PREFIXES)


def _extract_resource(argv: Sequence[str]) -> Optional[str]:
    """从 argv 中提取首个 typed resource，形如 ``doc:doc_abc123`` / ``table:tbl_xyz``。

    优先级：
    1. ``_RESOURCE_FLAGS`` 命中的显式参数
    2. fallback：扫描所有 value，遇到看起来像 typed id 的（``doc_`` / ``tbl_`` 等前缀）也接受

    A1 不解析 ``--target=user:abc`` 这种已 typed 的参数（避免误判）；
    label 解析（如把 chat id 转成"产品三群"）由 A4 HITL UI 接入时再做。
    """
    i = 0
    n = len(argv)
    while i < n:
        token = argv[i]
        flag, inline_value = _split_flag(token)
        kind = _RESOURCE_FLAGS.get(flag)
        if kind:
            value: Optional[str] = inline_value
            if value is None and i + 1 < n and not argv[i + 1].startswith("-"):
                value = argv[i + 1]
            if value:
                return f"{kind}:{value}"
        i += 1

    # fallback：扫一遍裸 value，挑首个匹配 typed 前缀的
    for token in argv:
        _, inline_value = _split_flag(token)
        candidate = inline_value if inline_value is not None else token
        if candidate.startswith("--"):
            continue
        if _looks_like_resource_id(candidate):
            kind = (
                "doc" if candidate.startswith("doc_")
                else "table" if candidate.startswith("tbl_")
                else "resource"
            )
            return f"{kind}:{candidate}"
    return None


class CliInvocationParser:
    """将 CLI 命令字符串解析为 ``CliInvocationSpec``。

    线程安全：解析过程中不修改实例状态，规则集是不可变 frozen dataclass。
    """

    def __init__(self, rules: Optional[CliRuleSet] = None) -> None:
        self._rules: CliRuleSet = rules or load_default_rules()

    @property
    def rules(self) -> CliRuleSet:
        return self._rules

    def parse(self, command: str) -> CliInvocationSpec:
        """主入口。永远返回一个 ``CliInvocationSpec``，不抛异常。

        异常路径（fail-safe）：
        - 词法切分失败 / 空字符串 → ``binary="<unparsed>"``，``risk_level=review``
          ``raw_args`` **不存原文**，仅存 ``"<unparsed: reason=... length=N>"`` 占位符
          （消化 A1 三视角 Review P0-2：unparsed 路径 PII 泄露问题）
        - binary 不在 ``KNOWN_BINARIES`` → ``risk_level=strict``
        - binary 已知但缺 domain / verb → ``risk_level=review``
        """
        cmd_str = command or ""
        try:
            tokens = shlex.split(cmd_str, comments=False, posix=True)
        except ValueError as exc:
            # 不打印 command 原文（可能含密码 / token，A1 P0-2 修复）
            logger.warning(
                "[CliInvocationParser] shlex split failed: %s (command_length=%d)",
                exc,
                len(cmd_str),
            )
            return self._build_unparsed_spec(cmd_str, reason=f"shlex_error:{type(exc).__name__}")

        if not tokens:
            return self._build_unparsed_spec(cmd_str, reason="empty_command")

        binary = tokens[0]
        # A1-L4 收口（A5 启动包）：白名单 = KNOWN_BINARIES ∪ manifest 中所有 cli.binary。
        # ``compute_known_binaries`` 内部带进程缓存 + fail-safe（扫描失败时回退 KNOWN_BINARIES）。
        if binary not in compute_known_binaries():
            return self._build_unknown_binary_spec(binary, tokens[1:])

        rest = tokens[1:]
        if len(rest) < 2:
            # 缺 domain / verb：fail-safe review，但仍带规则匹配信息便于审计
            placeholder_domain = rest[0] if rest else "<missing>"
            return CliInvocationSpec(
                binary=binary,
                domain=placeholder_domain,
                verb="<missing>",
                resource=None,
                resource_label=None,
                raw_args=redact_sensitive_args(rest),
                risk_level=RISK_REVIEW,
                matched_rule_pattern="",
                matched_rule_reason="incomplete command (missing domain/verb), fail-safe to review",
            )

        domain = rest[0]
        verb = rest[1]
        args = rest[2:]
        resource = _extract_resource(args)
        redacted = redact_sensitive_args(args)

        # ：tabtin 自家命令的风险档以 Go ``CommandDef.Risk`` 为 SSoT——
        # 优先查 ``tabtin commands --format json`` 的生成表（逐命令精确登记、
        # 注册期强制声明），命中即用；未登记（新命令未复跑 codegen / 版本错位）
        # 或表不可用时 fallback 到下方 yaml 模式匹配，行为与接入前一致。
        if binary == "tabtin":
            ssot_hit = lookup_tabtin_command_risk(rest)
            if ssot_hit is not None:
                ssot_risk, ssot_path = ssot_hit
                return CliInvocationSpec(
                    binary=binary,
                    domain=domain,
                    verb=verb,
                    resource=resource,
                    resource_label=None,
                    raw_args=redacted,
                    risk_level=ssot_risk,
                    matched_rule_pattern=f"tabtin-commands:{ssot_path}",
                    matched_rule_reason=(
                        "Go CommandDef.Risk SSoT (tabtin_command_risk.generated.json)"
                    ),
                )

        # 用统一的 grammar_key 公式（``<domain>.<verb>`` 二段），消化 A1 Review P0-1
        grammar_key = compute_grammar_key(binary, domain, verb)
        rule = self._rules.match(grammar_key)
        return CliInvocationSpec(
            binary=binary,
            domain=domain,
            verb=verb,
            resource=resource,
            resource_label=None,
            raw_args=redacted,
            risk_level=rule.risk_level,
            matched_rule_pattern=rule.pattern,
            matched_rule_reason=rule.reason,
        )

    def _build_unparsed_spec(self, command: str, reason: str) -> CliInvocationSpec:
        # 不写入 command 原文：原文可能包含 --password=... / --text=... 等 PII，
        # 而本路径根本没解析过、没机会按 flag 脱敏（消化 A1 Review P0-2）。
        # 仅留 length 与 reason，便于审计排错而无 PII 泄露面。
        placeholder = f"<unparsed: reason={reason} length={len(command)}>"
        return CliInvocationSpec(
            binary="<unparsed>",
            domain="<unparsed>",
            verb=reason,
            resource=None,
            resource_label=None,
            raw_args=[placeholder] if command else [],
            risk_level=DEFAULT_RISK_LEVEL,
            matched_rule_pattern="",
            matched_rule_reason=f"parse failed: {reason}, fail-safe to {DEFAULT_RISK_LEVEL}",
        )

    def _build_unknown_binary_spec(
        self, binary: str, rest: Iterable[str]
    ) -> CliInvocationSpec:
        rest_list = list(rest)
        return CliInvocationSpec(
            binary=binary,
            domain=rest_list[0] if rest_list else "<unknown>",
            verb=rest_list[1] if len(rest_list) > 1 else "<unknown>",
            resource=None,
            resource_label=None,
            raw_args=redact_sensitive_args(rest_list),
            risk_level=RISK_STRICT,
            matched_rule_pattern="",
            matched_rule_reason=f"binary {binary!r} not in KNOWN_BINARIES, fail-close to strict",
        )


# ---------------------------------------------------------------------------
# Schema 桥接 helper（PRD §5.1 第 2 项 schema 桥接约定）
# ---------------------------------------------------------------------------

def wrap_as_cli_invocation_spec(
    extension_id: str,
    descriptor: Any,
    raw_args: Optional[Sequence[str]] = None,
    parsed_resource: Optional[str] = None,
    resource_label: Optional[str] = None,
    redact: bool = True,
) -> CliInvocationSpec:
    """把 Extension 的 ``CliCommandDescriptor`` 适配为运行时 ``CliInvocationSpec``。

    PRD §5.1 第 2 项 "Schema 桥接约定"：

    - ``extension_id → domain`` 隐式映射（``BaseExtension.id`` 即作为 ``domain``）
    - ``descriptor.name`` → ``verb``
    - ``descriptor.risk_level``（向后兼容字段，老 Extension 不填即 ``None``）
      → ``CliInvocationSpec.risk_level``；缺失时 fallback 到 ``review``
      （与 PRD §5.1 第 3 项默认策略表第 7 行 = "其他 → review" 兜底一致）

    **鸭子类型契约**：``descriptor`` 形参的类型注解写为 ``Any``，目的是避免在模块级别 import
    ``apps.extensions.base.CliCommandDescriptor``——后者会传染性地触发
    ``apps.channel_gateway.models`` 的 Django Model 加载，让本 helper 无法在
    ``python -c`` 形式的 smoke test 或非 Django 环境（CLI binary、纯 worker）中使用。
    实际只读 ``descriptor.name`` 与可选的 ``descriptor.risk_level``，duck-typed。

    本 helper 不依赖 ``apps.services.agent_engine.cli.rules``，纯静态适配。
    A3 接入 ``PermissionRuleEngine`` 时，会在调用方先 ``parse(...)`` 再用本 helper 兜底
    （或反向：先用本 helper 拿默认 risk_level，再用 ``parse`` 覆盖动态参数）；具体集成顺序由 A3 决策。

    参数：
    - ``extension_id``    — 必填，``BaseExtension.id``，作为 ``domain``
    - ``descriptor``      — 必填，Extension 注册的 CLI 子命令 schema
                          （``CliCommandDescriptor`` 或任何含 ``.name`` / 可选 ``.risk_level`` 字段的对象）
    - ``raw_args``        — 可选，调用现场的 argv
    - ``parsed_resource`` — 可选，已解析的 typed URI（如 ``table:tbl_abc123``）
    - ``resource_label``  — 可选，HITL UI 显示用的人类可读名
    - ``redact``          — 默认 ``True``：本 helper 内部对 ``raw_args`` 调用 ``redact_sensitive_args``。
                          仅当调用方**已经**完成脱敏（如 ``parser.parse(...)`` 的输出再二次包装）时才设为 ``False``。
                          消化 A1 三视角 Review P1：避免调用方传入未脱敏 argv 进入审计的 footgun。

    返回：``CliInvocationSpec``。任何字段缺失时抛 ``ValueError``（spec ``__post_init__`` 校验）。
    """
    if not extension_id:
        raise ValueError("extension_id is required for wrap_as_cli_invocation_spec")
    if descriptor is None:
        raise ValueError("descriptor is required for wrap_as_cli_invocation_spec")
    if not getattr(descriptor, "name", ""):
        raise ValueError("descriptor.name must not be empty")

    risk_level = getattr(descriptor, "risk_level", None) or RISK_REVIEW

    args_list = list(raw_args or [])
    if redact:
        args_list = redact_sensitive_args(args_list)

    return CliInvocationSpec(
        binary="tabtin",
        domain=extension_id,
        verb=descriptor.name,
        resource=parsed_resource,
        resource_label=resource_label,
        raw_args=args_list,
        risk_level=risk_level,
    )


__all__ = [
    "CliInvocationParser",
    "wrap_as_cli_invocation_spec",
    "redact_sensitive_args",
]
