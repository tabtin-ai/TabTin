"""
数据连接器模型

当前仅支持 PostgreSQL 外部数据源接入 TabData。
通过 Proxy（实时代理）或 Mirror（定时镜像）模式映射外部表到 TabData Table。
"""
import json
import uuid

from django.conf import settings
from django.db import models


# ── 当前已实现的连接器类型 ──

SUPPORTED_CONNECTOR_TYPE_CHOICES = [
    ('postgresql', 'PostgreSQL'),
]
SUPPORTED_CONNECTOR_TYPES = tuple(value for value, _ in SUPPORTED_CONNECTOR_TYPE_CHOICES)
SUPPORTED_CONNECTOR_TYPE_SET = frozenset(SUPPORTED_CONNECTOR_TYPES)
SUPPORTED_CONNECTOR_TYPES_TEXT = ', '.join(SUPPORTED_CONNECTOR_TYPES)

CONNECTOR_TYPE_CHOICES = SUPPORTED_CONNECTOR_TYPE_CHOICES

# ── 同步模式 ──

SYNC_MODE_CHOICES = [
    ('proxy', '代理（实时转发）'),
    ('mirror', '镜像（定时同步）'),
]
SYNC_MODE_SET = frozenset(value for value, _ in SYNC_MODE_CHOICES)
SYNC_MODE_TEXT = ', '.join(value for value, _ in SYNC_MODE_CHOICES)

# ── 镜像策略 ──

MIRROR_STRATEGY_CHOICES = [
    ('full', '全量刷新'),
    ('incremental', '增量同步'),
]

# ── 连接器状态 ──

CONNECTOR_STATUS_CHOICES = [
    ('pending', '待连接'),
    ('connected', '已连接'),
    ('error', '连接异常'),
    ('disabled', '已禁用'),
]


class DataConnector(models.Model):
    """外部数据源连接器"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization_id = models.UUIDField(db_index=True, verbose_name='组织 ID')
    space_id = models.UUIDField(db_index=True, verbose_name='所属 Space')

    connector_type = models.CharField(
        max_length=32,
        choices=CONNECTOR_TYPE_CHOICES,
        verbose_name='连接器类型',
    )
    config_encrypted = models.TextField(
        verbose_name='加密配置',
        help_text='Fernet 加密的 JSON，包含连接详情（host/port/password 等）',
    )
    name = models.CharField(max_length=200, verbose_name='连接器名称')
    status = models.CharField(
        max_length=20,
        choices=CONNECTOR_STATUS_CHOICES,
        default='pending',
        verbose_name='连接状态',
    )
    last_error = models.TextField(blank=True, default='', verbose_name='最近错误信息')
    last_probe_at = models.DateTimeField(null=True, blank=True, verbose_name='最近探测时间')

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='data_connectors',
        verbose_name='创建者',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_connector'
        verbose_name = '数据连接器'
        verbose_name_plural = '数据连接器'
        indexes = [
            models.Index(fields=['space_id', 'status']),
        ]

    def __str__(self):
        return f'{self.name} ({self.connector_type})'

    # ── 配置加密/解密（复用 DbReadOnlyConnection 的 Fernet 模式） ──

    @staticmethod
    def _get_fernet():
        from cryptography.fernet import Fernet
        from django.core.exceptions import ImproperlyConfigured
        key = getattr(settings, 'DB_CONNECTION_ENCRYPTION_KEY', None)
        if not key:
            raise ImproperlyConfigured(
                "缺少 DB_CONNECTION_ENCRYPTION_KEY 配置。"
                "连接器使用独立加密密钥保护外部数据库凭据，"
                "禁止降级到 SECRET_KEY（轮换后所有连接器配置将永久不可解密）。"
                "请在环境变量中设置 DB_CONNECTION_ENCRYPTION_KEY（Fernet 格式，"
                "可通过 python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\" 生成）。"
            )
        return Fernet(key if isinstance(key, bytes) else key.encode())

    def set_config(self, config_dict: dict) -> None:
        """将配置字典加密后存储"""
        f = self._get_fernet()
        payload = json.dumps(config_dict, ensure_ascii=False).encode()
        self.config_encrypted = f.encrypt(payload).decode()

    def get_config(self) -> dict:
        """解密并返回配置字典"""
        f = self._get_fernet()
        payload = f.decrypt(self.config_encrypted.encode())
        return json.loads(payload.decode())


class ConnectorTableMapping(models.Model):
    """外部表到 TabData Table 的映射"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    connector = models.ForeignKey(
        DataConnector,
        on_delete=models.CASCADE,
        related_name='mappings',
        verbose_name='所属连接器',
    )
    table = models.OneToOneField(
        'Table',
        on_delete=models.CASCADE,
        related_name='connector_mapping',
        verbose_name='TabData 表',
    )

    # 外部表信息
    external_schema = models.CharField(max_length=200, blank=True, default='', verbose_name='外部 Schema')
    external_table = models.CharField(max_length=200, verbose_name='外部表名')

    # 同步模式
    sync_mode = models.CharField(
        max_length=16,
        choices=SYNC_MODE_CHOICES,
        verbose_name='同步模式',
    )
    mirror_interval_minutes = models.PositiveIntegerField(
        default=60,
        verbose_name='镜像间隔（分钟）',
    )
    mirror_strategy = models.CharField(
        max_length=16,
        choices=MIRROR_STRATEGY_CHOICES,
        default='full',
        verbose_name='镜像策略',
    )
    incremental_column = models.CharField(
        max_length=200,
        blank=True,
        default='',
        verbose_name='增量同步列',
        help_text='增量模式下用于判断变更的列名（如 updated_at）',
    )

    # 字段映射：{"external_col": "tabdata_field_id"}
    field_mapping = models.JSONField(default=dict, verbose_name='字段映射')

    # 同步状态
    last_sync_at = models.DateTimeField(null=True, blank=True, verbose_name='最近同步时间')
    last_sync_status = models.CharField(max_length=16, blank=True, default='', verbose_name='最近同步状态')
    last_sync_error = models.TextField(blank=True, default='', verbose_name='最近同步错误')
    last_sync_row_count = models.PositiveIntegerField(default=0, verbose_name='最近同步行数')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_connector_table_mapping'
        verbose_name = '连接器表映射'
        verbose_name_plural = '连接器表映射'
        unique_together = [('connector', 'external_schema', 'external_table')]

    def __str__(self):
        ext = f'{self.external_schema}.{self.external_table}' if self.external_schema else self.external_table
        return f'{ext} → {self.table_id} ({self.sync_mode})'
