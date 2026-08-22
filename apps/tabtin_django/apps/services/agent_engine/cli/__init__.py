"""CLI 治理层 — Wave A 启动包 A1（PRD-v3 §5.1）。

把"用户实际调用的命令字符串"解析成结构化的 ``CliInvocationSpec``（含 ``risk_level``），
供后续 PermissionRule（A3）与审计（A2）使用。

⚠️ **DORMANT 状态（2026-04-30）**：

本模块的 framework 完整、测试通过、接口稳定，但**当前主仓代码无生产调用方**：

- ``CliInvocationParser.parse`` / ``CliPermissionEngine.evaluate_cli_spec`` /
  ``emit_cli_audit_event`` / ``register_resolver`` 等关键入口在 ``chat_service`` /
  ``agent_runtime`` / ``tools/domains/`` 中**0 处 import**
- 飞书 lark-cli wrapper（曾经唯一的真实触发路径）已于 2026-04-30 整体撤除
- ``packages/apps/`` 目录下当前只有 ``tabtin-demo-app`` 一个 marketplace App

下一步决策（待 Tin 形态明确）：
1. 如果 Tin 接入沿用本套范式 → 把治理层 wire 到 ``chat_service`` 的 ``execute_in_terminal`` 路径
2. 如果 Tin 接入采用其他范式 → 撤掉本目录 + 配套 audit / migrations
3. 在决策前 framework 保持现状，避免被未来 Tin 形态绑架

详见 [`docs/prd-v4/02-legacy-debt-cleanup.md`](../../../../../../../docs/prd-v4/02-legacy-debt-cleanup.md) Part A。

模块组成：
- ``spec.py``    — ``CliInvocationSpec`` 数据类（调用态）
- ``parser.py``  — ``CliInvocationParser`` 解析框架 + ``wrap_as_cli_invocation_spec`` schema 桥接 helper
- ``rules.py``   — YAML 规则集加载与匹配
- ``cli_rules.yaml`` — 默认规则集（通配符默认策略：删除/归档触发 HITL，查询类直通等）

设计纪律（启动包 A1 范围）：
- ``CliInvocationParser`` **不依赖** Django models / 数据库；纯字符串解析器。
- ``wrap_as_cli_invocation_spec`` 不修改既有 ``CliCommandDescriptor`` 字段，向后兼容老 Extension（descriptor 上无 ``risk_level`` 时 fallback ``review``）。
- 解析失败 / 未知 binary 一律 fail-safe（review / strict），永不 ALLOW。
"""

from apps.services.agent_engine.cli.spec import (
    DEFAULT_RISK_LEVEL,
    KNOWN_BINARIES,
    REDACTED_FLAGS,
    RISK_LEVELS,
    RISK_REVIEW,
    RISK_SAFE,
    RISK_STRICT,
    CliInvocationSpec,
    compute_grammar_key,
    compute_known_binaries,
    invalidate_known_binaries_cache,
)
from apps.services.agent_engine.cli.parser import (
    CliInvocationParser,
    redact_sensitive_args,
    wrap_as_cli_invocation_spec,
)
from apps.services.agent_engine.cli.rules import (
    CliRule,
    CliRuleSet,
    load_default_rules,
    load_rules_from_file,
)

__all__ = [
    # spec
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
    # parser
    "CliInvocationParser",
    "wrap_as_cli_invocation_spec",
    "redact_sensitive_args",
    # rules
    "CliRule",
    "CliRuleSet",
    "load_default_rules",
    "load_rules_from_file",
]
