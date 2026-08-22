"""AgentSkillLink 统一写入 / 校验。

Agent 页 ``/api/agents/{id}/skills`` 与 Skill 库
``/api/skills/{key}/enable|disable|config`` 共用本 Writer，保证：

- organization 非 owner 启用须有已发布版本（与  对齐）
- attach / enable / disable / detach 同步或清理 SubAgentTemplate
- config 一律 merge（避免 silent wipe），含 credential ownership/status 校验
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from django.db import transaction
from django.db.models import Exists, OuterRef

from apps.skills.models import AgentSkillLink, Skill, SkillPublishedVersion
from apps.skills.services.registry_service import (
    SOURCE_APP,
    SOURCE_DEVICE,
    SOURCE_PLATFORM,
    SOURCE_USER,
    SOURCE_WORKSPACE,
    SkillsRegistryService,
    normalize_skill_source,
)

logger = logging.getLogger("skills.agent_link_writer")

UNPUBLISHED_SKILL_MESSAGE = "该 Skill 尚未发布版本，请让作者先发布后再启用"
DEFAULT_AGENT_SKILL_LOCKED_MESSAGE = "系统预置分身的默认 Skill 不可关闭或收回"
DEFAULT_AGENT_SKILL_LOCKED_CODE = "DEFAULT_AGENT_SKILL_LOCKED"
# 默认 Agent 上强制全开且不可关的 source。
# marketplace 推荐 pack 虽走 app: 前缀，但是用户从货架自选，不在锁定范围。
DEFAULT_AGENT_LOCKED_SOURCES = frozenset({SOURCE_PLATFORM, SOURCE_APP})
MARKETPLACE_APP_DISTRIBUTION = "marketplace"

CONFIG_KEY_CREDENTIAL_ID = "credential_id"
CONFIG_KEY_ENV = "env"
CONFIG_KEY_CONFIG = "config"

CREDENTIAL_ERROR_MESSAGES = {
    "CREDENTIAL_ID_INVALID_FORMAT": "credential_id 格式无效（需要 UUID）",
    "CREDENTIAL_NOT_FOUND": "凭据不存在或不属于当前用户",
    "CREDENTIAL_WRONG_CATEGORY": "凭据类型不是 api_key",
    "CREDENTIAL_INACTIVE": "凭据已停用，请先启用后再绑定",
    "CREDENTIAL_EXPIRED": "凭据已过期，请先续期后再绑定",
    "CREDENTIAL_DB_ERROR": "凭据校验暂时不可用，请稍后重试",
}


class AgentSkillLinkWriterError(Exception):
    """统一写入业务错误（400）。"""


class AgentSkillLinkWriterNotFoundError(AgentSkillLinkWriterError):
    """目标 skill / 携带行不存在（404）。"""


class AgentSkillLinkCredentialError(AgentSkillLinkWriterError):
    """credential 校验失败；携带 err_code 供 API 映射 HTTP 状态。"""

    def __init__(self, message: str, *, err_code: str):
        super().__init__(message)
        self.err_code = err_code


class AgentSkillLinkLockedError(AgentSkillLinkWriterError):
    """默认 Agent 锁定 skill 不可停用 / 摘除。"""

    code = DEFAULT_AGENT_SKILL_LOCKED_CODE

    def __init__(self, message: str = DEFAULT_AGENT_SKILL_LOCKED_MESSAGE):
        super().__init__(message)


class AgentSkillLinkWriter:
    """AgentSkillLink 可运行契约的唯一写入点。"""

    # ------------------------------------------------------------------
    # 解析 / 门槛
    # ------------------------------------------------------------------

    @staticmethod
    def resolve_user_skill(
        *,
        slug: str,
        requesting_user_id: UUID,
        organization_id,
    ) -> Optional[Skill]:
        """按可见范围安全解析 ``user:<slug>``。

        优先级：owner → organization 匹配 → public + approved。
        """
        own = Skill.objects.filter(
            slug=slug, owner_user_id=requesting_user_id,
        ).first()
        if own:
            return own

        if organization_id:
            team = Skill.objects.filter(
                slug=slug,
                visibility=Skill.VISIBILITY_ORGANIZATION,
                organization_id=organization_id,
            ).first()
            if team:
                return team

        approved_subquery = SkillPublishedVersion.objects.filter(
            skill=OuterRef("pk"),
            review_status=SkillPublishedVersion.REVIEW_APPROVED,
        )
        return (
            Skill.objects.filter(slug=slug, visibility=Skill.VISIBILITY_PUBLIC)
            .annotate(_has_approved=Exists(approved_subquery))
            .filter(_has_approved=True)
            .first()
        )

    @staticmethod
    def resolve_latest_published_version(skill: Skill) -> tuple:
        """非 owner 启用所需的已发布版本指针。

        - public：须 ``REVIEW_APPROVED``
        - 其他可见性：读 ``Skill.latest_version_seq``（未发布则为 None）
        """
        if skill.visibility == Skill.VISIBILITY_PUBLIC:
            approved = (
                SkillPublishedVersion.objects
                .filter(
                    skill=skill,
                    review_status=SkillPublishedVersion.REVIEW_APPROVED,
                )
                .order_by("-version_seq")
                .first()
            )
            if approved:
                return (approved.version_seq, approved.bundle_sha256 or "")
            return (None, "")
        return (skill.latest_version_seq, skill.install_content_hash or "")

    @classmethod
    def require_runnable_for_non_owner(
        cls,
        *,
        skill: Skill,
        requesting_user_id: UUID,
    ) -> None:
        """#2664 / ：非 owner 启用须有已发布版本，否则拒绝。"""
        if str(skill.owner_user_id) == str(requesting_user_id):
            return
        version_seq, _ = cls.resolve_latest_published_version(skill)
        if version_seq is None:
            raise AgentSkillLinkWriterError(UNPUBLISHED_SKILL_MESSAGE)

    @staticmethod
    def resolve_sync_space_id(agent, *, space_id=None) -> Optional[UUID]:
        """解析 SubAgentTemplate 同步用的真实 workspace。

        显式 ``space_id`` 优先；否则取该 Agent 最近会话的 ``workspace_id``。
        都没有时返回 ``None``——调用方必须跳过 sync / cleanup，
        **禁止**回落 ``agent.id``（会污染假 space，运行时按真实 workspace 查不到）。
        """
        if space_id:
            return space_id if isinstance(space_id, UUID) else UUID(str(space_id))
        try:
            from apps.chat.conversation.models import ChatSession

            workspace_id = (
                ChatSession.objects.filter(
                    agent_id=agent.id,
                    workspace_id__isnull=False,
                )
                .order_by("-updated_at")
                .values_list("workspace_id", flat=True)
                .first()
            )
            if workspace_id:
                return (
                    workspace_id
                    if isinstance(workspace_id, UUID)
                    else UUID(str(workspace_id))
                )
        except Exception:
            logger.debug(
                "[AgentSkillLinkWriter] resolve sync space via session failed agent=%s",
                getattr(agent, "id", None),
                exc_info=True,
            )
        return None

    @staticmethod
    def skipped_sync_result() -> Dict[str, Any]:
        return {
            "status": "skipped",
            "synced": 0,
            "error": None,
            "reason": "no_workspace",
        }

    @staticmethod
    def is_default_agent_locked_source(source: Optional[str]) -> bool:
        """platform / app skill 在默认 Agent 上可能锁定（；marketplace 另判）。"""
        return normalize_skill_source(source or "") in DEFAULT_AGENT_LOCKED_SOURCES

    @classmethod
    def resolve_app_skill_distribution(
        cls,
        *,
        skill_canonical_key: str,
        distribution: Optional[str] = None,
    ) -> Optional[str]:
        """解析 app skill 的 distribution；显式值优先，否则读 app registry。"""
        explicit = (distribution or "").strip() or None
        if explicit:
            return explicit
        prefix = (skill_canonical_key or "").strip().partition(":")[0]
        if normalize_skill_source(prefix) != SOURCE_APP:
            return None
        meta = cls.app_skill_install_metadata(skill_canonical_key)
        return (meta.get("distribution") or "").strip() or None

    @classmethod
    def is_default_agent_locked_skill(
        cls,
        *,
        skill_canonical_key: str,
        source: Optional[str] = None,
        distribution: Optional[str] = None,
    ) -> bool:
        """锁定判定：canonical key 前缀权威；无前缀时才回退 source。

        ``app:`` 仅锁定非 marketplace（内置 App Operator）。推荐货架 pack
        （``distribution=marketplace``）是用户自选携带，默认可关可收回。
        """
        prefix = (skill_canonical_key or "").strip().partition(":")[0]
        effective = normalize_skill_source(prefix or source or "")
        if effective == SOURCE_PLATFORM:
            return True
        if effective != SOURCE_APP:
            return False
        dist = cls.resolve_app_skill_distribution(
            skill_canonical_key=skill_canonical_key,
            distribution=distribution,
        )
        if dist == MARKETPLACE_APP_DISTRIBUTION:
            return False
        return True

    @staticmethod
    def is_locked_template_skill(agent, skill_canonical_key: str) -> bool:
        """四个核心分身的模板 Skill 是不可摘除的角色能力基线。"""
        template_id = (getattr(agent, "template_id", "") or "").strip()
        if not template_id:
            return False

        from apps.tabtinspace.services.onboarding_defaults import (
            LOCKED_TEMPLATE_SKILL_AGENT_IDS,
        )

        if template_id not in LOCKED_TEMPLATE_SKILL_AGENT_IDS:
            return False

        from apps.services.common.agent_template_registry import get_agent_template

        template = get_agent_template(template_id)
        if template is None:
            return False
        return (skill_canonical_key or "").strip() in template.skills

    @classmethod
    def is_agent_skill_locked(
        cls,
        *,
        agent,
        skill_canonical_key: str,
        source: Optional[str] = None,
        distribution: Optional[str] = None,
    ) -> bool:
        """统一锁定判定：核心分身模板基线，或默认 Agent 的系统能力。"""
        if cls.is_locked_template_skill(agent, skill_canonical_key):
            return True
        from apps.skills.services.default_agent_skill_seed import (
            is_default_skill_baseline_agent,
        )

        return (
            is_default_skill_baseline_agent(agent)
            and cls.is_default_agent_locked_skill(
                skill_canonical_key=skill_canonical_key,
                source=source,
                distribution=distribution,
            )
        )

    @classmethod
    def default_locked_links_q(cls):
        """ORM 过滤：锁定集合（容忍 source 脏数据；排除 marketplace 推荐 pack）。

        注意：PG 上 ``~Q(config_json__distribution=marketplace)`` 对缺 key 为
        UNKNOWN，会把内置 app 行误踢出；必须显式保留 distribution 缺失/为空的行。
        """
        from django.db.models import Q

        platform_q = (
            Q(source=SOURCE_PLATFORM)
            | Q(skill_canonical_key__startswith=f"{SOURCE_PLATFORM}:")
        )
        app_base = (
            Q(source=SOURCE_APP)
            | Q(skill_canonical_key__startswith=f"{SOURCE_APP}:")
        )
        app_not_marketplace = (
            Q(config_json__distribution__isnull=True)
            | ~Q(config_json__distribution=MARKETPLACE_APP_DISTRIBUTION)
        )
        return platform_q | (app_base & app_not_marketplace)

    @classmethod
    def assert_default_agent_skill_mutable(
        cls,
        *,
        agent_id: UUID,
        skill_canonical_key: str,
        source: Optional[str] = None,
        distribution: Optional[str] = None,
    ) -> None:
        """系统预置分身禁止关闭或收回其锁定 Skill。"""
        from apps.agent.models import Agent

        agent = (
            Agent.objects.filter(id=agent_id)
            .only("id", "is_default", "template_id")
            .first()
        )
        if agent is None:
            return
        resolved_distribution = distribution
        if resolved_distribution is None:
            link = (
                AgentSkillLink.objects.filter(
                    agent_id=agent_id,
                    skill_canonical_key=(skill_canonical_key or "").strip(),
                )
                .only("config_json", "source")
                .first()
            )
            if link is not None:
                if source is None:
                    source = getattr(link, "source", None)
                cfg = getattr(link, "config_json", None) or {}
                if isinstance(cfg, dict):
                    resolved_distribution = cfg.get("distribution")
        if cls.is_agent_skill_locked(
            agent=agent,
            skill_canonical_key=skill_canonical_key,
            source=source,
            distribution=resolved_distribution,
        ):
            raise AgentSkillLinkLockedError()

    @staticmethod
    def app_skill_install_metadata(canonical_key: str) -> Dict[str, Any]:
        """Return install provenance for app-backed official plugin skills."""
        _, _, remainder = canonical_key.partition(":")
        app_id, sep, _skill_id = remainder.partition("/")
        if not sep or not app_id:
            return {}
        try:
            from apps.services.common.app_registry import get_app
            app_def = get_app(app_id)
        except Exception:
            logger.debug(
                "[AgentSkillLinkWriter] app registry unavailable for %s",
                canonical_key,
                exc_info=True,
            )
            return {}
        if not app_def:
            return {}
        metadata: Dict[str, Any] = {
            "app_id": app_id,
            "version": getattr(app_def, "version", "") or None,
            "distribution": getattr(app_def, "distribution", "") or None,
        }
        official_release = getattr(app_def, "official_plugin_release", None)
        if isinstance(official_release, dict):
            metadata["official_plugin_release"] = official_release
        prepared_runtime = getattr(app_def, "prepared_runtime", None)
        if isinstance(prepared_runtime, dict):
            metadata["prepared_runtime"] = prepared_runtime
        return {
            key: value
            for key, value in metadata.items()
            if value not in (None, "", {})
        }

    # ------------------------------------------------------------------
    # 写入：attach / enable / disable / detach
    # ------------------------------------------------------------------

    @classmethod
    def attach(
        cls,
        *,
        agent_id: UUID,
        organization_id,
        requesting_user_id: UUID,
        skill_canonical_key: str,
        sync_space_id: Optional[UUID] = None,
        device_agents: Optional[List[Dict[str, Any]]] = None,
        enabled: bool = True,
    ) -> AgentSkillLink:
        """挂载携带行（幂等）+ 有 Space 时 SubAgent 同步。

        ``enabled`` 默认 True（显式携带即开启）。工作区目录 Skill 同样通过
        携带行表达 Agent 使用权，但不需要创建云端 Skill 物料。
        """
        canonical_key = (skill_canonical_key or "").strip()
        if not canonical_key or ":" not in canonical_key:
            raise AgentSkillLinkWriterError(
                f"无效 canonical_key（缺 source 前缀）：{canonical_key!r}"
            )
        source = normalize_skill_source(canonical_key.partition(":")[0])

        user_skill: Optional[Skill] = None
        skill_pk: Optional[UUID] = None
        if source == SOURCE_USER:
            slug = canonical_key.split(":", 1)[1]
            user_skill = cls.resolve_user_skill(
                slug=slug,
                requesting_user_id=requesting_user_id,
                organization_id=organization_id,
            )
            if not user_skill:
                raise AgentSkillLinkWriterNotFoundError(
                    f"Skill 不存在或不可见: {canonical_key}"
                )
            cls.require_runnable_for_non_owner(
                skill=user_skill,
                requesting_user_id=requesting_user_id,
            )
            skill_pk = user_skill.skill_id
        elif source not in {
            SOURCE_PLATFORM,
            SOURCE_APP,
            SOURCE_DEVICE,
            SOURCE_WORKSPACE,
        }:
            raise AgentSkillLinkWriterError(f"未知 source: {source}")

        desired_enabled = bool(enabled)
        app_install_metadata = (
            cls.app_skill_install_metadata(canonical_key)
            if source == SOURCE_APP
            else {}
        )

        with transaction.atomic():
            row, created = AgentSkillLink.objects.get_or_create(
                agent_id=agent_id,
                skill_canonical_key=canonical_key,
                defaults={
                    "skill_id": skill_pk,
                    "source": source,
                    "enabled": desired_enabled,
                    "config_json": app_install_metadata,
                },
            )
            if not created:
                fields_changed: list[str] = []
                if row.enabled != desired_enabled:
                    row.enabled = desired_enabled
                    fields_changed.append("enabled")
                if app_install_metadata:
                    cfg = dict(row.config_json or {})
                    changed_config = False
                    for key, value in app_install_metadata.items():
                        if cfg.get(key) != value:
                            cfg[key] = value
                            changed_config = True
                    if changed_config:
                        row.config_json = cfg
                        if "config_json" not in fields_changed:
                            fields_changed.append("config_json")
                if row.skill_id != skill_pk:
                    row.skill_id = skill_pk
                    fields_changed.append("skill_id")
                if row.source != source:
                    row.source = source
                    fields_changed.append("source")
                if fields_changed:
                    row.save(update_fields=fields_changed + ["updated_at"])

        # 工作区目录 Skill 无 SubAgent 模板可同步。
        if sync_space_id is None or source == SOURCE_WORKSPACE or not desired_enabled:
            sync_result = cls.skipped_sync_result()
        else:
            sync_result = cls.sync_sub_agent_templates(
                space_id=sync_space_id,
                canonical_key=canonical_key,
                source=source,
                user_skill=user_skill,
                device_agents=device_agents if source == SOURCE_DEVICE else None,
            )
        setattr(row, "_agents_sync", sync_result)
        logger.info(
            "agent_link_writer.attached agent=%s skill=%s created=%s enabled=%s sync=%s",
            agent_id, canonical_key, created, desired_enabled, sync_result.get("status"),
        )
        return row

    @classmethod
    def detach(
        cls,
        *,
        agent_id: UUID,
        skill_canonical_key: str,
        sync_space_id: Optional[UUID] = None,
    ) -> bool:
        """摘除携带行（删行）；有 workspace 时清理 SubAgentTemplate。返回是否命中。"""
        canonical_key = (skill_canonical_key or "").strip()
        cls.assert_default_agent_skill_mutable(
            agent_id=agent_id,
            skill_canonical_key=canonical_key,
        )
        deleted, _ = AgentSkillLink.objects.filter(
            agent_id=agent_id,
            skill_canonical_key=canonical_key,
        ).delete()
        if deleted and sync_space_id is not None:
            cls.remove_sub_agent_templates(
                space_id=sync_space_id,
                canonical_key=canonical_key,
            )
            logger.info(
                "agent_link_writer.detached agent=%s skill=%s",
                agent_id, canonical_key,
            )
        elif deleted:
            logger.info(
                "agent_link_writer.detached agent=%s skill=%s sync=skipped",
                agent_id, canonical_key,
            )
        return deleted > 0

    @classmethod
    def disable_or_detach(
        cls,
        *,
        agent_id: UUID,
        skill_canonical_key: str,
        sync_space_id: Optional[UUID] = None,
        remove: bool = False,
    ) -> bool:
        """Skill 库 disable 语义：``remove=False`` 置 enabled=False；``True`` 删行。"""
        canonical_key = (skill_canonical_key or "").strip()
        # 默认 Agent 锁定 skill：停用与摘除均拒绝
        cls.assert_default_agent_skill_mutable(
            agent_id=agent_id,
            skill_canonical_key=canonical_key,
        )
        qs = AgentSkillLink.objects.filter(
            agent_id=agent_id,
            skill_canonical_key=canonical_key,
        )
        if remove:
            affected, _ = qs.delete()
            found = affected > 0
        else:
            row = qs.first()
            if row is not None:
                if row.enabled:
                    row.enabled = False
                    row.save(update_fields=["enabled", "updated_at"])
                found = True
            else:
                # 无携带行 = 已停用（幂等）
                found = True

        if sync_space_id is not None:
            cls.remove_sub_agent_templates(
                space_id=sync_space_id,
                canonical_key=canonical_key,
            )
        return found

    # ------------------------------------------------------------------
    # config merge + credential
    # ------------------------------------------------------------------

    @classmethod
    def validate_credential_id(
        cls,
        *,
        requesting_user_id: UUID,
        credential_id: str,
    ) -> None:
        """校验 credential：格式、归属、category=api_key、激活、未过期。"""
        from apps.tabtinspace.services.app_settings_service import AppSettingsService

        ok, err_code = AppSettingsService._validate_api_key_credential(
            user_id=str(requesting_user_id),
            credential_id=credential_id,
        )
        if not ok:
            raise AgentSkillLinkCredentialError(
                CREDENTIAL_ERROR_MESSAGES.get(err_code, "credential_id 无效"),
                err_code=err_code,
            )

    @classmethod
    def merge_config(
        cls,
        *,
        agent_id: UUID,
        skill_canonical_key: str,
        requesting_user_id: UUID,
        sync_space_id: Optional[UUID] = None,
        enabled: Optional[bool] = None,
        credential_id: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        config: Optional[Dict[str, Any]] = None,
        config_patch: Optional[Dict[str, Any]] = None,
        device_agents: Optional[List[Dict[str, Any]]] = None,
    ) -> AgentSkillLink:
        """Merge 更新 config_json（与 Skill 库路径一致，避免整段替换 silent wipe）。

        - ``credential_id`` / ``env`` / ``config``：结构化字段（Skill 库 API）
        - ``config_patch``：Agent API 的 opaque dict，按顶层 key merge；
          值为 ``None`` 时删除该 key；含 ``credential_id`` 走同一校验
        - ``enabled`` 变更且有 workspace 时同步 / 清理 SubAgentTemplate
        """
        canonical_key = (skill_canonical_key or "").strip()
        row = AgentSkillLink.objects.filter(
            agent_id=agent_id,
            skill_canonical_key=canonical_key,
        ).first()
        if row is None:
            # 工作区目录 Skill 没有云端 Skill 物料；首次显式开关可由 PATCH 建携带行。
            raw_prefix = canonical_key.partition(":")[0].strip().lower()
            if raw_prefix == SOURCE_WORKSPACE and enabled is not None:
                row = cls.attach(
                    agent_id=agent_id,
                    organization_id=None,
                    requesting_user_id=requesting_user_id,
                    skill_canonical_key=canonical_key,
                    sync_space_id=sync_space_id,
                    enabled=bool(enabled),
                )
                return row
            raise AgentSkillLinkWriterNotFoundError(
                f"Agent 未携带该 Skill，请先启用：{canonical_key}"
            )

        if enabled is False:
            # 统一按 canonical key 前缀判定，避免 row.source 脏数据绕过
            cls.assert_default_agent_skill_mutable(
                agent_id=agent_id,
                skill_canonical_key=canonical_key,
            )

        # 结构化 credential 与 patch 内 credential 统一校验（非空时）
        credential_to_validate: Optional[str] = None
        if credential_id:
            credential_to_validate = credential_id
        elif config_patch is not None and CONFIG_KEY_CREDENTIAL_ID in config_patch:
            patch_cred = config_patch.get(CONFIG_KEY_CREDENTIAL_ID)
            if patch_cred:
                credential_to_validate = str(patch_cred)
        if credential_to_validate:
            cls.validate_credential_id(
                requesting_user_id=requesting_user_id,
                credential_id=credential_to_validate,
            )

        cfg = dict(row.config_json or {})
        changed = False

        if credential_id is not None:
            normalized = credential_id or None
            if cfg.get(CONFIG_KEY_CREDENTIAL_ID) != normalized:
                if normalized is None:
                    cfg.pop(CONFIG_KEY_CREDENTIAL_ID, None)
                else:
                    cfg[CONFIG_KEY_CREDENTIAL_ID] = normalized
                changed = True
        if env is not None and cfg.get(CONFIG_KEY_ENV) != env:
            cfg[CONFIG_KEY_ENV] = env
            changed = True
        if config is not None and cfg.get(CONFIG_KEY_CONFIG) != config:
            cfg[CONFIG_KEY_CONFIG] = config
            changed = True

        if config_patch is not None:
            for key, value in config_patch.items():
                if key == CONFIG_KEY_CREDENTIAL_ID:
                    normalized = value or None
                    if cfg.get(CONFIG_KEY_CREDENTIAL_ID) != normalized:
                        if normalized is None:
                            cfg.pop(CONFIG_KEY_CREDENTIAL_ID, None)
                        else:
                            cfg[CONFIG_KEY_CREDENTIAL_ID] = normalized
                        changed = True
                elif value is None:
                    if key in cfg:
                        cfg.pop(key)
                        changed = True
                elif cfg.get(key) != value:
                    cfg[key] = value
                    changed = True

        update_fields: list[str] = []
        enabled_changed = enabled is not None and row.enabled != enabled
        if changed:
            row.config_json = cfg
            update_fields.append("config_json")
        if enabled_changed:
            row.enabled = enabled
            update_fields.append("enabled")
        if update_fields:
            row.save(update_fields=update_fields + ["updated_at"])

        if enabled_changed:
            if sync_space_id is None:
                sync_result = cls.skipped_sync_result()
            else:
                source = normalize_skill_source(
                    row.source or canonical_key.partition(":")[0]
                )
                if row.enabled:
                    user_skill = None
                    if source == SOURCE_USER and row.skill_id:
                        user_skill = Skill.objects.filter(skill_id=row.skill_id).first()
                    sync_result = cls.sync_sub_agent_templates(
                        space_id=sync_space_id,
                        canonical_key=canonical_key,
                        source=source,
                        user_skill=user_skill,
                        device_agents=device_agents if source == SOURCE_DEVICE else None,
                    )
                else:
                    sync_result = cls.remove_sub_agent_templates(
                        space_id=sync_space_id,
                        canonical_key=canonical_key,
                    )
            setattr(row, "_agents_sync", sync_result)

        return row

    # ------------------------------------------------------------------
    # SubAgent 副作用
    # ------------------------------------------------------------------

    @classmethod
    def sync_sub_agent_templates(
        cls,
        *,
        space_id: UUID,
        canonical_key: str,
        source: str,
        user_skill: Optional[Skill] = None,
        device_agents: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """启用副作用：把 skill 的 agents/*.md 同步到 SubAgentTemplate。"""
        try:
            agents: List[Dict[str, Any]] = []
            if source == SOURCE_USER and user_skill is not None:
                raw = user_skill.agents_json or []
                if isinstance(raw, list):
                    agents = [a for a in raw if isinstance(a, dict)]
            elif source == SOURCE_PLATFORM:
                for entry in SkillsRegistryService.list_platform_skills():
                    if entry.get("skill_key") == canonical_key:
                        agents = list(entry.get("agents") or [])
                        break
            elif source == SOURCE_APP:
                for entry in SkillsRegistryService.list_app_skills():
                    if entry.get("skill_key") == canonical_key:
                        agents = list(entry.get("agents") or [])
                        break
            elif source == SOURCE_DEVICE:
                if device_agents:
                    agents = [a for a in device_agents if isinstance(a, dict)]
                else:
                    return {"status": "skipped", "synced": 0, "error": None}
            else:
                return {"status": "skipped", "synced": 0, "error": None}

            from apps.skills.services.agent_sync_service import AgentSyncService
            if agents:
                stats = AgentSyncService.sync_skill_agents(
                    space_id=str(space_id),
                    skill_key=canonical_key,
                    agents=agents,
                )
                synced = stats.get("created", 0) + stats.get("updated", 0)
                return {"status": "ok", "synced": synced, "error": None}
            AgentSyncService.remove_skill_agents(
                space_id=str(space_id),
                skill_key=canonical_key,
            )
            return {"status": "ok", "synced": 0, "error": None}
        except Exception as exc:
            logger.warning(
                "[AgentSkillLinkWriter] sync sub_agent templates failed: skill=%s space=%s",
                canonical_key, space_id, exc_info=True,
            )
            return {"status": "failed", "synced": 0, "error": str(exc)[:200]}

    @classmethod
    def remove_sub_agent_templates(
        cls,
        *,
        space_id: UUID,
        canonical_key: str,
    ) -> Dict[str, Any]:
        """停用 / 摘除副作用：清理 SubAgentTemplate。"""
        try:
            from apps.skills.services.agent_sync_service import AgentSyncService
            deleted = AgentSyncService.remove_skill_agents(
                space_id=str(space_id),
                skill_key=canonical_key,
            )
            return {"status": "ok", "synced": 0, "removed": deleted, "error": None}
        except Exception as exc:
            logger.warning(
                "[AgentSkillLinkWriter] remove sub_agent templates failed: skill=%s space=%s",
                canonical_key, space_id, exc_info=True,
            )
            return {"status": "failed", "synced": 0, "removed": 0, "error": str(exc)[:200]}


__all__ = [
    "AgentSkillLinkWriter",
    "AgentSkillLinkWriterError",
    "AgentSkillLinkWriterNotFoundError",
    "AgentSkillLinkCredentialError",
    "AgentSkillLinkLockedError",
    "UNPUBLISHED_SKILL_MESSAGE",
    "DEFAULT_AGENT_SKILL_LOCKED_MESSAGE",
    "DEFAULT_AGENT_SKILL_LOCKED_CODE",
    "DEFAULT_AGENT_LOCKED_SOURCES",
    "MARKETPLACE_APP_DISTRIBUTION",
    "CREDENTIAL_ERROR_MESSAGES",
    "CONFIG_KEY_CREDENTIAL_ID",
    "CONFIG_KEY_ENV",
    "CONFIG_KEY_CONFIG",
]
