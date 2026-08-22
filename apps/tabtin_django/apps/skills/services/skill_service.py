"""SkillService — Wave 1 服务层（PRD V3.3；#7118 硬切 organization_id + agent_id）。

PRD V3.3 §5 / §6 行为聚合：
- 创建（进入能力库，默认停用）
- 启用（行存在 = 已安装；enabled=True = 注入/启用）
- 停用（保留行、enabled=False，安装记录不丢；卸载才删行——「停用 ≠ 卸载」）
- 升级冲突（D7 三选一）
- 丢弃草稿（D15）
- 设定 visibility（D5）

#7118：Skill HTTP 已去 ``space_id``。公开方法签名以 ``organization_id`` +
``agent_id`` 为主；sandbox 落盘按两层拆分：
- 个人 Skill    → ``{TABTIN_SANDBOX_ROOT}/users/{userId}/skills/{slug}/``
- 组织共享 Skill → ``{TABTIN_SANDBOX_ROOT}/users/{userId}/organizations/{orgId}/skills/{slug}/``
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from uuid import UUID

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.skills.models import (
    AgentSkillLink,
    Skill,
    SkillEnablement,
    SkillPublishedVersion,
    UserSkillPreference,
)
from apps.skills.services.agent_link_writer import (
    AgentSkillLinkLockedError,
    AgentSkillLinkWriter,
    AgentSkillLinkWriterError,
    AgentSkillLinkWriterNotFoundError,
)
from apps.skills.services.space_context import (
    SkillSpaceContextError,
    resolve_skill_agent_context,
    resolve_skill_context_for_organization,
    resolve_skill_space_context,
)
from apps.skills.services.registry_service import (
    CANONICAL_SOURCES,
    SOURCE_USER,
    SkillsRegistryService,
    normalize_skill_source,
)
from apps.skills.services.user_preference_service import (
    UserSkillPreferenceError,
    UserSkillPreferenceService,
)


@dataclass(frozen=True)
class EnableSkillResult:
    """enable_skill 显式返回契约（避免往 ORM 行上 setattr）。"""

    skill_canonical_key: str
    enabled: bool
    skill_id: Optional[UUID]
    source: str
    agents_sync: Dict[str, Any]
    skill: Optional[Dict[str, Any]] = None

logger = logging.getLogger("skills.skill_service")

from apps.skills.services.semver_utils import (
    bump_patch_semver,
    compare_semver,
    display_semver_for_published_version,
    max_semver_label,
    normalize_semver_label,
)

# Skill 分类枚举。必须与 renderer 两端保持兼容：
#   - 市场筛选 / 修改分类对话框：`SKILL_MARKET_CATEGORY_ORDER`
#     （writing / collab / data / research / creative / engineering）
#   - 旧 27 细分类：`skillCategory.ts` 的 `SKILL_MARKET_CATEGORIES`
#     （任务类型 + 能力域）。创建对话框仍可能写入旧值，接口继续放行。
VALID_SKILL_CATEGORIES = frozenset({
    # 市场「全部」后的分类 chip（修改分类对话框同源）
    "writing",
    "collab",
    "data",
    "research",
    "creative",
    "engineering",
    # 任务类型（通用组，历史细分类）
    "productivity",
    "analysis",
    "project_management",
    "sales_crm",
    "customer_support",
    "education",
    "finance",
    "hr",
    "legal",
    "marketing",
    "design",
    "developer",
    "ai_media",
    "lifestyle",
    "other",
    # 能力域组（历史细分类）
    "doc",
    "web",
    "media",
    "device",
    "collaboration",
    "workflow",
    "knowledge",
    "communication",
    "automation",
})


class SkillServiceError(Exception):
    """业务错误。"""


class SkillVersionConflictError(SkillServiceError):
    """发布版本落后于数据库真源；携带客户端恢复表单所需的稳定字段。"""

    def __init__(self, message: str, *, requested_version: str, latest_version: str):
        super().__init__(message)
        self.requested_version = requested_version
        self.latest_version = latest_version
        self.suggested_patch_version = bump_patch_semver(latest_version)

    def response_data(self) -> Dict[str, str]:
        return {
            "reason": "skill_version_conflict",
            "requested_version": self.requested_version,
            "latest_version": self.latest_version,
            "suggested_patch_version": self.suggested_patch_version,
        }


class SkillNotFoundError(SkillServiceError):
    """目标 skill 不存在。"""


class SkillPermissionError(SkillServiceError):
    """权限不足（403）。"""


# ---------------------------------------------------------------------------
# Sandbox 双层布局——不允许把这些命名字面量散落在业务代码里。
# ---------------------------------------------------------------------------

SANDBOX_USERS_SEGMENT = "users"
SANDBOX_ORGANIZATIONS_SEGMENT = "organizations"
SANDBOX_SKILLS_SEGMENT = "skills"
SANDBOX_ROOT_ENV_VAR = "TABTIN_SANDBOX_ROOT"
SANDBOX_ROOT_DEFAULT = "/tmp/tabtin-sandbox"


def _sandbox_root() -> str:
    return os.environ.get(SANDBOX_ROOT_ENV_VAR, SANDBOX_ROOT_DEFAULT)


def _sandbox_skills_root(*, owner_user_id, organization_id=None) -> str:
    """返回 sandbox 下 (user[, organization]) 的 skills 目录根。"""
    segments = [_sandbox_root(), SANDBOX_USERS_SEGMENT, str(owner_user_id)]
    if organization_id:
        segments += [SANDBOX_ORGANIZATIONS_SEGMENT, str(organization_id)]
    segments.append(SANDBOX_SKILLS_SEGMENT)
    return os.path.join(*segments)


def _sandbox_skill_dir(*, owner_user_id, organization_id, slug: str) -> str:
    """按 (owner, organization?, slug) 定位单个 Skill 的 sandbox 目录。"""
    return os.path.join(
        _sandbox_skills_root(
            owner_user_id=owner_user_id, organization_id=organization_id,
        ),
        slug,
    )


def _sandbox_locations_for_skill(skill: "Skill") -> List[str]:
    """按当前 skill 状态返回 sandbox 目录候选（团队优先，回落个人）。"""
    org_id = skill.organization_id
    locations: List[str] = []
    if org_id and skill.visibility == Skill.VISIBILITY_ORGANIZATION:
        locations.append(_sandbox_skill_dir(
            owner_user_id=skill.owner_user_id,
            organization_id=org_id,
            slug=skill.slug,
        ))
    locations.append(_sandbox_skill_dir(
        owner_user_id=skill.owner_user_id,
        organization_id=None,
        slug=skill.slug,
    ))
    if org_id and skill.visibility != Skill.VISIBILITY_ORGANIZATION:
        # 曾经共享到 organization 又切回私有的历史目录也一起清扫。
        locations.append(_sandbox_skill_dir(
            owner_user_id=skill.owner_user_id,
            organization_id=org_id,
            slug=skill.slug,
        ))
    return locations


def _primary_sandbox_dir_for_skill(skill: "Skill") -> str:
    """当前应写入的 sandbox 目录（团队可见 → 组织路径；其他 → 个人路径）。"""
    org_id = (
        skill.organization_id
        if skill.visibility == Skill.VISIBILITY_ORGANIZATION
        else None
    )
    return _sandbox_skill_dir(
        owner_user_id=skill.owner_user_id,
        organization_id=org_id,
        slug=skill.slug,
    )


class SkillService:
    """Skill 业务编排服务。"""

    @staticmethod
    def _resolve_agent_context(agent_id):
        """#7118：直接从 Agent 解析 (organization, agent, workspace?)——不再喂 space_id。

        Skill HTTP 已不暴露 space_id；内部若需 workspace（SubAgent 同步、设备
        安装事实等），由 Agent 最近会话推导。
        """
        if not agent_id:
            raise SkillServiceError("agent_id 必填：Skill 归属 Agent")
        try:
            workspace_id = None
            try:
                from apps.chat.conversation.models import ChatSession

                workspace_id = (
                    ChatSession.objects.filter(
                        agent_id=agent_id,
                        workspace_id__isnull=False,
                    )
                    .order_by("-updated_at")
                    .values_list("workspace_id", flat=True)
                    .first()
                )
            except Exception:
                workspace_id = None
            return resolve_skill_agent_context(
                agent_id=agent_id, workspace_id=workspace_id,
            )
        except SkillSpaceContextError as exc:
            raise SkillServiceError(str(exc)) from exc

    @staticmethod
    def _resolve_space_context(space_id, agent_id=None):
        """内部兼容：仍接受 workspace_id 作为可选 SubAgent sync 锚点。

        ：HTTP 不再传 space_id；本方法主要供内部升级路径（需要设备安装
        事实）与旧测试保留。若未提供 agent_id，从会话回退解析。
        """
        resolved_agent_id = agent_id
        if not resolved_agent_id and space_id:
            try:
                from apps.chat.conversation.models import ChatSession

                resolved_agent_id = (
                    ChatSession.objects.filter(
                        workspace_id=space_id,
                        agent_id__isnull=False,
                    )
                    .order_by("-updated_at")
                    .values_list("agent_id", flat=True)
                    .first()
                )
            except Exception:
                resolved_agent_id = None
        try:
            return resolve_skill_space_context(space_id, agent_id=resolved_agent_id)
        except SkillSpaceContextError as exc:
            raise SkillServiceError(str(exc)) from exc

    @staticmethod
    def _app_skill_install_metadata(canonical_key: str) -> Dict[str, Any]:
        """Return install provenance for app-backed official plugin skills."""
        return AgentSkillLinkWriter.app_skill_install_metadata(canonical_key)

    # ---------- create ----------

    @staticmethod
    def create_user_skill(
        *,
        owner_user_id: UUID,
        organization_id: Optional[UUID] = None,
        agent_id: Optional[UUID] = None,
        name: str,
        description: str = "",
        slug: Optional[str] = None,
        slug_conflict_policy: str = "suffix",
        emoji: str = "",
        category: Optional[str] = None,
        skip_initial_publish: bool = False,
        import_source_url: str = "",
    ) -> Skill:
        """创建 user 来源 Skill（创建后默认停用，由用户决定何时启用）。

        ``skip_initial_publish=True``：只建库记录，不写模板、不发 v0.0.1。
        导入场景用——随后用真实文件做首次发布，避免 Registry 里先落空模板。

        ：``agent_id`` 缺省时不建立 AgentSkillLink（例如 CLI 场景仅想
        入库、稍后再挂到 Agent）；``organization_id`` 仅用于组织成员鉴权与
        SubAgent 同步 workspace 推断，不影响 Skill 归属。
        """
        if not owner_user_id:
            raise SkillServiceError("owner_user_id 必填")
        if not name:
            raise SkillServiceError("name 必填")
        if slug_conflict_policy not in {"suffix", "reject"}:
            raise SkillServiceError("slug_conflict_policy 必须是 suffix 或 reject")

        from apps.skills.services.publish_service import _resolve_unique_slug
        from apps.skills.services.slug_utils import slugify_skill_name

        slug_normalized = slugify_skill_name(slug or name)
        if slug_conflict_policy == "reject":
            if Skill.objects.filter(owner_user_id=owner_user_id, slug=slug_normalized).exists():
                raise SkillServiceError("标识名已存在")
            unique_slug = slug_normalized
        else:
            unique_slug = _resolve_unique_slug(
                owner_user_id=owner_user_id, slug=slug_normalized,
            )
        normalized_category = SkillService._normalize_category(category)
        skeleton_content = SkillService.generate_skill_skeleton(
            name,
            description or "",
            category=normalized_category,
            slug=unique_slug,
        )
        source_url = (import_source_url or "").strip()

        try:
            with transaction.atomic():
                skill = Skill.objects.create(
                    owner_user_id=owner_user_id,
                    slug=unique_slug,
                    name=name,
                    description=description or "",
                    emoji=emoji or "",
                    category=normalized_category,
                    visibility=Skill.VISIBILITY_PRIVATE,
                    source=Skill.SOURCE_USER,
                    import_source_url=source_url,
                )

                # 创建即进入当前 Agent 的携带集（若指定），但默认不注入。设备安装
                # 由客户端实际物化后上报，本服务不代建安装登记。
                if agent_id:
                    AgentSkillLink.objects.create(
                        agent_id=agent_id,
                        skill_id=skill.skill_id,
                        skill_canonical_key=skill.canonical_key,
                        source=SOURCE_USER,
                        enabled=False,
                        config_json={},
                    )
        except IntegrityError as exc:
            # reject 既覆盖常规预检，也覆盖并发请求同时通过预检后的唯一约束竞争。
            if slug_conflict_policy == "reject":
                raise SkillServiceError("标识名已存在") from exc
            raise

        if skip_initial_publish:
            logger.info(
                "skill_service.created_without_initial_publish skill=%s slug=%s org=%s",
                skill.skill_id, skill.slug, organization_id,
            )
            return skill

        # 与导入共用同一条「写 sandbox + publish」路径，避免新建/导入两套首发。
        try:
            SkillService._write_import_files_and_publish(
                skill=skill,
                user_id=owner_user_id,
                agent_id=agent_id,
                organization_id=organization_id,
                files=[{"path": "SKILL.md", "content": skeleton_content}],
                change_note="create",
            )
            skill.refresh_from_db()
        except Exception:
            logger.error(
                "skill_service.initial_publish failed skill=%s slug=%s",
                skill.skill_id,
                skill.slug,
                exc_info=True,
            )

        logger.info(
            "skill_service.created skill=%s slug=%s org=%s",
            skill.skill_id, skill.slug, organization_id,
        )
        return skill

    @staticmethod
    def _write_skeleton_to_sandbox(
        *, skill: Skill, content: str,
    ) -> str:
        skill_dir = _primary_sandbox_dir_for_skill(skill)
        os.makedirs(skill_dir, exist_ok=True)
        md_path = os.path.join(skill_dir, "SKILL.md")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(content)
        return md_path

    @staticmethod
    def _remove_sandbox_copy(*, skill: Skill) -> None:
        """删除该 skill 在 sandbox 中的所有历史目录（个人 + 组织）。"""
        import shutil

        allowed_roots = [
            os.path.realpath(_sandbox_skills_root(
                owner_user_id=skill.owner_user_id, organization_id=None,
            )),
        ]
        if skill.organization_id:
            allowed_roots.append(os.path.realpath(_sandbox_skills_root(
                owner_user_id=skill.owner_user_id,
                organization_id=skill.organization_id,
            )))
        for location in _sandbox_locations_for_skill(skill):
            real_dir = os.path.realpath(location)
            # 严格前缀校验：目录必须落在 (user[, org]) skills 根之下。
            if not any(real_dir.startswith(r + os.sep) for r in allowed_roots):
                continue
            if os.path.isdir(real_dir):
                shutil.rmtree(real_dir, ignore_errors=True)

    # ---------- 内部：可见性安全解析 ----------

    @staticmethod
    def _resolve_user_skill(
        *,
        slug: str,
        requesting_user_id: UUID,
        organization_id: Optional[UUID] = None,
    ) -> Optional[Skill]:
        """按可见范围安全解析 ``user:<slug>``（委托 Writer， / ）。"""
        return AgentSkillLinkWriter.resolve_user_skill(
            slug=slug,
            requesting_user_id=requesting_user_id,
            organization_id=organization_id,
        )

    @staticmethod
    def _resolve_latest_approved_version(skill: Skill) -> tuple:
        return AgentSkillLinkWriter.resolve_latest_published_version(skill)

    # ---------- enable / disable ----------

    @classmethod
    def _validate_user_gate_target(
        cls,
        *,
        user_id: UUID,
        skill_canonical_key: str,
        organization_id: Optional[UUID] = None,
    ) -> tuple[Optional[UUID], str]:
        """仅开总闸时仍校验存在性 / 可运行契约。"""
        canonical_key = (skill_canonical_key or "").strip()
        if not canonical_key or ":" not in canonical_key:
            raise SkillServiceError(
                f"无效 canonical_key（缺 source 前缀）：{canonical_key!r}"
            )
        raw_source = canonical_key.partition(":")[0].strip().lower()
        if raw_source not in CANONICAL_SOURCES:
            raise SkillServiceError(f"未知 source: {raw_source}")
        source = normalize_skill_source(raw_source)
        if source != SOURCE_USER:
            return None, source

        user_skill = AgentSkillLinkWriter.resolve_user_skill(
            slug=canonical_key.split(":", 1)[1],
            requesting_user_id=user_id,
            organization_id=organization_id,
        )
        if not user_skill:
            raise SkillNotFoundError(f"Skill 不存在或不可见: {canonical_key}")
        try:
            AgentSkillLinkWriter.require_runnable_for_non_owner(
                skill=user_skill,
                requesting_user_id=user_id,
            )
        except AgentSkillLinkWriterError as exc:
            raise SkillServiceError(str(exc)) from exc
        return user_skill.skill_id, source

    @classmethod
    def _attach_for_enable(
        cls,
        *,
        user_id: UUID,
        skill_canonical_key: str,
        agent_id: UUID,
        organization_id: Optional[UUID] = None,
        device_agents: Optional[List[Dict[str, Any]]] = None,
    ) -> tuple[Optional[UUID], str, Dict[str, Any]]:
        """enable 路径：先 attach 子开关并校验可运行契约。

        ：workspace 由 Agent 最近会话内部推导，不再由调用方提供 space_id。
        """
        from apps.agent.models import Agent as AgentModel

        agent = AgentModel.objects.filter(
            id=agent_id,
            owner_user_id=user_id,
            is_active=True,
        ).first()
        if agent is None:
            raise SkillPermissionError(
                f"无权为目标 Agent 启用 Skill，或 Agent 不存在: {agent_id}"
            )
        effective_org_id = organization_id or agent.organization_id
        sync_space_id = AgentSkillLinkWriter.resolve_sync_space_id(agent)

        try:
            link = AgentSkillLinkWriter.attach(
                agent_id=agent_id,
                organization_id=effective_org_id,
                requesting_user_id=user_id,
                skill_canonical_key=skill_canonical_key,
                sync_space_id=sync_space_id,
                device_agents=device_agents,
            )
        except AgentSkillLinkWriterNotFoundError as exc:
            raise SkillNotFoundError(str(exc)) from exc
        except AgentSkillLinkWriterError as exc:
            raise SkillServiceError(str(exc)) from exc

        source = getattr(link, "source", None) or skill_canonical_key.partition(":")[0]
        agents_sync = getattr(
            link, "_agents_sync", {"status": "skipped", "synced": 0},
        )
        return getattr(link, "skill_id", None), source, agents_sync

    @classmethod
    def enable_skill(
        cls,
        *,
        user_id: UUID,
        skill_canonical_key: str,
        agent_id: Optional[UUID] = None,
        organization_id: Optional[UUID] = None,
        source_skill_id: Optional[UUID] = None,
        acquire_as_copy: bool = False,
        device_agents: Optional[List[Dict[str, Any]]] = None,
    ) -> EnableSkillResult:
        """打开用户级技能库总闸。

        ：Skill HTTP 不再传 space_id。可选 ``agent_id`` 同时挂载/打开子
        开关（SubAgent 同步 workspace 由 Agent 最近会话内部推导）；可选
        ``organization_id`` 用于 owner 之外的可见性解析（未传则仅 owner
        或 public 可见）。
        """
        if not user_id or not skill_canonical_key:
            raise SkillServiceError("缺少 user_id / skill_canonical_key")

        acquired_skill: Optional[Skill] = None
        if acquire_as_copy and skill_canonical_key.startswith("user:"):
            acquired_skill = cls._acquire_organization_skill_for_user(
                user_id=user_id,
                skill_canonical_key=skill_canonical_key,
                organization_id=organization_id,
                source_skill_id=source_skill_id,
            )
            skill_canonical_key = acquired_skill.canonical_key

        agents_sync: Dict[str, Any] = {"status": "skipped", "synced": 0}
        skill_id = None
        source = skill_canonical_key.partition(":")[0]
        if agent_id:
            skill_id, source, agents_sync = cls._attach_for_enable(
                user_id=user_id,
                skill_canonical_key=skill_canonical_key,
                agent_id=agent_id,
                organization_id=organization_id,
                device_agents=device_agents,
            )
        else:
            skill_id, source = cls._validate_user_gate_target(
                user_id=user_id,
                skill_canonical_key=skill_canonical_key,
                organization_id=organization_id,
            )

        try:
            pref = UserSkillPreferenceService.set_enabled(
                user_id=user_id,
                skill_canonical_key=skill_canonical_key,
                enabled=True,
            )
        except UserSkillPreferenceError as exc:
            raise SkillServiceError(str(exc)) from exc

        logger.info(
            "skill_service.user_gate_enabled user=%s skill=%s agent=%s sync=%s",
            user_id,
            skill_canonical_key,
            agent_id,
            agents_sync.get("status"),
        )
        return EnableSkillResult(
            skill_canonical_key=pref.skill_canonical_key,
            enabled=bool(pref.enabled),
            skill_id=skill_id,
            source=source,
            agents_sync=agents_sync,
            skill=acquired_skill.to_index_entry() if acquired_skill else None,
        )

    @classmethod
    def _acquire_organization_skill_for_user(
        cls,
        *,
        user_id: UUID,
        skill_canonical_key: str,
        organization_id: Optional[UUID],
        source_skill_id: Optional[UUID] = None,
    ) -> Skill:
        """把组织精选接入为当前用户的私有快照，并返回幂等副本。"""
        slug = skill_canonical_key.split(":", 1)[1]
        source = None
        if source_skill_id:
            source = Skill.objects.filter(skill_id=source_skill_id).first()
            if source is None:
                raise SkillNotFoundError(f"Skill 不存在: {source_skill_id}")
            if source and source.canonical_key != skill_canonical_key:
                raise SkillServiceError("source_skill_id 与 skill_canonical_key 不匹配")
            if (
                source
                and source.visibility == Skill.VISIBILITY_ORGANIZATION
                and str(source.organization_id) != str(organization_id)
            ):
                raise SkillPermissionError("组织精选不属于当前组织")
            if (
                source
                and source.visibility == Skill.VISIBILITY_PRIVATE
                and str(source.owner_user_id) != str(user_id)
            ):
                raise SkillPermissionError("无权接入其他用户的私有 Skill")
            if source and source.visibility == Skill.VISIBILITY_PUBLIC:
                approved = source.published_versions.filter(
                    review_status=SkillPublishedVersion.REVIEW_APPROVED,
                ).exists()
                if not approved and str(source.owner_user_id) != str(user_id):
                    raise SkillPermissionError("公开 Skill 尚未通过审核")
        if source is None:
            source = AgentSkillLinkWriter.resolve_user_skill(
                slug=slug,
                requesting_user_id=user_id,
                organization_id=organization_id,
            )
        if not source:
            raise SkillNotFoundError(f"Skill 不存在或不可见: {skill_canonical_key}")
        if (
            source.visibility != Skill.VISIBILITY_ORGANIZATION
            or str(source.owner_user_id) == str(user_id)
        ):
            return source
        return cls._copy_organization_snapshot_for_user(
            source_skill=source,
            user_id=user_id,
        )

    @classmethod
    def _copy_organization_snapshot_for_user(
        cls,
        *,
        source_skill: Skill,
        user_id: UUID,
    ) -> Skill:
        """复制组织分发快照；数据库唯一约束保证用户 × 来源天然幂等。"""
        if source_skill.visibility != Skill.VISIBILITY_ORGANIZATION:
            raise SkillServiceError("只有组织精选 Skill 可以按接入语义复制")

        existing = Skill.objects.filter(
            owner_user_id=user_id,
            copied_from_skill_id=source_skill.skill_id,
        ).first()
        if existing:
            return existing

        from apps.skills.services.publish_service import _resolve_unique_slug

        with transaction.atomic():
            locked_source = Skill.objects.select_for_update().get(
                skill_id=source_skill.skill_id,
            )
            existing = Skill.objects.filter(
                owner_user_id=user_id,
                copied_from_skill_id=locked_source.skill_id,
            ).first()
            if existing:
                return existing

            copy_slug = _resolve_unique_slug(
                owner_user_id=user_id,
                slug=f"{locked_source.slug}-copy",
            )
            acquired = Skill.objects.create(
                owner_user_id=user_id,
                slug=copy_slug,
                name=locked_source.name,
                description=locked_source.description,
                emoji=locked_source.emoji,
                category=locked_source.category,
                source=Skill.SOURCE_USER,
                visibility=Skill.VISIBILITY_PRIVATE,
                organization_id=None,
                copied_from_skill=locked_source,
                latest_version_seq=locked_source.latest_version_seq,
                package_id=locked_source.package_id,
                agents_json=locked_source.agents_json,
                quick_use_json=locked_source.quick_use_json,
                install_content_hash=locked_source.install_content_hash,
            )
            source_versions = list(
                SkillPublishedVersion.objects.filter(skill=locked_source)
            )
            SkillPublishedVersion.objects.bulk_create([
                SkillPublishedVersion(
                    skill=acquired,
                    version_seq=version.version_seq,
                    version_label=version.version_label,
                    bundle_oss_key=version.bundle_oss_key,
                    bundle_sha256=version.bundle_sha256,
                    local_content_hash=version.local_content_hash,
                    quick_use_json=version.quick_use_json,
                    change_note=version.change_note,
                    published_by=version.published_by,
                    review_status=SkillPublishedVersion.REVIEW_NOT_REQUIRED,
                )
                for version in source_versions
            ])

        logger.info(
            "skill_service.organization_snapshot_acquired source=%s copy=%s user=%s",
            source_skill.skill_id,
            acquired.skill_id,
            user_id,
        )
        return acquired

    @classmethod
    def _sync_sub_agent_templates(
        cls,
        *,
        space_id: UUID,
        canonical_key: str,
        source: str,
        user_skill: Optional[Skill] = None,
        device_agents: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """启用动作的副作用：委托 Writer。"""
        return AgentSkillLinkWriter.sync_sub_agent_templates(
            space_id=space_id,
            canonical_key=canonical_key,
            source=source,
            user_skill=user_skill,
            device_agents=device_agents,
        )

    @staticmethod
    def disable_skill(
        *,
        user_id: UUID,
        skill_canonical_key: str,
        remove: bool = False,
        forget_acquisition: bool = False,
    ) -> bool:
        """关闭用户级总闸；``remove=True`` 时另摘除该用户名下 Agent 携带行。

        ``forget_acquisition=True`` 仅供「从我的 Skill 删除」使用：删除显式获取记录，
        让非本人 Skill 退出「我的」货架；必须与 ``remove=True`` 同时使用。

        普通关闭（技能库关）：只写 ``UserSkillPreference.enabled=False``，
        **保留** ``AgentSkillLink`` 行。

        ：Skill HTTP 不再传 space_id；``remove`` 场景的 SubAgent 同步
        workspace 由每个受影响 Agent 的最近会话内部推导。
        """
        if not user_id or not skill_canonical_key:
            return False
        try:
            if remove and forget_acquisition:
                UserSkillPreferenceService.forget(
                    user_id=user_id,
                    skill_canonical_key=skill_canonical_key,
                )
            else:
                UserSkillPreferenceService.set_enabled(
                    user_id=user_id,
                    skill_canonical_key=skill_canonical_key,
                    enabled=False,
                )
        except UserSkillPreferenceError as exc:
            raise SkillServiceError(str(exc)) from exc

        if remove:
            from apps.agent.models import Agent as AgentModel

            for agent in AgentModel.objects.filter(
                owner_user_id=user_id, is_active=True,
            ).only("id", "organization_id", "is_default"):
                sync_space_id = AgentSkillLinkWriter.resolve_sync_space_id(agent)
                try:
                    AgentSkillLinkWriter.disable_or_detach(
                        agent_id=agent.id,
                        skill_canonical_key=skill_canonical_key,
                        sync_space_id=sync_space_id,
                        remove=True,
                    )
                except AgentSkillLinkLockedError:
                    # ：默认 Agent 锁定 skill 保留携带行，跳过该 Agent
                    logger.info(
                        "skill_service.remove_skipped_locked agent=%s skill=%s",
                        agent.id,
                        skill_canonical_key,
                    )

        logger.info(
            "skill_service.user_gate_%s user=%s skill=%s",
            "uninstalled" if remove else "disabled",
            user_id,
            skill_canonical_key,
        )
        return True

    # ---------- set_visibility ----------

    @staticmethod
    def assert_organization_slug_unique(
        *,
        slug: str,
        organization_id: Optional[UUID],
        exclude_skill_id: Optional[UUID] = None,
    ) -> None:
        """组织精选标识名（slug）在同一组织内必须唯一（跨成员）。

        canonical key 仍是 ``user:<slug>``，启用链路不带 owner / skill UUID；
        同组织出现两个同 slug 会产生歧义。共享主路径走 publish，必须与
        ``set_visibility`` 共用本闸门。
        """
        if not organization_id:
            raise SkillServiceError("设为组织共享需要指定所属组织（organization_id）")
        normalized = (slug or "").strip()
        if not normalized:
            raise SkillServiceError("标识名不能为空")
        qs = Skill.objects.filter(
            organization_id=organization_id,
            visibility=Skill.VISIBILITY_ORGANIZATION,
            slug=normalized,
        )
        if exclude_skill_id is not None:
            qs = qs.exclude(skill_id=exclude_skill_id)
        if qs.exists():
            raise SkillServiceError(
                f"组织内已存在相同标识名的 Skill（slug={normalized}），请更换后再共享"
            )

    @staticmethod
    def set_visibility(
        *,
        skill_id: UUID,
        owner_user_id: UUID,
        visibility: str,
        organization_id: Optional[UUID] = None,
    ) -> Skill:
        """切换可见范围（D5 / §6.4，仅 owner 可调）。"""
        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")
        if str(skill.owner_user_id) != str(owner_user_id):
            raise SkillServiceError("只有 owner 才能修改可见范围")

        from apps.skills.services.publish_service import SkillPublishService
        target = (visibility or "").strip().lower()

        # ：设为团队共享必须带 organization_id，否则会写出 visibility=organization 但
        # organization_id=NULL 的「半生效」数据——owner 自己看得到、队友列表里查不到。
        # 在改 visibility 之前先校验，避免落到不一致状态。
        if target == Skill.VISIBILITY_ORGANIZATION and not organization_id:
            raise SkillServiceError("设为组织共享需要指定所属组织（organization_id）")

        if target == Skill.VISIBILITY_ORGANIZATION:
            SkillService.assert_organization_slug_unique(
                slug=skill.slug,
                organization_id=organization_id,
                exclude_skill_id=skill.skill_id,
            )

        skill = SkillPublishService.set_visibility(skill, target)

        # organization_id 维护：团队可见时强制绑定到目标团队；非团队可见时清空。
        if target == Skill.VISIBILITY_ORGANIZATION:
            if str(skill.organization_id) != str(organization_id):
                skill.organization_id = organization_id
                skill.save(update_fields=["organization_id", "updated_at"])
        elif skill.organization_id is not None:
            skill.organization_id = None
            skill.save(update_fields=["organization_id", "updated_at"])

        return skill

    # ---------- set_category ----------

    @staticmethod
    def set_category(
        *,
        skill_id: UUID,
        owner_user_id: UUID,
        category: Optional[str],
    ) -> Skill:
        """修改 Skill 分类（仅 owner 可调）。

        ：不再依赖 space_id 定位 sandbox；按 skill 的 owner + visibility
        找到实际 sandbox 目录（个人 / 组织两条路径）并同步 SKILL.md。
        """
        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")
        if str(skill.owner_user_id) != str(owner_user_id):
            raise SkillPermissionError("只有 owner 才能修改分类")

        normalized_category = SkillService._normalize_category(category)
        skill.category = normalized_category
        skill.save(update_fields=["category", "updated_at"])

        try:
            SkillService._sync_sandbox_skill_category(
                skill=skill,
                category=normalized_category,
            )
        except Exception:
            logger.warning(
                "skill_service.category_writeback failed skill=%s",
                skill.skill_id,
                exc_info=True,
            )
        return skill

    # ---------- set_quick_use ----------

    @staticmethod
    def set_quick_use(
        *,
        skill_id: UUID,
        owner_user_id: UUID,
        quick_use: Optional[List[Dict[str, Any]]],
    ) -> Skill:
        """更新「快速使用」preset 列表草稿（仅 owner）。

        写 ``Skill.quick_use_json``（草稿工作副本）；下次发布时由 publish_from_zip
        快照进对应 SkillPublishedVersion.quick_use_json（随版本不可变）。
        传 None / 空列表 = 清空草稿。
        """
        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")
        if str(skill.owner_user_id) != str(owner_user_id):
            raise SkillPermissionError("只有 owner 才能编辑快速使用")

        skill.quick_use_json = quick_use or []
        skill.save(update_fields=["quick_use_json", "updated_at"])
        return skill

    @staticmethod
    def _sync_sandbox_skill_category(*, skill: Skill, category: str) -> None:
        if not skill.slug:
            return
        for location in _sandbox_locations_for_skill(skill):
            skill_dir = os.path.realpath(location)
            md_path = os.path.join(skill_dir, "SKILL.md")
            if not os.path.isfile(md_path):
                continue
            with open(md_path, "r", encoding="utf-8") as f:
                raw = f.read()
            updated = SkillService._apply_skill_md_category(raw, category)
            if updated != raw:
                with open(md_path, "w", encoding="utf-8") as f:
                    f.write(updated)

    @staticmethod
    def _apply_skill_md_category(content: str, category: str) -> str:
        import re

        stripped = content.lstrip()
        leading = content[:len(content) - len(stripped)]
        match = re.match(r"^(---\s*\n)(.*?)(\n---\s*\n?)(.*)$", stripped, re.DOTALL)
        category = (category or "").strip()

        if not match:
            if not category:
                return content
            return f"{leading}---\nmetadata:\n  tabtin:\n    category: {category}\n---\n\n{stripped}"

        start, body, end, rest = match.groups()
        lines = body.split("\n")

        def indent(line: str) -> int:
            return len(line) - len(line.lstrip(" \t"))

        # 移除旧 category（顶层 category 或 metadata.tabtin.category），再按新值补回。
        # 不能删除其他嵌套对象里的 category，否则会破坏用户自定义元数据。
        next_lines: list[str] = []
        metadata_idx = -1
        tabtin_idx = -1
        stack: list[tuple[int, str]] = []
        for line in lines:
            stripped_line = line.strip()
            if not stripped_line:
                next_lines.append(line)
                continue
            current_indent = indent(line)
            while stack and current_indent <= stack[-1][0]:
                stack.pop()
            parent_path = [name for _, name in stack]

            if parent_path == [] and re.match(r"^category\s*:", line):
                continue
            if parent_path == ["metadata", "tabtin"] and re.match(r"^[ \t]+category\s*:", line):
                continue
            next_lines.append(line)

            key_match = re.match(r"^([ \t]*)([A-Za-z0-9_-]+)\s*:\s*(?:#.*)?$", line)
            if key_match:
                stack.append((current_indent, key_match.group(2)))

        lines = next_lines
        for idx, line in enumerate(lines):
            if re.match(r"^metadata\s*:\s*$", line):
                metadata_idx = idx
                break

        if category:
            if metadata_idx >= 0:
                metadata_indent = indent(lines[metadata_idx])
                metadata_end = len(lines)
                for idx in range(metadata_idx + 1, len(lines)):
                    line = lines[idx]
                    if not line.strip():
                        continue
                    if indent(line) <= metadata_indent:
                        metadata_end = idx
                        break
                for idx in range(metadata_idx + 1, metadata_end):
                    if re.match(r"^[ \t]+tabtin\s*:\s*$", lines[idx]):
                        tabtin_idx = idx
                        break
                if tabtin_idx >= 0:
                    child_indent = " " * (indent(lines[tabtin_idx]) + 2)
                    lines.insert(tabtin_idx + 1, f"{child_indent}category: {category}")
                else:
                    metadata_child = " " * (metadata_indent + 2)
                    lines.insert(metadata_idx + 1, f"{metadata_child}tabtin:\n{metadata_child}  category: {category}")
            else:
                lines.append("metadata:")
                lines.append("  tabtin:")
                lines.append(f"    category: {category}")

        return leading + start + "\n".join(lines).rstrip() + end + rest

    # ---------- discard draft ----------

    @staticmethod
    def discard_draft(
        *,
        owner_user_id: UUID,
        skill_id: UUID,
    ) -> bool:
        """丢弃从未发布过的草稿（D15）。

        前置条件：
        - owner = 当前 user
        - 没有 PublishedVersion 行
        他人 Agent 仍携带也不拦：丢掉的是 owner 自己的草稿，指向该原件的携带行一并清掉。
        """
        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")
        if str(skill.owner_user_id) != str(owner_user_id):
            raise SkillPermissionError("只有 owner 才能丢弃")

        if skill.published_versions.exists():
            raise SkillServiceError("只能丢弃从未发布过的草稿")

        links = AgentSkillLink.objects.filter(skill_id=skill.skill_id)

        slug_snapshot = skill.slug
        skill_snapshot = skill  # 保留 ORM 引用以在 delete 后仍可读 owner/org 做 sandbox 清理
        with transaction.atomic():
            links.delete()
            SkillEnablement.objects.filter(skill_id=skill.skill_id).delete()
            skill.delete()

        try:
            SkillService._remove_sandbox_copy(skill=skill_snapshot)
        except Exception:
            logger.warning(
                "skill_service.discard sandbox cleanup failed skill=%s",
                skill_id, exc_info=True,
            )

        logger.info("skill_service.discarded skill=%s slug=%s", skill_id, slug_snapshot)
        return True

    # ---------- delete (含已发布) ----------

    @staticmethod
    def delete_skill(
        *,
        owner_user_id: UUID,
        skill_id: UUID,
    ) -> bool:
        """删除 owner 自己的 user skill（**含已发布**）。

        与 ``discard_draft`` 的区别：discard_draft 只允许「从未发布过」的草稿；本方法
        放宽到已发布的 skill——这是 owner 的最终逃生口（已发布的 owner skill 在 Mine
        过去没有任何删除入口，一旦在别处停用就既不能重开也不能删）。

        清理范围：
        - SkillPublishedVersion：FK ``on_delete=CASCADE``，随 ``skill.delete()`` 级联删（同 PG 库）。
        - AgentSkillLink：显式删除 owner Agent 的携带行。
        - SkillEnablement：删除已经失去云端 Skill 身份的设备安装登记。
        - 本地 sandbox 副本：按 owner 启用过的各 Space 清理。

        前置条件：
        - owner = 当前 user（仅 owner 可删）；
        - 私有 / 公开 Skill 即使仍被其他人携带，也允许删除原件，并摘掉指向该原件的携带行；
        - 组织精选若仍有旧式成员引用，先迁移为成员个人快照再下架。

        注：关联的 Package Registry Package（``package_id`` 跨库软引用）不在此删除——
        跨库且影响面大，留作运维 / 后续清理。返回 True 表示删除成功。
        """
        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")
        if str(skill.owner_user_id) != str(owner_user_id):
            raise SkillPermissionError("只有 owner 才能删除")

        slug = skill.slug
        skill_snapshot = skill
        with transaction.atomic():
            skill = Skill.objects.select_for_update().get(skill_id=skill_id)
            links = AgentSkillLink.objects.filter(skill_id=skill.skill_id)
            if skill.visibility == Skill.VISIBILITY_ORGANIZATION:
                # 即使没有 Agent link，也可能存在 preference-only / device-only
                # 的历史接入事实；组织下架统一走幂等迁移，不能只看携带集。
                SkillService._migrate_legacy_organization_links(skill=skill)
                links = AgentSkillLink.objects.filter(skill_id=skill.skill_id)
            links.delete()
            SkillEnablement.objects.filter(skill_id=skill.skill_id).delete()
            skill.delete()

        try:
            SkillService._remove_sandbox_copy(skill=skill_snapshot)
        except Exception:
            logger.warning(
                "skill_service.delete sandbox cleanup failed skill=%s", skill_id,
                exc_info=True,
            )

        logger.info("skill_service.deleted skill=%s slug=%s", skill_id, slug)
        return True

    @classmethod
    def _migrate_legacy_organization_links(cls, *, skill: Skill) -> None:
        """删除旧组织快照前，把历史共享引用迁移为各成员的个人快照。"""
        if skill.visibility != Skill.VISIBILITY_ORGANIZATION:
            raise SkillServiceError("只有组织精选可以迁移历史成员引用")

        owner_ids = {
            str(user_id)
            for user_id in (
                AgentSkillLink.objects.filter(skill_id=skill.skill_id)
                .exclude(agent__owner_user_id=skill.owner_user_id)
                .values_list("agent__owner_user_id", flat=True)
                .distinct()
            )
            if user_id is not None
        }
        owner_ids.update(
            str(user_id)
            for user_id in (
                SkillEnablement.objects.filter(skill_id=skill.skill_id)
                .exclude(device__user_id=skill.owner_user_id)
                .values_list("device__user_id", flat=True)
                .distinct()
            )
            if user_id is not None
        )

        # Preference 只有 canonical key，没有 source skill_id。仅当当前用户在其
        # 所属组织中对该 key 只有唯一组织来源时才迁移，避免跨组织同 slug 错归。
        from apps.tabtinspace.models import OrganizationMember

        preference_user_ids = (
            UserSkillPreference.objects.filter(
                skill_canonical_key=skill.canonical_key,
            )
            .exclude(user_id=skill.owner_user_id)
            .values_list("user_id", flat=True)
            .distinct()
        )
        for preference_user_id in preference_user_ids:
            if Skill.objects.filter(
                owner_user_id=preference_user_id,
                slug=skill.slug,
            ).exists():
                continue
            organization_ids = OrganizationMember.objects.filter(
                user_id=preference_user_id,
            ).values_list("organization_id", flat=True)
            matching_sources = Skill.objects.filter(
                visibility=Skill.VISIBILITY_ORGANIZATION,
                organization_id__in=organization_ids,
                slug=skill.slug,
            ).count()
            if matching_sources == 1:
                owner_ids.add(str(preference_user_id))

        for member_user_id in owner_ids:
            acquired = cls._copy_organization_snapshot_for_user(
                source_skill=skill,
                user_id=member_user_id,
            )
            with transaction.atomic():
                legacy_links = list(
                    AgentSkillLink.objects.select_for_update().filter(
                        skill_id=skill.skill_id,
                        agent__owner_user_id=member_user_id,
                    )
                )
                for legacy in legacy_links:
                    target, created = AgentSkillLink.objects.get_or_create(
                        agent_id=legacy.agent_id,
                        skill_canonical_key=acquired.canonical_key,
                        defaults={
                            "skill_id": acquired.skill_id,
                            "source": SOURCE_USER,
                            "enabled": legacy.enabled,
                            "config_json": legacy.config_json,
                        },
                    )
                    if not created:
                        target.skill_id = acquired.skill_id
                        target.source = SOURCE_USER
                        target.enabled = legacy.enabled
                        target.config_json = legacy.config_json
                        target.save(update_fields=[
                            "skill_id", "source", "enabled", "config_json", "updated_at",
                        ])
                    legacy.delete()

                old_preference = UserSkillPreference.objects.filter(
                    user_id=member_user_id,
                    skill_canonical_key=skill.canonical_key,
                ).first()
                if old_preference:
                    UserSkillPreference.objects.update_or_create(
                        user_id=member_user_id,
                        skill_canonical_key=acquired.canonical_key,
                        defaults={"enabled": old_preference.enabled},
                    )
                    old_preference.delete()

                legacy_installs = list(
                    SkillEnablement.objects.select_for_update().filter(
                        skill_id=skill.skill_id,
                        device__user_id=member_user_id,
                    )
                )
                for legacy_install in legacy_installs:
                    # 服务端不能伪造客户端磁盘已从旧 key 搬到新 key；删除旧账本，
                    # 让客户端按个人副本的 package/version 重新物化并如实上报。
                    legacy_install.delete()

            logger.info(
                "skill_service.legacy_organization_links_migrated source=%s copy=%s user=%s",
                skill.skill_id,
                acquired.skill_id,
                member_user_id,
            )

    # ---------- publish ----------

    @staticmethod
    def publish_skill(
        *,
        skill_id: UUID,
        owner_user_id: UUID,
        organization_id: Optional[UUID] = None,
        agent_id: Optional[UUID] = None,
        version_label: Optional[str] = None,
        visibility: Optional[str] = None,
        change_note: str = "",
        files: Optional[List[Dict[str, Any]]] = None,
        quick_use: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """发布新版本（PRD §6.3）。

        ：``space_id`` 已下线；organization 直接来自 skill.organization_id
        或调用方传入。``agent_id`` 仅用于未来 SubAgent 同步（当前发布不触发同步）。
        """
        from apps.skills.models import SkillPublishedVersion

        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")
        if str(skill.owner_user_id) != str(owner_user_id):
            raise SkillPermissionError("只有 owner 才能发布")

        target_visibility = skill.visibility
        if visibility:
            target_vis = visibility.strip().lower()
            if target_vis in {Skill.VISIBILITY_PRIVATE, Skill.VISIBILITY_ORGANIZATION, Skill.VISIBILITY_PUBLIC}:
                target_visibility = target_vis

        effective_org_id = skill.organization_id or organization_id
        if effective_org_id and not isinstance(effective_org_id, UUID):
            try:
                effective_org_id = UUID(str(effective_org_id))
            except (TypeError, ValueError):
                effective_org_id = None

        if files:
            publish_entries = SkillService._entries_from_publish_files(files)
        else:
            publish_entries = SkillService._read_sandbox_files(skill)
            if not publish_entries:
                raise SkillServiceError("sandbox 目录为空或不存在，无法发布")

        if version_label:
            version_label = normalize_semver_label(version_label)
        else:
            raise SkillServiceError(
                "缺少发布版本号 version_label（Semantic Versioning 三段，如 0.0.1）"
            )

        from apps.services.package_registry.services import compute_bundle_sha256
        published_local_hash = compute_bundle_sha256(
            [(path, hashlib.sha256(content).hexdigest()) for path, content in publish_entries]
        )

        SkillService._validate_publish_version_policy(skill, version_label)
        SkillService._validate_publish_content_unique(skill, published_local_hash)

        # 共享给组织走 create + publish(visibility=organization)，不经过 set_visibility；
        # 必须在这里按组织精选已有标识名拦重复，否则不同成员会各建一条同 slug 快照。
        if (
            visibility
            and target_visibility == Skill.VISIBILITY_ORGANIZATION
            and not effective_org_id
        ):
            raise SkillServiceError("设为组织共享需要指定所属组织（organization_id）")
        if target_visibility == Skill.VISIBILITY_ORGANIZATION:
            SkillService.assert_organization_slug_unique(
                slug=skill.slug,
                organization_id=effective_org_id,
                exclude_skill_id=skill.skill_id,
            )

        zip_bytes = SkillService._build_zip(publish_entries, skill.slug)

        from apps.skills.services.publish_service import SkillPublishService
        SkillPublishService.publish_from_zip(
            zip_bytes,
            visibility=target_visibility,
            user_id=owner_user_id,
            organization_id=effective_org_id,
            change_note=change_note,
            known_skill=skill,
            version_label=version_label,
            quick_use_json=quick_use,
        )

        # 发布带的 visibility 必须落到 Skill.visibility——否则「未发布 skill 设为团队共享」
        # 走 publish 路径时只创建了版本 + 设了 organization_id，visibility 仍是 private，
        # 队友看不到、要再点一次才生效。organization 可见必须有 organization_id。
        skill.refresh_from_db()
        publish_update_fields: list[str] = []
        if effective_org_id and skill.organization_id != effective_org_id:
            skill.organization_id = effective_org_id
            publish_update_fields.append("organization_id")
        if visibility and skill.visibility != target_visibility:
            skill.visibility = target_visibility
            publish_update_fields.append("visibility")
        if publish_update_fields:
            publish_update_fields.append("updated_at")
            skill.save(update_fields=publish_update_fields)

        if skill.latest_version_seq is not None:
            SkillPublishedVersion.objects.filter(
                skill=skill,
                version_seq=skill.latest_version_seq,
            ).update(local_content_hash=published_local_hash)

        logger.info(
            "skill_service.published skill=%s version=%s",
            skill.skill_id, skill.latest_version_seq,
        )
        return {
            **skill.to_index_entry(),
            "latest_version_seq": skill.latest_version_seq,
            "install_content_hash": skill.install_content_hash,
        }

    @staticmethod
    def _decode_publish_file_bytes(item: Dict[str, Any], rel: str) -> bytes:
        """Decode a renderer-submitted file item ``{content, encoding?}`` to raw bytes.

        - ``encoding == "base64"`` → base64 解码成字节（图片/字体/图标等二进制资源），
          与前端 ``arrayBufferToBase64`` 严格往返；
        - 省略 / ``"text"`` → ``content`` 当 UTF-8 文本编码（向后兼容）。

        import / publish 两条 files[] 落盘路径共用本解码逻辑，行为一致。
        """
        encoding = str(item.get("encoding") or "text").strip().lower()
        content = item.get("content")
        if encoding == "base64":
            if not isinstance(content, str):
                raise SkillServiceError(f"二进制文件内容必须是 base64 字符串: {rel}")
            try:
                # validate=True：非 base64 字母表字符直接报错，避免静默解出错字节。
                return base64.b64decode(content, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise SkillServiceError(f"base64 解码失败: {rel}") from exc
        if not isinstance(content, str):
            raise SkillServiceError(f"文件内容必须是字符串: {rel}")
        return content.encode("utf-8")

    @staticmethod
    def _entries_from_publish_files(files: List[Dict[str, Any]]) -> List[tuple]:
        """Normalize renderer-submitted publish files into zip entries.

        Electron owns the editable platform-data working copy. For Mine publish,
        the renderer sends the exact SKILL.md content the user just saved, so
        Django does not have to guess whether its sandbox root matches Electron's.

        二进制资源（``encoding == "base64"``）解码成字节落盘；总大小预算按解码后的
        真实字节数计入（与 20MB 限制一致）。
        """
        from apps.skills.services.bundle_validator import SkillBundleValidator

        entries: List[tuple] = []
        total_bytes = 0
        found_skill_md = False
        for item in files or []:
            rel = str(item.get("path") or "").replace("\\", "/").lstrip("/")
            if not rel or rel.endswith("/"):
                continue
            parts = [part for part in rel.split("/") if part]
            if not parts or any(part == ".." for part in parts):
                raise SkillServiceError(f"非法文件路径: {rel}")
            rel = "/".join(parts)
            # 客户端可能仍带上 .gitignore 等；与 zip 校验一致，跳过而非整包失败。
            if SkillBundleValidator.should_skip_entry(rel):
                continue
            raw = SkillService._decode_publish_file_bytes(item, rel)
            if rel == "SKILL.md" or rel.endswith("/SKILL.md"):
                from apps.skills.services.publish_service import strip_skill_md_file_version
                raw = strip_skill_md_file_version(
                    raw.decode("utf-8", errors="replace"),
                ).encode("utf-8")
            total_bytes += len(raw)
            if total_bytes > SkillService._MAX_EXTRACTED_TOTAL:
                raise SkillServiceError("发布文件总大小超过限制 (20MB)")
            if rel == "SKILL.md" or rel.endswith("/SKILL.md"):
                found_skill_md = True
            entries.append((rel, raw))
        if not entries:
            raise SkillServiceError("没有可发布的文件")
        if not found_skill_md:
            raise SkillServiceError("发布文件必须包含 SKILL.md")
        return entries

    @staticmethod
    def _version_label_from_skill_md_entries(entries: List[tuple]) -> Optional[str]:
        """兼容读取历史 SKILL.md frontmatter 的 version。

        新发布版本以显式 ``version_label`` 和 ``SkillPublishedVersion`` 为真源；
        这里仅供旧文件解析、导入展示等历史读取场景使用。
        """
        from apps.skills.services.skill_doc_parser import parse_skill_doc

        for rel, raw in entries:
            rel_path = str(rel).replace("\\", "/").lstrip("/")
            if rel_path != "SKILL.md" and not rel_path.endswith("/SKILL.md"):
                continue
            text = raw.decode("utf-8", errors="replace")
            parsed = parse_skill_doc(text)
            ver = (parsed.get("version") or "").strip()
            if not ver:
                return None
            try:
                return normalize_semver_label(ver)
            except ValueError:
                return None
        return None

    @staticmethod
    def _normalize_category(category: Optional[str]) -> str:
        value = (category or "").strip().lower()
        if not value:
            return ""
        if value not in VALID_SKILL_CATEGORIES:
            raise SkillServiceError(
                "category 必须是以下之一："
                + " / ".join(sorted(VALID_SKILL_CATEGORIES))
            )
        return value

    @staticmethod
    def _validate_publish_version_policy(skill: Skill, version_label: str) -> None:
        from apps.skills.models import SkillPublishedVersion

        normalized_new = version_label
        existing_display: list[str] = []
        for row in SkillPublishedVersion.objects.filter(skill=skill).only(
            "version_label", "version_seq",
        ):
            try:
                existing_display.append(
                    display_semver_for_published_version(
                        row.version_label, row.version_seq,
                    )
                )
            except ValueError:
                continue

        max_label = max_semver_label(existing_display) or max_semver_label(
            SkillPublishedVersion.objects.filter(skill=skill)
            .exclude(version_label="")
            .values_list("version_label", flat=True)
        )
        if normalized_new in existing_display:
            raise SkillVersionConflictError(
                f"版本号 {version_label} 已存在，请使用新的版本号",
                requested_version=normalized_new,
                latest_version=max_label or normalized_new,
            )
        if max_label and compare_semver(normalized_new, max_label) <= 0:
            raise SkillVersionConflictError(
                f"新版本号必须高于已发布的最高版本 {max_label}",
                requested_version=normalized_new,
                latest_version=max_label,
            )

    @staticmethod
    def _validate_publish_content_unique(skill: Skill, local_content_hash: str) -> None:
        from apps.skills.models import SkillPublishedVersion

        if not local_content_hash:
            return
        duplicate = SkillPublishedVersion.objects.filter(
            skill=skill,
            local_content_hash=local_content_hash,
        ).exists()
        if duplicate:
            raise SkillServiceError(
                "当前内容与某个已发布版本完全相同，无需再次发布"
            )

    @staticmethod
    def activate_skill_version(
        *,
        skill_id: UUID,
        owner_user_id: UUID,
        agent_id: UUID,
        version_seq: int,
    ) -> Dict[str, Any]:
        """切换 owner 在指定 Agent 上使用的 Skill 版本（不创建新版本）。

        ：以 Agent 为身份锚点；不再传 space_id。
        """
        from apps.skills.models import SkillPublishedVersion

        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")
        if str(skill.owner_user_id) != str(owner_user_id):
            raise SkillPermissionError("只有 owner 才能切换版本")

        version = SkillPublishedVersion.objects.filter(
            skill=skill,
            version_seq=version_seq,
        ).first()
        if not version:
            raise SkillServiceError(f"版本 {version_seq} 不存在")

        link = AgentSkillLink.objects.filter(
            agent_id=agent_id,
            skill_id=skill.skill_id,
        ).first()
        if not link:
            raise SkillServiceError("未启用此 Skill，无法切换版本")

        active_hash = version.local_content_hash or version.bundle_sha256 or ""

        return {
            "skill_id": str(skill.skill_id),
            "installed_version_seq": version_seq,
            "version_label": version.version_label,
            "install_content_hash": active_hash,
            "package_id": str(skill.package_id) if skill.package_id else None,
        }

    @staticmethod
    def _read_sandbox_files(skill: Skill) -> List[tuple]:
        """按当前 skill 的 sandbox 目录（团队优先，回落个人）读文件。"""
        for location in _sandbox_locations_for_skill(skill):
            skill_dir = os.path.realpath(location)
            if not os.path.isdir(skill_dir):
                continue
            entries: List[tuple] = []
            for root, _dirs, files in os.walk(skill_dir, followlinks=False):
                for fname in files:
                    fpath = os.path.join(root, fname)
                    real_fpath = os.path.realpath(fpath)
                    if (
                        not real_fpath.startswith(skill_dir + os.sep)
                        and real_fpath != skill_dir
                    ):
                        continue
                    rel = os.path.relpath(fpath, skill_dir)
                    try:
                        with open(fpath, "rb") as f:
                            content = f.read()
                        entries.append((rel, content))
                    except Exception:
                        pass
            if entries:
                return entries
        return []

    @staticmethod
    def _build_zip(entries: List[tuple], slug: str) -> bytes:
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel_path, content in entries:
                # Package Registry bundle hashes are compared with the local
                # skill directory hash. Keep paths relative to the skill root
                # (`SKILL.md`), not wrapped in another slug directory, or a
                # freshly published Mine skill will immediately look dirty.
                zf.writestr(rel_path, content)
        return buf.getvalue()

    # ---------- SKILL.md skeleton ----------

    @staticmethod
    def generate_skill_skeleton(
        name: str,
        description: str,
        *,
        category: str = "",
        slug: str = "",
    ) -> str:
        """生成新标准格式 SKILL.md 骨架。

        - ``name`` = kebab-case 机器 id（= slug / 目录名）
        - 展示名进 ``metadata.tabtin.displayName``
        - 分类进 ``metadata.tabtin.category``

        入参 ``name`` 是用户输入的展示名；``slug`` 缺省时按展示名归一化。
        """
        from apps.skills.services.slug_utils import slugify_skill_name
        display_name = (name or "").strip() or "Skill"
        machine_slug = (slug or "").strip() or slugify_skill_name(display_name)
        safe_display = display_name.replace('\\', '\\\\').replace('"', '\\"')
        # 与 Electron generateSkillSkeleton 对齐：缺省 description 时用展示名，
        # 避免新建 skill 未填简介时 frontmatter description 为空导致无法保存发布。
        effective_description = (description or "").strip() or display_name
        safe_desc = effective_description.replace('\\', '\\\\').replace('"', '\\"')
        category_line = f"    category: {category}\n" if category else ""
        return f"""---
name: {machine_slug}
description: "{safe_desc}"
metadata:
  tabtin:
    displayName: "{safe_display}"
{category_line}---

# {display_name}

## 什么时候用这个 Skill

<!--
描述触发条件：用户对话里出现什么关键词 / 意图时，Agent 该调用这个 Skill。

好的写法：
- 关键词列表：「周报」「本周总结」「weekly report」
- 触发条件：用户要求整理一段时间内的工作产出
- 反例（不该触发）：用户只是随口提到"报告"但没有明确要求整理

差的写法：
- "当用户需要的时候"（太模糊，Agent 无法判断）
-->

## 步骤

<!-- 让 Agent 按什么顺序做事。每步一行，越具体越好。 -->

1. ...
2. ...

## 注意事项

<!-- 边界条件、不要做什么、易错点 -->

- ...
"""

    # ---------- list visible ----------

    @staticmethod
    def list_visible_skills(
        *,
        user_id: UUID,
        organization_id: Optional[UUID] = None,
        agent_id: Optional[UUID] = None,
        eligibility_context: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """列出当前 (user, organization[, agent]) 上下文里 4 来源所有 skill 索引项。

        ：Skill HTTP 不再传 space_id。visibility 解析靠 organization_id；
        携带态解析靠 agent_id。均缺省时仅返回 owner 自有 skill。

        与 ``SkillsRegistryService.list_available_skills`` 区别：本方法返回的
        列表不做 enablement 过滤，**所有可见 skill 都返回**（含未启用），
        并附带 ``enabled`` 字段标记当前状态。给 UI Skill 面板用。
        """
        if not user_id:
            return []

        resolved_agent_id: Optional[UUID] = agent_id
        resolved_org_id: Optional[str] = (
            str(organization_id) if organization_id else None
        )
        if resolved_agent_id:
            try:
                context = SkillService._resolve_agent_context(resolved_agent_id)
                resolved_agent_id = context.agent_id
                if not resolved_org_id:
                    resolved_org_id = str(context.organization_id)
            except SkillServiceError:
                # Agent 无效不阻断列表，只是失去携带态显示。
                resolved_agent_id = None

        platform_skills = SkillsRegistryService.list_platform_skills()
        app_skills = SkillsRegistryService.list_app_skills()
        device_skills = SkillsRegistryService.list_device_skills()
        user_skills = SkillsRegistryService.list_user_skills_visible(
            user_id=str(user_id),
            organization_id=resolved_org_id,
            agent_id=str(resolved_agent_id) if resolved_agent_id else None,
        )

        merged = SkillsRegistryService.merge_skills(
            platform_skills=platform_skills,
            app_skills=app_skills,
            device_skills=device_skills,
            user_skills=user_skills,
        )

        # 技能库开关 = 用户总闸；携带态仅在有 agent 时解析。
        user_gate = UserSkillPreferenceService.map_for_user(user_id)
        skill_state: Dict[str, Dict[str, Any]] = {}
        if resolved_agent_id:
            skill_state = SkillsRegistryService.resolve_agent_skill_state(
                None,
                agent_id=str(resolved_agent_id),
                user_id=str(user_id),
            )

        user_skill_ids = [
            entry.get("skill_id") for entry in merged
            if entry.get("source") == SOURCE_USER and entry.get("skill_id")
        ]
        review_map = SkillService._batch_review_status(user_skill_ids) if user_skill_ids else {}

        installed_label_pairs: List[tuple] = []
        for entry in merged:
            key = entry.get("skill_key", "")
            row = skill_state.get(key)
            # 保持 renderer 的 ``installed`` 分组契约：在终态模型中它表示
            # 当前 Agent 已携带（含停用），不是服务端声称设备已完成物化。
            entry["installed"] = bool(row and row.get("carried") is True)
            # 技能库开关 = 用户级总闸；不再用 AgentSkillLink.enabled。
            entry["enabled"] = UserSkillPreferenceService.resolve_from_map(
                user_gate, key,
            )
            entry["agent_enabled"] = bool(row and row.get("agent_enabled") is True)
            entry["installed_on_device"] = bool(
                row and row.get("installed_on_device") is True
            )
            installed_seq = row.get("installed_version_seq") if row else None
            entry["installed_version_seq"] = installed_seq
            entry["install_content_hash"] = (
                row.get("install_content_hash") if row else None
            )
            # 先占位，批量查完再填 SemVer label（详情页「当前在用」徽章用）。
            entry["installed_version_label"] = None

            sid = entry.get("skill_id")
            if sid and installed_seq is not None:
                installed_label_pairs.append((sid, installed_seq))
            if sid and sid in review_map:
                info = review_map[sid]
                entry["latest_review_status"] = info["latest_review_status"]
                entry["latest_approved_version_seq"] = info["latest_approved_version_seq"]

        label_map = SkillService._batch_installed_version_labels(installed_label_pairs)
        if label_map:
            for entry in merged:
                sid = entry.get("skill_id")
                seq = entry.get("installed_version_seq")
                if sid is None or seq is None:
                    continue
                label = label_map.get((str(sid), int(seq)))
                if label:
                    entry["installed_version_label"] = label

        return merged

    @staticmethod
    def _batch_installed_version_labels(
        pairs: List[tuple],
    ) -> Dict[tuple, str]:
        """批量解析 ``(skill_id, version_seq) → version_label``，供列表「当前在用」展示。

        一次查询覆盖本页所有已安装 user skill，避免按 entry N+1。
        无匹配 / 空 label 的 pair 不进入结果 map。
        """
        from apps.skills.models import SkillPublishedVersion

        unique: set = set()
        for sid, seq in pairs:
            if sid is None or seq is None:
                continue
            try:
                unique.add((str(sid), int(seq)))
            except (TypeError, ValueError):
                continue
        if not unique:
            return {}

        skill_ids = {sid for sid, _ in unique}
        seqs = {seq for _, seq in unique}
        rows = (
            SkillPublishedVersion.objects
            .filter(skill_id__in=skill_ids, version_seq__in=seqs)
            .only("skill_id", "version_seq", "version_label")
        )
        result: Dict[tuple, str] = {}
        for row in rows:
            key = (str(row.skill_id), int(row.version_seq))
            if key not in unique:
                continue
            label = (row.version_label or "").strip()
            if label:
                result[key] = label
        return result

    @staticmethod
    def _batch_review_status(skill_ids: list) -> Dict[str, Dict[str, Any]]:
        from apps.skills.models import SkillPublishedVersion
        result: Dict[str, Dict[str, Any]] = {}
        if not skill_ids:
            return result
        versions = (
            SkillPublishedVersion.objects
            .filter(skill_id__in=skill_ids)
            .order_by("skill_id", "-version_seq")
        )
        seen_latest: set = set()
        approved_map: Dict[str, int] = {}
        for v in versions:
            sid = str(v.skill_id)
            if sid not in seen_latest:
                seen_latest.add(sid)
                result[sid] = {
                    "latest_review_status": v.review_status,
                    "latest_approved_version_seq": None,
                }
            if (
                v.review_status == SkillPublishedVersion.REVIEW_APPROVED
                and sid not in approved_map
            ):
                approved_map[sid] = v.version_seq
        for sid, seq in approved_map.items():
            if sid in result:
                result[sid]["latest_approved_version_seq"] = seq
        return result

    # ---------- versions ----------

    @staticmethod
    def list_versions(
        *,
        skill_id: UUID,
        requesting_user_id: UUID,
    ) -> List[Dict[str, Any]]:
        from apps.skills.models import SkillPublishedVersion

        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")

        qs = SkillPublishedVersion.objects.filter(skill=skill).order_by("-version_seq")

        is_owner = str(skill.owner_user_id) == str(requesting_user_id)
        if not is_owner:
            qs = qs.filter(
                review_status__in=[
                    SkillPublishedVersion.REVIEW_NOT_REQUIRED,
                    SkillPublishedVersion.REVIEW_APPROVED,
                ],
            )

        return [
            {
                "version_seq": v.version_seq,
                "version_label": v.version_label,
                "change_note": v.change_note,
                "published_at": v.published_at.isoformat() if v.published_at else None,
                "review_status": v.review_status,
                "bundle_sha256": v.bundle_sha256,
                "local_content_hash": v.local_content_hash,
            }
            for v in qs
        ]

    # ---------- upgrade ----------

    @classmethod
    def upgrade_skill(
        cls,
        *,
        skill_id: UUID,
        user_id: UUID,
        agent_id: UUID,
        resolution: Optional[str] = None,
    ) -> Dict[str, Any]:
        """升级 Skill（PRD §6.6/§6.7 三选一）。

        ：以 Agent 为身份锚点；Workspace/device 由 Agent 最近会话内部解析。
        """
        from apps.skills.models import SkillPublishedVersion

        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")

        context = cls._resolve_agent_context(agent_id)
        link = AgentSkillLink.objects.filter(
            agent_id=context.agent_id,
            skill_id=skill.skill_id,
        ).first()
        if not link:
            raise SkillServiceError("未启用此 Skill，无法升级")
        if context.device_id is None:
            raise SkillServiceError(
                f"Agent 未绑定执行设备，无法读取 Skill 安装版本: {agent_id}"
            )
        installation = SkillEnablement.objects.filter(
            device_id=context.device_id,
            skill_canonical_key=skill.canonical_key,
        ).first()
        if installation is None:
            raise SkillServiceError(
                f"执行设备尚未上报该 Skill 的安装事实: {skill.canonical_key}"
            )

        if skill.latest_version_seq is None:
            raise SkillServiceError("此 Skill 尚无已发布版本")

        is_owner = str(skill.owner_user_id) == str(user_id)
        if is_owner:
            target_seq = skill.latest_version_seq
            target_hash = skill.install_content_hash
        else:
            resolved = cls._resolve_latest_approved_version(skill)
            target_seq = resolved[0]
            target_hash = resolved[1]
            if target_seq is None:
                raise SkillServiceError("此 Skill 尚无已通过审核的版本")

        if installation.installed_version_seq == target_seq:
            return {"status": "already_latest", "installed_version_seq": target_seq}

        _VALID_RESOLUTIONS = {"keep_local", "accept_new", "fork_as_copy"}
        if resolution and resolution not in _VALID_RESOLUTIONS:
            raise SkillServiceError(f"无效 resolution: {resolution!r}")

        has_local_changes = (
            installation.install_content_hash
            and installation.install_content_hash != target_hash
        )

        if has_local_changes and not resolution:
            return {
                "status": "conflict",
                "installed_version_seq": installation.installed_version_seq,
                "latest_version_seq": target_seq,
            }

        if resolution == "keep_local":
            return {
                "status": "kept_local",
                "installed_version_seq": installation.installed_version_seq,
                "latest_version_seq": target_seq,
            }

        if resolution == "fork_as_copy":
            fork_skill = cls._fork_as_copy(
                source_skill=skill,
                user_id=user_id,
                agent_id=context.agent_id,
            )
            return {
                "status": "forked",
                "installed_version_seq": installation.installed_version_seq,
                "latest_version_seq": target_seq,
                "fork_skill_id": str(fork_skill.skill_id),
                "fork_skill_name": fork_skill.name,
            }

        # accept_new：返回设备端应物化的目标；安装完成后由客户端上报登记。
        return {
            "status": "upgrade_required",
            "installed_version_seq": installation.installed_version_seq,
            "latest_version_seq": target_seq,
            "install_content_hash": target_hash,
            "package_id": str(skill.package_id) if skill.package_id else None,
        }

    # ---------- fork_as_copy ----------

    @classmethod
    def _fork_as_copy(
        cls,
        *,
        source_skill: Skill,
        user_id: UUID,
        agent_id: Optional[UUID] = None,
    ) -> Skill:
        """#7118：以 Agent 为身份锚点复制 skill；agent_id 缺省时不建立携带链。"""
        from apps.skills.services.publish_service import _resolve_unique_slug
        from apps.skills.services.slug_utils import slugify_skill_name

        fork_name = f"{source_skill.name}(我的副本)"
        # 幂等：同一用户对同一展示名已有副本时复用，避免连点 / 重复另存出两张同名卡。
        existing = (
            Skill.objects.filter(
                owner_user_id=user_id,
                name=fork_name,
                source=Skill.SOURCE_USER,
            )
            .order_by("created_at")
            .first()
        )
        if existing:
            if agent_id:
                AgentSkillLink.objects.get_or_create(
                    agent_id=agent_id,
                    skill_canonical_key=existing.canonical_key,
                    defaults={
                        "skill_id": existing.skill_id,
                        "source": SOURCE_USER,
                        "config_json": {},
                    },
                )
            return existing

        fork_slug = slugify_skill_name(fork_name)
        # slugify 会剥掉中文「(我的副本)」——fork slug 常与源相同；同 owner 唯一约束会撞。
        if fork_slug == (source_skill.slug or "").strip():
            fork_slug = f"{fork_slug}-copy" if fork_slug else "skill-copy"
        unique_slug = _resolve_unique_slug(owner_user_id=user_id, slug=fork_slug)
        if agent_id:
            unique_slug = cls._resolve_unique_agent_skill_slug(
                agent_id=agent_id, slug=unique_slug,
            )

        with transaction.atomic():
            fork = Skill.objects.create(
                owner_user_id=user_id,
                slug=unique_slug,
                name=fork_name,
                description=source_skill.description,
                emoji=source_skill.emoji,
                visibility=Skill.VISIBILITY_PRIVATE,
                source=Skill.SOURCE_USER,
            )
            if agent_id:
                AgentSkillLink.objects.create(
                    agent_id=agent_id,
                    skill_id=fork.skill_id,
                    skill_canonical_key=fork.canonical_key,
                    source=SOURCE_USER,
                    config_json={},
                )

        try:
            cls._copy_sandbox(
                source_skill=source_skill, dest_skill=fork,
            )
        except Exception:
            logger.warning("fork_as_copy sandbox copy failed", exc_info=True)

        return fork

    @staticmethod
    def _resolve_unique_agent_skill_slug(
        *,
        agent_id: UUID,
        slug: str,
    ) -> str:
        """保证 ``user:<slug>`` 在 Agent 携带集内尚未被占用。"""
        candidate = slug
        n = 2
        while AgentSkillLink.objects.filter(
            agent_id=agent_id,
            skill_canonical_key=f"user:{candidate}",
        ).exists():
            candidate = f"{slug}-{n}"
            n += 1
            if n > 100:
                raise SkillServiceError("副本 slug 与已启用 Skill 冲突，无法自动消解")
        return candidate

    @staticmethod
    def _copy_sandbox(*, source_skill: Skill, dest_skill: Skill) -> None:
        """把源 skill 的 sandbox 目录复制到目的 skill 的目标目录。"""
        import shutil

        dst_dir = os.path.realpath(_primary_sandbox_dir_for_skill(dest_skill))
        # 源侧允许在个人 / 组织两条路径任意一条命中。
        for src_location in _sandbox_locations_for_skill(source_skill):
            src_dir = os.path.realpath(src_location)
            if os.path.isdir(src_dir):
                shutil.copytree(src_dir, dst_dir, dirs_exist_ok=True)
                return

    # ---------- save_as_copy (公开入口) ----------

    @classmethod
    def save_as_copy(
        cls,
        *,
        source_skill_id: UUID,
        user_id: UUID,
        agent_id: Optional[UUID] = None,
    ) -> Skill:
        source = Skill.objects.filter(skill_id=source_skill_id).first()
        if not source:
            raise SkillNotFoundError(f"源 Skill 不存在: {source_skill_id}")
        return cls._fork_as_copy(
            source_skill=source, user_id=user_id, agent_id=agent_id,
        )

    # ---------- import ----------

    _MAX_IMPORT_ITEMS = 50

    @classmethod
    def import_skill(
        cls,
        *,
        user_id: UUID,
        organization_id: Optional[UUID] = None,
        agent_id: Optional[UUID] = None,
        source_skill_id: Optional[UUID] = None,
        name: Optional[str] = None,
        url: Optional[str] = None,
        files: Optional[list] = None,
        enable_agent_ids: Optional[List[str]] = None,
    ) -> tuple[Skill, Optional[List[Dict[str, Any]]], bool, List[str]]:
        """导入单个 Skill。

        ：以 (organization_id, agent_id) 为身份锚点；批量启用目标改为
        Agent 集合 ``enable_agent_ids``（Skill 归属 Agent，不再按 Space）。
        返回 ``(skill, normalized_files|None, already_exists, enabled_agent_ids)``。
        """
        agent_targets = cls._resolve_enable_agent_targets(
            user_id=user_id,
            enable_agent_ids=enable_agent_ids,
        )
        enabled_ids: List[str] = []
        if source_skill_id:
            skill = cls.save_as_copy(
                source_skill_id=source_skill_id,
                user_id=user_id,
                agent_id=agent_id,
            )
            enabled_ids = cls._apply_enable_agent_ids(
                user_id=user_id, skill=skill, enable_agent_ids=agent_targets,
            )
            return skill, None, False, enabled_ids
        if url:
            skill, normalized_files, already_exists = cls._import_from_url(
                user_id=user_id,
                organization_id=organization_id,
                agent_id=agent_id,
                url=url,
            )
            enabled_ids = cls._apply_enable_agent_ids(
                user_id=user_id, skill=skill, enable_agent_ids=agent_targets,
            )
            return skill, normalized_files, already_exists, enabled_ids
        if files:
            skill, normalized_files, already_exists = cls._import_from_files(
                user_id=user_id,
                organization_id=organization_id,
                agent_id=agent_id,
                files=files,
                name=name,
            )
            enabled_ids = cls._apply_enable_agent_ids(
                user_id=user_id, skill=skill, enable_agent_ids=agent_targets,
            )
            return skill, normalized_files, already_exists, enabled_ids
        raise SkillServiceError("导入请求缺少来源（source_skill_id / url / files）")

    @classmethod
    def import_skills_batch(
        cls,
        *,
        user_id: UUID,
        organization_id: Optional[UUID] = None,
        agent_id: Optional[UUID] = None,
        items: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """批量导入：同请求内逐项 ingest，per-item 成败。"""
        if not items:
            raise SkillServiceError("items 不能为空")
        if len(items) > cls._MAX_IMPORT_ITEMS:
            raise SkillServiceError(
                f"单次最多导入 {cls._MAX_IMPORT_ITEMS} 个 Skill，请分批"
            )

        results: List[Dict[str, Any]] = []
        ok_count = 0
        failed_count = 0
        import_agent_id: Optional[str] = str(agent_id) if agent_id else None

        for index, raw in enumerate(items):
            item = raw if isinstance(raw, dict) else {}
            try:
                source_skill_id = None
                raw_source = item.get("source_skill_id")
                if raw_source:
                    source_skill_id = UUID(str(raw_source))
                skill, normalized_files, already_exists, enabled_ids = cls.import_skill(
                    user_id=user_id,
                    organization_id=organization_id,
                    agent_id=agent_id,
                    source_skill_id=source_skill_id,
                    name=item.get("name"),
                    url=item.get("url"),
                    files=item.get("files"),
                    enable_agent_ids=item.get("enable_agent_ids"),
                )
                entry = skill.to_index_entry()
                entry["installed"] = True
                entry["enabled"] = (
                    import_agent_id is not None
                    and import_agent_id in {str(x) for x in enabled_ids}
                )
                entry["already_exists"] = already_exists
                if normalized_files:
                    entry["normalized_files"] = normalized_files
                if enabled_ids:
                    entry["enabled_agent_ids"] = enabled_ids
                state = None
                if import_agent_id:
                    state = SkillsRegistryService.resolve_agent_skill_state(
                        None,
                        agent_id=import_agent_id,
                        user_id=str(user_id),
                    ).get(skill.canonical_key)
                if state:
                    entry["installed_version_seq"] = state["installed_version_seq"]
                    entry["install_content_hash"] = state["install_content_hash"]
                    entry["enabled"] = bool(state["enabled"])
                    entry["installed_on_device"] = bool(
                        state["installed_on_device"]
                    )
                results.append({
                    "index": index,
                    "ok": True,
                    "already_exists": already_exists,
                    "skill": entry,
                    "normalized_files": normalized_files,
                    "enabled_agent_ids": enabled_ids,
                })
                ok_count += 1
            except SkillNotFoundError as exc:
                failed_count += 1
                results.append({
                    "index": index,
                    "ok": False,
                    "error": {"code": "NOT_FOUND", "message": str(exc)},
                })
            except SkillPermissionError as exc:
                failed_count += 1
                results.append({
                    "index": index,
                    "ok": False,
                    "error": {"code": "PERMISSION_DENIED", "message": str(exc)},
                })
            except SkillServiceError as exc:
                failed_count += 1
                results.append({
                    "index": index,
                    "ok": False,
                    "error": {"code": "VALIDATION_ERROR", "message": str(exc)},
                })
            except Exception as exc:
                logger.exception("[Skills] import_skills_batch item=%s failed", index)
                failed_count += 1
                results.append({
                    "index": index,
                    "ok": False,
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": str(exc) or "导入失败",
                    },
                })
        return {
            "results": results,
            "summary": {"ok": ok_count, "failed": failed_count},
        }

    @classmethod
    def _apply_enable_agent_ids(
        cls,
        *,
        user_id: UUID,
        skill: Skill,
        enable_agent_ids: Optional[List[str]],
    ) -> List[str]:
        """入库后按需启用到指定 Agent；逐项鉴权并以整组原子写入。"""
        targets = cls._resolve_enable_agent_targets(
            user_id=user_id,
            enable_agent_ids=enable_agent_ids,
        )

        enabled: List[str] = []
        with transaction.atomic():
            for aid in targets:
                cls.enable_skill(
                    user_id=user_id,
                    skill_canonical_key=skill.canonical_key,
                    agent_id=aid,
                )
                enabled.append(aid)
        return enabled

    @classmethod
    def _resolve_enable_agent_targets(
        cls,
        *,
        user_id: UUID,
        enable_agent_ids: Optional[List[str]],
    ) -> List[str]:
        """规范化并校验批量启用目标（Agent 归属校验：必须归当前用户所有）。"""
        targets: List[str] = []
        seen: set[str] = set()
        for raw in enable_agent_ids or []:
            aid = str(raw or "").strip()
            if not aid or aid in seen:
                continue
            seen.add(aid)
            targets.append(aid)

        if not targets:
            return targets

        from apps.agent.models import Agent as AgentModel

        owned = set(
            str(x)
            for x in AgentModel.objects.filter(
                id__in=targets,
                owner_user_id=user_id,
                is_active=True,
            ).values_list("id", flat=True)
        )
        for aid in targets:
            if aid not in owned:
                raise SkillPermissionError(
                    f"无权为目标 Agent 启用 Skill，或 Agent 不存在: {aid}"
                )
        return targets

    @staticmethod
    def normalize_import_source_url(url: str) -> str:
        """规范化导入来源 URL：trim、去 fragment、host 小写、GitHub blob→raw。"""
        from urllib.parse import urlparse, urlunparse

        raw = (url or "").strip()
        if not raw:
            return ""
        parsed = urlparse(raw)
        scheme = (parsed.scheme or "https").lower()
        host = (parsed.hostname or "").lower()
        path = parsed.path or ""
        # github.com/{owner}/{repo}/blob/{ref}/{path...} → raw.githubusercontent.com/...
        if host in {"github.com", "www.github.com"}:
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 4 and parts[2] == "blob":
                owner, repo, _blob, ref = parts[0], parts[1], parts[2], parts[3]
                rest = "/".join(parts[4:])
                host = "raw.githubusercontent.com"
                path = f"/{owner}/{repo}/{ref}/{rest}" if rest else f"/{owner}/{repo}/{ref}"
                path = path.rstrip("/")
                return urlunparse((scheme, host, path, "", "", ""))
        # 去 fragment；保留 query（少数 CDN 需要）
        return urlunparse((scheme, host, path, "", parsed.query, ""))

    @staticmethod
    def _validate_import_url(url: str) -> None:
        import ipaddress, socket
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.scheme != "https":
            raise SkillServiceError("仅支持 HTTPS URL")
        hostname = parsed.hostname
        if not hostname:
            raise SkillServiceError("无效 URL")
        blocked = [
            "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
            "127.0.0.0/8", "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10",
        ]
        try:
            for info in socket.getaddrinfo(hostname, None):
                addr = ipaddress.ip_address(info[4][0])
                for net in blocked:
                    if addr in ipaddress.ip_network(net):
                        raise SkillServiceError("不允许访问内网地址")
        except socket.gaierror:
            raise SkillServiceError(f"无法解析域名: {hostname}")

    @staticmethod
    def _describe_http_error(exc) -> str:
        """把上游 HTTP 错误翻成用户能懂的人话。

        重点区分「被限流」「鉴权失败」「找不到」，并尽量读出上游响应体里的真实
        原因（如 GitHub raw 的 ``API rate limit exceeded``）。此前 ``HTTPError``
        被当成 ``URLError`` 处理、只暴露 ``exc.reason``（如 "Forbidden"），上游
        403/429 的限流详情全被丢弃，用户只看到含糊的「API 限制」无从判断。
        """
        code = getattr(exc, "code", None)
        # 读上游响应体补充细节；读失败不阻断主流程。
        detail = ""
        try:
            raw = exc.read(2048)
            if raw:
                import json as _json
                body = raw.decode("utf-8", errors="replace").strip()
                try:
                    detail = (_json.loads(body) or {}).get("message", "") or ""
                except Exception:
                    detail = body[:200]
        except Exception:
            detail = ""

        if code == 429 or ("rate limit" in detail.lower()):
            msg = (
                "下载被上游服务限流（请求过于频繁）。如果是 GitHub 匿名 raw 链接，"
                "短时间内导入多次会触发其 API 限流，请稍后再试。"
            )
        elif code == 403:
            msg = (
                "上游拒绝访问（HTTP 403）。可能是私有仓库需要授权，或触发了匿名访问限流；"
                "请确认链接为公开的 raw 文件，或稍后再试。"
            )
        elif code == 404:
            msg = "URL 指向的资源不存在（HTTP 404），请检查链接是否正确（GitHub 请用 Raw 链接）。"
        else:
            reason = getattr(exc, "reason", None) or ""
            msg = f"URL 下载失败: HTTP {code} {reason}".rstrip()
        if detail and detail.lower() not in msg.lower():
            msg = f"{msg}（上游信息：{detail[:200]}）"
        return msg

    _MAX_EXTRACTED_TOTAL = 20 * 1024 * 1024
    _MAX_FILES_IN_ZIP = 100

    @classmethod
    def _ensure_import_link(
        cls, *, user_id: UUID, agent_id: Optional[UUID], skill: Skill,
    ) -> None:
        """幂等复用已有 Skill 时，确保当前 Agent 携带（默认停用）。"""
        if not agent_id:
            return
        AgentSkillLink.objects.get_or_create(
            agent_id=agent_id,
            skill_canonical_key=skill.canonical_key,
            defaults={
                "skill_id": skill.skill_id,
                "source": SOURCE_USER,
                "enabled": False,
                "config_json": {},
            },
        )

    @classmethod
    def _find_skill_by_import_source_url(
        cls, *, owner_user_id: UUID, import_source_url: str,
    ) -> Optional[Skill]:
        url = (import_source_url or "").strip()
        if not url:
            return None
        return (
            Skill.objects.filter(
                owner_user_id=owner_user_id,
                import_source_url=url,
                source=Skill.SOURCE_USER,
            )
            # 组织共享是独立的只读静态快照，不等于 owner 的「我的」原件。
            # 若私有原件已不存在，URL 导入必须新建个人 Skill，而不是复用快照并
            # 让客户端跳到「组织精选」。公开的自有原件仍属于「我的」，继续复用。
            .exclude(visibility=Skill.VISIBILITY_ORGANIZATION)
            .order_by("created_at")
            .first()
        )

    @classmethod
    def _find_skill_by_content_hash(
        cls, *, owner_user_id: UUID, content_hash: str,
    ) -> Optional[Skill]:
        """按发布内容 hash 找同 owner 已有 Skill（辅键，覆盖文件夹重复导入）。"""
        from apps.skills.models import SkillPublishedVersion

        h = (content_hash or "").strip()
        if not h:
            return None
        skill = (
            Skill.objects.filter(
                owner_user_id=owner_user_id,
                install_content_hash=h,
                source=Skill.SOURCE_USER,
            )
            # 共享快照与个人原件生命周期独立；不能用共享快照阻断个人导入。
            .exclude(visibility=Skill.VISIBILITY_ORGANIZATION)
            .order_by("created_at")
            .first()
        )
        if skill:
            return skill
        row = (
            SkillPublishedVersion.objects.filter(
                skill__owner_user_id=owner_user_id,
                local_content_hash=h,
            )
            .exclude(skill__visibility=Skill.VISIBILITY_ORGANIZATION)
            .select_related("skill")
            .order_by("published_at")
            .first()
        )
        if row:
            return row.skill
        return None

    @classmethod
    def _compute_import_content_hash(cls, files: list) -> str:
        """与 publish 路径一致的 skill-root 内容 hash，用于导入去重。"""
        from apps.services.package_registry.services import compute_bundle_sha256

        try:
            entries = cls._entries_from_publish_files(files)
        except SkillServiceError:
            return ""
        return compute_bundle_sha256(
            [(path, hashlib.sha256(content).hexdigest()) for path, content in entries]
        )

    @classmethod
    def _reuse_existing_import_skill(
        cls,
        *,
        skill: Skill,
        user_id: UUID,
        agent_id: Optional[UUID] = None,
        import_source_url: str = "",
    ) -> Skill:
        """复用已有 Skill：ensure Agent link；必要时回填 import_source_url。"""
        cls._ensure_import_link(user_id=user_id, agent_id=agent_id, skill=skill)
        source_url = (import_source_url or "").strip()
        if source_url and not (skill.import_source_url or "").strip():
            # 仅当尚无其他 skill 占用该 URL 时回填，避免撞 partial unique。
            conflict = cls._find_skill_by_import_source_url(
                owner_user_id=user_id, import_source_url=source_url,
            )
            if conflict is None or conflict.skill_id == skill.skill_id:
                skill.import_source_url = source_url
                skill.save(update_fields=["import_source_url", "updated_at"])
        return skill

    @classmethod
    def _import_from_url(
        cls,
        *,
        user_id: UUID,
        url: str,
        organization_id: Optional[UUID] = None,
        agent_id: Optional[UUID] = None,
    ) -> tuple[Skill, List[Dict[str, Any]], bool]:
        import io, zipfile, urllib.request, urllib.error

        normalized_url = cls.normalize_import_source_url(url)
        if not normalized_url:
            raise SkillServiceError("无效 URL")
        cls._validate_import_url(normalized_url)

        existing = cls._find_skill_by_import_source_url(
            owner_user_id=user_id, import_source_url=normalized_url,
        )
        if existing:
            skill = cls._reuse_existing_import_skill(
                skill=existing, user_id=user_id, agent_id=agent_id,
                import_source_url=normalized_url,
            )
            normalized_files = cls._serialize_imported_files_for_response(
                cls._read_sandbox_files(skill)
            )
            return skill, normalized_files, True

        try:
            req = urllib.request.Request(
                normalized_url, headers={"User-Agent": "TabTin-SkillImport/1.0"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read(10 * 1024 * 1024)
                content_type = resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            # ：HTTPError 是 URLError 子类，若不先拦下会落到下面的 URLError 分支、
            # 只暴露 exc.reason，丢失上游 403/429 的限流详情。这里单独分类 + 读响应体。
            raise SkillServiceError(cls._describe_http_error(exc)) from exc
        except urllib.error.URLError as exc:
            raise SkillServiceError(f"URL 下载失败: {exc.reason}") from exc
        except Exception as exc:
            raise SkillServiceError(f"URL 下载失败: {exc}") from exc

        if "text/html" in content_type:
            raise SkillServiceError(
                "URL 返回了 HTML 页面而非 Skill 文件。如果是 GitHub 链接，请使用 raw 链接（点 Raw 按钮）"
            )

        files: list = []
        if "zip" in content_type or normalized_url.endswith(".zip"):
            try:
                zf = zipfile.ZipFile(io.BytesIO(data))
                total_extracted = 0
                for i, info in enumerate(zf.infolist()):
                    if i >= cls._MAX_FILES_IN_ZIP:
                        raise SkillServiceError(f"zip 内文件数超过上限 ({cls._MAX_FILES_IN_ZIP})")
                    if info.is_dir():
                        continue
                    raw = zf.read(info)
                    total_extracted += len(raw)
                    if total_extracted > cls._MAX_EXTRACTED_TOTAL:
                        raise SkillServiceError("解压后总大小超过限制 (20MB)")
                    parts = info.filename.split("/", 1)
                    rel = parts[1] if len(parts) > 1 else parts[0]
                    if not rel:
                        continue
                    try:
                        content = raw.decode("utf-8")
                        files.append({"path": rel, "content": content})
                    except UnicodeDecodeError:
                        files.append({
                            "path": rel,
                            "content": base64.b64encode(raw).decode("ascii"),
                            "encoding": "base64",
                        })
            except zipfile.BadZipFile:
                raise SkillServiceError("下载的文件不是有效的 zip")
        else:
            from urllib.parse import unquote, urlparse
            raw_text = data.decode("utf-8", errors="replace")
            parsed = urlparse(normalized_url)
            fname = unquote(parsed.path.rsplit("/", 1)[-1] or "downloaded.md")
            files.append({"path": fname, "content": raw_text})

        if not files:
            raise SkillServiceError("URL 中未找到有效的 Skill 文件")

        skill, _normalized_from_files, already_exists = cls._import_from_files(
            user_id=user_id,
            organization_id=organization_id,
            agent_id=agent_id,
            files=files,
            name=None,
            import_source_url=normalized_url,
        )
        # URL 路径优先读 sandbox 以对齐落盘；空则回退请求 files。
        sandbox_files = cls._serialize_imported_files_for_response(
            cls._read_sandbox_files(skill)
        )
        normalized_files = sandbox_files or _normalized_from_files or cls._serialize_import_file_dicts(files)
        return skill, normalized_files, already_exists

    @classmethod
    def _serialize_import_file_dicts(cls, files: list) -> List[Dict[str, Any]]:
        """把导入请求里的 files[] 转成与 sandbox 序列化同形的响应。"""
        entries: List[tuple] = []
        for item in files or []:
            rel = str(item.get("path") or "").replace("\\", "/").lstrip("/")
            if not rel or ".." in rel.split("/"):
                continue
            try:
                raw = cls._decode_publish_file_bytes(item, rel)
            except SkillServiceError:
                continue
            entries.append((rel, raw))
        return cls._serialize_imported_files_for_response(entries)

    @staticmethod
    def _serialize_imported_files_for_response(
        entries: List[tuple],
    ) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for rel, raw in entries:
            rel_path = str(rel).replace("\\", "/").lstrip("/")
            if not rel_path:
                continue
            try:
                normalized.append({
                    "path": rel_path,
                    "content": raw.decode("utf-8"),
                })
            except UnicodeDecodeError:
                normalized.append({
                    "path": rel_path,
                    "content": base64.b64encode(raw).decode("ascii"),
                    "encoding": "base64",
                })
        normalized.sort(key=lambda item: str(item.get("path", "")))
        return normalized

    @classmethod
    def _import_from_files(
        cls,
        *,
        user_id: UUID,
        organization_id: Optional[UUID] = None,
        agent_id: Optional[UUID] = None,
        files: list,
        name: Optional[str] = None,
        import_source_url: str = "",
    ) -> tuple[Skill, List[Dict[str, Any]], bool]:
        """从 files[] 入库。返回 ``(skill, normalized_files, already_exists)``。"""
        skill_md_content = cls._decode_import_skill_md_content(files)
        parsed_meta = cls._parse_valid_import_frontmatter(skill_md_content)
        parsed_name = (name or "").strip()
        parsed_desc = parsed_meta["description"]
        if not parsed_name:
            parsed_name = parsed_meta["display_name"] or parsed_meta["name"].replace("-", " ")

        source_url = (import_source_url or "").strip()
        if source_url:
            existing_by_url = cls._find_skill_by_import_source_url(
                owner_user_id=user_id, import_source_url=source_url,
            )
            if existing_by_url:
                skill = cls._reuse_existing_import_skill(
                    skill=existing_by_url,
                    user_id=user_id,
                    agent_id=agent_id,
                    import_source_url=source_url,
                )
                normalized = (
                    cls._serialize_imported_files_for_response(
                        cls._read_sandbox_files(skill)
                    )
                    or cls._serialize_import_file_dicts(files)
                )
                return skill, normalized, True

        content_hash = cls._compute_import_content_hash(files)
        existing_by_hash = cls._find_skill_by_content_hash(
            owner_user_id=user_id, content_hash=content_hash,
        )
        if existing_by_hash:
            skill = cls._reuse_existing_import_skill(
                skill=existing_by_hash,
                user_id=user_id,
                agent_id=agent_id,
                import_source_url=source_url,
            )
            normalized = (
                cls._serialize_imported_files_for_response(
                    cls._read_sandbox_files(skill)
                )
                or cls._serialize_import_file_dicts(files)
            )
            return skill, normalized, True

        try:
            skill = cls.create_user_skill(
                owner_user_id=user_id,
                organization_id=organization_id,
                agent_id=agent_id,
                name=parsed_name,
                description=parsed_desc,
                category=parsed_meta.get("category", ""),
                skip_initial_publish=True,
                import_source_url=source_url,
            )
        except Exception as exc:
            from django.db import IntegrityError
            if source_url and isinstance(exc, IntegrityError):
                raced = cls._find_skill_by_import_source_url(
                    owner_user_id=user_id, import_source_url=source_url,
                )
                if raced:
                    skill = cls._reuse_existing_import_skill(
                        skill=raced,
                        user_id=user_id,
                        agent_id=agent_id,
                        import_source_url=source_url,
                    )
                    normalized = (
                        cls._serialize_imported_files_for_response(
                            cls._read_sandbox_files(skill)
                        )
                        or cls._serialize_import_file_dicts(files)
                    )
                    return skill, normalized, True
            raise

        try:
            skill = cls._write_import_files_and_publish(
                skill=skill,
                user_id=user_id,
                agent_id=agent_id,
                organization_id=organization_id,
                files=files,
            )
            normalized = (
                cls._serialize_imported_files_for_response(
                    cls._read_sandbox_files(skill)
                )
                or cls._serialize_import_file_dicts(files)
            )
            return skill, normalized, False
        except Exception:
            cls._cleanup_failed_import_skill(skill=skill)
            raise

    @classmethod
    def _write_import_files_and_publish(
        cls,
        *,
        skill: Skill,
        user_id: UUID,
        agent_id: Optional[UUID] = None,
        organization_id: Optional[UUID] = None,
        files: list,
        change_note: str = "import",
    ) -> Skill:
        skill_dir = os.path.realpath(_primary_sandbox_dir_for_skill(skill))
        allowed_root = os.path.realpath(_sandbox_skills_root(
            owner_user_id=skill.owner_user_id,
            organization_id=(
                skill.organization_id
                if skill.visibility == Skill.VISIBILITY_ORGANIZATION
                else None
            ),
        ))
        if not skill_dir.startswith(allowed_root + os.sep):
            raise SkillServiceError("非法 sandbox 路径")

        total_bytes = 0
        written_files: list = []
        for f in files:
            rel = f.get("path", "")
            if not rel or ".." in rel:
                continue
            fpath = os.path.realpath(os.path.join(skill_dir, rel))
            if not fpath.startswith(skill_dir + os.sep) and fpath != skill_dir:
                continue
            try:
                raw = cls._decode_publish_file_bytes(f, rel)
            except SkillServiceError:
                logger.warning("skill_import.skip_undecodable rel=%s", rel)
                continue
            total_bytes += len(raw)
            if total_bytes > cls._MAX_EXTRACTED_TOTAL:
                raise SkillServiceError("导入文件总大小超过限制 (20MB)")
            os.makedirs(os.path.dirname(fpath), exist_ok=True)
            with open(fpath, "wb") as fh:
                fh.write(raw)
            written_files.append(f)

        if not written_files:
            raise SkillServiceError("导入未写入任何有效文件，无法发布")

        try:
            cls._publish_initial_skill_files(
                skill=skill,
                user_id=user_id,
                agent_id=agent_id,
                organization_id=organization_id,
                files=written_files,
                change_note=change_note,
            )
        except SkillServiceError as exc:
            logger.warning(
                "skill_import.publish_deferred skill=%s slug=%s err=%s",
                getattr(skill, "skill_id", None),
                getattr(skill, "slug", None),
                exc,
            )
            return skill

        return skill

    @classmethod
    def _cleanup_failed_import_skill(cls, *, skill: Skill) -> None:
        """导入中途失败时清掉已提交的 Skill / enablement / sandbox，避免孤儿。"""
        skill_id = getattr(skill, "skill_id", None)
        try:
            AgentSkillLink.objects.filter(skill_id=skill_id).delete()
            SkillEnablement.objects.filter(skill_id=skill_id).delete()
        except Exception:
            logger.warning(
                "skill_import.cleanup enablement failed skill=%s", skill_id, exc_info=True,
            )
        try:
            cls._remove_sandbox_copy(skill=skill)
        except Exception:
            logger.warning(
                "skill_import.cleanup sandbox failed skill=%s", skill_id, exc_info=True,
            )
        try:
            Skill.objects.filter(skill_id=skill_id).delete()
        except Exception:
            logger.warning(
                "skill_import.cleanup skill row failed skill=%s", skill_id, exc_info=True,
            )

    @classmethod
    def _publish_initial_skill_files(
        cls,
        *,
        skill: Skill,
        user_id: UUID,
        agent_id: Optional[UUID] = None,
        organization_id: Optional[UUID] = None,
        files: list,
        change_note: str = "import",
    ) -> None:
        """把真实文件发成 Package Registry 版本（新建/导入共用的首次发布）。"""
        if not files:
            raise SkillServiceError("导入未写入任何有效文件，无法发布")
        try:
            from apps.skills.models import SkillPublishedVersion
            from apps.skills.services.semver_utils import suggest_next_semver

            skill.refresh_from_db()
            existing_labels = list(
                SkillPublishedVersion.objects.filter(skill=skill)
                .exclude(version_label="")
                .values_list("version_label", flat=True)
            )
            next_label = suggest_next_semver(existing_labels)
            cls.publish_skill(
                skill_id=skill.skill_id,
                owner_user_id=user_id,
                organization_id=organization_id or skill.organization_id,
                agent_id=agent_id,
                version_label=next_label,
                files=files,
                change_note=change_note,
            )
            skill.refresh_from_db()
        except SkillServiceError:
            raise
        except Exception:
            logger.error(
                "skill_service.import_republish failed skill=%s slug=%s",
                getattr(skill, "skill_id", None),
                getattr(skill, "slug", None),
                exc_info=True,
            )
            raise SkillServiceError(
                "导入文件已写入，但发布真实内容失败；请稍后在编辑器中「保存并发布」后再启用"
            )

    @classmethod
    def _decode_import_skill_md_content(cls, files: list) -> str:
        for f in files:
            rel = str(f.get("path", "")).replace("\\", "/").lstrip("/")
            if rel != "SKILL.md" and not rel.endswith("/SKILL.md"):
                continue
            try:
                raw = cls._decode_publish_file_bytes(f, rel)
            except SkillServiceError as exc:
                raise SkillServiceError(f"SKILL.md 内容无效: {exc}") from exc
            try:
                return raw.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise SkillServiceError("SKILL.md 必须是 UTF-8 文本") from exc
        raise SkillServiceError(
            "导入文件必须包含 SKILL.md；普通 Markdown（如 README.md）不能直接作为 Skill 导入"
        )

    @staticmethod
    def _parse_valid_import_frontmatter(skill_md_content: str) -> Dict[str, str]:
        from apps.skills.services.skill_doc_parser import (
            _parse_frontmatter,
            is_kebab_case,
            parse_skill_doc,
        )

        frontmatter, _ = _parse_frontmatter(skill_md_content.splitlines())
        if not frontmatter:
            raise SkillServiceError("SKILL.md 必须包含 frontmatter（---）")

        frontmatter_name = str(frontmatter.get("name") or "").strip()
        if not frontmatter_name:
            raise SkillServiceError("SKILL.md frontmatter 缺少 name")
        if not is_kebab_case(frontmatter_name):
            raise SkillServiceError("SKILL.md frontmatter 的 name 必须是 kebab-case")

        frontmatter_description = str(frontmatter.get("description") or "").strip()
        if not frontmatter_description:
            raise SkillServiceError("SKILL.md frontmatter 缺少 description")

        parsed = parse_skill_doc(skill_md_content)
        metadata = frontmatter.get("metadata")
        tabtin_metadata = metadata.get("tabtin") if isinstance(metadata, dict) else {}
        category = ""
        raw_category = ""
        if isinstance(tabtin_metadata, dict):
            raw_category = str(tabtin_metadata.get("category") or "").strip()
        if not raw_category:
            raw_category = str(frontmatter.get("category") or "").strip()
        if raw_category:
            try:
                category = SkillService._normalize_category(raw_category)
            except SkillServiceError:
                category = ""
        return {
            "name": frontmatter_name,
            "description": frontmatter_description,
            "display_name": str(parsed.get("display_name") or "").strip(),
            "category": category,
        }

    # ---------- export ----------

    @classmethod
    def export_skill(
        cls,
        *,
        skill_id: UUID,
        requesting_user_id: UUID,
    ) -> tuple:
        skill = Skill.objects.filter(skill_id=skill_id).first()
        if not skill:
            raise SkillNotFoundError(f"Skill 不存在: {skill_id}")
        if str(skill.owner_user_id) != str(requesting_user_id):
            raise SkillPermissionError("只有 owner 才能导出")

        # ：sandbox 双层布局按 (owner, organization?) 直接定位，不再需要
        # 从 AgentSkillLink → Workspace 反查 space_id。
        entries = cls._read_sandbox_files(skill)
        if not entries:
            raise SkillServiceError("sandbox 目录为空，无法导出")

        STANDARD_FIELDS = {"name", "description", "license", "compatibility", "metadata", "allowed-tools"}

        clean_entries = []
        for rel_path, content_bytes in entries:
            if rel_path == "SKILL.md":
                content_str = content_bytes.decode("utf-8", errors="replace")
                content_str = cls._strip_tabtin_frontmatter(content_str, STANDARD_FIELDS, skill)
                clean_entries.append((rel_path, content_str.encode("utf-8")))
            else:
                clean_entries.append((rel_path, content_bytes))

        slug = cls._to_agentskills_name(skill.slug, skill.name)
        zip_bytes = cls._build_zip(clean_entries, slug)
        filename = f"{slug}.zip"
        return (zip_bytes, filename)

    @staticmethod
    def _yaml_quote(val: str) -> str:
        safe = val.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')
        return f'"{safe}"'

    @staticmethod
    def _strip_tabtin_frontmatter(
        content: str, standard_fields: set, skill: "Skill",
    ) -> str:
        import re
        match = re.match(r"^---\s*\n(.*?)\n---\s*\n?", content, re.DOTALL)
        if not match:
            name_val = SkillService._to_agentskills_name(skill.slug, skill.name)
            desc_val = SkillService._yaml_quote(skill.description or "")
            return f"---\nname: {name_val}\ndescription: {desc_val}\n---\n\n{content}"

        body = content[match.end():]
        lines = match.group(1).split("\n")
        clean_lines = []
        skip_block = False
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if not line.startswith(" ") and not line.startswith("\t"):
                key = stripped.split(":")[0].strip()
                if key in standard_fields:
                    clean_lines.append(line)
                    skip_block = False
                else:
                    skip_block = True
            else:
                if not skip_block:
                    clean_lines.append(line)

        has_name = any(l.strip().startswith("name:") for l in clean_lines)
        has_desc = any(l.strip().startswith("description:") for l in clean_lines)
        if not has_name:
            clean_lines.insert(0, f"name: {SkillService._to_agentskills_name(skill.slug, skill.name)}")
        if not has_desc:
            clean_lines.append(f"description: {SkillService._yaml_quote(skill.description or '')}")

        return "---\n" + "\n".join(clean_lines) + "\n---\n\n" + body

    @staticmethod
    def _to_agentskills_name(slug: str, name: str) -> str:
        import re
        candidate = slug or name or "skill"
        candidate = re.sub(r"[^a-z0-9\-]", "-", candidate.lower())
        candidate = re.sub(r"-{2,}", "-", candidate).strip("-")
        return candidate[:64] or "skill"


__all__ = [
    "EnableSkillResult",
    "SkillService",
    "SkillServiceError",
    "SkillVersionConflictError",
    "SkillNotFoundError",
    "SkillPermissionError",
]
