"""
TabDoc 分享 service e2e 测试（PRD §5 Phase 1.7）

接入 ``apps.services.common.public_share.testing.PublicShareE2EMixin``，
继承 8 个标准用例（organization 阻挡 outsider / member / anonymous、
management 端点防越权、share_id 唯一性、密码三态等），并**额外补全
R7 关键风险用例**：

    R7 纵深防御（PRD §6.1 / ）：历史上 ``check_document_permission``
    会因他人 active ACL 关掉组织回退，导致 org owner/admin 管 share 被 403。
     已在主路径恢复组织回退；``check_resource_admin`` 仍保留
    organization admin fallback 作双保险。

R7 测试矩阵：8 个角色 × 2 个管理端点（create_share + close_share）= 16 用例。
每用例断言 service 层是否抛 ``ShareManagementPermissionDeniedError``，
以及 DB（DocumentShare 是否被新建 / 关闭）的最终状态。

约束：
- 直接调 ``DocumentShareService.load_resource_for_management`` /
  ``create_or_update_share`` / ``disable_share``，等价于路由层在 thin
  shim 之上的行为，但不引入 ninja TestClient 依赖（settings_share_test
  没装 ROOT_URLCONF）
- 子类不复制 mixin 的 8 个标准用例，pytest 会通过 mixin 继承自动 discover
"""
from __future__ import annotations

import json
import uuid

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.services.common.public_share.exceptions import (
    ShareManagementPermissionDeniedError,
)
from apps.services.common.public_share.testing import PublicShareE2EMixin
from apps.tabdoc.models import Document, DocumentPermission, DocumentShare
from apps.tabdoc.services.share_service import DocumentShareService
from apps.tabtinspace.models import Agent, Organization, OrganizationMember, Project, Space

User = get_user_model()


# ───────────────────────────────────────────────────────────────────
# 标准用例：继承 PublicShareE2EMixin 即生效
# ───────────────────────────────────────────────────────────────────


class DocumentShareStandardE2ETests(PublicShareE2EMixin, TestCase):
    """8 个标准用例（PublicShareE2EMixin 提供）的 tabdoc 落地。

    钩子方法 ``make_resource`` / ``make_share`` 由本类提供，
    ``setUp`` 显式调 ``setup_share_test_case()`` 构造夹具。
    """

    databases = {"default", "postgresql"}
    service_class = DocumentShareService

    def setUp(self):
        self.setup_share_test_case()

    def make_resource(self, *, owner, organization, space):
        return Document.objects.create(
            organization_id=organization.id,
            space_id=space.id,
            owner_id=owner.id,
            title="共享 e2e 文档",
            description_markdown="content",
            description_plaintext="content",
        )

    def make_share(self, resource, **kwargs):
        password = kwargs.pop("password", None)
        kwargs.setdefault("share_type", "public")
        share = DocumentShare(document=resource, **kwargs)
        if password:
            share.set_password(password)
        share.save()
        return share


# ───────────────────────────────────────────────────────────────────
# R7 关键风险用例（PRD §6.1）：organization admin fallback 必跑矩阵
# ───────────────────────────────────────────────────────────────────


class DocumentShareR7FallbackTests(TestCase):
    """R7：``check_resource_admin`` 内 organization admin fallback 矩阵。

    8 个角色 × 2 个管理端点（create_share + close_share）= 16 用例。

    夹具仍在 doc 上挂一条他人 role ACL，覆盖「有 active perm 但未命中本人」
    路径；#6850 后 org owner/admin 经主路径组织回退即可通过。
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 与 PublicShareE2EMixin / test_share_service.py 同款：断开 User
        # post_save 信号，避免在 SQLite 隔离 settings 下连锁失败。
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        try:
            post_save.disconnect(create_default_organization, sender=User)
        except Exception:
            pass

    def setUp(self):
        # ── 角色矩阵 ────────────────────────────────────────────────
        # doc_owner：文档 owner（同时是 self_wt owner，避免 wt owner 与
        # doc owner 重叠对 R7 路径的干扰，**doc_owner 必须**走 load_for_management
        # 的"owner_id 直通"分支，与 wt owner 路径分开断言）
        self.doc_owner = User.objects.create_user(
            username="r7_doc_owner",
            email="r7_doc_owner@example.com",
            password="x",
        )
        # wt_owner：另起一个用户做团队 owner（用 secondary_wt 装下），
        # 然后**在另一个 wt 上让其当 owner**——
        # 为了让 R7 测出 fallback，我们让 doc 挂在 wt_for_doc 下，
        # wt_for_doc 的 owner 是 wt_owner（不是 doc_owner）
        self.wt_owner = User.objects.create_user(
            username="r7_wt_owner",
            email="r7_wt_owner@example.com",
            password="x",
        )
        self.wt_admin = User.objects.create_user(
            username="r7_wt_admin",
            email="r7_wt_admin@example.com",
            password="x",
        )
        self.wt_editor = User.objects.create_user(
            username="r7_wt_editor",
            email="r7_wt_editor@example.com",
            password="x",
        )
        self.wt_viewer = User.objects.create_user(
            username="r7_wt_viewer",
            email="r7_wt_viewer@example.com",
            password="x",
        )
        self.cross_outsider = User.objects.create_user(
            username="r7_cross_outsider",
            email="r7_cross_outsider@example.com",
            password="x",
        )

        # ── organization / space / document ────────────────────────────
        self.organization = Organization.objects.create(
            name="R7 WT",
            owner=self.wt_owner,
            type="team",
        )
        # 把 doc_owner 也加进 wt（作为 editor，不给 doc admin 也不给 wt admin）
        # 这样 doc_owner 通过 owner_id 路径直通管 doc share，不被 R7 影响。
        OrganizationMember.objects.create(
            organization=self.organization, user_id=self.doc_owner.id, role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user_id=self.wt_admin.id, role="admin",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user_id=self.wt_editor.id, role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user_id=self.wt_viewer.id, role="viewer",
        )

        self.space = Space.objects.create(
            organization=self.organization,
            name="R7 Space",
            type="team",
        )

        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.doc_owner.id,
            title="R7 fallback 文档",
            description_markdown="x",
            description_plaintext="x",
        )

        # 挂一条他人 role ACL，覆盖「有 active perm 但本人未命中」路径。
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="role",
            subject_id="editor",
            permission="editor",
            is_active=True,
            granted_by=str(self.doc_owner.id),
        )

        # 跨 wt 用户：另起一个 organization，cross_outsider 在那里
        self.other_organization = Organization.objects.create(
            name="Other WT",
            owner=self.cross_outsider,
            type="team",
        )

    # ── helpers ────────────────────────────────────────────────────

    def _assert_create_succeeds(self, operator) -> DocumentShare:
        """断言 operator 走 load_resource_for_management + create_or_update_share
        能成功新建 / 更新 share，且 DB 中有活跃 share。"""
        doc = DocumentShareService.load_resource_for_management(
            self.doc.id, operator,
        )
        # 没抛异常即视为通过 admin 校验；进一步执行 create_or_update_share
        # 验证 DB 端到端可写
        share = DocumentShareService.create_or_update_share(
            doc, operator, share_type="public", permission="view",
        )
        assert share is not None
        assert share.is_active
        assert share.share_id
        return share

    def _assert_create_denied(self, operator) -> None:
        """断言 operator 走 load_resource_for_management 必被拒，
        且 DB 中**没有**因这次操作而新增的活跃 share。"""
        before_count = (
            DocumentShare.objects.using("postgresql")
            .filter(document=self.doc, is_active=True)
            .count()
        )
        with self.assertRaises(ShareManagementPermissionDeniedError):
            DocumentShareService.load_resource_for_management(self.doc.id, operator)
        after_count = (
            DocumentShare.objects.using("postgresql")
            .filter(document=self.doc, is_active=True)
            .count()
        )
        self.assertEqual(
            before_count, after_count,
            "denied operator should not have produced any share row",
        )

    def _make_active_share(self) -> DocumentShare:
        """构造一条活跃 share，供 close_share 用例消耗。"""
        share = DocumentShare(
            document=self.doc,
            share_type="public",
            permission="view",
        )
        share.save()
        return share

    def _assert_close_succeeds(self, operator) -> None:
        """构造活跃 share → operator 走 load_resource_for_management +
        disable_share 应成功关闭。"""
        share = self._make_active_share()
        doc = DocumentShareService.load_resource_for_management(
            self.doc.id, operator,
        )
        DocumentShareService.disable_share(doc, share_type="public")
        share.refresh_from_db()
        self.assertFalse(
            share.is_active,
            "close_share should mark share as inactive",
        )

    def _assert_close_denied(self, operator) -> None:
        """构造活跃 share → operator 走 load_resource_for_management 必被拒，
        DB 中 share **仍然活跃**（未被错误关闭）。"""
        share = self._make_active_share()
        with self.assertRaises(ShareManagementPermissionDeniedError):
            DocumentShareService.load_resource_for_management(self.doc.id, operator)
        share.refresh_from_db()
        self.assertTrue(
            share.is_active,
            "denied operator should not have closed share",
        )

    # ── R7 fallback 必要性证明（white-box，单独跑） ──────────────

    def test_r7_precondition_check_document_permission_denies_org_owner_without_acl(self):
        """#6863：组织 owner 无显式 ACL 时不可隐式获得文档 admin。"""
        from apps.tabdoc.services.document_service import DocumentService
        svc = DocumentService(user=self.wt_owner)
        self.assertFalse(
            svc.check_document_permission(self.doc, "admin"),
            "org owner 不应再靠组织回退拿到文档 admin",
        )

    def test_r7_precondition_check_document_permission_denies_org_admin_without_acl(self):
        """同上，针对 org admin。"""
        from apps.tabdoc.services.document_service import DocumentService
        svc = DocumentService(user=self.wt_admin)
        self.assertFalse(
            svc.check_document_permission(self.doc, "admin"),
            "org admin 不应再靠组织回退拿到文档 admin",
        )

    # ── R7 矩阵：create_share (8 用例) ─────────────────────────────

    def test_r7_create_doc_owner_allowed(self):
        """doc owner 走 owner_id 短路通过。"""
        self._assert_create_succeeds(self.doc_owner)

    def test_r7_create_wt_owner_denied_without_resource_acl(self):
        """#6863：org owner 未获显式文档 ACL 时不可管 share。"""
        self._assert_create_denied(self.wt_owner)

    def test_r7_create_wt_admin_denied_without_resource_acl(self):
        """#6863：org admin 同上。"""
        self._assert_create_denied(self.wt_admin)

    def test_r7_create_wt_editor_denied(self):
        """wt editor 不够 admin 等级，应被拒。"""
        self._assert_create_denied(self.wt_editor)

    def test_r7_create_wt_viewer_denied(self):
        self._assert_create_denied(self.wt_viewer)

    def test_r7_create_cross_wt_outsider_denied(self):
        """跨 wt 用户：在另一个 wt 上有任何角色都不应让他管 self.doc。"""
        self._assert_create_denied(self.cross_outsider)

    def test_r7_create_anonymous_denied(self):
        self._assert_create_denied(None)

    def test_r7_create_token_expired_treated_as_anonymous(self):
        """过期 token 经 JWTAuthOptional 转 ANONYMOUS_USER_MARKER，
        view 层经 get_authenticated_user 还原成 None，等价匿名。"""
        # service 层只看 user 实例本身，传 None 即可模拟"token 过期 → 匿名"
        self._assert_create_denied(None)

    # ── R7 矩阵：close_share (8 用例) ──────────────────────────────

    def test_r7_close_doc_owner_allowed(self):
        self._assert_close_succeeds(self.doc_owner)

    def test_r7_close_wt_owner_denied_without_resource_acl(self):
        self._assert_close_denied(self.wt_owner)

    def test_r7_close_wt_admin_denied_without_resource_acl(self):
        self._assert_close_denied(self.wt_admin)

    def test_r7_close_wt_editor_denied(self):
        self._assert_close_denied(self.wt_editor)

    def test_r7_close_wt_viewer_denied(self):
        self._assert_close_denied(self.wt_viewer)

    def test_r7_close_cross_wt_outsider_denied(self):
        self._assert_close_denied(self.cross_outsider)

    def test_r7_close_anonymous_denied(self):
        self._assert_close_denied(None)

    def test_r7_close_token_expired_treated_as_anonymous(self):
        self._assert_close_denied(None)


class DocumentSharePrivateBotSpaceTests(TestCase):
    """私有 bot Space 文档不继承 Organization 管理权。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        try:
            post_save.disconnect(create_default_organization, sender=User)
        except Exception:
            pass

    def setUp(self):
        self.doc_owner = User.objects.create_user(
            username="bot_doc_owner",
            email="bot_doc_owner@example.com",
            password="x",
        )
        self.wt_owner = User.objects.create_user(
            username="bot_wt_owner",
            email="bot_wt_owner@example.com",
            password="x",
        )
        self.wt_admin = User.objects.create_user(
            username="bot_wt_admin",
            email="bot_wt_admin@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="Bot Private WT",
            owner=self.wt_owner,
            type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=self.doc_owner.id,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=self.wt_admin.id,
            role="admin",
        )
        self.bot_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.doc_owner,
            name="Private Bot",
            type="bot",
            is_active=True,
        )
        self.bot_space = Space.objects.create(
            organization=self.organization,
            agent=self.bot_agent,
            name="Private Bot Space",
            type=Space.SpaceType.BOT,
        )
        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.bot_space.id,
            owner_id=self.doc_owner.id,
            title="私有 bot 文档",
            description_markdown="x",
            description_plaintext="x",
        )
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="role",
            subject_id="editor",
            permission="editor",
            is_active=True,
            granted_by=str(self.doc_owner.id),
        )

    def test_doc_owner_can_manage_private_bot_doc_share(self):
        doc = DocumentShareService.load_resource_for_management(
            self.doc.id,
            self.doc_owner,
        )

        self.assertEqual(doc.id, self.doc.id)

    def test_organization_owner_cannot_manage_private_bot_doc_share(self):
        with self.assertRaises(ShareManagementPermissionDeniedError):
            DocumentShareService.load_resource_for_management(
                self.doc.id,
                self.wt_owner,
            )

    def test_organization_admin_cannot_manage_private_bot_doc_share(self):
        with self.assertRaises(ShareManagementPermissionDeniedError):
            DocumentShareService.load_resource_for_management(
                self.doc.id,
                self.wt_admin,
            )


# ───────────────────────────────────────────────────────────────────
# 跨租户校验（P1-3）：validate_organization_scope D2=B 宽松模式
# ───────────────────────────────────────────────────────────────────


class DocumentShareOrganizationScopeTests(TestCase):
    """organization 分享严格作用域校验（本期不支持跨团队分享）：
    - 目标团队 == 文档所属团队 → 放行
    - 目标团队 != 文档所属团队 → 抛 ``ShareOrganizationMismatchError``
    - 空字符串 / None → 抛 ``ShareOrganizationMismatchError``
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        try:
            post_save.disconnect(create_default_organization, sender=User)
        except Exception:
            pass

    def setUp(self):
        self.owner = User.objects.create_user(
            username="p1_3_owner",
            email="p1_3_owner@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="P1-3 WT", owner=self.owner, type="team",
        )
        self.space = Space.objects.create(
            organization=self.organization, name="P1-3 Space", type="team",
        )
        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="P1-3 doc",
        )

    def test_same_organization_allowed(self):
        DocumentShareService.validate_organization_scope(
            self.doc, str(self.organization.id),
        )

    def test_different_organization_rejected(self):
        from apps.services.common.public_share.exceptions import (
            ShareOrganizationMismatchError,
        )
        with self.assertRaises(ShareOrganizationMismatchError):
            DocumentShareService.validate_organization_scope(
                self.doc, str(uuid.uuid4()),
            )

    def test_empty_organization_id_rejected(self):
        from apps.services.common.public_share.exceptions import (
            ShareOrganizationMismatchError,
        )
        with self.assertRaises(ShareOrganizationMismatchError):
            DocumentShareService.validate_organization_scope(self.doc, "")


class CloseShareBodyShareTypeTests(TestCase):
    """``close_share`` 从 JSON body 读 share_type（CLI 写命令把 flag 放 body）。

    ：每文档最多一条 active share；本套用例改为分别验证
    body 指定类型关闭，以及未指定类型时关闭当前有效分享。
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        try:
            post_save.disconnect(create_default_organization, sender=User)
        except Exception:
            pass

    def setUp(self):
        from django.test import RequestFactory

        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username="off_owner", email="off_o@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="Off WT", owner=self.owner, type="team",
        )
        self.space = Project.objects.create(
            organization=self.organization, name="Off Space",
        )
        self.doc = Document.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.owner.id, title="off doc",
        )

    def _active(self, share_type: str) -> int:
        from django.conf import settings

        db = (
            "default"
            if getattr(settings, "TABTIN_SINGLE_DATABASE_MODE", False)
            else "postgresql"
        )
        return (
            DocumentShare.objects.using(db)
            .filter(document=self.doc, share_type=share_type, is_active=True)
            .count()
        )

    def test_body_share_type_closes_organization(self):
        from apps.tabdoc.api_share import close_share

        DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        request = self.factory.delete(
            f"/api/tabdoc/documents/{self.doc.id}/share",
            data=json.dumps({"share_type": "organization"}),
            content_type="application/json",
        )
        request.auth = self.owner
        close_share(request, self.doc.id)

        self.assertEqual(self._active("organization"), 0, "organization 分享应被关闭")

    def test_default_closes_effective_share(self):
        from apps.tabdoc.api_share import close_share

        DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        request = self.factory.delete(f"/api/tabdoc/documents/{self.doc.id}/share")
        request.auth = self.owner
        close_share(request, self.doc.id)

        self.assertEqual(self._active("public"), 0, "未指定类型应关闭当前有效分享")
