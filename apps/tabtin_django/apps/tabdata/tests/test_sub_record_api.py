import json
from datetime import timedelta
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import Client, TestCase
from django.utils import timezone

from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord
from apps.tabdata.tests.test_undo_redo import (
    _ensure_free_tier,
    _ensure_native_table,
    _ensure_project_membership,
)
from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


def _issue_session_bound_token(user, *, label: str) -> str:
    """JWTAuth 强制 sid 绑定；测试 token 必须挂有效 UserSession。"""
    raw_key = f"sub_record_api_{label}_{user.id}".replace("-", "")[:64]
    UserSession.objects.get_or_create(
        session_key=SessionManager.hash_session_key(raw_key),
        defaults={
            "user": user,
            "session_type": "web",
            "ip_address": "127.0.0.1",
            "user_agent": "sub-record-api-test",
            "expires_at": timezone.now() + timedelta(hours=2),
        },
    )
    return generate_jwt_token(
        user, expire_hours=1, token_type="access", session_key=raw_key
    )


class SubRecordAPITestCase(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()

        self.client = Client()

        self.owner = User.objects.create_user(
            email="sub_record_api_owner@example.com",
            password="password123",
        )
        self.viewer = User.objects.create_user(
            email="sub_record_api_viewer@example.com",
            password="password123",
        )

        self.owner_token = _issue_session_bound_token(self.owner, label="owner")
        self.viewer_token = _issue_session_bound_token(self.viewer, label="viewer")

        ctx = create_test_organization_with_agent(
            owner=self.owner,
            organization_name="子记录API测试组织",
            space_name="子记录API测试项目",
            prefix="sub_record_api",
        )
        self.organization = ctx["organization"]
        self.space = ctx["space"]
        self.organization.members.create(user=self.viewer, role="viewer")
        _ensure_project_membership(
            organization=self.organization,
            project=self.space,
            user=self.owner,
            role="owner",
        )
        _ensure_project_membership(
            organization=self.organization,
            project=self.space,
            user=self.viewer,
            role="viewer",
        )

        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name="子记录API测试表",
            owner=self.owner,
        )
        self.primary_field = TableField.objects.create(
            table=self.table,
            name="标题",
            field_type="text",
            is_primary=True,
            order=0,
        )
        _ensure_native_table(
            self.space.id,
            self.table.id,
            fields=[self.primary_field],
        )

    def _auth_headers(self, token: str):
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def _create_record(self, title: str, order: float) -> TableRecord:
        return TableRecord.objects.create(
            table=self.table,
            created_by=self.owner,
            updated_by=self.owner,
            data={str(self.primary_field.id): title},
            order=order,
        )

    def _create_parent_field(self) -> TableField:
        return TableField.objects.create(
            table=self.table,
            name="父记录",
            field_type="link",
            order=1,
            config={
                "foreignTableId": str(self.table.id),
                "relationship": "ManyOne",
                "isOneWay": True,
                "isSubRecordParentField": True,
            },
        )

    def test_create_sub_record_denied_for_viewer(self):
        parent_record = self._create_record("父记录", 1)

        response = self.client.post(
            "/api/tabdata/sub-records/create",
            data=json.dumps(
                {
                    "table_id": str(self.table.id),
                    "parent_record_id": str(parent_record.id),
                    "data": {},
                }
            ),
            content_type="application/json",
            **self._auth_headers(self.viewer_token),
        )

        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], ErrorCode.PERMISSION_DENIED)

    def test_ensure_parent_field_denied_for_viewer(self):
        response = self.client.post(
            f"/api/tabdata/sub-records/tables/{self.table.id}/ensure-parent-field",
            content_type="application/json",
            **self._auth_headers(self.viewer_token),
        )

        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], ErrorCode.PERMISSION_DENIED)

    def test_create_parent_field_denied_for_viewer(self):
        response = self.client.post(
            f"/api/tabdata/sub-records/tables/{self.table.id}/create-parent-field",
            content_type="application/json",
            **self._auth_headers(self.viewer_token),
        )

        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], ErrorCode.PERMISSION_DENIED)

    def test_get_parent_field_allows_viewer_and_returns_none_when_absent(self):
        response = self.client.get(
            f"/api/tabdata/sub-records/tables/{self.table.id}/parent-field",
            **self._auth_headers(self.viewer_token),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIsNone(payload["data"]["field"])

    def test_list_self_link_fields_only_returns_many_one(self):
        valid = TableField.objects.create(
            table=self.table,
            name="有效父字段",
            field_type="link",
            order=1,
            config={
                "foreignTableId": str(self.table.id),
                "relationship": "ManyOne",
                "isOneWay": True,
            },
        )
        TableField.objects.create(
            table=self.table,
            name="无效OneMany",
            field_type="link",
            order=2,
            config={
                "foreignTableId": str(self.table.id),
                "relationship": "OneMany",
                "isOneWay": True,
            },
        )
        TableField.objects.create(
            table=self.table,
            name="无效非单向",
            field_type="link",
            order=3,
            config={
                "foreignTableId": str(self.table.id),
                "relationship": "ManyOne",
                "isOneWay": False,
            },
        )

        response = self.client.get(
            f"/api/tabdata/sub-records/tables/{self.table.id}/self-link-fields",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        fields = payload["data"]["fields"]
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["id"], str(valid.id))

    def test_create_sub_record_with_invalid_parent_field_returns_400(self):
        parent_record = self._create_record("父记录", 1)
        invalid_parent_field = TableField.objects.create(
            table=self.table,
            name="错误父字段",
            field_type="link",
            order=2,
            config={
                "foreignTableId": str(self.table.id),
                "relationship": "OneMany",
                "isOneWay": True,
            },
        )

        response = self.client.post(
            "/api/tabdata/sub-records/create",
            data=json.dumps(
                {
                    "table_id": str(self.table.id),
                    "parent_record_id": str(parent_record.id),
                    "parent_field_id": str(invalid_parent_field.id),
                    "data": {},
                }
            ),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], ErrorCode.VALIDATION_ERROR)
        self.assertIn("父记录字段无效", payload["message"])

    def test_move_sub_record_depth_overflow_returns_400(self):
        parent_field = self._create_parent_field()

        p0 = self._create_record("P0", 1)
        p1 = self._create_record("P1", 2)
        p2 = self._create_record("P2", 3)
        p3 = self._create_record("P3", 4)
        m0 = self._create_record("M0", 5)
        m1 = self._create_record("M1", 6)
        m2 = self._create_record("M2", 7)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=p1, foreign_record=p0, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=p2, foreign_record=p1, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=p3, foreign_record=p2, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=m1, foreign_record=m0, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=m2, foreign_record=m1, order=0
        )

        response = self.client.post(
            "/api/tabdata/sub-records/move",
            data=json.dumps(
                {
                    "table_id": str(self.table.id),
                    "record_id": str(m0.id),
                    "new_parent_id": str(p3.id),
                    "parent_field_id": str(parent_field.id),
                }
            ),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], ErrorCode.VALIDATION_ERROR)
        self.assertIn("移动后将超过最大层级深度", payload["message"])

    # ──────────────────────────────────────────────────────
    # 成功路径 API 测试
    # ──────────────────────────────────────────────────────

    @skipUnless(connection.vendor == 'postgresql', 'create_sub_record writes native storage')
    def test_create_sub_record_success(self):
        """成功创建子记录（201 响应）"""
        parent_field = self._create_parent_field()
        parent_record = self._create_record("Parent", 1)

        response = self.client.post(
            "/api/tabdata/sub-records/create",
            data=json.dumps({
                "table_id": str(self.table.id),
                "parent_record_id": str(parent_record.id),
                "parent_field_id": str(parent_field.id),
                "data": {str(self.primary_field.id): "NewChild"},
            }),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("record", payload["data"])
        self.assertEqual(payload["data"]["parent_field_id"], str(parent_field.id))

    def test_move_sub_record_success(self):
        """成功移动子记录到另一个父记录"""
        parent_field = self._create_parent_field()
        parent_a = self._create_record("ParentA", 1)
        parent_b = self._create_record("ParentB", 2)
        child = self._create_record("Child", 3)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent_a, order=0
        )

        response = self.client.post(
            "/api/tabdata/sub-records/move",
            data=json.dumps({
                "table_id": str(self.table.id),
                "record_id": str(child.id),
                "new_parent_id": str(parent_b.id),
                "parent_field_id": str(parent_field.id),
            }),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])

        # 验证新父链接
        self.assertTrue(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child, foreign_record=parent_b
            ).exists()
        )
        # 旧父链接消失
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child, foreign_record=parent_a
            ).exists()
        )

    def test_move_sub_record_to_root_success(self):
        """成功将子记录移到根级别"""
        parent_field = self._create_parent_field()
        parent = self._create_record("Parent", 1)
        child = self._create_record("Child", 2)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent, order=0
        )

        response = self.client.post(
            "/api/tabdata/sub-records/move",
            data=json.dumps({
                "table_id": str(self.table.id),
                "record_id": str(child.id),
                "new_parent_id": None,
                "parent_field_id": str(parent_field.id),
            }),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child
            ).exists()
        )

    @skipUnless(connection.vendor == 'postgresql', 'ensure_parent_field writes native column')
    def test_ensure_parent_field_success(self):
        """owner 成功自动创建父记录字段"""
        response = self.client.post(
            f"/api/tabdata/sub-records/tables/{self.table.id}/ensure-parent-field",
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        field_data = payload["data"]["field"]
        self.assertEqual(field_data["field_type"], "link")
        self.assertTrue(field_data["config"]["isSubRecordParentField"])
        self.assertEqual(field_data["config"]["relationship"], "ManyOne")

    @skipUnless(connection.vendor == 'postgresql', 'create_parent_field writes native column')
    def test_create_parent_field_returns_distinct_fields(self):
        """连续 create 得到不同父字段；ensure 仍返回第一个"""
        first = self.client.post(
            f"/api/tabdata/sub-records/tables/{self.table.id}/create-parent-field",
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )
        second = self.client.post(
            f"/api/tabdata/sub-records/tables/{self.table.id}/create-parent-field",
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )
        ensure = self.client.post(
            f"/api/tabdata/sub-records/tables/{self.table.id}/ensure-parent-field",
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(ensure.status_code, 200)
        first_id = first.json()["data"]["field"]["id"]
        second_id = second.json()["data"]["field"]["id"]
        ensure_id = ensure.json()["data"]["field"]["id"]
        self.assertNotEqual(first_id, second_id)
        self.assertEqual(ensure_id, first_id)

    def test_get_parent_field_returns_field_when_exists(self):
        """GET parent-field 在存在父字段时返回字段信息"""
        parent_field = self._create_parent_field()

        response = self.client.get(
            f"/api/tabdata/sub-records/tables/{self.table.id}/parent-field",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIsNotNone(payload["data"]["field"])
        self.assertEqual(payload["data"]["field"]["id"], str(parent_field.id))

    # ──────────────────────────────────────────────────────
    # reorder-tree API 测试
    # ──────────────────────────────────────────────────────

    @skipUnless(connection.vendor == 'postgresql', 'reorder_tree writes native storage')
    def test_reorder_tree_success(self):
        """reorder-tree 正常改变层级和排序"""
        parent_field = self._create_parent_field()
        root = self._create_record("Root", 1)
        child = self._create_record("Child", 2)
        target = self._create_record("Target", 3)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=root, order=0
        )

        response = self.client.post(
            "/api/tabdata/sub-records/reorder-tree",
            data=json.dumps(
                {
                    "table_id": str(self.table.id),
                    "moved_root_record_id": str(child.id),
                    "new_parent_id": str(target.id),
                    "position": "after",
                    "anchor_record_id": str(target.id),
                    "parent_field_id": str(parent_field.id),
                }
            ),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertTrue(payload["data"]["success"])
        self.assertIn(str(child.id), payload["data"]["updated_record_ids"])

    @skipUnless(connection.vendor == 'postgresql', 'reorder_tree writes native storage')
    def test_reorder_tree_to_top_level(self):
        """reorder-tree 可将子记录提升为顶级"""
        parent_field = self._create_parent_field()
        root = self._create_record("Root", 1)
        child = self._create_record("Child", 2)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=root, order=0
        )

        response = self.client.post(
            "/api/tabdata/sub-records/reorder-tree",
            data=json.dumps(
                {
                    "table_id": str(self.table.id),
                    "moved_root_record_id": str(child.id),
                    "new_parent_id": None,
                    "position": "after",
                    "anchor_record_id": str(root.id),
                    "parent_field_id": str(parent_field.id),
                }
            ),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["data"]["success"])

        # 验证层级已清除
        has_link = LinkRecord.objects.filter(
            link_field=parent_field, self_record=child
        ).exists()
        self.assertFalse(has_link)

    def test_reorder_tree_cycle_returns_400(self):
        """reorder-tree 循环引用应返回 400"""
        parent_field = self._create_parent_field()
        parent = self._create_record("Parent", 1)
        child = self._create_record("Child", 2)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent, order=0
        )

        response = self.client.post(
            "/api/tabdata/sub-records/reorder-tree",
            data=json.dumps(
                {
                    "table_id": str(self.table.id),
                    "moved_root_record_id": str(parent.id),
                    "new_parent_id": str(child.id),
                    "position": "after",
                    "anchor_record_id": str(child.id),
                    "parent_field_id": str(parent_field.id),
                }
            ),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertIn("不能将记录移动到自己的子记录下", payload["message"])

    def test_reorder_tree_depth_overflow_returns_400(self):
        """reorder-tree 深度溢出应返回 400"""
        parent_field = self._create_parent_field()

        d0 = self._create_record("D0", 1)
        d1 = self._create_record("D1", 2)
        d2 = self._create_record("D2", 3)
        d3 = self._create_record("D3", 4)
        m0 = self._create_record("M0", 5)
        m1 = self._create_record("M1", 6)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=d1, foreign_record=d0, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=d2, foreign_record=d1, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=d3, foreign_record=d2, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=m1, foreign_record=m0, order=0
        )

        response = self.client.post(
            "/api/tabdata/sub-records/reorder-tree",
            data=json.dumps(
                {
                    "table_id": str(self.table.id),
                    "moved_root_record_id": str(m0.id),
                    "new_parent_id": str(d3.id),
                    "position": "after",
                    "anchor_record_id": str(d3.id),
                    "parent_field_id": str(parent_field.id),
                }
            ),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertIn("超过最大层级深度", payload["message"])

    def test_reorder_tree_denied_for_viewer(self):
        """reorder-tree 对 viewer 应返回 403"""
        parent_field = self._create_parent_field()
        record = self._create_record("A", 1)

        response = self.client.post(
            "/api/tabdata/sub-records/reorder-tree",
            data=json.dumps(
                {
                    "table_id": str(self.table.id),
                    "moved_root_record_id": str(record.id),
                    "position": "end",
                    "parent_field_id": str(parent_field.id),
                }
            ),
            content_type="application/json",
            **self._auth_headers(self.viewer_token),
        )

        self.assertEqual(response.status_code, 403)

    @skipUnless(connection.vendor == 'postgresql', 'reorder_tree writes native storage')
    def test_reorder_tree_with_descendants_moves_subtree(self):
        """reorder-tree move_with_descendants 将子树整体移动"""
        parent_field = self._create_parent_field()

        root = self._create_record("Root", 1)
        child = self._create_record("Child", 2)
        grandchild = self._create_record("Grandchild", 3)
        target = self._create_record("Target", 4)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=root, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=grandchild, foreign_record=child, order=0
        )

        response = self.client.post(
            "/api/tabdata/sub-records/reorder-tree",
            data=json.dumps(
                {
                    "table_id": str(self.table.id),
                    "moved_root_record_id": str(child.id),
                    "new_parent_id": str(target.id),
                    "position": "after",
                    "anchor_record_id": str(target.id),
                    "parent_field_id": str(parent_field.id),
                    "move_with_descendants": True,
                }
            ),
            content_type="application/json",
            **self._auth_headers(self.owner_token),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        updated_ids = payload["data"]["updated_record_ids"]
        self.assertEqual(len(updated_ids), 2)
        self.assertIn(str(child.id), updated_ids)
        self.assertIn(str(grandchild.id), updated_ids)
