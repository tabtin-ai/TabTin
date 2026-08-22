"""
SkillEmbeddingService — 技能向量索引与语义检索（ 改用 organization_id 为租户键）。

职责：
- 将 Skill 描述（name + description + tags + parameters）向量化并存入 SkillEmbedding
- 提供语义检索接口，根据自然语言查询返回最相关的技能列表
- 复用 RAG 模块的 EmbeddingService 生成向量

租户键： 前用 ``space_id`` + ``metadata.space_id`` 做 user 来源 Skill
的组织隔离；#7118 后 Skill 归属 (organization, agent)，租户键统一为
``organization_id``。SkillEmbedding.organization_id 是唯一权威字段，
``space_id`` 列仅供历史数据回填期兼容读，新写入不再依赖。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from apps.services.llm.scenes.exceptions import SceneRoutingDisabled

logger = logging.getLogger(__name__)

try:
    import sentry_sdk
    _has_sentry = True
except ImportError:
    _has_sentry = False

# skill_key 转 UUIDv5 的命名空间（固定值，确保同一 skill_key 生成稳定 UUID）
_SKILL_UUID_NAMESPACE = uuid.UUID("b3d1e2f4-1a2b-4c3d-8e5f-9a0b1c2d3e4f")


def _skill_key_to_uuid(skill_key: str) -> uuid.UUID:
    """将 skill_key 字符串转换为稳定的 UUIDv5，用于 EmbeddingTask.target_id。"""
    return uuid.uuid5(_SKILL_UUID_NAMESPACE, skill_key)


def _build_content_text(
    name: str,
    description: str,
    tags: Optional[List[str]] = None,
    parameters: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """Combine skill metadata into a single text for embedding."""
    parts = [name]
    if description:
        parts.append(description)
    if tags:
        parts.append(f"tags: {', '.join(tags)}")
    text = " | ".join(parts)

    if parameters:
        param_fragments = []
        for p in parameters:
            if not isinstance(p, dict):
                continue
            pname = p.get("name") or p.get("param_name") or ""
            if not pname:
                continue
            ptype = p.get("type") or p.get("param_type") or ""
            pdesc = p.get("description") or p.get("desc") or ""
            fragment = pname
            if ptype:
                fragment = f"{pname}({ptype})"
            if pdesc:
                fragment = f"{fragment}: {pdesc}"
            param_fragments.append(fragment)
        if param_fragments:
            text = f"{text}\n参数: {', '.join(param_fragments)}"

    return text


class SkillEmbeddingService:
    """Index and search skills using pgvector embeddings."""

    @classmethod
    def index_skill(
        cls,
        *,
        skill_key: str,
        name: str,
        description: str,
        source: str = "platform",
        tags: Optional[List[str]] = None,
        location: Optional[str] = None,
        auto_activate_for: Optional[List[str]] = None,
        parameters: Optional[List[Dict[str, Any]]] = None,
        organization_id: Optional[str] = None,
    ) -> bool:
        """Index a single skill. Returns True if the embedding was created/updated.

        ：user 来源 Skill 必须提供 ``organization_id`` 做租户隔离；
        缺失会拒绝写入，避免造成对任何用户不可见的幽灵记录。
        """
        from apps.rag.models import SkillEmbedding
        from apps.rag.utils import calculate_content_hash
        from apps.skills.services.registry_service import (
            SOURCE_USER as _SOURCE_USER,
            normalize_skill_source as _normalize_source,
        )

        _canonical_source = _normalize_source(source)

        if _canonical_source == _SOURCE_USER and not organization_id:
            # 个人技能默认 private、无 organization_id，不进组织隔离的向量索引。
            # 拒绝写入避免幽灵记录；这是预期跳过，不是故障。
            logger.info(
                "[SkillEmbedding] index_skill skipped: personal user skill has no "
                "organization_id. skill_key=%s will not be indexed.",
                skill_key,
            )
            return False

        content = _build_content_text(name, description, tags, parameters)
        content_hash = calculate_content_hash(content)

        # 平台级 sentinel 与 SkillEmbedding.organization_id NULL 表达等价：非 user
        # 来源 Skill 属于全局公共，落 NULL；user 来源必带 organization_id UUID。
        organization_uuid: Optional[Any] = None
        if organization_id:
            try:
                organization_uuid = uuid.UUID(str(organization_id))
            except (ValueError, AttributeError):
                organization_uuid = None
                if _canonical_source == _SOURCE_USER:
                    logger.error(
                        "[SkillEmbedding] index_skill REJECTED: invalid organization_id "
                        "%r for user skill %s", organization_id, skill_key,
                    )
                    return False

        existing = SkillEmbedding.objects.filter(skill_key=skill_key).first()
        if existing and existing.content_hash == content_hash:
            # organization 变更时更新 metadata + 顶层列，即使 content 未变
            metadata_dirty = False
            new_meta = dict(existing.metadata or {})
            if organization_id and new_meta.get("organization_id") != str(organization_id):
                new_meta["organization_id"] = str(organization_id)
                metadata_dirty = True
            column_dirty = existing.organization_id != organization_uuid
            if metadata_dirty or column_dirty:
                existing.metadata = new_meta
                existing.organization_id = organization_uuid
                existing.save(update_fields=["metadata", "organization_id", "updated_at"])
                logger.info(
                    "[SkillEmbedding] updated organization for %s (source=%s, org=%s)",
                    skill_key, source, organization_id,
                )
            return False

        # BL-001/BL-002：计费上下文（user_id + organization_id）。
        # - 全局公共 Skill（platform/app/device）走平台级 sentinel
        # - user 来源真实租户 = 上面校验过的 organization_id
        from apps.services.llm.services._runtime.scene_call_context import (
            PLATFORM_ORGANIZATION_SENTINELS as _PLATFORM_SENTINELS,
        )
        _PLATFORM_SYSTEM_ORGANIZATION_ID = "system"

        _embed_user_id = ""
        _embed_organization_id = (
            str(organization_id)
            if _canonical_source == _SOURCE_USER
            else _PLATFORM_SYSTEM_ORGANIZATION_ID
        )

        try:
            from apps.services.llm.services.embedding import embed_text as _unified_embed
            _emb_result = _unified_embed(
                scene_key="rag_index_skill",
                texts=[content],
                user_id=_embed_user_id,
                organization_id=_embed_organization_id,
            )
            vector = _emb_result.vectors[0]
        except SceneRoutingDisabled:
            logger.info(
                "[SkillEmbedding] skipped because scene routing is disabled: %s",
                skill_key,
            )
            return False
        except Exception as exc:
            logger.warning("[SkillEmbedding] embed failed for %s: %s", skill_key, exc)
            # SS-002：能落到真实 organization 时才记录 EmbeddingTask 失败。
            if (
                _embed_organization_id
                and _embed_organization_id not in _PLATFORM_SENTINELS
            ):
                try:
                    from apps.rag.models import EmbeddingTask
                    EmbeddingTask.objects.create(
                        task_type='skill',
                        target_id=_skill_key_to_uuid(skill_key),
                        organization_id=_embed_organization_id,
                        status='failed',
                        error_message=str(exc)[:500],
                    )
                except Exception as task_exc:
                    logger.warning(
                        "[SkillEmbedding] failed to create EmbeddingTask for %s: %s",
                        skill_key, task_exc,
                    )
            return False

        metadata: Dict[str, Any] = {
            "name": name,
            "description": description,
            "source": source,
            "location": location or f"skills://{skill_key}",
            "tags": tags or [],
        }
        if auto_activate_for:
            metadata["auto_activate_for"] = auto_activate_for
        if organization_id:
            metadata["organization_id"] = str(organization_id)

        # SK-004：使用 bulk_create(update_conflicts=True) 原子 upsert
        obj = SkillEmbedding(
            skill_key=skill_key,
            source=source,
            organization_id=organization_uuid,
            space_id=None,
            content=content,
            content_hash=content_hash,
            embedding=vector,
            metadata=metadata,
        )
        SkillEmbedding.objects.bulk_create(
            [obj],
            update_conflicts=True,
            unique_fields=["skill_key"],
            update_fields=[
                "source", "organization_id", "space_id", "content",
                "content_hash", "embedding", "metadata", "updated_at",
            ],
        )
        logger.info("[SkillEmbedding] indexed %s (source=%s)", skill_key, source)
        return True

    @classmethod
    def index_all_skills(
        cls,
        *,
        user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> Dict[str, int]:
        """Index all available skills. Returns counts of created/skipped/failed."""
        from apps.skills.services.registry_service import SkillsRegistryService

        if user_id and organization_id and agent_id:
            skills = SkillsRegistryService.list_available_skills(
                user_id=user_id,
                organization_id=organization_id,
                agent_id=agent_id,
            )
        else:
            platform_skills = SkillsRegistryService.list_platform_skills()
            app_skills = SkillsRegistryService.list_app_skills()
            user_skills = cls._collect_all_user_skills()
            skills = SkillsRegistryService.merge_skills(
                platform_skills=platform_skills,
                app_skills=app_skills,
                user_skills=user_skills,
            )

        counts = cls._index_entries(skills, organization_id=organization_id)
        if user_id and organization_id:
            cls._cleanup_stale(
                skills, scope_source="organization", organization_id=organization_id,
            )
        else:
            cls._cleanup_stale(skills, scope_source="global")
        logger.info(
            "[SkillEmbedding] index_all done: indexed=%d skipped=%d failed=%d",
            counts["indexed"], counts["skipped"], counts["failed"],
        )
        return counts

    @classmethod
    def _collect_all_user_skills(cls) -> List[Dict[str, Any]]:
        """全局索引兜底：只拉取已挂组织的 user Skill。

        个人技能默认没有 organization_id，不进组织隔离的向量索引。
        """
        try:
            from apps.skills.models import Skill
        except Exception:
            return []
        result: List[Dict[str, Any]] = []
        for skill in Skill.objects.all().iterator(chunk_size=500):
            if not skill.organization_id:
                continue
            try:
                entry = skill.to_index_entry()
                result.append(entry)
            except Exception:
                logger.debug(
                    "[SkillEmbedding] skip skill %s in global index", skill.skill_id,
                    exc_info=True,
                )
        return result

    @classmethod
    def index_organization_skills(
        cls,
        *,
        user_id: str,
        organization_id: str,
        agent_id: Optional[str] = None,
    ) -> Dict[str, int]:
        """Index user-source skills visible to (user, organization)。

        ：租户键改为 organization_id；不再需要 space_id 反查 workspace。
        """
        from apps.skills.services.registry_service import SkillsRegistryService

        local_skills = SkillsRegistryService.list_user_skills_visible(
            user_id=user_id,
            organization_id=organization_id,
            agent_id=agent_id,
        )
        org_skills = [
            entry for entry in local_skills
            if entry.get("visibility") == "organization" or entry.get("organization_id")
        ]
        if not org_skills:
            return {"indexed": 0, "skipped": 0, "failed": 0}

        for entry in org_skills:
            meta = entry.get("meta") or {}
            meta["organization_id"] = str(organization_id)
            entry["meta"] = meta

        counts = cls._index_entries(org_skills, organization_id=organization_id)

        from apps.rag.models import SkillEmbedding
        current_keys = {e.get("skill_key") for e in org_skills if e.get("skill_key")}
        organization_uuid = None
        try:
            organization_uuid = uuid.UUID(str(organization_id))
        except (ValueError, AttributeError):
            pass

        if organization_uuid is None:
            logger.warning(
                "[SkillEmbedding] index_organization skipped stale cleanup: "
                "invalid organization_id=%s", organization_id,
            )
            return counts

        stale_qs = (
            SkillEmbedding.objects
            .filter(source="user", organization_id=organization_uuid)
            .exclude(skill_key__in=current_keys)
        )
        stale_count = stale_qs.count()
        if stale_count:
            stale_qs.delete()
            logger.info(
                "[SkillEmbedding] cleaned up %d stale organization entries for %s",
                stale_count, organization_id,
            )

        logger.info(
            "[SkillEmbedding] index_organization(%s) done: indexed=%d skipped=%d failed=%d stale_removed=%d",
            organization_id, counts["indexed"], counts["skipped"], counts["failed"], stale_count,
        )
        return counts

    @classmethod
    def _index_entries(
        cls,
        skills: List[Dict[str, Any]],
        *,
        organization_id: Optional[str] = None,
    ) -> Dict[str, int]:
        counts = {"indexed": 0, "skipped": 0, "failed": 0}
        for entry in skills:
            skill_key = entry.get("skill_key") or ""
            if not skill_key:
                continue
            try:
                parameters = entry.get("parameters") or entry.get("input_schema") or None
                if parameters and not isinstance(parameters, list):
                    parameters = None

                entry_meta = entry.get("meta") or {}
                entry_org_id = (
                    organization_id
                    or entry_meta.get("organization_id")
                    or entry.get("organization_id")
                )

                updated = cls.index_skill(
                    skill_key=skill_key,
                    name=entry.get("name") or skill_key,
                    description=entry.get("description") or "",
                    source=entry.get("source") or "platform",
                    tags=entry.get("tags"),
                    location=entry.get("location"),
                    auto_activate_for=entry.get("auto_activate_for"),
                    parameters=parameters,
                    organization_id=entry_org_id,
                )
                if updated:
                    counts["indexed"] += 1
                else:
                    counts["skipped"] += 1
            except Exception as exc:
                logger.warning("[SkillEmbedding] index failed for %s: %s", skill_key, exc)
                counts["failed"] += 1
        return counts

    @classmethod
    def _cleanup_stale(
        cls,
        current_skills: List[Dict[str, Any]],
        scope_source: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> int:
        """Remove embeddings for skills that no longer exist.

        scope_source="global"      → 清理非 user 条目（保护租户数据）
        scope_source="organization" → 清理指定 organization 的 user 条目
        其他                        → 拒绝执行（防止跨租户误删）
        """
        from apps.rag.models import SkillEmbedding

        current_keys = {e.get("skill_key") for e in current_skills if e.get("skill_key")}
        qs = SkillEmbedding.objects.exclude(skill_key__in=current_keys)

        if scope_source == "global":
            qs = qs.exclude(source="user")
        elif scope_source == "organization" and organization_id:
            organization_uuid = None
            try:
                organization_uuid = uuid.UUID(str(organization_id))
            except (ValueError, AttributeError):
                pass
            if organization_uuid is None:
                logger.warning(
                    "[SkillEmbedding] _cleanup_stale invalid organization_id=%s",
                    organization_id,
                )
                return 0
            qs = qs.filter(source="user", organization_id=organization_uuid)
        else:
            logger.warning(
                "[SkillEmbedding] _cleanup_stale called without valid scope "
                "(scope_source=%s, organization_id=%s), skipping",
                scope_source, organization_id,
            )
            return 0

        count = qs.count()
        if count:
            qs.delete()
            logger.info("[SkillEmbedding] cleaned up %d stale entries (scope=%s)", count, scope_source)
        return count

    @classmethod
    def repair_ghost_local_agent_entries(cls) -> int:
        """删除无 organization_id 的 user 幽灵记录。

        SK-001 修复工具：历史上可能存在 source='user' 但 organization_id
        为 NULL 的记录。这类记录在 search() 中对任何用户都不可见，
        却占用存储并污染统计数据。返回删除的记录数。
        """
        from apps.rag.models import SkillEmbedding

        ghost_qs = SkillEmbedding.objects.filter(
            source="user", organization_id__isnull=True,
        )
        count = ghost_qs.count()
        if count:
            ghost_qs.delete()
            logger.warning(
                "[SkillEmbedding] repair_ghost_local_agent_entries: deleted %d ghost records "
                "(user without organization_id). These were invisible to all users.",
                count,
            )
        else:
            logger.info("[SkillEmbedding] repair_ghost_local_agent_entries: no ghost records found.")
        return count

    @classmethod
    def get_all_local_agent_organization_ids(cls) -> List[str]:
        """返回所有含 user Skills 的 organization_id 列表（供 Beat 定时重建索引）。"""
        from apps.rag.models import SkillEmbedding

        raw = (
            SkillEmbedding.objects
            .filter(source="user", organization_id__isnull=False)
            .values_list("organization_id", flat=True)
            .distinct()
        )
        return [str(oid) for oid in raw if oid]

    @classmethod
    def search(
        cls,
        query: str,
        *,
        top_k: int = 5,
        source_filter: Optional[str] = None,
        similarity_threshold: Optional[float] = None,
        organization_id: Optional[str] = None,
        _query_vector: Optional[List[float]] = None,
    ) -> List[Dict[str, Any]]:
        """Semantic search for skills matching the query.

        Returns a list of dicts with: skill_key, name, description, source,
        location, tags, similarity_score.

        ：租户隔离键改为 ``organization_id``——仅返回属于该 organization 的
        user skill，无此参数时排除所有 user skill 防止跨租户泄漏。

        _query_vector：已预计算的查询向量（由 UnifiedSearchService 传入以避免重复 embedding）。
        """
        from apps.rag.models import SkillEmbedding
        from pgvector.django import CosineDistance
        from django.db.models import F
        from django.conf import settings as _settings

        # EMB-004：Skill 专属阈值默认 0.5，比 RAG 通用 0.7 更宽松以提高召回率。
        if similarity_threshold is None:
            similarity_threshold = getattr(_settings, 'SKILL_SEARCH_SIMILARITY_THRESHOLD', 0.5)

        if _query_vector is not None:
            query_vector = _query_vector
        elif query and query.strip():
            try:
                from apps.services.llm.services.embedding import embed_text as _unified_embed
                _emb_r = _unified_embed(
                    scene_key="rag_search_query",
                    texts=[query],
                    user_id="",
                    organization_id="",
                )
                query_vector = _emb_r.vectors[0]
            except Exception as exc:
                logger.warning("[SkillSearch] embedding failed: %s", exc)
                return []
        else:
            return []

        from django.db.models import Q

        organization_uuid = None
        if organization_id:
            try:
                organization_uuid = uuid.UUID(str(organization_id))
            except (ValueError, AttributeError):
                pass

        qs = SkillEmbedding.objects.all()
        if source_filter:
            from apps.skills.services.registry_service import normalize_skill_source
            qs = qs.filter(source=normalize_skill_source(source_filter))
        if organization_uuid:
            qs = qs.filter(
                ~Q(source="user")
                | Q(source="user", organization_id=organization_uuid)
            )
        else:
            qs = qs.exclude(source="user")

        results = (
            qs.annotate(distance=CosineDistance("embedding", query_vector))
            .annotate(similarity=1 - F("distance"))
            .filter(similarity__gte=similarity_threshold)
            .order_by("distance")[:top_k]
        )

        formatted: List[Dict[str, Any]] = []
        for r in results:
            meta = r.metadata or {}
            formatted.append({
                "skill_key": r.skill_key,
                "name": meta.get("name", r.skill_key),
                "description": meta.get("description", ""),
                "source": r.source,
                "location": meta.get("location", f"skills://{r.skill_key}"),
                "tags": meta.get("tags", []),
                "similarity_score": round(float(r.similarity), 4),
            })

        return formatted

    @staticmethod
    def trigger_reindex(
        skill_key: str,
        name: str,
        description: str,
        source: str = "platform",
        tags: Optional[List[str]] = None,
        location: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> None:
        """EMB-001：事件驱动触发单 Skill 向量索引刷新。"""
        try:
            from apps.rag.tasks import index_single_skill_task
            index_single_skill_task.delay(
                skill_key=skill_key,
                name=name,
                description=description,
                source=source,
                tags=tags,
                location=location,
                organization_id=organization_id,
            )
        except Exception:
            logger.warning(
                "[SkillEmbedding] trigger_reindex failed for %s, will be caught by periodic task",
                skill_key, exc_info=True,
            )


__all__ = ["SkillEmbeddingService"]
