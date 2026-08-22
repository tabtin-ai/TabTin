"""
Collection 服务 — 文件夹的 CRUD、嵌套、排序、资源归属管理
"""
from apps.tabtinspace.services.organization_control_guard import (
    assert_org_resource_write_for_space,
    assert_organization_resource_write_allowed_optional,
)
import logging
from typing import Optional, List, Dict, Any
from uuid import UUID

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Count, Max, Q
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import Collection, ContextItem, Project, Space, Workspace
from apps.tabtinspace.resource_registry import get_resource_model
from apps.tabtinspace.services.asset_host import (
    asset_host_q as _asset_host_q,
    create_host_kwargs as _create_host_kwargs,
    host_id_of as _host_id_of,
    organization_id_of as _organization_id_of,
)
from .base import BaseService, ServiceError

logger = logging.getLogger(__name__)


class CollectionService(BaseService):

    # ── 树形查询 ──

    def list_collections(self, space_id: UUID) -> List[Dict[str, Any]]:
        """返回 Space 内的文件夹树（根级文件夹列表，children 递归嵌套）。"""
        if not self.check_space_permission(str(space_id), 'viewer'):
            return []
        return self._list_collection_tree(host_id=space_id)

    def list_collections_for_organization(self, organization_id: UUID) -> List[Dict[str, Any]]:
        """返回 Organization 级（org-only）文件夹树。

        Organization 只做租户入口；文件夹内容默认仅创建者可见。
        """
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            return []
        if not self.user:
            return []
        return self._list_collection_tree(
            organization_id=organization_id,
            owner_user_id=self.user.id,
        )

    def _list_collection_tree(
        self,
        *,
        host_id: Optional[UUID] = None,
        organization_id: Optional[UUID] = None,
        owner_user_id=None,
    ) -> List[Dict[str, Any]]:
        qs = Collection.objects.filter(
            _asset_host_q(host_id, organization_id=organization_id)
        )
        # ：org-only 文件夹按创建者隔离；Space 宿主仍按 membership。
        if organization_id is not None:
            if owner_user_id is None:
                return []
            qs = qs.filter(created_by_id=owner_user_id)
        all_colls = list(
            qs.annotate(
                _item_count=Count(
                    'items',
                    filter=Q(items__is_archived=False, items__trashed_at__isnull=True),
                )
            )
            .order_by('-is_pinned', '-pinned_at', 'order', 'name')
        )
        return self._build_collection_tree(all_colls)

    @staticmethod
    def _build_collection_tree(all_colls: List[Collection]) -> List[Dict[str, Any]]:
        by_parent: Dict[Optional[str], List] = {}
        for coll in all_colls:
            pid = str(coll.parent_id) if coll.parent_id else None
            by_parent.setdefault(pid, []).append(coll)

        def _build_tree(parent_id: Optional[str]) -> List[Dict[str, Any]]:
            nodes = []
            for coll in by_parent.get(parent_id, []):
                nodes.append({
                    'id': coll.id,
                    'space_id': _host_id_of(coll),
                    'organization_id': coll.organization_id,
                    'parent_id': coll.parent_id,
                    'name': coll.name,
                    'icon': coll.icon,
                    'color': coll.color,
                    'order': coll.order,
                    'is_expanded': coll.is_expanded,
                    'is_pinned': bool(coll.is_pinned),
                    'pinned_at': coll.pinned_at,
                    'children': _build_tree(str(coll.id)),
                    'item_count': coll._item_count,
                    'created_by_id': str(coll.created_by_id) if coll.created_by_id else None,
                    'created_at': coll.created_at,
                    'updated_at': coll.updated_at,
                })
            return nodes

        return _build_tree(None)

    # ── CRUD ──

    @transaction.atomic(using=postgres_app_db_alias())
    def create_collection(
        self,
        space_id: UUID,
        name: str,
        parent_id: Optional[UUID] = None,
        icon: str = '📁',
        color: str = '',
        order: Optional[int] = None,
    ) -> Optional[Collection]:
        if not self.check_space_permission(str(space_id), 'editor'):
            return None
        if not (
            Workspace.objects.filter(id=space_id).exists()
            or Project.objects.filter(id=space_id).exists()
        ):
            return None

        assert_org_resource_write_for_space(space_id)

        if parent_id:
            try:
                parent = Collection.objects.get(_asset_host_q(space_id), id=parent_id)
            except Collection.DoesNotExist:
                raise ServiceError('PARENT_NOT_FOUND', '父文件夹不存在', status=404)
            if parent.get_depth() + 1 >= Collection.MAX_NESTING_DEPTH:
                raise ServiceError(
                    'MAX_DEPTH_EXCEEDED',
                    f'文件夹最大嵌套深度为 {Collection.MAX_NESTING_DEPTH} 层',
                    status=400,
                )
        else:
            parent_id = None

        dup_filter = _asset_host_q(space_id) & Q(name=name)
        if parent_id:
            dup_filter &= Q(parent_id=parent_id)
        else:
            dup_filter &= Q(parent__isnull=True)
        if Collection.objects.filter(dup_filter).exists():
            raise ServiceError('DUPLICATE_NAME', f'同级已存在名称「{name}」的文件夹', status=409)

        if order is None:
            sibling_filter = _asset_host_q(space_id)
            if parent_id:
                sibling_filter &= Q(parent_id=parent_id)
            else:
                sibling_filter &= Q(parent__isnull=True)
            max_order = (
                Collection.objects
                .filter(sibling_filter)
                .aggregate(m=Max('order'))
                .get('m') or 0
            )
            order = max_order + 1

        return Collection.objects.create(
            **_create_host_kwargs(space_id),
            parent_id=parent_id,
            name=name,
            icon=icon,
            color=color,
            order=order,
            created_by=self.user,
        )

    @transaction.atomic(using=postgres_app_db_alias())
    def create_collection_for_organization(
        self,
        organization_id: UUID,
        name: str,
        parent_id: Optional[UUID] = None,
        icon: str = '📁',
        color: str = '',
        order: Optional[int] = None,
    ) -> Optional[Collection]:
        """在 Organization 级（org-only）文件夹树下创建文件夹。"""
        if not self.check_organization_permission(str(organization_id), 'editor'):
            return None

        from apps.tabtinspace.models import Organization
        if not Organization.objects.filter(id=organization_id).exists():
            return None

        assert_organization_resource_write_allowed_optional(organization_id)

        org_host_q = _asset_host_q(organization_id=organization_id)
        # ：同名/同级排序按创建者分桶，不同用户可各自拥有同名根文件夹。
        owner_q = Q(created_by_id=self.user.id) if self.user else Q(pk__in=[])

        if parent_id:
            try:
                parent = Collection.objects.get(org_host_q & owner_q, id=parent_id)
            except Collection.DoesNotExist:
                raise ServiceError('PARENT_NOT_FOUND', '父文件夹不存在', status=404)
            if parent.get_depth() + 1 >= Collection.MAX_NESTING_DEPTH:
                raise ServiceError(
                    'MAX_DEPTH_EXCEEDED',
                    f'文件夹最大嵌套深度为 {Collection.MAX_NESTING_DEPTH} 层',
                    status=400,
                )
        else:
            parent_id = None

        dup_filter = org_host_q & owner_q & Q(name=name)
        if parent_id:
            dup_filter &= Q(parent_id=parent_id)
        else:
            dup_filter &= Q(parent__isnull=True)
        if Collection.objects.filter(dup_filter).exists():
            raise ServiceError('DUPLICATE_NAME', f'同级已存在名称「{name}」的文件夹', status=409)

        if order is None:
            sibling_filter = org_host_q & owner_q
            if parent_id:
                sibling_filter &= Q(parent_id=parent_id)
            else:
                sibling_filter &= Q(parent__isnull=True)
            max_order = (
                Collection.objects
                .filter(sibling_filter)
                .aggregate(m=Max('order'))
                .get('m') or 0
            )
            order = max_order + 1

        return Collection.objects.create(
            **_create_host_kwargs(organization_id=organization_id),
            parent_id=parent_id,
            name=name,
            icon=icon,
            color=color,
            order=order,
            created_by=self.user,
        )

    @transaction.atomic(using=postgres_app_db_alias())
    def update_collection(
        self,
        collection_id: UUID,
        name: Optional[str] = None,
        parent_id: Optional[UUID] = ...,
        icon: Optional[str] = None,
        color: Optional[str] = None,
        order: Optional[int] = None,
        is_expanded: Optional[bool] = None,
        is_pinned: Optional[bool] = None,
    ) -> Optional[Collection]:
        try:
            coll = Collection.objects.get(id=collection_id)
        except Collection.DoesNotExist:
            return None

        if not self._check_collection_editor_permission(coll):
            return None

        host_q = self._asset_host_q_for(coll)

        effective_parent_id = coll.parent_id if parent_id is ... else parent_id
        parent_changed = (
            parent_id is not ... and
            str(coll.parent_id) != str(parent_id)
        )

        # 移动文件夹（修改 parent）
        if parent_id is not ...:
            if parent_id is not None:
                if str(parent_id) == str(collection_id):
                    raise ServiceError('SELF_PARENT', '不能将文件夹移入自身', status=400)
                try:
                    parent_lookup = host_q
                    if _organization_id_of(coll) and coll.created_by_id:
                        parent_lookup &= Q(created_by_id=coll.created_by_id)
                    new_parent = Collection.objects.get(parent_lookup, id=parent_id)
                except Collection.DoesNotExist:
                    raise ServiceError('PARENT_NOT_FOUND', '目标父文件夹不存在', status=404)
                if self._is_descendant_of(new_parent, coll):
                    raise ServiceError('CIRCULAR_REF', '不能将文件夹移入其子文件夹中', status=400)
                if new_parent.get_depth() + 1 >= Collection.MAX_NESTING_DEPTH:
                    raise ServiceError(
                        'MAX_DEPTH_EXCEEDED',
                        f'文件夹最大嵌套深度为 {Collection.MAX_NESTING_DEPTH} 层',
                        status=400,
                    )

        effective_name = name if name is not None else coll.name
        name_changed = name is not None and name != coll.name
        if name_changed or parent_changed:
            dup_filter = host_q & Q(name=effective_name)
            # ：org-only 同名冲突按创建者分桶。
            org_id = _organization_id_of(coll)
            if org_id and coll.created_by_id:
                dup_filter &= Q(created_by_id=coll.created_by_id)
            if effective_parent_id:
                dup_filter &= Q(parent_id=effective_parent_id)
            else:
                dup_filter &= Q(parent__isnull=True)
            if Collection.objects.filter(dup_filter).exclude(id=collection_id).exists():
                raise ServiceError('DUPLICATE_NAME', f'同级已存在名称「{effective_name}」的文件夹', status=409)

        if parent_id is not ...:
            coll.parent_id = parent_id

        if name_changed:
            coll.name = name

        if icon is not None:
            coll.icon = icon
        if color is not None:
            coll.color = color
        if order is not None:
            coll.order = order
        if is_expanded is not None:
            coll.is_expanded = is_expanded
        if is_pinned is not None:
            coll.is_pinned = is_pinned
            coll.pinned_at = timezone.now() if is_pinned else None

        coll.save()
        return coll

    @transaction.atomic(using=postgres_app_db_alias())
    def delete_collection(self, collection_id: UUID) -> bool:
        try:
            coll = Collection.objects.get(id=collection_id)
        except Collection.DoesNotExist:
            return False

        if not self._check_collection_editor_permission(coll):
            return False

        all_ids = self.collect_collection_tree_ids(coll)

        trashed_at = timezone.now()
        items = list(
            ContextItem.objects
            .select_for_update()
            .filter(collection_id__in=all_ids, trashed_at__isnull=True)
        )
        for item in items:
            self._trash_collection_item(item, trashed_at)

        coll.delete()
        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def reorder_collections(
        self,
        space_id: UUID,
        collection_ids: List[UUID],
        parent_id: Optional[UUID] = None,
    ) -> bool:
        if not self.check_space_permission(str(space_id), 'editor'):
            return False

        base_filter = _asset_host_q(space_id)
        if parent_id:
            base_filter &= Q(parent_id=parent_id)
        else:
            base_filter &= Q(parent__isnull=True)

        for idx, cid in enumerate(collection_ids):
            Collection.objects.filter(base_filter, id=cid).update(order=idx)
        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def reorder_collections_for_organization(
        self,
        organization_id: UUID,
        collection_ids: List[UUID],
        parent_id: Optional[UUID] = None,
    ) -> bool:
        """重排 Organization 级（org-only）同级文件夹顺序。"""
        if not self.check_organization_permission(str(organization_id), 'editor'):
            return False
        if not self.user:
            return False

        base_filter = (
            _asset_host_q(organization_id=organization_id)
            & Q(created_by_id=self.user.id)
        )
        if parent_id:
            base_filter &= Q(parent_id=parent_id)
        else:
            base_filter &= Q(parent__isnull=True)

        if not collection_ids:
            return True

        owned_ids = set(
            Collection.objects.filter(base_filter, id__in=collection_ids)
            .values_list('id', flat=True)
        )
        if len(owned_ids) != len(set(collection_ids)):
            # 含他人文件夹或未知 id：拒绝整次重排，避免静默改半截。
            return False

        for idx, cid in enumerate(collection_ids):
            Collection.objects.filter(base_filter, id=cid).update(order=idx)
        return True

    # ── 内部权限 / 宿主辅助 ──

    def _check_collection_editor_permission(self, coll: Collection) -> bool:
        """按 Collection 的宿主态判断当前用户是否有编辑权限（ 三态 / ）。"""
        org_id = _organization_id_of(coll)
        if org_id:
            if not self.check_organization_permission(org_id, 'editor'):
                return False
            # ：org-only 文件夹内容权仅创建者；组织角色不抬权。
            return bool(self.user and coll.created_by_id == self.user.id)
        host_id = _host_id_of(coll)
        if not host_id:
            return False
        return self.check_space_permission(host_id, 'editor')

    @staticmethod
    def _asset_host_q_for(coll: Collection) -> Q:
        """按 Collection 当前宿主态构造 asset_host_q（不跨宿主匹配同级 / 父级）。"""
        org_id = _organization_id_of(coll)
        if org_id:
            return _asset_host_q(organization_id=org_id)
        return _asset_host_q(_host_id_of(coll))

    # ── 资源归属管理 ──

    def _can_move_context_item(self, item: ContextItem) -> bool:
        """判断当前用户是否可移动该 ContextItem。

        - Space 宿主（workspace/project）：需要源 Space editor
        - org-only 宿主（ TabFiles 等）：需要 organization editor
        """
        org_id = _organization_id_of(item)
        if org_id:
            return self.check_organization_permission(org_id, 'editor')
        host_id = _host_id_of(item)
        if not host_id:
            return False
        return self.check_space_permission(host_id, 'editor')

    @transaction.atomic(using=postgres_app_db_alias())
    def move_items(
        self,
        space_id: UUID,
        item_ids: List[UUID],
        collection_id: Optional[UUID] = None,
    ) -> int:
        """将 organization 内资源归入当前 Space 的文件夹树。

        `space_id` 是 UI 锚点 Space，决定目标文件夹归属；资源本身可以来自
        同一 organization 下的其他 Space，或 org-only 宿主（ 云盘裸文件）。
        """
        if not self.check_space_permission(str(space_id), 'editor'):
            raise ServiceError('PERMISSION_DENIED', '没有权限移动资源到该文件夹', status=403)

        anchor = (
            Workspace.objects.only('id', 'organization_id').filter(id=space_id).first()
            or Project.objects.only('id', 'organization_id').filter(id=space_id).first()
        )
        if anchor is None:
            raise ServiceError('SPACE_NOT_FOUND', '目标 Space 不存在', status=404)

        return self._move_items_within_organization(
            organization_id=anchor.organization_id,
            item_ids=item_ids,
            collection_id=collection_id,
            collection_host_q=_asset_host_q(space_id),
        )

    @transaction.atomic(using=postgres_app_db_alias())
    def move_items_for_organization(
        self,
        organization_id: UUID,
        item_ids: List[UUID],
        collection_id: Optional[UUID] = None,
    ) -> int:
        """将资源归入 Organization 级（org-only）文件夹树。

        与 :meth:`move_items` 的区别：目标文件夹必须是该 organization 的
        org-only 宿主；资源仍按  云资产 ACL 或 Space editor 判定。
        """
        if not self.check_organization_permission(str(organization_id), 'editor'):
            raise ServiceError('PERMISSION_DENIED', '没有权限移动资源到该文件夹', status=403)

        return self._move_items_within_organization(
            organization_id=organization_id,
            item_ids=item_ids,
            collection_id=collection_id,
            collection_host_q=_asset_host_q(organization_id=organization_id),
        )

    def _move_items_within_organization(
        self,
        *,
        organization_id: UUID,
        item_ids: List[UUID],
        collection_id: Optional[UUID],
        collection_host_q: Q,
    ) -> int:
        """校验目标文件夹归属、按  ACL 过滤可移动资源，写回 collection_id。"""
        if collection_id:
            target = (
                Collection.objects
                .filter(collection_host_q, id=collection_id)
                .only('id', 'organization_id', 'created_by_id')
                .first()
            )
            if target is None:
                raise ServiceError('COLLECTION_NOT_FOUND', '目标文件夹不存在', status=404)
            # ：写入 org-only 文件夹须为创建者本人。
            if _organization_id_of(target):
                if not self.user or target.created_by_id != self.user.id:
                    raise ServiceError('COLLECTION_NOT_FOUND', '目标文件夹不存在', status=404)

        from apps.tabtinspace.services.cloud_resource_acl import (
            CLOUD_ITEM_TYPES,
            check_item_resource_permission,
        )

        items = list(
            ContextItem.objects.filter(
                id__in=item_ids,
            ).filter(
                Q(workspace__organization_id=organization_id)
                | Q(project__organization_id=organization_id)
                | Q(organization_id=organization_id),
                is_archived=False,
                trashed_at__isnull=True,
            ).only(
                'id', 'workspace_id', 'project_id', 'organization_id',
                'item_type', 'resource_id', 'created_by_id',
            )
        )
        # 云资产改 collection 位置仅 owner：共享 editor 不得把资源挪进自己的个人文件夹
        permitted_ids = []
        for item in items:
            if item.item_type in CLOUD_ITEM_TYPES:
                if check_item_resource_permission(self.user, item, 'owner'):
                    permitted_ids.append(item.id)
            else:
                host_id = _host_id_of(item)
                if host_id and self.check_space_permission(host_id, 'editor'):
                    permitted_ids.append(item.id)
        if not permitted_ids:
            raise ServiceError(
                'MOVE_DENIED',
                '无权移动所选资源，或资源不存在',
                status=403,
            )

        return ContextItem.objects.filter(id__in=permitted_ids).update(
            collection_id=collection_id,
        )

    @transaction.atomic(using=postgres_app_db_alias())
    def reorder_items(
        self,
        space_id: UUID,
        item_ids: List[UUID],
        collection_id: Optional[UUID] = None,
    ) -> int:
        """更新同级资源 order（folder 内或根层）。"""
        if not self.check_space_permission(str(space_id), 'editor'):
            raise ServiceError('PERMISSION_DENIED', '没有权限重排资源', status=403)

        anchor = (
            Workspace.objects.only('id', 'organization_id').filter(id=space_id).first()
            or Project.objects.only('id', 'organization_id').filter(id=space_id).first()
        )
        if anchor is None:
            raise ServiceError('SPACE_NOT_FOUND', '目标 Space 不存在', status=404)

        if collection_id:
            if not Collection.objects.filter(_asset_host_q(space_id), id=collection_id).exists():
                raise ServiceError('COLLECTION_NOT_FOUND', '文件夹不存在', status=404)

        from apps.tabtinspace.services.cloud_resource_acl import check_item_resource_permission

        updated = 0
        for idx, item_id in enumerate(item_ids):
            try:
                item = ContextItem.objects.get(id=item_id, organization_id=anchor.organization_id)
            except ContextItem.DoesNotExist:
                continue
            expected_collection = collection_id
            if item.collection_id != expected_collection:
                continue
            if not check_item_resource_permission(self.user, item, 'editor'):
                continue
            if item.order != idx:
                ContextItem.objects.filter(id=item.id).update(order=idx)
                updated += 1
            else:
                updated += 1
        return updated

    # ── 内部工具方法 ──

    def _trash_collection_item(self, item: ContextItem, trashed_at) -> None:
        """将合集删除影响到的资源移入回收站。"""
        self._trash_source_resource(item, trashed_at)

        item.previous_status = item.status or ('archived' if item.is_archived else 'active')
        item.status = 'trashed'
        item.trashed_at = trashed_at
        item.trashed_by = self.user.id if self.user else None
        item.is_archived = True
        if self.user:
            item.updated_by = self.user
        item.save(update_fields=[
            'status', 'previous_status', 'trashed_at', 'trashed_by',
            'is_archived', 'updated_by', 'updated_at',
        ])

    def _trash_source_resource(self, item: ContextItem, trashed_at) -> None:
        """同步移动源资源到回收站；不认识的资源只处理 ContextItem。"""
        model_class = get_resource_model(item.item_type)
        if not model_class or not item.resource_id:
            return

        try:
            resource = model_class.objects.get(id=item.resource_id)
        except (model_class.DoesNotExist, TypeError, ValueError, ValidationError):
            return

        user_id = self.user.id if self.user else None
        if hasattr(resource, 'trash'):
            resource.trash(user_id=user_id, trashed_at=trashed_at)
            return

        if not hasattr(resource, 'trashed_at') or resource.trashed_at is not None:
            return

        resource.trashed_at = trashed_at
        resource.trashed_by = user_id
        update_fields = ['trashed_at', 'trashed_by']
        if hasattr(resource, 'status'):
            resource.previous_status = resource.status or 'active'
            resource.status = 'trashed'
            update_fields += ['previous_status', 'status']
        if hasattr(resource, 'updated_at'):
            update_fields.append('updated_at')
        resource.save(update_fields=update_fields)

    @staticmethod
    def collect_collection_tree_ids(coll: Collection) -> List[UUID]:
        """返回当前文件夹及其所有后代文件夹 ID。"""
        return [coll.id] + CollectionService._get_all_descendant_ids(coll)

    @staticmethod
    def _is_descendant_of(node: Collection, ancestor: Collection) -> bool:
        """判断 node 是否是 ancestor 的后代（防循环引用）。"""
        current = node
        seen = set()
        while current.parent_id is not None:
            if current.parent_id in seen:
                break
            if str(current.parent_id) == str(ancestor.id):
                return True
            seen.add(current.parent_id)
            try:
                current = Collection.objects.only('id', 'parent_id').get(id=current.parent_id)
            except Collection.DoesNotExist:
                break
        return False

    @staticmethod
    def _get_all_descendant_ids(coll: Collection) -> List[UUID]:
        """递归获取所有后代文件夹 ID。"""
        result = []
        queue = [coll.id]
        while queue:
            pid = queue.pop(0)
            child_ids = list(
                Collection.objects
                .filter(parent_id=pid)
                .values_list('id', flat=True)
            )
            result.extend(child_ids)
            queue.extend(child_ids)
        return result
