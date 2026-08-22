"""组织 MCP 分享者归属的真实 PostgreSQL 升级场景。"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class MCPConnectionCreatedByMigrationScenario(PostgresMigrationScenarioTestCase):
    migrate_from = (("tabtinspace", "0138_merge_20260803_1125"),)
    migrate_to = (("tabtinspace", "0140_backfill_mcpconnection_created_by"),)

    def test_upgrade_backfills_credential_owner_and_preserves_unknown_sharer(self):
        self.run_migration_scenario()

    def _state_apps(self, connection, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        return executor.loader.project_state(list(targets)).apps

    def seed_before_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_from, required=True)
        old_apps = self._state_apps(connection, targets)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        Organization = old_apps.get_model("tabtinspace", "Organization")
        SecureCredential = old_apps.get_model("tabtinspace", "SecureCredential")
        MCPConnection = old_apps.get_model("tabtinspace", "MCPConnection")

        self.user_id = uuid4()
        self.credential_connection_id = uuid4()
        self.legacy_connection_id = uuid4()
        user = User.objects.create(
            id=self.user_id,
            username=f"mcp-share-migration-{self.user_id.hex[:8]}",
            email=f"mcp-share-migration-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        organization = Organization.objects.create(
            id=uuid4(),
            owner=user,
            name="MCP Share Migration Organization",
        )
        credential = SecureCredential.objects.create(
            id=uuid4(),
            organization=organization,
            user=user,
            name="Organization MCP credential",
            credential_type="api_key",
            encrypted_value="migration-placeholder",
        )
        MCPConnection.objects.create(
            id=self.credential_connection_id,
            organization=organization,
            name="credential-backed",
            scope="remote",
            transport="http",
            endpoint="https://mcp.example.com/credential-backed",
            credential=credential,
        )
        MCPConnection.objects.create(
            id=self.legacy_connection_id,
            organization=organization,
            name="legacy-without-credential",
            scope="remote",
            transport="http",
            endpoint="https://mcp.example.com/legacy",
        )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        MCPConnection = new_apps.get_model("tabtinspace", "MCPConnection")

        credential_connection = MCPConnection.objects.get(
            id=self.credential_connection_id,
        )
        legacy_connection = MCPConnection.objects.get(id=self.legacy_connection_id)
        self.assertEqual(str(credential_connection.created_by_id), str(self.user_id))
        self.assertIsNone(legacy_connection.created_by_id)
