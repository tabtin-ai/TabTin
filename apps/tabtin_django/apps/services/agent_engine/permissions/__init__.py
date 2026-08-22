"""
Multiagent 权限规则引擎。

将 HITL 从 tool 级别二元开关升级为 allow/ask/deny × once/session/always 矩阵。
支持 AI 分类器智能审批（S16）+ 安全硬底线（S17）。

A3 升级（PRD-v3 §5.1 第 3 项）：新增 ``cli_engine`` 模块，识别 ``CliInvocationSpec``
结构化 spec；与既有 ``PermissionRuleEngine.evaluate(tool_name, ...)`` **并行模式**共存。
"""

from apps.services.agent_engine.permissions.rule_engine import (
    PermissionAction,
    PermissionScope,
    PermissionRuleEngine,
)
from apps.services.agent_engine.permissions.ai_classifier import (
    ClassifierResult,
    evaluate_with_classifier,
    try_uplift_safe_to_review,
)
from apps.services.agent_engine.permissions.cli_engine import (
    CliPermissionEngine,
    Decision,
    get_default_engine,
    get_default_parser,
    merge_decisions,
    reset_default_singletons_for_testing,
)
from apps.services.common.authorization_policy import check_safety_hardline

__all__ = [
    "PermissionAction",
    "PermissionScope",
    "PermissionRuleEngine",
    "ClassifierResult",
    "evaluate_with_classifier",
    "try_uplift_safe_to_review",
    "CliPermissionEngine",
    "Decision",
    "get_default_engine",
    "get_default_parser",
    "merge_decisions",
    "reset_default_singletons_for_testing",
    "check_safety_hardline",
]
