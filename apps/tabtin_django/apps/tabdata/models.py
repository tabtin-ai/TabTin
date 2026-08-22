"""
TabData 数据模型

包含核心模型（TabData 插件）：
1. Table - 表格（结构化层）
2. TableField - 字段定义
3. TableRecord - 记录数据
4. TableView - 视图配置（洞察化层/SubTable）
5. TableShare - 表格分享
6. RecordComment - 记录评论
7. RecordHistory - 记录历史
8. RecordHistoryItem - 记录历史明细
9. LinkRecord - 关联字段 junction table（legacy 真源）
9b. LinkRelation / LinkEdge - 统一关系定义与边存储（迁移中）
10. TableApiToken - Open API 访问令牌
11. RowPolicy / DataConnector / ApiCallLog 等拆分模型

Organization / Space 已迁移至 apps.tabtinspace.models。
"""

import logging
import uuid
from django.db import models
from django.contrib.auth import get_user_model
from django.utils import timezone
from django.db.models import Q
from django.contrib.postgres.indexes import GinIndex

logger = logging.getLogger(__name__)

from apps.services.common.cross_db_softref import make_softref_property
from apps.services.oss.models import FileRecord, UploadTask
from apps.services.common.base_models import ContextSyncMixin, ResourcePermission, TrashableModelMixin
from apps.tabdata.constants import TABDATA_DB_ALIAS

User = get_user_model()


class Table(TrashableModelMixin, ContextSyncMixin):
    """表格模型"""

    # ── 可见性 ──
    VISIBILITY_NORMAL = 'normal'
    VISIBILITY_SYSTEM = 'system'
    VISIBILITY_HIDDEN = 'hidden'
    VISIBILITY_CHOICES = [
        (VISIBILITY_NORMAL, '普通表'),      # 用户创建的表
        (VISIBILITY_SYSTEM, '系统表'),      # 平台系统表，可见但不可删除/改结构
        (VISIBILITY_HIDDEN, '隐藏系统表'),  # 用户完全不可见
    ]

    # ── 数据源类型 ──
    SOURCE_NATIVE = 'native'
    SOURCE_MIRROR = 'mirror'
    SOURCE_PROXY = 'proxy'
    SOURCE_TYPE_CHOICES = [
        (SOURCE_NATIVE, '原生表'),    # TabData 本地存储（默认）
        (SOURCE_MIRROR, '镜像表'),    # 定时同步外部数据到本地
        (SOURCE_PROXY, '代理表'),     # 实时转发查询到外部数据源
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255, verbose_name='表格名称')
    description = models.TextField(blank=True, verbose_name='表格描述')
    icon = models.CharField(max_length=50, blank=True, verbose_name='图标emoji')

    # 关联信息
    owner = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='owned_tables',
        verbose_name='所有者',
    )
    # ── Organization/Space 上下文：使用 UUID 字段（跨库安全） ──
    organization_id = models.UUIDField(db_index=True, verbose_name='所属组织')
    space_id = models.UUIDField(
        db_index=True,
        null=True,
        blank=True,
        verbose_name='宿主上下文 ID',
        help_text=(
            '#3266：软 UUID（非 FK）。值为 Workspace.id 或 Project.id（历史 id-reuse）；'
            '列名暂保留 space_id。资源归属以 organization_id 为准；宿主解析走 host_resolver。'
        ),
    )

    # Schema复用与默认数据源
    schema_history_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name='关联的Schema历史记录ID',
        help_text='指向 apps.schema.storage.Schema.id'
    )
    default_source_url = models.URLField(
        blank=True,
        verbose_name='默认数据源URL',
    )

    # 表格配置
    default_view = models.ForeignKey(
        'TableView',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name='默认视图'
    )
    row_count = models.IntegerField(default=0, verbose_name='行数')
    field_count = models.IntegerField(default=0, verbose_name='字段数')

    # 权限和状态
    visibility = models.CharField(
        max_length=20,
        choices=VISIBILITY_CHOICES,
        default=VISIBILITY_NORMAL,
        db_index=True,
        verbose_name='可见性',
        help_text='normal=普通表, system=系统表(可见不可删改结构), hidden=隐藏系统表',
    )
    is_public = models.BooleanField(default=False, verbose_name='是否公开')
    is_template = models.BooleanField(default=False, verbose_name='是否为模板')
    is_archived = models.BooleanField(default=False, verbose_name='是否归档')

    # 数据源类型
    source_type = models.CharField(
        max_length=16,
        choices=SOURCE_TYPE_CHOICES,
        default=SOURCE_NATIVE,
        db_index=True,
        verbose_name='数据源类型',
        help_text='native=本地存储, mirror=外部镜像, proxy=外部代理',
    )

    # RLS（行级安全）
    rls_enabled = models.BooleanField(
        default=False,
        verbose_name='启用行级安全',
        help_text='启用后，对 Open API 访问自动注入 RowPolicy 行级过滤条件',
    )
    rls_force = models.BooleanField(
        default=False,
        verbose_name='强制 RLS',
        help_text='启用后，JWT 用户（表格 Owner）也受 RLS 策略约束',
    )

    # Schema 版本号 — 每次 schema 变更（增删改字段）自动递增
    schema_version = models.PositiveIntegerField(
        default=0,
        verbose_name='Schema 版本号',
        help_text='每次字段结构变更（增删改字段）时自动递增',
    )

    # C3 / Wave 1.3：Table schema_version_token（删表副作用闭环防御）
    #
    # 每次 trash_table / delete_table / permanent_delete_table /
    # restore_table_from_trash 调用时 bump（重新生成 UUID）。Celery worker
    # 在执行涉及该 table 的任务前，**先**对比任务发布时 freeze 的 token 与当前
    # ``Table.schema_version_token``，不一致则视为"该表已删除/重置"，no-op +
    # 打 info 日志，避免持续报"table not found"刷屏。
    #
    # 与 ``schema_version`` 区别：
    # - ``schema_version`` 单调递增，覆盖字段结构变更（创建/删除/改名/类型转换），
    #   用于客户端 SDK 缓存失效。
    # - ``schema_version_token`` 是 trash 生命周期的 UUID 锚点，trash → restore
    #   一来一回也算两次 bump（防御未消费的旧任务再次执行）。
    schema_version_token = models.UUIDField(
        default=uuid.uuid4,
        verbose_name='Schema 版本 Token',
        help_text=(
            'C3：trash/delete/restore 时 bump，Celery worker 校验过期 task 跳过。'
            '与 schema_version 互补：前者覆盖生命周期，后者覆盖字段结构变更。'
        ),
    )

    # 全局递增版本号序列，用于增量同步。
    # 每次记录增删改时原子递增此值，赋给 TableRecord.version，
    # 保证同一张表内 version 全局单调递增，避免 per-record 独立递增导致增量遗漏。
    record_version_seq = models.PositiveBigIntegerField(
        default=0,
        verbose_name='记录版本序列',
        help_text='全局递增计数器，每次记录变更时 +1 后赋给记录的 version 字段',
    )
    record_delete_version = models.PositiveBigIntegerField(
        default=0,
        verbose_name='记录删除版本',
        help_text='最近一次成功物理删除记录时分配的版本，用于要求增量客户端全量刷新',
    )

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_table'
        verbose_name = '表格'
        verbose_name_plural = '表格'
        ordering = ['-updated_at']
        indexes = [
            models.Index(fields=['organization_id', 'is_archived']),
            models.Index(fields=['space_id', 'is_archived']),
            models.Index(fields=['space_id', 'visibility']),
            models.Index(fields=['owner', 'is_archived']),
            models.Index(fields=['is_template', 'is_public']),
            models.Index(fields=['created_at']),
        ]

    # ── 便捷属性 ──

    @property
    def is_system_table(self) -> bool:
        """是否为系统表（system 或 hidden）"""
        return self.visibility in (self.VISIBILITY_SYSTEM, self.VISIBILITY_HIDDEN)

    # ── ContextSyncMixin 实现（ResourceBridge 自动同步） ──

    def get_context_type(self) -> str:
        return "tabdata"

    def get_context_title(self) -> str:
        return self.name

    def get_context_preview(self) -> str:
        if self.description:
            return self.description[:200]
        field_names = self._get_visible_field_names()
        if field_names:
            return " | ".join(field_names)
        return f"{self.row_count} 行 · {self.field_count} 字段"

    def _get_visible_field_names(self, limit: int = 6) -> list[str]:
        """返回前 N 个可见字段名（按 order 排序），用于卡片预览。结果在实例上缓存。"""
        cached = getattr(self, '_cached_field_names', None)
        if cached is not None:
            return cached
        try:
            result = list(
                self.fields
                .filter(is_hidden=False)
                .order_by('order')
                .values_list('name', flat=True)[:limit]
            )
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "Failed to get field names for table %s", self.pk, exc_info=True,
            )
            result = []
        object.__setattr__(self, '_cached_field_names', result)
        return result

    def get_context_status(self) -> str:
        if self.trashed_at is not None:
            return "trashed"
        return "archived" if self.is_archived else "active"

    def get_context_metadata(self) -> dict:
        field_names = self._get_visible_field_names()
        return {
            "current_table_id": str(self.id),
            "table_id": str(self.id),
            "icon": self.icon or "📊",
            "record_count": self.row_count,
            "field_count": self.field_count,
            "field_names": field_names,
            "visibility": self.visibility,
        }

    def is_context_archived(self) -> bool:
        return self.is_archived

    def __str__(self):
        return self.name


class TableField(models.Model):
    """表格字段模型

    字段分为两类：
    1. 基础数据字段 —— 存储用户直接输入的值（文本、数字、日期等）
    2. 自动标识字段 —— 按规则自动生成不可编辑的标识值

    """

    # 字段类型定义
    FIELD_TYPE_CHOICES = [
        # ── 基础文本字段 ──
        ('text', '文本字段'),
        ('long_text', '多行文本'),

        # ── 数值字段 ──
        ('number', '数字'),
        ('percent', '百分比'),
        ('currency', '货币'),
        ('rating', '评分'),

        # ── 选择字段 ──
        ('select', '单选'),
        ('multi_select', '多选'),
        ('checkbox', '复选框'),

        # ── 日期时间字段 ──
        ('date', '日期'),
        ('created_time', '创建时间'),
        ('last_modified_time', '最后修改时间'),

        # ── 链接与联系方式 ──
        ('url', 'URL链接'),
        ('email', '邮箱'),
        ('phone', '手机号'),

        # ── 用户字段 ──
        ('user', '用户'),
        ('created_by', '创建者'),
        ('last_modified_by', '最后修改者'),

        # ── 媒体与文件 ──
        ('attachment', '附件'),

        # ── 关联字段 ──
        ('link', '关联'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    table = models.ForeignKey(
        Table,
        on_delete=models.CASCADE,
        related_name='fields',
        verbose_name='所属表格'
    )

    # 字段基本信息
    name = models.CharField(max_length=255, verbose_name='字段名称')
    api_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        verbose_name='API 稳定名称',
        help_text='给 SDK/API 用的稳定标识，不跟随 name (display_name) 变更。'
                  '留空时 SDK 退化使用 name 作为 key。',
    )
    field_type = models.CharField(
        max_length=50,
        choices=FIELD_TYPE_CHOICES,
        verbose_name='字段类型'
    )
    description = models.TextField(blank=True, verbose_name='字段描述')

    # 字段配置（JSON存储不同类型的特殊配置）
    # 例如：选项列表、数字格式、验证规则等
    config = models.JSONField(default=dict, verbose_name='字段配置')

    # 显示和排序
    order = models.IntegerField(default=0, verbose_name='字段顺序')
    width = models.IntegerField(default=150, verbose_name='列宽')
    is_primary = models.BooleanField(default=False, verbose_name='是否为主字段')
    is_hidden = models.BooleanField(default=False, verbose_name='是否隐藏')

    # 验证规则
    default_value = models.JSONField(
        null=True,
        blank=True,
        default=None,
        verbose_name='默认值',
        help_text='统一字段默认值：literal / created_time / last_modified_time / creator',
    )
    validation_rules = models.JSONField(default=dict, verbose_name='验证规则')

    # 仅用于兼容已部署数据库中的 NOT NULL 旧列。产品逻辑、API 与字段类型契约
    # 均不再读取或写入这两个标记；保留映射是为了让 ORM INSERT 始终显式写 false，
    # 避免要求现有数据库执行删列或补默认值的结构迁移。
    is_lookup = models.BooleanField(default=False, verbose_name='是否为 Lookup 字段')
    has_error = models.BooleanField(
        default=False,
        verbose_name='字段是否有错误',
        help_text='如 Lookup 依赖的 Link 字段或目标字段已被删除',
    )

    # 软删除标记
    is_deleted = models.BooleanField(default=False, verbose_name='是否已删除')

    CELL_VALUE_TYPE_CHOICES = [
        ('string', '文本'),
        ('number', '数值'),
        ('boolean', '布尔'),
        ('dateTime', '日期时间'),
    ]
    cell_value_type = models.CharField(
        max_length=16,
        choices=CELL_VALUE_TYPE_CHOICES,
        default='string',
        verbose_name='单元格值类型',
        help_text='字段值的逻辑类型，驱动过滤/排序/渲染分支',
    )
    is_multiple_cell_value = models.BooleanField(
        default=False,
        verbose_name='是否多值',
        help_text='多值字段的值为数组，渲染为标签列表',
    )
    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_field'
        verbose_name = '字段'
        verbose_name_plural = '字段'
        ordering = ['order']
        constraints = [
            models.UniqueConstraint(
                fields=['table', 'name'],
                condition=models.Q(is_deleted=False),
                name='uniq_active_field_name_per_table'
            ),
            models.UniqueConstraint(
                fields=['table', 'api_name'],
                condition=models.Q(is_deleted=False) & ~models.Q(api_name=''),
                name='uniq_active_api_name_per_table'
            ),
        ]
        indexes = [
            models.Index(fields=['table', 'order']),
            models.Index(fields=['table', 'is_primary']),
        ]

    # cellValueType 默认映射表（与前端 FIELD_CELL_VALUE_TYPE 保持一致）
    _FIELD_TYPE_CVT_MAP = {
        'text': 'string', 'long_text': 'string', 'url': 'string',
        'email': 'string', 'phone': 'string',
        'number': 'number', 'rating': 'number',
        'select': 'string', 'multi_select': 'string',
        'checkbox': 'boolean',
        'date': 'dateTime',
        'created_time': 'dateTime', 'last_modified_time': 'dateTime',
        'user': 'string', 'created_by': 'string', 'last_modified_by': 'string',
        'attachment': 'string',
        'link': 'string',
    }
    _FIELD_TYPE_MULTI_MAP = {
        'multi_select': True, 'attachment': True,
        'link': True,
    }

    def compute_cell_value_type(self) -> str:
        """根据 field_type 计算默认 cellValueType（用于创建/转换时自动设置）"""
        return self._FIELD_TYPE_CVT_MAP.get(self.field_type, 'string')

    def compute_is_multiple_cell_value(self) -> bool:
        """根据 field_type 计算默认 isMultipleCellValue

        对于 link 字段，根据 relationship 动态判断：
        - ManyMany / OneMany → True（多值）
        - OneOne / ManyOne → False（单值）
        """
        if self.field_type == 'link':
            config = self.config or {}
            relationship = config.get('relationship', 'ManyOne')
            return relationship in ('ManyMany', 'OneMany')
        return self._FIELD_TYPE_MULTI_MAP.get(self.field_type, False)

    def save(self, *args, **kwargs):
        # 自动填充 cell_value_type / is_multiple_cell_value（如果未显式设置）
        if not self.cell_value_type or self.cell_value_type == 'string':
            computed = self.compute_cell_value_type()
            if computed != 'string' or not self.cell_value_type:
                self.cell_value_type = computed
        # link 字段每次都重新计算（relationship 可能变更）
        if self.field_type == 'link':
            self.is_multiple_cell_value = self.compute_is_multiple_cell_value()
        elif not self.is_multiple_cell_value:
            self.is_multiple_cell_value = self.compute_is_multiple_cell_value()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.table.name}.{self.name} ({self.get_field_type_display()})"

    @property
    def visibility_roles(self):
        config = self.config or {}
        roles = config.get('visibility_roles')
        if isinstance(roles, list):
            return roles
        return []


class TableRecord(models.Model):
    """表格记录模型"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    table = models.ForeignKey(
        Table,
        on_delete=models.CASCADE,
        related_name='records',
        verbose_name='所属表格'
    )

    # DEPRECATED: 已废弃的 JSON 存储，数据已迁移至原生 PostgreSQL 列。
    # 仅作为回滚窗口保留，native_only 模式下不再写入新数据。
    # 后续版本将移除此字段。
    data = models.JSONField(
        default=dict, null=True, blank=True, verbose_name='记录数据',
        help_text='DEPRECATED: 已废弃的 JSON 存储，数据已迁移至原生 PostgreSQL 列。',
    )
    position_id = models.TextField(
        null=True,
        blank=True,
        editable=False,
        verbose_name='协作排序位置标识',
    )
    # 记录元数据
    order = models.FloatField(default=0, verbose_name='排序位置')
    is_deleted = models.BooleanField(default=False, verbose_name='是否已删除')
    deleted_at = models.DateTimeField(null=True, blank=True, verbose_name='删除时间')
    version = models.PositiveBigIntegerField(default=1, verbose_name='数据版本')

    # 审核和状态
    status = models.CharField(
        max_length=50,
        default='active',
        verbose_name='记录状态'
    )
    tags = models.JSONField(default=list, verbose_name='标签')

    # 创建和修改信息
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name='created_records',
        verbose_name='创建者',
    )
    updated_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name='updated_records',
        verbose_name='最后修改者',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    source_url = models.URLField(blank=True, verbose_name='数据来源URL')

    class Meta:
        db_table = 'tabdata_record'
        verbose_name = '记录'
        verbose_name_plural = '记录'
        ordering = ['order', '-created_at']
        indexes = [
            models.Index(fields=['table', 'is_deleted', 'order']),
            models.Index(fields=['table', 'is_deleted', 'deleted_at']),
            models.Index(fields=['table', 'created_at']),
            models.Index(fields=['created_by', 'created_at']),
            models.Index(fields=['status']),
            models.Index(fields=['table', 'version']),
        ]

    @property
    def row_id(self) -> str:
        """提供前端使用的稳定行ID"""
        return str(self.id)

    def __getattribute__(self, name):
        if name == 'data':
            from django.conf import settings
            if getattr(settings, 'DEBUG', False):
                import warnings
                warnings.warn(
                    "TableRecord.data (JSONField) 已废弃，数据已迁移至原生 PostgreSQL 列。"
                    "请改用 get_record_data() 或 NativeRecordIO 读取。"
                    "写入请通过 RecordService 确保原生列同步。",
                    DeprecationWarning,
                    stacklevel=2,
                )
        return super().__getattribute__(name)

    def get_record_data(self) -> dict:
        """
        从原生 PostgreSQL 列读取记录数据（推荐替代 record.data）。

        返回 UUID-keyed dict，与旧 record.data 格式兼容。
        如果原生列读取失败，降级到 JSONField（通过 __dict__ 绕过警告）。
        """
        try:
            from apps.tabdata.models import Table
            from apps.tabdata.native.record_io import NativeRecordIO
            from apps.tabdata.native.value_converter import convert_native_row_to_record_data
            from apps.tabdata.native.pg_type_map import is_system_field
            from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=self.table_id)
            native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
            row = native_io.read_single(self.id)
            if row:
                user_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table.id, is_deleted=False,
                ))
                user_fields = [f for f in user_fields if not is_system_field(f.field_type)]
                result = convert_native_row_to_record_data(row, user_fields)
                if result:
                    return result
        except Exception as exc:
            logger.warning(
                "get_record_data native read failed for record %s, falling back to JSONField: %s",
                self.id, exc,
            )
        # 降级：读取 JSONField（通过 __dict__ 绕过 DeprecationWarning）
        return self.__dict__.get('data') or {}

    def __str__(self):
        try:
            primary_field = self.table.fields.filter(is_primary=True).first()
            if primary_field:
                raw_data = self.__dict__.get('data') or {}
                field_key = str(primary_field.id)
                if field_key in raw_data:
                    return f"{raw_data[field_key]}"
        except Exception:
            pass
        return f"Record {str(self.id)[:8]}"


class AttachmentUpload(models.Model):
    """附件上传任务明细"""

    STATUS_CHOICES = [
        ('pending', '等待上传'),
        ('uploading', '上传中'),
        ('completed', '已完成'),
        ('failed', '失败'),
        ('cancelled', '已取消'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # 单库治理：tabdata 与 oss 同库（PG）后恢复为物理 FK。db_column=upload_task_id 保列名；
    # on_delete=CASCADE 对齐原语义（删 UploadTask 连带删 AttachmentUpload，子项随父删）；
    # NOT NULL 不变；db_index=True 复用既有列索引。
    upload_task = models.ForeignKey(
        'oss.UploadTask',
        on_delete=models.CASCADE,
        db_column='upload_task_id',
        db_index=True,
        related_name='+',
        verbose_name='OSS上传任务',
        help_text='上传任务（oss.UploadTask）',
    )
    # ── Space/组织：使用 UUID 字段 ──
    organization_id = models.UUIDField(db_index=True, verbose_name='所属组织')
    space_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='所属 Space')
    table = models.ForeignKey(
        Table,
        on_delete=models.CASCADE,
        related_name='attachment_uploads',
        verbose_name='所属表格'
    )
    field = models.ForeignKey(
        TableField,
        on_delete=models.CASCADE,
        related_name='attachment_uploads',
        verbose_name='所属字段'
    )
    record = models.ForeignKey(
        TableRecord,
        on_delete=models.CASCADE,
        related_name='attachment_uploads',
        verbose_name='所属记录',
        null=True,
        blank=True
    )
    # 单库治理：tabdata 与 oss 同库（PG）后恢复为物理 FK。db_column=file_record_id 保列名；
    # on_delete=SET_NULL 对齐原语义（删 FileRecord 时置空、保留 upload 任务记录便于排障）。
    file_record = models.ForeignKey(
        'oss.FileRecord',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column='file_record_id',
        db_index=True,
        related_name='+',
        verbose_name='上传生成的文件',
        help_text='上传生成的文件（oss.FileRecord）',
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name='created_attachment_uploads',
        verbose_name='创建者',
        null=True,
        blank=True,
    )

    task_type = models.CharField(max_length=20, default='chunk', verbose_name='任务类型')
    file_name = models.CharField(max_length=255, verbose_name='文件名')
    file_size = models.BigIntegerField(verbose_name='文件大小(字节)')
    chunk_size = models.PositiveIntegerField(default=5 * 1024 * 1024, verbose_name='分片大小')
    mime_type = models.CharField(max_length=100, blank=True, verbose_name='MIME类型')
    is_public = models.BooleanField(default=False, verbose_name='是否公开可访问')

    object_key = models.CharField(max_length=500, verbose_name='OSS对象键')
    upload_id = models.CharField(max_length=255, blank=True, verbose_name='分片上传ID')

    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='状态',
        db_index=True
    )
    total_parts = models.PositiveIntegerField(default=0, verbose_name='总分片数')
    completed_parts = models.PositiveIntegerField(default=0, verbose_name='已完成分片数')
    uploaded_size = models.BigIntegerField(default=0, verbose_name='已上传大小(字节)')
    part_etags = models.JSONField(default=list, verbose_name='分片ETag列表')
    error_message = models.TextField(blank=True, verbose_name='错误信息')
    permission_scope = models.JSONField(default=dict, verbose_name='权限继承信息')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_attachment_upload'
        verbose_name = '附件上传任务'
        verbose_name_plural = '附件上传任务'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['table', 'field', 'status']),
            models.Index(fields=['upload_task', 'status'], name='tabd_attup_task_status_idx'),
        ]

    # upload_task / file_record 现为物理 FK（见上字段定义）；链式访问由 FK descriptor 原生承载。

    def __str__(self):
        return f"{self.file_name} ({self.get_status_display()})"


class AttachmentReference(models.Model):
    """附件引用关系"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # ── Space/组织：使用 UUID 字段 ──
    organization_id = models.UUIDField(db_index=True, verbose_name='所属组织')
    space_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='所属 Space')
    table = models.ForeignKey(
        Table,
        on_delete=models.CASCADE,
        related_name='attachment_references',
        verbose_name='所属表格'
    )
    field = models.ForeignKey(
        TableField,
        on_delete=models.CASCADE,
        related_name='attachment_references',
        verbose_name='所属字段'
    )
    record = models.ForeignKey(
        TableRecord,
        on_delete=models.CASCADE,
        related_name='attachment_references',
        verbose_name='所属记录',
        null=True,
        blank=True
    )
    # v0.1 §5.1：跨库软引用 oss.FileRecord，原 CASCADE 语义由 oss signals 主动维护。
    file_id = models.UUIDField(
        db_index=True,
        verbose_name='文件记录 ID',
        help_text='软引用 oss.FileRecord.id（v0.1 §5.1）',
    )
    upload = models.ForeignKey(
        AttachmentUpload,
        on_delete=models.SET_NULL,
        related_name='references',
        verbose_name='上传任务',
        null=True,
        blank=True
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name='created_attachment_references',
        verbose_name='创建者',
        null=True,
        blank=True,
    )
    permission_scope = models.JSONField(default=dict, verbose_name='权限继承信息')
    usage_metadata = models.JSONField(default=dict, verbose_name='使用元数据')

    is_deleted = models.BooleanField(default=False, verbose_name='是否已删除')
    deleted_at = models.DateTimeField(null=True, blank=True, verbose_name='删除时间')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    # v0.1 §5.1：跨库软引用 accessor
    file = make_softref_property(
        target_model="oss.FileRecord",
        cache_attr="_cached_file",
        id_attr="file_id",
    )

    class Meta:
        db_table = 'tabdata_attachment_reference'
        verbose_name = '附件引用'
        verbose_name_plural = '附件引用'
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['record', 'field', 'file_id'],
                condition=Q(is_deleted=False),
                name='uniq_active_attachment_reference'
            )
        ]
        indexes = [
            models.Index(fields=['table', 'field', 'is_deleted']),
            models.Index(fields=['file_id', 'is_deleted']),
        ]

    def mark_deleted(self):
        from django.utils import timezone
        self.is_deleted = True
        self.deleted_at = timezone.now()
        self.save(update_fields=['is_deleted', 'deleted_at', 'updated_at'])

    def __str__(self):
        # v0.1 §5.1：file 是跨库软引用 property，调用会触发跨库 fetch（admin / repr 路径
        # 是潜在 N+1 + strict 模式 raise 的雷）。改用纯 ID + table 名，避免无意识触发。
        return f"file={self.file_id} -> {self.table.name}"


class TableView(models.Model):
    """表格视图模型"""

    VIEW_TYPE_CHOICES = [
        ('grid', '表格视图'),
        ('kanban', '看板视图'),
        ('calendar', '日历视图'),
        ('gallery', '画廊视图'),
        ('list', '列表视图'),
        ('flashcard', '闪卡视图'),
        ('form', '表单视图'),
        # 未来扩展的视图类型
        # ('timeline', '时间轴视图'),
    ]


    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    table = models.ForeignKey(
        Table,
        on_delete=models.CASCADE,
        related_name='views',
        verbose_name='所属表格'
    )

    # 视图基本信息
    name = models.CharField(max_length=255, verbose_name='视图名称')
    view_type = models.CharField(
        max_length=50,
        choices=VIEW_TYPE_CHOICES,
        default='grid',
        verbose_name='视图类型'
    )
    description = models.TextField(blank=True, verbose_name='视图描述')

    # 视图配置
    config = models.JSONField(default=dict, verbose_name='视图特定配置')

    # 过滤和排序
    filter = models.JSONField(
        null=True, blank=True, default=None,
        verbose_name='嵌套过滤条件',
        help_text='FilterSet 格式：{"conjunction":"and","filterSet":[...]}，优先于 filters',
    )
    filters = models.JSONField(default=list, verbose_name='过滤条件（旧版扁平格式）')
    sorts = models.JSONField(default=list, verbose_name='排序规则')
    groups = models.JSONField(default=list, verbose_name='分组规则')

    # 显示设置
    visible_fields = models.JSONField(default=list, verbose_name='可见字段列表')
    field_order = models.JSONField(default=list, verbose_name='字段顺序')
    column_meta = models.JSONField(default=dict, verbose_name='列元数据')

    # 视图配置单调版本号：每次配置维度（filters/sorts/groups/config 等）写入 +1。
    # 用于协作快照重连/合并时的回退防护——旧快照 config_rev 更低时不覆盖新配置
    # （见 collab-live reconcileConcurrentItems 与 collab_service._persist_collab_views）。
    config_rev = models.IntegerField(default=0, verbose_name='视图配置版本号')

    # 权限
    is_shared = models.BooleanField(default=False, verbose_name='是否分享')
    is_locked = models.BooleanField(default=False, verbose_name='是否锁定配置')

    # 创建者和顺序
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        verbose_name='创建者',
    )
    order = models.IntegerField(default=0, verbose_name='视图顺序')

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_view'
        verbose_name = '视图'
        verbose_name_plural = '视图'
        ordering = ['order', 'created_at']
        indexes = [
            models.Index(fields=['table', 'order']),
        ]

    def __str__(self):
        return f"{self.table.name} - {self.name} ({self.get_view_type_display()})"


class TableShare(models.Model):
    """表格分享模型 — 支持表单填写、数据只读、组织限定三种模式"""

    SHARE_TYPE_CHOICES = [
        ('form', '表单分享'),
        ('data', '数据只读'),
        ('organization', '组织限定'),
    ]
    PERMISSION_CHOICES = [
        ('view', '只读'),
        ('comment', '可评论'),
        ('edit', '可编辑'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    table = models.ForeignKey(
        Table,
        on_delete=models.CASCADE,
        related_name='shares',
        verbose_name='所属表格'
    )
    view = models.ForeignKey(
        TableView,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        verbose_name='分享的视图'
    )

    share_type = models.CharField(
        max_length=20,
        choices=SHARE_TYPE_CHOICES,
        default='form',
        verbose_name='分享类型',
    )
    share_id = models.CharField(
        max_length=20,
        unique=True,
        verbose_name='分享ID'
    )
    password_hash = models.CharField(
        max_length=255,
        blank=True,
        verbose_name='访问密码 hash'
    )
    permission = models.CharField(
        max_length=20,
        choices=PERMISSION_CHOICES,
        default='view',
        verbose_name='权限'
    )
    organization_id = models.CharField(
        max_length=36,
        blank=True,
        default='',
        verbose_name='限定 Organization ID',
        help_text='share_type=organization 时填写',
    )
    login_required = models.BooleanField(
        default=False,
        verbose_name='需要登录',
    )

    # 限制条件
    expire_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='过期时间'
    )
    max_visits = models.IntegerField(
        null=True,
        blank=True,
        verbose_name='最大访问次数'
    )
    visit_count = models.IntegerField(default=0, verbose_name='访问计数')

    # 设置
    allow_download = models.BooleanField(default=True, verbose_name='允许下载')
    watermark = models.CharField(
        max_length=255,
        blank=True,
        verbose_name='水印'
    )

    # 创建者
    created_by = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        verbose_name='创建者',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabdata_share'
        verbose_name = '表格分享'
        verbose_name_plural = '表格分享'
        indexes = [
            models.Index(fields=['table', 'created_at']),
        ]

    def __str__(self):
        return f"{self.table.name} - {self.share_id} ({self.get_permission_display()})"

    def is_expired(self):
        """检查分享是否过期"""
        if self.expire_at and timezone.now() > self.expire_at:
            return True
        if self.max_visits and self.visit_count >= self.max_visits:
            return True
        return False

    def set_password(self, raw_password: str) -> None:
        """对密码进行哈希存储。传入空字符串表示清除密码。

        与 ``DocumentShare.set_password`` 对称，Wave 5 §8 完成迁移后，
        字段名从 ``password`` 重命名为 ``password_hash`` —— 数据迁移 0036
        会把存量明文一次性 ``make_password`` 化，迁移结束后字段中只会出现 hash。
        """
        from django.contrib.auth.hashers import make_password
        self.password_hash = make_password(raw_password) if raw_password else ''

    def check_password(self, raw_password: str) -> bool:
        """验证密码。仅接受 hash 比对（迁移后所有存量都是 hash）。"""
        if not self.password_hash:
            return False
        from django.contrib.auth.hashers import check_password
        return check_password(raw_password, self.password_hash)

    @property
    def has_password(self) -> bool:
        """与 DocumentShare 对称：用于公开接口判断是否需要密码。"""
        return bool(self.password_hash)


class RecordComment(models.Model):
    """记录评论模型"""

    ACTOR_TYPE_HUMAN = 'human'
    ACTOR_TYPE_AGENT = 'agent'
    ACTOR_TYPE_CHOICES = [
        (ACTOR_TYPE_HUMAN, '用户'),
        (ACTOR_TYPE_AGENT, 'Agent'),
    ]

    class Status(models.TextChoices):
        OPEN = 'open', '待处理'
        RESOLVED = 'resolved', '已解决'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    record = models.ForeignKey(
        TableRecord,
        on_delete=models.CASCADE,
        related_name='comments',
        verbose_name='所属记录'
    )

    # 评论内容
    content = models.TextField(verbose_name='评论内容')
    mentions = models.JSONField(default=list, verbose_name='@提及的用户ID列表')

    # ``author`` 是执行授权主体；``actor_*`` 是详情页展示的实际发言者。
    # Agent 通过用户授权执行时，两者必须分开保存，避免把展示身份用于提权。
    author_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        verbose_name='授权主体名称快照',
    )
    actor_type = models.CharField(
        max_length=16,
        choices=ACTOR_TYPE_CHOICES,
        default=ACTOR_TYPE_HUMAN,
        verbose_name='展示作者类型',
    )
    actor_id = models.CharField(
        max_length=64,
        blank=True,
        default='',
        verbose_name='展示作者ID快照',
    )
    actor_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        verbose_name='展示作者名称快照',
    )

    # 评论创建时的授权用户。用户被删除后保留评论及身份快照。
    author = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='record_comments',
        verbose_name='授权用户',
    )

    client_request_id = models.CharField(
        max_length=100,
        null=True,
        blank=True,
        verbose_name='客户端幂等请求ID',
    )
    agent_run_id = models.CharField(
        max_length=64,
        blank=True,
        default='',
        db_index=True,
        verbose_name='Agent Run ID',
    )
    session_id = models.CharField(
        max_length=64,
        blank=True,
        default='',
        db_index=True,
        verbose_name='Session ID',
    )

    # 回复关系
    parent = models.ForeignKey(
        'self',
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='replies',
        verbose_name='父评论'
    )

    # 线程状态只以根评论（parent=None）上的值为权威；回复序列化时继承根评论状态。
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.OPEN,
        verbose_name='线程状态',
    )
    resolved_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='record_comment_threads_resolved',
        verbose_name='解决人',
    )
    resolved_at = models.DateTimeField(null=True, blank=True, verbose_name='解决时间')

    # 时间戳
    is_deleted = models.BooleanField(default=False, verbose_name='是否已删除')
    deleted_at = models.DateTimeField(null=True, blank=True, verbose_name='删除时间')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_comment'
        verbose_name = '评论'
        verbose_name_plural = '评论'
        ordering = ['created_at', 'id']
        indexes = [
            models.Index(fields=['record', 'created_at']),
            models.Index(fields=['author', 'created_at']),
            models.Index(
                fields=['record', 'is_deleted', 'created_at', 'id'],
                name='td_comment_record_page_idx',
            ),
            models.Index(
                fields=['record', 'parent', 'status', 'created_at'],
                name='td_comment_thread_status_idx',
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['record', 'author', 'client_request_id'],
                condition=models.Q(
                    author__isnull=False,
                    client_request_id__isnull=False,
                ),
                name='uniq_record_comment_request',
            ),
        ]

    def __str__(self):
        content_preview = self.content[:50] + '...' if len(self.content) > 50 else self.content
        display_name = self.actor_name or self.author_name or '未知用户'
        return f"{display_name}: {content_preview}"


class RecordHistory(models.Model):
    """记录历史模型"""

    ACTION_CHOICES = [
        ('create', '创建'),
        ('update', '更新'),
        ('delete', '删除'),
        ('restore', '恢复'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    record = models.ForeignKey(
        TableRecord,
        on_delete=models.CASCADE,
        related_name='history',
        verbose_name='所属记录'
    )

    # 操作信息
    action = models.CharField(
        max_length=20,
        choices=ACTION_CHOICES,
        verbose_name='操作类型'
    )
    field_changes = models.JSONField(
        default=dict,
        verbose_name='字段变更记录'
    )

    # 操作者
    user = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        verbose_name='操作者',
    )
    window_id = models.CharField(
        max_length=128,
        null=True,
        blank=True,
        db_index=True,
        verbose_name='窗口ID',
        help_text='前端窗口隔离标识（X-Window-Id）',
    )

    # 统一审计字段（对齐 TabDoc/TabSlide）
    editor_type = models.CharField(
        max_length=16, blank=True, default='human',
        verbose_name='编辑者类型',
        help_text='human / agent / system',
    )
    editor_name = models.CharField(
        max_length=128, blank=True, default='',
        verbose_name='编辑者名称',
    )

    # D8 / Wave 1.1：Agent run / session 关联（对齐 ChangeLog.agent_run_id / session_id）
    # 字段类型选择：CharField(64) 与 ChangeLog 完全一致，便于跨表反查（agent_run_ids 在
    # ChangeLog 与 RecordHistory 之间 join / IN 时类型对齐，避免 UUID 字符串显式 cast）。
    # 默认空串而非 NULL：与 ChangeLog 同源（W0-2 audit §3.2.2 推荐），保持
    # ContextVar.get() 返回 None 时统一回填 '' 的语义；NULL/'' 在 PG 索引中等价。
    agent_run_id = models.CharField(
        max_length=64, blank=True, default='',
        db_index=True,
        verbose_name='Agent Run ID',
        help_text='关联 ChangeLog.agent_run_id / get_current_run_id()，支持精确定位本 turn 的 RH（D8）',
    )
    session_id = models.CharField(
        max_length=64, blank=True, default='',
        db_index=True,
        verbose_name='Session ID',
        help_text='关联 ChatSession（QC-05 一致性，D8）',
    )

    # 撤销/重做状态
    is_undone = models.BooleanField(
        default=False,
        verbose_name='是否已撤销',
        help_text='标记该历史记录是否已被撤销'
    )
    undone_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='撤销时间'
    )
    undone_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='undone_histories',
        verbose_name='撤销者',
    )

    # 操作分组（用于批量操作的整体撤销/重做）
    operation_group_id = models.UUIDField(
        null=True,
        blank=True,
        verbose_name='操作组ID',
        help_text='批量操作的组标识，同一批操作共享相同的组ID'
    )

    # TTL 过期（对齐 TabDoc/TabSlide 的版本历史 TTL 策略）
    expired_at = models.DateTimeField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name='过期时间',
        help_text='TTL 过期时间，NULL 表示永不过期（命名版本关联的历史）',
    )

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabdata_history'
        verbose_name = '记录历史'
        verbose_name_plural = '记录历史'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['record', 'created_at'], name='th_rec_cre_idx'),
            models.Index(fields=['user', 'created_at'], name='th_user_cre_idx'),
            models.Index(fields=['action', 'created_at'], name='th_act_cre_idx'),
            models.Index(fields=['record', 'is_undone', 'created_at'], name='th_rec_undo_cre_idx'),
            models.Index(
                fields=['record', 'window_id', 'is_undone', 'created_at'],
                name='th_rec_win_undo_idx',
            ),
            models.Index(fields=['operation_group_id'], name='th_opgrp_idx'),
            # D8：Agent run 反查 + 时间排序复合索引（contributor / fallback 反向回放主路径）
            models.Index(fields=['agent_run_id', 'created_at'], name='th_run_cre_idx'),
        ]

    def __str__(self):
        return f"{self.get_action_display()} - {self.record} by {self.user.get_display_name() if self.user else 'System'}"


class RecordHistoryItem(models.Model):
    """
    字段级历史明细

    将 RecordHistory.field_changes（聚合）拆解为可查询的单字段演进轨迹。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    history = models.ForeignKey(
        RecordHistory,
        on_delete=models.CASCADE,
        related_name='items',
        verbose_name='所属历史',
    )
    record = models.ForeignKey(
        TableRecord,
        on_delete=models.CASCADE,
        related_name='history_items',
        verbose_name='所属记录',
    )
    field_key = models.CharField(
        max_length=255,
        db_index=True,
        verbose_name='字段键',
        help_text='字段ID或系统字段键（如 _deleted）',
    )
    before = models.JSONField(
        null=True,
        blank=True,
        verbose_name='变更前',
    )
    after = models.JSONField(
        null=True,
        blank=True,
        verbose_name='变更后',
    )
    user = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        verbose_name='操作者',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabdata_history_item'
        verbose_name = '记录历史明细'
        verbose_name_plural = '记录历史明细'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['history', 'created_at'], name='thi_hist_cre_idx'),
            models.Index(fields=['record', 'created_at'], name='thi_rec_cre_idx'),
            models.Index(fields=['field_key', 'created_at'], name='thi_fkey_cre_idx'),
            models.Index(fields=['user', 'created_at'], name='thi_user_cre_idx'),
        ]

    def __str__(self):
        return f"{self.field_key}: {self.before} -> {self.after}"


# ── TableNamedVersion: 表格命名版本 ──────────────────────────────────


class TableNamedVersion(models.Model):
    """
    [已废弃 — 逐步迁移到 VersionHistory] 表格命名版本（用户手动保存的版本书签）

    命名版本应统一使用 collab.VersionHistory（is_named=True）管理。
    此表保留是因为可能有用户数据引用，迁移命令：manage.py migrate_named_versions。
    新建的命名版本会同时写入 VH 和此表（双写过渡），待迁移完成后可移除此表的写入。

    原设计：
      通过引用某个 RecordHistory.id 来标记"保存时间点"，
      还原时复用 UndoRedoService.restore_table_to_history()。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    table = models.ForeignKey(
        Table,
        on_delete=models.CASCADE,
        related_name='named_versions',
        verbose_name='所属表格',
    )
    organization_id = models.UUIDField(verbose_name='所属组织')

    # 书签：保存时最新的 RecordHistory ID（还原时使用）
    history_id = models.UUIDField(
        null=True,
        blank=True,
        verbose_name='关联的历史记录 ID',
        help_text='保存版本时表格最新的 RecordHistory.id，还原时传入此 ID',
    )
    # 保存时的时间戳（冗余，便于展示）
    snapshot_at = models.DateTimeField(verbose_name='快照时间')

    # 版本信息
    name = models.CharField(max_length=200, blank=True, default='', verbose_name='版本名称')
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        verbose_name='创建者',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabdata_named_version'
        verbose_name = '表格命名版本'
        verbose_name_plural = '表格命名版本'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['table', 'created_at'], name='tabdata_nv_table_created_idx'),
        ]

    def __str__(self):
        label = self.name or '未命名版本'
        return f"TableNamedVersion {self.id} ({label}) for table {self.table_id}"


# ── TableSnapshot: 表格版本快照 ──────────────────────────────────


class TableSnapshot(models.Model):
    """
    表格全量版本快照（对齐 TabDoc/TabSlide 的 History 方案）

    定期对表数据创建 zlib 压缩的全量快照，支持"一键恢复到某个时间点"。
    快照内容：字段定义 + 记录数据 + 视图配置。

    与 RecordHistory 的区别：
    - RecordHistory: 逐条操作日志（字段级 before/after），用于撤销/重做
    - TableSnapshot: 整表全量快照，用于版本恢复和增量存储

    存储策略:
    - 全量快照: 每 10 次变更或每 30 分钟
    - TTL: Free 7d / Pro 30d / Team 90d
    - 命名版本: 永不过期
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    table = models.ForeignKey(
        'Table',
        on_delete=models.CASCADE,
        related_name='snapshots',
        verbose_name='所属表格',
    )
    organization_id = models.UUIDField(verbose_name='所属组织')
    version = models.IntegerField(
        verbose_name='快照时的版本号',
        help_text='创建快照时 Table.record_version_seq 的值',
    )

    blob = models.BinaryField(verbose_name='zlib 压缩的表数据 JSON')
    blob_size = models.PositiveIntegerField(default=0, verbose_name='blob 字节数')
    record_count = models.PositiveIntegerField(default=0, verbose_name='记录数')
    field_count = models.PositiveIntegerField(default=0, verbose_name='字段数')

    is_snapshot = models.BooleanField(
        default=True, verbose_name='是否全量快照',
    )
    base_snapshot = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='diffs',
        verbose_name='增量 diff 的基版本',
    )

    editor_type = models.CharField(
        max_length=16, blank=True, default='', verbose_name='触发者类型',
    )
    editor_id = models.CharField(
        max_length=64, blank=True, default='', verbose_name='触发者 ID',
    )

    expired_at = models.DateTimeField(
        db_index=True, null=True, blank=True,
        verbose_name='过期时间（NULL=永不过期）',
    )
    is_named = models.BooleanField(default=False, verbose_name='命名版本')
    name = models.CharField(max_length=200, blank=True, default='', verbose_name='版本名称')
    pinned = models.BooleanField(default=False, verbose_name='置顶')

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'tabdata_snapshot'
        verbose_name = '表格版本快照'
        verbose_name_plural = '表格版本快照'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['table', 'created_at'], name='tabdata_snap_tbl_created_idx'),
            models.Index(fields=['table', 'is_snapshot'], name='tabdata_snap_table_snap_idx'),
            models.Index(fields=['table', 'is_named'], name='tabdata_snap_table_named_idx'),
        ]

    def __str__(self):
        if self.is_named:
            label = self.name or '命名版本'
            return f"TableSnapshot {self.id} ({label}) for table {self.table_id}"
        kind = 'snapshot' if self.is_snapshot else 'diff'
        return f"TableSnapshot {self.id} ({kind}) for table {self.table_id}"


# ── NativeTableStatus: 原生列存储迁移状态追踪 ──────────────────────────


class NativeTableStatus(models.Model):
    """
    原生列存储迁移状态追踪

    记录每张表从 JSONField → 原生 PostgreSQL 列的迁移进度。
    配合 native.feature_flags.NativeStoragePhase 控制迁移阶段。

    生命周期：
    1. 表创建时（Phase 1+）：native_table_created = True, columns_synced = True
    2. 历史数据回填后：backfill_completed = True
    3. 切读前校验：consistency_errors = 0
    """

    table = models.OneToOneField(
        Table,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name='native_status',
        verbose_name='所属表格',
    )

    # 原生表状态
    native_table_created = models.BooleanField(
        default=False,
        verbose_name='原生表已创建',
        help_text='对应的 as_xxx.tbl_yyy PostgreSQL 表是否已创建',
    )
    columns_synced = models.BooleanField(
        default=False,
        verbose_name='列已同步',
        help_text='所有活跃字段是否已映射为原生列',
    )

    # 数据回填状态
    backfill_completed = models.BooleanField(
        default=False,
        verbose_name='回填已完成',
        help_text='历史 JSONField 数据是否已全部回填到原生列',
    )
    backfill_record_count = models.IntegerField(
        default=0,
        verbose_name='已回填记录数',
    )
    last_backfill_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='最近回填时间',
    )

    # 一致性校验
    last_consistency_check_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='最近一致性校验时间',
    )
    consistency_errors = models.IntegerField(
        default=0,
        verbose_name='一致性错误数',
        help_text='最近一次校验发现的 JSON ↔ 原生列不一致记录数',
    )

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_native_table_status'
        verbose_name = '原生表迁移状态'
        verbose_name_plural = '原生表迁移状态'

    def __str__(self):
        parts = []
        if self.native_table_created:
            parts.append('table✓')
        if self.columns_synced:
            parts.append('cols✓')
        if self.backfill_completed:
            parts.append(f'backfill✓({self.backfill_record_count})')
        status = ' '.join(parts) if parts else 'pending'
        return f"NativeStatus({self.table_id}): {status}"


# ── LinkRecord: 关联字段 junction table ──────────────────────────────


class LinkRecord(models.Model):
    """
    关联字段 junction table — 所有关系类型的 source of truth。

    无论 OneOne / OneMany / ManyOne / ManyMany，都使用同一张表存储关联关系。
    cell value 中的 JSONB [{id, title}] 是反范化缓存，LinkRecord 是 source of truth。

    架构决策记录（ADR-2026-02）：
    ─────────────────────────────────
    **当前方案**：统一 junction 表（所有 link 字段共享 tabdata_link_record）。

    **差异对比**：
    - 统一表优势：Schema 简洁、无 DDL 管理成本、字段创建/删除无需建/删物理表。
    - per-field 优势：天然隔离、可加 FK 约束保证一致性、大表场景避免 B-Tree 膨胀。
    - 风险点：当单个项目 link_field 数量 > 50 且记录量 > 100w 时，
      复合索引 (link_field, self_record) 可能出现热点扫描。

    **结论**：暂不重构。后续安排压测：
    1. 模拟 50+ link_field × 100w LinkRecord，对比 SELECT/INSERT/DELETE 延迟
    2. 如果 p95 > 50ms，考虑迁移到 per-field junction（通过迁移脚本拆表）
    3. 同步评估 FK 约束对删除记录时的级联开销
    ─────────────────────────────────
    """

    RELATIONSHIP_CHOICES = [
        ('OneOne', '一对一'),
        ('OneMany', '一对多'),
        ('ManyOne', '多对一'),
        ('ManyMany', '多对多'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    link_field = models.ForeignKey(
        TableField,
        on_delete=models.CASCADE,
        related_name='link_records',
        verbose_name='关联字段',
    )
    self_record = models.ForeignKey(
        TableRecord,
        on_delete=models.CASCADE,
        related_name='outgoing_links',
        verbose_name='源记录',
    )
    foreign_record = models.ForeignKey(
        TableRecord,
        on_delete=models.CASCADE,
        related_name='incoming_links',
        verbose_name='目标记录',
    )
    order = models.IntegerField(default=0, verbose_name='排序')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabdata_link_record'
        verbose_name = '关联记录'
        verbose_name_plural = '关联记录'
        unique_together = [['link_field', 'self_record', 'foreign_record']]
        indexes = [
            models.Index(fields=['link_field', 'self_record']),
            models.Index(fields=['link_field', 'foreign_record']),
        ]

    def __str__(self):
        return f"Link({self.link_field_id}): {self.self_record_id} → {self.foreign_record_id}"


# ── LinkRelation / LinkEdge: 统一关系定义 + 边存储 ──────────────────


class LinkRelation(models.Model):
    """
    一条关联关系的领域定义（一份定义，双侧字段共享）。

    与 legacy `LinkRecord`（按字段各存一份边）并存；本期只落地模型与 gateway，
    读写真源仍是 `LinkRecord`，切读在后续 storage phase 完成。

    双向关系只保留一行：host_field + symmetric_field。
    单向关系 symmetric_field 为空。
    """

    RELATIONSHIP_CHOICES = LinkRecord.RELATIONSHIP_CHOICES

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.UUIDField(db_index=True, verbose_name='所属组织')
    host_table = models.ForeignKey(
        Table,
        on_delete=models.CASCADE,
        related_name='hosted_link_relations',
        verbose_name='宿主表',
    )
    foreign_table = models.ForeignKey(
        Table,
        on_delete=models.CASCADE,
        related_name='foreign_link_relations',
        verbose_name='目标表',
    )
    host_field = models.OneToOneField(
        TableField,
        on_delete=models.CASCADE,
        related_name='link_relation_as_host',
        verbose_name='宿主关联字段',
    )
    symmetric_field = models.OneToOneField(
        TableField,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='link_relation_as_symmetric',
        verbose_name='对称关联字段',
    )
    # 宿主侧视角的基数（对称侧由 SYMMETRIC_RELATIONSHIP_MAP 推导）
    host_relationship = models.CharField(
        max_length=16,
        choices=RELATIONSHIP_CHOICES,
        default='ManyOne',
        verbose_name='宿主侧关系基数',
    )
    is_one_way = models.BooleanField(default=False, verbose_name='是否单向')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_link_relation'
        verbose_name = '关联关系定义'
        verbose_name_plural = '关联关系定义'
        indexes = [
            models.Index(
                fields=['organization_id', 'host_table'],
                name='tabdata_lin_organiz_3c8a1d_idx',
            ),
            models.Index(
                fields=['organization_id', 'foreign_table'],
                name='tabdata_lin_organiz_9f2b4e_idx',
            ),
        ]
        constraints = [
            models.CheckConstraint(
                check=(
                    Q(is_one_way=True, symmetric_field__isnull=True)
                    | Q(is_one_way=False, symmetric_field__isnull=False)
                ),
                name='tabdata_lrel_oway_sym_chk',
            ),
        ]

    def __str__(self):
        direction = 'one-way' if self.is_one_way else 'two-way'
        return (
            f"LinkRelation({self.id}): {self.host_table_id}→{self.foreign_table_id} "
            f"{self.host_relationship}/{direction}"
        )


class LinkEdge(models.Model):
    """
    统一关系边上的一条有向边（一份边，双侧顺序）。

    唯一约束：(relation, host_record, foreign_record)。
    host_order / foreign_order 分别服务两侧单元格展示顺序。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    relation = models.ForeignKey(
        LinkRelation,
        on_delete=models.CASCADE,
        related_name='edges',
        verbose_name='所属关系',
    )
    host_record = models.ForeignKey(
        TableRecord,
        on_delete=models.CASCADE,
        related_name='hosted_link_edges',
        verbose_name='宿主记录',
    )
    foreign_record = models.ForeignKey(
        TableRecord,
        on_delete=models.CASCADE,
        related_name='foreign_link_edges',
        verbose_name='目标记录',
    )
    host_order = models.IntegerField(default=0, verbose_name='宿主侧顺序')
    foreign_order = models.IntegerField(default=0, verbose_name='目标侧顺序')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabdata_link_edge'
        verbose_name = '关联边'
        verbose_name_plural = '关联边'
        constraints = [
            models.UniqueConstraint(
                fields=['relation', 'host_record', 'foreign_record'],
                name='tabdata_ledge_uniq_triple',
            ),
        ]
        indexes = [
            models.Index(
                fields=['relation', 'host_record'],
                name='tabdata_ledge_rel_host_idx',
            ),
            models.Index(
                fields=['relation', 'foreign_record'],
                name='tabdata_ledge_rel_fgn_idx',
            ),
        ]

    def __str__(self):
        return (
            f"LinkEdge({self.relation_id}): "
            f"{self.host_record_id}→{self.foreign_record_id}"
        )


# ── FieldReference: 关联标题依赖 ──────────────────────────────────


class FieldReference(models.Model):
    """
    关联字段展示值的依赖关系。

    from_field → to_field 表示 "to_field 依赖 from_field"。
    当前用于记录 Link 字段依赖的目标展示字段。

    用于：
    - 查询展示字段变化后需要刷新标题的 Link 字段
    - 循环依赖检测
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    from_field = models.ForeignKey(
        TableField,
        on_delete=models.CASCADE,
        related_name='outgoing_refs',
        verbose_name='被依赖字段',
    )
    to_field = models.ForeignKey(
        TableField,
        on_delete=models.CASCADE,
        related_name='incoming_refs',
        verbose_name='依赖方字段',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabdata_field_reference'
        verbose_name = '字段依赖'
        verbose_name_plural = '字段依赖'
        unique_together = [['from_field', 'to_field']]
        indexes = [
            models.Index(fields=['from_field']),
            models.Index(fields=['to_field']),
        ]

    def __str__(self):
        return f"Ref: {self.from_field_id} → {self.to_field_id}"


class TableAdminActionLog(models.Model):
    """后台治理动作日志。"""

    ACTION_TYPE_CHOICES = [
        ('batch_archive', '批量归档'),
        ('batch_restore', '批量恢复'),
        ('batch_trash', '批量逻辑删除'),
        ('batch_untrash', '批量回收站恢复'),
        ('batch_search_index_repair', '批量索引修复'),
        ('single_archive', '单表归档'),
        ('single_restore', '单表恢复'),
        ('single_trash', '单表逻辑删除'),
        ('single_untrash', '单表回收站恢复'),
        ('single_search_index_repair', '单表索引修复'),
        ('delete_table', '删除表格'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    action_type = models.CharField(
        max_length=64,
        choices=ACTION_TYPE_CHOICES,
        db_index=True,
        verbose_name='动作类型',
    )

    operator_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name='操作人 ID',
    )
    operator_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        verbose_name='操作人展示名',
    )

    target_table_ids = models.JSONField(
        default=list,
        verbose_name='目标表 ID 列表',
        help_text='治理动作影响的表格 ID 列表',
    )
    target_table_ids_text = models.TextField(
        blank=True,
        default='',
        verbose_name='目标表检索文本',
        help_text='格式: |table_id_1|table_id_2|，用于高性能模糊检索',
    )

    requested_count = models.PositiveIntegerField(default=0, verbose_name='请求总数')
    updated_count = models.PositiveIntegerField(default=0, verbose_name='成功处理数')
    skipped_count = models.PositiveIntegerField(default=0, verbose_name='跳过数')
    dry_run = models.BooleanField(default=False, verbose_name='是否 dry-run')

    success = models.BooleanField(default=True, db_index=True, verbose_name='是否成功')
    result_message = models.TextField(blank=True, default='', verbose_name='结果信息')
    error_message = models.TextField(blank=True, default='', verbose_name='错误信息')

    request_payload = models.JSONField(default=dict, verbose_name='请求快照')
    result_payload = models.JSONField(default=dict, verbose_name='结果快照')

    trace_id = models.CharField(
        max_length=128,
        blank=True,
        default='',
        db_index=True,
        verbose_name='链路追踪 ID',
    )
    ip_address = models.GenericIPAddressField(
        null=True,
        blank=True,
        verbose_name='IP 地址',
    )
    user_agent = models.TextField(blank=True, default='', verbose_name='User-Agent')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabdata_admin_action_log'
        verbose_name = '表格后台治理动作日志'
        verbose_name_plural = '表格后台治理动作日志'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['action_type', 'created_at']),
            models.Index(fields=['operator_id', 'created_at']),
            models.Index(fields=['success', 'created_at']),
            models.Index(fields=['dry_run', 'created_at']),
        ]

    def __str__(self):
        status = 'success' if self.success else 'failed'
        return f"{self.action_type} ({status}) @ {self.created_at.isoformat()}"


class TablePermission(ResourcePermission):
    """表格资源级权限（继承 ResourcePermission 统一基类）"""

    table = models.ForeignKey(Table, on_delete=models.CASCADE, related_name='permissions')

    class Meta(ResourcePermission.Meta):
        db_table = 'tabdata_table_permission'
        verbose_name = '表格权限'
        verbose_name_plural = '表格权限'
        constraints = [
            models.UniqueConstraint(
                fields=['table', 'subject_type', 'subject_id'],
                name='tabdata_perm_unique_subject',
            ),
        ]
        indexes = [
            models.Index(fields=['table', 'is_active'], name='tabdata_perm_tbl_active_idx'),
            models.Index(fields=['subject_type', 'subject_id'], name='tabdata_perm_subject_idx'),
        ]

    def __str__(self):
        return f"{self.subject_type}:{self.subject_id}={self.permission} on table {self.table_id}"


# ── 拆分模型统一注册入口 ─────────────────────────────────────
#
# Django 只会自动导入 apps.tabdata.models。
# 所有拆分在 models_*.py 的模型都必须在这里显式导入，
# 否则模型注册 / makemigrations 可能依赖 API 路由等副作用 import，
# 导致“代码里有模型，但迁移里没有”的结构漂移。
from apps.tabdata.models_api_log import ApiCallLog, ApiUsageSummary  # noqa: E402, F401
from apps.tabdata.models_connector import DataConnector, ConnectorTableMapping  # noqa: E402, F401
from apps.tabdata.models_db_connection import DbReadOnlyConnection  # noqa: E402, F401
from apps.tabdata.models_rls import RowPolicy  # noqa: E402, F401
from apps.tabdata.models_token import TableApiToken  # noqa: E402, F401
from apps.tabdata.models_webhook import TableWebhook  # noqa: E402, F401
