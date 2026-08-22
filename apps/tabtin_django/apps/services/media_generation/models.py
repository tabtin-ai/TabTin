"""
媒体生成服务数据模型
"""

import uuid
from django.db import models
from django.utils import timezone
from django.core.validators import MinValueValidator, MaxValueValidator
from decimal import Decimal


class MediaProvider(models.Model):
    """媒体生成服务提供商配置"""

    PROVIDER_CHOICES = [
        ('dashscope', '阿里云百炼 DashScope'),
        ('fal', 'fal.ai'),
        ('replicate', 'Replicate'),
    ]

    SCOPE_CHOICES = [
        ('global', '全局'),
        ('organization', '组织'),
        ('user', '个人'),
    ]

    RUNTIME_STATUS_CHOICES = [
        ('unknown', '未知'),
        ('healthy', '健康'),
        ('degraded', '降级'),
        ('unhealthy', '异常'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=50, choices=PROVIDER_CHOICES, verbose_name='提供商名称')
    provider_key = models.CharField(
        max_length=100, blank=True, default='',
        verbose_name='渠道标识',
        help_text='同一提供商的不同渠道标识'
    )
    display_name = models.CharField(max_length=100, verbose_name='显示名称')
    base_url = models.URLField(verbose_name='API基础URL')
    api_key = models.CharField(max_length=500, verbose_name='API密钥')

    # 作用域
    user_id = models.CharField(max_length=36, blank=True, null=True, verbose_name='用户ID')
    scope = models.CharField(max_length=20, choices=SCOPE_CHOICES, default='global', verbose_name='配置范围')
    organization_id = models.CharField(max_length=100, blank=True, null=True, verbose_name='组织ID')

    # 状态管理
    is_active = models.BooleanField(default=True, verbose_name='是否启用')
    priority = models.IntegerField(default=0, verbose_name='优先级')
    rate_limit = models.IntegerField(default=30, verbose_name='每分钟请求限制')
    runtime_status = models.CharField(
        max_length=20, choices=RUNTIME_STATUS_CHOICES, default='unknown', verbose_name='运行状态'
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_media_provider'
        verbose_name = '媒体生成提供商'
        verbose_name_plural = '媒体生成提供商'
        ordering = ['-priority', '-created_at']
        unique_together = [['scope', 'organization_id', 'user_id', 'provider_key']]
        indexes = [
            models.Index(fields=['name', 'is_active'], name='mg_provider_name_active_idx'),
            models.Index(fields=['scope', 'is_active'], name='mg_provider_scope_active_idx'),
        ]

    def __str__(self):
        if self.scope == 'user' and self.user_id:
            return f"{self.display_name} (用户: {self.user_id[:8]}...)"
        if self.scope == 'organization' and self.organization_id:
            return f"{self.display_name} (工作空间: {self.organization_id[:8]}...)"
        return f"{self.display_name} (全局)"

    def save(self, *args, **kwargs):
        if not self.provider_key:
            self.provider_key = self.name
        if self.scope == 'global':
            if self.user_id:
                self.scope = 'user'
            elif self.organization_id:
                self.scope = 'organization'
        super().save(*args, **kwargs)


class MediaModel(models.Model):
    """媒体生成模型配置"""

    TASK_TYPE_CHOICES = [
        ('text2image', '文生图'),
        ('image2image', '图生图'),
        ('image_edit', '图像编辑'),
        ('text2video', '文生视频'),
        ('image2video', '图生视频'),
        ('video_edit', '视频编辑'),
    ]

    BILLING_TYPE_CHOICES = [
        ('image_count', '按图片数量'),
        ('video_seconds', '按视频秒数'),
        ('resolution_seconds', '按分辨率×秒数'),
        ('request', '按请求次数'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider = models.ForeignKey(MediaProvider, on_delete=models.CASCADE, verbose_name='服务提供商')
    model_name = models.CharField(max_length=100, verbose_name='模型名称', help_text='API 调用时使用的模型标识')
    display_name = models.CharField(max_length=100, verbose_name='显示名称')
    description = models.TextField(blank=True, verbose_name='模型描述')
    task_type = models.CharField(max_length=30, choices=TASK_TYPE_CHOICES, verbose_name='任务类型')

    # 能力描述
    supported_sizes = models.JSONField(
        default=list, blank=True,
        verbose_name='支持的分辨率',
        help_text='如 ["1024*1024", "1280*720"]'
    )
    supported_durations = models.JSONField(
        default=list, blank=True,
        verbose_name='支持的时长(秒)',
        help_text='视频模型专用，如 [5, 10]'
    )
    max_prompt_length = models.IntegerField(default=500, verbose_name='最大提示词长度')
    supports_negative_prompt = models.BooleanField(default=False, verbose_name='支持反向提示词')
    supports_prompt_extend = models.BooleanField(default=True, verbose_name='支持提示词智能改写')
    supports_audio = models.BooleanField(default=False, verbose_name='支持音频输入')
    supports_multi_shot = models.BooleanField(default=False, verbose_name='支持多镜头叙事')

    # 计费
    billing_type = models.CharField(max_length=30, choices=BILLING_TYPE_CHOICES, default='image_count', verbose_name='计费类型')
    price_per_unit = models.DecimalField(max_digits=10, decimal_places=4, default=Decimal('0'), verbose_name='单价')
    price_unit = models.CharField(max_length=50, blank=True, default='', verbose_name='计费单位', help_text='如 元/张, 元/秒')
    free_quota = models.IntegerField(default=0, verbose_name='免费额度')

    is_active = models.BooleanField(default=True, verbose_name='是否启用')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_media_model'
        verbose_name = '媒体生成模型'
        verbose_name_plural = '媒体生成模型'
        unique_together = [['provider', 'model_name']]
        ordering = ['task_type', '-created_at']
        indexes = [
            models.Index(fields=['task_type', 'is_active'], name='mg_model_type_active_idx'),
            models.Index(fields=['model_name'], name='mg_model_name_idx'),
        ]

    def __str__(self):
        return f"{self.display_name} ({self.model_name})"


class MediaTask(models.Model):
    """媒体生成任务（核心跟踪表）"""

    TASK_TYPE_CHOICES = MediaModel.TASK_TYPE_CHOICES

    STATUS_CHOICES = [
        ('pending', '排队中'),
        ('running', '处理中'),
        ('succeeded', '成功'),
        ('failed', '失败'),
        ('cancelled', '已取消'),
    ]

    STORAGE_STATUS_CHOICES = [
        ('not_started', '未开始'),
        ('storing', '转存中'),
        ('succeeded', '已永久保存'),
        ('partial', '部分永久保存'),
        ('failed', '转存失败'),
    ]

    ARTIFACT_DELIVERY_STATUS_CHOICES = [
        ('not_required', '无需投递'),
        ('pending', '待投递'),
        ('delivered', '已投递'),
        ('failed', '投递失败'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task_type = models.CharField(max_length=30, choices=TASK_TYPE_CHOICES, verbose_name='任务类型')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending', verbose_name='任务状态')

    # 关联
    provider = models.ForeignKey(MediaProvider, on_delete=models.SET_NULL, null=True, verbose_name='服务提供商')
    model = models.ForeignKey(MediaModel, on_delete=models.SET_NULL, null=True, verbose_name='使用模型')
    user_id = models.CharField(max_length=36, verbose_name='用户ID')
    organization_id = models.CharField(max_length=100, blank=True, null=True, verbose_name='组织ID')
    source_session_id = models.CharField(
        max_length=255, blank=True, default='', db_index=True,
        verbose_name='来源会话ID',
    )
    source_tool_use_id = models.CharField(
        max_length=255, blank=True, default='',
        verbose_name='来源工具调用ID',
    )
    source_agent_run_id = models.CharField(
        max_length=128, blank=True, default='',
        verbose_name='来源Agent运行ID',
    )

    # Provider 侧任务 ID
    provider_task_id = models.CharField(max_length=200, blank=True, default='', verbose_name='Provider任务ID', db_index=True)

    # 输入
    prompt = models.TextField(verbose_name='提示词')
    negative_prompt = models.TextField(blank=True, default='', verbose_name='反向提示词')
    parameters = models.JSONField(default=dict, blank=True, verbose_name='生成参数', help_text='分辨率、时长、种子等')
    input_resources = models.JSONField(default=dict, blank=True, verbose_name='输入资源', help_text='图片/音频 URL')

    # 输出
    result_urls = models.JSONField(default=list, blank=True, verbose_name='原始结果URL', help_text='Provider 返回的临时 URL（24h有效）')
    stored_urls = models.JSONField(default=list, blank=True, verbose_name='永久存储URL', help_text='转存到 OSS 后的永久 URL')
    storage_status = models.CharField(
        max_length=20,
        choices=STORAGE_STATUS_CHOICES,
        default='not_started',
        verbose_name='永久存储状态',
    )
    stored_files = models.JSONField(
        default=list,
        blank=True,
        verbose_name='永久存储文件',
        help_text='带 file_id、文件名、MIME、大小和永久访问地址的稳定产物身份',
    )
    artifact_delivery_status = models.CharField(
        max_length=20,
        choices=ARTIFACT_DELIVERY_STATUS_CHOICES,
        default='not_required',
        db_index=True,
        verbose_name='正式产物消息投递状态',
    )
    artifact_delivery_error = models.TextField(blank=True, default='', verbose_name='正式产物消息投递错误')
    artifact_delivered_at = models.DateTimeField(null=True, blank=True, verbose_name='正式产物消息投递时间')
    result_metadata = models.JSONField(default=dict, blank=True, verbose_name='结果元数据', help_text='如 actual_prompt、task_metrics 等')

    # 计费
    cost_amount = models.DecimalField(max_digits=10, decimal_places=4, default=Decimal('0'), verbose_name='费用')
    cost_unit = models.CharField(max_length=30, blank=True, default='', verbose_name='计费单位')

    # 错误
    error_code = models.CharField(max_length=50, blank=True, default='', verbose_name='错误码')
    error_message = models.TextField(blank=True, default='', verbose_name='错误信息')

    # 时间
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')
    submitted_at = models.DateTimeField(null=True, blank=True, verbose_name='提交时间')
    completed_at = models.DateTimeField(null=True, blank=True, verbose_name='完成时间')

    # 轮询控制
    poll_count = models.IntegerField(default=0, verbose_name='轮询次数')
    next_poll_at = models.DateTimeField(null=True, blank=True, verbose_name='下次轮询时间')

    class Meta:
        db_table = 'services_media_task'
        verbose_name = '媒体生成任务'
        verbose_name_plural = '媒体生成任务'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user_id', '-created_at'], name='mg_task_user_created_idx'),
            models.Index(fields=['status', 'next_poll_at'], name='mg_task_poll_idx'),
            models.Index(fields=['provider_task_id'], name='mg_task_provider_id_idx'),
            models.Index(fields=['organization_id', '-created_at'], name='mg_task_ws_created_idx'),
        ]

    def __str__(self):
        return f"[{self.get_task_type_display()}] {self.status} - {self.prompt[:50]}"

    @property
    def is_terminal(self) -> bool:
        return self.status in ('succeeded', 'failed', 'cancelled')

    def mark_running(self, provider_task_id: str):
        self.status = 'running'
        self.provider_task_id = provider_task_id
        self.submitted_at = timezone.now()
        self.save(update_fields=['status', 'provider_task_id', 'submitted_at', 'updated_at'])

    def mark_succeeded(self, result_urls: list, metadata: dict = None):
        self.status = 'succeeded'
        self.result_urls = result_urls
        self.result_metadata = metadata or {}
        self.completed_at = timezone.now()
        self.save(update_fields=[
            'status', 'result_urls', 'result_metadata', 'completed_at', 'updated_at'
        ])

    def mark_failed(self, error_code: str, error_message: str):
        self.status = 'failed'
        self.error_code = error_code
        self.error_message = error_message
        self.completed_at = timezone.now()
        self.save(update_fields=[
            'status', 'error_code', 'error_message', 'completed_at', 'updated_at'
        ])

    def mark_storage_result(self, *, storage_status: str, stored_files: list):
        """保存永久转存终态；临时 Provider URL 永不进入 ``stored_urls``。"""
        if storage_status not in ('succeeded', 'partial', 'failed'):
            raise ValueError(f'非法永久存储终态: {storage_status}')

        stable_files = [
            dict(item)
            for item in stored_files
            if isinstance(item, dict)
            and all(
                isinstance(item.get(key), str) and item[key].strip()
                for key in ('file_id', 'file_name', 'mime_type', 'access_url')
            )
            and isinstance(item.get('file_size'), int)
            and not isinstance(item.get('file_size'), bool)
            and item['file_size'] >= 0
            and isinstance(item.get('index'), int)
            and not isinstance(item.get('index'), bool)
            and item['index'] >= 0
        ]
        if storage_status in ('succeeded', 'partial') and not stable_files:
            storage_status = 'failed'
        self.storage_status = storage_status
        self.stored_files = stable_files
        self.stored_urls = [
            item['access_url']
            for item in stable_files
            if isinstance(item.get('access_url'), str) and item['access_url']
        ]
        self.save(update_fields=[
            'storage_status', 'stored_files', 'stored_urls', 'updated_at',
        ])
