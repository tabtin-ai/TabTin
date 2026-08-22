"""
Context Item 服务

提供资源列表、智能体空间内搜索、跨智能体空间搜索（全局搜索）、回收站管理。
"""
import logging
import re
from typing import Optional, Dict, Any, List, Tuple
from uuid import UUID
from django.db import models, transaction
from django.db.models import Q
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import ContextItem, Space, SpaceActivityEvent, Workspace, Project
from apps.tabtinspace.constants import REMOVED_CONTEXT_ITEM_TYPES
from apps.tabtinspace.resource_registry import get_resource_model
from apps.tabtinspace.schemas.common import normalize_legacy_item_type
from apps.tabtinspace.services.space_activity_service import record_team_space_activity
from .base import BaseService

logger = logging.getLogger(__name__)

_SEARCH_SEPARATOR_RE = re.compile(r"[#>*_\-\[\]\(\)]")

# ：PATCH parent_id 区分「未传」与「显式 null 落根」
_PARENT_ID_UNSET = object()


def _search_query_variants(query: str) -> tuple[str, ...]:
    variants = [query]
    separator_normalized = _SEARCH_SEPARATOR_RE.sub(" ", query)
    separator_normalized = re.sub(r"\s+", " ", separator_normalized).strip()
    if separator_normalized and separator_normalized.casefold() != query.casefold():
        variants.append(separator_normalized)
    return tuple(variants)


def _icontains_variants_q(field: str, variants: tuple[str, ...]) -> Q:
    fallback_q = Q(**{f"{field}__icontains": variants[0]})
    for variant in variants[1:]:
        fallback_q |= Q(**{f"{field}__icontains": variant})
    return fallback_q


from apps.tabtinspace.services.asset_host import (
    asset_host_q as _asset_host_q,
    create_host_kwargs as _create_host_kwargs,
    host_id_of as _host_id_of,
    organization_id_of as _organization_id_of,
)


class ContextItemService(BaseService):

    def _check_item_permission(self, item: ContextItem, required_role: str) -> bool:
        """ContextItem 权限。

        云资产（tabdoc/tabdata/tabfiles）走资源级 ACL，不回退组织角色。
        其它类型仍走 workspace/project 宿主权限。
        """
        from apps.tabtinspace.services.cloud_resource_acl import (
            CLOUD_ITEM_TYPES,
            check_item_resource_permission,
        )

        if item.item_type in CLOUD_ITEM_TYPES:
            return check_item_resource_permission(self.user, item, required_role)

        host_id = _host_id_of(item)
        if host_id:
            return self.check_space_permission(host_id, required_role)
        organization_id = _organization_id_of(item)
        if organization_id:
            return self.check_organization_permission(organization_id, required_role)
        return False

    @staticmethod
    def _exclude_removed_module_types(qs):
        """已下线模块（如 TabDesign）不再出现在列表/搜索/回收站视图中。"""
        return qs.exclude(item_type__in=REMOVED_CONTEXT_ITEM_TYPES)

    @staticmethod
    def _apply_archive_filter(qs, is_archived: Optional[bool]):
        """普通资源列表不应把回收站条目当作 active/root 资源返回。"""
        if is_archived is None:
            return qs
        qs = qs.filter(is_archived=is_archived)
        if is_archived is False:
            qs = qs.filter(trashed_at__isnull=True).exclude(status="trashed")
        return qs

    def _archive_orphan_resource_items(self, qs) -> set[UUID]:
        """归档查询范围内已丢失源资源的 active ContextItem，并返回其 ID。"""
        rows = list(
            qs.filter(is_archived=False)
            .exclude(resource_id="")
            .values_list("id", "item_type", "resource_id")
        )
        if not rows:
            return set()

        grouped: dict[str, list[tuple[UUID, str]]] = {}
        for item_id, item_type, resource_id in rows:
            grouped.setdefault(normalize_legacy_item_type(item_type), []).append((item_id, resource_id))

        orphan_ids: set[UUID] = set()
        for item_type, entries in grouped.items():
            model_cls = get_resource_model(item_type)
            if model_cls is None:
                continue

            valid_ids: list[UUID] = []
            normalized_ids_by_item: dict[UUID, str] = {}
            invalid_item_ids: set[UUID] = set()
            for item_id, resource_id in entries:
                try:
                    normalized_resource_id = str(UUID(str(resource_id).strip()))
                    valid_ids.append(UUID(normalized_resource_id))
                    normalized_ids_by_item[item_id] = normalized_resource_id
                except (TypeError, ValueError, AttributeError):
                    invalid_item_ids.add(item_id)

            # 活跃源 ID：行存在且未进回收站。源已 trashed 仍算幽灵，需归档投影。
            active_resource_ids: set[str] = set()
            if valid_ids:
                concrete_fields = {field.name for field in model_cls._meta.concrete_fields}
                if "trashed_at" in concrete_fields:
                    for resource_id, trashed_at in model_cls.objects.filter(
                        id__in=valid_ids
                    ).values_list("id", "trashed_at"):
                        if trashed_at is None:
                            active_resource_ids.add(str(resource_id))
                elif "status" in concrete_fields:
                    for resource_id, status in model_cls.objects.filter(
                        id__in=valid_ids
                    ).values_list("id", "status"):
                        if status != "trashed":
                            active_resource_ids.add(str(resource_id))
                else:
                    active_resource_ids = {
                        str(resource_id)
                        for resource_id in model_cls.objects.filter(
                            id__in=valid_ids
                        ).values_list("id", flat=True)
                    }

            for item_id, _ in entries:
                normalized_resource_id = normalized_ids_by_item.get(item_id)
                if item_id in invalid_item_ids or normalized_resource_id not in active_resource_ids:
                    orphan_ids.add(item_id)

        if orphan_ids:
            ContextItem.objects.filter(id__in=orphan_ids, is_archived=False).update(
                is_archived=True,
                updated_at=timezone.now(),
            )
            logger.warning(
                "ContextItemService archived %d orphan ContextItem(s) in read path",
                len(orphan_ids),
            )

        return orphan_ids

    def list_items(
        self,
        space_id: UUID,
        item_type: Optional[str] = None,
        is_archived: Optional[bool] = None,
        page: int = 1,
        page_size: int = 100,
        scope: str = "space",
    ) -> Tuple[List[ContextItem], int]:
        """
        资源列表。

        scope="space"：仅当前 Space 的资源（默认）。
        scope="organization"：用户在当前 organization 内可访问的所有 Space 的资源。
        """
        if scope == "organization":
            return self._list_items_organization(space_id, item_type, is_archived, page, page_size)

        if not self.check_space_permission(str(space_id), 'viewer'):
            return [], 0

        qs = ContextItem.objects.filter(_asset_host_q(space_id))
        qs = self._exclude_removed_module_types(qs)
        if item_type:
            qs = qs.filter(item_type=normalize_legacy_item_type(item_type))
        qs = self._apply_archive_filter(qs, is_archived)

        orphan_ids = self._archive_orphan_resource_items(qs)
        if orphan_ids:
            qs = qs.exclude(id__in=orphan_ids)

        qs = qs.order_by('-is_pinned', '-pinned_at', '-updated_at')
        total = qs.count()

        offset = (page - 1) * page_size
        items = list(qs[offset:offset + page_size])
        return items, total

    def _list_items_organization(
        self,
        current_space_id: UUID,
        item_type: Optional[str],
        is_archived: Optional[bool],
        page: int,
        page_size: int,
    ) -> Tuple[List[ContextItem], int]:
        """Organization 级资源列表：返回用户可访问的所有 Space 的 ContextItem。

        当前 Space 的资源会通过排序 boost 优先展示，但不做隔离——
        其他 Space 的资源在 boost 之后依然可见。
        """
        space = (
            Workspace.objects.filter(id=current_space_id).first()
            or Project.objects.filter(id=current_space_id).first()
        )
        if not space:
            return [], 0

        return self.list_items_for_organization(
            organization_id=space.organization_id,
            item_type=item_type,
            is_archived=is_archived,
            page=page,
            page_size=page_size,
            current_space_id=current_space_id,
        )

    def list_items_for_organization(
        self,
        organization_id: UUID,
        item_type: Optional[str] = None,
        is_archived: Optional[bool] = None,
        page: int = 1,
        page_size: int = 100,
        current_space_id: Optional[UUID] = None,
        collection_id: Optional[UUID] = None,
        unfiled_only: bool = False,
        item_types: Optional[set[str]] = None,
        visited_only: bool = False,
        sort: Optional[str] = None,
    ) -> Tuple[List[ContextItem], int]:
        """返回当前用户在指定 Organization 内可访问的资源列表。

        ：云资产（tabdoc/tabdata/tabfiles）默认私有——仅 owner 或显式 ACL 可见；
        组织成员身份本身不授予内容发现权。其它非云资产仍按可访问 Space 宿主聚合。

        `current_space_id` 仅用于旧的 space-scoped organization 查询排序 boost；
        调用方已知 organization 时不需要再提供任意 Space 作为 anchor。

        ：`collection_id` 按云盘文件夹过滤；`unfiled_only=True` 只返回未入夹资源。

        云盘首页：`item_types` 在分页前限定白名单类型；
        `visited_only` + `sort=-last_visited_at` 按当前用户 ResourceAccess 排序分页。
        """
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            return [], 0
        if not self.user:
            return [], 0

        from apps.tabtinspace.services.accessible_space_resolver import get_accessible_space_ids
        from apps.tabtinspace.services.cloud_resource_acl import (
            CLOUD_ITEM_TYPES,
            build_cloud_item_visibility_q,
        )

        accessible = get_accessible_space_ids(str(self.user.id), organization_id)
        normalized_type = normalize_legacy_item_type(item_type) if item_type else None
        normalized_types: Optional[set[str]] = None
        if item_types is not None:
            normalized_types = {
                normalize_legacy_item_type(t) for t in item_types
            } & set(CLOUD_ITEM_TYPES)
            if not normalized_types:
                return [], 0

        # 云资产：资源级可见性（不依赖 Space membership）
        if normalized_types is not None:
            cloud_types = normalized_types
        elif normalized_type in CLOUD_ITEM_TYPES:
            cloud_types = {normalized_type}
        else:
            cloud_types = set(CLOUD_ITEM_TYPES)
        visibility_q = Q(organization_id=organization_id) & build_cloud_item_visibility_q(
            self.user, item_types=cloud_types,
        )

        # 非云资产：仍按可访问 Space 聚合（排除云类型以免绕过 ACL）
        # item_types 白名单路径只返回云盘三种，不再并入非云资产
        if (
            normalized_types is None
            and accessible
            and (normalized_type is None or normalized_type not in CLOUD_ITEM_TYPES)
        ):
            space_host_q = (
                Q(workspace_id__in=accessible) | Q(project_id__in=accessible)
            ) & ~Q(item_type__in=CLOUD_ITEM_TYPES)
            if normalized_type:
                space_host_q &= Q(item_type=normalized_type)
            visibility_q |= space_host_q

        qs = ContextItem.objects.filter(visibility_q).select_related(
            'workspace', 'project', 'organization',
        )
        qs = self._exclude_removed_module_types(qs)
        if normalized_types is not None:
            qs = qs.filter(item_type__in=normalized_types)
        elif normalized_type:
            qs = qs.filter(item_type=normalized_type)
        if unfiled_only:
            qs = qs.filter(collection_id__isnull=True)
        elif collection_id is not None:
            qs = qs.filter(collection_id=collection_id)
        qs = self._apply_archive_filter(qs, is_archived)
        orphan_ids = self._archive_orphan_resource_items(qs)
        if orphan_ids:
            qs = qs.exclude(id__in=orphan_ids)

        sort_by_visited = visited_only or sort == "-last_visited_at"
        if sort_by_visited:
            from django.db.models import F, OuterRef, Subquery
            from apps.tabtinspace.models import ResourceAccess

            access_subq = ResourceAccess.objects.filter(
                user_id=self.user.id,
                context_item_id=OuterRef("pk"),
            ).values("last_visited_at")[:1]
            qs = qs.annotate(_user_last_visited_at=Subquery(access_subq))
            if visited_only:
                qs = qs.filter(_user_last_visited_at__isnull=False)
            qs = qs.order_by(
                F("_user_last_visited_at").desc(nulls_last=True),
                "-id",
            )
        elif current_space_id:
            from django.db.models import Case, When, Value, IntegerField
            current_space_boost = Case(
                When(workspace_id=current_space_id, then=Value(0)),
                When(project_id=current_space_id, then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            )
            qs = qs.annotate(_space_boost=current_space_boost).order_by(
                '-is_pinned', '-pinned_at', '_space_boost', '-updated_at',
            )
        else:
            qs = qs.order_by('-is_pinned', '-pinned_at', '-updated_at')

        total = qs.count()

        offset = (page - 1) * page_size
        items = list(qs[offset:offset + page_size])
        return items, total

    def list_all_visible_cloud_items_for_tree(
        self,
        organization_id: UUID,
        item_types: Optional[set[str]] = None,
        limit: int = 5000,
        owned_only: bool = False,
    ) -> List[ContextItem]:
        """知识库树专用：拉取 org 内云资产（不分页，带上限）。"""
        if not self.check_organization_permission(str(organization_id), "viewer"):
            return []
        if not self.user:
            return []

        from apps.tabtinspace.services.cloud_resource_acl import (
            CLOUD_ITEM_TYPES,
            build_cloud_item_visibility_q,
            build_owned_cloud_item_visibility_q,
        )

        types = set(item_types or CLOUD_ITEM_TYPES) & CLOUD_ITEM_TYPES
        if not types:
            return []

        visibility_builder = (
            build_owned_cloud_item_visibility_q
            if owned_only
            else build_cloud_item_visibility_q
        )
        visibility_q = Q(organization_id=organization_id) & visibility_builder(
            self.user, item_types=types,
        )
        qs = (
            ContextItem.objects.filter(visibility_q)
            .filter(item_type__in=types)
            .select_related("workspace", "project", "organization")
        )
        qs = self._exclude_removed_module_types(qs)
        qs = self._apply_archive_filter(qs, False)
        orphan_ids = self._archive_orphan_resource_items(qs)
        if orphan_ids:
            qs = qs.exclude(id__in=orphan_ids)

        qs = qs.order_by("-is_pinned", "-pinned_at", "order", "-updated_at")
        return list(qs[: max(1, min(int(limit), 5000))])

    def record_access(self, item_id: UUID) -> bool:
        """记录当前用户对资源的最近访问（upsert last_visited_at=now）。

        轻量读路径埋点：只做存在性 + viewer 权限校验，**不**复用 get_item——
        后者每次都会跑 orphan 检查并可能把资源归档（写副作用），不适合高频 ping。
        每个 (user, context_item) 仅一行，靠唯一约束保证幂等；并发由 Django
        update_or_create 的 savepoint 兜底，不会抛 IntegrityError。
        """
        if not self.user:
            return False

        item = (
            ContextItem.objects.filter(id=item_id)
            .only("id", "workspace_id", "project_id", "organization_id")
            .first()
        )
        if not item:
            return False
        if not self._check_item_permission(item, 'viewer'):
            return False

        from apps.tabtinspace.models import ResourceAccess
        ResourceAccess.objects.update_or_create(
            user_id=self.user.id,
            context_item_id=item.id,
            defaults={"last_visited_at": timezone.now()},
        )
        return True

    def get_item(self, item_id: UUID) -> Optional[ContextItem]:
        try:
            item = ContextItem.objects.select_related(
                'workspace', 'project', 'organization',
            ).get(id=item_id)
        except ContextItem.DoesNotExist:
            return None

        if not self._check_item_permission(item, 'viewer'):
            return None
        if item.item_type in REMOVED_CONTEXT_ITEM_TYPES:
            return None
        orphan_ids = self._archive_orphan_resource_items(ContextItem.objects.filter(id=item.id))
        if item.id in orphan_ids:
            return None
        return item

    @transaction.atomic(using=postgres_app_db_alias())
    def create_item(
        self,
        space_id: UUID,
        item_type: str,
        title: Optional[str] = None,
        preview: Optional[str] = None,
        status: Optional[str] = None,
        order: Optional[int] = None,
        resource_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[ContextItem]:
        if not self.check_space_permission(str(space_id), 'editor'):
            return None
        canonical_type = normalize_legacy_item_type(item_type)
        if canonical_type in REMOVED_CONTEXT_ITEM_TYPES:
            return None
        item = ContextItem.objects.create(
            **_create_host_kwargs(space_id),
            item_type=item_type,
            title=title or '',
            preview=preview or '',
            status=status or '',
            order=order or 0,
            resource_id=resource_id or '',
            metadata=metadata or {},
            created_by=self.user if self.user else None,
            updated_by=self.user if self.user else None,
        )
        return item

    @transaction.atomic(using=postgres_app_db_alias())
    def update_item(
        self,
        item_id: UUID,
        title: Optional[str] = None,
        preview: Optional[str] = None,
        status: Optional[str] = None,
        order: Optional[int] = None,
        is_archived: Optional[bool] = None,
        is_pinned: Optional[bool] = None,
        resource_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        *,
        parent_id: Any = _PARENT_ID_UNSET,
    ) -> Optional[ContextItem]:
        try:
            item = ContextItem.objects.get(id=item_id)
        except ContextItem.DoesNotExist:
            return None

        archive_transition: Optional[bool] = None
        if is_archived is not None and is_archived != item.is_archived:
            archive_transition = is_archived

        # ：云资产改内容需 editor；归档/取消归档等同 trash 生命周期，需 admin
        from apps.tabtinspace.services.cloud_resource_acl import CLOUD_ITEM_TYPES

        required = 'editor'
        if archive_transition is not None and item.item_type in CLOUD_ITEM_TYPES:
            required = 'admin'
        # ：移动节点（改 parent）需要 can_move → editor
        if not self._check_item_permission(item, required):
            return None
        if title is not None:
            item.title = title
        if preview is not None:
            item.preview = preview
        if status is not None:
            item.status = status
        if order is not None:
            item.order = order
        if is_archived is not None:
            item.is_archived = is_archived
        if is_pinned is not None:
            item.is_pinned = is_pinned
            item.pinned_at = timezone.now() if is_pinned else None
        if resource_id is not None:
            item.resource_id = resource_id
        if metadata is not None:
            item.metadata = metadata
        if parent_id is not _PARENT_ID_UNSET:
            from apps.tabtinspace.services.context_item_parent import assign_parent

            # assign_parent 会 save；先挂父再写其它字段时统一一次 save
            assign_parent(item, parent_id, save=False)
        if self.user:
            item.updated_by = self.user

        item.save()
        if archive_transition is not None:
            self._record_archive_activity_on_commit(item, archived=archive_transition)
        return item

    def _record_archive_activity_on_commit(self, item: ContextItem, *, archived: bool) -> None:
        """资产归档/恢复留痕（提交后 best-effort，非 team_space 自动跳过）。"""
        actor_user = self.user
        host_id = _host_id_of(item)
        space = (
            (
                Project.objects.filter(id=host_id).only('id', 'organization_id').first()
                or Workspace.objects.filter(id=host_id).only('id', 'organization_id').first()
            )
            if host_id else None
        )
        if space is None or not isinstance(space, Project):
            return
        item_id = str(item.id)
        item_title = item.title
        item_type = item.item_type
        event_type = (
            SpaceActivityEvent.EventType.ASSET_ARCHIVED
            if archived
            else SpaceActivityEvent.EventType.ASSET_RESTORED
        )

        def _record():
            record_team_space_activity(
                space,
                event_type,
                actor_user=actor_user,
                target_type='asset',
                target_id=item_id,
                target_name=item_title,
                metadata={'item_type': item_type},
            )

        transaction.on_commit(_record, using=postgres_app_db_alias())

    @transaction.atomic(using=postgres_app_db_alias())
    def archive_item(self, item_id: UUID) -> bool:
        item = self.update_item(item_id, is_archived=True)
        return item is not None

    # ── 搜索 ──

    def _workspace_search_host_q(self, space_id: UUID) -> Q:
        """Workspace 搜索宿主过滤。

        除当前 Workspace/Project 宿主资源外，并入同 Organization 下当前用户
        可见的 org-only 云资产（tabdoc/tabdata/tabfiles）。云盘写路径已收敛为
        Organization-only，搜索必须对齐，否则会话内搜不到刚上传的文件。
        """
        host_q = _asset_host_q(space_id)
        if not self.user:
            return host_q

        space = (
            Workspace.objects.filter(id=space_id).only("organization_id").first()
            or Project.objects.filter(id=space_id).only("organization_id").first()
        )
        if not space or not getattr(space, "organization_id", None):
            return host_q

        from apps.tabtinspace.services.cloud_resource_acl import (
            CLOUD_ITEM_TYPES,
            build_cloud_item_visibility_q,
        )

        org_only_cloud_q = (
            Q(organization_id=space.organization_id)
            & Q(workspace_id__isnull=True)
            & Q(project_id__isnull=True)
            & build_cloud_item_visibility_q(self.user, item_types=CLOUD_ITEM_TYPES)
        )
        return host_q | org_only_cloud_q

    def search_items(
        self,
        space_id: UUID,
        query: str,
        item_type: Optional[str] = None,
        include_archived: bool = False,
        page: int = 1,
        page_size: int = 50,
    ) -> Tuple[List[ContextItem], int]:
        """
        智能体空间内全文搜索。

        使用 PostgreSQL tsvector + GIN 索引，同时保留 icontains fallback。
        结果按相关性排序。

        ：同时召回同组织下当前用户可见的 org-only 云资产。
        """
        if not self.check_space_permission(str(space_id), "viewer"):
            return [], 0
        if not query or not query.strip():
            return [], 0

        query = query.strip()
        query_variants = _search_query_variants(query)
        title_fallback_q = _icontains_variants_q("title", query_variants)
        preview_fallback_q = _icontains_variants_q("preview", query_variants)

        qs = ContextItem.objects.filter(self._workspace_search_host_q(space_id))
        qs = self._exclude_removed_module_types(qs)
        if not include_archived:
            qs = qs.filter(is_archived=False)
        if item_type:
            qs = qs.filter(item_type=normalize_legacy_item_type(item_type))
        from django.db import connections
        _is_pg = connections[postgres_app_db_alias()].vendor == 'postgresql'

        if _is_pg:
            from django.contrib.postgres.search import SearchQuery, SearchRank
            search_q = SearchQuery(query, config='simple')
            qs = qs.filter(
                models.Q(search_vector=search_q)
                | title_fallback_q
                | preview_fallback_q
            ).annotate(
                rank=SearchRank('search_vector', search_q)
            ).order_by('-rank', '-updated_at')
        else:
            qs = qs.filter(
                title_fallback_q | preview_fallback_q
            ).order_by('-updated_at')

        orphan_ids = self._archive_orphan_resource_items(qs)
        if orphan_ids:
            qs = qs.exclude(id__in=orphan_ids)

        total = qs.count()
        offset = (page - 1) * page_size
        items = list(qs[offset:offset + page_size])
        return items, total

    def organization_search(
        self,
        organization_id: UUID,
        query: str,
        item_type: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
        item_types: Optional[set[str]] = None,
    ) -> Tuple[List[ContextItem], int]:
        """
        跨智能体空间搜索——前端 Cmd+K 全局搜索的后端。

        在 organization 内所有智能体空间中搜索资源。
        返回的 ContextItem 通过 select_related('workspace', 'project') 预加载宿主信息，
        前端可据此按智能体空间分组展示搜索结果。

        云盘首页可传 ``item_types``（分页前白名单），与列表权限同口径。
        """
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            return [], 0
        if not query or not query.strip():
            return [], 0

        query = query.strip()
        query_variants = _search_query_variants(query)
        title_fallback_q = _icontains_variants_q("title", query_variants)
        preview_fallback_q = _icontains_variants_q("preview", query_variants)

        from apps.tabtinspace.services.accessible_space_resolver import get_accessible_space_ids
        from apps.tabtinspace.services.cloud_resource_acl import (
            CLOUD_ITEM_TYPES,
            build_cloud_item_visibility_q,
        )

        accessible = get_accessible_space_ids(str(self.user.id), organization_id)
        normalized_type = normalize_legacy_item_type(item_type) if item_type else None
        normalized_types: Optional[set[str]] = None
        if item_types is not None:
            normalized_types = {
                normalize_legacy_item_type(t) for t in item_types
            } & set(CLOUD_ITEM_TYPES)
            if not normalized_types:
                return [], 0

        # ：搜索与列表同口径——云资产仅 owner / 显式 ACL 可见
        cloud_types = normalized_types if normalized_types is not None else set(CLOUD_ITEM_TYPES)
        if normalized_type and normalized_type in CLOUD_ITEM_TYPES and normalized_types is None:
            cloud_types = {normalized_type}
        visibility_q = Q(organization_id=organization_id) & build_cloud_item_visibility_q(
            self.user, item_types=cloud_types,
        )
        # item_types 白名单路径只搜云盘三种；旧 type=单云类型时也不并入非云资产
        include_non_cloud = (
            normalized_types is None
            and (normalized_type is None or normalized_type not in CLOUD_ITEM_TYPES)
        )
        if include_non_cloud and accessible:
            space_host_q = (
                (Q(workspace_id__in=accessible) | Q(project_id__in=accessible))
                & ~Q(item_type__in=CLOUD_ITEM_TYPES)
            )
            if normalized_type:
                space_host_q &= Q(item_type=normalized_type)
            visibility_q |= space_host_q

        from django.db import connections
        _is_pg = connections[postgres_app_db_alias()].vendor == 'postgresql'

        base_qs = self._exclude_removed_module_types(
            ContextItem.objects.filter(visibility_q, is_archived=False)
            .select_related('workspace', 'project', 'organization')
        )
        if _is_pg:
            from django.contrib.postgres.search import SearchQuery, SearchRank
            search_q = SearchQuery(query, config='simple')
            qs = (
                base_qs.filter(
                    models.Q(search_vector=search_q)
                    | title_fallback_q
                    | preview_fallback_q
                )
                .annotate(rank=SearchRank('search_vector', search_q))
                .order_by('-rank', '-updated_at')
            )
        else:
            qs = (
                base_qs.filter(
                    title_fallback_q | preview_fallback_q
                )
                .order_by('-updated_at')
            )
        if normalized_types is not None:
            qs = qs.filter(item_type__in=normalized_types)
        elif normalized_type:
            qs = qs.filter(item_type=normalized_type)

        orphan_ids = self._archive_orphan_resource_items(qs)
        if orphan_ids:
            qs = qs.exclude(id__in=orphan_ids)

        total = qs.count()
        offset = (page - 1) * page_size
        items = list(qs[offset:offset + page_size])
        return items, total

    # ── 云盘「分享给我」统一 feed ──

    @staticmethod
    def encode_shared_feed_cursor(updated_at, item_id: UUID) -> str:
        import base64

        ts = updated_at.isoformat() if updated_at else ""
        raw = f"{ts}|{item_id}".encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    @staticmethod
    def decode_shared_feed_cursor(cursor: str):
        import base64
        from django.utils.dateparse import parse_datetime

        if not cursor:
            return None
        pad = "=" * (-len(cursor) % 4)
        try:
            raw = base64.urlsafe_b64decode(cursor + pad).decode("utf-8")
            ts_str, item_id_str = raw.split("|", 1)
            updated_at = parse_datetime(ts_str) if ts_str else None
            item_id = UUID(item_id_str)
        except (ValueError, TypeError, AttributeError):
            return None
        if updated_at is None:
            return None
        if timezone.is_naive(updated_at):
            updated_at = timezone.make_aware(updated_at, timezone.utc)
        return updated_at, item_id

    def list_cloud_drive_shared_feed(
        self,
        organization_id: UUID,
        item_types: Optional[set[str]] = None,
        cursor: Optional[str] = None,
        limit: int = 30,
    ) -> Tuple[List[ContextItem], List[dict], Optional[str]]:
        """组织级云盘「分享给我」统一分页 feed。

        在分页前聚合 tabdoc/tabdata/tabfiles，游标 ``(updated_at, context_item_id)``。
        File 同时返回 context_item_id 与 file_record_id。
        返回 ``(page_items, feed_rows, next_cursor)``，能力位由 router 复用
        ``_enrich_capabilities`` 回填（与 list/search 同口径）。
        """
        if not self.check_organization_permission(str(organization_id), "viewer"):
            return [], [], None
        if not self.user:
            return [], [], None

        from apps.tabtinspace.services.cloud_resource_acl import CLOUD_ITEM_TYPES

        types = (
            {normalize_legacy_item_type(t) for t in item_types} & set(CLOUD_ITEM_TYPES)
            if item_types is not None
            else set(CLOUD_ITEM_TYPES)
        )
        if not types:
            return [], [], None

        limit = max(1, min(int(limit or 30), 100))
        user_id = str(self.user.id)
        org_id_str = str(organization_id)

        # resource_id -> permission
        perm_by_type: dict[str, dict[str, str]] = {
            "tabdoc": {},
            "tabdata": {},
            "tabfiles": {},
        }
        owner_by_rid: dict[str, dict[str, str]] = {
            "tabdoc": {},
            "tabdata": {},
            "tabfiles": {},
        }

        if "tabdoc" in types:
            from apps.tabdoc.models import Document, DocumentPermission

            doc_perms = list(
                DocumentPermission.objects.filter(
                    is_active=True,
                    subject_type="user",
                    subject_id=user_id,
                ).values_list("document_id", "permission")
            )
            doc_ids = [str(did) for did, _ in doc_perms]
            docs = {
                str(d.id): d
                for d in Document.objects.filter(
                    id__in=doc_ids,
                    organization_id=organization_id,
                    status="active",
                    trashed_at__isnull=True,
                ).only("id", "owner_id", "title")
            } if doc_ids else {}
            for did, permission in doc_perms:
                rid = str(did)
                doc = docs.get(rid)
                if doc is None:
                    continue
                if str(getattr(doc, "owner_id", "") or "") == user_id:
                    continue
                perm_by_type["tabdoc"][rid] = permission
                owner_by_rid["tabdoc"][rid] = str(getattr(doc, "owner_id", "") or "")

        if "tabdata" in types:
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            from apps.tabdata.models import Table, TablePermission

            table_perms = list(
                TablePermission.objects.using(TABDATA_DB_ALIAS)
                .filter(
                    is_active=True,
                    subject_type="user",
                    subject_id=user_id,
                )
                .values_list("table_id", "permission")
            )
            table_ids = [str(tid) for tid, _ in table_perms]
            tables = {
                str(t.id): t
                for t in Table.objects.using(TABDATA_DB_ALIAS)
                .filter(
                    id__in=table_ids,
                    organization_id=organization_id,
                    is_archived=False,
                    trashed_at__isnull=True,
                )
                .only("id", "owner_id", "name")
            } if table_ids else {}
            for tid, permission in table_perms:
                rid = str(tid)
                table = tables.get(rid)
                if table is None:
                    continue
                owner_id = str(getattr(table, "owner_id", "") or "")
                if owner_id == user_id:
                    continue
                perm_by_type["tabdata"][rid] = permission
                owner_by_rid["tabdata"][rid] = owner_id

        if "tabfiles" in types:
            from apps.tabtinspace.models import FilePermission

            file_perms = list(
                FilePermission.objects.filter(
                    is_active=True,
                    subject_type="user",
                    subject_id=user_id,
                ).values_list("file_record_id", "permission")
            )
            for fid, permission in file_perms:
                perm_by_type["tabfiles"][str(fid)] = permission

        type_to_rids = {t: list(perm_by_type[t].keys()) for t in types if perm_by_type.get(t)}
        if not any(type_to_rids.values()):
            return [], [], None

        visibility_parts = []
        for item_type, rids in type_to_rids.items():
            if not rids:
                continue
            visibility_parts.append(Q(item_type=item_type, resource_id__in=rids))
        if not visibility_parts:
            return [], [], None

        item_q = visibility_parts[0]
        for part in visibility_parts[1:]:
            item_q |= part

        qs = (
            ContextItem.objects.filter(
                organization_id=organization_id,
                is_archived=False,
                trashed_at__isnull=True,
            )
            .exclude(status="trashed")
            .filter(item_q)
            .select_related("workspace", "project", "organization", "created_by")
        )
        # tabfiles：排除本人创建（owner）
        if "tabfiles" in types:
            qs = qs.exclude(item_type="tabfiles", created_by_id=self.user.id)

        cursor_values = self.decode_shared_feed_cursor(cursor) if cursor else None
        if cursor and cursor_values is None:
            raise ValueError("invalid cursor")
        if cursor_values is not None:
            cursor_ts, cursor_id = cursor_values
            qs = qs.filter(
                Q(updated_at__lt=cursor_ts)
                | Q(updated_at=cursor_ts, id__lt=cursor_id)
            )

        qs = qs.order_by("-updated_at", "-id")
        page_items = list(qs[: limit + 1])
        has_more = len(page_items) > limit
        page_items = page_items[:limit]

        # tabfiles owner 回填
        for item in page_items:
            if item.item_type == "tabfiles":
                owner_by_rid["tabfiles"][str(item.resource_id)] = str(
                    getattr(item, "created_by_id", "") or ""
                )

        owner_ids = {
            oid
            for mapping in owner_by_rid.values()
            for oid in mapping.values()
            if oid
        }
        info_map: dict = {}
        if owner_ids:
            try:
                from apps.services.billing.services.member_usage_service import (
                    build_user_info_map,
                )
                info_map = build_user_info_map(list(owner_ids))
            except Exception:
                info_map = {}

        from apps.tabtinspace.services.shared_resource_location import (
            build_shared_resource_locations,
        )

        locations = build_shared_resource_locations(self.user, page_items)
        feed: list[dict] = []
        for item in page_items:
            rid = str(item.resource_id or "")
            permission = perm_by_type.get(item.item_type, {}).get(rid, "viewer")
            owner_id = owner_by_rid.get(item.item_type, {}).get(rid, "")
            info = info_map.get(owner_id) if owner_id else None
            shared_by = (
                {
                    "id": owner_id,
                    "display_name": (info or {}).get("display_name", ""),
                    "avatar": (info or {}).get("avatar", ""),
                }
                if owner_id
                else None
            )
            host = item.workspace or item.project
            row = {
                "context_item_id": str(item.id),
                "resource_id": rid,
                "item_type": item.item_type,
                "title": item.title or "",
                "preview": (item.preview[:200] if item.preview else ""),
                "collection_id": str(item.collection_id) if item.collection_id else None,
                "organization_id": org_id_str,
                "space_id": str(host.id) if host else None,
                "space_name": host.name if host else "",
                "metadata": item.metadata or {},
                "is_pinned": bool(item.is_pinned),
                "updated_at": item.updated_at.isoformat() if item.updated_at else None,
                "created_at": item.created_at.isoformat() if item.created_at else None,
                "permission": permission,
                "shared_by": shared_by,
                "owner_id": owner_id or None,
                "location": locations.get(str(item.id), {"kind": "unavailable"}),
            }
            if item.item_type == "tabfiles":
                row["file_record_id"] = rid
            feed.append(row)

        next_cursor = None
        if has_more and page_items:
            last = page_items[-1]
            next_cursor = self.encode_shared_feed_cursor(last.updated_at, last.id)
        return page_items, feed, next_cursor

    # ── 回收站 ──

    def list_trashed_items(
        self,
        space_id: UUID,
        item_type: Optional[str] = None,
        page: int = 1,
        page_size: int = 100,
    ) -> Tuple[List[ContextItem], int]:
        """列出 Space 回收站内的资源"""
        if not self.check_space_permission(str(space_id), "viewer"):
            return [], 0

        qs = self._exclude_removed_module_types(
            ContextItem.objects.filter(_asset_host_q(space_id), trashed_at__isnull=False)
        )
        if item_type:
            qs = qs.filter(item_type=normalize_legacy_item_type(item_type))
        qs = qs.order_by("-trashed_at")
        total = qs.count()
        offset = (page - 1) * page_size
        items = list(qs[offset:offset + page_size])
        return items, total

    def list_trashed_items_for_organization(
        self,
        organization_id: UUID,
        item_type: Optional[str] = None,
        page: int = 1,
        page_size: int = 100,
    ) -> Tuple[List[ContextItem], int]:
        """列出当前用户在本组织删除的回收站资源（个人视角）。

        过滤：本组织宿主 ∩ trashed_by=自己（历史空 trashed_by 回退 created_by）。
        """
        if not self.check_organization_permission(str(organization_id), "viewer"):
            return [], 0
        if not self.user:
            return [], 0

        from apps.tabtinspace.services.cloud_resource_acl import (
            organization_resource_host_q,
            personal_trash_visibility_q,
        )

        normalized_type = normalize_legacy_item_type(item_type) if item_type else None
        qs = self._exclude_removed_module_types(
            ContextItem.objects.filter(
                organization_resource_host_q(organization_id),
                personal_trash_visibility_q(self.user),
                trashed_at__isnull=False,
            ).select_related("workspace", "project", "organization")
        )
        if normalized_type:
            qs = qs.filter(item_type=normalized_type)
        qs = qs.order_by("-trashed_at")
        total = qs.count()
        offset = (page - 1) * page_size
        items = list(qs[offset:offset + page_size])
        return items, total

    def empty_organization_trash(self, organization_id: UUID) -> int:
        """清空当前用户在本组织的回收站（仅自己删除的项）。"""
        if not self.check_organization_permission(str(organization_id), "viewer"):
            return 0
        if not self.user:
            return 0

        from apps.tabtinspace.services.cloud_resource_acl import (
            organization_resource_host_q,
            personal_trash_visibility_q,
        )

        trashed_items = ContextItem.objects.filter(
            organization_resource_host_q(organization_id),
            personal_trash_visibility_q(self.user),
            trashed_at__isnull=False,
        )
        count = trashed_items.count()
        if count == 0:
            return 0

        from apps.tabtinspace.services.trash_cleaner import TrashCleaner
        # 用户主动清空：必须包含死信，否则 cleanup_fail_count 触顶的条目会永久残留
        TrashCleaner.permanent_delete_trashed_items(
            trashed_items, user=self.user, include_dead_letters=True,
        )
        return count

    def empty_trash(self, space_id: UUID) -> int:
        """
        清空 Space 回收站 — 永久删除所有 trashed 资源。

        返回已删除的 ContextItem 数量。实际资源的永久删除由各模块
        service 负责（本方法仅清理 ContextItem 记录与对应的源资源）。
        """
        if not self.check_space_permission(str(space_id), "editor"):
            return 0

        trashed_items = ContextItem.objects.filter(
            _asset_host_q(space_id),
            trashed_at__isnull=False,
        )
        count = trashed_items.count()
        if count == 0:
            return 0

        from apps.tabtinspace.services.trash_cleaner import TrashCleaner
        TrashCleaner.permanent_delete_trashed_items(
            trashed_items, user=self.user, include_dead_letters=True,
        )
        return count
