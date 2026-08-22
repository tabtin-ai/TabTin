"""
#7124：清偿历史 agent_id=NULL 画像（画像 per-Agent 化兼容迁移）。

在 ``migrate``（首次升级启动）与 management command 中复用同一套幂等逻辑：

1. 有内容的 NULL 画像 → 填入同 (user, org) 下已存在的空 per-Agent 画像；
   并确保该用户在组织内的「默认/活跃」Agent 上也有一份（必要时创建）
2. 绝不覆盖已有非空 per-Agent 正文
3. 无法落点（无空 sibling 且默认 Agent 已有非空正文）时 **保留 NULL**，不静默丢弃
4. 成功落点后删除 NULL 行及其快照；无活跃 Agent 时保留 NULL 并记日志
5. 停用 Agent 上的 active AgentMemory → 改挂到 **同一 owner_user** 的组织默认 Agent
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional
from uuid import UUID

from django.apps import apps as django_apps
from django.db import transaction

logger = logging.getLogger(__name__)


@dataclass
class LegacyPortraitMigrationStats:
    null_portraits_seen: int = 0
    seeded_existing: int = 0
    created_for_default: int = 0
    deleted_null_portraits: int = 0
    deleted_snapshots: int = 0
    skipped_no_active_agent: int = 0
    skipped_empty_null: int = 0
    skipped_could_not_place: int = 0
    memories_reassigned: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "null_portraits_seen": self.null_portraits_seen,
            "seeded_existing": self.seeded_existing,
            "created_for_default": self.created_for_default,
            "deleted_null_portraits": self.deleted_null_portraits,
            "deleted_snapshots": self.deleted_snapshots,
            "skipped_no_active_agent": self.skipped_no_active_agent,
            "skipped_empty_null": self.skipped_empty_null,
            "skipped_could_not_place": self.skipped_could_not_place,
            "memories_reassigned": self.memories_reassigned,
            "errors": list(self.errors),
        }


def _portrait_db_alias(schema_editor=None) -> str:
    if schema_editor is not None:
        return schema_editor.connection.alias
    from apps.user_portrait.constants import USER_PORTRAIT_DB

    return USER_PORTRAIT_DB


def resolve_preferred_agent_id(
    *,
    organization_id: Any,
    owner_user_id: Any,
    agent_model=None,
) -> Optional[UUID]:
    """解析画像/记忆应挂靠的默认活跃 Agent。

    与 ``agent_one_active_default_per_owner`` 对齐：按
    ``(organization_id, owner_user_id)`` 取 ``is_default`` 活跃 Agent，
    否则取该用户在组织内最早创建的活跃 Agent。
    """
    if owner_user_id is None:
        return None
    if agent_model is None:
        try:
            agent_model = django_apps.get_model("agent", "Agent")
        except LookupError:
            return None

    qs = agent_model.objects.filter(
        organization_id=organization_id,
        owner_user_id=owner_user_id,
        is_active=True,
    )
    preferred = (
        qs.filter(is_default=True).order_by("created_at").first()
        or qs.order_by("created_at").first()
    )
    return preferred.id if preferred else None


def _is_empty_portrait_content(content_md: Optional[str]) -> bool:
    return not (content_md or "").strip()


def _seed_fields_from_legacy(target, legacy) -> list[str]:
    """把 legacy 可迁移字段拷到 target；返回 update_fields。"""
    target.content_md = legacy.content_md or ""
    target.version = legacy.version or 0
    target.last_distilled_at = legacy.last_distilled_at
    target.last_distill_status = legacy.last_distill_status or "idle"
    target.last_distill_error = legacy.last_distill_error or ""
    # pending_hints：仅当目标为空时合并，避免冲掉新 Agent 上已提交的 hint
    if not list(getattr(target, "pending_hints", None) or []):
        target.pending_hints = list(legacy.pending_hints or [])
        return [
            "content_md",
            "version",
            "last_distilled_at",
            "last_distill_status",
            "last_distill_error",
            "pending_hints",
            "updated_at",
        ]
    return [
        "content_md",
        "version",
        "last_distilled_at",
        "last_distill_status",
        "last_distill_error",
        "updated_at",
    ]


def _legacy_create_kwargs(legacy, *, agent_id: UUID) -> dict[str, Any]:
    return {
        "user_id": legacy.user_id,
        "organization_id": legacy.organization_id,
        "agent_id": agent_id,
        "content_md": legacy.content_md or "",
        "version": legacy.version or 0,
        "last_distilled_at": legacy.last_distilled_at,
        "last_distill_status": legacy.last_distill_status or "idle",
        "last_distill_error": legacy.last_distill_error or "",
        "pending_hints": list(legacy.pending_hints or []),
    }


def migrate_legacy_null_portraits(
    *,
    dry_run: bool = False,
    apps_registry=None,
    schema_editor=None,
) -> LegacyPortraitMigrationStats:
    """幂等清偿 ``agent_id=NULL`` 画像。"""
    stats = LegacyPortraitMigrationStats()
    registry = apps_registry or django_apps
    using = _portrait_db_alias(schema_editor)

    try:
        UserPortrait = registry.get_model("user_portrait", "UserPortrait")
        UserPortraitSnapshot = registry.get_model("user_portrait", "UserPortraitSnapshot")
    except LookupError as exc:
        stats.errors.append(f"user_portrait models unavailable: {exc}")
        return stats

    try:
        Agent = registry.get_model("agent", "Agent")
    except LookupError:
        Agent = None

    null_qs = UserPortrait.objects.using(using).filter(agent_id__isnull=True)
    stats.null_portraits_seen = null_qs.count()

    for legacy in null_qs.iterator():
        try:
            _migrate_one_legacy_portrait(
                legacy=legacy,
                UserPortrait=UserPortrait,
                UserPortraitSnapshot=UserPortraitSnapshot,
                Agent=Agent,
                using=using,
                dry_run=dry_run,
                stats=stats,
            )
        except Exception as exc:  # pragma: no cover - 单条失败不阻断整批
            logger.exception(
                "[LegacyPortraitMigration] failed user=%s organization=%s: %s",
                legacy.user_id,
                legacy.organization_id,
                exc,
            )
            stats.errors.append(
                f"portrait={legacy.id}: {type(exc).__name__}: {exc}"
            )

    return stats


def _migrate_one_legacy_portrait(
    *,
    legacy,
    UserPortrait,
    UserPortraitSnapshot,
    Agent,
    using: str,
    dry_run: bool,
    stats: LegacyPortraitMigrationStats,
) -> None:
    if _is_empty_portrait_content(legacy.content_md):
        # 空正文 NULL 行实跑会删；dry-run 同步计入将删除数量，避免 ops 低估。
        stats.skipped_empty_null += 1
        snap_qs = UserPortraitSnapshot.objects.using(using).filter(
            portrait_id=legacy.id
        )
        if dry_run:
            stats.deleted_snapshots += snap_qs.count()
            stats.deleted_null_portraits += 1
            return
        snap_n, _ = snap_qs.delete()
        stats.deleted_snapshots += snap_n
        legacy.delete(using=using)
        stats.deleted_null_portraits += 1
        return

    preferred_agent_id = resolve_preferred_agent_id(
        organization_id=legacy.organization_id,
        owner_user_id=legacy.user_id,
        agent_model=Agent,
    )

    siblings = list(
        UserPortrait.objects.using(using).filter(
            user_id=legacy.user_id,
            organization_id=legacy.organization_id,
            agent_id__isnull=False,
        )
    )
    empty_siblings = [
        p for p in siblings if _is_empty_portrait_content(p.content_md)
    ]
    sibling_by_agent = {str(p.agent_id): p for p in siblings}

    preferred_existing = (
        sibling_by_agent.get(str(preferred_agent_id))
        if preferred_agent_id is not None
        else None
    )
    can_create_preferred = (
        preferred_agent_id is not None and preferred_existing is None
    )
    can_seed_preferred = (
        preferred_existing is not None
        and _is_empty_portrait_content(preferred_existing.content_md)
    )
    can_place = bool(empty_siblings) or can_create_preferred or can_seed_preferred

    if preferred_agent_id is None and not empty_siblings:
        stats.skipped_no_active_agent += 1
        logger.warning(
            "[LegacyPortraitMigration] keep null portrait %s: no active agent "
            "for user=%s organization=%s",
            legacy.id,
            legacy.user_id,
            legacy.organization_id,
        )
        return

    if not can_place:
        # 默认 Agent 已有非空正文、且无其他空 sibling → 保留 NULL，避免丢弃唯一旧正文
        stats.skipped_could_not_place += 1
        logger.warning(
            "[LegacyPortraitMigration] keep null portrait %s: no empty "
            "per-Agent target (preferred=%s already non-empty)",
            legacy.id,
            preferred_agent_id,
        )
        return

    if dry_run:
        stats.seeded_existing += len(empty_siblings)
        if can_create_preferred:
            stats.created_for_default += 1
        stats.deleted_null_portraits += 1
        return

    with transaction.atomic(using=using):
        seeded_agent_ids: set[str] = set()
        for target in empty_siblings:
            fields = _seed_fields_from_legacy(target, legacy)
            target.save(using=using, update_fields=fields)
            stats.seeded_existing += 1
            seeded_agent_ids.add(str(target.agent_id))

        if preferred_agent_id is not None and str(preferred_agent_id) not in seeded_agent_ids:
            if preferred_existing is None:
                UserPortrait.objects.using(using).create(
                    **_legacy_create_kwargs(legacy, agent_id=preferred_agent_id)
                )
                stats.created_for_default += 1
            elif _is_empty_portrait_content(preferred_existing.content_md):
                fields = _seed_fields_from_legacy(preferred_existing, legacy)
                preferred_existing.save(using=using, update_fields=fields)
                stats.seeded_existing += 1

        snap_n, _ = UserPortraitSnapshot.objects.using(using).filter(
            portrait_id=legacy.id
        ).delete()
        stats.deleted_snapshots += snap_n
        legacy.delete(using=using)
        stats.deleted_null_portraits += 1


def reassign_memories_from_inactive_agents(
    *,
    dry_run: bool = False,
    apps_registry=None,
) -> int:
    """把停用 Agent 上的 active 记忆改挂到同 owner 的组织默认 Agent。返回改挂条数。"""
    registry = apps_registry or django_apps
    if not registry.is_installed("apps.agent_memory"):
        return 0
    try:
        Agent = registry.get_model("agent", "Agent")
        AgentMemory = registry.get_model("agent_memory", "AgentMemory")
    except LookupError:
        return 0

    inactive_agents = list(
        Agent.objects.filter(is_active=False).values(
            "id", "organization_id", "owner_user_id",
        )
    )
    moved = 0
    for ia in inactive_agents:
        preferred = resolve_preferred_agent_id(
            organization_id=ia["organization_id"],
            owner_user_id=ia["owner_user_id"],
            agent_model=Agent,
        )
        if preferred is None or str(preferred) == str(ia["id"]):
            continue
        mem_qs = AgentMemory.objects.filter(
            agent_id=ia["id"],
            status="active",
        )
        count = mem_qs.count()
        if count == 0:
            continue
        if dry_run:
            moved += count
            continue
        updated = mem_qs.update(agent_id=preferred)
        moved += updated
        logger.info(
            "[LegacyPortraitMigration] reassigned %d memories from inactive "
            "agent %s → %s (owner=%s)",
            updated,
            ia["id"],
            preferred,
            ia["owner_user_id"],
        )
    return moved


def run_legacy_portrait_migration(
    *,
    dry_run: bool = False,
    apps_registry=None,
    schema_editor=None,
    reassign_inactive_memories: bool = True,
) -> LegacyPortraitMigrationStats:
    """入口：画像清偿 +（可选）停用 Agent 记忆改挂。"""
    stats = migrate_legacy_null_portraits(
        dry_run=dry_run,
        apps_registry=apps_registry,
        schema_editor=schema_editor,
    )
    if reassign_inactive_memories:
        stats.memories_reassigned = reassign_memories_from_inactive_agents(
            dry_run=dry_run,
            apps_registry=apps_registry,
        )
    logger.info(
        "[LegacyPortraitMigration] done dry_run=%s stats=%s",
        dry_run,
        stats.as_dict(),
    )
    return stats
