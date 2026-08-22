"""#4111 字段角色可见性权限矩阵（真实 PostgreSQL）。

覆盖：
- owner/admin/editor/viewer 对 visibility_roles=['admin'] 字段
- 分享 edit 接收者看不到 admin-only（用户复现问题）
- 匿名/公开 view 分享看不到 admin-only
- 派生字段依赖隐藏字段时一并不可见
- filter/sort 含隐藏字段不泄漏
- collab：受限角色拿不到全量快照 / 得到降级信号
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import (
    FieldReference,
    Table,
    TableField,
    TablePermission,
    TableShare,
    TableView,
)
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.pg_type_map import is_system_field
from apps.tabdata.services.collab_service import CollabService
from apps.tabdata.services.field_visibility import (
    COLLAB_DENY_REASON_FIELD_VISIBILITY,
    COLLAB_MODE_REST_PROJECTION,
    FieldVisibilityCollabRestrictedError,
    evaluate_collab_access,
    filter_record_data,
    get_visible_fields,
    resolve_effective_table_role,
    resolve_sort_by_for_visibility,
    sanitize_filter_rules_for_visibility,
    sanitize_filters_for_visibility,
)
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.services.share_service import TableShareService
from apps.tabdata.services.table_service import TableService
from apps.tabdata.services.view_data_service import ViewDataService
from apps.tabdata.utils.record_serializers import serialize_record
from apps.tabtinspace.models import OrganizationMember
from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _disconnect_default_org_signal():
    from apps.tabtinspace.signals import create_default_organization

    try:
        post_save.disconnect(create_default_organization, sender=User)
    except Exception:
        pass


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "字段可见性测试自动初始化",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


def _ensure_native_table(space_id, table_id, fields=None) -> None:
    ddl = DDLManager(db_alias="default")
    ddl.ensure_schema(space_id)
    ddl.create_native_table(space_id, table_id)
    for field in fields or []:
        if not is_system_field(field.field_type):
            ddl.add_column(space_id, table_id, field.id, field.field_type, field.config)


class FieldVisibilityRolesMatrixTests(TestCase):
    """字段角色可见性矩阵 — 真实 PG。"""

    databases = ["default", "postgresql"]

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _disconnect_default_org_signal()

    def setUp(self):
        _ensure_free_tier()
        self.owner = User.objects.create_user(
            username=f"fv_owner_{uuid.uuid4().hex[:8]}",
            email=f"fv_owner_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.admin_user = User.objects.create_user(
            username=f"fv_admin_{uuid.uuid4().hex[:8]}",
            email=f"fv_admin_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.editor_user = User.objects.create_user(
            username=f"fv_editor_{uuid.uuid4().hex[:8]}",
            email=f"fv_editor_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.viewer_user = User.objects.create_user(
            username=f"fv_viewer_{uuid.uuid4().hex[:8]}",
            email=f"fv_viewer_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.share_editor = User.objects.create_user(
            username=f"fv_share_ed_{uuid.uuid4().hex[:8]}",
            email=f"fv_share_ed_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )

        ctx = create_test_organization_with_agent(
            owner=self.owner,
            organization_name="FV Org",
            space_name="FV Space",
            prefix="fv_roles",
        )
        self.organization = ctx["organization"]
        self.space = ctx["space"]
        for u in (
            self.admin_user,
            self.editor_user,
            self.viewer_user,
            self.share_editor,
        ):
            OrganizationMember.objects.get_or_create(
                organization=self.organization,
                user=u,
                defaults={"role": "editor"},
            )

        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            name="FV Table",
        )
        self.public_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="公开标题",
            field_type="text",
            order=0,
        )
        self.admin_only_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="管理员机密",
            field_type="text",
            order=1,
            config={"visibility_roles": ["admin"]},
        )
        # owner 也在 visibility_roles 里才能看到（与产品「管理员可见」一致时
        # 常配 admin+owner；此处严格只配 admin，验证 owner 仍因 get_table_role=owner
        # 且 field_allows_role 要求 role in list —— owner ∉ {admin} 时不可见？
        # 产品语义：visibility_roles=['admin'] 通常含 owner 抬权。
        # 本仓库既有 helper：role must be in list；owner 不自动抬。
        # 测试按「显式列表」契约：owner 需在列表中才可见。
        # 为覆盖「管理员可见」场景，另建一套含 owner/admin 的字段用于分享复现。
        self.secret_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="仅管理员",
            field_type="text",
            order=2,
            config={"visibility_roles": ["owner", "admin"]},
        )

        TablePermission.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.admin_user.id),
            permission="admin",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        TablePermission.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.editor_user.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        TablePermission.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.viewer_user.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
        )

        self.view = TableView.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, name="Grid", order=0,
        )

        _ensure_native_table(
            self.space.id,
            self.table.id,
            [self.public_field, self.admin_only_field, self.secret_field],
        )

        # 写入一条含机密字段的记录（经 owner）
        record, error = RecordService(user=self.owner).create_record(
            self.table.id,
            {
                "公开标题": "hello",
                "管理员机密": "admin-only-value",
                "仅管理员": "secret-value",
            },
        )
        self.assertIsNone(error, msg=error)
        self.assertIsNotNone(record)
        self.record_id = record.id

    def _visible_names(self, user, *, share=None):
        role = resolve_effective_table_role(user, self.table, share=share)
        return {f.name for f in get_visible_fields(self.table.id, role)}

    def _record_data_keys(self, user):
        result = RecordService(user=user).list_records(self.table.id)
        self.assertGreaterEqual(result["total"], 1)
        data = result["records"][0].get("data") or {}
        return set(data.keys())

    # ── 角色矩阵 ──────────────────────────────────────────

    def test_owner_sees_owner_admin_secret_field(self):
        """UI 勾选「管理员」只写 ['admin']；owner 作为资源所有者仍永可见。"""
        names = self._visible_names(self.owner)
        self.assertIn("公开标题", names)
        self.assertIn("仅管理员", names)
        self.assertIn("管理员机密", names)

    def test_admin_sees_admin_only_fields(self):
        names = self._visible_names(self.admin_user)
        self.assertIn("公开标题", names)
        self.assertIn("管理员机密", names)
        self.assertIn("仅管理员", names)
        keys = self._record_data_keys(self.admin_user)
        self.assertIn("仅管理员", keys)
        self.assertIn("管理员机密", keys)

    def test_editor_cannot_see_admin_only_fields(self):
        names = self._visible_names(self.editor_user)
        self.assertIn("公开标题", names)
        self.assertNotIn("管理员机密", names)
        self.assertNotIn("仅管理员", names)
        keys = self._record_data_keys(self.editor_user)
        self.assertIn("公开标题", keys)
        self.assertNotIn("仅管理员", keys)
        self.assertNotIn("管理员机密", keys)

    def test_viewer_cannot_see_admin_only_fields(self):
        names = self._visible_names(self.viewer_user)
        self.assertIn("公开标题", names)
        self.assertNotIn("仅管理员", names)
        keys = self._record_data_keys(self.viewer_user)
        self.assertNotIn("仅管理员", keys)

    def test_list_fields_filters_by_role(self):
        editor_fields = list(TableService(user=self.editor_user).list_fields(self.table.id))
        names = {f.name for f in editor_fields}
        self.assertIn("公开标题", names)
        self.assertNotIn("仅管理员", names)

        admin_fields = list(TableService(user=self.admin_user).list_fields(self.table.id))
        admin_names = {f.name for f in admin_fields}
        self.assertIn("仅管理员", admin_names)

    # ── 分享复现：edit 接收者看不到 admin-only ─────────────

    def test_share_edit_recipient_cannot_see_admin_only_field(self):
        """用户复现：字段设管理员可见，分享可编辑，接收者仍不该看到该字段。"""
        share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            view=self.view,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="edit",
            created_by=self.owner,
        )
        role = resolve_effective_table_role(
            self.share_editor, self.table, share=share,
        )
        self.assertEqual(role, "editor")
        names = {f.name for f in get_visible_fields(self.table.id, role)}
        self.assertIn("公开标题", names)
        self.assertNotIn("仅管理员", names)
        self.assertNotIn("管理员机密", names)

        meta = TableShareService.serialize_meta(
            share, include_protected=True, user=self.share_editor,
        )
        meta_names = {f["name"] for f in meta.get("fields", [])}
        self.assertIn("公开标题", meta_names)
        self.assertNotIn("仅管理员", meta_names)

        with patch.object(
            TableShareService,
            "verify_share_access",
            return_value=None,
        ):
            records_payload = TableShareService.get_records(
                share, user=self.share_editor, page=1, page_size=50,
            )
        for rec in records_payload.get("records", []):
            data = rec.get("data") or {}
            self.assertNotIn("仅管理员", data)
            self.assertNotIn("管理员机密", data)

    def test_anonymous_public_view_share_cannot_see_admin_only(self):
        share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            view=self.view,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="view",
            created_by=self.owner,
        )
        role = resolve_effective_table_role(None, self.table, share=share)
        self.assertEqual(role, "viewer")
        names = {f.name for f in get_visible_fields(self.table.id, role)}
        self.assertIn("公开标题", names)
        self.assertNotIn("仅管理员", names)

        meta = TableShareService.serialize_meta(
            share, include_protected=True, user=None,
        )
        meta_names = {f["name"] for f in meta.get("fields", [])}
        self.assertNotIn("仅管理员", meta_names)

    def test_anonymous_public_edit_share_reads_with_viewer_projection(self):
        """公开 edit 的匿名访问只获得 viewer 字段，不获得 editor 写入身份。"""
        share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            view=self.view,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="edit",
            created_by=self.owner,
        )

        role = resolve_effective_table_role(None, self.table, share=share)

        self.assertEqual(role, "viewer")
        names = {f.name for f in get_visible_fields(self.table.id, role)}
        self.assertIn("公开标题", names)
        self.assertNotIn("仅管理员", names)

    # ── 关联依赖闭包 ──────────────────────────────────────

    def test_dependent_field_hidden_when_source_hidden(self):
        dependent_link = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="机密关联",
            field_type="link",
            order=10,
            config={"foreignTableId": str(self.table.id)},
        )
        FieldReference.objects.using(TABDATA_DB_ALIAS).create(
            from_field=self.secret_field,
            to_field=dependent_link,
        )
        editor_names = self._visible_names(self.editor_user)
        self.assertNotIn("仅管理员", editor_names)
        self.assertNotIn("机密关联", editor_names)

        admin_names = self._visible_names(self.admin_user)
        self.assertIn("仅管理员", admin_names)
        self.assertIn("机密关联", admin_names)

    # ── filter / sort 侧信道 ──────────────────────────────

    def test_filter_and_sort_on_hidden_field_do_not_leak(self):
        visible_keys = RecordService(user=self.editor_user)._get_visible_field_keys(
            self.table.id,
        )
        # 简单 filter：隐藏字段被剔除
        cleaned = sanitize_filters_for_visibility(
            {"仅管理员": "secret-value", "公开标题": "hello"},
            visible_keys,
        )
        self.assertNotIn("仅管理员", cleaned)
        self.assertIn("公开标题", cleaned)

        # filterSet：隐藏字段规则被剔除
        cleaned_set = sanitize_filters_for_visibility(
            {
                "conjunction": "and",
                "filterSet": [
                    {
                        "field_id": str(self.secret_field.id),
                        "operator": "equals",
                        "value": "secret-value",
                    },
                    {
                        "field_id": str(self.public_field.id),
                        "operator": "equals",
                        "value": "hello",
                    },
                ],
            },
            visible_keys,
        )
        field_refs = [
            item.get("field_id") for item in cleaned_set.get("filterSet", [])
        ]
        self.assertNotIn(str(self.secret_field.id), field_refs)
        self.assertIn(str(self.public_field.id), field_refs)

        # sort 隐藏字段被忽略
        self.assertIsNone(
            resolve_sort_by_for_visibility("仅管理员", visible_keys)
        )
        self.assertEqual(
            resolve_sort_by_for_visibility("公开标题", visible_keys),
            "公开标题",
        )

        # list_records：带隐藏字段 filter 时不得用其收窄结果（被 strip 后仍能命中公开记录）
        result = RecordService(user=self.editor_user).list_records(
            self.table.id,
            filters={"仅管理员": "not-the-secret"},
        )
        self.assertGreaterEqual(result["total"], 1)
        for rec in result["records"]:
            data = rec.get("data") or {}
            self.assertNotIn("仅管理员", data)

    def test_filter_record_data_helper(self):
        data = {"公开标题": "a", "仅管理员": "b", str(self.secret_field.id): "c"}
        visible = {"ids": {str(self.public_field.id)}, "names": {"公开标题"}, "dbFieldNames": set()}
        filtered = filter_record_data(data, visible)
        self.assertEqual(filtered, {"公开标题": "a"})

    # ── Collab 降级 ───────────────────────────────────────

    def test_collab_evaluate_denies_restricted_role(self):
        decision = evaluate_collab_access(self.editor_user, self.table)
        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["collab_mode"], COLLAB_MODE_REST_PROJECTION)
        self.assertEqual(decision["reason"], COLLAB_DENY_REASON_FIELD_VISIBILITY)
        self.assertGreater(decision["hidden_field_count"], 0)

        owner_decision = evaluate_collab_access(self.owner, self.table)
        # owner 永可见全部字段 → collab full
        self.assertTrue(owner_decision["allowed"])
        self.assertEqual(owner_decision["collab_mode"], "full")

        admin_decision = evaluate_collab_access(self.admin_user, self.table)
        self.assertTrue(admin_decision["allowed"])
        self.assertEqual(admin_decision["collab_mode"], "full")

    def test_share_edit_collab_token_degrades_for_field_visibility(self):
        """分享 edit 接收者签发 collab token 时应得到 rest_projection 降级信号。"""
        share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            view=self.view,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="edit",
            created_by=self.owner,
        )
        payload = TableShareService.issue_share_collab_token(
            share, user=self.share_editor,
        )
        self.assertEqual(payload.get("collab_mode"), COLLAB_MODE_REST_PROJECTION)
        self.assertEqual(payload.get("reason"), COLLAB_DENY_REASON_FIELD_VISIBILITY)
        self.assertFalse(payload.get("authorized"))
        self.assertNotIn("share_collab_token", payload)
        self.assertGreater(payload.get("hidden_field_count", 0), 0)

    def test_anonymous_view_share_collab_token_degrades(self):
        share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            view=self.view,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="view",
            created_by=self.owner,
        )
        payload = TableShareService.issue_share_collab_token(share, user=None)
        self.assertEqual(payload.get("collab_mode"), COLLAB_MODE_REST_PROJECTION)
        self.assertNotIn("share_collab_token", payload)

    def test_build_snapshot_rejects_restricted_visitor(self):
        with self.assertRaises(FieldVisibilityCollabRestrictedError) as cm:
            CollabService.build_snapshot(
                self.table.id,
                user=self.editor_user,
                enforce_field_visibility=True,
            )
        self.assertEqual(
            cm.exception.decision.get("reason"),
            COLLAB_DENY_REASON_FIELD_VISIBILITY,
        )

        # 无访问者上下文的房间初始化仍可构建全量（准入已在 auth 挡）
        snapshot = CollabService.build_snapshot(self.table.id)
        field_names = {f["name"] for f in snapshot["fields"]}
        self.assertIn("仅管理员", field_names)

    def test_build_snapshot_allows_admin_with_enforcement(self):
        snapshot = CollabService.build_snapshot(
            self.table.id,
            user=self.admin_user,
            enforce_field_visibility=True,
        )
        self.assertEqual(snapshot["table_id"], str(self.table.id))
        field_names = {f["name"] for f in snapshot["fields"]}
        self.assertIn("仅管理员", field_names)

    # ── code-validator 必补：写回 / 写入拦截 / get_field / ViewData ──

    def test_share_patch_response_excludes_admin_only(self):
        """分享 PATCH 写回响应不得带回 admin-only 字段值。"""
        share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            view=self.view,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="edit",
            created_by=self.owner,
        )
        with patch.object(
            TableShareService,
            "verify_share_access",
            return_value=None,
        ):
            updated = TableShareService.update_shared_record(
                share,
                user=self.share_editor,
                record_id=self.record_id,
                data={str(self.public_field.id): "patched-title"},
            )
        self.assertTrue(getattr(updated, "_visibility_filtered", False))
        payload = serialize_record(updated)
        data = payload.get("data") or {}
        self.assertIn("公开标题", data)
        self.assertEqual(data.get("公开标题"), "patched-title")
        self.assertNotIn("仅管理员", data)
        self.assertNotIn("管理员机密", data)

    def test_share_patch_response_excludes_hidden_system_fields(self):
        """系统字段配置 visibility_roles 后，分享 PATCH 写回不得再注入。"""
        created_time_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="创建时间",
            field_type="created_time",
            order=90,
            config={"visibility_roles": ["admin"]},
        )
        created_by_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="创建者",
            field_type="created_by",
            order=91,
            config={"visibility_roles": ["owner", "admin"]},
        )
        _ensure_native_table(
            self.space.id,
            self.table.id,
            [self.public_field, self.admin_only_field, self.secret_field,
             created_time_field, created_by_field],
        )

        share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            view=self.view,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="edit",
            created_by=self.owner,
        )
        with patch.object(
            TableShareService,
            "verify_share_access",
            return_value=None,
        ):
            updated = TableShareService.update_shared_record(
                share,
                user=self.share_editor,
                record_id=self.record_id,
                data={str(self.public_field.id): "patched-sys"},
            )
        payload = serialize_record(updated)
        data = payload.get("data") or {}
        fields = payload.get("fields") or {}
        self.assertIn("公开标题", data)
        self.assertNotIn("创建时间", data)
        self.assertNotIn("创建者", data)
        self.assertNotIn("创建时间", fields)
        self.assertNotIn("创建者", fields)
        self.assertNotIn(str(created_time_field.id), fields)
        self.assertNotIn(str(created_by_field.id), fields)

    def test_share_write_hidden_field_rejected(self):
        """分享写入隐藏 field_id 必须拒绝。"""
        share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            view=self.view,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="edit",
            created_by=self.owner,
        )
        with patch.object(
            TableShareService,
            "verify_share_access",
            return_value=None,
        ):
            with self.assertRaises(ValueError) as cm:
                TableShareService.update_shared_record(
                    share,
                    user=self.share_editor,
                    record_id=self.record_id,
                    data={str(self.secret_field.id): "hacked"},
                )
        self.assertIn("field_visibility_restricted", str(cm.exception))

        # 底层 RecordService + share_grant 同样拒绝
        updated, error = RecordService(user=self.share_editor).update_record(
            self.record_id,
            {str(self.admin_only_field.id): "hacked-admin"},
            share_grant=share,
        )
        self.assertIsNone(updated)
        self.assertIsNotNone(error)
        self.assertIn("field_visibility_restricted", error)

    def test_get_field_hides_admin_only_from_editor(self):
        hidden = TableService(user=self.editor_user).get_field(self.secret_field.id)
        self.assertIsNone(hidden)
        hidden_admin_only = TableService(user=self.editor_user).get_field(
            self.admin_only_field.id,
        )
        self.assertIsNone(hidden_admin_only)

        visible = TableService(user=self.admin_user).get_field(self.secret_field.id)
        self.assertIsNotNone(visible)
        self.assertEqual(visible.id, self.secret_field.id)

        owner_visible = TableService(user=self.owner).get_field(
            self.admin_only_field.id,
        )
        self.assertIsNotNone(owner_visible)

    def test_owner_visible_and_collab_full_for_admin_only_roles(self):
        """visibility_roles=['admin'] 时 owner 仍可见且 collab full。"""
        names = self._visible_names(self.owner)
        self.assertIn("管理员机密", names)
        decision = evaluate_collab_access(self.owner, self.table)
        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["collab_mode"], "full")

        snapshot = CollabService.build_snapshot(
            self.table.id,
            user=self.owner,
            enforce_field_visibility=True,
        )
        field_names = {f["name"] for f in snapshot["fields"]}
        self.assertIn("管理员机密", field_names)

    def test_view_data_service_filter_hidden_field_no_leak(self):
        """ViewDataService filter 引用隐藏字段不得侧信道收窄 / 泄漏值。"""
        visible_keys = RecordService(user=self.editor_user)._get_visible_field_keys(
            self.table.id,
        )
        cleaned = sanitize_filter_rules_for_visibility(
            [
                {
                    "field_id": str(self.secret_field.id),
                    "operator": "equals",
                    "value": "not-the-secret",
                },
                {
                    "field_id": str(self.public_field.id),
                    "operator": "equals",
                    "value": "hello",
                },
            ],
            visible_keys,
        )
        refs = [item.get("field_id") for item in (cleaned or [])]
        self.assertNotIn(str(self.secret_field.id), refs)
        self.assertIn(str(self.public_field.id), refs)

        result = ViewDataService(user=self.editor_user).get_view_records(
            self.view.id,
            filters=[
                {
                    "field_id": str(self.secret_field.id),
                    "operator": "equals",
                    "value": "not-the-secret",
                },
            ],
        )
        # 隐藏字段 filter 被 strip 后不应把公开记录滤没
        total = result.get("total")
        if total is None:
            total = len(result.get("records") or [])
        self.assertGreaterEqual(total, 1)
        for rec in result.get("records") or []:
            data = rec.get("data") or {}
            self.assertNotIn("仅管理员", data)
            self.assertNotIn("管理员机密", data)
