"""
钱包系统数据模型
"""

import uuid
from django.db import models
from django.db.models import Q
from django.core.validators import MinValueValidator
from decimal import Decimal, ROUND_DOWN
CREDITS_QUANTIZE = Decimal('0.0001')
CNY_QUANTIZE = Decimal('0.01')


def generate_uuid():
    """生成UUID字符串"""
    return str(uuid.uuid4())


def get_default_reset_time():
    """历史 migration 引用，勿删除。"""
    from django.utils import timezone
    from dateutil.relativedelta import relativedelta
    return timezone.now() + relativedelta(months=1)


class AbstractWallet(models.Model):
    """钱包抽象基类，包含 OrganizationWallet 的公共字段与方法"""

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)

    # 点券余额
    credits = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name='credits 余额'
    )
    credits_precise = models.DecimalField(
        max_digits=20,
        decimal_places=4,
        default=Decimal('0.0000'),
        validators=[MinValueValidator(Decimal('0'))],
        verbose_name='credits 余额(精确)'
    )
    # WAL-07: 预扣费冻结机制——LLM 调用前冻结预估费用，调用后结算释放。
    # CreditsService.freeze_credits_for_llm / settle_frozen_credits / release_frozen_credits
    # 负责维护此字段。get_available_credits_precise() = credits_precise - credits_frozen_precise。
    credits_frozen = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name='冻结 credits',
        help_text='当前冻结中的 credits（整数近似值），由 sync_display_balances() 从精确值同步。'
    )
    credits_frozen_precise = models.DecimalField(
        max_digits=20,
        decimal_places=4,
        default=Decimal('0.0000'),
        validators=[MinValueValidator(Decimal('0'))],
        verbose_name='冻结 credits(精确)',
        help_text='当前冻结中的 credits 精确值，由 CreditsService 的 freeze/settle/release 方法维护。'
    )

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        abstract = True

    @staticmethod
    def quantize_credits(value) -> Decimal:
        return Decimal(str(value)).quantize(CREDITS_QUANTIZE)

    @staticmethod
    def to_display_credits(value: Decimal) -> int:
        return int(value.to_integral_value(rounding=ROUND_DOWN))

    def sync_display_balances(self):
        self.credits = self.to_display_credits(self.credits_precise)
        self.credits_frozen = self.to_display_credits(self.credits_frozen_precise)

    def save(self, *args, **kwargs):
        if self.credits_precise is None:
            self.credits_precise = self.quantize_credits(self.credits or 0)
        else:
            self.credits_precise = self.quantize_credits(self.credits_precise)

        if self.credits_frozen_precise is None:
            self.credits_frozen_precise = self.quantize_credits(self.credits_frozen or 0)
        else:
            self.credits_frozen_precise = self.quantize_credits(self.credits_frozen_precise)

        self.sync_display_balances()
        super().save(*args, **kwargs)

    def get_available_credits(self):
        """获取可用点券"""
        return self.credits - self.credits_frozen

    def get_available_credits_precise(self) -> Decimal:
        """获取可用点券（精确值）"""
        return self.quantize_credits(self.credits_precise - self.credits_frozen_precise)


class OrganizationWallet(AbstractWallet):
    """组织点券钱包。

    该表历史上叫 OrganizationWallet。产品口径上它只表示 credits
    点券余额，不表示人民币现金余额。
    """

    # ：操作数据挂真 FK（PROTECT 兜底防误删；删除顺序由墓碑管线保证——
    # 清理链先删钱包再物理删组织行）。
    organization = models.OneToOneField(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name='组织',
    )

    class Meta:
        db_table = 'users_wallet_organization_wallet'
        verbose_name = '组织点券钱包'
        verbose_name_plural = '组织点券钱包'
        ordering = ['-created_at']

    def __str__(self):
        return f"Organization({str(self.organization_id)[:8]}...) - 点券: {self.credits}"


class WalletTransaction(models.Model):
    """点券钱包交易记录"""

    TRANSACTION_TYPE_CHOICES = [
        ('recharge', '充值'),
        ('consume', '消费'),
        ('grant', '赠送'),
        ('expire', '过期'),
        ('refund', '退款'),
        # WAL-07: freeze/unfreeze 由 CreditsService 的预扣费冻结机制使用
        ('freeze', '冻结'),
        ('unfreeze', '解冻'),
    ]

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    organization_wallet = models.ForeignKey(
        OrganizationWallet,
        on_delete=models.CASCADE,
        related_name='transactions',
        verbose_name='组织钱包',
    )

    # 交易类型
    transaction_type = models.CharField(
        max_length=20,
        choices=TRANSACTION_TYPE_CHOICES,
        verbose_name='交易类型',
        db_index=True
    )

    # 金额（点券数量）
    amount = models.BigIntegerField(verbose_name='credits 数量')
    amount_precise = models.DecimalField(
        max_digits=20,
        decimal_places=4,
        default=Decimal('0.0000'),
        verbose_name='credits 数量(精确)'
    )
    balance_before = models.BigIntegerField(verbose_name='变动前余额')
    balance_before_precise = models.DecimalField(
        max_digits=20,
        decimal_places=4,
        default=Decimal('0.0000'),
        verbose_name='变动前余额(精确)'
    )
    balance_after = models.BigIntegerField(verbose_name='变动后余额')
    balance_after_precise = models.DecimalField(
        max_digits=20,
        decimal_places=4,
        default=Decimal('0.0000'),
        verbose_name='变动后余额(精确)'
    )

    # 计费主体（organization）。#3832：操作流水挂真 FK（PROTECT 兜底）；
    # 极少数无法归因的 legacy 流水为 NULL（原空串语义）。
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        blank=True,
        null=True,
        verbose_name='组织',
    )

    # 操作人审计
    operator_user_id = models.CharField(
        max_length=36,
        blank=True,
        default='',
        db_index=True,
        verbose_name='操作人用户ID',
        help_text='记录执行操作的用户ID，用于审计'
    )

    # 关联订单
    related_order_id = models.CharField(
        max_length=255,
        blank=True,
        db_index=True,
        verbose_name='关联订单ID'
    )

    # WAL-07: 冻结/解冻记录的索引匹配键，替代 description__contains 全表扫描
    # P1-02: null=True + UniqueConstraint 替代空字符串，MySQL 允许多个 NULL 共存于 UNIQUE INDEX
    reference_key = models.CharField(
        max_length=255,
        null=True,
        blank=True,
        default=None,
        verbose_name='引用键',
        help_text='WAL-07: 用于冻结/解冻记录的幂等匹配。格式：freeze:{run_id}:{iteration}',
    )

    usage_event_id = models.CharField(
        max_length=36,
        blank=True,
        default='',
        db_index=True,
        verbose_name='关联用量事件ID',
        help_text='同步扣款时显式关联 BillingUsageEvent.id，避免流水详情按时间/金额猜测',
    )
    billing_metadata = models.JSONField(default=dict, blank=True, verbose_name='计费元数据')

    # 描述
    description = models.TextField(verbose_name='描述')

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间', db_index=True)

    class Meta:
        db_table = 'users_wallet_transaction'
        verbose_name = '点券钱包交易'
        verbose_name_plural = '点券钱包交易'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['organization_wallet', 'created_at'], name='users_walle_worktea_9ad054_idx'),
            models.Index(fields=['transaction_type', 'created_at']),
            models.Index(fields=['related_order_id']),
            models.Index(fields=['organization', 'created_at']),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['transaction_type', 'reference_key'],
                name='uniq_tx_type_reference_key',
            ),
            models.UniqueConstraint(
                fields=['organization', 'transaction_type', 'related_order_id'],
                condition=(
                    Q(transaction_type='recharge')
                    & ~Q(related_order_id='')
                    & Q(organization__isnull=False)
                ),
                name='uniq_wallet_recharge_org_order',
            ),
        ]

    def __str__(self):
        return f"{self.get_transaction_type_display()} - {self.amount}点券 - {self.created_at.strftime('%Y-%m-%d %H:%M')}"


class OrganizationCashWallet(models.Model):
    """组织人民币钱包。

    现金钱包余额与人民币 1:1，用于购买点券包和权益扩容包。
    大模型调用只消耗 OrganizationWallet 中的 credits 点券余额。
    """

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    organization_id = models.CharField(max_length=100, unique=True, db_index=True, verbose_name='组织ID')
    balance_cny = models.DecimalField(
        max_digits=20,
        decimal_places=2,
        default=Decimal('0.00'),
        validators=[MinValueValidator(Decimal('0'))],
        verbose_name='人民币余额',
    )
    frozen_cny = models.DecimalField(
        max_digits=20,
        decimal_places=2,
        default=Decimal('0.00'),
        validators=[MinValueValidator(Decimal('0'))],
        verbose_name='冻结人民币余额',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_wallet_organization_cash_wallet'
        verbose_name = '组织人民币钱包'
        verbose_name_plural = '组织人民币钱包'
        ordering = ['-created_at']

    @staticmethod
    def quantize_cny(value) -> Decimal:
        return Decimal(str(value)).quantize(CNY_QUANTIZE)

    def get_available_cny(self) -> Decimal:
        return self.quantize_cny(self.balance_cny - self.frozen_cny)

    def save(self, *args, **kwargs):
        self.balance_cny = self.quantize_cny(self.balance_cny or 0)
        self.frozen_cny = self.quantize_cny(self.frozen_cny or 0)
        super().save(*args, **kwargs)

    def __str__(self):
        return f"Organization({self.organization_id[:8]}...) - 人民币: {self.balance_cny}"


class CashWalletTransaction(models.Model):
    """人民币钱包交易记录。"""

    TRANSACTION_TYPE_CHOICES = [
        ('recharge', '充值'),
        ('purchase_credit_package', '购买点券包'),
        ('purchase_addon_package', '购买权益扩容包'),
        ('membership_upgrade_payment', '会员升级支付'),
        ('membership_lifecycle_payment', '会员生命周期支付'),
        ('llm_auto_topup', 'LLM点券自动补充'),
        ('refund', '退款'),
        ('freeze', '冻结'),
        ('unfreeze', '解冻'),
        ('manual_adjust', '人工调整'),
    ]

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    cash_wallet = models.ForeignKey(
        OrganizationCashWallet,
        on_delete=models.CASCADE,
        related_name='transactions',
        verbose_name='组织人民币钱包',
    )
    organization_id = models.CharField(max_length=100, db_index=True, verbose_name='组织ID')
    transaction_type = models.CharField(
        max_length=40,
        choices=TRANSACTION_TYPE_CHOICES,
        db_index=True,
        verbose_name='交易类型',
    )
    amount_cny = models.DecimalField(max_digits=20, decimal_places=2, verbose_name='人民币变动金额')
    balance_before_cny = models.DecimalField(max_digits=20, decimal_places=2, verbose_name='变动前余额')
    balance_after_cny = models.DecimalField(max_digits=20, decimal_places=2, verbose_name='变动后余额')
    operator_user_id = models.CharField(max_length=36, blank=True, default='', db_index=True, verbose_name='操作人用户ID')
    related_order_id = models.CharField(max_length=255, blank=True, db_index=True, verbose_name='关联订单ID')
    related_wallet_transaction_id = models.CharField(max_length=64, blank=True, default='', verbose_name='关联点券钱包流水ID')
    related_addon_entitlement_id = models.CharField(max_length=64, blank=True, default='', verbose_name='关联扩容权益ID')
    description = models.TextField(blank=True, default='', verbose_name='描述')
    metadata = models.JSONField(default=dict, blank=True, verbose_name='扩展元数据')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'users_wallet_cash_transaction'
        verbose_name = '人民币钱包交易'
        verbose_name_plural = '人民币钱包交易'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['cash_wallet', 'created_at'], name='users_cash_wallet_time_idx'),
            models.Index(fields=['organization_id', 'created_at'], name='users_cash_org_time_idx'),
            models.Index(fields=['transaction_type', 'created_at'], name='users_cash_type_time_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['organization_id', 'transaction_type', 'related_order_id'],
                condition=~Q(related_order_id=''),
                name='uniq_cash_tx_org_type_order',
            ),
        ]

    def __str__(self):
        return f"{self.get_transaction_type_display()} - ¥{self.amount_cny} - {self.created_at.strftime('%Y-%m-%d %H:%M')}"


class CreditPackage(models.Model):
    """点券套餐"""

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    name = models.CharField(max_length=100, verbose_name='套餐名称')
    description = models.TextField(blank=True, verbose_name='套餐描述')

    # 定价
    price = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.01'))],
        verbose_name='价格（元）'
    )

    # 点券数量
    credits_amount = models.IntegerField(
        validators=[MinValueValidator(1)],
        verbose_name='基础 credits 数'
    )
    bonus_credits = models.IntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name='赠送 credits 数'
    )

    # 排序和状态
    sort_order = models.IntegerField(default=0, verbose_name='排序')
    is_active = models.BooleanField(default=True, verbose_name='是否启用', db_index=True)

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_wallet_credit_package'
        verbose_name = 'credits 套餐'
        verbose_name_plural = 'credits 套餐'
        ordering = ['sort_order', '-created_at']
        indexes = [
            models.Index(fields=['is_active', 'sort_order']),
        ]

    def __str__(self):
        total = self.credits_amount + self.bonus_credits
        return f"{self.name} - {total}点券（¥{self.price}）"

    @property
    def total_credits(self):
        """总点券数"""
        return self.credits_amount + self.bonus_credits

    def get_discount_percentage(self):
        """计算折扣百分比"""
        if self.bonus_credits > 0:
            return round((self.bonus_credits / self.credits_amount) * 100, 1)
        return 0
