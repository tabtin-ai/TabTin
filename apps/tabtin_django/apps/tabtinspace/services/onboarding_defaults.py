"""新用户 / 默认 Space onboarding 文案。

暂时统一中文（产品拍板：默认名/默认目录先不跟 UI 语言走英文，
避免本机出现 ``Default Space`` / ``Default Workspace`` 目录）。
"""
from __future__ import annotations

from typing import Any, Dict, NamedTuple, Optional

from django.contrib.auth.models import AbstractBaseUser


class OnboardingDefaults(NamedTuple):
    agent_name: str
    space_name: str
    space_description: str


# 产品语言：个人执行现场统一叫 Workspace（见 principle/workspace-project.md）。
# 默认 Agent 身份名：与 Workspace 名刻意区分，避免「执行者 / 执行现场」混淆。
DEFAULT_ONBOARDING_AGENT_NAME = "小Tin"
# 历史 onboarding 名，迁移与展示本地化仍识别。
LEGACY_ONBOARDING_AGENT_NAME = "默认 Workspace 执行身份"
LEGACY_ONBOARDING_AGENT_NAME_WANNENG = "万能Tin"
LEGACY_SPACE_EXECUTION_AGENT_NAME = "默认 Space 执行身份"
LEGACY_DEFAULT_EXECUTION_AGENT_NAMES = frozenset({
    LEGACY_ONBOARDING_AGENT_NAME,
    LEGACY_SPACE_EXECUTION_AGENT_NAME,
})
DEFAULT_ONBOARDING_SPACE_NAME = "默认 Workspace"
DEFAULT_ONBOARDING_SPACE_DESCRIPTION = "自动创建的默认 Workspace"

# ：系统补建默认小Tin 的 provenance。Space 迁移 / 用户自建不得带此标记。
SYSTEM_DEFAULT_PROVISION_SOURCE = "system_default"
AGENT_SETTINGS_PROVISION_SOURCE_KEY = "provision_source"

# ：默认小Tin承担首发阵容中的「日常」角色，另外四个角色从模板补建。
# 版本标记落在默认 Agent.settings，既能让存量用户在首次进入时收到阵容，
# 又能尊重用户之后对任一首发分身的停用决定（不自动补回来）。
# v2：为五个首发角色补齐简短 initial_rules；仅填空值，不覆盖用户编辑。
# v3：为存量「小Tin 代码版」补齐经审计的通用工程 Skill 基线；只补缺失行，
# 不重新打开用户已经关闭的 Skill，也不把工程 Skill 扩散给其他角色。
# v4：增加通用问题跟踪工作流；表 ID 与仓库交付规则保持运行时解析。
# v5：从代码版默认集移除四个偏评审/门禁类 Skill；市场内容仍可主动安装。
# v6：继续移除「完成前验收」；市场内容仍可主动安装。
# v7：增加固定到 v4.9.0 的 Ponytail 核心编码 Skill，不引入其生命周期 Hook。
# v8：按 AI 分身交接配置补齐四个核心分身的模板 Skill，并强制保持启用。
# v9：开源不再提供远程文书/数据 AI pack，存量核心分身卸掉对应空引用。
STARTER_AGENT_ROSTER_VERSION = 9
AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY = "starter_roster_version"
STARTER_AGENT_TEMPLATE_IDS = (
    "general-assistant",
    "code-engineer",
    "doc-writer",
    "data-analyst",
    "web-researcher",
)

# 交接包定义的四个核心分身。其模板 Skill 是角色能力基线：创建时默认携带，
# 存量升级时补齐并重开，运行期不可关闭或摘除。其它模板仍保持用户可配置。
LOCKED_TEMPLATE_SKILL_AGENT_IDS = frozenset({
    "general-assistant",
    "code-engineer",
    "doc-writer",
    "data-analyst",
})

# v3 一次性存量补齐清单。这里刻意保存升级快照，而不是运行时读取模板当前值：
# Agent 模板仍遵循「实例化即冻结」，未来模板继续演进时不会悄悄改动存量分身。
CODE_ENGINEER_STARTER_SKILL_KEYS_V3 = (
    "app:tabtin-workflow-skills-pack/grill-before-build",
    "app:tabtin-workflow-skills-pack/write-execution-plan",
    "app:tabtin-engineering-discipline-pack/tdd-vertical-slice",
    "app:tabtin-workflow-skills-pack/session-handoff",
)

CODE_ENGINEER_STARTER_SKILL_KEYS_V4 = (
    "app:tabtin-engineering-discipline-pack/issue-tracker-workflow",
)

CODE_ENGINEER_STARTER_SKILL_KEYS_V7 = (
    "app:ponytail/ponytail",
)

# v3-v5 仅存在于本轮尚未发布的开发现场。这个窄范围纠偏让已经试用过上一版的
# 本地代码版同步回到新默认；正式环境仍停在 v2，不会误删历史手动安装项。
CODE_ENGINEER_REMOVED_DEFAULT_SKILL_KEYS_V6 = (
    "app:tabtin-engineering-discipline-pack/parallel-review-pass",
    "app:tabtin-engineering-discipline-pack/pr-ready-checklist",
    "app:tabtin-engineering-discipline-pack/ci-failure-triage",
    "app:tabtin-engineering-discipline-pack/surgical-changes",
    "app:tabtin-workflow-skills-pack/verify-before-done",
)

CODE_ENGINEER_STARTER_SKILL_KEYS = (
    CODE_ENGINEER_STARTER_SKILL_KEYS_V3
    + CODE_ENGINEER_STARTER_SKILL_KEYS_V4
    + CODE_ENGINEER_STARTER_SKILL_KEYS_V7
)

# 远程 Bundle 已下线。这些 key 只存在于旧模板/旧携带行，本机没有 bundled 源，
# 继续挂着会留下空引用，并在首轮 reconcile 打 materialize warn。
OSS_STARTER_SKILL_KEYS_TO_UNASSIGN = (
    "app:tabtin-document-ai-pack/ppt-master",
    "app:tabtin-document-ai-pack/document-production",
    "app:tabtin-document-ai-pack/professional-editorial-review",
    "app:tabtin-data-ai-pack/table-data-production",
    "app:tabtin-data-ai-pack/data-analysis-visualization",
    "app:tabtin-data-ai-pack/web-data-collection",
)


def build_system_default_agent_settings(
    base: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """写入系统默认 Agent 的 settings 标记。"""
    settings = dict(base or {})
    settings[AGENT_SETTINGS_PROVISION_SOURCE_KEY] = SYSTEM_DEFAULT_PROVISION_SOURCE
    return settings


def is_system_default_agent(agent) -> bool:
    """是否为系统补建的默认小Tin（非 Space 迁移 / 非用户自建）。"""
    if agent is None:
        return False
    settings = getattr(agent, "settings", None) or {}
    if not isinstance(settings, dict):
        return False
    return settings.get(AGENT_SETTINGS_PROVISION_SOURCE_KEY) == SYSTEM_DEFAULT_PROVISION_SOURCE


def strip_reserved_provision_source(
    settings: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """用户创建 / 模板实例化路径不得携带系统默认 provenance。"""
    cleaned = dict(settings or {})
    cleaned.pop(AGENT_SETTINGS_PROVISION_SOURCE_KEY, None)
    return cleaned

_ZH_DEFAULTS = OnboardingDefaults(
    agent_name=DEFAULT_ONBOARDING_AGENT_NAME,
    space_name=DEFAULT_ONBOARDING_SPACE_NAME,
    space_description=DEFAULT_ONBOARDING_SPACE_DESCRIPTION,
)


def resolve_onboarding_defaults(
    user: Optional[AbstractBaseUser] = None,
    *,
    request=None,
) -> OnboardingDefaults:
    """返回 onboarding 默认名称（当前固定中文）。"""
    del user, request  # 保留签名，便于日后按语言恢复分支
    return _ZH_DEFAULTS
