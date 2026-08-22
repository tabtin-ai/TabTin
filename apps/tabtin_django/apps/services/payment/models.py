"""
支付服务数据模型
"""

import uuid
from django.db import models
from django.utils import timezone
from django.core.validators import MinValueValidator
from django.contrib.auth import get_user_model
from decimal import Decimal

User = get_user_model()


def generate_uuid():
    """生成UUID字符串"""
    return str(uuid.uuid4())


def generate_order_no():
    """生成订单号：YYYYMMDDHHMMSSxxxxxxxxxx（24位）"""
    import uuid
    timestamp = timezone.now().strftime('%Y%m%d%H%M%S')
    unique_part = uuid.uuid4().hex[:10]
    return f"{timestamp}{unique_part}"


class PaymentOrder(models.Model):
    """支付订单"""

    ORDER_TYPE_CHOICES = [
        ('membership', '会员购买'),
        ('credits', 'credits 充值'),
        ('storage_package', '存储套餐'),
        ('billing_addon', '权益增值包'),
        ('cash_wallet', '现金钱包充值'),
    ]

    PAYMENT_METHOD_CHOICES = [
        ('alipay', '支付宝'),
        ('wechat', '微信支付'),
        ('organization_wallet', '组织现金钱包'),
    ]

    BENEFIT_STATUS_CHOICES = [
        ('pending', '待处理'),
        ('processing', '处理中'),
        ('completed', '已完成'),
        ('failed', '处理失败'),
    ]

    STATUS_CHOICES = [
        ('pending', '待支付'),
        ('paying', '支付中'),
        ('paid', '已支付'),
        ('cancelled', '已取消'),
        ('expired', '已过期'),
        ('failed', '支付失败'),
        ('completed', '已完成'),
        ('refunded', '已退款'),
        ('partially_refunded', '部分退款'),
    ]

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    order_no = models.CharField(
        max_length=32,
        unique=True,
        default=generate_order_no,
        verbose_name='订单号',
        db_index=True
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='payment_orders',
        verbose_name='用户',
    )

    # 组织归属（P2: 计费主体）
    organization_id = models.CharField(
        max_length=100,
        blank=True,
        default='',
        db_index=True,
        verbose_name='组织ID',
        help_text='该订单归属的组织，为空时兼容旧用户级订单',
    )

    # 订单信息
    order_type = models.CharField(
        max_length=20,
        choices=ORDER_TYPE_CHOICES,
        verbose_name='订单类型',
        db_index=True
    )
    subject = models.CharField(max_length=200, verbose_name='订单标题')
    description = models.TextField(blank=True, verbose_name='订单描述')

    # 金额
    amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.00'))],
        verbose_name='订单金额（元）'
    )
    paid_amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal('0.00'),
        verbose_name='实付金额（元）'
    )

    # 支付信息
    payment_method = models.CharField(
        max_length=20,
        choices=PAYMENT_METHOD_CHOICES,
        verbose_name='支付方式',
        db_index=True
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='订单状态',
        db_index=True
    )

    # 第三方支付信息
    third_party_order_no = models.CharField(
        max_length=100,
        blank=True,
        verbose_name='第三方订单号'
    )
    third_party_trade_no = models.CharField(
        max_length=100,
        blank=True,
        db_index=True,
        verbose_name='第三方交易号'
    )

    # 业务数据（JSON存储）
    business_data = models.JSONField(
        default=dict,
        verbose_name='业务数据',
        help_text='存储会员等级、点券套餐等业务信息'
    )
    benefit_status = models.CharField(
        max_length=20,
        choices=BENEFIT_STATUS_CHOICES,
        default='pending',
        verbose_name='权益处理状态',
        db_index=True,
    )
    failure_code = models.CharField(
        max_length=80,
        blank=True,
        default='',
        verbose_name='失败代码',
    )
    failure_message = models.TextField(
        blank=True,
        default='',
        verbose_name='失败信息',
    )

    # 时间信息
    paid_at = models.DateTimeField(null=True, blank=True, verbose_name='支付时间')
    expired_at = models.DateTimeField(verbose_name='过期时间')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间', db_index=True)
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_payment_order'
        verbose_name = '支付订单'
        verbose_name_plural = '支付订单'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', 'status']),
            models.Index(fields=['order_no']),
            models.Index(fields=['third_party_trade_no']),
            models.Index(fields=['status', 'created_at']),
            models.Index(fields=['payment_method', 'status']),
        ]

    def __str__(self):
        return f"{self.order_no} - {self.get_order_type_display()} - ¥{self.amount}"

    def is_expired(self):
        """检查是否过期"""
        return timezone.now() > self.expired_at

    def can_cancel(self):
        """是否可以取消"""
        return self.status in ['pending', 'paying']

    def can_pay(self):
        """是否可以支付"""
        return self.status == 'pending' and not self.is_expired() and self.amount > Decimal('0.00')


def generate_refund_no():
    """生成退款单号：R + YYYYMMDDHHMMSSxxxxxxxxxx（25位）"""
    timestamp = timezone.now().strftime('%Y%m%d%H%M%S')
    unique_part = uuid.uuid4().hex[:10]
    return f"R{timestamp}{unique_part}"


class RefundRecord(models.Model):
    """退款记录：追踪支付平台退款状态（D10 决策）"""

    REFUND_STATUS_CHOICES = [
        ('pending', '待退款'),
        ('refunding', '退款中'),
        ('refunded', '已退款'),
        ('refund_failed', '退款失败'),
    ]

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    payment_order = models.ForeignKey(
        PaymentOrder,
        on_delete=models.CASCADE,
        related_name='refund_records',
        verbose_name='原支付订单',
    )
    invoice_id = models.CharField(
        max_length=36,
        db_index=True,
        verbose_name='关联账单ID',
        help_text='BillingInvoice ID（跨数据库引用，不建外键）',
    )
    refund_no = models.CharField(
        max_length=32,
        unique=True,
        default=generate_refund_no,
        verbose_name='退款单号',
        db_index=True,
    )
    refund_amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.01'))],
        verbose_name='退款金额（元）',
    )
    refund_status = models.CharField(
        max_length=20,
        choices=REFUND_STATUS_CHOICES,
        default='pending',
        verbose_name='退款状态',
        db_index=True,
    )
    payment_method = models.CharField(
        max_length=20,
        choices=PaymentOrder.PAYMENT_METHOD_CHOICES,
        verbose_name='支付方式',
    )
    third_party_refund_no = models.CharField(
        max_length=100,
        blank=True,
        verbose_name='第三方退款单号',
    )
    failure_reason = models.TextField(blank=True, verbose_name='失败原因')
    operator_user_id = models.CharField(max_length=36, blank=True, verbose_name='操作人')
    reason = models.TextField(blank=True, verbose_name='退款原因')
    metadata = models.JSONField(default=dict, verbose_name='附加数据')
    refunded_at = models.DateTimeField(null=True, blank=True, verbose_name='退款完成时间')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间', db_index=True)
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_payment_refund_record'
        verbose_name = '退款记录'
        verbose_name_plural = '退款记录'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['payment_order', 'refund_status']),
            models.Index(fields=['invoice_id']),
            models.Index(fields=['refund_status', 'created_at']),
        ]

    def __str__(self):
        return f"{self.refund_no} - {self.get_refund_status_display()} - ¥{self.refund_amount}"


class PaymentCallback(models.Model):
    """支付回调记录"""

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    order = models.ForeignKey(
        PaymentOrder,
        on_delete=models.CASCADE,
        related_name='callbacks',
        verbose_name='订单',
        null=True,
        blank=True
    )

    # 回调信息
    payment_method = models.CharField(max_length=20, verbose_name='支付方式', db_index=True)
    callback_data = models.JSONField(verbose_name='回调数据')

    # 验证状态
    is_verified = models.BooleanField(default=False, verbose_name='是否验证通过')
    is_processed = models.BooleanField(default=False, verbose_name='是否已处理')

    # 错误信息
    error_message = models.TextField(blank=True, verbose_name='错误信息')

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间', db_index=True)

    class Meta:
        db_table = 'services_payment_callback'
        verbose_name = '支付回调'
        verbose_name_plural = '支付回调'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['order', 'created_at']),
            models.Index(fields=['payment_method', 'created_at']),
            models.Index(fields=['is_processed', 'created_at']),
        ]

    def __str__(self):
        order_info = f"订单{self.order.order_no}" if self.order else "未关联订单"
        status = "已处理" if self.is_processed else ("已验证" if self.is_verified else "待验证")
        return f"{order_info} - {status}"
