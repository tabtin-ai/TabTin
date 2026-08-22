"""
初始化/更新会员等级种子数据

Usage:
    python manage.py seed_membership_tiers          # 仅创建缺失的等级
    python manage.py seed_membership_tiers --force   # 覆盖已有等级的配额参数（保留 is_active 状态）
"""

from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.users.membership.models import MembershipTier

# ──────────────────────────────────────────────────────────────────────
# [D6] features 门控策略
#   - 用户增长期暂不执行 feature gate，基础能力对所有等级开放。
#   - 中期仅对企业级功能（sso、audit_log）加门控。
#   - LLM credits 配额是天然成本护栏，无需 feature gate 二次拦截。
# ──────────────────────────────────────────────────────────────────────

SEED_DATA = [
    {
        "tier_type": "free",
        "name": "免费版",
        "description": "免费用户的默认等级",
        "price": Decimal("0.00"),
        "duration_months": 1,
        "max_tables": 20,
        "max_documents": 10,
        "max_groups": 3,
        "max_records_per_table": 2000,
        # Legacy, not enforced (D5/QTA-16) — 以下两个字段无任何执行力，
        # 保留数据库兼容。实际限流由 ApiToken.rate_limit 控制。
        "max_api_calls_per_day": 0,
        "max_crawl_tasks_per_day": 0,

        "included_storage_bytes": 500 * 1024 * 1024,  # 500 MB
        "included_llm_credits_monthly": Decimal("0"),
        "max_conversations_per_day": 50,
        "max_members": 3,
        "base_seats": 1,
        "extra_seat_price": Decimal("0.00"),
        "trash_retention_days": 14,
        # [D6] 免费版 features
        "features": {
            "api_access": True,
            "advanced_export": False,
        },
        "sort_order": 0,
        "tier_level": 0,
    },
    {
        "tier_type": "basic",
        "name": "基础版",
        "description": "适合个人用户的入门付费方案",
        "price": Decimal("29.00"),
        "duration_months": 1,
        "max_tables": 50,
        "max_documents": 100,
        "max_groups": 30,
        "max_records_per_table": 10000,
        "max_api_calls_per_day": 0,   # Legacy, not enforced (D5/QTA-16)
        "max_crawl_tasks_per_day": 0,  # Legacy, not enforced (D5/QTA-16)

        "included_storage_bytes": 5 * 1024 * 1024 * 1024,  # 5 GB
        "included_llm_credits_monthly": Decimal("500"),
        "max_conversations_per_day": 200,
        "max_members": 5,
        "base_seats": 2,
        "extra_seat_price": Decimal("9.00"),
        "trash_retention_days": 30,
        "features": {
            "api_access": True,
            "advanced_export": True,
        },
        "sort_order": 1,
        "tier_level": 10,
    },
    {
        "tier_type": "pro",
        "name": "专业版",
        "description": "面向团队和重度用户的高级方案",
        "price": Decimal("99.00"),
        "duration_months": 1,
        "max_tables": 200,
        "max_documents": 1000,
        "max_groups": 100,
        "max_records_per_table": 100000,
        "max_api_calls_per_day": 0,   # Legacy, not enforced (D5/QTA-16)
        "max_crawl_tasks_per_day": 0,  # Legacy, not enforced (D5/QTA-16)

        "included_storage_bytes": 50 * 1024 * 1024 * 1024,  # 50 GB
        "included_llm_credits_monthly": Decimal("3000"),
        "max_conversations_per_day": 1000,
        "max_members": 20,
        "base_seats": 5,
        "extra_seat_price": Decimal("19.00"),
        "trash_retention_days": 60,
        "features": {
            "api_access": True,
            "advanced_export": True,
            "priority_support": True,
            "custom_branding": True,
        },
        "sort_order": 2,
        "tier_level": 20,
    },
    {
        "tier_type": "enterprise",
        "name": "企业版",
        "description": "面向企业级客户的旗舰方案",
        "price": Decimal("399.00"),
        "duration_months": 1,
        "max_tables": -1,
        "max_documents": -1,
        "max_groups": -1,
        "max_records_per_table": -1,
        "max_api_calls_per_day": 0,   # Legacy, not enforced (D5/QTA-16)
        "max_crawl_tasks_per_day": 0,  # Legacy, not enforced (D5/QTA-16)

        "included_storage_bytes": 500 * 1024 * 1024 * 1024,  # 500 GB
        "included_llm_credits_monthly": Decimal("20000"),
        "max_conversations_per_day": -1,
        "max_members": -1,
        "base_seats": 10,
        "extra_seat_price": Decimal("29.00"),
        "trash_retention_days": 90,
        # [D6] 企业级功能门控 — sso / audit_log 仅企业版可用
        "features": {
            "api_access": True,
            "advanced_export": True,
            "priority_support": True,
            "custom_branding": True,
            "sso": True,
            "audit_log": True,
            "dedicated_support": True,
        },
        "sort_order": 3,
        "tier_level": 30,
    },
]

# --force 更新时不覆盖的字段（保留管理员手动调整的值）
FORCE_SKIP_FIELDS = {"is_active"}


class Command(BaseCommand):
    help = "初始化会员等级 (MembershipTier) 种子数据"

    def add_arguments(self, parser):
        parser.add_argument(
            "--force",
            action="store_true",
            help="覆盖已有等级的配额参数（保留 is_active 状态）",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        force = options["force"]
        created_count = 0
        updated_count = 0
        skipped_count = 0

        for item in SEED_DATA:
            tier_type = item["tier_type"]
            defaults = {k: v for k, v in item.items() if k != "tier_type"}

            existing = MembershipTier.objects.filter(tier_type=tier_type).first()

            if existing:
                if force:
                    for field, value in defaults.items():
                        if field not in FORCE_SKIP_FIELDS:
                            setattr(existing, field, value)
                    existing.save()
                    updated_count += 1
                    self.stdout.write(f"  [更新] {tier_type} — {item['name']}")
                else:
                    skipped_count += 1
                    self.stdout.write(
                        f"  [跳过] {tier_type} — 已存在（使用 --force 覆盖）"
                    )
            else:
                MembershipTier.objects.create(
                    tier_type=tier_type,
                    is_active=True,
                    **defaults,
                )
                created_count += 1
                self.stdout.write(f"  [创建] {tier_type} — {item['name']}")

        self.stdout.write(
            self.style.SUCCESS(
                f"\n完成: 创建 {created_count}，更新 {updated_count}，跳过 {skipped_count}"
            )
        )
