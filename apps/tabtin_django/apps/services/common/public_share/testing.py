"""PublicShareE2EMixin —— 各 App 分享测试的标准底座

每个使用 ``PublicShareService`` 的 App（tabdoc / tabdata / tabslide ...）
都应在自己的 ``tests/`` 下写一个继承本 mixin 的测试类，让 share 的核心
契约（organization 阻挡 outsider、密码三态、meta 鉴权、横向越权防护、share_id
碰撞）有强制的统一覆盖。

典型用法（Phase 1 tabdoc 改造时会用到）::

    from django.test import TestCase
    from apps.services.common.public_share.testing import PublicShareE2EMixin
    from apps.tabdoc.services.share_service import DocumentShareService

    class DocumentShareE2ETests(PublicShareE2EMixin, TestCase):
        databases = {"default", "postgresql"}
        service_class = DocumentShareService

        def make_resource(self, *, owner, organization, space):
            from apps.tabdoc.models import Document
            return Document.objects.create(
                organization_id=organization.id, space_id=space.id, owner_id=owner.id,
                title="t", description_markdown="x", description_plaintext="x",
            )

        def make_share(self, resource, **kwargs):
            from apps.tabdoc.models import DocumentShare
            kwargs.setdefault("share_type", "public")
            return DocumentShare.objects.create(document=resource, **kwargs)

子类无需重复实现 ``test_organization_share_blocks_outsider`` 等用例 ——
mixin 已给了 8 个标准用例，继承即生效。

设计 trade-off：
- Mixin 不继承 ``TestCase``，避免被 pytest / unittest 单独 discover 时执行
  （没 service_class 必然 NotImplementedError）
- 子类只需提供 3 个钩子 + service_class，剩下的复用
- 没有把 ``setup_share_test_case`` 放进 ``setUp`` ——
  子类的 ``setUp`` 应显式调本方法（保留 super().setUp() 链路灵活性）
"""

from __future__ import annotations

from typing import Any, Optional

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save

from .exceptions import (
    ShareManagementPermissionDeniedError,
    SharePasswordIncorrectError,
    SharePasswordRequiredError,
    SharePermissionDeniedError,
)


class PublicShareE2EMixin:
    """各 App share 测试公用基础设施 + 标准用例集。

    继承约定：

    - 子类必须 ``class TestX(PublicShareE2EMixin, TestCase)``
    - 子类必须设 ``service_class``（指向 PublicShareService 子类）
    - 子类必须 override ``make_resource()`` / ``make_share()``
    - 子类的 ``setUp`` 必须先调 ``self.setup_share_test_case()``
    """

    service_class: Any = None

    # ── 钩子方法：子类必须实现 ──

    def make_resource(self, *, owner, organization, space):
        """子类实现：根据 owner / organization / space 创建一个资源实例
        （Document / Table / Slide 等）。"""
        raise NotImplementedError(
            f"{type(self).__name__} must implement make_resource()",
        )

    def make_share(self, resource, **kwargs):
        """子类实现：基于 resource 创建一条 share。

        kwargs 可包含 share_type / organization_id / password / expire_at /
        is_active 等，子类应透传给具体 Share 模型 ``objects.create``。
        如果传了 ``password`` 字段，子类应在内部走 ``share.set_password(pwd)``
        而不是直接赋给 password_hash。
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement make_share()",
        )

    # ── 测试夹具搭建 ──

    def setup_share_test_case(self) -> None:
        """构造分享测试的标准 fixture：owner / member / outsider
        + 1 个 organization（owner + member 加入）+ 1 个 Space。

        断言会用到的实例属性（**子类的 setUp / test 可直接访问**）：

        - ``self.owner``：资源 owner（同时是 WT owner）
        - ``self.member``：WT 成员（非 owner）
        - ``self.outsider``：与 WT 无关的第三人
        - ``self.organization``：测试用 Organization
        - ``self.space``：测试用 Space

        资源本身由 ``self.make_resource()`` 生成（子类 setUp 自行调用）。
        """
        # tabtinspace.signals.create_default_organization 会在 User 保存时自动建一个
        # personal organization，单测里直接造 Organization 会让 owner 被绑死到默认 wt，
        # 干扰断言。复用 tabdoc/tests/test_share_service.py 的同款做法：临时断开
        # 信号，tearDown 不强制 reconnect（test runner 进程级别）。
        from apps.tabtinspace.signals import create_default_organization
        User = get_user_model()
        try:
            post_save.disconnect(create_default_organization, sender=User)
        except Exception:
            pass

        from apps.tabtinspace.models import Organization, OrganizationMember

        self.owner = User.objects.create_user(
            username="share_e2e_owner",
            email="share_e2e_owner@example.com",
            password="x",
        )
        self.member = User.objects.create_user(
            username="share_e2e_member",
            email="share_e2e_member@example.com",
            password="x",
        )
        self.outsider = User.objects.create_user(
            username="share_e2e_outsider",
            email="share_e2e_outsider@example.com",
            password="x",
        )

        self.organization = Organization.objects.create(
            name="Share E2E WT",
            owner=self.owner,
            type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user_id=self.member.id, role="editor",
        )
        from apps.tabtinspace.models import Project
        self.space = Project.objects.create(
            organization=self.organization,
            name="Share E2E Space",
        )

    # ── 复用型断言工具（Phase 1/2/3 自定义测试也可调用）──

    def assert_share_organization_blocks_outsider(
        self,
        share: Any,
        *,
        outsider: Optional[Any] = None,
    ) -> None:
        """断言：organization 限定 share + outsider 调用 ``verify_share_access``
        应 raise SharePermissionDeniedError。"""
        if self.service_class is None:
            raise NotImplementedError("set service_class on the test class")

        target = outsider or self.outsider
        try:
            self.service_class.verify_share_access(share, user=target)
        except SharePermissionDeniedError:
            return
        raise AssertionError(
            "outsider should be blocked from organization share but verify_share_access passed",
        )

    def assert_share_password_required(
        self,
        share: Any,
        *,
        wrong_password: str = "wrong",
        right_password: str = "right",
    ) -> None:
        """断言 share 的密码三种调用路径：

        - 不传密码 → raise SharePasswordRequiredError
        - 传错误密码 → raise SharePasswordIncorrectError
        - 传正确密码 → 不抛异常
        """
        if self.service_class is None:
            raise NotImplementedError("set service_class on the test class")

        try:
            self.service_class.verify_share_access(share, password="")
        except SharePasswordRequiredError:
            pass
        else:
            raise AssertionError("expected SharePasswordRequiredError on empty password")

        try:
            self.service_class.verify_share_access(share, password=wrong_password)
        except SharePasswordIncorrectError:
            pass
        else:
            raise AssertionError("expected SharePasswordIncorrectError on wrong password")

        self.service_class.verify_share_access(share, password=right_password)

    def assert_share_meta_no_leak(
        self,
        share: Any,
        *,
        outsider: Optional[Any] = None,
    ) -> None:
        """断言：organization 限定 share 的 meta 通道 —— outsider 走
        ``verify_share_access`` 必失败，view 层据此应只返 has_password
        / share_id 等最小字段（PRD §4.3 P0-3 fix）。

        本断言只校验 service 层 verify 必抛 ——
        view 层「降级到只返 has_password」的契约由各 App 自行测试。
        """
        self.assert_share_organization_blocks_outsider(share, outsider=outsider)

    def assert_management_endpoint_rejects_non_admin(
        self,
        resource_id: Any,
        outsider: Optional[Any] = None,
    ) -> None:
        """断言：``load_resource_for_management`` 对非 owner / 非 admin
        必 raise ShareManagementPermissionDenied（P0-2 横向越权 fix）。"""
        if self.service_class is None:
            raise NotImplementedError("set service_class on the test class")

        target = outsider or self.outsider
        try:
            self.service_class.load_resource_for_management(resource_id, target)
        except ShareManagementPermissionDeniedError:
            return
        raise AssertionError(
            "outsider should be rejected by load_resource_for_management",
        )

    # ── 标准用例（继承即跑）──

    def test_organization_share_blocks_anonymous_access(self):
        """organization 限定 share + 匿名（user=None）→ raise SharePermissionDenied。"""
        resource = self.make_resource(
            owner=self.owner, organization=self.organization, space=self.space,
        )
        share = self.make_share(
            resource, share_type="organization", organization_id=str(self.organization.id),
        )
        try:
            self.service_class.verify_share_access(share, user=None)
        except SharePermissionDeniedError:
            return
        raise AssertionError("anonymous user should be blocked from organization share")

    def test_organization_share_blocks_outsider(self):
        resource = self.make_resource(
            owner=self.owner, organization=self.organization, space=self.space,
        )
        share = self.make_share(
            resource, share_type="organization", organization_id=str(self.organization.id),
        )
        self.assert_share_organization_blocks_outsider(share)

    def test_organization_share_allows_member(self):
        resource = self.make_resource(
            owner=self.owner, organization=self.organization, space=self.space,
        )
        share = self.make_share(
            resource, share_type="organization", organization_id=str(self.organization.id),
        )
        self.service_class.verify_share_access(share, user=self.member)

    def test_management_endpoint_rejects_anonymous(self):
        resource = self.make_resource(
            owner=self.owner, organization=self.organization, space=self.space,
        )
        try:
            self.service_class.load_resource_for_management(resource.id, None)
        except ShareManagementPermissionDeniedError:
            return
        raise AssertionError("anonymous operator should be rejected")

    def test_management_endpoint_allows_owner(self):
        resource = self.make_resource(
            owner=self.owner, organization=self.organization, space=self.space,
        )
        loaded = self.service_class.load_resource_for_management(
            resource.id, self.owner,
        )
        if str(getattr(loaded, "id", "")) != str(resource.id):
            raise AssertionError("owner load returned wrong resource")

    def test_management_endpoint_rejects_outsider(self):
        resource = self.make_resource(
            owner=self.owner, organization=self.organization, space=self.space,
        )
        self.assert_management_endpoint_rejects_non_admin(resource.id)

    def test_share_id_unique_under_concurrent_generate(self):
        """``generate_share_id`` 同一调用 100 次产生的 share_id 必须不重复。

        这只是熵的 sanity check —— DB UniqueConstraint 兜底由各 App
        自己测；本用例只防止「basecase 实现退化为非随机」。
        """
        ids = {self.service_class.generate_share_id() for _ in range(100)}
        if len(ids) != 100:
            raise AssertionError(
                f"share_id collisions in 100 generates: {100 - len(ids)} dups",
            )

    def test_password_three_state_semantics(self):
        """``apply_password`` 三态：None 不动、"" 清空、非空设新值。"""
        resource = self.make_resource(
            owner=self.owner, organization=self.organization, space=self.space,
        )
        share = self.make_share(resource)

        # None → 不动
        share.set_password("initial")
        before_hash = share.password_hash
        changed = self.service_class.apply_password(share, None)
        if changed or share.password_hash != before_hash:
            raise AssertionError("password=None should not change password_hash")

        # "" → 清空
        changed = self.service_class.apply_password(share, "")
        if not changed or share.password_hash:
            raise AssertionError("password='' should clear password_hash")

        # 非空 → 设新值
        changed = self.service_class.apply_password(share, "new_pwd")
        if not changed or not share.password_hash:
            raise AssertionError("password='new' should set password_hash")
        if not share.check_password("new_pwd"):
            raise AssertionError("password 'new_pwd' should verify true")
