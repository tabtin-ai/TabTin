"""
ResourceBridge — 平台桥接层核心服务

集中处理所有 App 资源的平台级行为：
  1. ContextItem 同步（创建/更新/归档/回收站/删除）
  2. resource_changed 信号发射（跨 App 事件）
  3. 搜索索引自动维护（通过 ContextItem title/preview）

各 App 的 Service 层只需在 CRUD 操作后调用一行即可：
    ResourceBridge.on_create(resource, user=self.user)
    ResourceBridge.on_update(resource, user=self.user)
    ResourceBridge.on_archive(resource, user=self.user)
    ResourceBridge.on_trash(resource, user=self.user)
    ResourceBridge.on_restore(resource, user=self.user)
    ResourceBridge.on_delete(resource, user=self.user)

资源模型必须实现 ContextSyncMixin（继承 SpaceResourceModel 即自动包含）。

See Also:
    - apps/services/common/base_models.py — ContextSyncMixin 协议定义
    - apps/tabtinspace/signals.py — resource_changed 信号定义
"""

import logging
from typing import Optional

from django.contrib.auth import get_user_model
from django.db.models import Q

from apps.tabtinspace.models import ContextItem, Project, Space
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.services.asset_host import asset_host_q, create_host_kwargs

User = get_user_model()
logger = logging.getLogger(__name__)


class ResourceBridge:
    """
    平台桥接层：所有 App 资源生命周期的统一处理器。

    作为无状态的静态服务类，不需要实例化。
    所有方法均为 @staticmethod，可直接调用。

    Usage:
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        # 资源创建后
        ResourceBridge.on_create(document, user=self.user)

        # 资源更新后
        ResourceBridge.on_update(document, user=self.user)

        # 资源归档
        ResourceBridge.on_archive(document, user=self.user)

        # 资源删除
        ResourceBridge.on_delete(document, user=self.user)
    """

    # ── 公共 API ──

    @staticmethod
    def check_restore_quota(resource) -> None:
        """恢复前存储配额预检查。配额不足时抛出异常以阻止恢复。"""
        organization_id = str(ResourceBridge._get_resource_organization_id(resource) or "")
        if not organization_id:
            return
        from apps.services.oss.services.reactivate_utils import check_restore_storage_quota
        context_filter = resource.get_restore_quota_filter()
        check_restore_storage_quota(
            module=resource.get_context_type(),
            context_filter=context_filter,
            organization_id=organization_id,
        )

    @staticmethod
    def on_create(resource, user=None, collection_id=None, parent_item_id=None) -> Optional[ContextItem]:
        """资源创建后调用。

        ：``parent_item_id`` 写入 ContextItem.parent（知识库树）；与 Document.parent 解耦。
        """
        try:
            ResourceBridge._validate_resource(resource)
            item = None
            # ：有 space_id（workspace/project）或仅有 organization_id 时都同步 ContextItem
            if ResourceBridge._should_sync_context_item(resource):
                item = ResourceBridge._create_context_item(
                    resource,
                    user,
                    collection_id=collection_id,
                    parent_item_id=parent_item_id,
                )
                ResourceBridge._update_search_vector(item.id)
            ResourceBridge._emit_signal(resource, "created", user)
            ResourceBridge._push_ws(resource, "created", user, context_item=item)
            return item
        except Exception as exc:
            logger.error("[ResourceBridge] on_create failed: %s(%s): %s",
                         type(resource).__name__, getattr(resource, "id", "?"), exc, exc_info=True)
            return None

    @staticmethod
    def on_update(resource, user=None) -> Optional[ContextItem]:
        """资源更新后调用。如果 ContextItem 不存在会自动创建（补偿）。"""
        try:
            ResourceBridge._validate_resource(resource)
            item = None
            if ResourceBridge._should_sync_context_item(resource):
                item = ResourceBridge._upsert_context_item(resource, user)
                ResourceBridge._update_search_vector(item.id)
            ResourceBridge._emit_signal(resource, "updated", user)
            ResourceBridge._push_ws(resource, "updated", user, context_item=item)
            return item
        except Exception as exc:
            logger.error("[ResourceBridge] on_update failed: %s(%s): %s",
                         type(resource).__name__, getattr(resource, "id", "?"), exc, exc_info=True)
            return None

    @staticmethod
    def _snapshot_cloud_recipients(resource, user=None, context_item=None):
        """提交前快照云资源可见用户（删除/归档后 ACL 可能已失效）。"""
        from apps.tabtinspace.services.context_sync_publisher import (
            is_cloud_resource_type,
            resolve_cloud_resource_recipient_user_ids,
        )

        resource_type = resource.get_context_type()
        if not is_cloud_resource_type(resource_type):
            return None
        organization_id = str(ResourceBridge._get_resource_organization_id(resource) or "") or None
        created_by_id = None
        if context_item is not None:
            created_by_id = getattr(context_item, "created_by_id", None)
        recipients = resolve_cloud_resource_recipient_user_ids(
            resource_type,
            str(resource.id),
            organization_id,
            created_by_id=str(created_by_id) if created_by_id else None,
        )
        if user and getattr(user, "id", None):
            recipients.add(str(user.id))
        return recipients

    @staticmethod
    def on_archive(resource, user=None) -> bool:
        """资源归档后调用。"""
        try:
            ResourceBridge._validate_resource(resource)
            recipients = ResourceBridge._snapshot_cloud_recipients(resource, user)
            ResourceBridge._archive_context_item(resource, user)
            ResourceBridge._emit_signal(resource, "archived", user)
        except Exception as exc:
            logger.error("[ResourceBridge] on_archive failed: %s(%s): %s",
                         type(resource).__name__, getattr(resource, "id", "?"), exc, exc_info=True)
            return False

        try:
            ResourceBridge._push_ws(
                resource, "archived", user, recipient_user_ids=recipients,
            )
        except Exception as exc:
            logger.error(
                "[ResourceBridge] on_archive WS push failed (archive committed): %s(%s): %s",
                type(resource).__name__, getattr(resource, "id", "?"), exc, exc_info=True,
            )
        return True

    @staticmethod
    def on_trash(resource, user=None) -> bool:
        """资源移入回收站后调用。将 ContextItem 标记为 trashed 状态，同时 deactivate OSS FileUsage。"""
        try:
            ResourceBridge._validate_resource(resource)
            recipients = ResourceBridge._snapshot_cloud_recipients(resource, user)
            ResourceBridge._trash_context_item(resource, user)
            ResourceBridge._deactivate_file_usages_on_trash(resource, user)
            ResourceBridge._emit_signal(resource, "trashed", user)
            ResourceBridge._push_ws(
                resource, "trashed", user, recipient_user_ids=recipients,
            )
            return True
        except Exception as exc:
            logger.error("[ResourceBridge] on_trash failed: %s(%s): %s",
                         type(resource).__name__, getattr(resource, "id", "?"), exc, exc_info=True)
            return False

    @staticmethod
    def on_restore(resource, user=None) -> Optional[ContextItem]:
        """资源从归档/回收站恢复后调用。"""
        try:
            ResourceBridge._validate_resource(resource)
            item = ResourceBridge._upsert_context_item(resource, user, is_archived=False)
            ResourceBridge._update_search_vector(item.id)
            ResourceBridge._reactivate_file_usages(resource, user)
            ResourceBridge._emit_signal(resource, "restored", user)
            ResourceBridge._push_ws(resource, "restored", user, context_item=item)
            return item
        except Exception as exc:
            logger.error("[ResourceBridge] on_restore failed: %s(%s): %s",
                         type(resource).__name__, getattr(resource, "id", "?"), exc, exc_info=True)
            return None

    @staticmethod
    def on_delete(resource, user=None) -> bool:
        """资源删除后调用。"""
        try:
            ResourceBridge._validate_resource(resource)

            user_id = getattr(user, "id", None) if user else None
            resource_name = ""
            try:
                resource_name = resource.get_context_title()
            except Exception:
                resource_name = getattr(resource, "title", getattr(resource, "name", ""))
            logger.info(
                "[PermanentDelete] module=%s resource=%s name=%r "
                "space=%s organization=%s user=%s",
                resource.get_context_type(),
                resource.id,
                resource_name,
                resource.space_id,
                getattr(resource, "organization_id", None),
                user_id,
            )

            recipients = ResourceBridge._snapshot_cloud_recipients(resource, user)
            ResourceBridge._release_file_usages(resource, user)
            ResourceBridge._delete_context_item(resource)
            ResourceBridge._emit_signal(resource, "deleted", user)
            ResourceBridge._push_ws(
                resource, "deleted", user, recipient_user_ids=recipients,
            )
            return True
        except Exception as exc:
            logger.error("[ResourceBridge] on_delete failed: %s(%s): %s",
                         type(resource).__name__, getattr(resource, "id", "?"), exc, exc_info=True)
            return False

    # ── 内部方法 ──

    @staticmethod
    def _release_file_usages(resource, user=None) -> None:
        """兜底释放 resource 关联的 active FileUsage 及存储计量。

        正常流程中 trash 阶段已 deactivate，此处仅处理遗漏情况。
        """
        try:
            organization_id = str(ResourceBridge._get_resource_organization_id(resource) or "")
            if not organization_id:
                return
            context_filter = resource.get_restore_quota_filter()
            from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
            deactivate_file_usages_and_release_storage(
                module=resource.get_context_type(),
                context_filter=context_filter,
                organization_id=organization_id,
                user_id=str(getattr(user, "id", "")) if user else "",
                biz_type="permanent_delete",
                biz_id=str(resource.id),
                log_prefix="ResourceBridge.on_delete",
            )
        except Exception as exc:
            logger.error(
                "[ResourceBridge] _release_file_usages failed: %s(%s): %s",
                type(resource).__name__, getattr(resource, "id", "?"), exc,
                exc_info=True,
            )
            raise

    @staticmethod
    def _deactivate_file_usages_on_trash(resource, user=None) -> None:
        """移入回收站时 deactivate 关联的 FileUsage 并释放存储计量。

        与 _reactivate_file_usages 对称：trash → deactivate，restore → reactivate。
        """
        try:
            organization_id = str(ResourceBridge._get_resource_organization_id(resource) or "")
            context_filter = resource.get_restore_quota_filter()
            from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
            deactivate_file_usages_and_release_storage(
                module=resource.get_context_type(),
                context_filter=context_filter,
                organization_id=organization_id,
                user_id=str(getattr(user, "id", "")) if user else "",
                biz_type="trash",
                biz_id=str(resource.id),
                log_prefix="ResourceBridge.on_trash",
            )
        except Exception as exc:
            logger.error(
                "[ResourceBridge] _deactivate_file_usages_on_trash failed: %s(%s): %s",
                type(resource).__name__, getattr(resource, "id", "?"), exc,
                exc_info=True,
            )

    @staticmethod
    def _reactivate_file_usages(resource, user=None) -> None:
        """恢复 resource 关联的 inactive FileUsage 及存储计量。

        与 _deactivate_file_usages_on_trash 对称，用于资源从回收站恢复时重新激活引用。
        """
        try:
            organization_id = str(ResourceBridge._get_resource_organization_id(resource) or "")
            if not organization_id:
                return
            context_filter = resource.get_restore_quota_filter()
            from apps.services.oss.services.reactivate_utils import reactivate_file_usages_and_restore_storage
            reactivate_file_usages_and_restore_storage(
                module=resource.get_context_type(),
                context_filter=context_filter,
                organization_id=organization_id,
                user_id=str(getattr(user, "id", "")) if user else "",
                biz_type="restore",
                biz_id=str(resource.id),
                log_prefix="ResourceBridge.on_restore",
            )
        except Exception as exc:
            logger.error(
                "[ResourceBridge] _reactivate_file_usages failed: %s(%s): %s",
                type(resource).__name__, getattr(resource, "id", "?"), exc,
                exc_info=True,
            )

    @staticmethod
    def _validate_resource(resource) -> None:
        """验证 resource 实现了 ContextSyncMixin 协议"""
        from apps.services.common.base_models import ContextSyncMixin

        if not isinstance(resource, ContextSyncMixin):
            raise TypeError(
                f"{type(resource).__name__} 未实现 ContextSyncMixin，"
                "无法使用 ResourceBridge。请确保模型继承了 SpaceResourceModel 或 ContextSyncMixin。"
            )

    @staticmethod
    def _get_resource_space_id_optional(resource, *, required: bool = False):
        """获取资源的 Space 上下文。Space 只是本地执行现场，云资源可无该上下文。"""
        space_id = getattr(resource, "space_id", None)
        if space_id is None:
            if not required:
                return None
            raise ValueError(
                f"{type(resource).__name__}({getattr(resource, 'id', '?')}) 的 space_id 为空，"
                "无法同步 Space 本地 ContextItem。"
            )
        return space_id

    @staticmethod
    def _get_resource_space_id(resource, *, required: bool = True):
        return ResourceBridge._get_resource_space_id_optional(resource, required=required)

    @staticmethod
    def _should_sync_context_item(resource) -> bool:
        """是否应同步 ContextItem：有 space 宿主，或  org-only（仅 organization_id）。"""
        if ResourceBridge._get_resource_space_id(resource, required=False):
            return True
        return bool(getattr(resource, "organization_id", None))

    @staticmethod
    def _get_resource_organization_id(resource):
        """获取资源的 organization_id（优先用资源自身字段，fallback 走统一 resolver）。"""
        organization_id = getattr(resource, "organization_id", None)
        if organization_id is not None:
            return organization_id
        from apps.services.billing.organization_resolver import resolve_organization_id_from_space
        space_id = ResourceBridge._get_resource_space_id(resource, required=False)
        if not space_id:
            return None
        return resolve_organization_id_from_space(str(space_id))

    _ORG_ONLY_CONTEXT_TYPES = frozenset({"tabdata", "tabdoc", "tabfiles"})

    @staticmethod
    def _is_org_only_context_type(resource) -> bool:
        try:
            return resource.get_context_type() in ResourceBridge._ORG_ONLY_CONTEXT_TYPES
        except Exception:
            return False

    @staticmethod
    def _host_kwargs_for_resource(resource) -> dict:
        """按资源宿主生成 ContextItem 创建 kwargs。

        ：tabdata / tabdoc / tabfiles 一律挂 Organization，不再跟 Space。
        """
        organization_id = ResourceBridge._get_resource_organization_id(resource)
        if ResourceBridge._is_org_only_context_type(resource):
            if not organization_id:
                raise ValueError(
                    f"{type(resource).__name__}({getattr(resource, 'id', '?')}) "
                    "缺少 organization_id，无法创建 org-only ContextItem。"
                )
            return create_host_kwargs(organization_id=organization_id)

        space_id = ResourceBridge._get_resource_space_id(resource, required=False)
        if space_id:
            return create_host_kwargs(space_id)
        if not organization_id:
            raise ValueError(
                f"{type(resource).__name__}({getattr(resource, 'id', '?')}) "
                "缺少 space_id 与 organization_id，无法创建 ContextItem。"
            )
        return create_host_kwargs(organization_id=organization_id)

    @staticmethod
    def _get_lookup_q(resource):
        """查找 ContextItem。

        ：云资产按 item_type + resource_id 定位（宿主可能从 Space 迁到 Organization）。
        """
        type_and_resource = (
            Q(item_type=resource.get_context_type())
            & Q(resource_id=str(resource.id))
        )
        if ResourceBridge._is_org_only_context_type(resource):
            return type_and_resource

        space_id = ResourceBridge._get_resource_space_id(resource, required=False)
        if space_id:
            host_q = asset_host_q(space_id)
        else:
            organization_id = ResourceBridge._get_resource_organization_id(resource)
            if not organization_id:
                raise ValueError(
                    f"{type(resource).__name__}({getattr(resource, 'id', '?')}) "
                    "缺少 space_id 与 organization_id，无法定位 ContextItem。"
                )
            host_q = asset_host_q(organization_id=organization_id)
        return host_q & type_and_resource

    @staticmethod
    def _create_context_item(
        resource, user=None, collection_id=None, parent_item_id=None,
    ) -> ContextItem:
        """创建 ContextItem（workspace/project 或  org-only）。"""
        from apps.tabtinspace.services.context_item_parent import (
            resolve_parent_item,
            validate_parent_for_item,
        )

        host_kwargs = ResourceBridge._host_kwargs_for_resource(resource)
        parent = resolve_parent_item(parent_item_id) if parent_item_id else None
        if parent is not None:
            host_stub = ContextItem(
                **host_kwargs,
                item_type=resource.get_context_type(),
            )
            validate_parent_for_item(item=None, parent=parent, host_item=host_stub)

        item = ContextItem.objects.create(
            **host_kwargs,
            item_type=resource.get_context_type(),
            title=resource.get_context_title(),
            preview=resource.get_context_preview(),
            status=resource.get_context_status(),
            resource_id=str(resource.id),
            metadata=resource.get_context_metadata(),
            order=0,
            is_archived=resource.is_context_archived(),
            collection_id=collection_id,
            parent=parent,
            created_by=user,
            updated_by=user,
        )
        ResourceBridge._maybe_enrich_team_space_tabdoc_asset(item, user=user)
        return item

    @staticmethod
    def _upsert_context_item(
        resource, user=None, is_archived: Optional[bool] = None
    ) -> ContextItem:
        """创建或更新 ContextItem（幂等）"""
        item = ContextItem.objects.filter(ResourceBridge._get_lookup_q(resource)).first()

        if not item:
            return ResourceBridge._create_context_item(resource, user)

        item.title = resource.get_context_title()
        item.preview = resource.get_context_preview()
        item.status = resource.get_context_status()
        metadata = dict(resource.get_context_metadata() or {})
        existing_metadata = dict(item.metadata or {})
        if existing_metadata.get("asset_kind") is not None:
            metadata["asset_kind"] = existing_metadata["asset_kind"]
        if existing_metadata.get("asset_source") is not None:
            metadata["asset_source"] = existing_metadata["asset_source"]
        item.metadata = metadata

        if is_archived is not None:
            item.is_archived = is_archived
        else:
            item.is_archived = resource.is_context_archived()

        # restore 时清除 trashed 字段
        restoring_from_trash = is_archived is False and item.trashed_at is not None
        if restoring_from_trash:
            item.trashed_at = None
            item.trashed_by = None
            item.previous_status = ""

        # ：云资产 ContextItem 宿主收敛到 Organization（清掉 workspace/project）
        if ResourceBridge._is_org_only_context_type(resource):
            host_kwargs = ResourceBridge._host_kwargs_for_resource(resource)
            item.workspace_id = host_kwargs.get("workspace_id")
            item.project_id = host_kwargs.get("project_id")
            item.organization_id = host_kwargs.get("organization_id")

        if user:
            item.updated_by = user

        item.save()
        if restoring_from_trash:
            # ：原 parent 已删/已回收则落根
            from apps.tabtinspace.services.context_item_parent import sanitize_parent_on_restore

            sanitize_parent_on_restore(item)
        ResourceBridge._maybe_enrich_team_space_tabdoc_asset(item, user=user)
        return item

    @staticmethod
    def _maybe_enrich_team_space_tabdoc_asset(item: ContextItem, user=None) -> None:
        """Team Space 内的 TabDoc 同步写入团队资产 metadata，供资产页展示。"""
        if item.item_type != "tabdoc":
            return

        metadata = dict(item.metadata or {})
        has_asset_kind = metadata.get("asset_kind") == "tabdoc"
        asset_source = metadata.get("asset_source")
        has_asset_source = (
            isinstance(asset_source, dict)
            and asset_source.get("kind") == "ai_deliverable"
        )
        if has_asset_kind and has_asset_source:
            return

        # ：团队资产宿主是 Project（id-reuse）；个人 Workspace 不写团队 deliverable 元数据
        project_id = getattr(item, "project_id", None)
        if not project_id:
            return
        space = Project.objects.filter(id=project_id).only(
            "id", "organization_id",
        ).first()
        if not space:
            return

        actor_user_id = str(getattr(user, "id", "") or "")
        metadata["asset_kind"] = "tabdoc"
        metadata["asset_source"] = {
            "kind": "ai_deliverable",
            "member_user_id": "",
            "actor_user_id": actor_user_id,
            "conversation_origin": {},
            "run_origin": {},
        }
        item.metadata = metadata
        item.save(update_fields=["metadata", "updated_at"])
        if has_asset_kind:
            return

        from apps.tabtinspace.models import SpaceActivityEvent
        from apps.tabtinspace.services.space_activity_service import record_team_space_activity

        record_team_space_activity(
            space,
            SpaceActivityEvent.EventType.ASSET_CREATED,
            actor_user=user,
            target_type="asset",
            target_id=str(item.id),
            target_name=item.title,
            metadata={"item_type": item.item_type, "source_kind": "ai_deliverable"},
        )

    @staticmethod
    def _archive_context_item(resource, user=None) -> None:
        """归档 ContextItem"""
        lookup_q = ResourceBridge._get_lookup_q(resource)
        from django.utils import timezone
        updated = ContextItem.objects.filter(lookup_q).update(
            is_archived=True, updated_at=timezone.now()
        )
        if updated == 0:
            logger.debug(
                "[ResourceBridge] 归档时未找到 ContextItem: %s/%s",
                resource.get_context_type(),
                resource.id,
            )

    @staticmethod
    def _trash_context_item(resource, user=None) -> None:
        """将 ContextItem 标记为 trashed 状态"""
        lookup_q = ResourceBridge._get_lookup_q(resource)
        from django.utils import timezone

        item = ContextItem.objects.filter(lookup_q).first()
        if not item:
            logger.debug(
                "[ResourceBridge] trash 时未找到 ContextItem: %s/%s",
                resource.get_context_type(),
                resource.id,
            )
            return

        # ：先上提子节点到祖父，再标记自身进回收站
        from apps.tabtinspace.services.context_item_parent import promote_children_on_trash

        promote_children_on_trash(item)

        item.previous_status = item.status or "active"
        item.status = "trashed"
        item.trashed_at = timezone.now()
        item.trashed_by = user.id if user else None
        item.is_archived = True
        item.save(update_fields=[
            "status", "previous_status", "trashed_at", "trashed_by",
            "is_archived", "updated_at",
        ])

    @staticmethod
    def _delete_context_item(resource) -> None:
        """删除 ContextItem"""
        lookup_q = ResourceBridge._get_lookup_q(resource)
        deleted, _ = ContextItem.objects.filter(lookup_q).delete()
        if deleted == 0:
            logger.debug(
                "[ResourceBridge] 删除时未找到 ContextItem: %s/%s",
                resource.get_context_type(),
                resource.id,
            )

    @staticmethod
    def _emit_signal(resource, action: str, user=None) -> None:
        """发射 resource_changed 信号 + EventBus 事件"""
        from apps.tabtinspace.signals import resource_changed

        try:
            resource_changed.send(
                sender=type(resource),
                resource=resource,
                action=action,
                resource_type=resource.get_context_type(),
                space_id=ResourceBridge._get_resource_space_id(resource, required=False),
                organization_id=ResourceBridge._get_resource_organization_id(resource),
                user=user,
            )
        except Exception as exc:
            logger.error(
                "[ResourceBridge] signal emit failed: action=%s, resource=%s(%s): %s",
                action, type(resource).__name__, getattr(resource, "id", "?"), exc, exc_info=True,
            )

        ResourceBridge._emit_event_bus(resource, action, user)

    @staticmethod
    def _emit_event_bus(resource, action: str, user=None) -> None:
        """将资源生命周期事件桥接到 EventBus，供 Tracker（Goal）等自动化消费。

        使用 transaction.on_commit 确保数据库事务成功后才发出事件，
        避免事务回滚但事件已发出的不一致。
        """
        from django.db import connection

        context_type = resource.get_context_type()
        resource_id = str(getattr(resource, "id", ""))
        organization_id = str(ResourceBridge._get_resource_organization_id(resource) or "")
        space_id = str(ResourceBridge._get_resource_space_id(resource, required=False) or "")

        if not organization_id:
            return

        resource_title = ""
        try:
            resource_title = resource.get_context_title()
        except Exception:
            resource_title = getattr(resource, "title", getattr(resource, "name", ""))

        def _do_emit():
            try:
                from apps.extensions.event_bus import Event, EventBus

                event = Event(
                    source=context_type,
                    event_type=f"{context_type}.resource.{action}",
                    organization_id=organization_id,
                    space_id=space_id or None,
                    payload={
                        "resource_id": resource_id,
                        "resource_type": context_type,
                        "title": resource_title,
                        "action": action,
                        "user_id": str(getattr(user, "id", "")) if user else "",
                    },
                )
                EventBus.emit(event)
            except Exception as exc:
                logger.warning(
                    "[ResourceBridge] EventBus emit failed: %s.resource.%s resource=%s: %s",
                    context_type, action, resource_id, exc,
                )

        connection.on_commit(_do_emit)

    @staticmethod
    def _update_search_vector(item_id) -> None:
        """更新 ContextItem 的全文搜索向量（仅 PostgreSQL 支持）"""
        try:
            from django.db import connections
            conn = connections[postgres_app_db_alias()]
            if conn.vendor != 'postgresql':
                return
            from django.contrib.postgres.search import SearchVector
            ContextItem.objects.filter(id=item_id).update(
                search_vector=(
                    SearchVector('title', weight='A', config='simple') +
                    SearchVector('preview', weight='B', config='simple')
                )
            )
        except Exception as exc:
            logger.warning("[ResourceBridge] search_vector update failed for %s: %s", item_id, exc)

    @staticmethod
    def _push_ws(
        resource,
        action: str,
        user=None,
        context_item=None,
        recipient_user_ids=None,
    ) -> None:
        """通过 WS Bus 推送资源变更事件到前端。

        ：云盘资源（tabdoc/tabdata/tabfiles）只扇出到可见用户 topic，
        不再写入 organization / space topic。
        ``recipient_user_ids`` 用于删除/归档等 ACL 可能已失效的场景（提交前快照）。
        """
        try:
            from apps.services.common.ws.bus import publish_ws_event
            from apps.services.common.ws.protocol import ContextSyncEvent
            from apps.tabtinspace.services.context_sync_publisher import (
                is_cloud_resource_type,
                publish_cloud_resource_event,
                resolve_cloud_resource_recipient_user_ids,
            )

            raw_space_id = ResourceBridge._get_resource_space_id(resource, required=False)
            organization_id = str(ResourceBridge._get_resource_organization_id(resource) or "")
            if not raw_space_id and not organization_id:
                return
            space_id = str(raw_space_id or "")
            resource_type = resource.get_context_type()

            envelope = {
                "type": f"resource_{action}",
                "resource_type": resource_type,
                "resource_id": str(resource.id),
                "title": resource.get_context_title(),
                "space_id": space_id or None,
                "organization_id": organization_id or None,
                "user_id": str(user.id) if user else None,
            }
            if context_item is not None:
                envelope["context_item_id"] = str(getattr(context_item, "id", "") or "") or None
                envelope["collection_id"] = (
                    str(context_item.collection_id)
                    if getattr(context_item, "collection_id", None)
                    else None
                )
                envelope["parent_id"] = (
                    str(context_item.parent_id)
                    if getattr(context_item, "parent_id", None)
                    else None
                )
            updated_at = getattr(resource, "updated_at", None)
            if updated_at is not None:
                envelope["updated_at"] = (
                    updated_at.isoformat()
                    if hasattr(updated_at, "isoformat")
                    else str(updated_at)
                )

            if action == "updated":
                try:
                    envelope["metadata"] = (
                        context_item.metadata
                        if context_item is not None
                        else resource.get_context_metadata()
                    )
                    envelope["status"] = resource.get_context_status()
                    envelope["preview"] = resource.get_context_preview()
                except Exception:
                    pass

            if is_cloud_resource_type(resource_type):
                created_by_id = None
                if context_item is not None:
                    created_by_id = getattr(context_item, "created_by_id", None)
                if recipient_user_ids is None:
                    recipients = resolve_cloud_resource_recipient_user_ids(
                        resource_type,
                        str(resource.id),
                        organization_id or None,
                        created_by_id=str(created_by_id) if created_by_id else None,
                    )
                    if user and getattr(user, "id", None):
                        recipients.add(str(user.id))
                else:
                    recipients = {str(uid) for uid in recipient_user_ids if uid}
                publish_cloud_resource_event(
                    envelope,
                    recipient_user_ids=recipients,
                    created_by_id=str(created_by_id) if created_by_id else None,
                )
                return

            topics = []
            if space_id:
                topics.append(f"{ContextSyncEvent.PREFIX}.{space_id}")
            if organization_id:
                topics.append(f"{ContextSyncEvent.PREFIX}.organization.{organization_id}")

            for topic in dict.fromkeys(topics):
                publish_ws_event(
                    topic=topic,
                    envelope=envelope,
                )
        except Exception as exc:
            logger.error("[ResourceBridge] WS push failed for action=%s resource=%s: %s",
                         action, str(getattr(resource, "id", "?")), exc, exc_info=True)
