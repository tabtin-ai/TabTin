"""
会员体系数据模型
"""

import math
import uuid
from django.conf import settings
from django.db import models, transaction
from django.db.models import F, Q
from django.utils import timezone
from django.core.validators import MinValueValidator
from django.contrib.auth import get_user_model
from decimal import Decimal

User = get_user_model()


def generate_uuid():
    """生成UUID字符串"""
    return str(uuid.uuid4())


class MembershipTier(models.Model):
    """会员等级配置"""

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    tier_type = models.CharField(max_length=50, unique=True, verbose_name='等级标识', help_text='如: free, basic, pro')
    name = models.CharField(max_length=100, verbose_name='显示名称')
    description = models.TextField(blank=True, verbose_name='说明')

    # 定价
    price = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal('0.00'),
        validators=[MinValueValidator(Decimal('0.00'))],
        verbose_name='价格（元）'
    )
    duration_months = models.IntegerField(
        default=1,
        validators=[MinValueValidator(1)],
        verbose_name='时长（月）'
    )

    # 资源配额（-1 表示无限制）
    max_tables = models.IntegerField(default=10, verbose_name='最大表格数', help_text='-1表示无限制')
    max_documents = models.IntegerField(
        default=-1,
        verbose_name='最大文档数',
        help_text='-1表示无限制。seed data 中会按 free/basic/pro/enterprise 覆盖默认值。',
    )
    max_groups = models.IntegerField(
        default=-1,
        verbose_name='最大群组数',
        help_text='-1表示无限制。用于 TabChat 群聊数量套餐权益检查。',
    )
    max_records_per_table = models.IntegerField(default=1000, verbose_name='每表最大记录数', help_text='-1表示无限制')
    # Legacy, not enforced — 无任何调用点执行此配额，实际限流由 ApiToken.rate_limit
    # (Redis 滑动窗口, 次/分钟) 控制。保留字段以兼容已有数据库行，勿新增引用。(D5/QTA-12)
    max_api_calls_per_day = models.IntegerField(default=100, verbose_name='[Legacy] 每日API调用上限', help_text='Legacy, not enforced. 实际限流见 ApiToken.rate_limit')
    # Legacy, not enforced — ExtractionTask 模型已移除，此配额始终返回 0，
    # 无实际执行意义。保留字段以兼容已有数据库行，勿新增引用。(D5/QTA-13)
    max_crawl_tasks_per_day = models.IntegerField(default=10, verbose_name='[Legacy] 每日采集任务上限', help_text='Legacy, not enforced. ExtractionTask 已移除')
    # Entitlement 映射（同步到 OrganizationBillingEntitlement）
    included_storage_bytes = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name='赠送存储容量（字节）',
        help_text='该等级赠送的存储额度，同步到 organization entitlement'
    )
    included_llm_credits_monthly = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal('0'),
        validators=[MinValueValidator(Decimal('0'))],
        verbose_name='每月赠送LLM额度（credits）',
        help_text='该等级每月赠送的LLMcredits额度，同步到 organization entitlement'
    )

    included_media_monthly = models.IntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name='每月媒体生成张数',
        help_text='该等级每月包含的图片/视频生成次数',
    )
    included_search_monthly = models.IntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name='每月联网搜索次数',
    )
    included_tts_monthly = models.IntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name='每月TTS字符数',
    )

    # QTA-24: 每日对话次数配额
    max_conversations_per_day = models.IntegerField(
        default=-1,
        verbose_name='每日最大对话次数',
        help_text=(
            '-1表示无限制。'
            'seed data: free=50, basic=200, pro=1000, enterprise=-1；'
            '通过 Redis 计数器 + BillingUsageEvent fallback 执行检查。'
        ),
    )

    # TODO(QTA-15): 缺少 max_organizations 字段 — 当前用户可创建无限组织，
    # 需在此添加字段并在 tabtinspace/services/organization_service.py:create_organization 中接入检查。

    # 席位管理
    # MEM-16: 模型 default=-1（无限制）与 seed free tier=3 不一致。
    # default=-1 是"字段级安全兜底"，实际各等级值由 seed_membership_tiers.py 写入。
    # 手动在 Admin 新建 MembershipTier 时会得到 -1（无限制），如不符合预期请手动指定。
    max_members = models.IntegerField(
        default=-1,
        verbose_name='最大成员数',
        help_text=(
            '-1表示无限制。'
            '注意：seed data 中 free=3/basic=5/pro=20/enterprise=-1；'
            '手动新建时需按实际等级手动设置，default=-1 仅作字段兜底。'
        ),
    )
    base_seats = models.IntegerField(
        default=1,
        validators=[MinValueValidator(1)],
        verbose_name='套餐包含基础席位数',
    )
    extra_seat_price = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal('0.00'),
        validators=[MinValueValidator(Decimal('0.00'))],
        verbose_name='每额外席位月费（元）',
    )

    # 回收站保留期（天）
    # MEM-16: 模型 default=30 与 seed free tier=14 不一致。
    # 30 天是合理的"中间值"默认，seed data 会为 free tier 覆盖为 14 天。
    trash_retention_days = models.IntegerField(
        default=30,
        validators=[MinValueValidator(1)],
        verbose_name='回收站保留天数',
        help_text=(
            '该等级的回收站资源保留天数。'
            'seed data: free=14, basic=30, pro=60, enterprise=90；'
            '手动新建时按实际等级设置，default=30 仅作字段兜底。'
        ),
    )

    # 功能权限（JSON灵活配置）
    features = models.JSONField(
        default=dict,
        verbose_name='功能权限',
        help_text='示例: {"api_access": true, "advanced_export": true}'
    )

    # 排序和状态
    sort_order = models.IntegerField(default=0, verbose_name='排序')
    tier_level = models.IntegerField(
        default=0,
        verbose_name='等级层级',
        help_text='用于升降级判断的等级数值（越高=越高级），独立于展示排序 sort_order',
        db_index=True,
    )
    is_active = models.BooleanField(default=True, verbose_name='是否启用')

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_membership_tier'
        verbose_name = '会员等级'
        verbose_name_plural = '会员等级'
        ordering = ['sort_order', '-created_at']
        indexes = [
            models.Index(fields=['tier_type']),
            models.Index(fields=['is_active', 'sort_order']),
        ]

    def __str__(self):
        return f"{self.name} ({self.tier_type})"

    def get_quota_summary(self):
        """获取配额摘要（含席位、存储、LLM 额度、回收站等）"""
        def _fmt(v):
            return '无限制' if v == -1 else v

        return {
            'max_tables': _fmt(self.max_tables),
            'max_documents': _fmt(self.max_documents),
            'max_groups': _fmt(self.max_groups),
            'max_records_per_table': _fmt(self.max_records_per_table),
            'max_members': _fmt(self.max_members),
            'max_conversations_per_day': _fmt(self.max_conversations_per_day),
            'included_storage_bytes': self.included_storage_bytes,
            'included_llm_credits_monthly': self.included_llm_credits_monthly,
            'base_seats': self.base_seats,
            'extra_seat_price': self.extra_seat_price,
            'trash_retention_days': self.trash_retention_days,
        }


class MembershipStatusMixin:
    """
    会员状态公共逻辑 — UserMembership / OrganizationMembership 共用。
    要求宿主模型包含 status, end_date 字段。
    """

    def is_expired(self):
        if self.end_date is None:
            return False
        return timezone.now() > self.end_date

    def check_and_update_status(self):
        model_cls = type(self)
        with transaction.atomic():
            membership = model_cls.objects.select_for_update().get(id=self.id)
            if membership.status == 'active' and membership.is_expired():
                membership.status = 'expired'
                membership.save(update_fields=['status', 'updated_at'])
                self.status = 'expired'
                return True
        return False

    def days_until_expiry(self):
        if self.end_date is None or self.is_expired():
            return 0
        delta = self.end_date - timezone.now()
        total_seconds = delta.total_seconds()
        if total_seconds <= 0:
            return 0
        return math.ceil(total_seconds / 86400)


class UserMembership(MembershipStatusMixin, models.Model):
    """用户会员关系"""

    STATUS_CHOICES = [
        ('active', '有效'),
        ('expired', '已过期'),
    ]

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name='membership',
        verbose_name='用户',
    )
    tier = models.ForeignKey(
        MembershipTier,
        on_delete=models.PROTECT,
        related_name='memberships',
        verbose_name='会员等级'
    )

    # 状态
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='active',
        verbose_name='状态',
        db_index=True
    )

    # 时间管理
    start_date = models.DateTimeField(verbose_name='开始时间')
    end_date = models.DateTimeField(verbose_name='到期时间', db_index=True)
    related_order_id = models.CharField(
        max_length=36,
        blank=True,
        verbose_name='关联订单ID',
        db_index=True
    )

    # 自动续费
    auto_renew = models.BooleanField(default=False, verbose_name='自动续费')

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_membership_user_membership'
        verbose_name = '用户会员'
        verbose_name_plural = '用户会员'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', 'status']),
            models.Index(fields=['status', 'end_date']),
        ]

    def __str__(self):
        try:
            user_display = f"用户{str(self.user.id)[:8]}"
        except:
            user_display = "未知用户"
        return f"{user_display} - {self.tier.name} ({self.get_status_display()})"

class OrganizationMembership(MembershipStatusMixin, models.Model):
    """
    组织会员关系 — 计费主体

    每个组织在此表中最多一条记录（organization_id unique=True），作为当前套餐快照。
    生命周期变更历史和待生效计划记录在 OrganizationMembershipChangeLog。
    """

    STATUS_CHOICES = [
        ('active', '有效'),
        ('grace', '宽限期'),
        ('expired', '已过期'),
        ('suspended', '已暂停'),
        ('cancelled', '已取消'),
    ]

    class BillingCycle(models.TextChoices):
        MONTHLY = 'monthly', '月付'
        YEARLY = 'yearly', '年付'

    class ScheduledChangeType(models.TextChoices):
        DOWNGRADE = 'downgrade', '降级'
        SWITCH = 'switch', '同级切换'

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    organization_id = models.CharField(
        max_length=100,
        unique=True,
        db_index=True,
        verbose_name='组织ID',
    )
    tier = models.ForeignKey(
        MembershipTier,
        on_delete=models.PROTECT,
        related_name='organization_memberships',
        verbose_name='会员等级',
    )

    # 状态
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='active',
        verbose_name='状态',
        db_index=True,
    )

    # 时间管理
    start_date = models.DateTimeField(verbose_name='开始时间')
    end_date = models.DateTimeField(verbose_name='到期时间', db_index=True)
    billing_cycle = models.CharField(
        max_length=20,
        choices=BillingCycle.choices,
        default=BillingCycle.MONTHLY,
        verbose_name='计费周期',
    )
    current_actual_paid_period_price = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        null=True,
        blank=True,
        verbose_name='当前完整周期实际成交价',
        help_text='完整周期成交价快照，不是升级补差金额；历史事实不可恢复时保持为空。',
    )
    grace_period_end = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='宽限期截止时间',
        help_text='PR2 仅预留字段；运行时宽限逻辑由后续生命周期服务统一。',
    )
    lifecycle_version = models.PositiveBigIntegerField(
        default=1,
        verbose_name='生命周期版本',
        help_text='用于报价和套餐变更的乐观并发控制。',
    )
    related_order_id = models.CharField(
        max_length=36,
        blank=True,
        verbose_name='关联订单ID',
        db_index=True,
    )
    scheduled_tier = models.ForeignKey(
        MembershipTier,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name='+',
        verbose_name='已预约目标套餐',
        help_text='当前有效的下周期套餐计划；历史记录见 OrganizationMembershipChangeLog。',
    )
    scheduled_billing_cycle = models.CharField(
        max_length=20,
        choices=BillingCycle.choices,
        null=True,
        blank=True,
        verbose_name='已预约目标计费周期',
    )
    scheduled_change_type = models.CharField(
        max_length=32,
        choices=ScheduledChangeType.choices,
        null=True,
        blank=True,
        verbose_name='已预约变更类型',
    )
    scheduled_change_effective_at = models.DateTimeField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name='已预约变更生效时间',
    )
    scheduled_change_log_id = models.UUIDField(
        null=True,
        blank=True,
        verbose_name='已预约变更记录ID',
        help_text='指向 OrganizationMembershipChangeLog.id；避免强 FK 循环，执行时会锁 ChangeLog 校验。',
    )

    # 自动续费
    auto_renew = models.BooleanField(default=False, verbose_name='自动续费')

    # 审计
    purchased_by = models.CharField(
        max_length=36,
        blank=True,
        verbose_name='购买者用户ID',
        help_text='记录为哪个用户发起的购买操作',
    )

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_membership_organization_membership'
        verbose_name = '组织会员'
        verbose_name_plural = '组织会员'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['organization_id', 'status']),
            models.Index(fields=['status', 'end_date']),
        ]

    def __str__(self):
        return f"WT:{self.organization_id[:8]} - {self.tier.name} ({self.get_status_display()})"

    def bump_lifecycle_version(self) -> int:
        """显式递增生命周期版本；不挂入 save()，由后续事务服务按需调用。"""
        type(self).objects.filter(pk=self.pk).update(
            lifecycle_version=F('lifecycle_version') + 1,
        )
        self.refresh_from_db(fields=['lifecycle_version'])
        return self.lifecycle_version


class OrganizationMembershipChangeLog(models.Model):
    """组织套餐变更事实与待生效计划；不是 Subscription 主表。"""

    class ChangeType(models.TextChoices):
        NEW = 'new', '新购'
        RENEW = 'renew', '续费'
        RENEWAL = 'renewal', '手动续费'
        UPGRADE = 'upgrade', '升级'
        DOWNGRADE = 'downgrade', '降级'
        SWITCH = 'switch', '同级或周期切换'
        GRACE_ENTER = 'grace_enter', '进入宽限期'
        GRACE_EXIT = 'grace_exit', '退出宽限期'
        EXPIRE = 'expire', '到期'
        FREE_DOWNGRADE = 'free_downgrade', '降为免费版'
        CANCEL_CHANGE = 'cancel_change', '取消变更'
        ADMIN_ADJUST = 'admin_adjust', '管理员调整'
        REFUND_REVOKE = 'refund_revoke', '退款撤销'
        SUSPEND = 'suspend', '暂停'
        RESUME = 'resume', '恢复'

    class Status(models.TextChoices):
        REQUESTED = 'requested', '已请求'
        SCHEDULED = 'scheduled', '已预约'
        PAYMENT_PENDING = 'payment_pending', '待支付'
        PAID = 'paid', '已支付'
        PENDING = 'pending', '待生效'
        APPLYING = 'applying', '应用中'
        APPLIED = 'applied', '已应用'
        FAILED = 'failed', '失败'
        CANCELLED = 'cancelled', '已取消'
        EXPIRED = 'expired', '已过期'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.CASCADE,
        related_name='membership_change_logs',
        verbose_name='组织',
    )
    membership = models.ForeignKey(
        OrganizationMembership,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='change_logs',
        verbose_name='关联会员',
    )
    change_type = models.CharField(
        max_length=32,
        choices=ChangeType.choices,
        verbose_name='变更类型',
    )
    status = models.CharField(
        max_length=32,
        choices=Status.choices,
        verbose_name='处理状态',
    )
    from_tier = models.ForeignKey(
        MembershipTier,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name='原套餐',
    )
    to_tier = models.ForeignKey(
        MembershipTier,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name='目标套餐',
    )
    from_tier_snapshot = models.JSONField(default=dict, blank=True, verbose_name='原套餐快照')
    to_tier_snapshot = models.JSONField(default=dict, blank=True, verbose_name='目标套餐快照')
    from_billing_cycle = models.CharField(
        max_length=20,
        choices=OrganizationMembership.BillingCycle.choices,
        null=True,
        blank=True,
        verbose_name='原计费周期',
    )
    to_billing_cycle = models.CharField(
        max_length=20,
        choices=OrganizationMembership.BillingCycle.choices,
        null=True,
        blank=True,
        verbose_name='目标计费周期',
    )
    requested_at = models.DateTimeField(default=timezone.now, verbose_name='申请时间')
    effective_at = models.DateTimeField(null=True, blank=True, verbose_name='计划生效时间')
    applied_at = models.DateTimeField(null=True, blank=True, verbose_name='实际生效时间')
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name='申请人',
    )
    payment_order_id = models.CharField(
        max_length=64,
        null=True,
        blank=True,
        default=None,
        verbose_name='支付订单主键',
        help_text='仅保存 PaymentOrder 主键字符串，不保存或混用 order_no。',
    )
    list_amount = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True, verbose_name='目标周期原价',
    )
    current_value = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True, verbose_name='当前剩余价值',
    )
    target_value = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True, verbose_name='目标剩余价值',
    )
    discount_amount = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True, verbose_name='优惠金额',
    )
    payable_amount = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True, verbose_name='实际应付金额',
    )
    reason = models.TextField(blank=True, default='', verbose_name='变更原因')
    metadata = models.JSONField(default=dict, blank=True, verbose_name='扩展元数据')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_membership_organization_change_log'
        verbose_name = '组织套餐变更记录'
        verbose_name_plural = '组织套餐变更记录'
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['payment_order_id'],
                condition=Q(payment_order_id__isnull=False),
                name='uniq_membership_change_payment_order',
            ),
            models.UniqueConstraint(
                fields=['organization'],
                condition=Q(
                    status__in=['pending', 'scheduled'],
                    change_type__in=['downgrade', 'switch'],
                ),
                name='uniq_active_membership_plan_per_org',
            ),
            models.CheckConstraint(
                check=Q(payment_order_id__isnull=True) | ~Q(payment_order_id=''),
                name='membership_change_payment_order_nonempty',
            ),
        ]
        indexes = [
            models.Index(
                fields=['organization', 'created_at'],
                name='memchg_org_created_idx',
            ),
            models.Index(
                fields=['organization', 'status', 'effective_at'],
                name='memchg_org_status_eff_idx',
            ),
            models.Index(
                fields=['membership', 'created_at'],
                name='memchg_member_created_idx',
            ),
            models.Index(
                fields=['change_type', 'status'],
                name='memchg_type_status_idx',
            ),
        ]

    def clean(self):
        super().clean()
        if not str(self.payment_order_id or '').strip():
            self.payment_order_id = None

    def save(self, *args, **kwargs):
        if not str(self.payment_order_id or '').strip():
            self.payment_order_id = None
        super().save(*args, **kwargs)

    def mark_applied(self, *, at=None):
        self.status = self.Status.APPLIED
        self.applied_at = at or timezone.now()
        self.save(update_fields=['status', 'applied_at', 'updated_at'])

    def mark_failed(self, *, reason=''):
        self.status = self.Status.FAILED
        if reason:
            self.reason = reason
        self.save(update_fields=['status', 'reason', 'updated_at'])

    def mark_cancelled(self, *, reason=''):
        self.status = self.Status.CANCELLED
        if reason:
            self.reason = reason
        self.save(update_fields=['status', 'reason', 'updated_at'])
