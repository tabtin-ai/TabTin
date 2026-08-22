"""
计费中心模型

organization 引用口径（ 墓碑管线拍板）：
- **操作数据**（清理作业 ``OrganizationLifecycleCleanupService`` 负责删的表）：
  挂真 FK ``on_delete=PROTECT``，``db_column='organization_id'`` 保持列名。
  墓碑管线保证删除顺序（子行先于组织行消失），PROTECT 仅作误删兜底；
  不用 CASCADE，避免大表级联删回到同步事务超时。
- **审计 / 对账 / 清理作业记录**：保持 CharField 软引用（规范例外）——
  这些表的存在意义就是组织删除后还能查账，不能随组织行消失，也不能
  阻断组织行删除。逐表注释注明。
- user 维度（user_id / purchased_by / operator_user_id 等）本批不动，
  待用户删除语义拍板（见  评论）。
"""

import re
import uuid
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models, transaction
from django.utils import timezone


def generate_usage_event_idempotency_key() -> str:
    return uuid.uuid4().hex


_PROVIDER_CREDIT_PROVIDER_KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")


def normalize_provider_credit_provider_key(value: str) -> str:
    """规范化 Provider Credit 使用的稳定供应商键。"""
    normalized = str(value or "").strip().lower()
    if not _PROVIDER_CREDIT_PROVIDER_KEY_PATTERN.fullmatch(normalized):
        raise ValidationError(
            {"provider_key": "provider_key 必须为 3-64 位小写字母、数字、点、下划线或连字符"}
        )
    return normalized


def normalize_provider_credit_model_ids(value) -> list[str]:
    """把模型 UUID 数组规范化为去重后的 canonical UUID 字符串。"""
    if value in (None, ""):
        return []
    if not isinstance(value, (list, tuple)):
        raise ValidationError({"eligible_model_ids": "eligible_model_ids 必须是 JSON Array"})

    normalized: list[str] = []
    seen: set[str] = set()
    for raw_model_id in value:
        try:
            model_id = str(uuid.UUID(str(raw_model_id)))
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValidationError(
                {"eligible_model_ids": "eligible_model_ids 只能包含模型 UUID"}
            ) from exc
        if model_id not in seen:
            seen.add(model_id)
            normalized.append(model_id)
    return normalized


def normalize_provider_credit_membership_plan_codes(value) -> list[str]:
    """规范化用于 Campaign 匹配的 MembershipTier.tier_type 数组。"""
    if value in (None, ""):
        return []
    if not isinstance(value, (list, tuple)):
        raise ValidationError(
            {"membership_plan_codes": "membership_plan_codes 必须是 JSON Array"}
        )

    normalized: list[str] = []
    seen: set[str] = set()
    for raw_code in value:
        code = str(raw_code or "").strip().lower()
        if not code:
            raise ValidationError(
                {"membership_plan_codes": "membership_plan_codes 不能包含空值"}
            )
        if len(code) > 50:
            raise ValidationError(
                {"membership_plan_codes": "membership plan code 不能超过 50 个字符"}
            )
        if code not in seen:
            seen.add(code)
            normalized.append(code)
    return normalized


class MeterPricing(models.Model):
    """计量项定价规则"""

    SCOPE_CHOICES = [
        ("global", "全局"),
        ("organization", "组织"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    meter_key = models.CharField(max_length=200, db_index=True, verbose_name="计量项")
    scope = models.CharField(
        max_length=20,
        choices=SCOPE_CHOICES,
        default="global",
        db_index=True,
        verbose_name="作用域",
    )
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        blank=True,
        null=True,
        verbose_name="组织",
        help_text="scope=organization 时的专属定价主体；global 定价为 NULL。",
    )

    # 可选维度：用于覆盖渠道/模型的专属价格
    provider_key = models.CharField(
        max_length=100,
        blank=True,
        default="",
        db_index=True,
        verbose_name="渠道标识",
    )
    model_name = models.CharField(
        max_length=120,
        blank=True,
        default="",
        db_index=True,
        verbose_name="模型名称",
    )

    unit = models.CharField(max_length=40, default="unit", verbose_name="计价单位")
    unit_price = models.DecimalField(
        max_digits=18,
        decimal_places=8,
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="单价",
    )
    currency = models.CharField(max_length=12, default="CNY", verbose_name="币种")
    precision = models.PositiveSmallIntegerField(default=4, verbose_name="账务精度")

    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否启用")
    priority = models.IntegerField(default=0, verbose_name="优先级")
    effective_from = models.DateTimeField(default=timezone.now, db_index=True, verbose_name="生效开始时间")
    effective_to = models.DateTimeField(null=True, blank=True, db_index=True, verbose_name="生效结束时间")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_meter_pricing"
        verbose_name = "计量定价"
        verbose_name_plural = "计量定价"
        ordering = ["-priority", "-effective_from", "-created_at"]
        indexes = [
            models.Index(fields=["meter_key", "scope", "organization", "is_active"]),
            models.Index(fields=["provider_key", "model_name", "is_active"]),
            models.Index(fields=["effective_from", "effective_to"]),
        ]

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)

        def _invalidate():
            from apps.services.billing.services.pricing_service import MeterPricingService
            MeterPricingService.invalidate_cache()

        transaction.on_commit(_invalidate)

    def delete(self, *args, **kwargs):
        result = super().delete(*args, **kwargs)

        def _invalidate():
            from apps.services.billing.services.pricing_service import MeterPricingService
            MeterPricingService.invalidate_cache()

        transaction.on_commit(_invalidate)
        return result

    def __str__(self):
        target = self.organization_id if self.scope == "organization" else "global"
        return f"{self.meter_key}@{target}={self.unit_price}{self.currency}/{self.unit}"


class BillingUsageEvent(models.Model):
    """计费用量事件（organization 主体）"""

    CHARGE_STATUS_CHOICES = [
        ('charged', '已同步扣款'),
        ('pending', '待聚合'),
        ('aggregated', '已聚合扣款'),
        ('failed', '扣款失败'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        blank=True,
        null=True,
        verbose_name="组织",
        help_text="计费主体；极少数无法归因的 legacy 事件为 NULL（原空串语义）。",
    )
    user_id = models.CharField(max_length=36, blank=True, default="", db_index=True, verbose_name="用户ID")

    meter_key = models.CharField(max_length=200, db_index=True, verbose_name="计量项")
    quantity = models.DecimalField(max_digits=20, decimal_places=8, verbose_name="数量")
    unit = models.CharField(max_length=40, default="unit", verbose_name="单位")
    unit_price = models.DecimalField(max_digits=18, decimal_places=8, verbose_name="单价")
    amount = models.DecimalField(max_digits=20, decimal_places=8, verbose_name="金额")
    currency = models.CharField(max_length=12, default="CNY", verbose_name="币种")

    provider_key = models.CharField(max_length=100, blank=True, default="", verbose_name="渠道标识")
    model_name = models.CharField(max_length=120, blank=True, default="", verbose_name="模型名称")

    # 子 Agent 计费收尾（2026-05）：本笔扣费属于「哪类活」——主管对话 _main_chat /
    # 子 Agent _sub_agent / 后台压缩 _compact / 摘要评判 _summary_judge / 其他业务
    # scene_key。与 LLMUsageFact.scene_key **同源同值**（同一次网关请求的 ctx.scene_key
    # 同时写两表），让财务报表 / 导出能按「钱花在哪类活上」下钻。
    # ⚠️ 纯分类维度，**不参与任何金额计算**；非 LLM 事件（存储 / 短信 / 搜索等）留空，
    # 报表里归入「未分类」桶——按 scene_key 切分后金额总数恒等于不切分时的总数。
    # 不单独建字段级 db_index：下方两个复合索引（scene_key,occurred_at）/
    # (organization_id,scene_key,occurred_at) 的最左前缀已覆盖按 scene_key 的过滤与分组，
    # 单列索引在高频写入的扣费表上属冗余写开销。
    scene_key = models.CharField(
        max_length=100, blank=True, default="",
        verbose_name="场景标识",
    )

    biz_type = models.CharField(max_length=60, blank=True, default="", verbose_name="业务类型")
    biz_id = models.CharField(max_length=255, blank=True, default="", verbose_name="业务ID")
    idempotency_key = models.CharField(
        max_length=255,
        blank=True,
        default=generate_usage_event_idempotency_key,
        unique=True,
        verbose_name="幂等键",
    )
    logical_billing_key = models.CharField(
        max_length=255,
        blank=True,
        default="",
        verbose_name="逻辑计费键",
        help_text="同一次 Agent LLM 调用的稳定逻辑标识；provider retry attempt 共享。",
    )
    attempt_index = models.IntegerField(
        null=True,
        blank=True,
        verbose_name="Provider重试序号",
        help_text="同一逻辑计费键下的 provider 请求 attempt 序号；旧客户端为空。",
    )
    usage_source = models.CharField(
        max_length=64,
        blank=True,
        default="provider_final",
        verbose_name="用量来源",
        help_text="provider_final 表示采用上游最终 usage 结算。",
    )
    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")

    charge_status = models.CharField(
        max_length=20,
        choices=CHARGE_STATUS_CHOICES,
        default='charged',
        db_index=True,
        verbose_name='扣款状态',
    )
    charged_at = models.DateTimeField(
        null=True, blank=True,
        verbose_name='实际扣款时间',
    )
    aggregation_key = models.CharField(
        max_length=100, blank=True, default='',
        verbose_name='聚合批次ID',
    )

    occurred_at = models.DateTimeField(default=timezone.now, db_index=True, verbose_name="发生时间")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")

    class Meta:
        db_table = "services_billing_usage_event"
        verbose_name = "计费用量事件"
        verbose_name_plural = "计费用量事件"
        ordering = ["-occurred_at", "-created_at"]
        indexes = [
            models.Index(fields=["organization", "meter_key", "occurred_at"]),
            models.Index(fields=["meter_key", "occurred_at"]),
            models.Index(fields=["user_id", "occurred_at"]),
            models.Index(fields=["biz_type", "biz_id"]),
            models.Index(fields=["charge_status", "created_at"]),
            # 子 Agent 计费收尾：报表按 scene_key 下钻（含时间范围过滤）。
            models.Index(fields=["scene_key", "occurred_at"]),
            models.Index(fields=["organization", "scene_key", "occurred_at"]),
        ]

    def __str__(self):
        return f"{self.organization_id}:{self.meter_key}={self.quantity}({self.amount}{self.currency})"


class OrganizationCreditLedger(models.Model):
    """组织credits流水（AdminDash / 计费后台专用）。

    organization_id 保持软引用（ 规范例外——审计账本类）：含人工调整 /
    补偿 / 退款冲正等运营留痕，组织删除后仍需可查账，不随组织行消失，
    也不纳入 OrganizationLifecycleCleanupService 清理。
    """

    LEDGER_TYPE_CHOICES = [
        ("plan_included_grant", "套餐内赠"),
        ("resource_pack_purchase", "资源包购买"),
        ("system_gift", "系统赠送"),
        ("compensation", "补偿"),
        ("usage_consume", "用量扣减"),
        ("expire", "过期"),
        ("refund_reverse", "退款冲正"),
        ("manual_adjust", "人工调整"),
        ("legacy_derived", "历史兼容派生"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.CharField(max_length=100, db_index=True, verbose_name="组织ID")
    user_id = models.CharField(max_length=36, blank=True, default="", db_index=True, verbose_name="用户ID")
    ledger_type = models.CharField(
        max_length=40,
        choices=LEDGER_TYPE_CHOICES,
        db_index=True,
        verbose_name="流水类型",
    )
    amount_points = models.DecimalField(
        max_digits=20,
        decimal_places=4,
        verbose_name="变动 credits",
        help_text="正数=增加，负数=扣减",
    )
    balance_after_points = models.DecimalField(
        max_digits=20,
        decimal_places=4,
        null=True,
        blank=True,
        verbose_name="变更后余额（credits）",
    )
    related_usage_event_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        db_index=True,
        verbose_name="关联用量事件ID",
    )
    related_billing_event_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        db_index=True,
        verbose_name="关联计费事件ID",
    )
    related_wallet_transaction_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        verbose_name="关联钱包流水ID",
    )
    related_order_id = models.CharField(max_length=64, blank=True, default="", verbose_name="关联订单ID")
    related_invoice_id = models.CharField(max_length=64, blank=True, default="", verbose_name="关联账单ID")
    operator_admin_account_id = models.CharField(
        max_length=36,
        blank=True,
        default="",
        verbose_name="操作后台账号ID",
    )
    operator_user_id = models.CharField(
        max_length=36,
        blank=True,
        default="",
        db_index=True,
        verbose_name="操作用户ID",
    )
    reason = models.CharField(max_length=500, blank=True, default="", verbose_name="原因")
    ticket_id = models.CharField(max_length=128, blank=True, default="", verbose_name="工单ID")
    metadata_json = models.JSONField(default=dict, blank=True, verbose_name="扩展元数据")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="创建时间")

    class Meta:
        db_table = "services_billing_organization_credit_ledger"
        verbose_name = "组织credits流水"
        verbose_name_plural = "组织credits流水"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["organization_id", "created_at"]),
            models.Index(fields=["user_id", "created_at"]),
            models.Index(fields=["ledger_type", "created_at"]),
            models.Index(fields=["related_usage_event_id"]),
            models.Index(fields=["related_billing_event_id"]),
        ]

    def __str__(self):
        return f"{self.organization_id}:{self.ledger_type}:{self.amount_points}"


class ProviderCreditCampaign(models.Model):
    """供应商推广额度活动定义，不代表组织实际可用余额。"""

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        ACTIVE = "active", "生效"
        PAUSED = "paused", "暂停"
        ENDED = "ended", "结束"

    class TriggerType(models.TextChoices):
        MANUAL = "manual", "手动"
        NEW_ORG = "new_org", "新组织"
        MEMBERSHIP = "membership", "会员权益"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=100, unique=True, verbose_name="活动编码")
    name = models.CharField(max_length=200, verbose_name="活动名称")
    provider_key = models.CharField(max_length=64, verbose_name="供应商稳定标识")
    eligible_model_ids = models.JSONField(
        default=list,
        blank=True,
        verbose_name="可用模型UUID",
        help_text="空数组表示该 provider 下全部模型可用；非空时按模型 UUID 精确匹配。",
    )
    credits_amount = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="单次发放额度",
    )
    total_budget_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="活动总预算",
    )
    granted_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="已发放额度",
    )
    enabled = models.BooleanField(default=True, db_index=True, verbose_name="是否允许发放")
    trigger_type = models.CharField(
        max_length=20,
        choices=TriggerType.choices,
        default=TriggerType.MANUAL,
        db_index=True,
        verbose_name="自动发放触发类型",
    )
    membership_plan_codes = models.JSONField(
        default=list,
        blank=True,
        verbose_name="适用会员套餐编码",
        help_text="仅匹配 MembershipTier.tier_type；禁止使用展示名称。",
    )
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.ACTIVE,
        db_index=True,
        verbose_name="状态",
    )
    start_at = models.DateTimeField(default=timezone.now, db_index=True, verbose_name="开始时间")
    end_at = models.DateTimeField(null=True, blank=True, db_index=True, verbose_name="结束时间")
    expire_days = models.PositiveIntegerField(
        default=30,
        validators=[MinValueValidator(1)],
        verbose_name="发放后有效天数",
    )
    metadata = models.JSONField(default=dict, blank=True, verbose_name="扩展元数据")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_provider_credit_campaign"
        verbose_name = "供应商额度活动"
        verbose_name_plural = "供应商额度活动"
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                check=models.Q(credits_amount__gte=0)
                & models.Q(total_budget_credits__gte=0)
                & models.Q(granted_credits__gte=0),
                name="provider_credit_campaign_amounts_nonnegative",
            ),
            models.CheckConstraint(
                check=models.Q(granted_credits__lte=models.F("total_budget_credits")),
                name="provider_credit_campaign_granted_within_budget",
            ),
            models.CheckConstraint(
                check=models.Q(end_at__isnull=True) | models.Q(end_at__gt=models.F("start_at")),
                name="provider_credit_campaign_valid_window",
            ),
        ]
        indexes = [
            models.Index(
                fields=["provider_key", "status"],
                name="pcred_camp_prov_status_idx",
            ),
            models.Index(
                fields=["trigger_type", "enabled", "status"],
                name="pcred_camp_trigger_idx",
            ),
        ]

    def clean(self):
        super().clean()
        self.provider_key = normalize_provider_credit_provider_key(self.provider_key)
        self.eligible_model_ids = normalize_provider_credit_model_ids(self.eligible_model_ids)
        self.membership_plan_codes = normalize_provider_credit_membership_plan_codes(
            self.membership_plan_codes
        )
        self.code = str(self.code or "").strip()
        if not self.code:
            raise ValidationError({"code": "活动编码不能为空"})
        if self.end_at and self.end_at <= self.start_at:
            raise ValidationError({"end_at": "结束时间必须晚于开始时间"})
        if Decimal(str(self.credits_amount)) > Decimal(str(self.total_budget_credits)):
            raise ValidationError({"credits_amount": "单次发放额度不能超过活动总预算"})
        if (
            self.trigger_type == self.TriggerType.MEMBERSHIP
            and not self.membership_plan_codes
        ):
            raise ValidationError(
                {"membership_plan_codes": "membership 活动必须配置至少一个会员套餐编码"}
            )

    def save(self, *args, **kwargs):
        self.provider_key = normalize_provider_credit_provider_key(self.provider_key)
        self.eligible_model_ids = normalize_provider_credit_model_ids(self.eligible_model_ids)
        self.membership_plan_codes = normalize_provider_credit_membership_plan_codes(
            self.membership_plan_codes
        )
        self.code = str(self.code or "").strip()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.code}:{self.provider_key}"


class ProviderCreditGrant(models.Model):
    """组织从某个活动获得的一批供应商受限额度。"""

    class Status(models.TextChoices):
        ACTIVE = "active", "可用"
        EXHAUSTED = "exhausted", "已用尽"
        EXPIRED = "expired", "已过期"
        REVOKED = "revoked", "已撤销"

    class GrantSource(models.TextChoices):
        CAMPAIGN = "campaign", "活动"
        ADMIN = "admin", "管理员"
        MEMBERSHIP = "membership", "会员权益"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        "tabtinspace.Organization",
        on_delete=models.PROTECT,
        db_column="organization_id",
        related_name="provider_credit_grants",
        verbose_name="组织",
    )
    campaign = models.ForeignKey(
        ProviderCreditCampaign,
        on_delete=models.PROTECT,
        related_name="grants",
        verbose_name="活动",
    )
    provider_key = models.CharField(max_length=64, verbose_name="供应商稳定标识快照")
    eligible_model_ids = models.JSONField(
        default=list,
        blank=True,
        verbose_name="可用模型UUID快照",
    )
    total_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="发放总额",
    )
    consumed_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="已消费额度",
    )
    remaining_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="可用余额",
    )
    active_reserved_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="活跃预留额度",
        help_text="尚未结算的 BillingReservation 预留额度；不改变 remaining_credits。",
    )
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.ACTIVE,
        verbose_name="状态",
    )
    grant_source = models.CharField(
        max_length=20,
        choices=GrantSource.choices,
        default=GrantSource.CAMPAIGN,
        verbose_name="发放来源",
    )
    trigger_type = models.CharField(
        max_length=20,
        choices=ProviderCreditCampaign.TriggerType.choices,
        null=True,
        blank=True,
        verbose_name="自动发放触发类型",
    )
    effective_at = models.DateTimeField(default=timezone.now, verbose_name="生效时间")
    expire_at = models.DateTimeField(null=True, blank=True, verbose_name="过期时间")
    metadata = models.JSONField(default=dict, blank=True, verbose_name="扩展元数据")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_provider_credit_grant"
        verbose_name = "供应商额度发放"
        verbose_name_plural = "供应商额度发放"
        ordering = ["expire_at", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "campaign"],
                name="uniq_provider_credit_grant_org_campaign",
            ),
            models.CheckConstraint(
                check=models.Q(total_credits__gte=0)
                & models.Q(consumed_credits__gte=0)
                & models.Q(remaining_credits__gte=0),
                name="provider_credit_grant_balances_nonnegative",
            ),
            models.CheckConstraint(
                check=models.Q(active_reserved_credits__gte=0),
                name="pcred_reserved_nonnegative",
            ),
            models.CheckConstraint(
                check=models.Q(active_reserved_credits__lte=models.F("remaining_credits")),
                name="pcred_reserved_lte_remaining",
            ),
            models.CheckConstraint(
                check=models.Q(expire_at__isnull=True)
                | models.Q(expire_at__gt=models.F("effective_at")),
                name="provider_credit_grant_valid_window",
            ),
        ]
        indexes = [
            models.Index(
                fields=["organization", "status"],
                name="pcredit_grant_org_status_idx",
            ),
            models.Index(
                fields=["provider_key", "status"],
                name="pcred_grant_prov_stat_idx",
            ),
            models.Index(fields=["expire_at"], name="pcredit_grant_expire_idx"),
        ]

    def clean(self):
        super().clean()
        self.provider_key = normalize_provider_credit_provider_key(self.provider_key)
        self.eligible_model_ids = normalize_provider_credit_model_ids(self.eligible_model_ids)
        if self.expire_at and self.expire_at <= self.effective_at:
            raise ValidationError({"expire_at": "过期时间必须晚于生效时间"})

    def save(self, *args, **kwargs):
        self.provider_key = normalize_provider_credit_provider_key(self.provider_key)
        self.eligible_model_ids = normalize_provider_credit_model_ids(self.eligible_model_ids)
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.organization_id}:{self.provider_key}:{self.remaining_credits}"


class ProviderCreditTransaction(models.Model):
    """Provider Credit 的不可变余额流水。"""

    class TransactionType(models.TextChoices):
        GRANT = "grant", "发放"
        CONSUME = "consume", "消费"
        EXPIRE = "expire", "过期"
        REFUND = "refund", "退款"
        ADJUST = "adjust", "调整"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    grant = models.ForeignKey(
        ProviderCreditGrant,
        on_delete=models.PROTECT,
        db_index=False,
        related_name="transactions",
        verbose_name="发放批次",
    )
    organization = models.ForeignKey(
        "tabtinspace.Organization",
        on_delete=models.PROTECT,
        db_column="organization_id",
        related_name="provider_credit_transactions",
        verbose_name="组织",
    )
    transaction_type = models.CharField(
        max_length=20,
        choices=TransactionType.choices,
        verbose_name="流水类型",
    )
    amount = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        verbose_name="余额变动",
        help_text="发放/退款为正，消费/过期为负，调整可正可负。",
    )
    balance_after = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="变动后余额",
    )
    reference_type = models.CharField(max_length=64, blank=True, default="", verbose_name="关联类型")
    reference_id = models.CharField(max_length=128, blank=True, default="", verbose_name="关联ID")
    idempotency_key = models.CharField(max_length=255, unique=True, verbose_name="幂等键")
    metadata = models.JSONField(default=dict, blank=True, verbose_name="扩展元数据")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")

    class Meta:
        db_table = "services_billing_provider_credit_transaction"
        verbose_name = "供应商额度流水"
        verbose_name_plural = "供应商额度流水"
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                check=models.Q(balance_after__gte=0),
                name="provider_credit_transaction_balance_nonnegative",
            ),
        ]
        indexes = [
            models.Index(fields=["grant"], name="pcredit_tx_grant_idx"),
            models.Index(fields=["created_at"], name="pcredit_tx_created_idx"),
        ]

    def __str__(self):
        return f"{self.grant_id}:{self.transaction_type}:{self.amount}"


class OrganizationStorageUsage(models.Model):
    """组织附件空间使用快照"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.OneToOneField(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )

    # 当前有效占用
    active_file_count = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="当前有效文件数",
    )
    active_storage_bytes = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="当前有效占用字节",
    )

    # 累计统计
    total_uploaded_bytes = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="累计上传字节",
    )
    total_released_bytes = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="累计释放字节",
    )

    # 日末快照（方案 2.7 + 8.11：DB 持久化代替仅 Redis）
    eod_snapshot_bytes = models.BigIntegerField(default=0, verbose_name="日末快照字节数")
    eod_snapshot_date = models.DateField(null=True, blank=True, verbose_name="日末快照日期")

    last_metered_at = models.DateTimeField(null=True, blank=True, verbose_name="最近计量时间")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_organization_storage_usage"
        verbose_name = "组织附件空间使用"
        verbose_name_plural = "组织附件空间使用"
        ordering = ["-updated_at", "-created_at"]
        indexes = [
            models.Index(fields=["active_storage_bytes", "updated_at"]),
        ]

    def __str__(self):
        return f"{self.organization_id}: {self.active_storage_bytes} bytes"


class OrganizationBillingPolicy(models.Model):
    """组织计费策略"""

    STORAGE_BILLING_MODE_CHOICES = [
        ("package_only", "仅套餐"),
        ("paygo_only", "仅按量"),
        ("package_plus_paygo", "套餐+按量"),
    ]
    LLM_BILLING_MODE_CHOICES = [
        ("quota_then_paygo", "预算优先后按量"),
        ("paygo_only", "仅按量"),
        ("quota_only", "仅预算"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.OneToOneField(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )
    storage_billing_mode = models.CharField(
        max_length=40,
        choices=STORAGE_BILLING_MODE_CHOICES,
        default="package_plus_paygo",
        verbose_name="存储计费模式",
    )
    llm_billing_mode = models.CharField(
        max_length=40,
        choices=LLM_BILLING_MODE_CHOICES,
        default="quota_only",
        verbose_name="LLM计费模式",
    )
    currency = models.CharField(max_length=12, default="CREDITS", verbose_name="计费币种")

    # ── LLM 点券自动补充（quota_only 模式的配套能力）──
    # 点券（月度配额）用尽时，从组织钱包按管理员设定的金额扣款购买补充量，
    # 写入当月预算池 topup_credits（1 元 = CREDITS_PER_YUAN 点券）。
    auto_topup_enabled = models.BooleanField(default=False, verbose_name="LLM点券自动补充开关")
    auto_topup_spend_yuan = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("10"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="每次自动补充花费（元）",
    )
    auto_topup_threshold_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="自动补充触发阈值（配额剩余低于此值时触发）",
    )
    auto_topup_monthly_cap_yuan = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("100"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="每月自动补充花费上限（元）",
    )
    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否启用")
    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_organization_policy"
        verbose_name = "组织计费策略"
        verbose_name_plural = "组织计费策略"
        ordering = ["-updated_at", "-created_at"]
        indexes = [
            models.Index(fields=["organization", "is_active"]),
        ]

    def __str__(self):
        return (
            f"{self.organization_id}: storage={self.storage_billing_mode}, "
            f"llm={self.llm_billing_mode}"
        )


class OrganizationBillingEntitlement(models.Model):
    """组织权益快照（会员赠送 + 增值包）"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.OneToOneField(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )

    included_storage_bytes = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="赠送存储容量（字节）",
    )
    purchased_storage_bytes = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="增值包存储容量（字节）",
    )
    included_llm_credits_monthly = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="每月赠送LLM额度（credits）",
    )

    included_media_monthly = models.IntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="每月媒体生成张数",
    )
    included_search_monthly = models.IntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="每月联网搜索次数",
    )
    included_tts_monthly = models.IntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="每月TTS字符数",
    )

    effective_from = models.DateTimeField(default=timezone.now, db_index=True, verbose_name="生效开始时间")
    effective_to = models.DateTimeField(null=True, blank=True, db_index=True, verbose_name="生效结束时间")
    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否启用")
    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_organization_entitlement"
        verbose_name = "组织计费权益"
        verbose_name_plural = "组织计费权益"
        ordering = ["-updated_at", "-created_at"]
        indexes = [
            models.Index(fields=["organization", "is_active"]),
            models.Index(fields=["effective_from", "effective_to"]),
        ]

    @property
    def total_storage_package_bytes(self) -> int:
        return int(self.included_storage_bytes or 0) + int(self.purchased_storage_bytes or 0)

    def __str__(self):
        return (
            f"{self.organization_id}: storage={self.total_storage_package_bytes}B, "
            f"llm={self.included_llm_credits_monthly}"
        )


class StoragePackagePlan(models.Model):
    """OSS / 存储增值包配置。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120, verbose_name="套餐名称")
    description = models.TextField(blank=True, default="", verbose_name="套餐描述")
    price = models.DecimalField(
        max_digits=20,
        decimal_places=2,
        validators=[MinValueValidator(Decimal("0.01"))],
        verbose_name="售价（元）",
    )
    storage_bytes = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(1)],
        verbose_name="基础容量（字节）",
    )
    bonus_storage_bytes = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(0)],
        verbose_name="赠送容量（字节）",
    )
    duration_months = models.PositiveIntegerField(
        default=1,
        validators=[MinValueValidator(1)],
        verbose_name="有效期（月）",
    )
    sort_order = models.IntegerField(default=0, verbose_name="排序")
    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否启用")
    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_storage_package_plan"
        verbose_name = "存储套餐"
        verbose_name_plural = "存储套餐"
        ordering = ["sort_order", "-created_at"]
        indexes = [
            models.Index(fields=["is_active", "sort_order"]),
        ]

    @property
    def total_storage_bytes(self) -> int:
        return int(self.storage_bytes or 0) + int(self.bonus_storage_bytes or 0)

    def __str__(self):
        return f"{self.name}: {self.total_storage_bytes}B / {self.duration_months}m"


class OrganizationStorageSubscription(models.Model):
    """组织已购买的存储增值包实例。"""

    STATUS_CHOICES = [
        ("active", "生效中"),
        ("expired", "已过期"),
        ("cancelled", "已取消"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )
    package_plan = models.ForeignKey(
        StoragePackagePlan,
        on_delete=models.PROTECT,
        related_name="subscriptions",
        verbose_name="套餐",
    )
    order_id = models.CharField(
        max_length=36,
        blank=True,
        null=True,
        unique=True,
        db_index=True,
        verbose_name="关联支付订单ID",
    )
    purchased_by = models.CharField(max_length=36, blank=True, default="", verbose_name="购买用户ID")
    storage_bytes = models.BigIntegerField(
        default=0,
        validators=[MinValueValidator(1)],
        verbose_name="生效容量（字节）",
    )
    start_at = models.DateTimeField(default=timezone.now, db_index=True, verbose_name="开始时间")
    end_at = models.DateTimeField(db_index=True, verbose_name="结束时间")
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default="active",
        db_index=True,
        verbose_name="状态",
    )
    auto_renew = models.BooleanField(default=False, verbose_name="自动续费")
    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_organization_storage_subscription"
        verbose_name = "组织存储订阅"
        verbose_name_plural = "组织存储订阅"
        ordering = ["-end_at", "-created_at"]
        indexes = [
            models.Index(fields=["organization", "status", "end_at"]),
            models.Index(fields=["organization", "start_at"]),
        ]

    def __str__(self):
        return f"{self.organization_id}:{self.storage_bytes}B@{self.status}"


class AddonPackage(models.Model):
    """通用权益增值包配置。"""

    QUOTA_KEY_CHOICES = [
        ("max_tables", "表格数量"),
        ("max_documents", "文档数量"),
        ("max_groups", "群组数量"),
        ("storage_quota_bytes", "存储容量"),
        ("max_members", "成员席位"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    addon_code = models.CharField(max_length=80, unique=True, db_index=True, verbose_name="增值包编码")
    addon_name = models.CharField(max_length=120, verbose_name="增值包名称")
    description = models.TextField(blank=True, default="", verbose_name="增值包描述")
    price = models.DecimalField(
        max_digits=20,
        decimal_places=2,
        validators=[MinValueValidator(Decimal("0.01"))],
        verbose_name="售价（元）",
    )
    quota_key = models.CharField(max_length=64, choices=QUOTA_KEY_CHOICES, db_index=True, verbose_name="权益键")
    quota_value = models.BigIntegerField(
        validators=[MinValueValidator(1)],
        verbose_name="增加额度",
    )
    period_months = models.PositiveIntegerField(
        default=1,
        validators=[MinValueValidator(1)],
        verbose_name="有效期（月）",
    )
    sort_order = models.IntegerField(default=0, verbose_name="排序")
    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否启用")
    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_addon_package"
        verbose_name = "权益增值包"
        verbose_name_plural = "权益增值包"
        ordering = ["sort_order", "-created_at"]
        indexes = [
            models.Index(fields=["is_active", "sort_order"]),
            models.Index(fields=["quota_key", "is_active"]),
        ]

    def __str__(self):
        return f"{self.addon_name}: +{self.quota_value} {self.quota_key}"


class OrganizationAddonEntitlement(models.Model):
    """组织已购买的通用增值包权益实例。"""

    STATUS_CHOICES = [
        ("active", "生效中"),
        ("expired", "已过期"),
        ("cancelled", "已取消"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )
    addon_package = models.ForeignKey(
        AddonPackage,
        on_delete=models.PROTECT,
        related_name="entitlements",
        verbose_name="增值包",
    )
    order_id = models.CharField(
        max_length=36,
        blank=True,
        null=True,
        unique=True,
        db_index=True,
        verbose_name="关联支付订单ID",
    )
    quota_key = models.CharField(max_length=64, db_index=True, verbose_name="权益键")
    quota_value = models.BigIntegerField(validators=[MinValueValidator(1)], verbose_name="生效额度")
    starts_at = models.DateTimeField(default=timezone.now, db_index=True, verbose_name="开始时间")
    expires_at = models.DateTimeField(db_index=True, verbose_name="结束时间")
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default="active",
        db_index=True,
        verbose_name="状态",
    )
    purchased_by = models.CharField(max_length=36, blank=True, default="", verbose_name="购买用户ID")
    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_organization_addon_entitlement"
        verbose_name = "组织增值包权益"
        verbose_name_plural = "组织增值包权益"
        ordering = ["-expires_at", "-created_at"]
        indexes = [
            models.Index(fields=["organization", "status", "expires_at"]),
            models.Index(fields=["organization", "quota_key", "status"]),
            models.Index(fields=["starts_at", "expires_at"]),
        ]

    def __str__(self):
        return f"{self.organization_id}:{self.quota_key}+{self.quota_value}@{self.status}"


class OrganizationLlmMonthlyBudget(models.Model):
    """组织 LLM 月度预算池"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )
    cycle_month = models.DateField(db_index=True, verbose_name="结算月份（每月1号）")

    included_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="月度预算总额（credits）",
    )
    consumed_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="已消耗预算（credits）",
    )
    active_reserved_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="活跃预留预算（credits）",
        help_text="已被 BillingReservation 冻结、尚未结算的月度额度。",
    )
    # WAL-25: overflow_credits 语义说明：
    #   此字段仅记录 quota_only 模式下超出月度配额的"免费溢出量"（系统容忍的超支，不扣钱包）。
    #   quota_then_paygo 模式下超额部分走 paygo 扣钱包，不写入此字段（overflow_credits 恒为 0）。
    #   因此 overflow_credits ≠ "所有超额用量"，勿用于跨模式的超配统计。
    overflow_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="免费溢出量（quota_only 模式专用）",
        help_text="仅 quota_only 模式下超出配额的免费溢出量；quota_then_paygo 模式下超额走 paygo，此字段恒为 0。",
    )
    # 自动补充累计量：独立于 included_credits 存放（included_credits 会被权益同步
    # 动态刷新覆盖，不能混入补充量）。剩余配额 = included + topup - consumed。
    # 该字段同时是"本月自动补充进度"，与 auto_topup_monthly_cap_yuan 换算后的点券上限比较。
    topup_credits = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[MinValueValidator(Decimal("0"))],
        verbose_name="本月自动补充累计量（credits）",
    )
    updated_from_entitlement_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name="最近同步权益时间",
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_organization_llm_monthly_budget"
        verbose_name = "组织LLM月预算"
        verbose_name_plural = "组织LLM月预算"
        ordering = ["-cycle_month", "-updated_at"]
        unique_together = [["organization", "cycle_month"]]
        constraints = [
            models.CheckConstraint(
                check=models.Q(active_reserved_credits__gte=0),
                name="llmbudget_reserved_nonneg",
            ),
        ]
        indexes = [
            models.Index(fields=["organization", "cycle_month"]),
        ]

    @property
    def total_quota_credits(self) -> Decimal:
        """当月可用配额总量 = 权益赠送 + 自动补充。"""
        return Decimal(str(self.included_credits or 0)) + Decimal(str(self.topup_credits or 0))

    @property
    def remaining_credits(self) -> Decimal:
        remaining = self.total_quota_credits - Decimal(str(self.consumed_credits or 0))
        return remaining if remaining > 0 else Decimal("0")

    def __str__(self):
        return f"{self.organization_id}@{self.cycle_month}: {self.consumed_credits}/{self.included_credits}"


class BillingReservation(models.Model):
    """一次可计费 Provider 调用的资金冻结与恢复状态。"""

    class Status(models.TextChoices):
        RESERVED = "reserved", "已预留"
        EXECUTING = "executing", "执行中"
        SETTLEMENT_PENDING = "settlement_pending", "待结算"
        COMMITTED = "committed", "已结算"
        RELEASED = "released", "已释放"
        EXPIRED = "expired", "未执行过期"
        UNKNOWN = "unknown", "结果未知"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        "tabtinspace.Organization",
        on_delete=models.PROTECT,
        db_column="organization_id",
        related_name="+",
        verbose_name="计费组织",
    )
    user_id = models.CharField(max_length=36, db_index=True, verbose_name="用户ID")
    logical_search_invocation_id = models.UUIDField(verbose_name="逻辑搜索调用ID")
    request_fingerprint = models.CharField(max_length=64, verbose_name="请求指纹")
    fingerprint_version = models.CharField(max_length=32, verbose_name="指纹版本")
    meter_key = models.CharField(max_length=200, db_index=True, verbose_name="计量项")
    quantity = models.DecimalField(max_digits=20, decimal_places=8, verbose_name="数量")
    unit = models.CharField(max_length=40, default="request", verbose_name="单位")
    pricing_rule = models.ForeignKey(
        "MeterPricing",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
        verbose_name="定价规则快照来源",
    )
    unit_price = models.DecimalField(max_digits=18, decimal_places=8, verbose_name="冻结单价")
    total_credits = models.DecimalField(max_digits=20, decimal_places=8, verbose_name="冻结总点券")
    funding_mode = models.CharField(max_length=40, verbose_name="资金模式快照")
    provider_key = models.CharField(max_length=100, blank=True, default="", verbose_name="搜索渠道")
    biz_type = models.CharField(max_length=60, blank=True, default="", verbose_name="业务类型")
    thread_id = models.CharField(max_length=128, blank=True, default="", verbose_name="会话ID")
    status = models.CharField(
        max_length=32,
        choices=Status.choices,
        default=Status.RESERVED,
        db_index=True,
        verbose_name="状态",
    )
    generation = models.PositiveIntegerField(default=1, verbose_name="执行代次")
    reserved_at = models.DateTimeField(default=timezone.now, verbose_name="预留时间")
    lease_expires_at = models.DateTimeField(db_index=True, verbose_name="租约到期时间")
    execution_started_at = models.DateTimeField(null=True, blank=True, verbose_name="执行开始时间")
    provider_finished_at = models.DateTimeField(null=True, blank=True, verbose_name="Provider完成时间")
    settled_at = models.DateTimeField(null=True, blank=True, verbose_name="结算时间")
    released_at = models.DateTimeField(null=True, blank=True, verbose_name="释放时间")
    result_reference = models.CharField(max_length=255, blank=True, default="", verbose_name="结果引用")
    result_metadata = models.JSONField(default=dict, blank=True, verbose_name="安全结果元数据")
    first_seen_at = models.DateTimeField(null=True, blank=True, verbose_name="首次异常时间")
    last_checked_at = models.DateTimeField(null=True, blank=True, verbose_name="最近核查时间")
    next_recovery_at = models.DateTimeField(null=True, blank=True, db_index=True, verbose_name="下次恢复时间")
    recovery_attempt_count = models.PositiveIntegerField(default=0, verbose_name="恢复次数")
    resolution_reason = models.CharField(max_length=255, blank=True, default="", verbose_name="处置原因")
    resolved_by = models.CharField(max_length=100, blank=True, default="", verbose_name="处置人")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_reservation"
        verbose_name = "计费预留"
        verbose_name_plural = "计费预留"
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "logical_search_invocation_id"],
                name="uniq_billing_reservation_org_search_invocation",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "lease_expires_at"], name="bill_res_status_lease_idx"),
            models.Index(fields=["status", "next_recovery_at"], name="bill_res_status_recover_idx"),
            models.Index(fields=["organization", "created_at"], name="bill_res_org_created_idx"),
        ]


class BillingReservationAllocation(models.Model):
    """Reservation 冻结的不可重选资金切片。"""

    class Status(models.TextChoices):
        RESERVED = "reserved", "已预留"
        COMMITTED = "committed", "已结算"
        RELEASED = "released", "已释放"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reservation = models.ForeignKey(
        BillingReservation,
        on_delete=models.CASCADE,
        related_name="allocations",
        verbose_name="计费预留",
    )
    source_type = models.CharField(max_length=40, db_index=True, verbose_name="资金来源")
    source_reference = models.CharField(max_length=255, verbose_name="来源引用")
    provider_credit_grant = models.ForeignKey(
        ProviderCreditGrant,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
    )
    monthly_budget = models.ForeignKey(
        OrganizationLlmMonthlyBudget,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
    )
    organization_wallet = models.ForeignKey(
        "wallet.OrganizationWallet",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
    )
    credits = models.DecimalField(max_digits=20, decimal_places=8, verbose_name="冻结点券")
    metadata = models.JSONField(default=dict, blank=True, verbose_name="资金快照")
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.RESERVED,
        db_index=True,
    )
    committed_at = models.DateTimeField(null=True, blank=True)
    released_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "services_billing_reservation_allocation"
        constraints = [
            models.UniqueConstraint(
                fields=["reservation", "source_type", "source_reference"],
                name="uniq_billing_reservation_allocation_source",
            ),
        ]
        indexes = [
            models.Index(fields=["reservation", "status"], name="bill_res_alloc_status_idx"),
        ]


class ProviderAttempt(models.Model):
    """Provider 执行证据；禁止保存 query、完整工具参数或凭证。"""

    class Outcome(models.TextChoices):
        STARTED = "started", "已开始"
        SUCCEEDED = "succeeded", "成功"
        FAILED = "failed", "明确失败"
        UNKNOWN = "unknown", "结果未知"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reservation = models.ForeignKey(
        BillingReservation,
        on_delete=models.CASCADE,
        related_name="provider_attempts",
    )
    provider_key = models.CharField(max_length=100, verbose_name="Provider")
    attempt_number = models.PositiveIntegerField(default=1)
    generation = models.PositiveIntegerField(default=1)
    started_at = models.DateTimeField(default=timezone.now)
    finished_at = models.DateTimeField(null=True, blank=True)
    outcome = models.CharField(
        max_length=20,
        choices=Outcome.choices,
        default=Outcome.STARTED,
        db_index=True,
    )
    provider_request_id = models.CharField(max_length=255, blank=True, default="")
    error_code = models.CharField(max_length=100, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "services_billing_provider_attempt"
        constraints = [
            models.UniqueConstraint(
                fields=["reservation", "generation", "attempt_number"],
                name="uniq_provider_attempt_res_generation_number",
            ),
        ]
        indexes = [
            models.Index(fields=["reservation", "outcome"], name="bill_prov_attempt_out_idx"),
        ]


class BillingUsageDaily(models.Model):
    """组织按天聚合的计费用量"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )
    usage_date = models.DateField(db_index=True, verbose_name="用量日期")
    meter_key = models.CharField(max_length=200, db_index=True, verbose_name="计量项")

    quantity = models.DecimalField(max_digits=24, decimal_places=8, verbose_name="聚合数量")
    amount = models.DecimalField(max_digits=24, decimal_places=8, verbose_name="聚合金额")
    currency = models.CharField(max_length=12, default="CREDITS", verbose_name="币种")
    source_event_count = models.BigIntegerField(default=0, validators=[MinValueValidator(0)], verbose_name="来源事件数")
    extra = models.JSONField(default=dict, verbose_name="扩展数据")

    generated_at = models.DateTimeField(default=timezone.now, verbose_name="生成时间")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_usage_daily"
        verbose_name = "计费日聚合"
        verbose_name_plural = "计费日聚合"
        ordering = ["-usage_date", "-updated_at"]
        unique_together = [["organization", "usage_date", "meter_key"]]
        indexes = [
            models.Index(fields=["organization", "usage_date"]),
            models.Index(fields=["organization", "meter_key", "usage_date"]),
        ]

    def __str__(self):
        return f"{self.organization_id}:{self.usage_date}:{self.meter_key}"


class BillingInvoice(models.Model):
    """组织账单"""

    STATUS_CHOICES = [
        ("draft", "草稿"),
        ("open", "待支付"),
        ("paid", "已支付"),
        ("failed", "扣款失败"),
        ("cancelled", "已取消"),
        ("refunded", "已退款"),
        ("partially_refunded", "部分退款"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    invoice_no = models.CharField(max_length=40, unique=True, db_index=True, verbose_name="账单号")
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )

    period_start = models.DateField(db_index=True, verbose_name="账期开始")
    period_end = models.DateField(db_index=True, verbose_name="账期结束")
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default="draft",
        db_index=True,
        verbose_name="状态",
    )

    currency = models.CharField(max_length=12, default="CREDITS", verbose_name="币种")
    subtotal_amount = models.DecimalField(
        max_digits=24,
        decimal_places=8,
        default=Decimal("0"),
        verbose_name="小计",
    )
    discount_amount = models.DecimalField(
        max_digits=24,
        decimal_places=8,
        default=Decimal("0"),
        verbose_name="优惠",
    )
    total_amount = models.DecimalField(
        max_digits=24,
        decimal_places=8,
        default=Decimal("0"),
        verbose_name="应付总额",
    )
    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")
    collection_attempt_count = models.IntegerField(default=0, db_index=True, verbose_name="扣款尝试次数")
    refunded_amount = models.DecimalField(
        max_digits=24, decimal_places=8, default=Decimal("0"),
        verbose_name="已退款金额",
    )
    refunded_at = models.DateTimeField(null=True, blank=True, verbose_name="退款时间")

    issued_at = models.DateTimeField(null=True, blank=True, verbose_name="出账时间")
    paid_at = models.DateTimeField(null=True, blank=True, verbose_name="支付时间")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_invoice"
        verbose_name = "账单"
        verbose_name_plural = "账单"
        ordering = ["-period_start", "-created_at"]
        unique_together = [["organization", "period_start", "period_end"]]
        indexes = [
            models.Index(fields=["organization", "status", "period_start"]),
            models.Index(fields=["period_start", "period_end"]),
        ]

    def __str__(self):
        return f"{self.invoice_no}({self.organization_id})"


class BillingInvoiceLine(models.Model):
    """账单明细"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    invoice = models.ForeignKey(
        BillingInvoice,
        on_delete=models.CASCADE,
        related_name="lines",
        verbose_name="所属账单",
    )
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )
    meter_key = models.CharField(max_length=200, db_index=True, verbose_name="计量项")
    description = models.CharField(max_length=255, blank=True, default="", verbose_name="描述")

    quantity = models.DecimalField(max_digits=24, decimal_places=8, verbose_name="数量")
    unit = models.CharField(max_length=40, default="unit", verbose_name="单位")
    unit_price = models.DecimalField(max_digits=24, decimal_places=8, verbose_name="单价")
    amount = models.DecimalField(max_digits=24, decimal_places=8, verbose_name="金额")
    metadata = models.JSONField(default=dict, verbose_name="扩展元数据")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")

    class Meta:
        db_table = "services_billing_invoice_line"
        verbose_name = "账单明细"
        verbose_name_plural = "账单明细"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["invoice", "meter_key"]),
            models.Index(fields=["organization", "meter_key"]),
        ]

    def __str__(self):
        return f"{self.invoice_id}:{self.meter_key}:{self.amount}"


class BillingBudgetPolicy(models.Model):
    """用量预算阈值策略（按组织），从 LLM 模块迁移至 billing 模块"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.OneToOneField(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )
    warning_threshold_percent = models.DecimalField(
        max_digits=6,
        decimal_places=2,
        default=Decimal("80"),
        validators=[MinValueValidator(Decimal("0")), MaxValueValidator(Decimal("500"))],
        verbose_name="预警阈值(%)",
    )
    critical_threshold_percent = models.DecimalField(
        max_digits=6,
        decimal_places=2,
        default=Decimal("100"),
        validators=[MinValueValidator(Decimal("0")), MaxValueValidator(Decimal("500"))],
        verbose_name="严重阈值(%)",
    )
    block_on_critical = models.BooleanField(
        default=False,
        verbose_name="严重阈值硬阻断",
        help_text="启用后，达到严重阈值时将拒绝新的请求",
    )
    budget_limit_credits = models.DecimalField(
        max_digits=16,
        decimal_places=4,
        null=True,
        blank=True,
        default=None,
        verbose_name="显式预算上限(credits)",
        help_text="XM-16: 与 included_credits 解耦的独立预算上限。"
                  "设置后优先使用此值作为预算告警分母，"
                  "解决 free tier included=0 时预算告警永不触发的问题。",
    )
    is_active = models.BooleanField(default=True, verbose_name="是否启用")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_budget_policy"
        verbose_name = "用量预算策略"
        verbose_name_plural = "用量预算策略"
        ordering = ["organization"]
        indexes = [
            models.Index(fields=["organization", "is_active"], name="billing_budget_ws_idx"),
        ]

    def clean(self):
        """GRD-22: 校验 warning < critical，防止跳过 warning 直接 critical。"""
        from django.core.exceptions import ValidationError

        super().clean()
        w = self.warning_threshold_percent
        c = self.critical_threshold_percent
        if w is not None and c is not None and w > c:
            raise ValidationError(
                {
                    "warning_threshold_percent": (
                        f"预警阈值 ({w}%) 不能大于严重阈值 ({c}%)，"
                        "否则永远无法触发 warning 直接跳到 critical，违背渐进告警语义。"
                    ),
                }
            )

    def save(self, *args, **kwargs):
        w = self.warning_threshold_percent
        c = self.critical_threshold_percent
        if w is not None and c is not None and w > c:
            raise ValueError(
                f"warning_threshold_percent ({w}) 不能大于 critical_threshold_percent ({c})"
            )
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.organization_id}: {self.warning_threshold_percent}/{self.critical_threshold_percent}"


class BillingAdminAuditLog(models.Model):
    """Billing 管理员操作审计日志

    organization_id 保持软引用（ 规范例外——审计类）：审计日志必须在
    组织删除后留存可查，不挂 FK、不阻断组织行物理删除。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    admin_user_id = models.CharField(max_length=36, db_index=True, verbose_name="管理员ID")
    action = models.CharField(max_length=50, db_index=True, verbose_name="操作动作")
    target_type = models.CharField(max_length=50, db_index=True, verbose_name="目标类型")
    target_id = models.CharField(max_length=100, verbose_name="目标ID")
    organization_id = models.CharField(max_length=100, blank=True, db_index=True, verbose_name="组织ID")
    detail = models.JSONField(default=dict, verbose_name="变更详情")
    ip_address = models.CharField(max_length=45, blank=True, verbose_name="IP地址")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="创建时间")

    class Meta:
        db_table = "services_billing_admin_audit_log"
        verbose_name = "计费审计日志"
        verbose_name_plural = "计费审计日志"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["admin_user_id", "created_at"], name="billing_audit_admin_idx"),
            models.Index(fields=["action", "target_type"], name="billing_audit_action_idx"),
        ]

    def __str__(self):
        return f"{self.action}:{self.target_type}:{self.target_id}"


class OrganizationLifecycleCleanupJob(models.Model):
    """organization 删除后的 default DB 清理作业。

    organization_id 保持软引用（ 规范例外——清理作业记录类）：作业记录
    本身就是「组织删除后」的执行凭证（墓碑管线终步由它驱动），必须在组织行
    物理删除后继续存在，天然不能挂 FK。
    """

    STATUS_CHOICES = [
        ("pending", "待执行"),
        ("running", "执行中"),
        ("succeeded", "已成功"),
        ("failed", "待重试"),
        ("permanently_failed", "永久失败"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.CharField(max_length=100, unique=True, db_index=True, verbose_name="组织ID")
    trigger_source = models.CharField(max_length=50, default="organization_delete", db_index=True, verbose_name="触发来源")
    status = models.CharField(
        max_length=30,
        choices=STATUS_CHOICES,
        default="pending",
        db_index=True,
        verbose_name="状态",
    )
    attempt_count = models.PositiveIntegerField(default=0, verbose_name="已尝试次数")
    max_attempts = models.PositiveIntegerField(default=6, verbose_name="最大尝试次数")
    last_error = models.TextField(blank=True, default="", verbose_name="最后一次错误")
    next_retry_at = models.DateTimeField(null=True, blank=True, db_index=True, verbose_name="下次重试时间")
    last_success_summary = models.JSONField(default=dict, verbose_name="最近成功清理摘要")
    started_at = models.DateTimeField(null=True, blank=True, verbose_name="最近开始时间")
    finished_at = models.DateTimeField(null=True, blank=True, verbose_name="最近完成时间")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_organization_lifecycle_cleanup_job"
        verbose_name = "组织生命周期清理作业"
        verbose_name_plural = "组织生命周期清理作业"
        ordering = ["status", "next_retry_at", "-updated_at"]
        indexes = [
            models.Index(fields=["status", "next_retry_at"], name="billing_cleanup_due_idx"),
            models.Index(fields=["trigger_source", "created_at"], name="billing_cleanup_trigger_idx"),
        ]

    def __str__(self):
        return f"{self.organization_id}:{self.status}({self.attempt_count}/{self.max_attempts})"


class BillingReconciliationReport(models.Model):
    """计费对账报告

    organization_id 保持软引用（ 规范例外——对账类）：对账报告在组织
    删除后仍需留档追溯，且空串表示全局汇总行，语义上不指向单一组织。
    """

    STATUS_CHOICES = [
        ("matched", "匹配"),
        ("warning", "差异预警"),
        ("mismatch", "严重不匹配"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    report_date = models.DateField(db_index=True, verbose_name="对账日期")
    organization_id = models.CharField(
        max_length=100, blank=True, default="", db_index=True,
        verbose_name="组织ID",
        help_text="空=全局汇总",
    )
    billing_total = models.DecimalField(
        max_digits=20, decimal_places=8, default=Decimal("0"),
        verbose_name="BillingUsageEvent 汇总金额",
    )
    wallet_total = models.DecimalField(
        max_digits=20, decimal_places=8, default=Decimal("0"),
        verbose_name="WalletTransaction 消费汇总",
    )
    diff_amount = models.DecimalField(
        max_digits=20, decimal_places=8, default=Decimal("0"),
        verbose_name="差额（billing - wallet）",
    )
    diff_pct = models.DecimalField(
        max_digits=10, decimal_places=4, default=Decimal("0"),
        verbose_name="差异百分比",
    )
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default="matched",
        db_index=True, verbose_name="对账状态",
    )
    detail_json = models.JSONField(default=dict, verbose_name="详细信息")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")

    class Meta:
        db_table = "services_billing_reconciliation_report"
        verbose_name = "计费对账报告"
        verbose_name_plural = "计费对账报告"
        ordering = ["-report_date", "-created_at"]
        unique_together = [["report_date", "organization_id"]]
        indexes = [
            models.Index(fields=["report_date", "status"]),
        ]

    def __str__(self):
        ws = self.organization_id or "GLOBAL"
        return f"{self.report_date}@{ws}: {self.status} diff={self.diff_amount}"


class OrganizationServicePolicy(models.Model):
    """组织服务开关策略（控制各计费服务的启用/禁用和自动化行为）"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.OneToOneField(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )

    enable_media_image = models.BooleanField(default=True, verbose_name="AI 文生图")
    enable_media_video = models.BooleanField(default=True, verbose_name="AI 视频生成")
    enable_media_audio = models.BooleanField(default=True, verbose_name="AI 音频/BGM 生成")
    enable_speech_asr = models.BooleanField(default=True, verbose_name="语音识别")
    enable_speech_tts = models.BooleanField(default=True, verbose_name="语音合成")
    enable_rag_embedding = models.BooleanField(default=True, verbose_name="RAG 向量化")
    enable_web_search = models.BooleanField(default=True, verbose_name="网页搜索")
    enable_docparse = models.BooleanField(default=True, verbose_name="文档解析")

    enable_auto_doc_index = models.BooleanField(default=True, verbose_name="文档自动索引")
    enable_auto_code_index = models.BooleanField(default=True, verbose_name="代码自动索引")

    created_at = models.DateTimeField(auto_now_add=True, null=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")
    updated_by = models.CharField(max_length=64, blank=True, default="", verbose_name="更新人")

    class Meta:
        db_table = "services_billing_organization_service_policy"
        verbose_name = "组织服务策略"
        verbose_name_plural = "组织服务策略"

    SERVICE_KEY_FIELD_MAP = {
        "media.image": "enable_media_image",
        "media.video": "enable_media_video",
        "media.audio": "enable_media_audio",
        "speech.asr": "enable_speech_asr",
        "speech.tts": "enable_speech_tts",
        "rag.embedding": "enable_rag_embedding",
        "web.search": "enable_web_search",
        "docparse": "enable_docparse",
    }

    def is_service_enabled(self, service_key: str) -> bool:
        field = self.SERVICE_KEY_FIELD_MAP.get(service_key)
        if field is None:
            return True
        return bool(getattr(self, field, True))

    def __str__(self):
        return f"ServicePolicy({self.organization_id})"


class BillingRuntimeConfig(models.Model):
    """计费运行时参数配置（单例模式）。

    将原本硬编码在代码中的计费参数集中管理，支持通过 AdminDash 实时调整。
    每个参数都有合理默认值，缺省时回退到默认值不影响系统运行。
    """

    id = models.AutoField(primary_key=True)

    credits_per_yuan = models.IntegerField(
        default=100,
        verbose_name="credits/元换算比例",
        help_text="1 元 = N credits，影响冻结金额预估和前端费用展示",
    )
    min_balance_threshold = models.DecimalField(
        max_digits=10, decimal_places=4, default=Decimal("0.01"),
        verbose_name="余额放行最低阈值（credits）",
        help_text="组织可用余额低于此值时阻断 LLM 调用",
    )
    freeze_fallback_credits = models.DecimalField(
        max_digits=10, decimal_places=4, default=Decimal("0.5"),
        verbose_name="冻结保底金额（credits）",
        help_text="首轮或无法估算时的保底冻结金额",
    )
    freeze_est_input_tokens = models.IntegerField(
        default=2000,
        verbose_name="首轮冻结预估输入 tokens",
    )
    freeze_est_output_tokens = models.IntegerField(
        default=500,
        verbose_name="首轮冻结预估输出 tokens",
    )
    precheck_fail_threshold = models.IntegerField(
        default=10,
        verbose_name="Fail-open 连续异常阈值",
        help_text="预检连续异常超过此次数后切换为 fail-closed",
    )
    failopen_max_credits = models.DecimalField(
        max_digits=10, decimal_places=4, default=Decimal("10"),
        verbose_name="Fail-open 累计金额上限（credits）",
        help_text="fail-open 期间允许的最大累计放行金额",
    )
    precheck_fail_window = models.IntegerField(
        default=60,
        verbose_name="Fail-open 异常窗口（秒）",
        help_text="超过此秒数无新异常时自动重置计数器",
    )
    balance_recheck_interval = models.IntegerField(
        default=1,
        verbose_name="余额复检间隔（每 N 轮）",
        help_text="Agent 运行中每 N 轮 LLM 调用复检一次余额",
    )
    stale_freeze_threshold_minutes = models.IntegerField(
        default=120,
        verbose_name="冻结超时阈值（分钟）",
        help_text="超过此时长未结算/释放的冻结将被定时任务清理",
    )
    pricing_cache_ttl = models.IntegerField(
        default=60,
        verbose_name="定价缓存 TTL（秒）",
        help_text="MeterPricing 查询结果的 Redis 缓存有效期",
    )
    cache_discount_config = models.JSONField(
        default=dict, blank=True,
        verbose_name="Provider 缓存折扣率配置",
        help_text='格式: {"anthropic": {"cache_read_ratio": 0.1, "cache_write_ratio": 1.25}, ...}',
    )
    show_per_message_cost = models.BooleanField(
        default=True,
        verbose_name="展示每条消息费用",
        help_text=(
            "是否在前端 assistant 消息气泡上展示本条消息消耗的 credits 数。"
            "PRD-04 Wave 5：默认 True（透明承诺），管理员可按需关闭。"
        ),
    )
    sync_charge_threshold_credits = models.IntegerField(
        default=100,
        verbose_name='同步扣款阈值（credits）',
        help_text='单次预期金额 ≥ 此值走同步扣款，否则进入异步聚合',
    )
    fail_open_24h_block_threshold = models.IntegerField(
        default=50,
        verbose_name='Fail-open 24h 阻断阈值',
        help_text='单 organization 在 24 小时内 fail-open 累计超过此次数后自动冻结服务',
    )
    internal_llm_call_balance_guard_pct = models.IntegerField(
        default=20,
        verbose_name='内部 LLM 调用余额守护百分比',
        help_text='internal_llm_call 一小时累计成本超过 max(余额×此百分比, floor) 时强制阻断',
    )
    internal_llm_call_balance_guard_floor = models.IntegerField(
        default=500,
        verbose_name='内部 LLM 调用余额守护下限（credits）',
        help_text='与百分比取 max，避免低余额时误杀基础记忆功能',
    )
    large_charge_review_threshold_credits = models.IntegerField(
        default=1000,
        verbose_name='大额扣费审核阈值（credits）',
        help_text='单次扣费超过此值进入待审核，不直接扣款',
    )

    degradation_window_seconds = models.IntegerField(
        default=3600,
        verbose_name="降级追踪窗口（秒）",
        help_text="降级事件累计的时间窗口，默认 3600 秒（1 小时）",
    )
    degradation_alert_threshold = models.IntegerField(
        default=10,
        verbose_name="降级告警阈值",
        help_text="窗口内累计降级次数超过此值时触发告警，默认 10",
    )

    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")
    updated_by = models.CharField(
        max_length=100, blank=True, default="",
        verbose_name="更新人",
    )

    class Meta:
        db_table = "services_billing_runtime_config"
        verbose_name = "计费运行时配置"
        verbose_name_plural = "计费运行时配置"

    def __str__(self):
        return f"BillingRuntimeConfig (updated: {self.updated_at})"

    @classmethod
    def get_instance(cls) -> "BillingRuntimeConfig":
        """获取单例实例，不存在时使用默认值创建。"""
        instance, _ = cls.objects.get_or_create(pk=1)
        return instance


class BillingAnomalyAlert(models.Model):
    """计费异常告警

    organization_id 保持软引用（ 规范例外——告警/审计类）：cleanup_failed
    类告警在组织删除流程中/之后创建（墓碑终步失败时也会写入），必须能指向
    已消失或即将消失的组织，不能挂 FK。
    """

    ALERT_TYPE_CHOICES = [
        ("spike", "消费突增"),
        ("abuse", "疑似滥用"),
        ("pattern", "异常模式"),
        ("charge_failed", "计费失败"),
        ("cleanup_failed", "清理失败"),
        ("frozen_leak", "冻结泄漏"),
        ("refund_inconsistency", "退款不一致"),
        ("zero_price_model", "零价格模型"),
        ("event_update_failed", "占位更新失败"),
        ("storage_critical", "存储用量严重"),
        ("storage_no_price", "存储无定价"),
    ]
    SEVERITY_CHOICES = [
        ("info", "信息"),
        ("warning", "警告"),
        ("critical", "严重"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    alert_type = models.CharField(
        max_length=32, choices=ALERT_TYPE_CHOICES, db_index=True,
        verbose_name="告警类型",
    )
    severity = models.CharField(
        max_length=20, choices=SEVERITY_CHOICES, default="warning",
        db_index=True, verbose_name="严重程度",
    )
    organization_id = models.CharField(
        max_length=100, blank=True, default="", db_index=True,
        verbose_name="组织ID",
    )
    user_id = models.CharField(
        max_length=36, blank=True, default="", db_index=True,
        verbose_name="用户ID",
    )
    metric_name = models.CharField(max_length=100, verbose_name="指标名称")
    current_value = models.DecimalField(
        max_digits=20, decimal_places=4, verbose_name="当前值",
    )
    baseline_value = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0"),
        verbose_name="基线值",
    )
    threshold_ratio = models.DecimalField(
        max_digits=10, decimal_places=2, default=Decimal("5"),
        verbose_name="阈值倍率",
    )
    message = models.TextField(verbose_name="告警消息")
    is_resolved = models.BooleanField(default=False, db_index=True, verbose_name="是否已处理")
    resolved_at = models.DateTimeField(null=True, blank=True, verbose_name="处理时间")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="创建时间")

    class Meta:
        db_table = "services_billing_anomaly_alert"
        verbose_name = "计费异常告警"
        verbose_name_plural = "计费异常告警"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["severity", "is_resolved", "created_at"]),
            models.Index(fields=["organization_id", "created_at"]),
            models.Index(fields=["user_id", "created_at"]),
        ]

    def __str__(self):
        return f"[{self.severity}] {self.alert_type}: {self.message[:50]}"


# ──────────────────────────────────────────────────────────
# 成员级费用管控
# ──────────────────────────────────────────────────────────

MEMBER_BUDGET_SENTINEL = "__default__"


class MemberLlmBudgetPolicy(models.Model):
    """成员级 LLM 费用管控策略。

    三级继承：个人策略(user_id=具体ID) > 角色策略(user_id=SENTINEL, target_role=具体角色)
              > 默认策略(user_id=SENTINEL, target_role=SENTINEL) > 不限。
    user_id 和 target_role 使用哨兵值 "__default__" 替代 NULL，
    确保 MySQL 下 UniqueConstraint 生效。
    """

    ROLE_CHOICES = [
        ("owner", "Owner"),
        ("admin", "Admin"),
        ("editor", "Editor"),
        ("viewer", "Viewer"),
    ]
    MODEL_TIER_CHOICES = [
        ("standard", "标准"),
        ("premium", "高级"),
        ("enterprise", "不限"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )
    user_id = models.CharField(
        max_length=36, default=MEMBER_BUDGET_SENTINEL, db_index=True,
        verbose_name="用户ID",
        help_text="具体用户 ID，或 '__default__' 表示角色/默认策略",
    )
    target_role = models.CharField(
        max_length=20, default=MEMBER_BUDGET_SENTINEL,
        verbose_name="目标角色",
        help_text="具体角色（角色策略），或 '__default__'（默认策略/个人策略）。"
                  "合法角色由 ROLE_CHOICES 定义，API 层校验。",
    )

    monthly_credits_limit = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        verbose_name="月度 credits 上限",
        help_text="NULL 表示不限",
    )
    daily_credits_limit = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        verbose_name="日度 credits 上限",
        help_text="NULL 表示不限",
    )
    max_model_tier = models.CharField(
        max_length=20, default="enterprise", choices=MODEL_TIER_CHOICES,
        verbose_name="最高模型等级",
        help_text="允许使用的最高模型等级",
    )
    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否启用")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_member_llm_budget_policy"
        verbose_name = "成员预算策略"
        verbose_name_plural = "成员预算策略"
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "user_id", "target_role"],
                name="uniq_member_budget_policy",
            ),
        ]
        indexes = [
            models.Index(fields=["organization", "is_active"]),
        ]

    def __str__(self):
        return f"MemberBudgetPolicy({self.organization_id}, user={self.user_id}, role={self.target_role})"


class MemberLlmUsageCounter(models.Model):
    """成员月度/日度用量计数器。

    替代 Sum(BillingUsageEvent) 实时聚合——在 charge_llm_usage 成功后
    用 INSERT ... ON CONFLICT ... DO UPDATE 原子递增，预检时单行查询 + Redis 缓存。
    """

    CYCLE_CHOICES = [
        ("monthly", "月度"),
        ("daily", "日度"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.PROTECT,
        db_column='organization_id',
        related_name='+',
        verbose_name="组织",
    )
    user_id = models.CharField(max_length=36, verbose_name="用户ID")
    cycle_date = models.DateField(verbose_name="周期日期", help_text="月度=月首日, 日度=当天")
    cycle_type = models.CharField(max_length=10, choices=CYCLE_CHOICES, verbose_name="周期类型")
    consumed_credits = models.DecimalField(
        max_digits=20, decimal_places=4, default=Decimal("0"),
        verbose_name="已消耗 credits",
    )
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_member_usage_counter"
        verbose_name = "成员用量计数器"
        verbose_name_plural = "成员用量计数器"
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "user_id", "cycle_date", "cycle_type"],
                name="uniq_member_usage_counter",
            ),
        ]
        indexes = [
            models.Index(fields=["organization", "user_id", "cycle_type", "cycle_date"]),
        ]

    def __str__(self):
        return f"MemberUsage({self.organization_id}, {self.user_id}, {self.cycle_type}={self.cycle_date})"


class BillingDispute(models.Model):
    """W5-4: 用户申诉工单

    organization_id 保持软引用（ 规范例外——工单/审计类）：申诉是资金
    争议留痕，组织删除后工单仍需可查、可继续处理，不随组织行消失，也不纳入
    OrganizationLifecycleCleanupService 清理。
    """

    STATUS_CHOICES = [
        ("open", "待处理"),
        ("investigating", "调查中"),
        ("resolved", "已解决"),
        ("rejected", "已驳回"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    transaction_id = models.CharField(
        max_length=36, db_index=True, blank=True, default="",
        verbose_name="关联流水ID",
    )
    organization_id = models.CharField(max_length=100, db_index=True, verbose_name="组织ID")
    user_id = models.CharField(max_length=36, db_index=True, verbose_name="申诉用户ID")

    reason = models.TextField(verbose_name="申诉原因")
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default="open",
        db_index=True, verbose_name="状态",
    )
    admin_notes = models.TextField(blank=True, default="", verbose_name="处理备注")

    sla_deadline = models.DateTimeField(
        null=True, blank=True, verbose_name="SLA 截止时间",
        help_text="默认创建后 2 个工作日",
    )
    resolved_at = models.DateTimeField(null=True, blank=True, verbose_name="处理完成时间")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "services_billing_dispute"
        verbose_name = "计费申诉"
        verbose_name_plural = "计费申诉"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "created_at"], name="billing_dispute_status_idx"),
            models.Index(fields=["organization_id", "created_at"], name="billing_dispute_wt_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["transaction_id", "organization_id"],
                name="uniq_billing_dispute_tx_organization",
            ),
        ]

    def __str__(self):
        return f"Dispute({self.id}, {self.status}, {self.organization_id})"
