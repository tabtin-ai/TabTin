"""Admin 组织详情 · 资源与资产列表 API。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.db.models import Q
from django.test import RequestFactory, SimpleTestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.tabtinspace.admin_api import (
    _extract_context_item_file_size_bytes,
    _serialize_space_item,
    admin_list_organization_resources,
)


def _expected_organization_host_q(organization_id) -> Q:
    """与 admin_list_organization_resources 生产路径保持同形。"""
    return Q(workspace__organization_id=organization_id) | Q(
        project__organization_id=organization_id
    )


def _q_lookup_keys(q: Q) -> set[str]:
    keys: set[str] = set()
    for child in q.children:
        if isinstance(child, Q):
            keys |= _q_lookup_keys(child)
        elif isinstance(child, tuple) and child:
            keys.add(str(child[0]).split("__")[0])
    return keys


class AdminOrganizationResourcesApiTests(SimpleTestCase):
    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.organization_id = uuid4()
        self.auth = SimpleNamespace(id=uuid4(), is_staff=True, is_superuser=True)

    def _get(self, path: str):
        request = self.rf.get(path)
        request.auth = self.auth
        return request

    def _stub_list_queryset(self, context_objects, items, *, by_type=None):
        """filter(org_q) -> exclude×3 -> filter(is_archived) -> facets / page。"""
        after_excludes = (
            context_objects.filter.return_value.exclude.return_value.exclude.return_value.exclude.return_value
        )
        filtered_qs = after_excludes.filter.return_value
        empty_facet: list = []
        filtered_qs.exclude.return_value.values.return_value.annotate.return_value.order_by.return_value = (
            empty_facet
        )
        filtered_qs.values.return_value.annotate.return_value.order_by.return_value = (
            by_type
            if by_type is not None
            else [{"item_type": "tabdoc", "count": len(items)}]
        )
        ordered = MagicMock()
        ordered.__getitem__ = lambda _self, _key: list(items)
        filtered_qs.count.return_value = len(items)
        filtered_qs.select_related.return_value.order_by.return_value = ordered
        after_excludes.filter.return_value = filtered_qs
        return filtered_qs

    def _assert_endpoint_org_filter(self, context_objects) -> None:
        """钉死端点首个 ContextItem.objects.filter：必须含 workspace|project 组织臂，且无 space。"""
        self.assertTrue(context_objects.filter.called)
        args, kwargs = context_objects.filter.call_args_list[0]
        self.assertEqual(
            len(args),
            1,
            "organization filter must be a positional Q, not space__ kwargs",
        )
        org_q = args[0]
        self.assertIsInstance(org_q, Q)
        self.assertEqual(org_q, _expected_organization_host_q(self.organization_id))
        self.assertEqual(org_q.connector, Q.OR)
        self.assertEqual(kwargs.get("trashed_at__isnull"), True)
        self.assertNotIn("space__organization_id", kwargs)
        self.assertNotIn("space_id", kwargs)
        lookup_roots = _q_lookup_keys(org_q)
        self.assertEqual(lookup_roots, {"workspace", "project"})
        self.assertNotIn("space", lookup_roots)

    def test_extract_file_size_from_metadata(self):
        item = SimpleNamespace(
            metadata={"file_size": "4096"},
            item_type="tabfiles",
            resource_id=str(uuid4()),
            id=uuid4(),
        )
        self.assertEqual(_extract_context_item_file_size_bytes(item), 4096)

    def test_extract_file_size_missing(self):
        item = SimpleNamespace(
            metadata={},
            item_type="tabdoc",
            resource_id=str(uuid4()),
            id=uuid4(),
        )
        self.assertIsNone(_extract_context_item_file_size_bytes(item))

    @patch("apps.tabtinspace.admin_api._build_owner_name_map", return_value={})
    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    @patch("apps.tabtinspace.admin_api.Organization.objects")
    def test_list_organization_resources_filters_workspace_or_project_org(
        self, org_objects, context_objects, _name_map
    ):
        """#6468：端点真实 filter 必须是 workspace|project 组织 Q，不得 space__。"""
        org_objects.filter.return_value.first.return_value = SimpleNamespace(
            id=self.organization_id
        )
        filtered_qs = self._stub_list_queryset(context_objects, items=[])

        request = self._get(
            f"/api/auth/admin/organizations/{self.organization_id}/resources"
        )
        resp = admin_list_organization_resources(
            request, organization_id=self.organization_id
        )
        self.assertTrue(resp["success"])
        self._assert_endpoint_org_filter(context_objects)
        filtered_qs.select_related.assert_called_with(
            "workspace", "project", "created_by", "updated_by"
        )

    @patch("apps.tabtinspace.admin_api._build_owner_name_map", return_value={})
    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    @patch("apps.tabtinspace.admin_api.Organization.objects")
    def test_list_organization_resources_workspace_hosted_item(
        self, org_objects, context_objects, _name_map
    ):
        org_objects.filter.return_value.first.return_value = SimpleNamespace(
            id=self.organization_id
        )
        now = timezone.now()
        workspace_id = uuid4()
        user_id = uuid4()
        item = SimpleNamespace(
            id=uuid4(),
            resource_id=str(uuid4()),
            item_type="tabdoc",
            title="产品说明",
            workspace_id=workspace_id,
            project_id=None,
            workspace=SimpleNamespace(
                name="演示空间", organization_id=self.organization_id
            ),
            project=None,
            is_archived=False,
            status="active",
            created_by_id=user_id,
            updated_by_id=user_id,
            created_at=now,
            updated_at=now,
            metadata={},
        )
        filtered_qs = self._stub_list_queryset(context_objects, items=[item])

        request = self._get(
            f"/api/auth/admin/organizations/{self.organization_id}/resources"
        )
        resp = admin_list_organization_resources(
            request, organization_id=self.organization_id
        )
        self.assertTrue(resp["success"])
        self._assert_endpoint_org_filter(context_objects)
        self.assertEqual(resp["data"]["total"], 1)
        self.assertEqual(resp["data"]["items"][0]["title"], "产品说明")
        self.assertEqual(resp["data"]["items"][0]["item_type"], "tabdoc")
        self.assertEqual(resp["data"]["items"][0]["space_id"], str(workspace_id))
        self.assertEqual(resp["data"]["items"][0]["space_name"], "演示空间")
        self.assertEqual(resp["data"]["by_type"][0]["item_type"], "tabdoc")
        filtered_qs.select_related.assert_called_with(
            "workspace", "project", "created_by", "updated_by"
        )

    @patch("apps.tabtinspace.admin_api._build_owner_name_map", return_value={})
    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    @patch("apps.tabtinspace.admin_api.Organization.objects")
    def test_list_organization_resources_project_hosted_item(
        self, org_objects, context_objects, _name_map
    ):
        """团队资产挂 Project：序列化 space_id/space_name 取自 project。"""
        org_objects.filter.return_value.first.return_value = SimpleNamespace(
            id=self.organization_id
        )
        now = timezone.now()
        project_id = uuid4()
        user_id = uuid4()
        item = SimpleNamespace(
            id=uuid4(),
            resource_id=str(uuid4()),
            item_type="tabdata",
            title="项目交付表",
            workspace_id=None,
            project_id=project_id,
            workspace=None,
            project=SimpleNamespace(
                name="交付项目", organization_id=self.organization_id
            ),
            is_archived=False,
            status="active",
            created_by_id=user_id,
            updated_by_id=user_id,
            created_at=now,
            updated_at=now,
            metadata={},
        )
        filtered_qs = self._stub_list_queryset(
            context_objects,
            items=[item],
            by_type=[{"item_type": "tabdata", "count": 1}],
        )

        request = self._get(
            f"/api/auth/admin/organizations/{self.organization_id}/resources"
        )
        resp = admin_list_organization_resources(
            request, organization_id=self.organization_id
        )
        self.assertTrue(resp["success"])
        self._assert_endpoint_org_filter(context_objects)
        row = resp["data"]["items"][0]
        self.assertEqual(row["title"], "项目交付表")
        self.assertEqual(row["item_type"], "tabdata")
        self.assertEqual(row["space_id"], str(project_id))
        self.assertEqual(row["space_name"], "交付项目")
        filtered_qs.select_related.assert_called_with(
            "workspace", "project", "created_by", "updated_by"
        )

    @patch("apps.tabtinspace.admin_api.Organization.objects")
    def test_list_organization_resources_not_found(self, org_objects):
        org_objects.filter.return_value.first.return_value = None
        request = self._get(
            f"/api/auth/admin/organizations/{self.organization_id}/resources"
        )
        resp = admin_list_organization_resources(
            request, organization_id=self.organization_id
        )
        self.assertEqual(getattr(resp, "status_code", None), 404)

    @patch("apps.tabtinspace.admin_api.Organization.objects")
    def test_list_organization_resources_page_size_invalid(self, org_objects):
        org_objects.filter.return_value.first.return_value = SimpleNamespace(
            id=self.organization_id
        )
        request = self._get(
            f"/api/auth/admin/organizations/{self.organization_id}/resources"
        )
        with self.assertRaises(HttpError) as ctx:
            admin_list_organization_resources(
                request,
                organization_id=self.organization_id,
                page_size=999,
            )
        self.assertEqual(ctx.exception.status_code, 400)

    @patch("apps.tabtinspace.admin_api.SpaceAppSettings.objects")
    def test_serialize_workspace_without_project_only_fields(self, space_app_settings):
        """#7880：Workspace 无 is_archived 等字段时序列化不得 AttributeError。"""
        space_app_settings.filter.return_value.exists.return_value = False
        now = timezone.now()
        workspace = SimpleNamespace(
            id=uuid4(),
            organization_id=self.organization_id,
            name="个人工作区",
            description="",
            working_dir="/tmp/ws",
            created_at=now,
            updated_at=now,
            memberships=SimpleNamespace(
                filter=lambda **_kwargs: SimpleNamespace(count=lambda: 0)
            ),
        )
        # 故意不挂 is_archived / is_default / last_activity_at / start_date / end_date
        payload = _serialize_space_item(
            workspace,
            organization_name_map={str(self.organization_id): "演示组织"},
            resource_counts={},
        )
        self.assertEqual(payload["name"], "个人工作区")
        self.assertFalse(payload["is_archived"])
        self.assertFalse(payload["is_default"])
        self.assertIsNone(payload["last_activity_at"])
        self.assertIsNone(payload["start_date"])
        self.assertIsNone(payload["end_date"])
        self.assertEqual(payload["status"], "active")
