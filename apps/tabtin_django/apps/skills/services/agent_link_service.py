"""AgentSkillLink 服务 — Agent 技能携带集（ B1.2 / ）。

职责：**携带集 CRUD**（给 ``/agents/{agent_id}/skills`` 携带 API 用）：
list / attach / detach / update。写入与可运行契约（发布版本、Subagent 同步、
credential 校验、config merge）委托 ``AgentSkillLinkWriter``，与 Skill 库
enable/disable/config 路径共用同一写入点。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from apps.skills.models import AgentSkillLink, Skill
from apps.skills.services.agent_link_writer import (
    AgentSkillLinkCredentialError,
    AgentSkillLinkLockedError as WriterSkillLockedError,
    AgentSkillLinkWriter,
    AgentSkillLinkWriterError,
    AgentSkillLinkWriterNotFoundError,
    DEFAULT_AGENT_SKILL_LOCKED_CODE,
)
from apps.skills.services.registry_service import (
    SOURCE_APP,
    SOURCE_PLATFORM,
    SOURCE_USER,
    SkillsRegistryService,
)


def skill_fallback_display_name(skill_canonical_key: str) -> str:
    """无 display_name 时只用 canonical key 末段，去掉 pack 前缀。"""
    remainder = (skill_canonical_key or "").split(":", 1)[-1]
    return remainder.rsplit("/", 1)[-1] or remainder

logger = logging.getLogger("skills.agent_link_service")


class AgentSkillLinkError(Exception):
    """携带集业务错误（400）。"""


class AgentSkillLinkNotFoundError(AgentSkillLinkError):
    """目标 skill / 携带行不存在（404）。"""


class AgentSkillLinkCredentialValidationError(AgentSkillLinkError):
    """credential 校验失败；携带 err_code 供 API 映射。"""

    def __init__(self, message: str, *, err_code: str):
        super().__init__(message)
        self.err_code = err_code


class AgentSkillLinkLockedError(AgentSkillLinkError):
    """默认 Agent 锁定 skill 不可停用 / 摘除。"""

    def __init__(
        self,
        message: str,
        *,
        err_code: str = DEFAULT_AGENT_SKILL_LOCKED_CODE,
    ):
        super().__init__(message)
        self.err_code = err_code


def _map_writer_error(exc: AgentSkillLinkWriterError) -> AgentSkillLinkError:
    if isinstance(exc, AgentSkillLinkWriterNotFoundError):
        return AgentSkillLinkNotFoundError(str(exc))
    if isinstance(exc, AgentSkillLinkCredentialError):
        return AgentSkillLinkCredentialValidationError(
            str(exc), err_code=exc.err_code,
        )
    if isinstance(exc, WriterSkillLockedError):
        return AgentSkillLinkLockedError(
            str(exc),
            err_code=getattr(exc, "code", DEFAULT_AGENT_SKILL_LOCKED_CODE),
        )
    return AgentSkillLinkError(str(exc))


def _is_link_locked_for_agent(agent, link) -> bool:
    """Agent Skill 锁定判定与统一 Writer 保持同一口径。"""
    cfg = getattr(link, "config_json", None) or {}
    distribution = cfg.get("distribution") if isinstance(cfg, dict) else None
    return AgentSkillLinkWriter.is_agent_skill_locked(
        agent=agent,
        skill_canonical_key=link.skill_canonical_key,
        source=getattr(link, "source", None),
        distribution=distribution,
    )


class AgentSkillLinkService:
    """Agent 携带集编排（读路径本地；写路径委托 Writer）。"""

    # ------------------------------------------------------------------
    # 携带集 CRUD
    # ------------------------------------------------------------------

    @classmethod
    def list_links(
        cls,
        agent,
        *,
        requesting_user_id: Optional[UUID] = None,
    ) -> List[Dict[str, Any]]:
        """列出 Agent 携带集；``enabled`` 为用户总闸 AND 子开关。

        总闸按请求用户（技能库归属）读取；缺省回退 Agent owner。
        """
        from apps.skills.services.user_preference_service import (
            UserSkillPreferenceService,
        )
        from apps.skills.services.default_agent_skill_seed import (
            repair_default_agent_skills_if_needed,
        )

        repair_default_agent_skills_if_needed(
            agent,
            requesting_user_id or getattr(agent, "owner_user_id", None),
        )

        links = list(
            AgentSkillLink.objects.filter(agent_id=agent.id).order_by("created_at")
        )
        meta_map = cls._build_metadata_map(links)
        preference_user_id = (
            requesting_user_id or getattr(agent, "owner_user_id", None)
        )
        user_gate = UserSkillPreferenceService.map_for_user(
            preference_user_id,
            [link.skill_canonical_key for link in links],
        )
        items = []
        for link in links:
            locked = _is_link_locked_for_agent(agent, link)
            # 历史脏数据：系统预置分身的锁定 Skill 若曾被关掉，读路径拨回启用。
            agent_enabled = bool(link.enabled)
            if locked and not agent_enabled:
                link.enabled = True
                link.save(update_fields=["enabled", "updated_at"])
                agent_enabled = True
            item = cls._serialize_link(link, meta_map)
            item["locked"] = locked
            # 锁定项注入强制开：忽略用户总闸（Electron enabledMap 也走本接口）
            if locked:
                item.update(
                    UserSkillPreferenceService.compose_enablement(
                        agent_enabled=True,
                        user_enabled=True,
                    )
                )
            else:
                item.update(
                    UserSkillPreferenceService.compose_enablement(
                        agent_enabled=agent_enabled,
                        user_enabled=UserSkillPreferenceService.resolve_from_map(
                            user_gate, link.skill_canonical_key,
                        ),
                    )
                )
            items.append(item)
        return items

    @classmethod
    def attach_skill(
        cls,
        agent,
        *,
        skill_canonical_key: str,
        requesting_user_id: UUID,
        space_id=None,
        device_agents: Optional[List[Dict[str, Any]]] = None,
        enabled: bool = True,
    ) -> Dict[str, Any]:
        """挂载 skill 到 Agent 携带集（与 Skill 库 enable 同一可运行契约）。"""
        sync_space_id = AgentSkillLinkWriter.resolve_sync_space_id(
            agent, space_id=space_id,
        )
        desired_enabled = bool(enabled)
        try:
            link = AgentSkillLinkWriter.attach(
                agent_id=agent.id,
                organization_id=agent.organization_id,
                requesting_user_id=requesting_user_id,
                skill_canonical_key=skill_canonical_key,
                sync_space_id=sync_space_id,
                device_agents=device_agents,
                enabled=desired_enabled,
            )
        except AgentSkillLinkWriterError as exc:
            raise _map_writer_error(exc) from exc

        # Agent 侧显式携带时同步打开用户总闸，否则最终注入永远为关。
        # 工作区目录 Skill 直接按 Agent 携带关系管理，不写用户总闸。
        from apps.skills.services.user_preference_service import (
            UserSkillPreferenceService,
        )

        is_workspace = (skill_canonical_key or "").startswith("workspace:")
        gate_user_id = requesting_user_id or getattr(agent, "owner_user_id", None)
        if gate_user_id and not is_workspace:
            UserSkillPreferenceService.set_enabled(
                user_id=gate_user_id,
                skill_canonical_key=skill_canonical_key,
                enabled=True,
            )

        meta_map = cls._build_metadata_map([link])
        item = cls._serialize_link(link, meta_map)
        item["locked"] = _is_link_locked_for_agent(agent, link)
        item.update(
            UserSkillPreferenceService.compose_enablement(
                agent_enabled=bool(link.enabled),
                user_enabled=True,
            )
        )
        item["agents_sync"] = getattr(
            link, "_agents_sync", {"status": "skipped", "synced": 0},
        )
        return item

    @classmethod
    def detach_skill(
        cls,
        agent,
        *,
        skill_canonical_key: str,
        space_id=None,
    ) -> bool:
        """摘除（删行）并清理 SubAgentTemplate。返回是否命中一行（幂等）。"""
        sync_space_id = AgentSkillLinkWriter.resolve_sync_space_id(
            agent, space_id=space_id,
        )
        try:
            return AgentSkillLinkWriter.detach(
                agent_id=agent.id,
                skill_canonical_key=skill_canonical_key,
                sync_space_id=sync_space_id,
            )
        except AgentSkillLinkWriterError as exc:
            raise _map_writer_error(exc) from exc

    @classmethod
    def update_link(
        cls,
        agent,
        *,
        skill_canonical_key: str,
        requesting_user_id: UUID,
        enabled: Optional[bool] = None,
        config_json: Optional[Dict[str, Any]] = None,
        space_id=None,
    ) -> Dict[str, Any]:
        """更新携带行：enabled 切换走 Subagent 副作用；config 走 merge + credential 校验。"""
        sync_space_id = AgentSkillLinkWriter.resolve_sync_space_id(
            agent, space_id=space_id,
        )
        try:
            if config_json is not None or enabled is not None:
                link = AgentSkillLinkWriter.merge_config(
                    agent_id=agent.id,
                    skill_canonical_key=skill_canonical_key,
                    requesting_user_id=requesting_user_id,
                    sync_space_id=sync_space_id,
                    enabled=enabled,
                    config_patch=config_json,
                )
            else:
                link = AgentSkillLink.objects.filter(
                    agent_id=agent.id,
                    skill_canonical_key=(skill_canonical_key or "").strip(),
                ).first()
                if link is None:
                    raise AgentSkillLinkWriterNotFoundError(
                        f"Agent 未携带该 skill: {skill_canonical_key}"
                    )
        except AgentSkillLinkWriterError as exc:
            raise _map_writer_error(exc) from exc

        meta_map = cls._build_metadata_map([link])
        item = cls._serialize_link(link, meta_map)
        locked = _is_link_locked_for_agent(agent, link)
        item["locked"] = locked
        from apps.skills.services.user_preference_service import (
            UserSkillPreferenceService,
        )

        preference_user_id = (
            requesting_user_id or getattr(agent, "owner_user_id", None)
        )
        if locked:
            item.update(
                UserSkillPreferenceService.compose_enablement(
                    agent_enabled=True,
                    user_enabled=True,
                )
            )
        else:
            item.update(
                UserSkillPreferenceService.compose_enablement(
                    agent_enabled=bool(link.enabled),
                    user_enabled=UserSkillPreferenceService.is_enabled(
                        preference_user_id, skill_canonical_key,
                    ),
                )
            )
        if hasattr(link, "_agents_sync"):
            item["agents_sync"] = link._agents_sync
        return item

    # ------------------------------------------------------------------
    # space → agent 解析（skill 面板旧 API 形状仍以 space_id 为入参）
    # ------------------------------------------------------------------

    @staticmethod
    def resolve_workspace_agent_id(space_id) -> Optional[UUID]:
        """解析 space → agent（：经最近会话；无会话返回 None）。"""
        if not space_id:
            return None
        try:
            from apps.chat.conversation.models import ChatSession

            return (
                ChatSession.objects.filter(
                    workspace_id=space_id,
                    agent_id__isnull=False,
                )
                .order_by("-updated_at")
                .values_list("agent_id", flat=True)
                .first()
            )
        except Exception:
            logger.warning(
                "[AgentSkillLink] resolve space→agent failed: space=%s",
                space_id, exc_info=True,
            )
            return None

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    @classmethod
    def _build_metadata_map(
        cls, links: List[AgentSkillLink],
    ) -> Dict[str, Dict[str, Any]]:
        """构造 canonical_key → registry 元信息（name / description / emoji…）。"""
        meta: Dict[str, Dict[str, Any]] = {}
        if not links:
            return meta

        sources = {link.source for link in links}
        try:
            if SOURCE_PLATFORM in sources:
                for entry in SkillsRegistryService.list_platform_skills():
                    key = entry.get("skill_key")
                    if key:
                        meta[key] = entry
            if SOURCE_APP in sources:
                for entry in SkillsRegistryService.list_app_skills():
                    key = entry.get("skill_key")
                    if key:
                        meta[key] = entry
        except Exception:
            logger.debug(
                "[AgentSkillLink] registry metadata lookup failed", exc_info=True,
            )

        user_skill_ids = [
            link.skill_id for link in links
            if link.source == SOURCE_USER and link.skill_id
        ]
        if user_skill_ids:
            try:
                for skill in Skill.objects.filter(skill_id__in=user_skill_ids):
                    meta[skill.canonical_key] = skill.to_index_entry()
            except Exception:
                logger.debug(
                    "[AgentSkillLink] user skill metadata lookup failed",
                    exc_info=True,
                )
        return meta

    @staticmethod
    def _serialize_link(
        link: AgentSkillLink, meta_map: Dict[str, Dict[str, Any]],
    ) -> Dict[str, Any]:
        entry = meta_map.get(link.skill_canonical_key) or {}
        fallback_name = skill_fallback_display_name(link.skill_canonical_key)
        return {
            "skill_canonical_key": link.skill_canonical_key,
            "source": link.source,
            "skill_id": str(link.skill_id) if link.skill_id else None,
            "enabled": link.enabled,
            "config_json": dict(link.config_json or {}),
            "name": entry.get("display_name") or entry.get("name") or fallback_name,
            "description": entry.get("description") or "",
            "emoji": entry.get("emoji") or "",
            "created_at": link.created_at.isoformat() if link.created_at else None,
            "updated_at": link.updated_at.isoformat() if link.updated_at else None,
        }


__all__ = [
    "AgentSkillLinkService",
    "AgentSkillLinkError",
    "AgentSkillLinkNotFoundError",
    "AgentSkillLinkCredentialValidationError",
    "AgentSkillLinkLockedError",
    "skill_fallback_display_name",
]
