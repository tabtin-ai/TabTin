"""#3832 billing FK 化后的测试组织供给工具。

billing 操作表的 ``organization_id`` 已换真 FK（tabtinspace.Organization，
on_delete=PROTECT），测试夹具不能再用 "ws_xxx" 之类的假字符串 id——
必须指向真实存在的组织行。

``org_id_for(token)`` 把历史测试里的假 id token 映射到一个稳定的真实组织：
- 同一 token 在同一测试事务内返回同一 organization_id（str(uuid)）；
- 首次调用时自动创建 Organization 行（含专用 owner 用户），幂等 get_or_create。

用法（替换历史字面值）：

    organization_id=org_id_for("ws_collect_001")
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

_NAMESPACE = uuid.UUID("3832a9b0-0000-4000-8000-000000003832")


def _stable_uuid(token: str) -> uuid.UUID:
    return uuid.uuid5(_NAMESPACE, token)


def fake_org_id(token: str) -> str:
    """纯计算版：返回 token 对应的稳定 uuid 字符串，不触 DB。

    供 SimpleTestCase（禁数据库）的 mock 型测试使用——只需要一个格式合法、
    可复现的组织 id，不需要真实组织行。
    """
    return str(_stable_uuid(token))


def org_id_for(
    token: str,
    *,
    status: str = "active",
    first_team_eligible: bool = False,
) -> str:
    """返回 token 对应的真实组织 id（str）；不存在则创建。"""
    from apps.tabtinspace.models import Organization, OrganizationProviderCreditClaim
    from django.contrib.auth import get_user_model

    User = get_user_model()
    org_uuid = _stable_uuid(token)
    organization = Organization.objects.filter(id=org_uuid).first()
    if organization is not None:
        if first_team_eligible:
            OrganizationProviderCreditClaim.objects.get_or_create(
                organization_id=organization.id,
                defaults={
                    "user_id": organization.owner_id,
                    "eligibility_order": 2,
                },
            )
        return str(org_uuid)

    owner_username = (
        f"billing_org_owner_{org_uuid.hex[:16]}"
        if first_team_eligible
        else "billing_test_org_owner"
    )
    owner = User.objects.filter(username=owner_username).first()
    if owner is None:
        with patch(
            "apps.tabtinspace.services.organization_service."
            "OrganizationService._dispatch_new_organization_provider_credits"
        ):
            owner = User.objects.create_user(
                username=owner_username,
                email=f"{owner_username}@test.local",
                password="test-pass-123",
            )
        if first_team_eligible:
            OrganizationProviderCreditClaim.objects.filter(
                user_id=owner.id,
                eligibility_order=1,
            ).update(eligible_campaign_ids=[])
    organization, _ = Organization.objects.get_or_create(
        id=org_uuid,
        defaults={
            "name": f"test-org-{token}",
            "owner_id": owner.id,
            "type": Organization.OrganizationType.TEAM,
            "status": status,
        },
    )
    if first_team_eligible:
        OrganizationProviderCreditClaim.objects.get_or_create(
            organization_id=organization.id,
            defaults={
                "user_id": owner.id,
                "eligibility_order": 2,
            },
        )
    return str(org_uuid)
