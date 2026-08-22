"""
短信服务数据模型
"""

import uuid
from django.conf import settings
from django.db import models
from django.utils import timezone


class SmsConfig(models.Model):
    """短信服务配置模型"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider = models.CharField(max_length=50, verbose_name='服务提供商', default='aliyun')
    sign_name = models.CharField(max_length=100, verbose_name='短信签名')
    region = models.CharField(max_length=50, verbose_name='服务区域', default='cn-hangzhou')
    is_active = models.BooleanField(default=True, verbose_name='是否启用')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_sms_config'
        verbose_name = '短信服务配置'
        verbose_name_plural = '短信服务配置'
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.provider} - {self.sign_name}"


class SmsTemplate(models.Model):
    """短信模板模型"""

    TEMPLATE_TYPE_CHOICES = [
        ('verification', '验证码'),
        ('notification', '通知'),
        ('marketing', '营销'),
        ('other', '其他'),
    ]

    STATUS_CHOICES = [
        ('pending', '待审核'),
        ('approved', '已通过'),
        ('rejected', '已拒绝'),
        ('disabled', '已禁用'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    template_code = models.CharField(max_length=100, unique=True, verbose_name='模板代码')
    template_name = models.CharField(max_length=200, verbose_name='模板名称')
    template_content = models.TextField(verbose_name='模板内容')
    template_type = models.CharField(
        max_length=20,
        choices=TEMPLATE_TYPE_CHOICES,
        default='verification',
        verbose_name='模板类型'
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='审核状态'
    )
    provider = models.CharField(max_length=50, verbose_name='服务提供商', default='aliyun')
    required_params = models.JSONField(default=list, verbose_name='必需参数', help_text='模板中需要的参数列表')
    is_active = models.BooleanField(default=True, verbose_name='是否启用')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_sms_template'
        verbose_name = '短信模板'
        verbose_name_plural = '短信模板'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['template_code']),
            models.Index(fields=['template_type']),
            models.Index(fields=['status']),
        ]

    def __str__(self):
        return f"{self.template_name} ({self.template_code})"


class SmsRecord(models.Model):
    """短信发送记录模型"""

    STATUS_CHOICES = [
        ('pending', '发送中'),
        ('success', '发送成功'),
        ('failed', '发送失败'),
        ('delivered', '已送达'),
        ('undelivered', '未送达'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='sms_records',
        verbose_name='发送用户',
    )
    phone_number = models.CharField(max_length=20, verbose_name='手机号码', db_index=True)
    template_code = models.CharField(max_length=100, verbose_name='模板代码', db_index=True)
    template_params = models.JSONField(default=dict, verbose_name='模板参数')
    sign_name = models.CharField(max_length=100, verbose_name='短信签名')
    content = models.TextField(verbose_name='短信内容', blank=True)

    # 发送状态
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='发送状态',
        db_index=True
    )

    # 第三方服务相关
    provider = models.CharField(max_length=50, verbose_name='服务提供商', default='aliyun')
    message_id = models.CharField(max_length=200, verbose_name='消息ID', blank=True, db_index=True)
    request_id = models.CharField(max_length=200, verbose_name='请求ID', blank=True)
    response_data = models.JSONField(default=dict, verbose_name='响应数据')

    # 错误信息
    error_code = models.CharField(max_length=100, verbose_name='错误代码', blank=True)
    error_message = models.TextField(verbose_name='错误消息', blank=True)

    # 时间信息
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间', db_index=True)
    sent_at = models.DateTimeField(null=True, blank=True, verbose_name='发送时间')
    delivered_at = models.DateTimeField(null=True, blank=True, verbose_name='送达时间')

    # 统计信息
    retry_count = models.PositiveIntegerField(default=0, verbose_name='重试次数')
    cost = models.DecimalField(max_digits=10, decimal_places=4, null=True, blank=True, verbose_name='费用')

    class Meta:
        db_table = 'services_sms_record'
        verbose_name = '短信发送记录'
        verbose_name_plural = '短信发送记录'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['phone_number', 'created_at']),
            models.Index(fields=['template_code', 'created_at']),
            models.Index(fields=['status', 'created_at']),
            models.Index(fields=['provider', 'created_at']),
        ]

    def __str__(self):
        from ..common.utils import mask_phone_number
        return f"{mask_phone_number(self.phone_number)} - {self.template_code} - {self.status}"

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

    def increment_retry(self):
        """增加重试次数"""
        self.retry_count += 1
        self.save(update_fields=['retry_count'])


class SmsStatistics(models.Model):
    """短信统计模型"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    date = models.DateField(verbose_name='统计日期', db_index=True)
    provider = models.CharField(max_length=50, verbose_name='服务提供商', db_index=True)
    template_code = models.CharField(max_length=100, verbose_name='模板代码', db_index=True)

    # 统计数据
    total_sent = models.PositiveIntegerField(default=0, verbose_name='发送总数')
    success_count = models.PositiveIntegerField(default=0, verbose_name='成功数量')
    failed_count = models.PositiveIntegerField(default=0, verbose_name='失败数量')
    delivered_count = models.PositiveIntegerField(default=0, verbose_name='送达数量')

    # 费用统计
    total_cost = models.DecimalField(max_digits=10, decimal_places=4, default=0, verbose_name='总费用')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_sms_statistics'
        verbose_name = '短信统计'
        verbose_name_plural = '短信统计'
        ordering = ['-date']
        unique_together = ['date', 'provider', 'template_code']
        indexes = [
            models.Index(fields=['date', 'provider']),
            models.Index(fields=['date', 'template_code']),
        ]

    def __str__(self):
        return f"{self.date} - {self.provider} - {self.template_code}"

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
