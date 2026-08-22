"""默认 Agent 平台 / 已装 App skill 自动携带。

产品口径：
- 仅针对必须存在的默认能力基线 Agent，不改自建分身
- 创建 / 复活 / 活跃纠偏 / 提升为默认时：挂上全部 platform + 组织已装**内置** App 的 skill，并启用
- ``distribution=marketplace`` 推荐 pack 不进 seed / repair 期望集（用户自选携带，可关可收）
- attach 幂等：补齐缺失、重开曾关掉的锁定项；不删除用户自建携带
- 组织新装内置 App 时：将该 App 的 skill 挂到组织内所有活跃默认能力基线 Agent 并启用
- 默认 Agent 上 platform / 内置 app skill 不可关闭或收回（见 AgentSkillLinkWriter）
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Iterable, Optional, TypeVar
from uuid import UUID

from apps.skills.services.agent_link_writer import (
    MARKETPLACE_APP_DISTRIBUTION,
    AgentSkillLinkWriter,
    AgentSkillLinkWriterError,
)
from apps.tabtinspace.services.onboarding_defaults import (
    LEGACY_DEFAULT_EXECUTION_AGENT_NAMES,
)

logger = logging.getLogger("skills.default_agent_skill_seed")

T = TypeVar("T")


def _user_id(user) -> Optional[UUID]:
    if user is None:
        return None
    raw = getattr(user, "id", user)
    try:
        return UUID(str(raw))
    except (TypeError, ValueError):
        return None


def run_default_agent_skill_seed_safe(
    action: Callable[[], T],
    *,
    event: str,
    **fields: Any,
) -> Optional[T]:
    """接线侧统一软失败：种子异常不阻断建组织 / 装 App / ensure_default。"""
    try:
        return action()
    except Exception as exc:  # noqa: BLE001 — 接线侧失败不阻断主流程
        extras = " ".join(f"{key}={value}" for key, value in fields.items())
        logger.warning(
            "%s %s error=%s",
            event,
            extras,
            exc,
            exc_info=True,
        )
        return None


def iter_platform_skill_keys() -> list[str]:
    from apps.skills.services.registry_service import SkillsRegistryService

    keys: list[str] = []
    for entry in SkillsRegistryService.list_platform_skills():
        if not isinstance(entry, dict):
            continue
        key = (entry.get("skill_key") or "").strip()
        if key:
            keys.append(key)
    return keys


def iter_app_skill_keys(
    *,
    app_ids: Optional[set[str]] = None,
    include_marketplace: bool = False,
) -> list[str]:
    """列出 app skill keys；``app_ids`` 非空时只保留这些 App。

    默认排除 ``distribution=marketplace``，与  锁定集 / need_repair 同口径：
    推荐 pack 不进默认分身 seed，避免用户关掉后被 ensure/repair 重新打开。
    """
    from apps.skills.services.registry_service import SkillsRegistryService

    keys: list[str] = []
    for entry in SkillsRegistryService.list_app_skills():
        if not isinstance(entry, dict):
            continue
        app_id = (entry.get("app_id") or "").strip()
        if app_ids is not None and app_id not in app_ids:
            continue
        dist = (entry.get("distribution") or "").strip()
        if not include_marketplace and dist == MARKETPLACE_APP_DISTRIBUTION:
            continue
        key = (entry.get("skill_key") or "").strip()
        if key:
            keys.append(key)
    return keys


def _attach_keys(
    *,
    agent_id: UUID,
    organization_id,
    requesting_user_id: UUID,
    skill_keys: Iterable[str],
) -> dict[str, Any]:
    attached = 0
    skipped = 0
    errors: list[str] = []
    for key in dict.fromkeys(skill_keys):
        try:
            AgentSkillLinkWriter.attach(
                agent_id=agent_id,
                organization_id=organization_id,
                requesting_user_id=requesting_user_id,
                skill_canonical_key=key,
                sync_space_id=None,
            )
            attached += 1
        except AgentSkillLinkWriterError as exc:
            skipped += 1
            errors.append(f"{key}: {exc}")
            logger.warning(
                "default_agent_skill_seed.attach_failed agent=%s skill=%s err=%s",
                agent_id,
                key,
                exc,
            )
        except Exception as exc:  # noqa: BLE001 — 单 key 失败不阻断整批
            skipped += 1
            errors.append(f"{key}: {exc}")
            logger.warning(
                "default_agent_skill_seed.attach_unexpected agent=%s skill=%s",
                agent_id,
                key,
                exc_info=True,
            )
    return {"attached": attached, "skipped": skipped, "errors": errors}


def is_default_skill_baseline_agent(agent) -> bool:
    """是否应拥有默认 platform + 内置 App skill 基线。

    新默认小Tin用 ``is_default`` 标识；#10928 兼容 0075 迁移遗留的
    「默认 Space 执行身份」，否则历史用户选中该身份时 prompt skill 段会只剩空壳。
    """
    if agent is None:
        return False
    if getattr(agent, "is_default", False):
        return True

    name = (getattr(agent, "name", "") or "").strip()
    agent_type = (getattr(agent, "type", "") or "").strip()
    template_id = (getattr(agent, "template_id", "") or "").strip()
    return (
        agent_type == "bot"
        and not template_id
        and name in LEGACY_DEFAULT_EXECUTION_AGENT_NAMES
    )


def _expected_default_skill_keys(agent) -> list[str]:
    from apps.tabtinspace.services.app_catalog_service import OrganizationAppCatalogService

    installed = OrganizationAppCatalogService.get_installed_app_ids(agent.organization_id)
    return iter_platform_skill_keys() + iter_app_skill_keys(app_ids=installed)


def default_agent_skills_need_repair(agent) -> bool:
    """活跃默认热路径用的廉价探测：有禁用锁定行，或期望 skill 未全部 enabled 挂上。

    用集合包含判断，不用「数量相等」——否则会出现「缺新 skill + 多一个孤儿
    旧 skill」时 need_repair=False、热路径永不补挂。
    """
    from apps.skills.models import AgentSkillLink
    from apps.skills.services.agent_link_writer import AgentSkillLinkWriter

    if not is_default_skill_baseline_agent(agent):
        return False
    locked_q = AgentSkillLinkWriter.default_locked_links_q()
    if AgentSkillLink.objects.filter(
        agent_id=agent.id,
        enabled=False,
    ).filter(locked_q).exists():
        return True
    expected_keys = set(_expected_default_skill_keys(agent))
    if not expected_keys:
        return False
    actual_keys = set(
        AgentSkillLink.objects.filter(agent_id=agent.id, enabled=True)
        .filter(locked_q)
        .values_list("skill_canonical_key", flat=True)
    )
    return not expected_keys.issubset(actual_keys)


def seed_default_agent_skills(agent, user) -> dict[str, Any]:
    """为单个默认能力基线 Agent 灌入全部 platform + 组织已装 App skill（幂等）。"""
    if not is_default_skill_baseline_agent(agent):
        return {
            "attached": 0,
            "skipped": 0,
            "errors": ["not_default_skill_baseline_agent"],
        }

    uid = _user_id(user) or _user_id(getattr(agent, "owner_user_id", None))
    if uid is None:
        logger.warning(
            "default_agent_skill_seed.no_user agent=%s",
            getattr(agent, "id", None),
        )
        return {"attached": 0, "skipped": 0, "errors": ["no_user"]}

    organization_id = agent.organization_id
    keys = _expected_default_skill_keys(agent)
    result = _attach_keys(
        agent_id=agent.id,
        organization_id=organization_id,
        requesting_user_id=uid,
        skill_keys=keys,
    )
    logger.info(
        "default_agent_skill_seed.seeded agent=%s org=%s attached=%s skipped=%s",
        agent.id,
        organization_id,
        result["attached"],
        result["skipped"],
    )
    return result


def repair_default_agent_skills_if_needed(agent, user) -> dict[str, Any]:
    """仅在探测到缺口/脏数据时全量 seed，避免 ensure 热路径每次写库。"""
    if not default_agent_skills_need_repair(agent):
        return {"attached": 0, "skipped": 0, "errors": [], "repaired": False}
    result = seed_default_agent_skills(agent, user)
    result["repaired"] = True
    return result


def attach_app_skills_to_org_default_agents(
    *,
    organization_id,
    app_id: str,
    user,
) -> dict[str, Any]:
    """组织新装 App 后：挂到该组织全部活跃默认能力基线 Agent。"""
    from django.db.models import Q

    from apps.agent.models import Agent

    app_id = (app_id or "").strip()
    if not app_id:
        return {"agents": 0, "attached": 0, "skipped": 0, "errors": ["empty_app_id"]}

    uid = _user_id(user)
    skill_keys = iter_app_skill_keys(app_ids={app_id})
    if not skill_keys:
        return {"agents": 0, "attached": 0, "skipped": 0, "errors": [], "skill_keys": []}

    baseline_q = Q(is_default=True) | Q(
        type="bot",
        template_id="",
        name__in=LEGACY_DEFAULT_EXECUTION_AGENT_NAMES,
    )
    defaults = list(
        Agent.objects.filter(
            organization_id=organization_id,
            is_active=True,
        )
        .filter(baseline_q)
        .only(
            "id",
            "organization_id",
            "owner_user_id",
            "is_default",
            "name",
            "type",
            "template_id",
        )
    )
    total_attached = 0
    total_skipped = 0
    errors: list[str] = []
    for agent in defaults:
        request_uid = uid or _user_id(agent.owner_user_id)
        if request_uid is None:
            total_skipped += 1
            errors.append(f"agent={agent.id}: no_user")
            continue
        result = _attach_keys(
            agent_id=agent.id,
            organization_id=organization_id,
            requesting_user_id=request_uid,
            skill_keys=skill_keys,
        )
        total_attached += result["attached"]
        total_skipped += result["skipped"]
        errors.extend(result["errors"])

    logger.info(
        "default_agent_skill_seed.app_installed org=%s app=%s agents=%s attached=%s",
        organization_id,
        app_id,
        len(defaults),
        total_attached,
    )
    return {
        "agents": len(defaults),
        "attached": total_attached,
        "skipped": total_skipped,
        "errors": errors,
        "skill_keys": skill_keys,
    }
