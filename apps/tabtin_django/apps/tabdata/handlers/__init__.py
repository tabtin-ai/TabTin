"""Record Handlers — TabData DDD 应用层。

导出 RecordHandlerFactory，通过工厂方法构建各类 Handler。

Usage（step2 接入后）::

    from apps.tabdata.handlers import RecordHandlerFactory

    # 单条操作
    handler = RecordHandlerFactory.create_handler(user=request.auth)
    snapshot, error = handler.handle(context)

    handler = RecordHandlerFactory.update_handler(user=request.auth)
    snapshot, error = handler.handle(context)

    handler = RecordHandlerFactory.delete_handler(user=request.auth)
    success = handler.handle(context)

    # 批量操作
    handler = RecordHandlerFactory.batch_create_handler(user=request.auth)
    snapshots, errors = handler.handle(context)

    handler = RecordHandlerFactory.batch_update_handler(user=request.auth)
    snapshots, errors = handler.handle(context)

    handler = RecordHandlerFactory.batch_delete_handler(user=request.auth)
    count, errors, deleted_ids, failed_ids = handler.handle(context)
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from apps.tabdata.handlers.batch_create_records import BatchCreateRecordsHandler
    from apps.tabdata.handlers.batch_delete_records import BatchDeleteRecordsHandler
    from apps.tabdata.handlers.batch_update_records import BatchUpdateRecordsHandler
    from apps.tabdata.handlers.create_record import CreateRecordHandler
    from apps.tabdata.handlers.delete_record import DeleteRecordHandler
    from apps.tabdata.handlers.update_record import UpdateRecordHandler


class RecordHandlerFactory:
    """构建 Handler 实例，注入 Port 依赖。

    API 层或 Service Facade 通过本工厂获取 Handler。
    所有 Port 使用 ``apps.tabdata.infrastructure`` 下的默认实现。
    """

    @staticmethod
    def create_handler(user=None) -> CreateRecordHandler:
        from apps.tabdata.handlers.create_record import CreateRecordHandler
        return CreateRecordHandler(**RecordHandlerFactory._build_ports(user=user))

    @staticmethod
    def update_handler(user=None) -> UpdateRecordHandler:
        from apps.tabdata.handlers.update_record import UpdateRecordHandler
        return UpdateRecordHandler(**RecordHandlerFactory._build_ports(user=user))

    @staticmethod
    def delete_handler(user=None) -> DeleteRecordHandler:
        from apps.tabdata.handlers.delete_record import DeleteRecordHandler
        return DeleteRecordHandler(**RecordHandlerFactory._build_ports(user=user))

    @staticmethod
    def batch_create_handler(user=None) -> BatchCreateRecordsHandler:
        from apps.tabdata.handlers.batch_create_records import BatchCreateRecordsHandler
        return BatchCreateRecordsHandler(**RecordHandlerFactory._build_ports(user=user))

    @staticmethod
    def batch_update_handler(user=None) -> BatchUpdateRecordsHandler:
        from apps.tabdata.handlers.batch_update_records import BatchUpdateRecordsHandler
        return BatchUpdateRecordsHandler(**RecordHandlerFactory._build_ports(user=user))

    @staticmethod
    def batch_delete_handler(user=None) -> BatchDeleteRecordsHandler:
        from apps.tabdata.handlers.batch_delete_records import BatchDeleteRecordsHandler
        return BatchDeleteRecordsHandler(**RecordHandlerFactory._build_ports(user=user))

    @staticmethod
    def _build_ports(user=None) -> dict:
        """构建所有 Port 默认实现实例。

        使用延迟导入避免在 ``handlers/`` 模块加载时拉入全部基础设施依赖。
        基础设施层文件由其他 Agent 在 step1 中创建。
        """
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.infrastructure.attachment_adapter import DjangoAttachmentAdapter
        from apps.tabdata.infrastructure.cascade_adapter import DjangoCascadeAdapter
        from apps.tabdata.infrastructure.django_field_repository import DjangoFieldRepository
        from apps.tabdata.infrastructure.django_record_repository import DjangoRecordRepository
        from apps.tabdata.infrastructure.django_unit_of_work import DjangoUnitOfWork
        from apps.tabdata.infrastructure import get_event_bus
        from apps.tabdata.infrastructure.link_service_adapter import DjangoLinkServiceAdapter
        from apps.tabdata.infrastructure.native_io_adapter import NativeRecordIOAdapter

        return {
            'record_repository': DjangoRecordRepository(db_alias=TABDATA_DB_ALIAS),
            'native_io': NativeRecordIOAdapter(),
            'unit_of_work': DjangoUnitOfWork(db_alias=TABDATA_DB_ALIAS),
            'event_bus': get_event_bus(),
            'field_repository': DjangoFieldRepository(db_alias=TABDATA_DB_ALIAS),
            'link_service': DjangoLinkServiceAdapter(),
            'cascade_service': DjangoCascadeAdapter(),
            'attachment_service': DjangoAttachmentAdapter(user=user),
        }


__all__ = ['RecordHandlerFactory']
