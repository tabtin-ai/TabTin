"""
数据连接器服务

管理外部 PostgreSQL 数据源的连接、发现、表导入。
"""
from apps.tabtinspace.services.organization_control_guard import (
    assert_organization_resource_write_allowed_optional,
)
import logging

from django.db import transaction
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models_connector import (
    CONNECTOR_STATUS_CHOICES,
    DataConnector,
    ConnectorTableMapping,
    SUPPORTED_CONNECTOR_TYPE_SET,
    SUPPORTED_CONNECTOR_TYPES_TEXT,
    SYNC_MODE_SET,
    SYNC_MODE_TEXT,
)

logger = logging.getLogger(__name__)


class ConnectorService:
    """数据连接器管理服务"""

    def __init__(self, user):
        self.user = user

    @staticmethod
    def _ensure_supported_connector_type(connector_type: str) -> None:
        """拒绝尚未实现的连接器类型，避免 API / Service 能力漂移。"""
        if connector_type not in SUPPORTED_CONNECTOR_TYPE_SET:
            raise ValueError(
                f"Unsupported connector type: '{connector_type}'. "
                f"Currently supported: {SUPPORTED_CONNECTOR_TYPES_TEXT}."
            )

    # ── Connector CRUD ──

    def create_connector(self, organization_id: str, space_id: str,
                         connector_type: str, name: str, config: dict) -> DataConnector:
        """创建数据连接器"""
        from apps.tabtinspace.services.base import ensure_space_in_organization

        self._ensure_supported_connector_type(connector_type)
        space = ensure_space_in_organization(organization_id, space_id)
        connector = DataConnector(
            organization_id=space.organization_id,
            space_id=space.id,
            connector_type=connector_type,
            name=name,
            created_by=self.user,
        )
        connector.set_config(config)
        connector.save(using=TABDATA_DB_ALIAS)
        return connector

    def get_connector(self, connector_id: str) -> DataConnector:
        """获取单个连接器"""
        return DataConnector.objects.using(TABDATA_DB_ALIAS).get(id=connector_id)

    def list_connectors(self, space_id: str) -> list:
        """列出 Space 下所有连接器"""
        return list(
            DataConnector.objects.using(TABDATA_DB_ALIAS)
            .filter(space_id=space_id)
            .order_by('-created_at')
        )

    _VALID_STATUSES = {s[0] for s in CONNECTOR_STATUS_CHOICES}

    def update_connector(self, connector_id: str, **fields) -> DataConnector:
        """更新连接器配置（仅允许更新 name / status / config）"""
        connector = self.get_connector(connector_id)

        if 'name' in fields:
            connector.name = fields['name']

        if 'status' in fields:
            status = fields['status']
            if status not in self._VALID_STATUSES:
                raise ValueError(
                    f"Invalid connector status '{status}'. "
                    f"Allowed values: {', '.join(sorted(self._VALID_STATUSES))}"
                )
            connector.status = status

        if 'config' in fields and fields['config'] is not None:
            connector.set_config(fields['config'])

        connector.save(using=TABDATA_DB_ALIAS)
        return connector

    def delete_connector(self, connector_id: str):
        """删除连接器及其所有关联的表映射和 TabData 表"""
        from apps.tabdata.models import Table

        connector = self.get_connector(connector_id)
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            mappings = connector.mappings.using(TABDATA_DB_ALIAS).all()
            table_ids = [mapping.table_id for mapping in mappings]
            mappings.delete()
            if table_ids:
                Table.objects.using(TABDATA_DB_ALIAS).filter(id__in=table_ids).delete()
            connector.delete(using=TABDATA_DB_ALIAS)

    # ── Connection Testing ──

    def test_connection(self, connector_id: str) -> tuple[bool, str]:
        """测试连接器的连通性，并更新连接器状态"""
        connector = self.get_connector(connector_id)
        instance = self._get_connector_instance(connector)
        try:
            success, message = instance.test_connection()
            connector.status = 'connected' if success else 'error'
            connector.last_error = '' if success else message
            connector.last_probe_at = timezone.now()
            connector.save(
                using=TABDATA_DB_ALIAS,
                update_fields=['status', 'last_error', 'last_probe_at', 'updated_at'],
            )
            return success, message
        except Exception as e:
            connector.status = 'error'
            connector.last_error = str(e)
            connector.last_probe_at = timezone.now()
            connector.save(
                using=TABDATA_DB_ALIAS,
                update_fields=['status', 'last_error', 'last_probe_at', 'updated_at'],
            )
            return False, str(e)
        finally:
            instance.close()

    # ── Schema Discovery ──

    def discover_tables(self, connector_id: str) -> list:
        """发现外部数据源中的所有表（含列信息）
        """
        connector = self.get_connector(connector_id)
        instance = self._get_connector_instance(connector)
        try:
            # 当前连接器接口未暴露 connect()/shared connection，直接按标准抽象调用。
            tables = instance.discover_tables()
            for table in tables:
                table.columns = instance.discover_columns(table.schema, table.name)
            return tables
        finally:
            instance.close()

    # ── Table Import ──

    def import_tables(self, connector_id: str, selections: list[dict]) -> list[dict]:
        """
        将选定的外部表导入为 TabData 表。

        Args:
            connector_id: 连接器 ID
            selections: 导入选择列表，每项包含:
                - schema: 外部 Schema 名
                - table: 外部表名
                - sync_mode: 同步模式（proxy/mirror）

        Returns:
            创建的表信息列表
        """
        from apps.tabdata.models import Table, TableField
        from apps.tabdata.services.connectors.type_mapping import pg_type_to_tabdata
        from apps.tabdata.services.table_service import TableService

        connector = self.get_connector(connector_id)
        instance = self._get_connector_instance(connector)
        results = []

        self._ensure_supported_connector_type(connector.connector_type)
        type_mapper = pg_type_to_tabdata

        assert_organization_resource_write_allowed_optional(connector.organization_id)

        # QTA-27: 连接器导入前预检 max_tables 配额
        from apps.users.membership.services.quota_service import check_quota_safe
        _wt_id_str = str(connector.organization_id) if connector.organization_id else None
        if _wt_id_str:
            check_quota_safe(
                quota_type="max_tables",
                increment=len(selections),
                organization_id=_wt_id_str,
                actor=self.user,
            )

        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                for sel in selections:
                    ext_schema = sel.get('schema', '')
                    ext_table = sel['table']
                    sync_mode = sel.get('sync_mode', 'proxy')
                    if sync_mode not in SYNC_MODE_SET:
                        raise ValueError(
                            f"Invalid sync_mode '{sync_mode}'. "
                            f"Allowed values: {SYNC_MODE_TEXT}."
                        )

                    # 发现外部表列
                    columns = instance.discover_columns(ext_schema, ext_table)

                    # 创建 TabData 表
                    source_type = 'proxy' if sync_mode == 'proxy' else 'mirror'
                    table = Table.objects.using(TABDATA_DB_ALIAS).create(
                        name=ext_table,
                        description=f'从 {connector.name} 导入 ({ext_schema}.{ext_table})',
                        organization_id=connector.organization_id,
                        space_id=connector.space_id,
                        owner=self.user,
                        source_type=source_type,
                        visibility='normal',
                    )

                    # 从外部列创建字段
                    field_mapping = {}
                    for i, col in enumerate(columns):
                        field_type = type_mapper(col.data_type)
                        field = TableField.objects.using(TABDATA_DB_ALIAS).create(
                            table=table,
                            name=col.name,
                            api_name=col.name,
                            field_type=field_type,
                            order=i,
                            is_primary=col.is_primary_key,
                        )
                        field_mapping[col.name] = str(field.id)

                    active_fields = list(
                        TableField.objects.using(TABDATA_DB_ALIAS).filter(
                            table_id=table.id, is_deleted=False,
                        )
                    )
                    TableService(user=self.user)._native_ensure_table(
                        connector.space_id, table.id, active_fields,
                    )

                    # 创建映射记录
                    mapping = ConnectorTableMapping.objects.using(TABDATA_DB_ALIAS).create(
                        connector=connector,
                        table=table,
                        external_schema=ext_schema,
                        external_table=ext_table,
                        sync_mode=sync_mode,
                        field_mapping=field_mapping,
                    )

                    results.append({
                        'table_id': str(table.id),
                        'table_name': table.name,
                        'source_type': source_type,
                        'field_count': len(columns),
                        'mapping_id': str(mapping.id),
                    })

            return results
        finally:
            instance.close()

    # ── Connector Factory ──

    def _get_connector_instance(self, connector: DataConnector):
        """根据连接器类型创建对应的连接器实例"""
        config = connector.get_config()
        self._ensure_supported_connector_type(connector.connector_type)
        if connector.connector_type == 'postgresql':
            from apps.tabdata.services.connectors.postgresql_connector import PostgreSQLConnector
            return PostgreSQLConnector(config)
        raise ValueError(
            f"Unsupported connector type: '{connector.connector_type}'. "
            f"Currently supported: {SUPPORTED_CONNECTOR_TYPES_TEXT}."
        )
