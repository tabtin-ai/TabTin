"""
邮件服务数据模型
"""

import uuid
from django.conf import settings
from django.db import models
from django.utils import timezone


class EmailConfig(models.Model):
    """邮件服务配置模型"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider = models.CharField(max_length=50, verbose_name='服务提供商', default='tencent')
    smtp_host = models.CharField(max_length=200, verbose_name='SMTP服务器')
    smtp_port = models.PositiveIntegerField(verbose_name='SMTP端口', default=465)
    use_ssl = models.BooleanField(default=True, verbose_name='使用SSL')
    use_tls = models.BooleanField(default=False, verbose_name='使用TLS')
    default_sender = models.EmailField(verbose_name='默认发件人')
    is_active = models.BooleanField(default=True, verbose_name='是否启用')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_email_config'
        verbose_name = '邮件服务配置'
        verbose_name_plural = '邮件服务配置'
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.provider} - {self.smtp_host}:{self.smtp_port}"


class EmailTemplate(models.Model):
    """邮件模板模型"""

    TEMPLATE_TYPE_CHOICES = [
        ('verification', '验证码'),
        ('welcome', '欢迎邮件'),
        ('notification', '通知'),
        ('marketing', '营销'),
        ('system', '系统邮件'),
        ('other', '其他'),
    ]

    STATUS_CHOICES = [
        ('draft', '草稿'),
        ('active', '启用'),
        ('disabled', '禁用'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    template_name = models.CharField(max_length=100, unique=True, verbose_name='模板名称')
    template_subject = models.CharField(max_length=200, verbose_name='邮件主题模板')
    template_content = models.TextField(verbose_name='邮件内容模板')
    template_type = models.CharField(
        max_length=20,
        choices=TEMPLATE_TYPE_CHOICES,
        default='notification',
        verbose_name='模板类型'
    )
    content_type = models.CharField(
        max_length=10,
        choices=[('html', 'HTML'), ('plain', '纯文本')],
        default='html',
        verbose_name='内容类型'
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='active',
        verbose_name='状态'
    )
    required_params = models.JSONField(default=list, verbose_name='必需参数', help_text='模板中需要的参数列表')
    description = models.TextField(blank=True, verbose_name='模板描述')
    is_active = models.BooleanField(default=True, verbose_name='是否启用')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_email_template'
        verbose_name = '邮件模板'
        verbose_name_plural = '邮件模板'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['template_name']),
            models.Index(fields=['template_type']),
            models.Index(fields=['status']),
        ]

    def __str__(self):
        return f"{self.template_name} ({self.template_type})"


class EmailRecord(models.Model):
    """邮件发送记录模型"""

    STATUS_CHOICES = [
        ('pending', '发送中'),
        ('success', '发送成功'),
        ('failed', '发送失败'),
        ('bounced', '退回'),
        ('delivered', '已送达'),
        ('opened', '已打开'),
        ('clicked', '已点击'),
    ]

    PRIORITY_CHOICES = [
        ('low', '低'),
        ('normal', '普通'),
        ('high', '高'),
        ('urgent', '紧急'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='email_records',
        verbose_name='发送用户',
    )
    recipient_email = models.EmailField(verbose_name='收件人邮箱', db_index=True)
    sender_email = models.EmailField(verbose_name='发件人邮箱')
    subject = models.CharField(max_length=500, verbose_name='邮件主题')
    content = models.TextField(verbose_name='邮件内容')
    content_type = models.CharField(
        max_length=10,
        choices=[('html', 'HTML'), ('plain', '纯文本')],
        default='html',
        verbose_name='内容类型'
    )

    # 模板相关
    template_name = models.CharField(max_length=100, verbose_name='模板名称', blank=True)
    template_params = models.JSONField(default=dict, verbose_name='模板参数')

    # 发送状态
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='发送状态',
        db_index=True
    )
    priority = models.CharField(
        max_length=10,
        choices=PRIORITY_CHOICES,
        default='normal',
        verbose_name='优先级'
    )

    # 第三方服务相关
    provider = models.CharField(max_length=50, verbose_name='服务提供商', default='tencent')
    message_id = models.CharField(max_length=200, verbose_name='消息ID', blank=True, db_index=True)
    request_id = models.CharField(max_length=200, verbose_name='请求ID', blank=True)
    response_data = models.JSONField(default=dict, verbose_name='响应数据')

    # 错误信息
    error_code = models.CharField(max_length=100, verbose_name='错误代码', blank=True)
    error_message = models.TextField(verbose_name='错误消息', blank=True)

    # 附件信息
    has_attachments = models.BooleanField(default=False, verbose_name='是否有附件')
    attachments_info = models.JSONField(default=list, verbose_name='附件信息')

    # 时间信息
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间', db_index=True)
    sent_at = models.DateTimeField(null=True, blank=True, verbose_name='发送时间')
    delivered_at = models.DateTimeField(null=True, blank=True, verbose_name='送达时间')
    opened_at = models.DateTimeField(null=True, blank=True, verbose_name='打开时间')
    clicked_at = models.DateTimeField(null=True, blank=True, verbose_name='点击时间')

    # 统计信息
    retry_count = models.PositiveIntegerField(default=0, verbose_name='重试次数')
    open_count = models.PositiveIntegerField(default=0, verbose_name='打开次数')
    click_count = models.PositiveIntegerField(default=0, verbose_name='点击次数')

    class Meta:
        db_table = 'services_email_record'
        verbose_name = '邮件发送记录'
        verbose_name_plural = '邮件发送记录'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['recipient_email', 'created_at']),
            models.Index(fields=['template_name', 'created_at']),
            models.Index(fields=['status', 'created_at']),
            models.Index(fields=['provider', 'created_at']),
            models.Index(fields=['priority', 'created_at']),
        ]

    def __str__(self):
        from ..common.utils import mask_email
        return f"{mask_email(self.recipient_email)} - {self.subject[:50]} - {self.status}"

    def mark_as_sent(self, message_id: str, response_data: dict = None):
        """标记为已发送"""
        self.status = 'success'
        self.message_id = message_id
        self.sent_at = timezone.now()
        if response_data:
            self.response_data = response_data
        self.save(update_fields=['status', 'message_id', 'sent_at', 'response_data'])

    def mark_as_failed(self, error_code: str, error_message: str):
        """标记为发送失败"""
        self.status = 'failed'
        self.error_code = error_code
        self.error_message = error_message
        self.save(update_fields=['status', 'error_code', 'error_message'])

    def mark_as_delivered(self):
        """标记为已送达"""
        self.status = 'delivered'
        self.delivered_at = timezone.now()
        self.save(update_fields=['status', 'delivered_at'])

    def mark_as_opened(self):
        """标记为已打开"""
        if self.status != 'opened':
            self.status = 'opened'
            self.opened_at = timezone.now()
        self.open_count += 1
        self.save(update_fields=['status', 'opened_at', 'open_count'])

    def mark_as_clicked(self):
        """标记为已点击"""
        if self.status != 'clicked':
            self.status = 'clicked'
            self.clicked_at = timezone.now()
        self.click_count += 1
        self.save(update_fields=['status', 'clicked_at', 'click_count'])

    def increment_retry(self):
        """增加重试次数"""
        self.retry_count += 1
        self.save(update_fields=['retry_count'])


class EmailStatistics(models.Model):
    """邮件统计模型"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    date = models.DateField(verbose_name='统计日期', db_index=True)
    provider = models.CharField(max_length=50, verbose_name='服务提供商', db_index=True)
    template_name = models.CharField(max_length=100, verbose_name='模板名称', db_index=True)

    # 统计数据
    total_sent = models.PositiveIntegerField(default=0, verbose_name='发送总数')
    success_count = models.PositiveIntegerField(default=0, verbose_name='成功数量')
    failed_count = models.PositiveIntegerField(default=0, verbose_name='失败数量')
    delivered_count = models.PositiveIntegerField(default=0, verbose_name='送达数量')
    opened_count = models.PositiveIntegerField(default=0, verbose_name='打开数量')
    clicked_count = models.PositiveIntegerField(default=0, verbose_name='点击数量')
    bounced_count = models.PositiveIntegerField(default=0, verbose_name='退回数量')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_email_statistics'
        verbose_name = '邮件统计'
        verbose_name_plural = '邮件统计'
        ordering = ['-date']
        unique_together = ['date', 'provider', 'template_name']
        indexes = [
            models.Index(fields=['date', 'provider']),
            models.Index(fields=['date', 'template_name']),
        ]

    def __str__(self):
        return f"{self.date} - {self.provider} - {self.template_name}"

    @property
    def success_rate(self):
        """成功率"""
        if self.total_sent == 0:
            return 0
        return round(self.success_count / self.total_sent * 100, 2)

    @property
    def delivery_rate(self):
        """送达率"""
        if self.success_count == 0:
            return 0
        return round(self.delivered_count / self.success_count * 100, 2)

    @property
    def open_rate(self):
        """打开率"""
        if self.delivered_count == 0:
            return 0
        return round(self.opened_count / self.delivered_count * 100, 2)

    @property
    def click_rate(self):
        """点击率"""
        if self.opened_count == 0:
            return 0
        return round(self.clicked_count / self.opened_count * 100, 2)

    @property
    def bounce_rate(self):
        """退回率"""
        if self.total_sent == 0:
            return 0
        return round(self.bounced_count / self.total_sent * 100, 2)
