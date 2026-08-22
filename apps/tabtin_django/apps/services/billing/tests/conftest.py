"""
Billing 测试 fixtures。
Django TestCase 不直接使用 pytest fixtures，但此文件为未来迁移到 pytest 预留。
"""

import uuid
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.utils import timezone

User = get_user_model()


def create_admin_user(suffix: str = "") -> "User":
    username = f"billing_test_admin{suffix}_{uuid.uuid4().hex[:6]}"
    return User.objects.create_superuser(
        username=username,
        email=f"{username}@test.com",
        password="test_pass_123",
    )


def create_normal_user(suffix: str = "") -> "User":
    username = f"billing_test_user{suffix}_{uuid.uuid4().hex[:6]}"
    return User.objects.create_user(
        username=username,
        email=f"{username}@test.com",
        password="test_pass_123",
    )


def create_test_organization_id() -> str:
    return f"test-ws-{uuid.uuid4().hex[:12]}"


def create_billing_usage_event(organization_id: str, user_id: str, **overrides):
    from apps.services.billing.models import BillingUsageEvent
    defaults = {
        "organization_id": organization_id,
        "user_id": user_id,
        "meter_key": "llm.tokens",
        "biz_type": "llm",
        "quantity": Decimal("1000"),
        "unit_price": Decimal("0.0001"),
        "amount": Decimal("0.1"),
        "unit": "token",
    }
    defaults.update(overrides)
    return BillingUsageEvent.objects.create(**defaults)
