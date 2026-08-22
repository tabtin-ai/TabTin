"""
TrashCleaner — 统一回收站清理服务

根据 ContextItem 的 item_type 路由到各模块，执行完整的级联删除：
ResourceBridge 回调、原生存储清理、OSS 文件引用释放等。

支持两种模式：
- user 模式：通过各模块 Service 的 permanent_delete 方法（含权限校验）
- 系统模式（user=None）：直接操作模型，跳过权限校验，用于 Celery 定时清理
"""
import logging
from django.db import transaction

from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

# 单根契约（docs/single-root-space-prd.md §2.7）：tabcode/code 资源类型已废弃，
# 不再有 trash 删除路径。CodeProject 表已退役，残留 ContextItem 走通用 noop。
ITEM_TYPE_TO_DELETER = {
    "tabdoc": "_delete_document",
    "tabslide": "_delete_slide",
    "tabdesign": "_delete_noop",
    "tabvideo": "_delete_noop",
    "tabdata": "_delete_table",
    "tabwhiteboard": "_delete_noop",
    "tabmemo": "_delete_memo",
    "tabfiles": "_delete_tabfiles",
    # 兼容旧数据中可能存在的短名称
    "document": "_delete_document",
    "slide": "_delete_slide",
    "design": "_delete_noop",
    "video": "_delete_noop",
    "table": "_delete_table",
    "canvas": "_delete_noop",
    "memo": "_delete_memo",
}

BATCH_SIZE = 50
CLEANUP_MAX_RETRIES = 5


class TrashCleaner:
    """集中式回收站清理器。"""

    @classmethod
    def permanent_delete_trashed_items(
        cls,
        trashed_items_qs,
        user=None,
        *,
        include_dead_letters: bool = False,
    ):
        """
        遍历 trashed ContextItem queryset，按 item_type 路由到各模块
        执行永久删除。每条独立事务，单条失败不影响其他条目。

        默认跳过 cleanup_fail_count >= CLEANUP_MAX_RETRIES 的条目（死信），
        避免定时清理反复撞墙。用户主动「清空回收站」应传
        include_dead_letters=True，否则卡死的条目会永远清不掉。
        分批加载避免大 queryset 占用过多内存。
        """
        qs = (
            trashed_items_qs
            if include_dead_letters
            else trashed_items_qs.filter(cleanup_fail_count__lt=CLEANUP_MAX_RETRIES)
        )
        while True:
            batch = list(qs[:BATCH_SIZE])
            if not batch:
                break
            any_deleted = False
            for item in batch:
                deleter_name = ITEM_TYPE_TO_DELETER.get(item.item_type)
                if not deleter_name:
                    logger.warning(
                        "未知 item_type=%s，跳过 context_item=%s",
                        item.item_type, item.id,
                    )
                    continue
                deleter = getattr(cls, deleter_name, None)
                if not deleter:
                    logger.warning(
                        "未实现 deleter=%s，跳过 context_item=%s",
                        deleter_name, item.id,
                    )
                    continue
                try:
                    deleter(item, user)
                    any_deleted = True
                except Exception:
                    cls._increment_fail_count(item)
                    logger.exception(
                        "永久删除失败: item_type=%s, resource_id=%s, fail_count=%d",
                        item.item_type, item.resource_id, item.cleanup_fail_count,
                    )
            if not any_deleted:
                break

    @classmethod
    def _increment_fail_count(cls, item):
        """递增失败计数；达到阈值时记录 stuck 告警。"""
        try:
            from django.db.models import F
            type(item).objects.filter(pk=item.pk).update(
                cleanup_fail_count=F('cleanup_fail_count') + 1
            )
            item.cleanup_fail_count += 1
            if item.cleanup_fail_count >= CLEANUP_MAX_RETRIES:
                logger.error(
                    "[TrashCleaner] 条目已达最大重试次数，标记为 stuck: "
                    "item_type=%s resource_id=%s context_item=%s",
                    item.item_type, item.resource_id, item.id,
                )
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Space 批量删除前的 OSS FileUsage 清理
    # ------------------------------------------------------------------

    @classmethod
    def release_file_usages_for_spaces(cls, space_ids):
        """批量释放 Space 下所有资源关联的 OSS FileUsage。

        在 Space 批量删除前调用，防止 ORM .delete() 跳过 ResourceBridge
        导致 FileUsage 永久残留（DEL-4 / DEL-5 修复）。
        """
        if not space_ids:
            return 0

        from apps.tabtinspace.models import ContextItem
        from apps.tabtinspace.resource_registry import get_resource_model
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        from django.db.models import Q

        items = ContextItem.objects.filter(
            Q(workspace_id__in=space_ids) | Q(project_id__in=space_ids)
        )
        released = 0

        for item in items.iterator():
            model_class = get_resource_model(item.item_type)
            if not model_class:
                continue
            try:
                resource = model_class.objects.get(id=item.resource_id)
                ResourceBridge._release_file_usages(resource)
                released += 1
            except model_class.DoesNotExist:
                continue
            except Exception:
                logger.warning(
                    "[TrashCleaner] release_file_usages_for_spaces: "
                    "item=%s type=%s resource=%s failed",
                    item.id, item.item_type, item.resource_id,
                    exc_info=True,
                )

        if released:
            logger.info(
                "[TrashCleaner] release_file_usages_for_spaces: "
                "spaces=%s, released=%d FileUsage groups",
                space_ids, released,
            )
        return released

    # ------------------------------------------------------------------
    # 死信条目 FileUsage 补偿释放（DEL-3）
    # ------------------------------------------------------------------

    @classmethod
    def retry_dead_letter_file_usages(cls):
        """扫描死信条目（cleanup_fail_count >= MAX），尝试仅释放 OSS FileUsage。

        全量永久删除可能因各种原因持续失败，但 FileUsage 释放通常可以独立完成。
        这是一条补偿路径，确保即使永久删除卡住，OSS 存储也不会永久泄漏。
        """
        from apps.tabtinspace.models import ContextItem
        from apps.tabtinspace.resource_registry import get_resource_model
        from apps.tabtinspace.services.resource_bridge import ResourceBridge
        from apps.services.oss.services.deactivate_utils import (
            deactivate_file_usages_and_release_storage,
        )

        dead_items = ContextItem.objects.filter(
            cleanup_fail_count__gte=CLEANUP_MAX_RETRIES,
            trashed_at__isnull=False,
        ).order_by('trashed_at')

        stats = {"scanned": 0, "released": 0, "resource_gone": 0, "failed": 0}

        for item in dead_items.iterator():
            stats["scanned"] += 1
            model_class = get_resource_model(item.item_type)
            if not model_class:
                continue

            try:
                resource = model_class.objects.get(id=item.resource_id)
                ResourceBridge._release_file_usages(resource)
                stats["released"] += 1
            except model_class.DoesNotExist:
                organization_id = cls._resolve_organization_id_from_context_item(item)
                try:
                    deactivate_file_usages_and_release_storage(
                        module=item.item_type,
                        context_filter={"context_id": str(item.resource_id)},
                        organization_id=organization_id,
                        biz_type="dead_letter_compensation",
                        biz_id=str(item.id),
                        log_prefix="TrashCleaner.dead_letter",
                    )
                    stats["released"] += 1
                except Exception:
                    stats["failed"] += 1
                    logger.warning(
                        "[TrashCleaner] dead letter fallback deactivate failed: "
                        "item=%s type=%s resource=%s",
                        item.id, item.item_type, item.resource_id,
                        exc_info=True,
                    )
            except Exception:
                stats["failed"] += 1
                logger.warning(
                    "[TrashCleaner] dead letter FileUsage release failed: "
                    "item=%s type=%s resource=%s",
                    item.id, item.item_type, item.resource_id,
                    exc_info=True,
                )

        if stats["scanned"]:
            logger.info("[TrashCleaner] retry_dead_letter_file_usages: %s", stats)
        return stats

    @staticmethod
    def _resolve_organization_id_from_context_item(item):
        """从 ContextItem 宿主解析 organization_id（含  org-only）。"""
        from apps.services.billing.organization_resolver import resolve_organization_id_from_space
        from apps.tabtinspace.services.asset_host import host_id_of, organization_id_of

        org_id = organization_id_of(item)
        if org_id:
            return org_id
        host_id = host_id_of(item)
        if not host_id:
            return ""
        return resolve_organization_id_from_space(host_id) or ""

    # ------------------------------------------------------------------
    # 系统模式核心：直接操作模型，跳过 Service 权限校验
    # ------------------------------------------------------------------

    @staticmethod
    def _system_delete_resource(resource, user=None, using=None):
        """系统模式通用删除：拆分 ResourceBridge 逻辑，FileUsage 释放延迟到 on_commit。

        DEL-1 修复：避免跨库事务不原子——PostgreSQL 回滚时 MySQL FileUsage 已 deactivate。
        将 MySQL 侧 _release_file_usages 放入 on_commit(using=...) 回调，确保 PostgreSQL
        事务提交成功后才操作 MySQL。
        """
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        try:
            ResourceBridge._validate_resource(resource)
        except Exception:
            pass

        # 预捕获 FileUsage 释放所需的属性（delete 后 Python 对象可能无法再做 DB 查询）
        resource_id = str(resource.id)
        resource_cls_name = type(resource).__name__
        try:
            ws_id = str(ResourceBridge._get_resource_organization_id(resource) or "")
            ctx_type = resource.get_context_type()
            ctx_filter = resource.get_restore_quota_filter()
            user_id_str = str(getattr(user, "id", "")) if user else ""
        except Exception:
            ws_id, ctx_type, ctx_filter, user_id_str = "", "", {}, ""

        # 同步执行：ContextItem 删除、信号、WebSocket 推送
        try:
            ResourceBridge._delete_context_item(resource)
        except Exception as exc:
            logger.warning(
                "[TrashCleaner] _delete_context_item failed: %s(%s): %s",
                resource_cls_name, resource_id, exc,
            )
        try:
            ResourceBridge._emit_signal(resource, "deleted", user)
        except Exception:
            pass
        try:
            ResourceBridge._push_ws(resource, "deleted", user)
        except Exception:
            pass

        # DEL-1: MySQL FileUsage 释放延迟到 PostgreSQL 事务提交后
        if ws_id and ctx_filter:
            def _deferred_release_file_usages():
                try:
                    from apps.services.oss.services.deactivate_utils import (
                        deactivate_file_usages_and_release_storage,
                    )
                    deactivate_file_usages_and_release_storage(
                        module=ctx_type,
                        context_filter=ctx_filter,
                        organization_id=ws_id,
                        user_id=user_id_str,
                        biz_type="permanent_delete",
                        biz_id=resource_id,
                        log_prefix="TrashCleaner.on_commit",
                    )
                except Exception as exc:
                    logger.error(
                        "[TrashCleaner] on_commit _release_file_usages failed: "
                        "%s(%s): %s", resource_cls_name, resource_id, exc,
                        exc_info=True,
                    )

            transaction.on_commit(_deferred_release_file_usages, using=using)

        resource.delete()

    # ------------------------------------------------------------------
    # 各模块 deleter
    # ------------------------------------------------------------------

    @classmethod
    def _delete_document(cls, item, user):
        from apps.tabdoc.models import Document
        try:
            doc = Document.objects.get(id=item.resource_id)
        except Document.DoesNotExist:
            item.delete()
            return

        if doc.status != "trashed":
            item.delete()
            return

        if user:
            from apps.tabdoc.services.document_service import DocumentService
            svc = DocumentService(user=user)
            svc.permanent_delete_document(doc, system_call=True)
        else:
            with transaction.atomic(using=postgres_app_db_alias()):
                cls._system_delete_resource(doc, using=postgres_app_db_alias())

    @classmethod
    def _delete_slide(cls, item, user):
        from apps.tabslide.models import SlideProject
        try:
            proj = SlideProject.objects.get(id=item.resource_id)
        except SlideProject.DoesNotExist:
            item.delete()
            return

        if proj.status != "trashed":
            item.delete()
            return

        if user:
            from apps.tabslide.services.slide_service import SlideService
            svc = SlideService(user=user)
            svc.permanent_delete_project(str(proj.id))
        else:
            with transaction.atomic(using=postgres_app_db_alias()):
                cls._system_delete_resource(proj, using=postgres_app_db_alias())

    @classmethod
    def _delete_noop(cls, item, user):
        """No-op deleter for removed modules (e.g. tabdesign). Cleans up the ContextItem only."""
        item.delete()

    @classmethod
    def _delete_table(cls, item, user):
        from apps.tabdata.models import Table
        TABDATA_DB = postgres_app_db_alias()
        try:
            table = Table.objects.using(TABDATA_DB).get(id=item.resource_id)
        except Table.DoesNotExist:
            item.delete()
            return

        if table.trashed_at is None:
            item.delete()
            return

        if user:
            from apps.tabdata.services.table_service import TableService
            svc = TableService(user=user)
            result = svc.permanent_delete_table(table.id)
            if not result:
                logger.warning(
                    "TableService.permanent_delete_table 返回 False: table=%s",
                    table.id,
                )
        else:
            with transaction.atomic(using=TABDATA_DB):
                from apps.tabdata.services.table_service import TableService
                try:
                    TableService._native_drop_table(table.space_id, table.id)
                except Exception:
                    logger.error(
                        "系统清理：_native_drop_table 失败，跳过本次删除以避免孤儿物理表 table=%s",
                        table.id, exc_info=True,
                    )
                    return
                cls._system_delete_resource(table, using=TABDATA_DB)

    @classmethod
    def _delete_memo(cls, item, user):
        from apps.tabmemo.models import Memo
        try:
            memo = Memo.objects.get(id=item.resource_id)
        except Memo.DoesNotExist:
            item.delete()
            return

        if memo.status != "trashed":
            item.delete()
            return

        if user:
            from apps.tabmemo.services.memo_service import MemoService
            svc = MemoService(user=user)
            svc.permanent_delete_memo(str(memo.id))
        else:
            with transaction.atomic(using=postgres_app_db_alias()):
                cls._system_delete_resource(memo, using=postgres_app_db_alias())

    @classmethod
    def _delete_tabfiles(cls, item, user):
        """永久删除云盘裸文件：ContextItem + FileUsage；OSS 由 ref_count 归零后清理。"""
        if item.trashed_at is None and item.status != "trashed":
            item.delete()
            return

        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        if user:
            svc = TabFilesService(user=user)
            svc.permanent_delete_item(item)
            return

        # 系统定时清理：无 user 权限校验，直接释放引用并删 ContextItem
        with transaction.atomic(using=postgres_app_db_alias()):
            svc = TabFilesService(user=None)
            svc.permanent_delete_item(item)
