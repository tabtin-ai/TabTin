"""TabData 表单分享安全回归（PRD `tabdoc/PRD-shareperm-p0-fix.md` §5 Phase 3.3）

覆盖两个 P1：

- **P1-5（PRD §4.4）**：``get_form_collaborators`` 从前裸列 organization 全员，
  本测试验证修复后**仅返回该表的协作者**（TablePermission 中 subject_type='user'
  且 is_active=True 的记录 + table.owner），且**只有协作者**可查（非协作者 / 匿名
  一律拒绝）。

- **P1-6（PRD §4.5）**：``submit_public_form`` 从前以 share owner 身份漂移
  写入，不实时校验 owner 当前是否对 table 有 editor+ 权限。本测试验证修复后
  在 submit 时刻调 ``BaseService.check_table_permission(table_id, 'editor')``，
  失败则返 403 + ``OWNER_REVOKED`` 错误码（owner 仍在但被降权 / 被移除 /
  退出 organization 等场景都被拦截）。

测试设计：

- 与 Phase 2 ``test_share_service_e2e.py`` 同款 ——
  直接调 view 函数 + RequestFactory，不走 HTTP client（绕开 ninja 反序列化对
  in-memory SQLite settings_share_test 的依赖）
- 跑法::

      cd apps/tabtin_django && source venv/bin/activate
      DJANGO_SETTINGS_MODULE=tabtin.settings_share_test \\
          python -m pytest apps/tabdata/tests/test_form_share_security.py -v
"""

from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.http import JsonResponse
from django.test import RequestFactory, TestCase, override_settings

from apps.tabdata.api_form import (
    get_form_collaborators,
    router as form_router,
    submit_public_form,
)
from apps.tabdata.models import (
    Table,
    TableField,
    TablePermission,
    TableShare,
    TableView,
)
from apps.tabdata.schemas import FormSubmitRequest
from apps.tabdata.services.share_service import TableShareService
from apps.tabtinspace.models import Space, Organization, OrganizationMember
from apps.users.auth.permissions import JWTAuth

User = get_user_model()


def _disconnect_default_organization_signal() -> None:
    """阻止 ``apps.tabtinspace.signals.create_default_organization`` 给每个新 User
    自动建 personal organization，干扰我们对协作者集合的精确断言。"""
    from apps.tabtinspace.signals import create_default_organization

    try:
        post_save.disconnect(create_default_organization, sender=User)
    except Exception:
        pass


def _mirror_user_to_postgresql(user) -> None:
    """settings_share_test 下 User 模型在 default 库；但 TableShare.created_by
    这种跨库 FK 在 lazy load 时会用 share._state.db='postgresql' 查 User
    （Django ORM 行为），导致 ``User.DoesNotExist``。

    解决：测试 fixture 里把 User 在 postgresql 库也建一份（in-memory sqlite
    场景下两个 alias 是独立内存，不冲突；生产 PG 不会触发此 helper —— 仅测试期）。

    复用同一 id，确保后续 ``BaseService(user=u).check_table_permission`` 等
    用 ``str(u.id)`` 比较时一致。
    """
    User.objects.using("postgresql").create(
        id=user.id,
        username=user.username,
        email=user.email,
        password=user.password,
        is_active=user.is_active,
    )


def _response_status(response) -> int:
    """Phase 2 同款 helper：dict → 200；JsonResponse → 其 status_code；tuple → tuple[0]."""
    if isinstance(response, tuple) and len(response) == 2:
        status, body = response
        if isinstance(body, JsonResponse):
            return body.status_code
        return int(status)
    if isinstance(response, JsonResponse):
        return response.status_code
    if isinstance(response, dict):
        return 200
    raise TypeError(f"unexpected view response type: {type(response)!r}")


def _response_payload(response) -> dict:
    """tuple → tuple[1]；JsonResponse → json.loads(content)；dict → 直接返回。"""
    if isinstance(response, tuple) and len(response) == 2:
        body = response[1]
        if isinstance(body, JsonResponse):
            return json.loads(body.content.decode("utf-8"))
        return body
    if isinstance(response, dict):
        return response
    return json.loads(response.content.decode("utf-8"))


# ════════════════════════════════════════════════════════════════════
# Phase 3.1：P1-5 ``get_form_collaborators`` 越权 / 泄露回归
# ════════════════════════════════════════════════════════════════════


class GetFormCollaboratorsSecurityTests(TestCase):
    """验证 ``get_form_collaborators`` 修复后：

    1. 装饰器契约：必须 ``auth=jwt_auth``（匿名由 ninja 自动拦截 401）
    2. 登录但非该表协作者 → view 内返 403
    3. 协作者访问 → 200，返 owner + TablePermission 协作者，**不含** organization 其他成员
    4. organization 有 200 成员但只有 3 个协作者 → 只返 3 个（核心回归断言）
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        self.factory = RequestFactory()

        # table owner（同时也是 organization owner，简化 fixture）
        self.owner = User.objects.create_user(
            username="p15_owner", email="p15_o@example.com", password="x",
        )
        # 显式 TablePermission 协作者
        self.collab_a = User.objects.create_user(
            username="p15_collab_a", email="p15_ca@example.com", password="x",
        )
        self.collab_b = User.objects.create_user(
            username="p15_collab_b", email="p15_cb@example.com", password="x",
        )
        # organization 普通成员，但不是 table 协作者
        self.wt_only_member = User.objects.create_user(
            username="p15_wt_only", email="p15_wto@example.com", password="x",
        )
        # organization 之外的人
        self.outsider = User.objects.create_user(
            username="p15_outsider", email="p15_ou@example.com", password="x",
        )

        self.organization = Organization.objects.create(
            name="P1-5 WT", owner=self.owner, type="team",
        )
        for u in (self.collab_a, self.collab_b, self.wt_only_member):
            OrganizationMember.objects.create(
                organization=self.organization, user_id=u.id, role="editor",
            )

        self.space = Space.objects.create(
            organization=self.organization,
            name="P1-5 Space",
            type="team",
        )

        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            name="p1-5 table",
        )

        # 显式给 collab_a / collab_b 加 TablePermission
        for u in (self.collab_a, self.collab_b):
            TablePermission.objects.using("postgresql").create(
                table=self.table,
                subject_type="user",
                subject_id=str(u.id),
                permission="editor",
                is_active=True,
                granted_by=str(self.owner.id),
            )

        # form 视图 + form share
        self.view = TableView.objects.create(
            table=self.table,
            name="form view",
            view_type="form",
            config={"title": "P1-5 form"},
        )
        self.share = TableShare(
            table=self.table,
            view=self.view,
            share_type="form",
            share_id=TableShareService.generate_share_id(),
            permission="edit",
            created_by=self.owner,
        )
        self.share.save(using="postgresql")

    def _call(self, *, user):
        request = self.factory.get(f"/forms/{self.share.share_id}/collaborators")
        request.auth = user
        return get_form_collaborators(request, self.share.share_id)

    # ── 1. 装饰器契约：必须 auth=jwt_auth ──

    def test_route_auth_is_jwt_auth_not_anonymous(self):
        """契约级断言：路由 auth_callbacks 必须含 JWTAuth ——
        否则 ninja 不会拦匿名访问，view 内的访问者校验会被绕过。"""
        op = None
        for path, ops in form_router.path_operations.items():
            if "collaborators" in path:
                for o in ops.operations:
                    if o.view_func.__name__ == "get_form_collaborators":
                        op = o
                        break
        self.assertIsNotNone(op, "未找到 get_form_collaborators 的 path operation")
        self.assertTrue(
            op.auth_callbacks,
            "get_form_collaborators 装饰器必须传 auth=jwt_auth，"
            "不能是 None（匿名访问会绕开协作者校验）",
        )
        self.assertTrue(
            any(isinstance(cb, JWTAuth) for cb in op.auth_callbacks),
            f"auth_callbacks 必须含 JWTAuth 实例，实际：{op.auth_callbacks!r}",
        )

    # ── 2. 登录但非该表协作者 → 403（view 内）──

    def test_logged_in_non_collaborator_returns_403(self):
        """非协作者登录 → view 内返 403（避免任意登录用户查任意表协作者列表）。"""
        response = self._call(user=self.outsider)
        self.assertEqual(_response_status(response), 403)
        payload = _response_payload(response)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")

    def test_organization_member_not_table_collaborator_returns_403(self):
        """**关键回归**：wt_only_member 是 organization 成员但不在 TablePermission ——
        如果修复不彻底（还在裸列 wt 成员），他可能拿到完整名单；修复后必须 403。"""
        response = self._call(user=self.wt_only_member)
        self.assertEqual(_response_status(response), 403)

    # ── 3. 协作者访问 → 200 + 协作者集合 = owner + TablePermission 用户 ──

    def test_collaborator_returns_only_table_collaborators_and_owner(self):
        """协作者访问 → 200，返回集合严格 = {owner, collab_a, collab_b}。
        wt_only_member 必须**不**出现（即使他在 organization 里）。"""
        response = self._call(user=self.collab_a)
        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        data = payload["data"]
        returned_ids = {c["id"] for c in data["collaborators"]}
        expected_ids = {
            str(self.owner.id),
            str(self.collab_a.id),
            str(self.collab_b.id),
        }
        self.assertEqual(
            returned_ids,
            expected_ids,
            f"协作者集合不符预期：返回={returned_ids} 期望={expected_ids}",
        )
        self.assertNotIn(
            str(self.wt_only_member.id),
            returned_ids,
            "wt_only_member 是 organization 成员但不是 table 协作者，"
            "不应出现在结果中（核心回归断言）",
        )
        self.assertEqual(data["total"], 3)

    def test_owner_can_view_collaborators(self):
        """owner 是协作者集合的隐式成员（不在 TablePermission 里也算）→ 200。"""
        response = self._call(user=self.owner)
        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        returned_ids = {c["id"] for c in payload["data"]["collaborators"]}
        self.assertIn(str(self.owner.id), returned_ids)


class GetFormCollaboratorsLargeOrganizationRegressionTest(TestCase):
    """**P1-5 核心回归用例**（PRD 验收清单单独列）：
    organization 有 200 个成员但 table 上只有 3 个协作者 →
    必须只返这 3 个（如果修复不彻底，会返 200 人）。
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username="big_wt_owner", email="bw_o@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="Big WT (200 members)", owner=self.owner, type="team",
        )
        self.space = Space.objects.create(
            organization=self.organization, name="Big Space",
            type="team",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            name="big-wt table",
        )

        # 200 个 organization 成员（除 owner 之外）
        members = User.objects.bulk_create([
            User(
                username=f"bw_m{i:03d}",
                email=f"bw_m{i:03d}@example.com",
                password="x",
            )
            for i in range(200)
        ])
        OrganizationMember.objects.bulk_create([
            OrganizationMember(
                organization=self.organization, user_id=m.id, role="editor",
            )
            for m in members
        ])

        # 只让前 2 个成员成为 table 协作者（+ owner 隐式 = 3）
        self.collab1 = members[0]
        self.collab2 = members[1]
        for u in (self.collab1, self.collab2):
            TablePermission.objects.using("postgresql").create(
                table=self.table,
                subject_type="user",
                subject_id=str(u.id),
                permission="viewer",
                is_active=True,
                granted_by=str(self.owner.id),
            )

        self.view = TableView.objects.create(
            table=self.table, name="big form", view_type="form",
        )
        self.share = TableShare(
            table=self.table,
            view=self.view,
            share_type="form",
            share_id=TableShareService.generate_share_id(),
            permission="edit",
            created_by=self.owner,
        )
        self.share.save(using="postgresql")

    def test_only_three_collaborators_not_two_hundred_members(self):
        """关键回归：organization 有 200 成员，只返 3 协作者（owner + collab1 + collab2）。
        如果修复不彻底（还在拉 OrganizationMember），page_size 默认 50 → 会返 50 人。"""
        request = self.factory.get(
            f"/forms/{self.share.share_id}/collaborators?page_size=200",
        )
        request.auth = self.owner  # owner 必能访问
        response = get_form_collaborators(
            request, self.share.share_id, page_size=200,
        )
        self.assertEqual(_response_status(response), 200)
        payload = _response_payload(response)
        data = payload["data"]
        self.assertEqual(
            data["total"], 3,
            f"应只返 3 个协作者（owner + 2 个 TablePermission），实际 total={data['total']}",
        )
        returned_ids = {c["id"] for c in data["collaborators"]}
        self.assertEqual(
            returned_ids,
            {str(self.owner.id), str(self.collab1.id), str(self.collab2.id)},
        )


# ════════════════════════════════════════════════════════════════════
# Phase 3.2：P1-6 ``submit_public_form`` owner 身份漂移回归
# ════════════════════════════════════════════════════════════════════


@override_settings(CACHES={
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"},
})
class SubmitPublicFormOwnerPermissionTests(TestCase):
    """验证 ``submit_public_form`` 修复后：

    1. owner 仍在 + 有 editor → 200 成功落库
    2. owner 在但被降为 viewer → 403 ``OWNER_REVOKED``
    3. owner 在但被从 TablePermission 移除（既不是 wt member）→ 403 ``OWNER_REVOKED``
    4. owner 是 organization owner 走 wt fallback → 200 成功（边界）
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_organization_signal()

    def setUp(self):
        self.factory = RequestFactory()
        # table owner（同时是 organization owner——保证 check_table_permission 直通）
        self.table_owner = User.objects.create_user(
            username="p16_table_owner", email="p16_to@example.com", password="x",
        )
        # 任何会作为 share.created_by 的 user 都必须 mirror（见 helper docstring）
        _mirror_user_to_postgresql(self.table_owner)
        self.organization = Organization.objects.create(
            name="P1-6 WT", owner=self.table_owner, type="team",
        )
        self.space = Space.objects.create(
            organization=self.organization, name="P1-6 Space",
            type="team",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.table_owner.id,
            name="p1-6 table",
        )
        # 给表加一个文本字段
        self.field = TableField.objects.using("postgresql").create(
            table=self.table, name="text_field", field_type="text", order=0,
            is_primary=False,
        )

        self.view = TableView.objects.using("postgresql").create(
            table=self.table,
            name="form view",
            view_type="form",
            config={"title": "p16 form"},
        )

    def _make_share(self, *, created_by):
        share = TableShare(
            table=self.table,
            view=self.view,
            share_type="form",
            share_id=TableShareService.generate_share_id(),
            permission="edit",
            created_by=created_by,
        )
        share.save(using="postgresql")
        return share

    def _submit(self, share, *, value="hello", mock_record_create: bool = True):
        """提交表单。

        ``mock_record_create=True`` 时把 RecordService.create_record patch 成
        直接返回 (Mock, None) 成功 —— 跳过真实 ``QuotaService`` 校验
        （settings_share_test 没装会员等级 fixture，真实 create 会卡在
        ``QuotaService.check_quota``）。这不影响 P1-6 的校验链路：
        owner 失权 → 403 OWNER_REVOKED 在 RecordService 被调到之前就触发了。
        """
        request = self.factory.post(f"/forms/{share.share_id}/submit")
        request.auth = None  # 匿名提交（公开表单语义）
        data = FormSubmitRequest(fields={str(self.field.id): value})
        if not mock_record_create:
            return submit_public_form(request, share.share_id, data)

        from unittest.mock import patch, MagicMock
        with patch(
            "apps.tabdata.services.record_service.RecordService"
        ) as mock_rs_cls:
            mock_rs = mock_rs_cls.return_value
            fake_record = MagicMock()
            fake_record.id = "fake-record-id"
            mock_rs.create_record.return_value = (fake_record, None)
            return submit_public_form(request, share.share_id, data)

    # ── 1. 正面：owner 是 table.owner_id → 直通 ──

    def test_owner_with_editor_permission_returns_201(self):
        """owner = table.owner_id → check_table_permission 走 owner 直通，
        提交成功（201，RecordService 走 mock 路径）。

        关键断言：P1-6 校验没有把合法 owner 误拦截，能走完 view 主流程
        返 201 = check_table_permission(editor) 返 True 路径。"""
        share = self._make_share(created_by=self.table_owner)
        response = self._submit(share, value="success-record")
        self.assertEqual(_response_status(response), 201)

    # ── 2. owner 被降为 viewer（不是 table.owner_id，且只有 TablePermission(viewer)）──

    def test_owner_demoted_to_viewer_returns_403_owner_revoked(self):
        """owner 现状：不是 table.owner_id；TablePermission 显式 viewer；
        既不是 organization owner 也不是 wt member（避免 wt fallback 走 editor）。
        → check_table_permission(editor) 返 False → 403 OWNER_REVOKED。"""
        demoted = User.objects.create_user(
            username="p16_demoted", email="p16_dm@example.com", password="x",
        )
        _mirror_user_to_postgresql(demoted)
        # 只给 viewer，不加入 organization（避免 wt fallback 提供 editor）
        TablePermission.objects.using("postgresql").create(
            table=self.table,
            subject_type="user",
            subject_id=str(demoted.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.table_owner.id),
        )

        share = self._make_share(created_by=demoted)
        response = self._submit(share)
        self.assertEqual(_response_status(response), 403)
        payload = _response_payload(response)
        self.assertEqual(payload["code"], "OWNER_REVOKED")

    # ── 3. owner 被移除 TablePermission（也不是 wt member / wt owner）──

    def test_owner_removed_from_table_permission_returns_403_owner_revoked(self):
        """owner 既不是 table.owner_id，也不在 TablePermission（is_active=False），
        也不是 wt 任何角色 → check_table_permission 返 False → 403 OWNER_REVOKED。"""
        removed = User.objects.create_user(
            username="p16_removed", email="p16_rm@example.com", password="x",
        )
        _mirror_user_to_postgresql(removed)
        # 先建一条 active 的 editor 权限（模拟"曾经是协作者"）
        perm = TablePermission.objects.using("postgresql").create(
            table=self.table,
            subject_type="user",
            subject_id=str(removed.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.table_owner.id),
        )
        share = self._make_share(created_by=removed)

        # 移除权限：is_active=False（模拟 admin 把他从协作者移除）
        perm.is_active = False
        perm.save(using="postgresql")

        response = self._submit(share)
        self.assertEqual(_response_status(response), 403)
        payload = _response_payload(response)
        self.assertEqual(payload["code"], "OWNER_REVOKED")

    # ── 4. 边界：owner 是 organization owner 走 fallback → 200 ──

    def test_owner_is_organization_owner_via_fallback_returns_201(self):
        """owner 不是 table.owner_id，TablePermission 也没有他，但他是 organization owner ——
        check_organization_permission 应给 'editor'，整个权限链通过 → 201。
        这覆盖"分享创建者后来退出 table 协作但仍是 wt 管理员"的边界。"""
        # 另建一个 user 当 organization owner（不能用 self.table_owner，否则走 table owner 直通）
        # 思路：建另一个 wt，把这个 table 挪过去，让新 wt 的 owner 当 share.created_by
        wt2_owner = User.objects.create_user(
            username="p16_wt2_owner", email="p16_w2o@example.com", password="x",
        )
        _mirror_user_to_postgresql(wt2_owner)
        wt2 = Organization.objects.create(
            name="P1-6 WT2", owner=wt2_owner, type="team",
        )
        # 让 self.table 挪到新 wt 下（直接改 organization_id 字段，简化 fixture）
        self.table.organization_id = wt2.id
        self.table.save(using="postgresql", update_fields=["organization_id"])

        share = self._make_share(created_by=wt2_owner)
        response = self._submit(share, value="wt-fallback-record")
        # wt owner 通过 organization fallback 拿到 admin → editor 校验通过 → 201
        self.assertEqual(_response_status(response), 201)
