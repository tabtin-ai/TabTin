"""
TabFiles 服务 — 裸文件在云盘中的管理

将 OSS FileRecord 作为 ContextItem（item_type='tabfiles'）纳入
Workspace / Project 的资源索引体系，支持上传、从聊天归档、下载 URL 获取等。

#3266：ContextItem / Collection 已无 space FK；宿主为 workspace 或 project（id-reuse）。
#6603：新增 Organization-only 宿主态——``upload_to_organization`` 等方法可直挂
Organization，不再强制先有 Space/Workspace/Project。
#7140：Collection 已支持 organization-only 归属，``upload_to_organization`` /
``archive_from_chat_to_organization`` 可传 ``collection_id`` 指向该 organization
下的 org-only 文件夹。
"""
import logging
from typing import Optional, Dict, Any, Iterable, Union
from uuid import UUID

from django.db import transaction
from django.db.models import Q

from apps.services.common.db_router import postgres_app_db_alias

from apps.tabtinspace.models import (
    Collection,
    ContextItem,
    Organization,
    Project,
    ProjectMemberWorkspace,
    SpaceActivityEvent,
    Workspace,
)
from apps.services.oss.models import FileRecord, FileUsage
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.tabtinspace.services.space_activity_service import record_team_space_activity
from .base import BaseService, ServiceError

logger = logging.getLogger(__name__)

AssetHost = Union[Workspace, Project]


def _asset_host_q(host_id) -> Q:
    """个人资产挂 workspace，团队挂 project（ id-reuse）。"""
    return Q(workspace_id=host_id) | Q(project_id=host_id)


def _create_host_kwargs(host_id) -> dict:
    if Workspace.objects.filter(id=host_id).exists():
        return {'workspace_id': host_id}
    if Project.objects.filter(id=host_id).exists():
        return {'project_id': host_id}
    return {'workspace_id': host_id}


def _host_kwargs_from_instance(host: AssetHost) -> dict:
    if isinstance(host, Workspace):
        return {'workspace_id': host.id}
    return {'project_id': host.id}


def _resolve_asset_host(host_id: UUID) -> Optional[AssetHost]:
    return (
        Workspace.objects.filter(id=host_id).first()
        or Project.objects.filter(id=host_id).first()
    )


def _resolve_publish_host(session) -> Optional[Project]:
    """从会话执行现场解析团队资产宿主 Project。

    优先级：
    1. ProjectMemberWorkspace（伴生 Workspace → Project）
    2. workspace_id 与 Project id-reuse（历史 team_space 会话）
    """
    workspace_id = getattr(session, 'workspace_id', None)
    if workspace_id is None:
        return None

    link = (
        ProjectMemberWorkspace.objects
        .select_related('project')
        .filter(workspace_id=workspace_id)
        .first()
    )
    if link is not None:
        return link.project

    return Project.objects.filter(id=workspace_id).first()


class TabFilesService(BaseService):

    ITEM_TYPE = 'tabfiles'
    AI_FINAL_ITEM_TYPE = 'team_asset'
    SOURCE_MEMBER_UPLOAD = 'member_upload'
    SOURCE_AI_DELIVERABLE = 'ai_deliverable'
    SOURCE_AI_FINAL_ANSWER = 'ai_final_answer'
    FINAL_ANSWER_STOP_REASONS = {'end_turn', 'stop_sequence', 'max_tokens'}

    @transaction.atomic(using=postgres_app_db_alias())
    def upload_to_space(
        self,
        space_id: UUID,
        file_record_id: UUID,
        collection_id: Optional[UUID] = None,
        title: Optional[str] = None,
        source_kind: str = SOURCE_MEMBER_UPLOAD,
        conversation_origin: Optional[Dict[str, Any]] = None,
        run_origin: Optional[Dict[str, Any]] = None,
    ) -> Optional[ContextItem]:
        """将已上传的 OSS FileRecord 注册为云盘文件资源。

        ``space_id`` 参数名历史保留，语义为 Workspace.id 或 Project.id。
        """
        host_id = space_id
        if not self.check_space_permission(str(host_id), 'editor'):
            return None

        host = _resolve_asset_host(host_id)
        if host is None:
            raise ServiceError('SPACE_NOT_FOUND', 'Workspace / Project 不存在', status=404)

        try:
            file_record = FileRecord.objects.get(id=file_record_id, status='completed')
        except FileRecord.DoesNotExist:
            raise ServiceError('FILE_NOT_FOUND', '文件不存在或未完成上传', status=404)

        self._assert_file_record_scope(file_record, host)

        if collection_id:
            if not Collection.objects.filter(
                _asset_host_q(host_id),
                id=collection_id,
            ).exists():
                raise ServiceError('COLLECTION_NOT_FOUND', '目标文件夹不存在', status=404)

        existing = ContextItem.objects.filter(
            _asset_host_q(host_id),
            item_type=self.ITEM_TYPE,
            resource_id=str(file_record.id),
        ).first()
        if existing:
            if collection_id and existing.collection_id != collection_id:
                existing.collection_id = collection_id
                existing.save(update_fields=['collection_id', 'updated_at'])
            return existing

        display_title = title or file_record.file_name
        asset_source = self._build_asset_source(
            kind=source_kind,
            user_id=str(self.user.id) if self.user else '',
            conversation_origin=conversation_origin,
            run_origin=run_origin,
        )

        item = ContextItem.objects.create(
            **_host_kwargs_from_instance(host),
            item_type=self.ITEM_TYPE,
            title=display_title,
            preview=f'{file_record.file_type} · {self._format_size(file_record.file_size)}',
            status='active',
            resource_id=str(file_record.id),
            metadata=self._build_metadata(file_record, asset_source=asset_source),
            collection_id=collection_id,
            order=0,
            created_by=self.user,
            updated_by=self.user,
        )

        FileUsage.add_usage(
            file_record=file_record,
            user_id=str(self.user.id) if self.user else '',
            module='tabfiles',
            context_type='context_item',
            context_id=str(item.id),
        )

        from apps.tabtinspace.services.resource_bridge import ResourceBridge
        ResourceBridge._update_search_vector(item.id)

        self._record_asset_created_on_commit(host, item, source_kind=source_kind)

        return item

    def archive_from_chat(
        self,
        space_id: UUID,
        file_record_id: UUID,
        collection_id: Optional[UUID] = None,
        source_kind: str = SOURCE_MEMBER_UPLOAD,
        conversation_origin: Optional[Dict[str, Any]] = None,
        run_origin: Optional[Dict[str, Any]] = None,
    ) -> Optional[ContextItem]:
        """从聊天附件归档文件到云盘。"""
        return self.upload_to_space(
            space_id=space_id,
            file_record_id=file_record_id,
            collection_id=collection_id,
            source_kind=source_kind,
            conversation_origin=conversation_origin,
            run_origin=run_origin,
        )

    # ── Organization-only（：不挂 workspace/project，宿主直接是 Organization）──

    @transaction.atomic(using=postgres_app_db_alias())
    def upload_to_organization(
        self,
        organization_id: UUID,
        file_record_id: UUID,
        collection_id: Optional[UUID] = None,
        title: Optional[str] = None,
        source_kind: str = SOURCE_MEMBER_UPLOAD,
        conversation_origin: Optional[Dict[str, Any]] = None,
        run_origin: Optional[Dict[str, Any]] = None,
    ) -> Optional[ContextItem]:
        """将已上传的 OSS FileRecord 注册为 Organization 级云盘文件资源（org-only）。

        与 :meth:`upload_to_space` 的区别：宿主是 Organization 本身，不挂
        workspace/project。``collection_id``须指向同一 organization
        下的 org-only Collection。
        """
        if not self.check_organization_permission(str(organization_id), 'editor'):
            return None

        organization = Organization.objects.filter(id=organization_id).first()
        if organization is None:
            raise ServiceError('ORGANIZATION_NOT_FOUND', 'Organization 不存在', status=404)

        try:
            file_record = FileRecord.objects.get(id=file_record_id, status='completed')
        except FileRecord.DoesNotExist:
            raise ServiceError('FILE_NOT_FOUND', '文件不存在或未完成上传', status=404)

        self._assert_file_record_organization_scope(file_record, organization)

        if collection_id:
            # ：org-only 上传落点仅允许写入自己创建的文件夹。
            target = Collection.objects.filter(
                organization_id=organization_id, id=collection_id,
            ).only('id', 'created_by_id').first()
            if (
                target is None
                or not self.user
                or target.created_by_id != self.user.id
            ):
                raise ServiceError('COLLECTION_NOT_FOUND', '目标文件夹不存在', status=404)

        existing = ContextItem.objects.filter(
            organization_id=organization_id,
            item_type=self.ITEM_TYPE,
            resource_id=str(file_record.id),
        ).first()
        if existing:
            if collection_id and existing.collection_id != collection_id:
                existing.collection_id = collection_id
                existing.save(update_fields=['collection_id', 'updated_at'])
            return existing

        display_title = title or file_record.file_name
        asset_source = self._build_asset_source(
            kind=source_kind,
            user_id=str(self.user.id) if self.user else '',
            conversation_origin=conversation_origin,
            run_origin=run_origin,
        )

        item = ContextItem.objects.create(
            organization_id=organization_id,
            item_type=self.ITEM_TYPE,
            title=display_title,
            preview=f'{file_record.file_type} · {self._format_size(file_record.file_size)}',
            status='active',
            resource_id=str(file_record.id),
            metadata=self._build_metadata(file_record, asset_source=asset_source),
            collection_id=collection_id,
            order=0,
            created_by=self.user,
            updated_by=self.user,
        )

        FileUsage.add_usage(
            file_record=file_record,
            user_id=str(self.user.id) if self.user else '',
            module='tabfiles',
            context_type='context_item',
            context_id=str(item.id),
        )

        from apps.tabtinspace.services.resource_bridge import ResourceBridge
        ResourceBridge._update_search_vector(item.id)

        # 注：组织级资产暂不接入 SpaceActivityEvent 动态流（该流以 team Project 为
        # 宿主维度设计），org-only 上传不产生活动留痕，属已知限制。

        return item

    def archive_from_chat_to_organization(
        self,
        organization_id: UUID,
        file_record_id: UUID,
        collection_id: Optional[UUID] = None,
        source_kind: str = SOURCE_MEMBER_UPLOAD,
        conversation_origin: Optional[Dict[str, Any]] = None,
        run_origin: Optional[Dict[str, Any]] = None,
    ) -> Optional[ContextItem]:
        """从聊天附件归档文件到 Organization 级云盘（org-only）。"""
        return self.upload_to_organization(
            organization_id=organization_id,
            file_record_id=file_record_id,
            collection_id=collection_id,
            source_kind=source_kind,
            conversation_origin=conversation_origin,
            run_origin=run_origin,
        )

    def _assert_file_record_organization_scope(
        self,
        file_record: FileRecord,
        organization: Organization,
    ) -> None:
        """确保文件可以被挂载进目标 Organization，避免跨组织串文件。"""
        record_organization_id = str(getattr(file_record, 'organization_id', '') or '')
        if record_organization_id:
            if record_organization_id == str(organization.id):
                return
            raise ServiceError('FILE_ACCESS_DENIED', '无权使用此文件', status=403)

        user_id = str(getattr(self.user, 'id', '') or '')
        if user_id and str(getattr(file_record, 'upload_user', '') or '') == user_id:
            return

        raise ServiceError('FILE_ACCESS_DENIED', '无权使用此文件', status=403)

    def _get_organization_item(
        self,
        organization_id: UUID,
        file_record_id: UUID,
        *,
        require_trashed: Optional[bool] = None,
    ) -> ContextItem:
        qs = ContextItem.objects.filter(
            organization_id=organization_id,
            item_type=self.ITEM_TYPE,
            resource_id=str(file_record_id),
        )
        if require_trashed is True:
            qs = qs.filter(trashed_at__isnull=False)
        elif require_trashed is False:
            qs = qs.filter(trashed_at__isnull=True).exclude(status='trashed')
        item = qs.first()
        if not item:
            raise ServiceError('TABFILE_NOT_FOUND', '文件不存在', status=404)
        return item

    def _assert_file_item_permission(self, item: ContextItem, required_role: str) -> None:
        """#6863：TabFiles 资源级鉴权（owner / FilePermission），不回退组织角色。"""
        from apps.tabtinspace.services.cloud_resource_acl import check_item_resource_permission

        if not check_item_resource_permission(self.user, item, required_role):
            raise ServiceError('PERMISSION_DENIED', '权限不足', status=403)

    def _assert_trashed_file_manageable(self, item: ContextItem) -> None:
        """个人回收站：删除者可恢复/永删（历史空 trashed_by 回退创建者）。"""
        from apps.tabtinspace.services.cloud_resource_acl import is_personal_trash_operator

        if is_personal_trash_operator(
            self.user,
            trashed_by=getattr(item, 'trashed_by', None),
            created_by_id=getattr(item, 'created_by_id', None),
        ):
            return
        raise ServiceError('PERMISSION_DENIED', '权限不足', status=403)

    @transaction.atomic(using=postgres_app_db_alias())
    def trash_organization_file(self, organization_id: UUID, file_record_id: UUID) -> ContextItem:
        """将 Organization 级云盘裸文件移入回收站（保留 OSS FileRecord，可恢复）。"""
        item = self._get_organization_item(organization_id, file_record_id, require_trashed=False)
        # trash 需 resource admin+（owner 满足）
        self._assert_file_item_permission(item, 'admin')
        if item.trashed_at is not None or item.status == 'trashed':
            raise ServiceError('ALREADY_TRASHED', '文件已在回收站中', status=400)

        from django.utils import timezone

        now = timezone.now()
        item.previous_status = item.status or ('archived' if item.is_archived else 'active')
        item.status = 'trashed'
        item.trashed_at = now
        item.trashed_by = self.user.id if self.user else None
        item.is_archived = True
        item.updated_by = self.user
        item.save(update_fields=[
            'status', 'previous_status', 'trashed_at', 'trashed_by',
            'is_archived', 'updated_by', 'updated_at',
        ])

        self._schedule_file_usage_deactivate(item, biz_type='tabfiles_trash_release')
        return item

    @transaction.atomic(using=postgres_app_db_alias())
    def restore_organization_file_from_trash(self, organization_id: UUID, file_record_id: UUID) -> ContextItem:
        """从回收站恢复 Organization 级云盘裸文件。"""
        item = self._get_organization_item(organization_id, file_record_id, require_trashed=True)
        self._assert_trashed_file_manageable(item)
        from apps.services.oss.services.reactivate_utils import (
            StorageQuotaExceededError,
            check_restore_storage_quota,
        )
        try:
            check_restore_storage_quota(
                module='tabfiles',
                context_filter={'context_type': 'context_item', 'context_id': str(item.id)},
                organization_id=str(organization_id),
            )
        except StorageQuotaExceededError as exc:
            raise ServiceError(
                'STORAGE_QUOTA_EXCEEDED',
                f'存储空间不足，无法恢复。需要 {exc.required_bytes} 字节，可用 {exc.available_bytes} 字节。',
                status=400,
            ) from exc

        if not FileRecord.objects.filter(id=file_record_id, status='completed').exists():
            raise ServiceError('FILE_NOT_FOUND', '源文件已不存在，无法恢复', status=404)

        restore_status = item.previous_status if item.previous_status in ('active', 'archived') else 'active'
        item.status = restore_status
        item.previous_status = ''
        item.trashed_at = None
        item.trashed_by = None
        item.is_archived = restore_status == 'archived'
        item.updated_by = self.user
        item.save(update_fields=[
            'status', 'previous_status', 'trashed_at', 'trashed_by',
            'is_archived', 'updated_by', 'updated_at',
        ])

        self._schedule_file_usage_reactivate(item, biz_type='tabfiles_restore_storage')
        return item

    @transaction.atomic(using=postgres_app_db_alias())
    def permanent_delete_organization_file(self, organization_id: UUID, file_record_id: UUID) -> None:
        """永久删除 Organization 级回收站中的云盘裸文件。"""
        item = self._get_organization_item(organization_id, file_record_id, require_trashed=True)
        self._assert_trashed_file_manageable(item)
        self._permanent_delete_item(item)

    def _get_item(
        self,
        space_id: UUID,
        file_record_id: UUID,
        *,
        require_trashed: Optional[bool] = None,
    ) -> ContextItem:
        qs = ContextItem.objects.filter(
            _asset_host_q(space_id),
            item_type=self.ITEM_TYPE,
            resource_id=str(file_record_id),
        )
        if require_trashed is True:
            qs = qs.filter(trashed_at__isnull=False)
        elif require_trashed is False:
            qs = qs.filter(trashed_at__isnull=True).exclude(status='trashed')
        item = qs.first()
        if not item:
            raise ServiceError('TABFILE_NOT_FOUND', '文件不存在', status=404)
        return item

    @transaction.atomic(using=postgres_app_db_alias())
    def trash_file(self, space_id: UUID, file_record_id: UUID) -> ContextItem:
        """将云盘裸文件移入回收站（保留 OSS FileRecord，可恢复）。"""
        item = self._get_item(space_id, file_record_id, require_trashed=False)
        self._assert_file_item_permission(item, 'admin')
        if item.trashed_at is not None or item.status == 'trashed':
            raise ServiceError('ALREADY_TRASHED', '文件已在回收站中', status=400)

        from django.utils import timezone

        now = timezone.now()
        item.previous_status = item.status or ('archived' if item.is_archived else 'active')
        item.status = 'trashed'
        item.trashed_at = now
        item.trashed_by = self.user.id if self.user else None
        item.is_archived = True
        item.updated_by = self.user
        item.save(update_fields=[
            'status', 'previous_status', 'trashed_at', 'trashed_by',
            'is_archived', 'updated_by', 'updated_at',
        ])

        self._schedule_file_usage_deactivate(item, biz_type='tabfiles_trash_release')
        return item

    @transaction.atomic(using=postgres_app_db_alias())
    def restore_file_from_trash(self, space_id: UUID, file_record_id: UUID) -> ContextItem:
        """从回收站恢复云盘裸文件。"""
        item = self._get_item(space_id, file_record_id, require_trashed=True)
        self._assert_trashed_file_manageable(item)
        from apps.services.oss.services.reactivate_utils import (
            StorageQuotaExceededError,
            check_restore_storage_quota,
        )
        org_id = self._resolve_organization_id(item)
        if org_id:
            try:
                check_restore_storage_quota(
                    module='tabfiles',
                    context_filter={'context_type': 'context_item', 'context_id': str(item.id)},
                    organization_id=org_id,
                )
            except StorageQuotaExceededError as exc:
                raise ServiceError(
                    'STORAGE_QUOTA_EXCEEDED',
                    f'存储空间不足，无法恢复。需要 {exc.required_bytes} 字节，可用 {exc.available_bytes} 字节。',
                    status=400,
                ) from exc

        # 恢复前确认 OSS 文件仍在
        if not FileRecord.objects.filter(id=file_record_id, status='completed').exists():
            raise ServiceError('FILE_NOT_FOUND', '源文件已不存在，无法恢复', status=404)

        restore_status = item.previous_status if item.previous_status in ('active', 'archived') else 'active'
        item.status = restore_status
        item.previous_status = ''
        item.trashed_at = None
        item.trashed_by = None
        item.is_archived = restore_status == 'archived'
        item.updated_by = self.user
        item.save(update_fields=[
            'status', 'previous_status', 'trashed_at', 'trashed_by',
            'is_archived', 'updated_by', 'updated_at',
        ])

        self._schedule_file_usage_reactivate(item, biz_type='tabfiles_restore_storage')
        return item

    @transaction.atomic(using=postgres_app_db_alias())
    def permanent_delete_file(self, space_id: UUID, file_record_id: UUID) -> None:
        """永久删除回收站中的云盘裸文件（释放 FileUsage；OSS 由 ref_count 归零后清理）。"""
        item = self._get_item(space_id, file_record_id, require_trashed=True)
        self._assert_trashed_file_manageable(item)
        self._permanent_delete_item(item)

    def permanent_delete_item(self, item: ContextItem) -> None:
        """供 TrashCleaner / 系统清理调用：按 ContextItem 永久删除。"""
        if item.item_type != self.ITEM_TYPE:
            raise ServiceError('INVALID_TYPE', '不是云盘裸文件', status=400)
        if item.trashed_at is None and item.status != 'trashed':
            raise ServiceError('NOT_TRASHED', '仅可永久删除回收站中的文件', status=400)
        self._permanent_delete_item(item)

    def _permanent_delete_item(self, item: ContextItem) -> None:
        item_id = str(item.id)
        organization_id = self._resolve_organization_id(item)
        user_id = str(self.user.id) if self.user else ''

        # 先同步释放 FileUsage，再删 ContextItem，避免引用悬空后补救困难
        try:
            from apps.services.oss.services.deactivate_utils import (
                deactivate_file_usages_and_release_storage,
            )
            deactivate_file_usages_and_release_storage(
                module=self.ITEM_TYPE,
                context_filter={
                    'context_type': 'context_item',
                    'context_id': item_id,
                },
                organization_id=organization_id,
                user_id=user_id,
                biz_type='tabfiles_permanent_delete',
                biz_id=item_id,
                log_prefix='[TabFiles PermanentDelete]',
            )
        except Exception:
            logger.exception(
                '[TabFilesService] permanent_delete FileUsage release failed: item=%s',
                item_id,
            )

        item.delete()

    def _schedule_file_usage_deactivate(self, item: ContextItem, *, biz_type: str) -> None:
        item_id = str(item.id)
        organization_id = self._resolve_organization_id(item)
        user_id = str(self.user.id) if self.user else ''

        def _do_deactivate():
            try:
                from apps.services.oss.services.deactivate_utils import (
                    deactivate_file_usages_and_release_storage,
                )
                deactivate_file_usages_and_release_storage(
                    module=self.ITEM_TYPE,
                    context_filter={
                        'context_type': 'context_item',
                        'context_id': item_id,
                    },
                    organization_id=organization_id,
                    user_id=user_id,
                    biz_type=biz_type,
                    biz_id=item_id,
                    log_prefix='[TabFiles Trash]',
                )
            except Exception:
                logger.exception(
                    '[TabFilesService] FileUsage deactivate failed: item=%s',
                    item_id,
                )

        transaction.on_commit(_do_deactivate, using=postgres_app_db_alias())

    def _schedule_file_usage_reactivate(self, item: ContextItem, *, biz_type: str) -> None:
        item_id = str(item.id)
        organization_id = self._resolve_organization_id(item)
        user_id = str(self.user.id) if self.user else ''

        def _do_reactivate():
            try:
                from apps.services.oss.services.reactivate_utils import (
                    reactivate_file_usages_and_restore_storage,
                )
                reactivate_file_usages_and_restore_storage(
                    module=self.ITEM_TYPE,
                    context_filter={
                        'context_type': 'context_item',
                        'context_id': item_id,
                    },
                    organization_id=organization_id,
                    user_id=user_id,
                    biz_type=biz_type,
                    biz_id=item_id,
                    log_prefix='[TabFiles Restore]',
                )
            except Exception:
                logger.exception(
                    '[TabFilesService] FileUsage reactivate failed: item=%s',
                    item_id,
                )

        transaction.on_commit(_do_reactivate, using=postgres_app_db_alias())

    @staticmethod
    def _resolve_organization_id(item: ContextItem) -> str:
        # org-only 行直接持有 organization_id，无需再经 space 反查。
        if item.organization_id:
            return str(item.organization_id)
        from apps.services.billing.organization_resolver import resolve_organization_id_from_space
        return resolve_organization_id_from_space(str(item.space_id)) or ''

    def _record_asset_created_on_commit(
        self,
        host: AssetHost,
        item: ContextItem,
        *,
        source_kind: str,
    ) -> None:
        """资产入库留痕（提交后 best-effort，非团队宿主自动跳过）。"""
        actor_user = self.user
        item_id = str(item.id)
        item_title = item.title
        item_type = item.item_type

        def _record():
            record_team_space_activity(
                host,
                SpaceActivityEvent.EventType.ASSET_CREATED,
                actor_user=actor_user,
                target_type='asset',
                target_id=item_id,
                target_name=item_title,
                metadata={'item_type': item_type, 'source_kind': source_kind},
            )

        transaction.on_commit(_record, using=postgres_app_db_alias())

    def _assert_file_record_scope(self, file_record: FileRecord, host: AssetHost) -> None:
        """确保文件可以被挂载进目标宿主，避免跨团队串文件。"""
        record_organization_id = str(getattr(file_record, 'organization_id', '') or '')
        host_organization_id = str(getattr(host, 'organization_id', '') or '')
        if record_organization_id:
            if record_organization_id == host_organization_id:
                return
            raise ServiceError('FILE_ACCESS_DENIED', '无权使用此文件', status=403)

        user_id = str(getattr(self.user, 'id', '') or '')
        if user_id and str(getattr(file_record, 'upload_user', '') or '') == user_id:
            return

        raise ServiceError('FILE_ACCESS_DENIED', '无权使用此文件', status=403)

    @staticmethod
    def get_download_url(
        file_record_id: UUID,
        *,
        as_attachment: bool = False,
    ) -> Optional[str]:
        """获取文件的预签名 URL；显式下载时强制 attachment，避免可执行内容内联。"""
        try:
            from django.utils.http import content_disposition_header
            from apps.services.oss.services.factory import get_oss_service
            record = FileRecord.objects.get(id=file_record_id, status='completed')
            service = get_oss_service()
            disposition = (
                content_disposition_header(True, record.file_name)
                if as_attachment
                else None
            )
            return service.generate_presigned_url(
                record.file_key,
                expiration=3600,
                response_content_disposition=disposition,
            )
        except FileRecord.DoesNotExist:
            return None
        except Exception as exc:
            logger.warning('[TabFilesService] get_download_url failed: %s', exc)
            return None

    @staticmethod
    def get_file_size(file_record_id: UUID) -> Optional[int]:
        """从 FileRecord 权威字段读取大小，兼容缺少冗余 metadata 的旧 ContextItem。"""
        return FileRecord.objects.filter(
            id=file_record_id,
            status='completed',
        ).values_list('file_size', flat=True).first()

    @classmethod
    def publish_message_assets(cls, message_or_id: Any) -> list[ContextItem]:
        """把 Project 中明确可共享的 AI 输出发布为资产。

        只处理两类信号：
        - assistant final answer（LLM 主消息且 stop_reason 表明已结束）
        - content_blocks 中显式携带 cloud FileRecord ID 的产物

        本地相对/绝对路径、终端日志、截图等没有 FileRecord 的内容不会被上传或建
        文件资产，避免把中间执行细节误当成团队云资产。
        """
        from apps.chat.conversation.models import ChatMessage
        message = message_or_id
        if not isinstance(message_or_id, ChatMessage):
            message = (
                ChatMessage.objects
                .select_related(
                    'session',
                    'session__workspace',
                    'session__user',
                )
                .filter(id=message_or_id)
                .first()
            )
        if not message or getattr(message, 'role', '') != 'assistant':
            return []

        session = getattr(message, 'session', None)
        project = _resolve_publish_host(session)
        if not project:
            return []

        service = cls(user=getattr(session, 'user', None))
        published: list[ContextItem] = []

        final_answer = service._publish_ai_final_answer(project, message)
        if final_answer:
            published.append(final_answer)

        published.extend(service._publish_explicit_file_deliverables(project, message))
        return published

    def _publish_ai_final_answer(self, project: Project, message: Any) -> Optional[ContextItem]:
        if getattr(message, 'message_kind', '') != 'llm':
            return None
        if not self._is_publishable_final_answer(message):
            return None
        if not self.check_space_permission(str(project.id), 'viewer'):
            return None

        conversation_origin = self._conversation_origin(message, project)
        run_origin = self._run_origin(message)
        resource_id = f'chat_message:{message.id}'
        existing = ContextItem.objects.filter(
            _asset_host_q(project.id),
            item_type=self.AI_FINAL_ITEM_TYPE,
            resource_id=resource_id,
        ).first()
        if existing:
            return existing

        title = self._final_answer_title(message)
        preview = (getattr(message, 'text_summary', '') or '').strip()
        asset_source = self._build_asset_source(
            kind=self.SOURCE_AI_FINAL_ANSWER,
            user_id=str(getattr(self.user, 'id', '') or ''),
            conversation_origin=conversation_origin,
            run_origin=run_origin,
        )
        item = ContextItem.objects.create(
            **_create_host_kwargs(project.id),
            item_type=self.AI_FINAL_ITEM_TYPE,
            title=title,
            preview=preview[:500],
            status='active',
            resource_id=resource_id,
            metadata={
                'asset_kind': self.SOURCE_AI_FINAL_ANSWER,
                'asset_source': asset_source,
            },
            order=0,
            created_by=self.user,
            updated_by=self.user,
        )

        from apps.tabtinspace.services.resource_bridge import ResourceBridge
        ResourceBridge._update_search_vector(item.id)

        record_team_space_activity(
            project,
            SpaceActivityEvent.EventType.ASSET_CREATED,
            actor_user=self.user,
            target_type='asset',
            target_id=str(item.id),
            target_name=item.title,
            metadata={'item_type': item.item_type, 'source_kind': self.SOURCE_AI_FINAL_ANSWER},
        )
        return item

    def _publish_explicit_file_deliverables(self, project: Project, message: Any) -> list[ContextItem]:
        items: list[ContextItem] = []
        conversation_origin = self._conversation_origin(message, project)
        run_origin = self._run_origin(message)
        for file_ref in self._iter_explicit_file_refs(getattr(message, 'content_blocks_json', None)):
            try:
                item = self.upload_to_space(
                    space_id=project.id,
                    file_record_id=UUID(file_ref['file_record_id']),
                    title=file_ref.get('title') or None,
                    source_kind=self.SOURCE_AI_DELIVERABLE,
                    conversation_origin=conversation_origin,
                    run_origin=run_origin,
                )
            except (ValueError, ServiceError):
                logger.debug(
                    '[TabFilesService] skip non-publishable deliverable file ref: %s',
                    file_ref,
                    exc_info=True,
                )
                continue
            if item:
                items.append(item)
        return items

    @classmethod
    def _is_publishable_final_answer(cls, message: Any) -> bool:
        if getattr(message, 'metadata', None) and message.metadata.get('partial'):
            return False
        stop_reason = (getattr(message, 'stop_reason', '') or '').strip()
        if stop_reason and stop_reason not in cls.FINAL_ANSWER_STOP_REASONS:
            return False
        return bool((getattr(message, 'text_summary', '') or '').strip())

    @staticmethod
    def _final_answer_title(message: Any) -> str:
        session = getattr(message, 'session', None)
        session_title = (getattr(session, 'title', '') or '').strip()
        return f'{session_title} · AI 最终答复' if session_title else 'AI 最终答复'

    @staticmethod
    def _conversation_origin(message: Any, project: Project) -> Dict[str, Any]:
        session = getattr(message, 'session', None)
        return {
            # wire 兼容：历史字段名 team_space_id，值为 Project.id
            'team_space_id': str(project.id),
            'project_id': str(project.id),
            'chat_session_id': str(getattr(session, 'id', '') or ''),
            'message_id': str(getattr(message, 'id', '') or ''),
        }

    @staticmethod
    def _run_origin(message: Any) -> Dict[str, Any]:
        trace_id = getattr(message, 'trace_id', None)
        return {
            'agent_run_id': getattr(message, 'agent_run_id', '') or '',
            'trace_id': str(trace_id) if trace_id else '',
            'subagent_run_id': getattr(message, 'subagent_run_id', '') or '',
        }

    @classmethod
    def _iter_explicit_file_refs(cls, blocks: Any) -> Iterable[Dict[str, str]]:
        """递归查找明确指向云 FileRecord 的产物引用。"""
        if isinstance(blocks, list):
            for item in blocks:
                yield from cls._iter_explicit_file_refs(item)
            return
        if not isinstance(blocks, dict):
            return

        file_record_id = blocks.get('file_record_id') or blocks.get('fileRecordId')
        if isinstance(file_record_id, str) and file_record_id.strip():
            title = blocks.get('title') or blocks.get('file_name') or blocks.get('fileName')
            yield {
                'file_record_id': file_record_id.strip(),
                'title': title.strip() if isinstance(title, str) else '',
            }

        payload = blocks.get('payload')
        if isinstance(payload, (dict, list)):
            yield from cls._iter_explicit_file_refs(payload)
        content = blocks.get('content')
        if isinstance(content, (dict, list)):
            yield from cls._iter_explicit_file_refs(content)

    @classmethod
    def _build_asset_source(
        cls,
        *,
        kind: str,
        user_id: str = '',
        conversation_origin: Optional[Dict[str, Any]] = None,
        run_origin: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return {
            'kind': kind,
            'member_user_id': user_id if kind == cls.SOURCE_MEMBER_UPLOAD else '',
            'actor_user_id': user_id,
            'conversation_origin': cls._compact_dict(conversation_origin or {}),
            'run_origin': cls._compact_dict(run_origin or {}),
        }

    @staticmethod
    def _compact_dict(value: Dict[str, Any]) -> Dict[str, Any]:
        return {key: item for key, item in value.items() if item not in (None, '', [])}

    @staticmethod
    def _build_metadata(record: FileRecord, asset_source: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        thumbnail_url = record.cdn_url or record.access_url
        if record.is_public:
            thumbnail_url = build_public_asset_url(record.file_key) or thumbnail_url
        return {
            'file_type': record.file_type,
            'mime_type': record.mime_type,
            'file_size': record.file_size,
            'file_extension': record.file_extension,
            'file_name': record.file_name,
            'thumbnail_url': thumbnail_url,
            'asset_kind': 'cloud_file',
            'asset_source': asset_source or {},
        }

    @staticmethod
    def _format_size(size_bytes: int) -> str:
        if size_bytes < 1024:
            return f'{size_bytes} B'
        elif size_bytes < 1024 * 1024:
            return f'{size_bytes / 1024:.1f} KB'
        elif size_bytes < 1024 * 1024 * 1024:
            return f'{size_bytes / (1024 * 1024):.1f} MB'
        return f'{size_bytes / (1024 * 1024 * 1024):.1f} GB'
