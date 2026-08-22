"""
v0.2 USER 画像 · 成员校验集成测试

针对 review 报告中"`_check_organization_membership` 0 覆盖"的盲区：
  - 之前的单测 settings 没装 tabtinspace → membership 校验路径整段被 skip
  - 这里用扩展 settings（``settings_user_portrait_integration_test``）注册了
    label="tabtinspace" 的 fake app（最小 Organization / OrganizationMember 模型），
    覆盖完整的"是否成员 → 通过 / 拒绝"语义；fake 模型字段跟生产模型在
    _check_organization_membership 关心的字段完全一致，所以测的是真业务逻辑。

覆盖：
  - owner 访问自己 organization 的画像 → 通过
  - member 访问所属 organization 的画像 → 通过
  - 非成员访问 organization → 抛 PERMISSION_DENIED
  - 用户从 organization 退出后再访问 → 抛 PERMISSION_DENIED
  - mark_distill_pending 在已存在 portrait 行的分支也必须做成员校验
    （v0.2 P0-7 修复点）
"""

from __future__ import annotations

import uuid

import pytest
from django.apps import apps as django_apps
from django.test import TestCase

# 集成测试需要 fake_tabtinspace 注册 + 真实 Organization / OrganizationMember 模型，
# 仅在 ``settings_user_portrait_integration_test`` 下加载。其他 settings 下
# (例如默认 user_portrait_test) 跳过整个模块——既不破坏现有 49 测试集，
# 也明确告诉读者：这是要跑专用 settings 才能验证的集成测试。
if not django_apps.is_installed("apps.user_portrait.tests._fake_tabtinspace"):
    pytest.skip(
        "test_membership_integration 需要 settings_user_portrait_integration_test "
        "（装载 fake tabtinspace 模型）",
        allow_module_level=True,
    )

from apps.user_portrait.error_codes import ErrorCode, ServiceError  # noqa: E402
from apps.user_portrait.services.portrait_service import UserPortraitService  # noqa: E402
from apps.user_portrait.tests._fake_tabtinspace.models import (  # noqa: E402
    Organization,
    OrganizationMember,
)
from apps.users.auth.models import User  # noqa: E402


class CheckOrganizationMembershipIntegrationTests(TestCase):
    """fake_tabtinspace 加载后的成员校验完整语义。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = User.objects.create_user(
            email="owner@portrait.test",
            password="StrongPass123!",
        )
        self.member = User.objects.create_user(
            email="member@portrait.test",
            password="StrongPass123!",
        )
        self.outsider = User.objects.create_user(
            email="outsider@portrait.test",
            password="StrongPass123!",
        )
        self.organization = Organization.objects.create(
            name="Test Organization",
            owner_id=self.owner.id,
        )
        OrganizationMember.objects.create(
            organization_id=self.organization.id,
            user_id=self.member.id,
            role="editor",
        )
        # ：画像按 Agent 隔离——服务方法需 agent_id。成员校验在 agent_id
        # 归一之后，故此处传合法 agent_id 让用例真正落到 membership 分支。
        self.aid = str(uuid.uuid4())

    def _wid(self) -> str:
        return str(self.organization.id)

    def test_owner_can_access_own_organization_portrait(self):
        """owner 是 Organization 的所有者 → 成员校验通过 → 可创建 / 读取自己的画像。"""
        svc = UserPortraitService(user=self.owner)
        portrait = svc.get_or_create_portrait(self._wid(), self.aid)
        self.assertEqual(str(portrait.organization_id), self._wid())
        self.assertEqual(str(portrait.user_id), str(self.owner.id))

    def test_member_can_access_organization_portrait(self):
        """普通成员（editor 角色）也能读写自己在该 Organization 的画像。"""
        svc = UserPortraitService(user=self.member)
        portrait = svc.get_or_create_portrait(self._wid(), self.aid)
        self.assertEqual(str(portrait.user_id), str(self.member.id))

    def test_outsider_cannot_access_organization_portrait(self):
        """非成员访问该 Organization 的画像 → PERMISSION_DENIED。"""
        svc = UserPortraitService(user=self.outsider)
        with self.assertRaises(ServiceError) as ctx:
            svc.get_or_create_portrait(self._wid(), self.aid)
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)
        self.assertEqual(ctx.exception.status, 403)

    def test_outsider_cannot_read_existing_portrait(self):
        """残留场景：即使 portrait 行存在（owner 创建过），非成员也读不到。"""
        UserPortraitService(user=self.owner).get_or_create_portrait(self._wid(), self.aid)
        outsider_svc = UserPortraitService(user=self.outsider)
        with self.assertRaises(ServiceError) as ctx:
            outsider_svc.get_portrait(self._wid(), self.aid)
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)

    def test_outsider_cannot_submit_hint(self):
        """非成员提交 hint → PERMISSION_DENIED。"""
        svc = UserPortraitService(user=self.outsider)
        with self.assertRaises(ServiceError) as ctx:
            svc.add_hint(self._wid(), self.aid, text="malicious hint")
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)

    def test_outsider_cannot_list_snapshots(self):
        """非成员列 snapshots → PERMISSION_DENIED。"""
        svc = UserPortraitService(user=self.outsider)
        with self.assertRaises(ServiceError) as ctx:
            svc.list_snapshots(self._wid(), self.aid)
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)

    def test_member_loses_access_after_leaving_organization(self):
        """退出 Organization 后再读自己已有的画像 → PERMISSION_DENIED。

        关键不变量：成员资格变化必须立即在权限层生效，不能因为 portrait
        行已存在就走捷径绕过校验。
        """
        member_svc = UserPortraitService(user=self.member)
        portrait = member_svc.get_or_create_portrait(self._wid(), self.aid)
        self.assertIsNotNone(portrait)

        OrganizationMember.objects.filter(
            organization_id=self.organization.id,
            user_id=self.member.id,
        ).delete()

        with self.assertRaises(ServiceError) as ctx:
            member_svc.get_portrait(self._wid(), self.aid)
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)

    def test_mark_distill_pending_re_checks_membership_on_existing_row(self):
        """v0.2 P0-7 修复点：
        portrait 行已存在 + 用户已不是成员 → mark_distill_pending 必须拒绝。

        修复前的 bug：mark_distill_pending 在"行已存在"分支直接改 status，
        从未调 _check_organization_membership，残留行 + 非成员可触发蒸馏。
        """
        UserPortraitService(user=self.owner).get_or_create_portrait(self._wid(), self.aid)

        outsider_svc = UserPortraitService(user=self.outsider)
        with self.assertRaises(ServiceError) as ctx:
            outsider_svc.mark_distill_pending(self._wid(), self.aid)
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)

    def test_mark_distill_pending_for_member_after_leave_is_rejected(self):
        """成员退出后，自己的 portrait 行还在，但不能再触发蒸馏。"""
        member_svc = UserPortraitService(user=self.member)
        member_svc.get_or_create_portrait(self._wid(), self.aid)

        OrganizationMember.objects.filter(
            organization_id=self.organization.id,
            user_id=self.member.id,
        ).delete()

        with self.assertRaises(ServiceError) as ctx:
            member_svc.mark_distill_pending(self._wid(), self.aid)
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)

    def test_organization_not_exists_treated_as_non_member(self):
        """Organization 根本不存在的 UUID → 走非成员分支抛 PERMISSION_DENIED
        （而不是 silently 通过——这点很关键，防止 random UUID 探测）。
        """
        random_wid = str(uuid.uuid4())
        svc = UserPortraitService(user=self.outsider)
        with self.assertRaises(ServiceError) as ctx:
            svc.get_or_create_portrait(random_wid, self.aid)
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)
