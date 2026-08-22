"""
OSS对象存储服务数据模型
"""

import uuid
import hashlib
from django.db import models, transaction
from django.utils import timezone
from django.core.validators import MinValueValidator, MaxValueValidator


class OSSConfig(models.Model):
    """OSS配置模型"""

    ACCESS_MODE_CHOICES = [
        ('private', '私有'),
        ('public-read', '公共读'),
        ('public-read-write', '公共读写'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bucket_name = models.CharField(max_length=100, verbose_name='存储桶名称', db_index=True)
    endpoint = models.CharField(max_length=200, verbose_name='访问端点')
    internal_endpoint = models.CharField(max_length=200, verbose_name='内网端点', blank=True)
    region = models.CharField(max_length=50, verbose_name='地域')
    access_mode = models.CharField(
        max_length=20,
        choices=ACCESS_MODE_CHOICES,
        default='private',
        verbose_name='访问模式'
    )
    cdn_domain = models.CharField(max_length=200, verbose_name='CDN域名', blank=True)
    is_default = models.BooleanField(default=False, verbose_name='是否默认配置')
    is_active = models.BooleanField(default=True, verbose_name='是否启用')
    description = models.TextField(verbose_name='描述', blank=True)
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_oss_config'
        verbose_name = 'OSS配置'
        verbose_name_plural = 'OSS配置'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['bucket_name']),
            models.Index(fields=['is_default', 'is_active']),
        ]

    def __str__(self):
        return f"{self.bucket_name} ({self.region})"

    def save(self, *args, **kwargs):
        # 确保只有一个默认配置
        if self.is_default:
            OSSConfig.objects.filter(is_default=True).exclude(id=self.id).update(is_default=False)
        super().save(*args, **kwargs)


class FileRecord(models.Model):
    """文件记录模型"""

    STATUS_CHOICES = [
        ('uploading', '上传中'),
        ('completed', '已完成'),
        ('failed', '上传失败'),
        ('deleted', '已删除'),
    ]

    FILE_TYPE_CHOICES = [
        ('image', '图片'),
        ('document', '文档'),
        ('video', '视频'),
        ('audio', '音频'),
        ('archive', '压缩包'),
        ('other', '其他'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    file_name = models.CharField(max_length=255, verbose_name='原始文件名', db_index=True)
    file_key = models.CharField(max_length=500, verbose_name='OSS文件键', db_index=True)
    file_key_hash = models.CharField(max_length=64, verbose_name='OSS文件键哈希', unique=True, db_index=True)
    file_path = models.CharField(max_length=500, verbose_name='文件路径')
    file_size = models.BigIntegerField(verbose_name='文件大小(字节)', validators=[MinValueValidator(0)])
    file_type = models.CharField(
        max_length=20,
        choices=FILE_TYPE_CHOICES,
        default='other',
        verbose_name='文件类型'
    )
    mime_type = models.CharField(max_length=100, verbose_name='MIME类型')
    file_extension = models.CharField(max_length=10, verbose_name='文件扩展名')
    file_hash = models.CharField(max_length=64, verbose_name='文件MD5哈希', db_index=True)
    hash_algorithm = models.CharField(
        max_length=32,
        blank=True,
        default='',
        db_index=True,
        verbose_name='哈希算法',
        help_text='md5 / sha256 / sha256-sampled，空=未知(旧数据)',
    )

    # 存储信息
    bucket_name = models.CharField(max_length=100, verbose_name='存储桶名称', db_index=True)
    oss_config = models.ForeignKey(
        OSSConfig,
        on_delete=models.SET_NULL,
        null=True,
        verbose_name='OSS配置'
    )

    # 访问信息
    access_url = models.URLField(max_length=500, verbose_name='访问URL', blank=True)
    cdn_url = models.URLField(max_length=500, verbose_name='CDN URL', blank=True)
    is_public = models.BooleanField(default=False, verbose_name='是否公开访问')

    # 上传信息
    upload_user = models.CharField(max_length=100, verbose_name='上传用户', blank=True)
    upload_source = models.CharField(max_length=50, verbose_name='上传来源', blank=True)
    upload_ip = models.GenericIPAddressField(verbose_name='上传IP', blank=True, null=True)

    # 计费归属
    organization_id = models.CharField(
        max_length=100, blank=True, default='', db_index=True,
        verbose_name='组织ID',
        help_text='文件归属的组织，用于存储计量',
    )

    # 状态信息
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='uploading',
        verbose_name='状态',
        db_index=True
    )

    # 统计信息
    download_count = models.PositiveIntegerField(default=0, verbose_name='下载次数')
    view_count = models.PositiveIntegerField(default=0, verbose_name='查看次数')
    ref_count = models.PositiveIntegerField(default=0, verbose_name='引用计数')

    # 元数据
    tags = models.JSONField(default=list, verbose_name='文件标签')
    metadata = models.JSONField(default=dict, verbose_name='文件元数据')

    # 时间信息
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间', db_index=True)
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')
    deleted_at = models.DateTimeField(null=True, blank=True, verbose_name='删除时间')

    class Meta:
        db_table = 'services_oss_file_record'
        verbose_name = '文件记录'
        verbose_name_plural = '文件记录'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['file_name', 'created_at']),
            models.Index(fields=['file_type', 'created_at']),
            models.Index(fields=['bucket_name', 'created_at']),
            models.Index(fields=['upload_user', 'created_at']),
            models.Index(fields=['upload_user', 'status', 'created_at']),
            models.Index(fields=['status', 'created_at']),
            models.Index(fields=['file_hash']),
            # P0 IDOR 修复（PRD-presign-organization-isolation-fix.md）：秒传查询
            # 现在要按 (file_hash, organization_id, status) 三列过滤，原 file_hash
            # 单列索引在 organization 维度下选择率不足，补复合索引保证查询走索引。
            # 原 file_hash 单列索引保留 — 跨 organization 统计 / 文件 hash 去重观察等场景仍需。
            models.Index(
                fields=['file_hash', 'organization_id', 'status'],
                name='oss_filerec_hash_wt_status_idx',
            ),
        ]

    def __str__(self):
        return f"{self.file_name} ({self.get_file_size_display()})"

    @staticmethod
    def _calc_file_key_hash(file_key: str) -> str:
        return hashlib.sha256(file_key.encode('utf-8')).hexdigest()

    def save(self, *args, **kwargs):
        if self.file_key:
            new_hash = self._calc_file_key_hash(self.file_key)
            if self.file_key_hash != new_hash:
                self.file_key_hash = new_hash
                update_fields = kwargs.get('update_fields')
                if update_fields is not None:
                    kwargs['update_fields'] = list(set(update_fields) | {'file_key_hash'})
        super().save(*args, **kwargs)

    def get_file_size_display(self):
        """获取文件大小的可读格式"""
        size = self.file_size
        for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
            if size < 1024.0:
                return f"{size:.1f} {unit}"
            size /= 1024.0
        return f"{size:.1f} PB"

    def mark_as_completed(self, access_url: str = '', cdn_url: str = ''):
        """标记为上传完成"""
        self.status = 'completed'
        if access_url:
            self.access_url = access_url
        if cdn_url:
            self.cdn_url = cdn_url
        self.save(update_fields=['status', 'access_url', 'cdn_url'])

    def mark_as_failed(self, error_message: str = ''):
        """标记为上传失败"""
        self.status = 'failed'
        if error_message:
            self.metadata['error_message'] = error_message
        self.save(update_fields=['status', 'metadata'])

    def soft_delete(self):
        """软删除文件记录"""
        self.status = 'deleted'
        self.deleted_at = timezone.now()
        self.save(update_fields=['status', 'deleted_at'])

    def increment_download_count(self):
        """增加下载次数（原子 F() 操作，避免 read-modify-write 竞态）"""
        FileRecord.objects.filter(id=self.id).update(
            download_count=models.F('download_count') + 1
        )
        self.refresh_from_db(fields=['download_count'])

    def increment_view_count(self):
        """增加查看次数（原子 F() 操作，避免 read-modify-write 竞态）"""
        FileRecord.objects.filter(id=self.id).update(
            view_count=models.F('view_count') + 1
        )
        self.refresh_from_db(fields=['view_count'])

    def to_response_dict(self) -> dict:
        """统一的 API 响应序列化，各接口复用。"""
        access_url = self.access_url
        cdn_url = self.cdn_url
        if self.is_public:
            try:
                from apps.services.oss.services.public_assets import build_public_asset_url
                public_url = build_public_asset_url(self.file_key)
                access_url = public_url or access_url
                cdn_url = public_url or cdn_url
            except Exception:
                pass
        return {
            'file_id': str(self.id),
            'file_name': self.file_name,
            'file_key': self.file_key,
            'file_path': self.file_path,
            'file_size': self.file_size,
            'file_type': self.file_type,
            'mime_type': self.mime_type,
            'file_extension': self.file_extension,
            'file_hash': self.file_hash,
            'access_url': access_url,
            'cdn_url': cdn_url,
            'is_public': self.is_public,
            'download_count': self.download_count,
            'view_count': self.view_count,
            'tags': self.tags,
            'metadata': self.metadata,
            'status': self.status,
            'upload_user': self.upload_user,
            'upload_source': self.upload_source,
            'created_at': self.created_at,
            'updated_at': self.updated_at,
        }


class UploadTask(models.Model):
    """上传任务模型"""

    TASK_TYPE_CHOICES = [
        ('single', '单文件上传'),
        ('batch', '批量上传'),
        ('chunk', '分片上传'),
    ]

    STATUS_CHOICES = [
        ('pending', '等待中'),
        ('processing', '处理中'),
        ('completed', '已完成'),
        ('failed', '失败'),
        ('cancelled', '已取消'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task_name = models.CharField(max_length=200, verbose_name='任务名称')
    task_type = models.CharField(
        max_length=20,
        choices=TASK_TYPE_CHOICES,
        default='single',
        verbose_name='任务类型'
    )

    # 任务统计
    total_files = models.PositiveIntegerField(default=0, verbose_name='总文件数')
    completed_files = models.PositiveIntegerField(default=0, verbose_name='已完成文件数')
    failed_files = models.PositiveIntegerField(default=0, verbose_name='失败文件数')
    total_size = models.BigIntegerField(default=0, verbose_name='总大小(字节)')
    uploaded_size = models.BigIntegerField(default=0, verbose_name='已上传大小(字节)')

    # 任务状态
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='任务状态',
        db_index=True
    )
    progress = models.FloatField(
        default=0.0,
        validators=[MinValueValidator(0.0), MaxValueValidator(100.0)],
        verbose_name='进度百分比'
    )

    # 错误信息
    error_message = models.TextField(verbose_name='错误信息', blank=True)

    # 结果数据
    result_data = models.JSONField(default=dict, verbose_name='结果数据')

    # 关联文件
    files = models.ManyToManyField(FileRecord, verbose_name='关联文件', blank=True)

    # 用户信息
    created_by = models.CharField(max_length=100, verbose_name='创建用户', blank=True)
    organization_id = models.CharField(
        max_length=100,
        blank=True,
        default='',
        db_index=True,
        verbose_name='组织ID',
        help_text='上传任务归属的组织，用于清理和后台筛选',
    )

    # 时间信息
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间', db_index=True)
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')
    started_at = models.DateTimeField(null=True, blank=True, verbose_name='开始时间')
    completed_at = models.DateTimeField(null=True, blank=True, verbose_name='完成时间')

    class Meta:
        db_table = 'services_oss_upload_task'
        verbose_name = '上传任务'
        verbose_name_plural = '上传任务'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['task_type', 'status']),
            models.Index(fields=['created_by', 'created_at']),
        ]

    def __str__(self):
        return f"{self.task_name} ({self.get_status_display()})"

    def update_progress(self):
        """更新任务进度（从数据库刷新最新计数后原子写入）。"""
        self.refresh_from_db(fields=['total_files', 'completed_files'])
        if self.total_files > 0:
            self.progress = round((self.completed_files / self.total_files) * 100, 2)
        else:
            self.progress = 0.0
        UploadTask.objects.filter(id=self.id).update(progress=self.progress)

    def mark_as_started(self):
        """标记任务开始"""
        self.status = 'processing'
        self.started_at = timezone.now()
        self.save(update_fields=['status', 'started_at'])

    def mark_as_completed(self):
        """标记任务完成"""
        self.status = 'completed'
        self.progress = 100.0
        self.completed_at = timezone.now()
        self.save(update_fields=['status', 'progress', 'completed_at'])

    def mark_as_failed(self, error_message: str):
        """标记任务失败"""
        self.status = 'failed'
        self.error_message = error_message
        self.completed_at = timezone.now()
        self.save(update_fields=['status', 'error_message', 'completed_at'])

    def mark_as_cancelled(self):
        """标记任务取消"""
        self.status = 'cancelled'
        self.completed_at = timezone.now()
        self.save(update_fields=['status', 'completed_at'])


class FileStatistics(models.Model):
    """文件统计模型 — 已废弃，不再写入数据。由 BillingUsageDaily + Phase 1 实时聚合替代。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    date = models.DateField(verbose_name='统计日期', db_index=True)
    bucket_name = models.CharField(max_length=100, verbose_name='存储桶名称', db_index=True)

    # 文件统计
    total_files = models.PositiveIntegerField(default=0, verbose_name='总文件数')
    total_size = models.BigIntegerField(default=0, verbose_name='总大小(字节)')

    # 操作统计
    upload_count = models.PositiveIntegerField(default=0, verbose_name='上传次数')
    download_count = models.PositiveIntegerField(default=0, verbose_name='下载次数')
    delete_count = models.PositiveIntegerField(default=0, verbose_name='删除次数')
    view_count = models.PositiveIntegerField(default=0, verbose_name='查看次数')

    # 流量统计
    traffic_upload = models.BigIntegerField(default=0, verbose_name='上传流量(字节)')
    traffic_download = models.BigIntegerField(default=0, verbose_name='下载流量(字节)')

    # 文件类型统计
    image_count = models.PositiveIntegerField(default=0, verbose_name='图片文件数')
    document_count = models.PositiveIntegerField(default=0, verbose_name='文档文件数')
    video_count = models.PositiveIntegerField(default=0, verbose_name='视频文件数')
    audio_count = models.PositiveIntegerField(default=0, verbose_name='音频文件数')
    archive_count = models.PositiveIntegerField(default=0, verbose_name='压缩包文件数')
    other_count = models.PositiveIntegerField(default=0, verbose_name='其他文件数')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_oss_file_statistics'
        verbose_name = '文件统计'
        verbose_name_plural = '文件统计'
        ordering = ['-date']
        unique_together = ['date', 'bucket_name']
        indexes = [
            models.Index(fields=['date', 'bucket_name']),
        ]

    def __str__(self):
        return f"{self.date} - {self.bucket_name}"

    def get_total_size_display(self):
        """获取总大小的可读格式"""
        size = self.total_size
        for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
            if size < 1024.0:
                return f"{size:.1f} {unit}"
            size /= 1024.0
        return f"{size:.1f} PB"


class OSSAdminActionLog(models.Model):
    """OSS 后台治理审计日志。"""

    ACTION_TYPE_CHOICES = [
        ('batch_delete', '批量删除'),
        ('repair_organization_scope', '修复 organization 归属'),
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
    organization_id = models.CharField(
        max_length=100,
        blank=True,
        default='',
        db_index=True,
        verbose_name='主组织ID',
        help_text='当治理动作只涉及单个组织时写入；跨组织动作留空',
    )
    organization_ids = models.JSONField(
        default=list,
        verbose_name='影响的组织列表',
        help_text='治理动作影响的组织 ID 列表',
    )
    organization_ids_text = models.TextField(
        blank=True,
        default='',
        verbose_name='影响组织检索文本',
        help_text='格式: |organization_id_1|organization_id_2|，用于高性能模糊检索',
    )

    target_file_ids = models.JSONField(
        default=list,
        verbose_name='目标文件 ID 列表',
        help_text='治理动作影响的文件 ID 列表',
    )
    target_file_ids_text = models.TextField(
        blank=True,
        default='',
        verbose_name='目标文件检索文本',
        help_text='格式: |file_id_1|file_id_2|，用于高性能模糊检索',
    )

    requested_count = models.PositiveIntegerField(default=0, verbose_name='请求总数')
    processed_count = models.PositiveIntegerField(default=0, verbose_name='处理数')
    deleted_count = models.PositiveIntegerField(default=0, verbose_name='删除数')
    skipped_count = models.PositiveIntegerField(default=0, verbose_name='跳过数')
    dry_run = models.BooleanField(default=False, db_index=True, verbose_name='是否 dry-run')

    success = models.BooleanField(default=True, db_index=True, verbose_name='是否成功')
    message = models.TextField(blank=True, default='', verbose_name='结果信息')
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

    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'services_oss_admin_action_log'
        verbose_name = 'OSS 后台治理动作日志'
        verbose_name_plural = 'OSS 后台治理动作日志'
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


class FileUsage(models.Model):
    """
    文件使用记录 — 跨模块通用引用追踪。

    每当一个业务实体（消息、记录、文档、项目等）引用了某个 OSS 文件，
    就创建一条 FileUsage。删除业务实体时标记 is_active=False 并
    递减 FileRecord.ref_count。当 ref_count 归零后，定时任务
    会在宽限期后清理物理文件。
    """

    MODULE_CHOICES = [
        ('chat', 'Chat 对话'),
        ('tabdata', 'TabData 表格'),
        ('tabdoc', 'TabDoc 文档'),
        ('tabdesign', 'TabDesign 设计'),
        ('tabslide', 'TabSlide 幻灯片'),
        ('tabmemo', 'TabMemo 碎片'),
        ('tabchat', 'TabChat 即时通讯'),
        ('tabcode', 'TabCode 代码'),
        ('updater', 'Updater 桌面更新'),
        ('media_generation', '媒体生成'),
        ('crawl', 'Crawl 采集'),
        ('tabfiles', 'TabFiles 文件管理'),
        ('package_registry', 'Package Registry 包管理'),
        ('other', '其他'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    file_record = models.ForeignKey(
        FileRecord,
        on_delete=models.CASCADE,
        related_name='usages',
        verbose_name='关联文件',
    )
    user_id = models.UUIDField(db_index=True, verbose_name='用户 ID')
    module = models.CharField(max_length=32, choices=MODULE_CHOICES, db_index=True, verbose_name='来源模块')
    context_type = models.CharField(max_length=64, blank=True, default='', verbose_name='上下文类型')
    context_id = models.CharField(max_length=128, blank=True, default='', db_index=True, verbose_name='上下文 ID')
    is_active = models.BooleanField(default=True, db_index=True, verbose_name='是否有效')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    deactivated_at = models.DateTimeField(null=True, blank=True, verbose_name='失效时间')

    class Meta:
        db_table = 'services_oss_file_usage'
        verbose_name = '文件使用记录'
        verbose_name_plural = '文件使用记录'
        ordering = ['-created_at']
        unique_together = ['file_record', 'module', 'context_type', 'context_id']
        indexes = [
            models.Index(fields=['file_record', 'is_active']),
            models.Index(fields=['module', 'context_id', 'is_active']),
            models.Index(fields=['user_id', 'module']),
        ]

    def __str__(self):
        return f"{self.module}/{self.context_type}:{self.context_id} -> {self.file_record_id}"

    def deactivate(self):
        """标记引用失效，并递减 FileRecord.ref_count（原子操作）。"""
        if not self.is_active:
            return
        with transaction.atomic():
            locked = (
                FileUsage.objects
                .select_for_update()
                .filter(id=self.id, is_active=True)
                .first()
            )
            if not locked:
                return
            locked.is_active = False
            locked.deactivated_at = timezone.now()
            locked.save(update_fields=['is_active', 'deactivated_at'])

            FileRecord.objects.filter(
                id=locked.file_record_id, ref_count__gt=0,
            ).update(ref_count=models.F('ref_count') - 1)

            self.is_active = False
            self.deactivated_at = locked.deactivated_at

            wt_id = getattr(locked.file_record, 'organization_id', None) if locked.file_record_id else None
            if wt_id:
                _wt = str(wt_id)
                def _do_invalidate(w=_wt):
                    from apps.services.oss.services.analytics_cache import invalidate_safe
                    invalidate_safe(w)
                transaction.on_commit(_do_invalidate)

    @classmethod
    def add_usage(cls, file_record: FileRecord, user_id, module: str,
                  context_type: str = '', context_id: str = '') -> 'FileUsage':
        """创建引用并递增 ref_count（幂等：相同 unique key 不重复创建）。"""
        should_invalidate = False
        with transaction.atomic():
            usage, created = cls.objects.get_or_create(
                file_record=file_record,
                module=module,
                context_type=context_type,
                context_id=context_id,
                defaults={
                    'user_id': user_id,
                    'is_active': True,
                },
            )
            if created:
                FileRecord.objects.filter(id=file_record.id).update(
                    ref_count=models.F('ref_count') + 1,
                )
                should_invalidate = True
            elif not usage.is_active:
                usage = cls.objects.select_for_update().get(id=usage.id)
                if not usage.is_active:
                    usage.is_active = True
                    usage.deactivated_at = None
                    usage.user_id = user_id
                    usage.save(update_fields=['is_active', 'deactivated_at', 'user_id'])
                    FileRecord.objects.filter(id=file_record.id).update(
                        ref_count=models.F('ref_count') + 1,
                    )
                    should_invalidate = True
            if should_invalidate:
                wt_id = getattr(file_record, 'organization_id', None)
                if wt_id:
                    _wt = str(wt_id)
                    def _do_invalidate(w=_wt):
                        from apps.services.oss.services.analytics_cache import invalidate_safe
                        invalidate_safe(w)
                    transaction.on_commit(_do_invalidate)
        return usage
