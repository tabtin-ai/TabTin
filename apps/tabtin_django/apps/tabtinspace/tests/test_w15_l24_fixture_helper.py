"""W1.5-prep / L24 验证：prod-mode fixture helper 端到端可用。

覆盖内容
--------

- L24.1：通过完整 fixture chain 创建 prod-mode 对象（无 mock），验证
  ``BillingAnomalyAlert`` schema 漂移修复后 default DB 可正常工作。
- L24.2：``create_test_organization_with_agent`` 仍可创建带兼容 Agent 关联的
  type='bot' Space，但 Agent 不再是 Space 成立的前提。
- 验证 cleanup 不残留对象。

设计
----

使用 ``django.test.TransactionTestCase`` 并显式 ``databases = {'default',
'postgresql'}``，确保两库都被 setUp。不走 SQLite，跑 prod 真实 schema。

注意：本测试在 ``USE_SQLITE_FOR_TESTS=0`` 下也能跑，但默认 pytest /
manage.py test 会走 SQLite，所以本测试用 standalone django.setup() 模式
在真实 dev DB 上跑（W1.5 E2E 风格）。
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
from django.apps import apps as django_apps  # noqa: E402

if not django_apps.ready:
    django.setup()

import pytest  # noqa: E402

from apps.tabtinspace.models import (  # noqa: E402
    Agent,
    SpaceMembership,
    Organization,
    OrganizationMember,
    Workspace,
)
from apps.tabtinspace.tests.fixtures import (  # noqa: E402
    cleanup_test_organization,
    create_test_agent,
    create_test_bot_space,
    create_legacy_team_space,
    create_test_user,
    create_test_organization,
    create_test_organization_with_agent,
)


# 标记本测试不走 pytest-django(不依赖 test DB),直接用 dev DB。
# CI 应通过 RUN_PROD_MODE_FIXTURE_TESTS=1 环境变量显式启用。
pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_PROD_MODE_FIXTURE_TESTS", "0") != "1",
    reason=(
        "prod-mode fixture 测试只在 RUN_PROD_MODE_FIXTURE_TESTS=1 时跑（"
        "需要 dev MySQL + PG 已 migrate 干净，与 W1.5 E2E 同链路）"
    ),
)


def test_l24_2_fixture_can_still_create_agent_linked_space():
    """L24.2：兼容 fixture 仍可创建带 Agent 关联的 Space。"""
    ctx = create_test_organization_with_agent(prefix="l24t1")
    try:
        assert ctx["user"].is_active
        assert ctx["organization"].owner_id == ctx["user"].id
        assert ctx["agent"].organization_id == ctx["organization"].id
        assert ctx["agent"].type == "bot"
        assert ctx["space"].organization_id == ctx["organization"].id

        # ：身份经 SpaceMembership.agent，不再挂 Workspace.agent_id
        membership = SpaceMembership.objects.using("postgresql").filter(
            workspace_id=ctx["space"].id, agent_id=ctx["agent"].id,
        ).first()
        assert membership is not None
        assert membership.role == "owner"
    finally:
        cleanup_test_organization(ctx["organization"], delete_user=True)


def test_l24_2_create_legacy_team_space_no_agent_required():
    """legacy team Space 仅保留给历史共享/委托覆盖，不作为普通容器。"""
    user = create_test_user(prefix="l24t2")
    organization = create_test_organization(owner=user, prefix="l24t2")
    try:
        team_space = create_legacy_team_space(organization=organization, prefix="l24t2")
        assert team_space.type == "team"
        assert team_space.agent_id is None
    finally:
        cleanup_test_organization(organization, delete_user=True)


def test_l24_2_explicit_bot_space_without_agent_raises():
    """L24.2：直接在 ORM 层创建 workspace 不带 agent 必须抛 IntegrityError。"""
    from django.db.utils import IntegrityError

    user = create_test_user(prefix="l24t3")
    organization = create_test_organization(owner=user, prefix="l24t3")
    try:
        with pytest.raises(IntegrityError):
            Space.objects.using("postgresql").create(
                organization_id=organization.id,
                type=Space.SpaceType.WORKSPACE,
                name="invalid-bot-no-agent",
                status="active",
            )
    finally:
        cleanup_test_organization(organization, delete_user=True)


def test_cleanup_removes_all_resources():
    """cleanup_test_organization 应清理 SpaceMembership/Space/Agent/Member/Organization 所有 5 类对象。"""
    ctx = create_test_organization_with_agent(prefix="l24t4")
    organization_id = ctx["organization"].id
    space_id = ctx["space"].id
    agent_id = ctx["agent"].id
    user_id = ctx["user"].id

    cleanup_test_organization(ctx["organization"], delete_user=True)

    pg = "postgresql"
    assert not Organization.objects.using(pg).filter(id=organization_id).exists()
    assert not Workspace.objects.using(pg).filter(id=space_id).exists()
    assert not Agent.objects.using(pg).filter(id=agent_id).exists()
    assert not OrganizationMember.objects.using(pg).filter(organization_id=organization_id).exists()
    assert not SpaceMembership.objects.using(pg).filter(workspace_id=space_id).exists()


def test_create_test_agent_records_owner_without_human_shadow():
    """测试 Agent 通过 owner_user 记录所有者，不创建 human 影子身份。"""
    user = create_test_user(prefix="l24t5")
    organization = create_test_organization(owner=user, prefix="l24t5")
    try:
        agent = create_test_agent(
            organization=organization, agent_type="bot", user=user, prefix="l24t5",
        )
        assert agent.type == "bot"
        assert agent.owner_user_id == user.id
    finally:
        cleanup_test_organization(organization, delete_user=True)


def test_no_billing_side_effects_on_organization_create():
    """fixture 创建 Organization 不调 provision_billing(避免 billing 副作用)。"""
    from apps.services.billing.models import BillingAnomalyAlert

    pre_count = BillingAnomalyAlert.objects.using("default").count()
    ctx = create_test_organization_with_agent(prefix="l24t6")
    try:
        post_count = BillingAnomalyAlert.objects.using("default").count()
        assert post_count == pre_count, (
            "create_test_organization_with_agent 不应触发 BillingAnomalyAlert 写入"
        )
    finally:
        cleanup_test_organization(ctx["organization"], delete_user=True)


if __name__ == "__main__":
    if "RUN_PROD_MODE_FIXTURE_TESTS" not in os.environ:
        os.environ["RUN_PROD_MODE_FIXTURE_TESTS"] = "1"
    sys.exit(pytest.main([__file__, "-v", "--no-header", "-p", "no:cacheprovider"]))
