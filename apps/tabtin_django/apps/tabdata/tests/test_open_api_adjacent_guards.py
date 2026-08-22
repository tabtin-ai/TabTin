import uuid
import json
from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models.deletion import ProtectedError
from django.db.models.signals import post_save
from django.test import RequestFactory, SimpleTestCase, TestCase
from django.utils import timezone

from apps.tabdata.api_connector import (
    CreateConnectorRequest,
    UpdateConnectorRequest,
    create_connector,
    update_connector,
)
from apps.tabdata.api_token import (
    cascade_deactivate_token,
    CreateTokenRequest,
    preview_detach_token,
    preview_repair_cross_user_links,
    preview_reparent_token,
    preview_token_impact,
    ReparentTokenRequest,
    repair_cross_user_links,
    UpdateTokenRequest,
    create_token,
    delete_token,
    detach_token,
    get_token as get_api_token,
    list_available_scopes,
    list_tokens,
    reparent_token,
    regenerate_token as regenerate_api_token,
    update_token as update_api_token,
)
from apps.tabdata.api_open import (
    RLSPolicyBody,
    WebhookCreateBody,
    WebhookUpdateBody,
    create_policy,
    create_webhook,
    list_policies,
    list_webhooks,
    update_webhook,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.models import Table
from apps.tabdata.models_connector import DataConnector
from apps.tabdata.models_rls import RowPolicy
from apps.tabdata.models_token import TableApiToken, TokenTargetValidationError
from apps.tabdata.models_webhook import TableWebhook
from apps.tabdata.services.connector_service import ConnectorService
from apps.tabdata.services.connectors.base import ExternalColumn, ExternalTable
from apps.tabdata.tests.test_permissions import _ensure_free_tier
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


def _ensure_local_project_membership(organization, space, user, role):
    agent, _ = Agent.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={
            "name": user.get_display_name(),
            "type": "human",
            "is_active": True,
        },
    )
    if not agent.is_active:
        agent.is_active = True
        agent.save(update_fields=["is_active", "updated_at"])

    SpaceMembership.objects.update_or_create(
        workspace=space,
        agent=agent,
        defaults={
            "role": role,
            "is_active": True,
        },
    )


class OpenApiAdjacentGuardTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()

        self.owner = User.objects.create_user(
            username="adj_owner",
            email="adj_owner@test.com",
            password="pass123",
        )
        self.editor = User.objects.create_user(
            username="adj_editor",
            email="adj_editor@test.com",
            password="pass123",
        )
        self.viewer = User.objects.create_user(
            username="adj_viewer",
            email="adj_viewer@test.com",
            password="pass123",
        )
        self.outsider = User.objects.create_user(
            username="adj_outsider",
            email="adj_outsider@test.com",
            password="pass123",
        )

        self.organization = Organization.objects.create(
            name="Adjacent Guard Organization",
            owner=self.owner,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="Adjacent Guard Space",
        )
        self.other_space = Space.objects.create(
            organization=self.organization,
            name="Other Space",
        )
        self.alt_space = Space.objects.create(
            organization=self.organization,
            name="Alternate Guard Space",
        )

        _ensure_local_project_membership(self.organization, self.space, self.owner, "owner")
        _ensure_local_project_membership(self.organization, self.space, self.editor, "editor")
        _ensure_local_project_membership(self.organization, self.space, self.viewer, "viewer")
        _ensure_local_project_membership(self.organization, self.alt_space, self.owner, "owner")

        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="Guard Table",
            owner=self.owner,
        )
        self.alt_table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.alt_space.id,
            name="Alt Guard Table",
            owner=self.owner,
        )

        self.foreign_owner = User.objects.create_user(
            username="adj_foreign_owner",
            email="adj_foreign_owner@test.com",
            password="pass123",
        )
        self.foreign_organization = Organization.objects.create(
            name="Foreign Guard Organization",
            owner=self.foreign_owner,
        )
        self.foreign_space = Space.objects.create(
            organization=self.foreign_organization,
            name="Foreign Guard Space",
        )
        _ensure_local_project_membership(self.foreign_organization, self.foreign_space, self.foreign_owner, "owner")
        self.foreign_table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.foreign_organization.id,
            space_id=self.foreign_space.id,
            name="Foreign Guard Table",
            owner=self.foreign_owner,
        )

        self.connector = DataConnector(
            organization_id=self.organization.id,
            space_id=self.space.id,
            connector_type="postgresql",
            name="Existing Connector",
            created_by=self.owner,
        )
        self.connector.set_config(
            {
                "host": "localhost",
                "port": 5432,
                "database": "db",
                "username": "user",
                "password": "pass",
            }
        )
        self.connector.save(using=TABDATA_DB_ALIAS)

        self.webhook = TableWebhook.objects.using(TABDATA_DB_ALIAS).create(
            space_id=self.space.id,
            table_id=self.table.id,
            url="https://example.com/webhook",
            events=["record.created"],
            secret="secret",
            created_by=self.owner,
        )

    def _create_api_token(
        self,
        *,
        user=None,
        name=None,
        scopes=None,
        space_ids=None,
        table_ids=None,
        rate_limit=60,
        expired_at=None,
        parent_token=None,
    ):
        return TableApiToken.create_token(
            user=user or self.owner,
            name=name or f"token-{uuid.uuid4().hex[:8]}",
            scopes=scopes or ["table:read"],
            space_ids=space_ids,
            table_ids=table_ids,
            rate_limit=rate_limit,
            expired_at=expired_at,
            parent_token=parent_token,
        )

    def test_create_connector_rejects_unimplemented_type(self):
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        body = CreateConnectorRequest(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            connector_type="mysql",
            name="Unsupported Connector",
            config={"host": "localhost"},
        )

        status, payload = create_connector(request, body)

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertIn("Unsupported connector type", payload["message"])
        self.assertFalse(
            DataConnector.objects.using(TABDATA_DB_ALIAS)
            .filter(name="Unsupported Connector")
            .exists()
        )

    def test_create_connector_requires_editor_space_permission_for_jwt(self):
        request = self.factory.post("/fake")
        request.auth = self.viewer
        request.api_token = None

        body = CreateConnectorRequest(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            connector_type="postgresql",
            name="Viewer Connector",
            config={"host": "localhost"},
        )

        status, payload = create_connector(request, body)

        self.assertEqual(status, 403)
        self.assertIn("editor role is required", payload["message"])
        self.assertFalse(
            DataConnector.objects.using(TABDATA_DB_ALIAS)
            .filter(name="Viewer Connector")
            .exists()
        )

    def test_create_connector_rejects_organization_space_mismatch(self):
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        body = CreateConnectorRequest(
            organization_id=str(uuid.uuid4()),
            space_id=str(self.space.id),
            connector_type="postgresql",
            name="Mismatched Connector",
            config={"host": "localhost"},
        )

        status, payload = create_connector(request, body)

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertIn("organization_id does not match", payload["message"])

    def test_create_webhook_requires_editor_space_permission_for_jwt(self):
        request = self.factory.post("/fake")
        request.auth = self.viewer
        request.api_token = None

        body = WebhookCreateBody(
            space_id=str(self.space.id),
            table_id=str(self.table.id),
            url="https://example.com/new-webhook",
            events=["record.created"],
        )

        response = create_webhook(request, body)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(json.loads(response.content)["code"], "PERMISSION_DENIED")

    def test_update_connector_requires_editor_space_permission_for_jwt(self):
        request = self.factory.patch("/fake")
        request.auth = self.viewer
        request.api_token = None

        body = UpdateConnectorRequest(name="Renamed By Viewer")
        status, payload = update_connector(request, self.connector.id, body)

        self.assertEqual(status, 403)
        self.assertIn("editor role is required", payload["message"])

        self.connector.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.connector.name, "Existing Connector")

    def test_create_token_rejects_inaccessible_space_ids(self):
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        body = CreateTokenRequest(
            name="foreign-space-token",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
        )

        status, payload = create_token(request, body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("Space", payload["message"])

    def test_create_token_rejects_inaccessible_table_ids(self):
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        body = CreateTokenRequest(
            name="foreign-table-token",
            scopes=["table:read"],
            table_ids=[str(self.foreign_table.id)],
        )

        status, payload = create_token(request, body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("表格", payload["message"])

    def test_create_token_rejects_table_ids_outside_space_scope(self):
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        body = CreateTokenRequest(
            name="mismatch-token",
            scopes=["table:read"],
            space_ids=[str(self.alt_space.id)],
            table_ids=[str(self.table.id)],
        )

        status, payload = create_token(request, body)

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertIn("space_ids", payload["message"])

    def test_list_available_scopes_returns_scope_group_and_preset_metadata(self):
        request = self.factory.get("/fake")
        request.auth = self.owner
        request.api_token = None

        response = list_available_scopes(request)

        self.assertTrue(response["success"])
        self.assertIn("scopes", response["data"])
        self.assertIn("groups", response["data"])
        self.assertIn("presets", response["data"])
        self.assertTrue(any(item["key"] == "sql:query" for item in response["data"]["scopes"]))
        self.assertTrue(any(item["key"] == "sql" for item in response["data"]["groups"]))
        self.assertEqual(
            response["data"]["presets"]["readonly"]["label_key"],
            "apiToken.scopePresets.readonly.label",
        )
        self.assertIn("storage:read", response["data"]["presets"]["readonly"]["scopes"])

    def test_create_token_normalizes_model_parent_not_found_to_standard_response(self):
        caller_token, _ = self._create_api_token(
            name="stale-caller",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        body = CreateTokenRequest(
            name="child-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        with patch.object(
            TableApiToken,
            "create_token",
            autospec=True,
            side_effect=TokenTargetValidationError(
                "父 Token 不存在，无法创建派生 Token",
                error_code=ErrorCode.NOT_FOUND,
                status_code=404,
            ),
        ):
            status, payload = create_token(request, body)

        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "目标父 Token 不存在")

    def test_update_token_rejects_space_change_that_breaks_existing_table_scope(self):
        token, _ = TableApiToken.create_token(
            user=self.owner,
            name="scoped-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = None

        body = UpdateTokenRequest(space_ids=[str(self.alt_space.id)])
        status, payload = update_api_token(request, token_id=token.id, body=body)

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")

        token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(token.space_ids, [str(self.space.id)])
        self.assertEqual(token.table_ids, [str(self.table.id)])

    def test_token_routes_return_standard_not_found_response_for_missing_target(self):
        missing_id = uuid.uuid4()

        def _call_get():
            request = self.factory.get("/fake")
            request.auth = self.owner
            request.api_token = None
            return get_api_token(request, token_id=missing_id)

        def _call_update():
            request = self.factory.patch("/fake")
            request.auth = self.owner
            request.api_token = None
            return update_api_token(
                request,
                token_id=missing_id,
                body=UpdateTokenRequest(name="missing"),
            )

        def _call_impact_preview():
            request = self.factory.post("/fake")
            request.auth = self.owner
            request.api_token = None
            return preview_token_impact(
                request,
                token_id=missing_id,
                body=UpdateTokenRequest(name="missing"),
            )

        def _call_detach_preview():
            request = self.factory.post("/fake")
            request.auth = self.owner
            request.api_token = None
            return preview_detach_token(request, token_id=missing_id)

        def _call_detach():
            request = self.factory.post("/fake")
            request.auth = self.owner
            request.api_token = None
            return detach_token(request, token_id=missing_id)

        def _call_cascade_deactivate():
            request = self.factory.post("/fake")
            request.auth = self.owner
            request.api_token = None
            return cascade_deactivate_token(request, token_id=missing_id)

        cases = [
            ("get", _call_get),
            ("update", _call_update),
            ("impact-preview", _call_impact_preview),
            ("detach-preview", _call_detach_preview),
            ("detach", _call_detach),
            ("cascade-deactivate", _call_cascade_deactivate),
        ]

        for name, make_call in cases:
            with self.subTest(route=name):
                status, payload = make_call()
                self.assertEqual(status, 404)
                self.assertEqual(payload["code"], "NOT_FOUND")
                self.assertEqual(payload["message"], "Token 不存在")

    def test_reparent_routes_return_standard_not_found_response_for_missing_target(self):
        missing_id = uuid.uuid4()
        parent_token, _ = self._create_api_token(
            name="existing-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None
        status, payload = preview_reparent_token(
            request,
            token_id=missing_id,
            body=ReparentTokenRequest(parent_token_id=parent_token.id),
        )
        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "Token 不存在")

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None
        status, payload = reparent_token(
            request,
            token_id=missing_id,
            body=ReparentTokenRequest(parent_token_id=parent_token.id),
        )
        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "Token 不存在")

    def test_reparent_routes_return_standard_not_found_response_for_missing_parent(self):
        token, _ = self._create_api_token(
            name="existing-target",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        missing_parent_id = uuid.uuid4()

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None
        status, payload = preview_reparent_token(
            request,
            token_id=token.id,
            body=ReparentTokenRequest(parent_token_id=missing_parent_id),
        )
        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "目标父 Token 不存在")

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None
        status, payload = reparent_token(
            request,
            token_id=token.id,
            body=ReparentTokenRequest(parent_token_id=missing_parent_id),
        )
        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "目标父 Token 不存在")

    def test_update_token_normalizes_model_not_found_to_standard_response(self):
        token, _ = self._create_api_token(
            name="update-target",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = None

        with patch.object(
            TableApiToken,
            "apply_update",
            autospec=True,
            side_effect=TokenTargetValidationError(
                "目标 Token 不存在，无法执行更新",
                error_code=ErrorCode.NOT_FOUND,
                status_code=404,
            ),
        ):
            status, payload = update_api_token(
                request,
                token_id=token.id,
                body=UpdateTokenRequest(name="renamed"),
            )

        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "Token 不存在")

    def test_preview_reparent_token_normalizes_model_parent_not_found_to_standard_response(self):
        token, _ = self._create_api_token(
            name="preview-target",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        new_parent, _ = self._create_api_token(
            name="preview-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        with patch.object(
            TableApiToken,
            "build_parent_transition_preview",
            autospec=True,
            side_effect=TokenTargetValidationError(
                "目标父 Token 不存在，无法预览父链修复",
                error_code=ErrorCode.NOT_FOUND,
                status_code=404,
            ),
        ):
            status, payload = preview_reparent_token(
                request,
                token_id=token.id,
                body=ReparentTokenRequest(parent_token_id=new_parent.id),
            )

        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "目标父 Token 不存在")

    def test_api_token_auth_create_token_records_parent_token(self):
        caller_token, _ = self._create_api_token(
            name="delegator",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        response = create_token(
            request,
            CreateTokenRequest(
                name="delegated-child",
                scopes=["table:read"],
                space_ids=[str(self.space.id)],
                table_ids=[str(self.table.id)],
                rate_limit=20,
            ),
        )

        self.assertTrue(response["success"])
        child_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(
            pk=response["data"]["token"]["id"]
        )
        self.assertEqual(child_token.parent_token_id, caller_token.id)
        self.assertEqual(response["data"]["token"]["parent_token_id"], str(caller_token.id))

    def test_api_token_auth_create_token_rebases_onto_locked_parent_state(self):
        caller_token, _ = self._create_api_token(
            name="stale-delegator",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        stale_caller_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=caller_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=caller_token.id).update(
            scopes=["token:manage", "table:read", "field:read"],
            updated_at=timezone.now(),
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = stale_caller_token

        response = create_token(
            request,
            CreateTokenRequest(
                name="rebased-child",
                scopes=["field:read"],
                space_ids=[str(self.space.id)],
                table_ids=[str(self.table.id)],
            ),
        )

        self.assertTrue(response["success"])
        child_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(
            pk=response["data"]["token"]["id"]
        )
        self.assertEqual(child_token.parent_token_id, caller_token.id)
        self.assertEqual(
            stale_caller_token.scopes,
            ["token:manage", "table:read", "field:read"],
        )

    def test_api_token_auth_create_token_rejects_when_manage_scope_removed_before_commit(self):
        caller_token, _ = self._create_api_token(
            name="revoked-manager",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        stale_caller_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=caller_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=caller_token.id).update(
            scopes=["table:read"],
            updated_at=timezone.now(),
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = stale_caller_token

        status, payload = create_token(
            request,
            CreateTokenRequest(
                name="revoked-manage-child",
                scopes=["table:read"],
                space_ids=[str(self.space.id)],
                table_ids=[str(self.table.id)],
            ),
        )

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("token:manage", payload["message"])
        self.assertFalse(
            TableApiToken.objects.using(TABDATA_DB_ALIAS)
            .filter(name="revoked-manage-child")
            .exists()
        )

    def test_detach_token_promotes_child_to_root(self):
        parent_token, _ = self._create_api_token(
            name="jwt-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="jwt-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=parent_token,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = detach_token(request, token_id=child_token.id)

        self.assertTrue(response["success"])
        child_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(child_token.parent_token_id)
        self.assertIsNone(response["data"]["parent_token_id"])

    def test_reparent_token_moves_child_to_new_parent(self):
        old_parent, _ = self._create_api_token(
            name="old-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        new_parent, _ = self._create_api_token(
            name="new-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="move-me",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=old_parent,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = reparent_token(
            request,
            token_id=child_token.id,
            body=ReparentTokenRequest(parent_token_id=new_parent.id),
        )

        self.assertTrue(response["success"])
        child_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(child_token.parent_token_id, new_parent.id)
        self.assertEqual(response["data"]["parent_token_id"], str(new_parent.id))

    def test_reparent_token_requires_jwt_owner_governance(self):
        parent_token, _ = self._create_api_token(
            name="delegator",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        new_parent, _ = self._create_api_token(
            name="new-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="jwt-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=parent_token,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = parent_token

        status, payload = reparent_token(
            request,
            token_id=child_token.id,
            body=ReparentTokenRequest(parent_token_id=new_parent.id),
        )

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("JWT", payload["message"])

        child_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(child_token.parent_token_id, parent_token.id)

    def test_api_token_auth_cannot_create_child_token_with_broader_scopes(self):
        caller_token, _ = self._create_api_token(
            name="limited-scope-caller",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        body = CreateTokenRequest(
            name="broader-scope-child",
            scopes=["token:manage", "table:read", "field:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        status, payload = create_token(request, body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("scope", payload["message"])

    def test_api_token_auth_cannot_create_child_token_outside_current_resource_scope(self):
        caller_token, _ = self._create_api_token(
            name="limited-resource-caller",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        body = CreateTokenRequest(
            name="broader-resource-child",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.alt_space.id)],
            table_ids=[str(self.alt_table.id)],
        )

        status, payload = create_token(request, body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("Space", payload["message"])

    def test_api_token_auth_cannot_create_child_token_with_higher_rate_limit(self):
        caller_token, _ = self._create_api_token(
            name="limited-rate-caller",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=30,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        body = CreateTokenRequest(
            name="higher-rate-child",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=60,
        )

        status, payload = create_token(request, body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("rate_limit", payload["message"])

    def test_api_token_auth_treats_zero_rate_limit_as_default_ceiling(self):
        caller_token, _ = self._create_api_token(
            name="zero-rate-caller",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=0,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        body = CreateTokenRequest(
            name="higher-than-default-child",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=61,
        )

        status, payload = create_token(request, body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("60", payload["message"])

    def test_api_token_auth_cannot_create_non_expiring_child_when_caller_expires(self):
        caller_token, _ = self._create_api_token(
            name="expiring-caller",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            expired_at=timezone.now() + timedelta(days=2),
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        body = CreateTokenRequest(
            name="non-expiring-child",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        status, payload = create_token(request, body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("过期时间", payload["message"])

    def test_api_token_auth_cannot_create_child_token_with_later_expiry(self):
        caller_token, _ = self._create_api_token(
            name="short-expiring-caller",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            expired_at=timezone.now() + timedelta(days=2),
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        body = CreateTokenRequest(
            name="later-expiring-child",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            expires_in_days=5,
        )

        status, payload = create_token(request, body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("过期时间", payload["message"])

    def test_api_token_auth_cannot_update_child_token_with_higher_rate_limit(self):
        caller_token, _ = self._create_api_token(
            name="limited-rate-manager",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=30,
        )
        child_token, _ = self._create_api_token(
            name="manageable-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=20,
            parent_token=caller_token,
        )

        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        body = UpdateTokenRequest(rate_limit=60)
        status, payload = update_api_token(request, token_id=child_token.id, body=body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("rate_limit", payload["message"])

        child_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(child_token.rate_limit, 20)

    def test_update_parent_token_rejects_rate_limit_shrink_when_child_would_exceed(self):
        parent_token, _ = self._create_api_token(
            name="jwt-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=60,
        )
        self._create_api_token(
            name="jwt-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=40,
            parent_token=parent_token,
        )

        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = update_api_token(
            request,
            token_id=parent_token.id,
            body=UpdateTokenRequest(rate_limit=30),
        )

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("派生 Token", payload["message"])

        parent_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(parent_token.rate_limit, 60)

    def test_update_parent_token_rejects_deactivation_while_active_child_exists(self):
        parent_token, _ = self._create_api_token(
            name="jwt-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        self._create_api_token(
            name="active-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=parent_token,
        )

        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = update_api_token(
            request,
            token_id=parent_token.id,
            body=UpdateTokenRequest(is_active=False),
        )

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertIn("激活中的派生 Token", payload["message"])

        parent_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertTrue(parent_token.is_active)

    def test_update_token_allows_explicit_null_to_clear_table_scope(self):
        token, _ = self._create_api_token(
            name="jwt-root",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = None

        response = update_api_token(
            request,
            token_id=token.id,
            body=UpdateTokenRequest(table_ids=None),
        )

        self.assertTrue(response["success"])

        token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(token.table_ids)

    def test_preview_token_impact_reports_descendant_violation(self):
        parent_token, _ = self._create_api_token(
            name="preview-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=60,
        )
        child_token, _ = self._create_api_token(
            name="preview-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=40,
            parent_token=parent_token,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_token_impact(
            request,
            token_id=parent_token.id,
            body=UpdateTokenRequest(rate_limit=30),
        )

        self.assertTrue(response["success"])
        self.assertFalse(response["data"]["can_apply"])
        self.assertEqual(response["data"]["descendant_count"], 1)
        self.assertEqual(response["data"]["violations"][0]["token_id"], str(child_token.id))
        self.assertIn("rate_limit", response["data"]["violations"][0]["message"])

    def test_preview_token_impact_includes_current_and_candidate_state_diff(self):
        token, _ = self._create_api_token(
            name="preview-source",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=20,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_token_impact(
            request,
            token_id=token.id,
            body=UpdateTokenRequest(
                name="preview-target",
                description="updated description",
                rate_limit=30,
            ),
        )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["current_state"]["name"], "preview-source")
        self.assertEqual(response["data"]["candidate_state"]["name"], "preview-target")
        self.assertEqual(response["data"]["candidate_state"]["description"], "updated description")
        self.assertEqual(response["data"]["current_state"]["rate_limit"], 20)
        self.assertEqual(response["data"]["candidate_state"]["rate_limit"], 30)

    def test_preview_token_impact_normalizes_zero_rate_limit_in_state_snapshot(self):
        token, _ = self._create_api_token(
            name="legacy-zero-rate",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=20,
        )
        token.rate_limit = 0
        token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["rate_limit", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_token_impact(
            request,
            token_id=token.id,
            body=UpdateTokenRequest(name="legacy-zero-rate-renamed"),
        )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["current_state"]["rate_limit"], 60)
        self.assertEqual(response["data"]["candidate_state"]["rate_limit"], 60)

    def test_model_build_transition_preview_rebases_partial_update_onto_locked_current_state(self):
        token, _ = TableApiToken.create_token(
            user=self.owner,
            name="stale-preview-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=20,
        )
        stale_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=token.id).update(
            description="fresh-preview-description",
            rate_limit=35,
            updated_at=timezone.now(),
        )

        preview = stale_token.build_transition_preview(
            action="update",
            name="renamed-under-lock",
        )

        self.assertEqual(preview["current_state"]["description"], "fresh-preview-description")
        self.assertEqual(preview["candidate_state"]["description"], "fresh-preview-description")
        self.assertEqual(preview["current_state"]["rate_limit"], 35)
        self.assertEqual(preview["candidate_state"]["rate_limit"], 35)
        self.assertEqual(preview["candidate_state"]["name"], "renamed-under-lock")
        self.assertEqual(stale_token.description, "fresh-preview-description")
        self.assertEqual(stale_token.rate_limit, 35)

    def test_model_apply_update_rebases_partial_update_onto_locked_current_state(self):
        token, _ = TableApiToken.create_token(
            user=self.owner,
            name="stale-apply-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=20,
        )
        stale_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=token.id).update(
            description="fresh-apply-description",
            rate_limit=35,
            updated_at=timezone.now(),
        )

        stale_token.apply_update(name="applied-under-lock")

        token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(token.name, "applied-under-lock")
        self.assertEqual(token.description, "fresh-apply-description")
        self.assertEqual(token.rate_limit, 35)
        self.assertEqual(stale_token.description, "fresh-apply-description")
        self.assertEqual(stale_token.rate_limit, 35)

    def test_model_apply_update_raises_not_found_when_target_deleted_before_lock(self):
        token, _ = TableApiToken.create_token(
            user=self.owner,
            name="deleted-before-lock",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        stale_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=token.id).delete()

        with self.assertRaises(TokenTargetValidationError) as ctx:
            stale_token.apply_update(name="should-fail")

        self.assertEqual(ctx.exception.api_error_code, ErrorCode.NOT_FOUND)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("无法执行更新", str(ctx.exception))

    def test_model_apply_update_rejects_when_actor_chain_becomes_invalid_before_commit(self):
        root_token, _ = self._create_api_token(
            name="root-manager",
            scopes=["token:manage", "table:read", "field:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        actor_token, _ = self._create_api_token(
            name="delegated-manager",
            scopes=["token:manage", "table:read", "field:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=root_token,
        )
        child_token, _ = self._create_api_token(
            name="managed-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=actor_token,
        )
        stale_actor_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=actor_token.id)
        stale_child_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=child_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=root_token.id).update(
            scopes=["token:manage", "table:read"],
            updated_at=timezone.now(),
        )

        with self.assertRaises(TokenTargetValidationError) as ctx:
            stale_child_token.apply_update(
                actor_token=stale_actor_token,
                name="blocked-under-invalid-actor",
            )

        self.assertIn("委托链已失效", str(ctx.exception))
        child_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(child_token.name, "managed-child")
        self.assertEqual(stale_actor_token.parent_token_id, root_token.id)

    def test_model_apply_update_rejects_when_actor_manage_scope_removed_before_commit(self):
        actor_token, _ = self._create_api_token(
            name="direct-manager",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="direct-managed-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=actor_token,
        )
        stale_actor_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=actor_token.id)
        stale_child_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=child_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=actor_token.id).update(
            scopes=["table:read"],
            updated_at=timezone.now(),
        )

        with self.assertRaises(TokenTargetValidationError) as ctx:
            stale_child_token.apply_update(
                actor_token=stale_actor_token,
                name="blocked-missing-manage-scope",
            )

        self.assertIn("token:manage", str(ctx.exception))
        child_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(child_token.name, "direct-managed-child")

    def test_preview_token_impact_hides_foreign_current_parent_token(self):
        token, _ = self._create_api_token(
            name="preview-foreign-parent-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_parent, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-parent",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        token.parent_token = foreign_parent
        token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_token_impact(
            request,
            token_id=token.id,
            body=UpdateTokenRequest(name="renamed-under-lock"),
        )

        self.assertTrue(response["success"])
        self.assertIsNone(response["data"]["current_parent_token"])
        self.assertEqual(response["data"]["current_parent_token_id"], str(foreign_parent.id))

    def test_preview_detach_token_reports_tree_stats(self):
        root_token, _ = self._create_api_token(
            name="preview-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="preview-child",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=root_token,
        )
        self._create_api_token(
            name="preview-grandchild",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=child_token,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_detach_token(request, token_id=child_token.id)

        self.assertTrue(response["success"])
        self.assertTrue(response["data"]["can_apply"])
        self.assertEqual(response["data"]["current_parent_token_id"], str(root_token.id))
        self.assertIsNone(response["data"]["next_parent_token_id"])
        self.assertEqual(response["data"]["direct_child_count"], 1)
        self.assertEqual(response["data"]["descendant_count"], 1)
        self.assertEqual(response["data"]["active_descendant_count"], 1)
        self.assertEqual(response["data"]["violations"], [])

    def test_preview_detach_does_not_persist_parent_transition(self):
        root_token, _ = self._create_api_token(
            name="preview-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="preview-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=root_token,
        )
        original_updated_at = child_token.updated_at

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_detach_token(request, token_id=child_token.id)

        self.assertTrue(response["success"])
        child_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(str(child_token.parent_token_id), str(root_token.id))
        self.assertEqual(child_token.updated_at, original_updated_at)

    def test_preview_detach_hides_foreign_current_parent_token(self):
        token, _ = self._create_api_token(
            name="detach-foreign-parent-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_parent, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-parent",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        token.parent_token = foreign_parent
        token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_detach_token(request, token_id=token.id)

        self.assertTrue(response["success"])
        self.assertIsNone(response["data"]["current_parent_token"])
        self.assertEqual(response["data"]["current_parent_token_id"], str(foreign_parent.id))

    def test_preview_reparent_token_reports_incompatible_parent(self):
        old_parent, _ = self._create_api_token(
            name="old-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=60,
        )
        moving_token, _ = self._create_api_token(
            name="moving-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=40,
            parent_token=old_parent,
        )
        new_parent, _ = self._create_api_token(
            name="new-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=20,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_reparent_token(
            request,
            token_id=moving_token.id,
            body=ReparentTokenRequest(parent_token_id=str(new_parent.id)),
        )

        self.assertTrue(response["success"])
        self.assertFalse(response["data"]["can_apply"])
        self.assertEqual(response["data"]["new_parent_token"]["id"], str(new_parent.id))
        self.assertEqual(response["data"]["violations"][0]["token_id"], str(moving_token.id))
        self.assertIn("rate_limit", response["data"]["violations"][0]["message"])

    def test_model_build_parent_transition_preview_uses_locked_new_parent_state(self):
        old_parent, _ = self._create_api_token(
            name="old-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=60,
        )
        moving_token, _ = self._create_api_token(
            name="moving-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=40,
            parent_token=old_parent,
        )
        new_parent, _ = self._create_api_token(
            name="new-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=60,
        )
        stale_moving_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=moving_token.id)
        stale_new_parent = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=new_parent.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=new_parent.id).update(
            rate_limit=20,
            updated_at=timezone.now(),
        )

        preview = stale_moving_token.build_parent_transition_preview(
            action="reparent",
            parent_token=stale_new_parent,
        )

        self.assertFalse(preview["can_apply"])
        self.assertEqual(preview["violations"][0]["token_id"], str(moving_token.id))
        self.assertIn("rate_limit", preview["violations"][0]["message"])
        self.assertEqual(stale_new_parent.rate_limit, 20)
        moving_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(moving_token.parent_token_id, old_parent.id)

    def test_model_build_parent_transition_preview_raises_not_found_when_parent_deleted_before_lock(self):
        moving_token, _ = self._create_api_token(
            name="moving-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        new_parent, _ = self._create_api_token(
            name="deleted-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        stale_moving_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=moving_token.id)
        stale_new_parent = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=new_parent.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=new_parent.id).delete()

        with self.assertRaises(TokenTargetValidationError) as ctx:
            stale_moving_token.build_parent_transition_preview(
                action="reparent",
                parent_token=stale_new_parent,
            )

        self.assertEqual(ctx.exception.api_error_code, ErrorCode.NOT_FOUND)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("目标父 Token 不存在", str(ctx.exception))

    def test_model_reparent_to_uses_locked_new_parent_state(self):
        old_parent, _ = self._create_api_token(
            name="old-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=60,
        )
        moving_token, _ = self._create_api_token(
            name="moving-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=40,
            parent_token=old_parent,
        )
        new_parent, _ = self._create_api_token(
            name="new-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=60,
        )
        stale_moving_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=moving_token.id)
        stale_new_parent = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=new_parent.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=new_parent.id).update(
            rate_limit=20,
            updated_at=timezone.now(),
        )

        with self.assertRaises(TokenTargetValidationError):
            stale_moving_token.reparent_to(stale_new_parent)

        moving_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(moving_token.parent_token_id, old_parent.id)
        self.assertEqual(stale_moving_token.parent_token_id, old_parent.id)
        self.assertEqual(stale_new_parent.rate_limit, 20)

    def test_cascade_deactivate_token_disables_entire_subtree(self):
        root_token, _ = self._create_api_token(
            name="cascade-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="cascade-child",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=root_token,
        )
        grandchild_token, _ = self._create_api_token(
            name="cascade-grandchild",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=child_token,
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = cascade_deactivate_token(request, token_id=root_token.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["changed_count"], 3)
        self.assertEqual(response["data"]["affected_token_count"], 3)
        self.assertTrue(response["data"]["target_before_state"]["is_active"])
        self.assertFalse(response["data"]["target_after_state"]["is_active"])
        self.assertTrue(all(item["before_state"]["is_active"] for item in response["data"]["changed_tokens"]))
        self.assertTrue(all(not item["after_state"]["is_active"] for item in response["data"]["changed_tokens"]))

        root_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        child_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        grandchild_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertFalse(root_token.is_active)
        self.assertFalse(child_token.is_active)
        self.assertFalse(grandchild_token.is_active)

    def test_cascade_deactivate_normalizes_zero_rate_limit_in_transition_snapshot(self):
        root_token, _ = self._create_api_token(
            name="legacy-zero-rate-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=20,
        )
        root_token.rate_limit = 0
        root_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["rate_limit", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = cascade_deactivate_token(request, token_id=root_token.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["target_before_state"]["rate_limit"], 60)
        self.assertEqual(response["data"]["target_after_state"]["rate_limit"], 60)

    def test_model_cascade_deactivate_uses_locked_current_state_for_changed_diff(self):
        root_token, _ = self._create_api_token(
            name="cascade-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="cascade-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=root_token,
        )
        stale_root_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=root_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=root_token.id).update(
            is_active=False,
            updated_at=timezone.now(),
        )

        affected_tokens, changed_tokens, changed_count = stale_root_token.cascade_deactivate()

        self.assertEqual(changed_count, 1)
        self.assertEqual({str(item.pk) for item in changed_tokens}, {str(child_token.id)})
        self.assertEqual(
            {str(item.pk) for item in affected_tokens},
            {str(root_token.id), str(child_token.id)},
        )
        self.assertFalse(stale_root_token.is_active)
        root_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        child_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertFalse(root_token.is_active)
        self.assertFalse(child_token.is_active)

    def test_cascade_deactivate_requires_jwt_owner_governance(self):
        root_token, _ = self._create_api_token(
            name="jwt-only-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        manager_token, _ = self._create_api_token(
            name="api-manager",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = manager_token

        status, payload = cascade_deactivate_token(request, token_id=root_token.id)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("JWT", payload["message"])

    def test_preview_detach_ignores_foreign_dirty_descendant(self):
        root_token, _ = self._create_api_token(
            name="owner-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_child, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-child",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        foreign_child.parent_token = root_token
        foreign_child.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_detach_token(request, token_id=root_token.id)

        self.assertTrue(response["success"])
        self.assertTrue(response["data"]["can_apply"])
        self.assertEqual(response["data"]["direct_child_count"], 0)
        self.assertEqual(response["data"]["descendant_count"], 0)
        self.assertEqual(response["data"]["ignored_foreign_descendant_count"], 1)
        self.assertEqual(response["data"]["warnings"][0]["reason_code"], "foreign_descendants_excluded")

    def test_cascade_deactivate_does_not_touch_foreign_dirty_descendant(self):
        root_token, _ = self._create_api_token(
            name="owner-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        local_child, _ = self._create_api_token(
            name="local-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=root_token,
        )
        foreign_child, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-child",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        foreign_child.parent_token = root_token
        foreign_child.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = cascade_deactivate_token(request, token_id=root_token.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["changed_count"], 2)
        self.assertEqual(response["data"]["affected_token_count"], 2)
        self.assertEqual(response["data"]["ignored_foreign_descendant_count"], 1)
        self.assertEqual(response["data"]["warnings"][0]["reason_code"], "foreign_descendants_excluded")

        root_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        local_child.refresh_from_db(using=TABDATA_DB_ALIAS)
        foreign_child.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertFalse(root_token.is_active)
        self.assertFalse(local_child.is_active)
        self.assertTrue(foreign_child.is_active)

    def test_delete_token_rejects_foreign_dirty_child_with_explicit_message(self):
        root_token, _ = self._create_api_token(
            name="delete-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_child, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-child",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        foreign_child.parent_token = root_token
        foreign_child.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.delete("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = delete_token(request, token_id=root_token.id)

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertIn("跨用户", payload["message"])
        self.assertTrue(
            TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=root_token.id).exists()
        )

    def test_delete_token_rejects_mixed_same_and_foreign_children_with_explicit_message(self):
        root_token, _ = self._create_api_token(
            name="delete-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        self._create_api_token(
            name="local-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=root_token,
        )
        foreign_child, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-child",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        foreign_child.parent_token = root_token
        foreign_child.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.delete("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = delete_token(request, token_id=root_token.id)

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertIn("跨用户", payload["message"])
        self.assertIn("处理子 Token", payload["message"])

    def test_preview_repair_cross_user_links_returns_standard_not_found_response(self):
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = preview_repair_cross_user_links(request, token_id=uuid.uuid4())

        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "Token 不存在")

    def test_repair_cross_user_links_returns_standard_not_found_response(self):
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = repair_cross_user_links(request, token_id=uuid.uuid4())

        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "Token 不存在")

    def test_preview_repair_cross_user_links_maps_token_validation_error(self):
        token, _ = self._create_api_token(
            name="preview-repair-target",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        with patch.object(
            TableApiToken,
            "preview_cross_user_link_repair",
            autospec=True,
            side_effect=TokenTargetValidationError(
                "repair preview stale",
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            ),
        ):
            status, payload = preview_repair_cross_user_links(request, token_id=token.id)

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertEqual(payload["message"], "repair preview stale")

    def test_preview_repair_cross_user_links_reports_targets(self):
        root_token, _ = self._create_api_token(
            name="repair-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-token",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        same_user_hidden_token, _ = self._create_api_token(
            name="same-user-hidden-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token.parent_token = root_token
        foreign_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )
        same_user_hidden_token.parent_token = foreign_token
        same_user_hidden_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_repair_cross_user_links(request, token_id=root_token.id)

        self.assertTrue(response["success"])
        self.assertTrue(response["data"]["can_apply"])
        self.assertEqual(response["data"]["repair_type"], "cross_user_links")
        self.assertFalse(response["data"]["current_token_in_repair_scope"])
        self.assertEqual(response["data"]["repair_target_count"], 2)
        self.assertEqual(response["data"]["same_user_repair_target_count"], 1)
        self.assertEqual(response["data"]["foreign_user_repair_target_count"], 1)
        self.assertEqual(len(response["data"]["same_user_repair_targets"]), 1)
        self.assertEqual(response["data"]["same_user_repair_targets"][0]["id"], str(same_user_hidden_token.id))
        self.assertIsNone(response["data"]["same_user_repair_targets"][0]["parent_token_id"])
        self.assertEqual(response["data"]["same_user_targets_with_issues_count"], 0)
        self.assertFalse(response["data"]["has_residual_issues_after_repair"])
        self.assertEqual(response["data"]["same_user_residual_issue_count"], 0)
        self.assertEqual(response["data"]["residual_issue_count"], 0)
        self.assertIsNone(response["data"]["same_user_repair_target_health"][0]["token"]["parent_token_id"])
        self.assertTrue(response["data"]["same_user_repair_target_health"][0]["is_healthy_after_repair"])

    def test_repair_cross_user_links_detaches_mixed_user_edges(self):
        root_token, _ = self._create_api_token(
            name="repair-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-token",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        same_user_hidden_token, _ = self._create_api_token(
            name="same-user-hidden-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token.parent_token = root_token
        foreign_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )
        same_user_hidden_token.parent_token = foreign_token
        same_user_hidden_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = repair_cross_user_links(request, token_id=root_token.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["changed_count"], 2)
        self.assertEqual(response["data"]["repair_target_count"], 2)

        foreign_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        same_user_hidden_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(foreign_token.parent_token_id)
        self.assertIsNone(same_user_hidden_token.parent_token_id)

        preview_response = preview_detach_token(request, token_id=root_token.id)
        self.assertEqual(preview_response["data"]["ignored_foreign_descendant_count"], 0)

    def test_repair_cross_user_links_can_detach_current_token_from_foreign_parent(self):
        token, _ = self._create_api_token(
            name="repair-self-token",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_parent, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-parent",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        token.parent_token = foreign_parent
        token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = repair_cross_user_links(request, token_id=token.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["changed_count"], 1)
        self.assertTrue(response["data"]["current_token_in_repair_scope"])
        self.assertEqual(response["data"]["same_user_repair_targets"][0]["id"], str(token.id))
        self.assertIsNone(response["data"]["same_user_repair_targets"][0]["parent_token_id"])
        self.assertTrue(response["data"]["same_user_repair_target_health"][0]["is_healthy_after_repair"])
        self.assertFalse(response["data"]["has_residual_issues_after_repair"])
        self.assertIsNone(response["data"]["target_token"]["parent_token_id"])
        self.assertEqual(response["data"]["target_before_state"]["parent_token_id"], str(foreign_parent.id))
        self.assertIsNone(response["data"]["target_after_state"]["parent_token_id"])
        token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(token.parent_token_id)

    def test_preview_repair_cross_user_links_returns_target_transition_when_current_token_in_scope(self):
        token, _ = self._create_api_token(
            name="repair-self-token",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_parent, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-parent",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        token.parent_token = foreign_parent
        token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_repair_cross_user_links(request, token_id=token.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["target_token"]["parent_token_id"], str(foreign_parent.id))
        self.assertEqual(response["data"]["target_current_state"]["parent_token_id"], str(foreign_parent.id))
        self.assertIsNone(response["data"]["target_candidate_state"]["parent_token_id"])
        token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(str(token.parent_token_id), str(foreign_parent.id))

    def test_preview_repair_cross_user_links_repairs_foreign_ancestor_chain_for_current_token(self):
        foreign_root, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-root",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        same_user_parent, _ = self._create_api_token(
            name="same-user-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        token, _ = self._create_api_token(
            name="repair-descendant-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=same_user_parent,
        )
        same_user_parent.parent_token = foreign_root
        same_user_parent.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_repair_cross_user_links(request, token_id=token.id)

        self.assertTrue(response["success"])
        self.assertTrue(response["data"]["current_token_in_repair_scope"])
        self.assertEqual(response["data"]["repair_target_count"], 1)
        self.assertEqual(response["data"]["same_user_repair_targets"][0]["id"], str(token.id))
        self.assertEqual(response["data"]["target_current_state"]["parent_token_id"], str(same_user_parent.id))
        self.assertIsNone(response["data"]["target_candidate_state"]["parent_token_id"])
        token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(str(token.parent_token_id), str(same_user_parent.id))

    def test_repair_cross_user_links_repairs_foreign_ancestor_chain_for_current_token(self):
        foreign_root, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-root",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        same_user_parent, _ = self._create_api_token(
            name="same-user-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        token, _ = self._create_api_token(
            name="repair-descendant-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=same_user_parent,
        )
        same_user_parent.parent_token = foreign_root
        same_user_parent.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = repair_cross_user_links(request, token_id=token.id)

        self.assertTrue(response["success"])
        self.assertTrue(response["data"]["current_token_in_repair_scope"])
        self.assertEqual(response["data"]["repair_target_count"], 1)
        self.assertIsNone(response["data"]["target_token"]["parent_token_id"])
        self.assertEqual(response["data"]["target_before_state"]["parent_token_id"], str(same_user_parent.id))
        self.assertIsNone(response["data"]["target_after_state"]["parent_token_id"])
        token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(token.parent_token_id)

    def test_repair_cross_user_links_requires_jwt_owner_governance(self):
        root_token, _ = self._create_api_token(
            name="repair-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        manager_token, _ = self._create_api_token(
            name="api-manager",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = manager_token

        status, payload = repair_cross_user_links(request, token_id=root_token.id)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("JWT", payload["message"])

    def test_preview_repair_cross_user_links_reports_residual_same_user_subtree_issues(self):
        root_token, _ = self._create_api_token(
            name="repair-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-token",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        same_user_hidden_token, _ = self._create_api_token(
            name="same-user-hidden-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        active_child, _ = self._create_api_token(
            name="active-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=same_user_hidden_token,
        )
        foreign_token.parent_token = root_token
        foreign_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )
        same_user_hidden_token.parent_token = foreign_token
        same_user_hidden_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )
        same_user_hidden_token.is_active = False
        same_user_hidden_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["is_active", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_repair_cross_user_links(request, token_id=root_token.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["same_user_targets_with_issues_count"], 1)
        self.assertTrue(response["data"]["has_residual_issues_after_repair"])
        self.assertEqual(response["data"]["same_user_residual_issue_count"], response["data"]["residual_issue_count"])
        self.assertGreaterEqual(response["data"]["residual_issue_count"], 1)
        health_item = response["data"]["same_user_repair_target_health"][0]
        self.assertEqual(health_item["token"]["id"], str(same_user_hidden_token.id))
        self.assertIsNone(health_item["token"]["parent_token_id"])
        self.assertFalse(health_item["is_healthy_after_repair"])
        self.assertIn("激活中的派生 Token", health_item["issues"][0]["message"])
        warning_codes = {item["reason_code"] for item in response["data"]["warnings"]}
        self.assertIn("same_user_targets_still_dirty_after_repair", warning_codes)
        same_user_hidden_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(str(same_user_hidden_token.parent_token_id), str(foreign_token.id))
        active_child.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(str(active_child.parent_token_id), str(same_user_hidden_token.id))

    def test_repair_cross_user_links_returns_residual_same_user_subtree_issues(self):
        root_token, _ = self._create_api_token(
            name="repair-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-token",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        same_user_hidden_token, _ = self._create_api_token(
            name="same-user-hidden-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        self._create_api_token(
            name="active-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=same_user_hidden_token,
        )
        foreign_token.parent_token = root_token
        foreign_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )
        same_user_hidden_token.parent_token = foreign_token
        same_user_hidden_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )
        same_user_hidden_token.is_active = False
        same_user_hidden_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["is_active", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = repair_cross_user_links(request, token_id=root_token.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["same_user_targets_with_issues_count"], 1)
        self.assertTrue(response["data"]["has_residual_issues_after_repair"])
        self.assertEqual(response["data"]["same_user_residual_issue_count"], response["data"]["residual_issue_count"])
        self.assertGreaterEqual(response["data"]["residual_issue_count"], 1)
        self.assertIsNone(response["data"]["same_user_repair_targets"][0]["parent_token_id"])
        self.assertFalse(response["data"]["same_user_repair_target_health"][0]["is_healthy_after_repair"])
        warning_codes = {item["reason_code"] for item in response["data"]["warnings"]}
        self.assertIn("same_user_targets_still_dirty_after_repair", warning_codes)
        same_user_hidden_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(same_user_hidden_token.parent_token_id)

    def test_preview_repair_cross_user_links_marks_cycle_warning_as_residual_issue(self):
        token_a, _ = self._create_api_token(
            name="cycle-a",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        token_b, _ = self._create_api_token(
            name="cycle-b",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=token_a,
        )
        token_a.parent_token = token_b
        token_a.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_repair_cross_user_links(request, token_id=token_a.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["repair_target_count"], 0)
        self.assertEqual(response["data"]["same_user_targets_with_issues_count"], 0)
        self.assertEqual(response["data"]["residual_issue_count"], 0)
        self.assertTrue(response["data"]["has_residual_issues_after_repair"])
        warning_codes = {item["reason_code"] for item in response["data"]["warnings"]}
        self.assertIn("cycle_requires_detach_repair", warning_codes)

    def test_stabilize_cross_user_link_repair_plan_skips_targets_that_left_current_scope(self):
        root_token, _ = self._create_api_token(
            name="repair-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-token",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        same_user_hidden_token, _ = self._create_api_token(
            name="same-user-hidden-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token.parent_token = root_token
        foreign_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )
        same_user_hidden_token.parent_token = foreign_token
        same_user_hidden_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        stale_plan = root_token.build_cross_user_link_repair_plan()

        foreign_token.parent_token = None
        foreign_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        stable_plan = root_token.stabilize_cross_user_link_repair_plan(stale_plan)

        self.assertEqual(stable_plan["repair_target_count"], 0)
        warning_codes = {item["reason_code"] for item in stable_plan["warnings"]}
        self.assertIn("repair_targets_left_current_scope", warning_codes)

    def test_stabilize_cross_user_link_repair_plan_includes_targets_that_enter_current_scope(self):
        root_token, _ = self._create_api_token(
            name="repair-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-token",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        same_user_hidden_token, _ = self._create_api_token(
            name="same-user-hidden-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token.parent_token = root_token
        foreign_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        stale_plan = root_token.build_cross_user_link_repair_plan()

        same_user_hidden_token.parent_token = foreign_token
        same_user_hidden_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        stable_plan = root_token.stabilize_cross_user_link_repair_plan(stale_plan)

        self.assertEqual(stable_plan["repair_target_count"], 2)
        stable_ids = {str(item.id) for item in stable_plan["repair_target_tokens"]}
        self.assertIn(str(foreign_token.id), stable_ids)
        self.assertIn(str(same_user_hidden_token.id), stable_ids)
        warning_codes = {item["reason_code"] for item in stable_plan["warnings"]}
        self.assertIn("repair_targets_entered_current_scope", warning_codes)

    def test_stabilize_cross_user_link_repair_plan_uses_locked_graph_scan_when_requested(self):
        token, _ = self._create_api_token(
            name="repair-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        stale_plan = {
            "repair_target_tokens": [],
            "repair_target_count": 0,
            "same_user_repair_target_count": 0,
            "foreign_user_repair_target_count": 0,
            "warnings": [],
        }
        current_plan = {
            "repair_target_tokens": [],
            "repair_target_count": 0,
            "same_user_repair_target_count": 0,
            "foreign_user_repair_target_count": 0,
            "warnings": [],
        }

        with patch.object(
            TableApiToken,
            "build_cross_user_link_repair_plan",
            autospec=True,
            return_value=current_plan,
        ) as mocked_build_plan:
            token.stabilize_cross_user_link_repair_plan(stale_plan, lock_targets=True)

        mocked_build_plan.assert_called_once_with(token, lock_graph=True)

    def test_build_cross_user_link_repair_plan_uses_sorted_lock_context_when_requested(self):
        token, _ = self._create_api_token(
            name="repair-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        with patch.object(
            TableApiToken,
            "_lock_cross_user_repair_graph",
            autospec=True,
            return_value={
                "token": token,
                "ancestor_tokens": [],
                "linked_descendants": [],
            },
        ) as mocked_lock_context:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                token.build_cross_user_link_repair_plan(lock_graph=True)

        mocked_lock_context.assert_called_once_with(
            token,
            target_missing_message='目标 Token 不存在，无法继续跨用户 repair',
            target_missing_error_code=ErrorCode.NOT_FOUND,
            target_missing_status_code=404,
        )

    def test_lock_governance_context_retries_from_scratch_when_graph_expands_after_lock(self):
        root_token, _ = self._create_api_token(
            name="retry-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        late_child, _ = self._create_api_token(
            name="late-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=root_token,
        )
        stale_root_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=root_token.id)
        subtree_results = iter(([], [late_child], [late_child]))
        lock_calls = []
        real_lock = TableApiToken._lock_token_for_governance

        def _collect_subtree_side_effect(token, *, lock_rows):
            if str(token.pk) == str(root_token.id) and not lock_rows:
                return list(next(subtree_results))
            return []

        def _lock_token_side_effect(token_id, **kwargs):
            if kwargs.get("lock_row"):
                lock_calls.append(str(token_id))
            return real_lock(token_id, **kwargs)

        with patch.object(
            TableApiToken,
            "_collect_ancestor_tokens",
            autospec=True,
            return_value=[],
        ), patch.object(
            TableApiToken,
            "_collect_same_user_subtree_tokens",
            autospec=True,
            side_effect=_collect_subtree_side_effect,
        ), patch.object(
            TableApiToken,
            "_lock_token_for_governance",
            autospec=True,
            side_effect=_lock_token_side_effect,
        ):
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                stale_root_token._lock_governance_context(
                    target_missing_message="目标 Token 不存在，无法测试治理重试",
                )

        self.assertEqual(lock_calls.count(str(root_token.id)), 2)
        self.assertEqual(lock_calls.count(str(late_child.id)), 1)

    def test_lock_cross_user_repair_graph_retries_from_scratch_when_graph_expands_after_lock(self):
        root_token, _ = self._create_api_token(
            name="repair-retry-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        late_child, _ = self._create_api_token(
            name="repair-late-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=root_token,
        )
        stale_root_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=root_token.id)
        linked_results = iter(([], [late_child], [late_child]))
        lock_calls = []
        real_lock = TableApiToken._lock_token_for_governance

        def _collect_linked_side_effect(token, *, lock_rows):
            if str(token.pk) == str(root_token.id) and not lock_rows:
                return list(next(linked_results))
            return []

        def _lock_token_side_effect(token_id, **kwargs):
            if kwargs.get("lock_row"):
                lock_calls.append(str(token_id))
            return real_lock(token_id, **kwargs)

        with patch.object(
            TableApiToken,
            "_collect_ancestor_tokens",
            autospec=True,
            return_value=[],
        ), patch.object(
            TableApiToken,
            "_collect_linked_subtree_tokens",
            autospec=True,
            side_effect=_collect_linked_side_effect,
        ), patch.object(
            TableApiToken,
            "_lock_token_for_governance",
            autospec=True,
            side_effect=_lock_token_side_effect,
        ):
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                stale_root_token._lock_cross_user_repair_graph(
                    target_missing_message="目标 Token 不存在，无法测试 repair 重试",
                )

        self.assertEqual(lock_calls.count(str(root_token.id)), 2)
        self.assertEqual(lock_calls.count(str(late_child.id)), 1)

    def test_model_build_cross_user_link_repair_plan_raises_not_found_when_root_deleted(self):
        token, _ = self._create_api_token(
            name="repair-stale-root",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        stale_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=token.id).delete()

        with self.assertRaises(TokenTargetValidationError) as ctx:
            stale_token.build_cross_user_link_repair_plan()

        self.assertEqual(ctx.exception.api_error_code, ErrorCode.NOT_FOUND)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("跨用户 repair", str(ctx.exception))

    def test_preview_repair_cross_user_links_does_not_report_residual_issue_after_cross_user_cycle_is_broken(self):
        token, _ = self._create_api_token(
            name="cycle-owner",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_token, _ = self._create_api_token(
            user=self.foreign_owner,
            name="cycle-foreign",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        token.parent_token = foreign_token
        token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )
        foreign_token.parent_token = token
        foreign_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_repair_cross_user_links(request, token_id=token.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["repair_target_count"], 2)
        self.assertFalse(response["data"]["has_residual_issues_after_repair"])
        warning_codes = {item["reason_code"] for item in response["data"]["warnings"]}
        self.assertNotIn("cycle_requires_detach_repair", warning_codes)

    def test_preview_detach_reports_dirty_cycle_without_hanging(self):
        token_a, _ = self._create_api_token(
            name="cycle-a",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        token_b, _ = self._create_api_token(
            name="cycle-b",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=token_a,
        )
        token_a.parent_token = token_b
        token_a.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = preview_detach_token(request, token_id=token_a.id)

        self.assertTrue(response["success"])
        self.assertTrue(response["data"]["can_apply"])
        self.assertIsNone(response["data"]["next_parent_token_id"])
        self.assertEqual(response["data"]["direct_child_count"], 1)
        self.assertEqual(response["data"]["descendant_count"], 1)
        self.assertEqual(response["data"]["violations"], [])

    def test_update_token_rejects_dirty_descendant_cycle(self):
        token_a, _ = self._create_api_token(
            name="cycle-a",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        token_b, _ = self._create_api_token(
            name="cycle-b",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=token_a,
        )
        token_a.parent_token = token_b
        token_a.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = update_api_token(
            request,
            token_id=token_a.id,
            body=UpdateTokenRequest(name="cycle-a-renamed"),
        )

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertIn("循环", payload["message"])

    def test_detach_token_breaks_dirty_cycle(self):
        token_a, _ = self._create_api_token(
            name="cycle-a",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        token_b, _ = self._create_api_token(
            name="cycle-b",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=token_a,
        )
        token_a.parent_token = token_b
        token_a.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        response = detach_token(request, token_id=token_a.id)

        self.assertTrue(response["success"])
        token_a.refresh_from_db(using=TABDATA_DB_ALIAS)
        token_b.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertIsNone(token_a.parent_token_id)
        self.assertEqual(str(token_b.parent_token_id), str(token_a.id))

    def test_api_token_auth_list_tokens_only_returns_self_and_descendants(self):
        caller_token, _ = self._create_api_token(
            name="delegated-lister",
            scopes=["token:read", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="listed-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=caller_token,
        )
        sibling_root_token, _ = self._create_api_token(
            name="sibling-root",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.get("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        response = list_tokens(request)

        self.assertTrue(response["success"])
        listed_ids = {item["id"] for item in response["data"]}
        self.assertIn(str(caller_token.id), listed_ids)
        self.assertIn(str(child_token.id), listed_ids)
        self.assertNotIn(str(sibling_root_token.id), listed_ids)

    def test_api_token_auth_list_tokens_filters_out_dirty_descendant_with_later_expiry(self):
        caller_token, _ = self._create_api_token(
            name="short-expiry-lister",
            scopes=["token:read", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            expired_at=timezone.now() + timedelta(days=2),
        )
        visible_token, _ = self._create_api_token(
            name="visible-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            expired_at=timezone.now() + timedelta(days=1),
            parent_token=caller_token,
        )
        hidden_token, _ = self._create_api_token(
            name="hidden-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            expired_at=timezone.now() + timedelta(days=1),
            parent_token=caller_token,
        )
        hidden_token.expired_at = timezone.now() + timedelta(days=5)
        hidden_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["expired_at", "updated_at"],
        )

        request = self.factory.get("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        response = list_tokens(request)

        self.assertTrue(response["success"])
        listed_ids = {item["id"] for item in response["data"]}
        self.assertIn(str(visible_token.id), listed_ids)
        self.assertNotIn(str(hidden_token.id), listed_ids)

    def test_list_tokens_can_filter_by_space_id(self):
        visible_token, _ = self._create_api_token(
            name="space-visible-token",
            scopes=["token:read", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        hidden_token, _ = self._create_api_token(
            name="space-hidden-token",
            scopes=["token:read", "table:read"],
            space_ids=[str(self.alt_space.id)],
            table_ids=[str(self.alt_table.id)],
        )

        request = self.factory.get("/fake", {"space_id": str(self.space.id)})
        request.auth = self.owner
        request.api_token = None

        response = list_tokens(request)

        self.assertTrue(response["success"])
        listed_ids = {item["id"] for item in response["data"]}
        self.assertIn(str(visible_token.id), listed_ids)
        self.assertNotIn(str(hidden_token.id), listed_ids)

    def test_api_token_auth_cannot_get_existing_token_with_later_expiry(self):
        caller_token, _ = self._create_api_token(
            name="short-expiry-reader",
            scopes=["token:read", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            expired_at=timezone.now() + timedelta(days=2),
        )
        target_token, _ = self._create_api_token(
            name="later-expiry-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            expired_at=timezone.now() + timedelta(days=1),
            parent_token=caller_token,
        )
        target_token.expired_at = timezone.now() + timedelta(days=5)
        target_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["expired_at", "updated_at"],
        )

        request = self.factory.get("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        status, payload = get_api_token(request, token_id=target_token.id)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("过期时间", payload["message"])

    def test_api_token_auth_cannot_regenerate_zero_rate_limit_target_above_ceiling(self):
        caller_token, _ = self._create_api_token(
            name="rate-limited-regenerator",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=30,
        )
        target_token, _ = self._create_api_token(
            name="legacy-zero-rate-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=20,
            parent_token=caller_token,
        )
        target_token.rate_limit = 0
        target_token.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["rate_limit", "updated_at"],
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        status, payload = regenerate_api_token(request, token_id=target_token.id)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("rate_limit", payload["message"])

    def test_api_token_auth_regenerate_rejects_when_manage_scope_removed_before_commit(self):
        caller_token, _ = self._create_api_token(
            name="revoked-regenerator",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        target_token, _ = self._create_api_token(
            name="regenerate-target",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=caller_token,
        )
        original_sign_hash = target_token.sign_hash
        stale_caller_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=caller_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=caller_token.id).update(
            scopes=["table:read"],
            updated_at=timezone.now(),
        )

        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = stale_caller_token

        status, payload = regenerate_api_token(request, token_id=target_token.id)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("token:manage", payload["message"])
        target_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(target_token.sign_hash, original_sign_hash)

    def test_api_token_auth_delete_rejects_when_manage_scope_removed_before_commit(self):
        caller_token, _ = self._create_api_token(
            name="revoked-deleter",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        target_token, _ = self._create_api_token(
            name="delete-target",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=caller_token,
        )
        stale_caller_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=caller_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=caller_token.id).update(
            scopes=["table:read"],
            updated_at=timezone.now(),
        )

        request = self.factory.delete("/fake")
        request.auth = self.owner
        request.api_token = stale_caller_token

        status, payload = delete_token(request, token_id=target_token.id)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("token:manage", payload["message"])
        self.assertTrue(
            TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=target_token.id).exists()
        )

    def test_delete_token_returns_standard_not_found_response(self):
        request = self.factory.delete("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = delete_token(request, token_id=uuid.uuid4())

        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "Token 不存在")

    def test_regenerate_token_returns_standard_not_found_response(self):
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = regenerate_api_token(request, token_id=uuid.uuid4())

        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertEqual(payload["message"], "Token 不存在")

    def test_api_token_auth_cannot_manage_sibling_token_it_did_not_create(self):
        caller_token, _ = self._create_api_token(
            name="limited-manager",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        sibling_token, _ = self._create_api_token(
            name="sibling-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = caller_token

        body = UpdateTokenRequest(name="should-not-succeed")
        status, payload = update_api_token(request, token_id=sibling_token.id, body=body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "PERMISSION_DENIED")
        self.assertIn("派生", payload["message"])

        sibling_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(sibling_token.name, "sibling-token")

    def test_delete_token_rejects_parent_with_children(self):
        parent_token, _ = self._create_api_token(
            name="jwt-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        child_token, _ = self._create_api_token(
            name="jwt-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=parent_token,
        )

        request = self.factory.delete("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = delete_token(request, token_id=parent_token.id)

        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "VALIDATION_ERROR")
        self.assertIn("派生 Token", payload["message"])
        self.assertTrue(
            TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=parent_token.id).exists()
        )
        self.assertTrue(
            TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=child_token.id).exists()
        )

    def test_verify_token_rejects_child_when_parent_is_inactive(self):
        parent_token, _ = self._create_api_token(
            name="delegator",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        _, child_plain_token = self._create_api_token(
            name="delegated-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=parent_token,
        )

        parent_token.is_active = False
        parent_token.save(validate_delegation=False, update_fields=["is_active", "updated_at"])

        self.assertIsNone(TableApiToken.verify_token(child_plain_token))

    def test_model_create_token_rejects_child_outside_parent_boundary(self):
        parent_token, _ = self._create_api_token(
            name="model-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=30,
        )

        with self.assertRaises(TokenTargetValidationError):
            TableApiToken.create_token(
                user=self.owner,
                parent_token=parent_token,
                name="invalid-child",
                scopes=["token:manage", "table:read", "field:read"],
                space_ids=[str(self.space.id)],
                table_ids=[str(self.table.id)],
                rate_limit=30,
            )

    def test_model_create_token_uses_locked_parent_state(self):
        parent_token, _ = self._create_api_token(
            name="model-stale-parent",
            scopes=["token:manage", "table:read", "field:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        stale_parent_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=parent_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=parent_token.id).update(
            scopes=["token:manage", "table:read"],
            updated_at=timezone.now(),
        )

        with self.assertRaises(TokenTargetValidationError):
            TableApiToken.create_token(
                user=self.owner,
                parent_token=stale_parent_token,
                actor_token=stale_parent_token,
                name="invalid-child-under-stale-parent",
                scopes=["field:read"],
                space_ids=[str(self.space.id)],
                table_ids=[str(self.table.id)],
            )

        self.assertFalse(
            TableApiToken.objects.using(TABDATA_DB_ALIAS)
            .filter(name="invalid-child-under-stale-parent")
            .exists()
        )
        self.assertEqual(
            stale_parent_token.scopes,
            ["token:manage", "table:read"],
        )

    def test_model_create_token_rejects_invalid_scope(self):
        with self.assertRaises(TokenTargetValidationError):
            TableApiToken.create_token(
                user=self.owner,
                name="invalid-scope-token",
                scopes=["table:read", "totally:invalid"],
                space_ids=[str(self.space.id)],
                table_ids=[str(self.table.id)],
            )

    def test_model_delete_rejects_parent_with_children(self):
        parent_token, _ = self._create_api_token(
            name="model-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        self._create_api_token(
            name="model-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=parent_token,
        )

        with self.assertRaises(TokenTargetValidationError):
            parent_token.delete()

    def test_model_delete_rejects_foreign_dirty_child_with_explicit_message(self):
        parent_token, _ = self._create_api_token(
            name="model-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        foreign_child, _ = self._create_api_token(
            user=self.foreign_owner,
            name="foreign-child",
            scopes=["table:read"],
            space_ids=[str(self.foreign_space.id)],
            table_ids=[str(self.foreign_table.id)],
        )
        foreign_child.parent_token = parent_token
        foreign_child.save(
            validate_scope_targets=False,
            validate_delegation=False,
            update_fields=["parent_token", "updated_at"],
        )

        with self.assertRaises(TokenTargetValidationError) as ctx:
            parent_token.delete()
        self.assertIn("跨用户", str(ctx.exception))

    def test_model_delete_with_governance_rejects_when_target_leaves_actor_scope_before_commit(self):
        actor_token, _ = self._create_api_token(
            name="delete-actor",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        new_parent, _ = self._create_api_token(
            name="delete-new-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        target_token, _ = self._create_api_token(
            name="delete-moving-target",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=actor_token,
        )
        stale_actor_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=actor_token.id)
        stale_target_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=target_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=target_token.id).update(
            parent_token_id=new_parent.id,
            updated_at=timezone.now(),
        )

        with self.assertRaises(TokenTargetValidationError) as ctx:
            stale_target_token.delete_with_governance(actor_token=stale_actor_token)

        self.assertIn("派生", str(ctx.exception))
        target_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(target_token.parent_token_id, new_parent.id)
        self.assertEqual(stale_target_token.parent_token_id, new_parent.id)

    def test_model_delete_with_governance_rejects_inactive_actor_before_commit(self):
        actor_token, _ = self._create_api_token(
            name="inactive-delete-actor",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        target_token, _ = self._create_api_token(
            name="inactive-delete-target",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=actor_token,
        )
        stale_actor_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=actor_token.id)
        stale_target_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=target_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=actor_token.id).update(
            is_active=False,
            updated_at=timezone.now(),
        )

        with self.assertRaises(TokenTargetValidationError) as ctx:
            stale_target_token.delete_with_governance(actor_token=stale_actor_token)

        self.assertIn("已停用", str(ctx.exception))
        self.assertTrue(
            TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=target_token.id).exists()
        )

    def test_queryset_delete_rejects_parent_with_children(self):
        parent_token, _ = self._create_api_token(
            name="queryset-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        self._create_api_token(
            name="queryset-child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=parent_token,
        )

        with self.assertRaises(ProtectedError):
            TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=parent_token.id).delete()

    def test_model_create_token_rejects_table_outside_space_scope(self):
        with self.assertRaises(TokenTargetValidationError):
            TableApiToken.create_token(
                user=self.owner,
                name="invalid-model-token",
                scopes=["table:read"],
                space_ids=[str(self.alt_space.id)],
                table_ids=[str(self.table.id)],
            )

    def test_model_regenerate_sign_with_governance_rejects_when_target_leaves_actor_scope_before_commit(self):
        actor_token, _ = self._create_api_token(
            name="regenerate-actor",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        new_parent, _ = self._create_api_token(
            name="regenerate-new-parent",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )
        target_token, _ = self._create_api_token(
            name="regenerate-moving-target",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=actor_token,
        )
        original_sign_hash = target_token.sign_hash
        stale_actor_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=actor_token.id)
        stale_target_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=target_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=target_token.id).update(
            parent_token_id=new_parent.id,
            updated_at=timezone.now(),
        )

        with self.assertRaises(TokenTargetValidationError) as ctx:
            stale_target_token.regenerate_sign_with_governance(actor_token=stale_actor_token)

        self.assertIn("派生", str(ctx.exception))
        target_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(target_token.parent_token_id, new_parent.id)
        self.assertEqual(target_token.sign_hash, original_sign_hash)
        self.assertEqual(stale_target_token.parent_token_id, new_parent.id)

    def test_model_regenerate_sign_with_governance_rejects_expired_actor_before_commit(self):
        actor_token, _ = self._create_api_token(
            name="expired-regenerate-actor",
            scopes=["token:manage", "table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            expired_at=timezone.now() + timedelta(days=1),
        )
        target_token, _ = self._create_api_token(
            name="expired-regenerate-target",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            parent_token=actor_token,
            expired_at=timezone.now() + timedelta(hours=12),
        )
        original_sign_hash = target_token.sign_hash
        stale_actor_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=actor_token.id)
        stale_target_token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=target_token.id)
        TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(pk=actor_token.id).update(
            expired_at=timezone.now() - timedelta(minutes=1),
            updated_at=timezone.now(),
        )

        with self.assertRaises(TokenTargetValidationError) as ctx:
            stale_target_token.regenerate_sign_with_governance(actor_token=stale_actor_token)

        self.assertIn("已过期", str(ctx.exception))
        target_token.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(target_token.sign_hash, original_sign_hash)

    def test_model_save_rejects_inaccessible_table_scope(self):
        token, _ = TableApiToken.create_token(
            user=self.owner,
            name="valid-model-token",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
        )

        token.table_ids = [str(self.foreign_table.id)]
        with self.assertRaises(TokenTargetValidationError):
            token.save()

    def test_create_policy_requires_editor_table_permission_for_jwt(self):
        request = self.factory.post("/fake")
        request.auth = self.viewer
        request.api_token = None

        body = RLSPolicyBody(
            name="viewer_policy",
            condition={"field_id": "owner", "operator": "equals", "value": "$current_user_id"},
        )

        status, payload = create_policy(request, table_id=self.table.id, body=body)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "TABLE_ACCESS_DENIED")
        self.assertFalse(
            RowPolicy.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=self.table.id, name="viewer_policy")
            .exists()
        )

    def test_list_policies_requires_viewer_table_permission_for_jwt(self):
        request = self.factory.get("/fake")
        request.auth = self.outsider
        request.api_token = None

        status, payload = list_policies(request, table_id=self.table.id)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "TABLE_ACCESS_DENIED")

    def test_list_webhooks_requires_editor_space_permission_for_jwt(self):
        request = self.factory.get("/fake", {"space_id": str(self.space.id)})
        request.auth = self.viewer
        request.api_token = None

        response = list_webhooks(request)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(json.loads(response.content)["code"], "PERMISSION_DENIED")

    def test_policy_read_token_respects_space_scope_when_table_ids_unbounded(self):
        request = self.factory.get("/fake")
        request.auth = self.owner
        request.api_token = TableApiToken(
            user=self.owner,
            token_id="adjacenttoken",
            sign_hash="hash",
            scopes=["policy:read"],
            space_ids=[str(self.other_space.id)],
            table_ids=None,
        )

        status, payload = list_policies(request, table_id=self.table.id)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "TABLE_ACCESS_DENIED")

    def test_policy_read_token_requires_table_and_space_intersection(self):
        request = self.factory.get("/fake")
        request.auth = self.owner
        request.api_token = TableApiToken(
            user=self.owner,
            token_id="intersectiontoken",
            sign_hash="hash",
            scopes=["policy:read"],
            space_ids=[str(self.other_space.id)],
            table_ids=[str(self.table.id)],
        )

        status, payload = list_policies(request, table_id=self.table.id)

        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "TABLE_ACCESS_DENIED")

    def test_update_webhook_requires_editor_space_permission_for_jwt(self):
        request = self.factory.patch("/fake")
        request.auth = self.viewer
        request.api_token = None

        body = WebhookUpdateBody(url="https://example.com/updated-webhook")
        response = update_webhook(request, webhook_id=self.webhook.id, body=body)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(json.loads(response.content)["code"], "PERMISSION_DENIED")


class ConnectorServiceUnitTests(SimpleTestCase):
    def test_discover_tables_uses_connector_interface_without_connect_side_channel(self):
        service = ConnectorService(user=None)
        connector = object()
        instance = MagicMock()
        instance.discover_tables.return_value = [
            ExternalTable(schema="public", name="orders"),
        ]
        instance.discover_columns.return_value = [
            ExternalColumn(name="id", data_type="int4", is_primary_key=True),
        ]

        with patch.object(service, "get_connector", return_value=connector), patch.object(
            service,
            "_get_connector_instance",
            return_value=instance,
        ):
            tables = service.discover_tables("connector-id")

        instance.discover_tables.assert_called_once_with()
        instance.discover_columns.assert_called_once_with("public", "orders")
        instance.close.assert_called_once_with()
        self.assertEqual(tables[0].columns[0].name, "id")
