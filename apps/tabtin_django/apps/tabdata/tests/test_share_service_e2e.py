"""TabData ``TableShareService`` 端到端测试

PRD `apps/tabtin_django/apps/tabdoc/PRD-shareperm-p0-fix.md` §5 Phase 2.8
要求的验证集合，覆盖：

1. **基类标准 8 用例**（继承 ``PublicShareE2EMixin`` 自动跑）：
   organization share 阻挡 anonymous / outsider、允许 member、密码三态、
   management endpoint 横向越权防护、share_id 唯一性 ……

2. **管理端点 8 角色 × 2 端点 = 16 用例对照**：
   owner / wt owner / wt admin / wt editor / wt viewer / outsider /
   anonymous / 过期 token，每个跑 ``create_data_share`` +
   ``close_data_share`` 两端点，验证横向越权防护行为。

3. **R2 兼容性回归**：
   密码态调 ``get_shared_table_meta`` 必须返 ``table_name`` / ``table_icon``，
   **不**返 ``fields[]`` / ``view_name``。

测试通过 settings_share_test 跑：

    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings_share_test \\
        python -m pytest apps/tabdata/tests/test_share_service_e2e.py -v

注意：本测试直接调用 view 函数（绕开 ninja path 反序列化），
利用 ninja 1.5.3 的「decorator 原样返回 view_func」语义 ——
不依赖 HTTP test client，避免 ninja path operation OpenAPI 解析时
对 SQLite 测试库环境的依赖。
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase

from apps.services.common.public_share import (
    SharePasswordIncorrectError,
    SharePasswordRequiredError,
    SharePermissionDeniedError,
)
from apps.services.common.public_share.testing import PublicShareE2EMixin
from apps.tabdata.api_share import (
    CreateDataShareRequest,
    UpdateSharedRecordRequest,
    close_data_share,
    create_data_share,
    get_shared_table_meta,
    get_shared_table_records,
    update_shared_table_record,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.services.oss.models import FileRecord
from apps.tabdata.models import (
    AttachmentReference,
    Table,
    TableField,
    TablePermission,
    TableRecord,
    TableShare,
    TableView,
)
from apps.tabdata.request_context import (
    clear_request_context,
    set_current_table_share_grant,
    set_current_table_share_password,
)
from apps.tabdata.services.share_service import TableShareService
from apps.tabdata.services.table_service import TableService
from apps.tabtinspace.models import Space, Organization, OrganizationMember, Project

User = get_user_model()


def _disconnect_default_organization_signal():
    """阻止 ``apps.tabtinspace.signals.create_default_organization`` 干扰断言。"""
    from apps.tabtinspace.signals import create_default_organization

    try:
        post_save.disconnect(create_default_organization, sender=User)
    except Exception:
        pass


def _response_status(response) -> int:
    """规范化提取响应 status code。

    api_share.py 各 view 函数的返回类型不统一：
    - 成功路径：``success_response`` 返回 ``dict``（ninja 框架后续包成 200 JsonResponse）
    - 失败路径：``error_response_with_status`` / ``permission_denied_response``
      等返回 ``JsonResponse``（自带 status_code）

    本 helper 统一抹平：dict → 200；JsonResponse → 其 status_code。
    """
    from django.http import JsonResponse

    if isinstance(response, JsonResponse):
        return response.status_code
    if isinstance(response, dict):
        return 200
    raise TypeError(f"unexpected view response type: {type(response)!r}")


def _response_payload(response) -> dict:
    """提取响应 body dict。dict 直接返回，JsonResponse 走 json.loads。"""
    if isinstance(response, dict):
        return response

    import json

    return json.loads(response.content.decode("utf-8"))


# ════════════════════════════════════════════════════════════════════
# 1. 基类标准用例（PublicShareE2EMixin 8 用例继承即跑）
# ════════════════════════════════════════════════════════════════════


class TableShareServiceMixinTests(PublicShareE2EMixin, TestCase):
    """复用 ``PublicShareE2EMixin`` 的 8 个标准用例。

    本类提供 ``make_resource`` / ``make_share`` 钩子，service_class 指向
    ``TableShareService``，剩下的标准用例由 mixin 提供（organization 三组
    断言、management 三组断言、share_id 唯一性、密码三态等）。
    """

    databases = {"default", "postgresql"}
    service_class = TableShareService

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        super().setUp()
        self.setup_share_test_case()

    def make_resource(self, *, owner, organization, space):
        return Table.objects.create(
            organization_id=organization.id,
            space_id=space.id,
            owner_id=owner.id,
            name="e2e share test table",
        )

    def make_share(self, resource, **kwargs):
        password = kwargs.pop("password", None)
        kwargs.setdefault("share_type", "data")
        kwargs.setdefault("share_id", TableShareService.generate_share_id())
        kwargs.setdefault("created_by", self.owner)
        share = TableShare(table=resource, **kwargs)
        if password is not None:
            share.set_password(password)
        share.save(using="postgresql")
        return share


class EditableShareGrantTablePermissionTests(TestCase):
    """可编辑分享链接应能驱动普通表格 runtime 的读写权限链。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        self.owner = User.objects.create_user(
            username="share_runtime_owner", email="share-runtime-owner@example.com", password="x",
        )
        self.visitor = User.objects.create_user(
            username="share_runtime_visitor", email="share-runtime-visitor@example.com", password="x",
        )
        User.objects.db_manager("postgresql").create_user(
            id=self.owner.id,
            username="share_runtime_owner",
            email="share-runtime-owner@example.com",
            password="x",
        )
        User.objects.db_manager("postgresql").create_user(
            id=self.visitor.id,
            username="share_runtime_visitor",
            email="share-runtime-visitor@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="Share Runtime WT", owner=self.owner, type="team",
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="Share Runtime Space",
            type="team",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            name="share runtime table",
        )

    def tearDown(self):
        clear_request_context()
        super().tearDown()

    def _make_share(self, *, permission: str, password: str | None = None) -> TableShare:
        share = TableShare(
            table=self.table,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission=permission,
            created_by=self.owner,
        )
        if password:
            share.set_password(password)
        share.save(using="postgresql")
        return share

    def test_edit_share_grants_viewer_and_editor_runtime_access(self):
        service = TableService(user=self.visitor)

        self.assertIsNone(service.get_table(self.table.id))

        set_current_table_share_grant(self._make_share(permission="edit"))

        self.assertEqual(service.get_table(self.table.id).id, self.table.id)
        self.assertTrue(service.check_table_permission(str(self.table.id), "editor"))

    def test_view_share_does_not_grant_editor_runtime_access(self):
        service = TableService(user=self.visitor)
        set_current_table_share_grant(self._make_share(permission="view"))

        self.assertIsNone(service.get_table(self.table.id))
        self.assertFalse(service.check_table_permission(str(self.table.id), "editor"))

    def test_password_edit_share_requires_matching_password_context(self):
        service = TableService(user=self.visitor)
        set_current_table_share_grant(
            self._make_share(permission="edit", password="secret-pass"),
        )

        self.assertIsNone(service.get_table(self.table.id))

        set_current_table_share_password("secret-pass")

        self.assertEqual(service.get_table(self.table.id).id, self.table.id)


# ════════════════════════════════════════════════════════════════════
# 2. 管理端点角色矩阵（8 角色 × 2 端点 = 16 用例）
# ════════════════════════════════════════════════════════════════════


class ManagementEndpointRoleMatrixTests(TestCase):
    """覆盖 create_data_share + close_data_share 的横向越权防护行为。

    角色矩阵（PRD §6.1 R7 隐含约束 —— tabdata 端 ``BaseService.check_table_permission``
    已涵盖 organization owner / admin / editor / viewer fallback，所以这里
    既验证 owner 直通，也验证 wt admin / wt editor 也通过）：

    | 角色 | 期望（admin 要求） |
    |------|--------------------|
    | owner | ✅ 通过 |
    | wt_owner（同 owner，但身份是 organization owner 不是 table owner） | ✅ 通过（wt admin fallback） |
    | wt_admin | ✅ 通过（wt admin fallback） |
    | wt_editor | ❌ 403（admin 要求高于 editor） |
    | wt_viewer | ❌ 403 |
    | outsider | ❌ 403 |
    | anonymous | ❌ 403（request.auth=None） |
    | expired_token（user.is_active=False，本测试用 None 模拟 ——
       ninja JWTAuth 对失效 token 直接返 None，路由层进入 view 时
       request.auth=None，等同 anonymous） | ❌ 403 |
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        self.factory = RequestFactory()

        # owner —— table.owner，同时也是 personal organization owner
        self.owner = User.objects.create_user(
            username="role_owner", email="role_owner@example.com", password="x",
        )
        # wt_owner —— 持有 wt 的人（这里实际就是 owner 自己 ——
        # 由 _table_organization 上是 owner 的）；保持单变量避免重复定义
        # 但额外建一个独立账号，证明 wt owner 即便不是 table owner 也通过 fallback
        # 注：实际测试中需要 wt.owner 与 table.owner_id 解耦才能区分二者。
        # 简化设计：让 table 由 table_actual_owner 持有，wt 由 wt_owner_user 持有，
        # 二者都属于 wt（避免角色重叠误判）。
        self.table_actual_owner = User.objects.create_user(
            username="role_table_owner", email="rtable@example.com", password="x",
        )
        self.wt_owner_user = User.objects.create_user(
            username="role_wt_owner", email="rwtown@example.com", password="x",
        )
        self.wt_admin = User.objects.create_user(
            username="role_wt_admin", email="rwtadm@example.com", password="x",
        )
        self.wt_editor = User.objects.create_user(
            username="role_wt_editor", email="rwted@example.com", password="x",
        )
        self.wt_viewer = User.objects.create_user(
            username="role_wt_viewer", email="rwtvw@example.com", password="x",
        )
        self.outsider = User.objects.create_user(
            username="role_outsider", email="rout@example.com", password="x",
        )

        self.organization = Organization.objects.create(
            name="Role Matrix WT", owner=self.wt_owner_user, type="team",
        )
        for u, role in [
            (self.table_actual_owner, "editor"),
            (self.wt_admin, "admin"),
            (self.wt_editor, "editor"),
            (self.wt_viewer, "viewer"),
        ]:
            OrganizationMember.objects.create(
                organization=self.organization, user_id=u.id, role=role,
            )

        self.space = Space.objects.create(
            organization=self.organization, name="Role Matrix Space",
            type="team",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.table_actual_owner.id,
            name="role matrix table",
        )

    # ── helper：直接调 view 函数 ──

    def _call_create(self, user, *, share_type="data") -> int:
        request = self.factory.post(f"/tables/{self.table.id}/share")
        request.auth = user
        # 角色矩阵测的是管理权限，不是公网 ack；扩 data 时带上确认标记避免 409 干扰断言
        payload = CreateDataShareRequest(
            share_type=share_type,
            acknowledge_public_exposure=(share_type == "data"),
            organization_id=(
                str(self.organization.id) if share_type == "organization" else ""
            ),
        )
        response = create_data_share(request, self.table.id, payload)
        return _response_status(response)

    def _call_close(self, user) -> int:
        request = self.factory.delete(f"/tables/{self.table.id}/share")
        request.auth = user
        response = close_data_share(request, self.table.id)
        return _response_status(response)

    # ── 角色 1：table owner（直通） ──

    def test_create_table_owner_allowed(self):
        self.assertEqual(self._call_create(self.table_actual_owner), 200)

    def test_close_table_owner_allowed(self):
        self.assertEqual(self._call_close(self.table_actual_owner), 200)

    # ── 角色 2：organization owner（wt fallback admin） ──

    def test_create_wt_owner_allowed(self):
        # wt_owner_user 不是 table owner，但是 wt owner → 通过 wt admin fallback
        self.assertEqual(self._call_create(self.wt_owner_user), 200)

    def test_close_wt_owner_allowed(self):
        self.assertEqual(self._call_close(self.wt_owner_user), 200)

    # ── 角色 3：organization admin（wt fallback admin） ──

    def test_create_wt_admin_allowed(self):
        self.assertEqual(self._call_create(self.wt_admin), 200)

    def test_close_wt_admin_allowed(self):
        self.assertEqual(self._call_close(self.wt_admin), 200)

    # ── 角色 4：organization editor（admin 要求高于 editor，应拒） ──

    def test_create_wt_editor_denied(self):
        self.assertEqual(self._call_create(self.wt_editor), 403)

    def test_close_wt_editor_denied(self):
        self.assertEqual(self._call_close(self.wt_editor), 403)

    # ── 角色 5：organization viewer（拒） ──

    def test_create_wt_viewer_denied(self):
        self.assertEqual(self._call_create(self.wt_viewer), 403)

    def test_close_wt_viewer_denied(self):
        self.assertEqual(self._call_close(self.wt_viewer), 403)

    # ── 角色 6：outsider（wt 外部用户，拒） ──

    def test_create_outsider_denied(self):
        self.assertEqual(self._call_create(self.outsider), 403)

    def test_close_outsider_denied(self):
        self.assertEqual(self._call_close(self.outsider), 403)

    # ── 角色 7：anonymous（request.auth=None，拒） ──

    def test_create_anonymous_denied(self):
        self.assertEqual(self._call_create(None), 403)

    def test_close_anonymous_denied(self):
        self.assertEqual(self._call_close(None), 403)

    # ── 角色 8：expired_token（ninja JWTAuth 失效 token → request.auth=None） ──

    def test_create_expired_token_denied(self):
        # ninja JWTAuth 对过期 / 非法 token 返 None，view 看到 request.auth=None
        self.assertEqual(self._call_create(None), 403)

    def test_close_expired_token_denied(self):
        self.assertEqual(self._call_close(None), 403)


# ════════════════════════════════════════════════════════════════════
# 3. R2 兼容性回归（PRD §6.1 R2）
# ════════════════════════════════════════════════════════════════════


class MetaEndpointR2CompatibilityTests(TestCase):
    """密码态 GET /shared/{share_id} 必须返 table_name / table_icon，
    必须**不**返 fields[] / view_name —— 保证 SharedTablePage 密码界面
    不白屏，同时不泄漏字段 schema。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        self.factory = RequestFactory()

        self.owner = User.objects.create_user(
            username="r2_owner", email="r2own@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="R2 WT", owner=self.owner, type="team",
        )
        self.space = Space.objects.create(
            organization=self.organization, name="R2 Space",
            type="team",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            name="R2 compat table",
            icon="📊",
            description="r2 desc",
        )
        # 给表加几个字段以便对照（密码态时这些字段绝对不应被泄漏）
        from apps.tabdata.models import TableField

        TableField.objects.create(
            table=self.table, name="字段A", field_type="text", order=0,
        )
        TableField.objects.create(
            table=self.table, name="字段B", field_type="number", order=1,
        )

        # 密码保护的 data 分享
        self.share = TableShare(
            table=self.table,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="view",
            created_by=self.owner,
        )
        self.share.set_password("secret-pass")
        self.share.save(using="postgresql")

    def _call_meta(self, *, password: str = "", user=None):
        request = self.factory.get(f"/shared/{self.share.share_id}")
        # 模拟 JWTAuthOptional 已经把匿名置成 ANONYMOUS_USER_MARKER
        # （get_authenticated_user 会还原成 None）
        from apps.users.auth.permissions import ANONYMOUS_USER_MARKER
        request.auth = user if user is not None else ANONYMOUS_USER_MARKER
        response = get_shared_table_meta(
            request, self.share.share_id, password=password,
        )
        return _response_payload(response), _response_status(response)

    def test_password_missing_returns_basic_fields_no_protected(self):
        """无密码请求 → 返 table_name / table_icon，**不**返 fields[] / view_name。"""
        payload, status_code = self._call_meta(password="")
        self.assertEqual(status_code, 200)
        data = payload["data"]
        # R2 兼容：基础展示字段必须保留
        self.assertEqual(data["share_id"], self.share.share_id)
        self.assertEqual(data["share_type"], "data")
        self.assertTrue(data["has_password"])
        self.assertEqual(data["table_name"], "R2 compat table")
        self.assertEqual(data["table_icon"], "📊")
        self.assertEqual(data["table_description"], "r2 desc")
        # R2 兼容：保护字段必须移除
        self.assertNotIn("fields", data)
        self.assertNotIn("view_name", data)
        self.assertNotIn("permission", data)
        self.assertNotIn("allow_download", data)

    def test_password_incorrect_returns_basic_fields_no_protected(self):
        """错误密码 → 同样降级到基础响应（不返 fields[]）。"""
        payload, status_code = self._call_meta(password="wrong-pwd")
        self.assertEqual(status_code, 200)
        data = payload["data"]
        self.assertTrue(data["has_password"])
        self.assertEqual(data["table_name"], "R2 compat table")
        self.assertNotIn("fields", data)
        self.assertNotIn("view_name", data)

    def test_password_correct_returns_full_protected_fields(self):
        """正确密码 → 返完整 meta（含 fields[]）。"""
        payload, status_code = self._call_meta(password="secret-pass")
        self.assertEqual(status_code, 200)
        data = payload["data"]
        self.assertEqual(data["table_name"], "R2 compat table")
        # 全字段：fields[] / view_name / permission / allow_download 都必须返
        self.assertIn("fields", data)
        self.assertEqual(len(data["fields"]), 2)
        field_names = {f["name"] for f in data["fields"]}
        self.assertEqual(field_names, {"字段A", "字段B"})
        self.assertIn("view_name", data)
        self.assertIn("permission", data)
        self.assertIn("allow_download", data)


# ════════════════════════════════════════════════════════════════════
# 4. 公开端点 organization 限定鉴权回归（service 层断言）
# ════════════════════════════════════════════════════════════════════


class OrganizationShareVerifyAccessTests(TestCase):
    """补充验证：PRD §4.1 P0-1 共同次因 ——
    organization 校验绝不能传 ``is_active=True``，且 anonymous / outsider
    必须被 ``verify_share_access`` 拒绝。

    本测试覆盖 mixin 标准用例已覆盖范围之外的边角：service 层 raise
    异常时携带的语义信息，view 层据此分支响应。
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        self.owner = User.objects.create_user(
            username="wtshare_owner", email="wt_o@example.com", password="x",
        )
        self.member = User.objects.create_user(
            username="wtshare_member", email="wt_m@example.com", password="x",
        )
        self.outsider = User.objects.create_user(
            username="wtshare_outsider", email="wt_ou@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="VerifyAccess WT", owner=self.owner, type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user_id=self.member.id, role="editor",
        )
        self.space = Space.objects.create(
            organization=self.organization, name="VA Space",
            type="team",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            name="va table",
        )
        self.share = TableShare(
            table=self.table,
            share_type="organization",
            share_id=TableShareService.generate_share_id(),
            organization_id=str(self.organization.id),
            permission="view",
            created_by=self.owner,
        )
        self.share.save(using="postgresql")

    def test_anonymous_user_blocked(self):
        with self.assertRaises(SharePermissionDeniedError):
            TableShareService.verify_share_access(self.share, user=None)

    def test_outsider_blocked(self):
        with self.assertRaises(SharePermissionDeniedError):
            TableShareService.verify_share_access(self.share, user=self.outsider)

    def test_member_allowed(self):
        # 无密码，member 直接通过（无异常）
        TableShareService.verify_share_access(self.share, user=self.member)

    def test_organization_check_does_not_use_is_active(self):
        """回归测试：OrganizationMember 模型没有 is_active 字段，
        基类 verify_share_access 内部 filter 必须不传它（否则 raise FieldError）。
        借 member 路径（必经 OrganizationMember.filter）反向检测。"""
        try:
            TableShareService.verify_share_access(self.share, user=self.member)
        except Exception as exc:  # pragma: no cover  —— 出错即定位
            self.fail(
                f"verify_share_access for valid member raised {type(exc).__name__}: {exc}",
            )


# ════════════════════════════════════════════════════════════════════
# 5. P1-3 跨租户校验回归（D2=B 宽松）
# ════════════════════════════════════════════════════════════════════


class OrganizationScopeValidationTests(TestCase):
    """``create_data_share`` 走严格 ``validate_organization_scope``，应：

    - 接受 organization_id == table.organization_id（合法）
    - 拒绝 organization_id != table.organization_id（本期不支持跨团队分享）
    - 拒绝 organization_id 为空 / 非 UUID 格式
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username="scope_owner", email="scope_o@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="Scope WT", owner=self.owner, type="team",
        )
        self.other_organization = Organization.objects.create(
            name="Other Scope WT", owner=self.owner, type="team",
        )
        self.space = Project.objects.create(
            organization=self.organization, name="Scope Space",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            name="scope table",
        )

    def _call(self, *, share_type="organization", organization_id=""):
        request = self.factory.post(f"/tables/{self.table.id}/share")
        request.auth = self.owner
        payload = CreateDataShareRequest(
            share_type=share_type, organization_id=organization_id,
        )
        return create_data_share(request, self.table.id, payload)

    def test_organization_id_same_as_table_organization_allowed(self):
        response = self._call(organization_id=str(self.organization.id))
        self.assertEqual(_response_status(response), 200)

    def test_organization_id_cross_organization_rejected(self):
        """本期严格模式：目标团队不等于表格所属团队 → 400 拒绝。"""
        response = self._call(organization_id=str(self.other_organization.id))
        self.assertEqual(_response_status(response), 400)
        payload = _response_payload(response)
        self.assertEqual(payload["code"], "INVALID_ORGANIZATION_ID")

    def test_organization_id_empty_derives_from_table(self):
        """未传 organization_id 时从表格归属推导（对齐 TabDoc）。"""
        response = self._call(organization_id="")
        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        self.assertEqual(payload["data"]["share"]["share_type"], "organization")

    def test_organization_id_invalid_uuid_rejected(self):
        response = self._call(organization_id="not-a-uuid")
        self.assertEqual(_response_status(response), 400)
        payload = _response_payload(response)
        self.assertEqual(payload["code"], "INVALID_ORGANIZATION_ID")


class SharedRecordsEndpointTests(TestCase):
    """records 端点修复回归。

    历史 bug：``get_shared_table_records`` 调用了不存在的
    ``ViewService.get_view_records`` → 任何访问一律 500，表格分享内容看不了。
    修复后改用 ``TableShareService.get_records`` → ``ViewDataService``，
    并以表格 owner 身份取数（分享本身即授权，绕过表成员校验）。
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        from apps.users.auth.permissions import ANONYMOUS_USER_MARKER

        self._anon = ANONYMOUS_USER_MARKER
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username="rec_owner", email="rec_o@example.com", password="x",
        )
        self.member = User.objects.create_user(
            username="rec_member", email="rec_m@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="Rec WT", owner=self.owner, type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.member, role="viewer",
        )
        self.space = Project.objects.create(
            organization=self.organization,
            name="Rec Project",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.owner.id, name="rec table",
        )
        self.view = TableView.objects.create(table=self.table, name="Grid")
        self.share = TableShare.objects.create(
            table=self.table, share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="view", created_by=self.owner,
        )

    @patch("apps.tabdata.services.view_data_service.ViewDataService.get_view_records")
    def test_public_records_endpoint_returns_data(self, mock_get):
        """匿名访问公开 data 分享：鉴权通过 → 200 + records（不再 500）。"""
        mock_get.return_value = {"records": [{"id": "r1"}], "total": 1}
        request = self.factory.get(f"/shared/{self.share.share_id}/records")
        request.auth = self._anon
        response = get_shared_table_records(
            request, self.share.share_id, page=1, page_size=50,
        )

        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        data = payload.get("data", payload)
        self.assertEqual(data["records"], [{"id": "r1"}])
        self.assertEqual(data["total"], 1)
        # 用解析出的视图 id 调了 ViewDataService（而非已废的 ViewService）
        _, kwargs = mock_get.call_args
        self.assertEqual(str(kwargs["view_id"]), str(self.view.id))

    @patch("apps.tabdata.services.view_data_service.ViewDataService.get_view_records")
    def test_public_edit_records_endpoint_still_allows_anonymous_read(self, mock_get):
        """公开可编辑只提高写入能力；匿名读取不应被误判成组织内分享。"""
        original_share_id = self.share.share_id
        update_request = self.factory.post(f"/tables/{self.table.id}/share")
        update_request.auth = self.owner
        update_response = create_data_share(
            update_request,
            self.table.id,
            CreateDataShareRequest(
                share_type="data",
                permission="edit",
                acknowledge_public_exposure=True,
            ),
        )
        self.assertEqual(_response_status(update_response), 200)
        self.share.refresh_from_db()
        self.assertEqual(self.share.share_id, original_share_id)
        self.assertEqual(self.share.permission, "edit")
        mock_get.return_value = {"records": [{"id": "r1"}], "total": 1}

        request = self.factory.get(f"/shared/{self.share.share_id}/records")
        request.auth = self._anon
        response = get_shared_table_records(
            request, self.share.share_id, page=1, page_size=50,
        )

        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        self.assertEqual(payload["data"]["records"], [{"id": "r1"}])
        mock_get.assert_called_once()

    def test_public_edit_meta_exposes_read_contract_to_anonymous_user(self):
        """同一公开链接切到 edit 后仍返回完整读取契约，写入登录标记保持兼容。"""
        self.share.permission = "edit"
        self.share.save(using=TABDATA_DB_ALIAS, update_fields=["permission"])

        request = self.factory.get(f"/shared/{self.share.share_id}")
        request.auth = self._anon
        response = get_shared_table_meta(request, self.share.share_id)

        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        data = payload["data"]
        self.assertEqual(data["share_type"], "data")
        self.assertEqual(data["permission"], "edit")
        self.assertTrue(data["requires_login"])
        self.assertIn("fields", data)

    @patch("apps.services.oss.services.file_access.get_oss_service")
    @patch("apps.tabdata.services.view_data_service.ViewDataService.get_view_records")
    def test_public_records_sign_private_attachment_after_share_authorization(
        self,
        mock_get,
        mock_get_oss,
    ):
        """公开分享只换签该表、该记录、可见附件字段已有的引用。"""
        field = TableField.objects.create(
            table=self.table,
            name="附件",
            field_type="attachment",
        )
        record = TableRecord.objects.create(
            table=self.table,
            data={},
            created_by=self.owner,
        )
        file_record = FileRecord.objects.create(
            file_name="private.jpg",
            file_key="tabdata/share/private.jpg",
            file_path="tabdata/share",
            file_size=128,
            file_type="image",
            mime_type="image/jpeg",
            file_extension="jpg",
            file_hash="SHARE-PRIVATE",
            bucket_name="test-bucket",
            access_url="https://oss.example.com/tabdata/share/private.jpg",
            is_public=False,
            status="completed",
        )
        reference = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=field,
            record=record,
            file_id=file_record.id,
            created_by=self.owner,
        )
        mock_get.return_value = {
            "records": [{
                "id": str(record.id),
                "data": {
                    "附件": [{
                        "reference_id": str(reference.id),
                        "file_id": str(file_record.id),
                        "url": file_record.access_url,
                    }],
                },
            }],
            "total": 1,
        }
        oss = MagicMock()
        oss.generate_presigned_url.return_value = (
            "https://oss.example.com/tabdata/share/private.jpg?sig=share"
        )
        mock_get_oss.return_value = oss

        payload = TableShareService.get_records(
            self.share,
            user=None,
            page=1,
            page_size=50,
        )

        attachment = payload["records"][0]["data"]["附件"][0]
        self.assertEqual(
            attachment["url"],
            "https://oss.example.com/tabdata/share/private.jpg?sig=share",
        )
        self.assertEqual(attachment["file_id"], str(file_record.id))
        file_record.refresh_from_db()
        self.assertNotIn("sig=", file_record.access_url)

    @patch("apps.tabdata.services.record_service.RecordService.update_record")
    def test_view_share_record_update_is_denied(self, mock_update):
        """view 分享不能调用共享写入通道。"""
        record = TableRecord.objects.create(
            table=self.table, data={"Name": "old"}, created_by=self.owner,
        )
        request = self.factory.patch(f"/shared/{self.share.share_id}/records/{record.id}")
        request.auth = self.member

        response = update_shared_table_record(
            request,
            self.share.share_id,
            record.id,
            UpdateSharedRecordRequest(field_id="Name", value="new"),
        )

        self.assertEqual(_response_status(response), 403)
        mock_update.assert_not_called()

    @patch("apps.tabdata.services.record_service.RecordService.update_record")
    def test_edit_share_record_update_requires_login(self, mock_update):
        """edit 分享需要登录后才能提交写入。"""
        self.share.permission = "edit"
        self.share.save(using=TABDATA_DB_ALIAS, update_fields=["permission"])
        record = TableRecord.objects.create(
            table=self.table, data={"Name": "old"}, created_by=self.owner,
        )
        request = self.factory.patch(f"/shared/{self.share.share_id}/records/{record.id}")
        request.auth = self._anon

        response = update_shared_table_record(
            request,
            self.share.share_id,
            record.id,
            UpdateSharedRecordRequest(field_id="Name", value="new"),
        )

        self.assertEqual(_response_status(response), 403)
        mock_update.assert_not_called()

    @patch("apps.tabdata.api_share.serialize_record")
    @patch("apps.tabdata.services.record_service.RecordService.update_record")
    def test_edit_share_record_update_uses_share_grant(self, mock_update, mock_serialize):
        """登录用户可通过 edit 分享更新记录，且不会要求真实协作者权限。"""
        self.share.permission = "edit"
        self.share.save(using=TABDATA_DB_ALIAS, update_fields=["permission"])
        record = TableRecord.objects.create(
            table=self.table, data={"Name": "old"}, created_by=self.owner,
        )
        mock_update.return_value = (record, None)
        mock_serialize.return_value = {"id": str(record.id), "data": {"Name": "new"}}

        request = self.factory.patch(f"/shared/{self.share.share_id}/records/{record.id}")
        request.auth = self.member

        response = update_shared_table_record(
            request,
            self.share.share_id,
            record.id,
            UpdateSharedRecordRequest(field_id="Name", value="new"),
        )

        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        self.assertEqual(payload["data"]["record"]["id"], str(record.id))
        args, kwargs = mock_update.call_args
        self.assertEqual(args[1], {"Name": "new"})
        self.assertEqual(kwargs["share_grant"], self.share)

    def _enable_share_password(self, raw: str = "secret-pass") -> None:
        """密码必须写到 API 实际读取的 DB alias（单库模式为 default）。"""
        self.share.set_password(raw)
        self.share.save(using=TABDATA_DB_ALIAS, update_fields=["password_hash"])
        self.share.refresh_from_db()
        self.assertTrue(self.share.has_password)

    @patch("apps.tabdata.services.view_data_service.ViewDataService.get_view_records")
    def test_password_share_accepts_canonical_table_share_password_header(self, mock_get):
        """：正典头 X-Table-Share-Password 可通过加密分享 records。"""
        self._enable_share_password()
        mock_get.return_value = {"records": [{"id": "r1"}], "total": 1}

        request = self.factory.get(
            f"/shared/{self.share.share_id}/records",
            HTTP_X_TABLE_SHARE_PASSWORD="secret-pass",
        )
        request.auth = self._anon
        response = get_shared_table_records(
            request, self.share.share_id, page=1, page_size=50,
        )

        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        data = payload.get("data", payload)
        self.assertEqual(data["total"], 1)
        mock_get.assert_called_once()

    @patch("apps.tabdata.services.view_data_service.ViewDataService.get_view_records")
    def test_password_share_accepts_legacy_x_share_password_header(self, mock_get):
        """：兼容旧头 X-Share-Password，避免已发客户端立刻挂。"""
        self._enable_share_password()
        mock_get.return_value = {"records": [{"id": "r1"}], "total": 1}

        request = self.factory.get(
            f"/shared/{self.share.share_id}/records",
            HTTP_X_SHARE_PASSWORD="secret-pass",
        )
        request.auth = self._anon
        response = get_shared_table_records(
            request, self.share.share_id, page=1, page_size=50,
        )

        self.assertEqual(_response_status(response), 200)
        mock_get.assert_called_once()

    def test_password_share_rejects_missing_password_header(self):
        """加密分享未带密码头 → 403 PASSWORD_REQUIRED。"""
        self._enable_share_password()

        request = self.factory.get(f"/shared/{self.share.share_id}/records")
        request.auth = self._anon
        response = get_shared_table_records(
            request, self.share.share_id, page=1, page_size=50,
        )

        self.assertEqual(_response_status(response), 403)
        payload = _response_payload(response)
        self.assertEqual(payload["code"], "PASSWORD_REQUIRED")


class CloseDataShareBodyShareTypeTests(TestCase):
    """``close_data_share`` 从 JSON body 读 share_type（ critical fix）。

    根因：tabtin CLI 声明式管线（pipeline.go）只对 GET 做 body→query 转换，
    DELETE 的 --share-type 走 JSON body 发送；而 Django Ninja 对
    ``close_data_share`` 裸 str 形参默认按 query 绑定，两边错位导致
    ``table share off --share-type organization`` 被静默当成关闭 data 分享。

    修法镜像  已验证过的 ``tabdoc.api_share.close_share`` 方案：
    ``_share_type_from_request`` 优先读 body，查不到再退回 query（见
    apps/tabtin_django/apps/tabdata/api_share.py）。本套用例对照 tabdoc 的
    ``CloseShareBodyShareTypeTests``（apps/tabtin_django/apps/tabdoc/tests/
    test_share_service_e2e.py 同名类）。
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        self.owner = User.objects.create_user(
            username="tbl_off_owner", email="tbl_off_o@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="Table Off WT", owner=self.owner, type="team",
        )
        # Table.space_id 是裸 UUIDField（非 FK， Space 模型退役后仍保留列名，
        # 见 tabdata/models.py:78-85），不需要真实 Space/Workspace 行——直接生成
        # UUID 即可，不复用本文件其它测试类里已过期的 Space.objects.create 写法
        # （那些用例在当前代码库上已因  报错，属于另一个待修的既有缺口）。
        self.table = Table.objects.create(
            organization_id=self.organization.id, space_id=uuid.uuid4(),
            owner_id=self.owner.id, name="off table",
        )
        self.factory = RequestFactory()

    def _active_count(self, share_type: str) -> int:
        return (
            TableShare.objects.using(TABDATA_DB_ALIAS)
            .filter(table=self.table, share_type=share_type)
            .count()
        )

    def test_body_share_type_closes_organization_not_data(self):
        """两种分享同时存在时，body 传 organization 只应关掉 organization，不误关 data。"""
        import json

        TableShare.objects.create(
            table=self.table, share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="view", created_by=self.owner,
        )
        TableShare.objects.create(
            table=self.table, share_type="organization",
            share_id=TableShareService.generate_share_id(),
            permission="view", created_by=self.owner,
            organization_id=self.organization.id,
        )
        self.assertEqual(self._active_count("data"), 1)
        self.assertEqual(self._active_count("organization"), 1)

        request = self.factory.delete(
            f"/tables/{self.table.id}/share",
            data=json.dumps({"share_type": "organization"}),
            content_type="application/json",
        )
        request.auth = self.owner
        response = close_data_share(request, self.table.id)

        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        self.assertEqual(payload["data"]["deleted_count"], 1)
        self.assertEqual(
            self._active_count("organization"), 0,
            "body 显式 organization 应被关闭",
        )
        self.assertEqual(
            self._active_count("data"), 1,
            "data 分享不应被误关（回归  静默当成 data 的 bug）",
        )

    def test_query_share_type_still_works_without_body(self):
        """未带 body（如浏览器 / 未来前端直连）仍走 Ninja 解析的 query 值，向后兼容。"""
        TableShare.objects.create(
            table=self.table, share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="view", created_by=self.owner,
        )
        request = self.factory.delete(f"/tables/{self.table.id}/share")
        request.auth = self.owner
        response = close_data_share(request, self.table.id, share_type="data")

        self.assertEqual(_response_status(response), 200)
        self.assertEqual(self._active_count("data"), 0)
