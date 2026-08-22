from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import RequestFactory, SimpleTestCase

from apps.services.common.middleware import CORSMiddleware
from apps.tabdata.middleware import TabDataRequestContextMiddleware
from apps.tabdata.models import Table, TablePermission
from apps.tabdata.request_context import (
    clear_request_context,
    get_current_parent_document_id,
    is_embedded_access_verification_unavailable,
    mark_embedded_access_verification_unavailable,
    parent_document_access_context,
    set_current_parent_document_id,
)
from apps.tabdoc.services.embedded_access import (
    current_parent_document_allows_resource,
    document_references_resource,
    get_current_parent_document_resource_role,
)
from apps.tabdata.services.base import BaseService as TableBaseService
from apps.tabdoc.services.document_service import DocumentService


class EmbeddedResourceReferenceTests(SimpleTestCase):
    def tearDown(self):
        clear_request_context()

    def test_finds_nested_tabdata_block(self):
        table_id = str(uuid4())
        document = SimpleNamespace(
            id=uuid4(),
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "blockquote",
                        "content": [
                            {"type": "tabdataBlock", "attrs": {"tableId": table_id}}
                        ],
                    }
                ],
            },
        )

        self.assertTrue(document_references_resource(document, "table", table_id))
        self.assertFalse(document_references_resource(document, "table", str(uuid4())))

    def test_supports_future_document_block_without_self_reference(self):
        child_id = str(uuid4())
        document = SimpleNamespace(
            id=uuid4(),
            description_json={
                "type": "doc",
                "content": [
                    {"type": "tabdocBlock", "attrs": {"documentId": child_id}}
                ],
            },
        )

        self.assertTrue(document_references_resource(document, "document", child_id))
        self.assertFalse(
            document_references_resource(document, "document", str(document.id))
        )

    @patch(
        "apps.tabdoc.services.exchange_service.DocumentExchangeService._resolve_from_binary"
    )
    def test_binary_is_authoritative_when_json_snapshot_is_stale(self, resolve_binary):
        stale_table_id = str(uuid4())
        current_table_id = str(uuid4())
        document = SimpleNamespace(
            id=uuid4(),
            latest_version=7,
            description_binary=b"current-yjs-state",
            description_json={
                "type": "doc",
                "content": [
                    {"type": "tabdataBlock", "attrs": {"tableId": stale_table_id}}
                ],
            },
        )
        resolve_binary.return_value = (
            {
                "type": "doc",
                "content": [
                    {"type": "tabdataBlock", "attrs": {"tableId": current_table_id}}
                ],
            },
            "",
        )

        self.assertTrue(document_references_resource(document, "table", current_table_id))
        self.assertFalse(document_references_resource(document, "table", stale_table_id))

    @patch(
        "apps.tabdoc.services.exchange_service.DocumentExchangeService._resolve_from_binary",
        return_value=None,
    )
    def test_binary_conversion_failure_does_not_fall_back_to_stale_json(self, _resolve_binary):
        table_id = str(uuid4())
        document = SimpleNamespace(
            id=uuid4(),
            latest_version=8,
            description_binary=b"unreadable-yjs-state",
            description_json={
                "type": "doc",
                "content": [
                    {"type": "tabdataBlock", "attrs": {"tableId": table_id}}
                ],
            },
        )

        self.assertFalse(document_references_resource(document, "table", table_id))
        self.assertTrue(is_embedded_access_verification_unavailable())


class EmbeddedAccessValidationTests(SimpleTestCase):
    def tearDown(self):
        clear_request_context()

    def _parent_query(self, parent):
        query = MagicMock()
        query.select_related.return_value = query
        query.prefetch_related.return_value = query
        query.filter.return_value = query
        query.first.return_value = parent
        return query

    @patch("apps.tabdoc.services.document_service.DocumentService.check_document_permission")
    @patch("apps.tabdoc.models.Document.objects")
    def test_parent_viewer_can_read_referenced_table(self, document_objects, check_permission):
        organization_id = uuid4()
        parent_id = uuid4()
        table_id = uuid4()
        parent = SimpleNamespace(
            id=parent_id,
            organization_id=organization_id,
            trashed_at=None,
            status="active",
            description_json={
                "type": "doc",
                "content": [
                    {"type": "tabdataBlock", "attrs": {"tableId": str(table_id)}}
                ],
            },
        )
        document_objects.select_related.return_value = self._parent_query(parent)
        check_permission.side_effect = (
            lambda *_args, **kwargs: kwargs["required_role"] == "viewer"
        )
        set_current_parent_document_id(str(parent_id))

        inherited_role = get_current_parent_document_resource_role(
            user=SimpleNamespace(id=uuid4()),
            resource_type="table",
            resource=SimpleNamespace(id=table_id, organization_id=organization_id),
        )

        self.assertEqual(inherited_role, "viewer")
        self.assertEqual(check_permission.call_count, 2)
        self.assertTrue(
            all(
                not call.kwargs["allow_embedded_access"]
                for call in check_permission.call_args_list
            )
        )

    @patch("apps.tabdoc.services.document_service.DocumentService.check_document_permission")
    @patch("apps.tabdoc.models.Document.objects")
    def test_parent_editor_inherits_editor_to_referenced_table(
        self,
        document_objects,
        check_permission,
    ):
        organization_id = uuid4()
        parent_id = uuid4()
        table_id = uuid4()
        owner_id = uuid4()
        parent = SimpleNamespace(
            id=parent_id,
            owner_id=owner_id,
            organization_id=organization_id,
            trashed_at=None,
            status="active",
            description_json={
                "type": "doc",
                "content": [
                    {"type": "tabdataBlock", "attrs": {"tableId": str(table_id)}}
                ],
            },
        )
        document_objects.select_related.return_value = self._parent_query(parent)
        check_permission.side_effect = (
            lambda *_args, **kwargs: kwargs["required_role"] == "editor"
        )
        set_current_parent_document_id(str(parent_id))

        inherited_role = get_current_parent_document_resource_role(
            user=SimpleNamespace(id=uuid4()),
            resource_type="table",
            resource=SimpleNamespace(
                id=table_id,
                owner_id=owner_id,
                organization_id=organization_id,
            ),
        )

        self.assertEqual(inherited_role, "editor")
        check_permission.assert_called_once()
        self.assertFalse(check_permission.call_args.kwargs["allow_embedded_access"])

    @patch("apps.tabdoc.services.document_service.DocumentService.check_document_permission")
    @patch("apps.tabdoc.models.Document.objects")
    def test_parent_editor_cannot_elevate_foreign_owned_table(
        self,
        document_objects,
        check_permission,
    ):
        organization_id = uuid4()
        parent_id = uuid4()
        table_id = uuid4()
        parent = SimpleNamespace(
            id=parent_id,
            owner_id=uuid4(),
            organization_id=organization_id,
            trashed_at=None,
            status="active",
            description_json={
                "type": "doc",
                "content": [
                    {"type": "tabdataBlock", "attrs": {"tableId": str(table_id)}}
                ],
            },
        )
        document_objects.select_related.return_value = self._parent_query(parent)
        check_permission.return_value = True
        set_current_parent_document_id(str(parent_id))

        inherited_role = get_current_parent_document_resource_role(
            user=SimpleNamespace(id=uuid4()),
            resource_type="table",
            resource=SimpleNamespace(
                id=table_id,
                owner_id=uuid4(),
                organization_id=organization_id,
            ),
        )

        self.assertEqual(inherited_role, "viewer")

    @patch("apps.tabdoc.services.document_service.DocumentService.check_document_permission")
    @patch("apps.tabdoc.models.Document.objects")
    def test_rejects_cross_organization_resource(self, document_objects, check_permission):
        parent = SimpleNamespace(
            id=uuid4(),
            organization_id=uuid4(),
            trashed_at=None,
            status="active",
            description_json={},
        )
        document_objects.select_related.return_value = self._parent_query(parent)
        set_current_parent_document_id(str(parent.id))

        allowed = current_parent_document_allows_resource(
            user=SimpleNamespace(id=uuid4()),
            resource_type="table",
            resource=SimpleNamespace(id=uuid4(), organization_id=uuid4()),
        )

        self.assertFalse(allowed)
        check_permission.assert_not_called()

    @patch("apps.tabdoc.services.document_service.DocumentService.check_document_permission")
    @patch("apps.tabdoc.models.Document.objects")
    def test_child_document_inherits_parent_viewer_context(self, document_objects, check_permission):
        organization_id = uuid4()
        parent = SimpleNamespace(
            id=uuid4(),
            organization_id=organization_id,
            trashed_at=None,
            status="active",
            description_json={},
        )
        child = SimpleNamespace(
            id=uuid4(),
            parent_id=parent.id,
            organization_id=organization_id,
        )
        document_objects.select_related.return_value = self._parent_query(parent)
        check_permission.return_value = True
        set_current_parent_document_id(str(parent.id))

        self.assertTrue(
            current_parent_document_allows_resource(
                user=SimpleNamespace(id=uuid4()),
                resource_type="document",
                resource=child,
            )
        )


class ParentDocumentRequestContextTests(SimpleTestCase):
    def tearDown(self):
        clear_request_context()

    def test_middleware_sets_and_clears_parent_document_id(self):
        parent_id = str(uuid4())
        middleware = TabDataRequestContextMiddleware(lambda request: None)
        request = RequestFactory().get(
            "/api/tabdata/tables/example",
            HTTP_X_TABTIN_PARENT_DOCUMENT_ID=parent_id,
        )

        middleware.process_request(request)
        self.assertEqual(get_current_parent_document_id(), parent_id)

        response = MagicMock()
        self.assertIs(middleware.process_response(request, response), response)
        self.assertIsNone(get_current_parent_document_id())

    def test_scoped_parent_context_restores_outer_state(self):
        outer_parent_id = str(uuid4())
        inner_parent_id = str(uuid4())
        set_current_parent_document_id(outer_parent_id)

        with parent_document_access_context(inner_parent_id):
            self.assertEqual(get_current_parent_document_id(), inner_parent_id)
            mark_embedded_access_verification_unavailable()
            self.assertTrue(is_embedded_access_verification_unavailable())

        self.assertEqual(get_current_parent_document_id(), outer_parent_id)
        self.assertFalse(is_embedded_access_verification_unavailable())

    def test_middleware_marks_temporary_embed_verification_failure(self):
        middleware = TabDataRequestContextMiddleware(lambda request: None)
        request = RequestFactory().get(
            "/api/tabdata/tables/example",
            HTTP_X_TABTIN_PARENT_DOCUMENT_ID=str(uuid4()),
        )
        middleware.process_request(request)
        mark_embedded_access_verification_unavailable()

        response = MagicMock(status_code=403)
        self.assertIs(middleware.process_response(request, response), response)
        response.__setitem__.assert_called_once_with(
            "X-TabTin-Embedded-Access-Unavailable",
            "1",
        )
        self.assertFalse(is_embedded_access_verification_unavailable())

    def test_cors_exposes_temporary_embed_verification_header(self):
        middleware = CORSMiddleware(lambda request: None)
        self.assertIn(
            "X-TabTin-Embedded-Access-Unavailable",
            middleware.expose_headers,
        )


class EmbeddedAccessRoleBoundaryTests(SimpleTestCase):
    @patch(
        "apps.tabdoc.services.embedded_access.get_current_parent_document_resource_role",
        return_value="editor",
    )
    @patch.object(TablePermission.objects, "using")
    @patch.object(Table.objects, "using")
    def test_table_parent_editor_context_grants_editor(
        self,
        table_using,
        permission_using,
        inherited_role,
    ):
        user = SimpleNamespace(id=uuid4())
        table = SimpleNamespace(id=uuid4(), owner_id=uuid4(), organization_id=uuid4())
        table_using.return_value.get.return_value = table
        permission_query = permission_using.return_value.filter.return_value
        permission_query.values_list.return_value.first.return_value = None
        service = TableBaseService(user=user)

        self.assertTrue(service.check_table_permission(str(table.id), "viewer"))
        self.assertTrue(service.check_table_permission(str(table.id), "editor"))
        self.assertEqual(service.get_table_role(str(table.id)), "editor")
        self.assertEqual(inherited_role.call_count, 3)

    @patch(
        "apps.tabdoc.services.embedded_access.get_current_parent_document_resource_role",
        return_value="editor",
    )
    @patch.object(TablePermission.objects, "using")
    @patch.object(Table.objects, "using")
    def test_explicit_table_viewer_and_parent_editor_resolve_to_editor(
        self,
        table_using,
        permission_using,
        inherited_role,
    ):
        user = SimpleNamespace(id=uuid4())
        table = SimpleNamespace(id=uuid4(), owner_id=uuid4(), organization_id=uuid4())
        table_using.return_value.get.return_value = table
        permission_query = permission_using.return_value.filter.return_value
        permission_query.values_list.return_value.first.return_value = "viewer"

        service = TableBaseService(user=user)

        self.assertTrue(service.check_table_permission(str(table.id), "editor"))
        self.assertEqual(service.get_table_role(str(table.id)), "editor")
        self.assertEqual(inherited_role.call_count, 2)

    @patch(
        "apps.tabdoc.services.embedded_access.get_current_parent_document_resource_role",
        return_value="viewer",
    )
    @patch.object(TablePermission.objects, "using")
    @patch.object(Table.objects, "using")
    def test_explicit_table_editor_and_parent_viewer_resolve_to_editor(
        self,
        table_using,
        permission_using,
        inherited_role,
    ):
        user = SimpleNamespace(id=uuid4())
        table = SimpleNamespace(id=uuid4(), owner_id=uuid4(), organization_id=uuid4())
        table_using.return_value.get.return_value = table
        permission_query = permission_using.return_value.filter.return_value
        permission_query.values_list.return_value.first.return_value = "editor"
        service = TableBaseService(user=user)

        self.assertTrue(service.check_table_permission(str(table.id), "editor"))
        self.assertEqual(service.get_table_role(str(table.id)), "editor")
        inherited_role.assert_called_once()

    @patch(
        "apps.tabdoc.services.embedded_access.get_current_parent_document_resource_role",
        return_value="editor",
    )
    def test_document_parent_editor_context_grants_editor(self, inherited_role):
        user = SimpleNamespace(id=uuid4())
        permissions = MagicMock()
        active_permissions = permissions.filter.return_value
        active_permissions.filter.return_value.values_list.return_value = []
        document = SimpleNamespace(
            id=uuid4(),
            owner_id=uuid4(),
            organization_id=uuid4(),
            space_id=None,
            permissions=permissions,
        )
        service = DocumentService(user=user)

        with patch.object(service, "_resolve_organization_role", return_value=None), patch.object(
            service,
            "_resolve_space_role",
            return_value=None,
        ), patch.object(service, "_allow_project_task_document_preview", return_value=False):
            self.assertTrue(service.check_document_permission(document, "viewer"))
            self.assertTrue(service.check_document_permission(document, "editor"))
            self.assertEqual(service.compute_user_document_role(document), "editor")

        self.assertEqual(inherited_role.call_count, 3)
