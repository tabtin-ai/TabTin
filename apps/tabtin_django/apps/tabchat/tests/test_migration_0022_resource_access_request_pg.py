"""tabchat.0022 ResourceAccessRequest editor / optional source 的 PG 场景测试。

覆盖：
- 前向：允许 editor + source_conversation NULL
- 反向：先清掉 editor / null-source 行，再恢复 viewer-only 与 NOT NULL
- 再前向：可再次升到 0022
"""

from __future__ import annotations

import uuid

from django.db import connections
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class ResourceAccessRequestEditorForwardScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabchat"
    migrate_from = "0021_reconcile_orphaned_message_reaction_schema"
    migrate_to = "0022_resource_access_request_editor_optional_source"

    def test_forward_allows_editor_and_null_source(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        # 前向本身不依赖脏数据；保留空 seed。
        return

    def assert_after_migration(self, connection) -> None:
        self.assertTrue(
            self.column_nullable("tabchat_resource_access_request", "source_conversation_id")
        )
        row = self.fetchone(
            """
            SELECT pg_get_constraintdef(c.oid)
            FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            WHERE t.relname = 'tabchat_resource_access_request'
              AND c.conname = 'tabchat_rar_role_viewer_editor'
            """
        )
        self.assertIsNotNone(row)
        self.assertIn("editor", row[0])


class ResourceAccessRequestReverseCleanupScenario(PostgresMigrationScenarioTestCase):
    """0022 → 插入不兼容行 → 回滚 0021 → 再前进 0022。"""

    app_label = "tabchat"
    migrate_from = "0021_reconcile_orphaned_message_reaction_schema"
    migrate_to = "0022_resource_access_request_editor_optional_source"

    def test_reverse_cleans_incompatible_rows_then_reforward(self) -> None:
        connection = connections[self._alias]
        self._migrate(
            connection,
            [("tabchat", "0022_resource_access_request_editor_optional_source")],
        )

        org_id = str(uuid.uuid4())
        owner_id = f"owner-{uuid.uuid4().hex[:8]}"
        requester_id = f"req-{uuid.uuid4().hex[:8]}"
        conversation_id = str(uuid.uuid4())
        resource_id = str(uuid.uuid4())

        self.execute(
            """
            INSERT INTO tabchat_conversation (
                id, organization_id, type, name, avatar_url, created_by,
                last_message_preview, member_count, archived_by, is_archived,
                latest_message_seq, created_at, updated_at
            ) VALUES (
                %s::uuid, %s, 1, 'mig', '', %s,
                '', 1, '', false,
                0, NOW(), NOW()
            )
            """,
            [conversation_id, org_id, owner_id],
        )

        # 兼容旧路径：带会话的 viewer pending（反向后应保留）
        keep_id = str(uuid.uuid4())
        self.execute(
            """
            INSERT INTO tabchat_resource_access_request (
                id, resource_type, resource_id, requester_id, owner_id,
                source_conversation_id, source_message_id, role, status,
                resolved_by, created_at, updated_at
            ) VALUES (
                %s::uuid, 'document', %s::uuid, %s, %s,
                %s::uuid, 1, 'viewer', 'pending',
                '', NOW(), NOW()
            )
            """,
            [keep_id, resource_id, requester_id, owner_id, conversation_id],
        )

        # 反向不兼容：editor + null source
        drop_editor_id = str(uuid.uuid4())
        drop_null_id = str(uuid.uuid4())
        self.execute(
            """
            INSERT INTO tabchat_resource_access_request (
                id, resource_type, resource_id, requester_id, owner_id,
                source_conversation_id, source_message_id, role, status,
                resolved_by, created_at, updated_at
            ) VALUES (
                %s::uuid, 'document', %s::uuid, %s, %s,
                %s::uuid, 2, 'editor', 'pending',
                '', NOW(), NOW()
            )
            """,
            [drop_editor_id, str(uuid.uuid4()), f"{requester_id}-e", owner_id, conversation_id],
        )
        self.execute(
            """
            INSERT INTO tabchat_resource_access_request (
                id, resource_type, resource_id, requester_id, owner_id,
                source_conversation_id, source_message_id, role, status,
                resolved_by, created_at, updated_at
            ) VALUES (
                %s::uuid, 'table', %s::uuid, %s, %s,
                NULL, NULL, 'editor', 'pending',
                '', NOW(), NOW()
            )
            """,
            [drop_null_id, str(uuid.uuid4()), f"{requester_id}-n", owner_id],
        )

        # 回滚到 0021
        self._migrate(
            connection,
            [("tabchat", "0021_reconcile_orphaned_message_reaction_schema")],
        )

        remaining = self.fetchall(
            "SELECT id::text, role FROM tabchat_resource_access_request ORDER BY role"
        )
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0][0], keep_id)
        self.assertEqual(remaining[0][1], "viewer")
        self.assertFalse(
            self.column_nullable("tabchat_resource_access_request", "source_conversation_id")
        )
        old_constraint = self.fetchone(
            """
            SELECT COUNT(*)
            FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            WHERE t.relname = 'tabchat_resource_access_request'
              AND c.conname = 'tabchat_rar_role_viewer_only'
            """
        )
        self.assertEqual(old_constraint[0], 1)

        # 再前进到 0022
        self._migrate(
            connection,
            [("tabchat", "0022_resource_access_request_editor_optional_source")],
        )
        self.assertTrue(
            self.column_nullable("tabchat_resource_access_request", "source_conversation_id")
        )

    def seed_before_migration(self, connection) -> None:
        return

    def assert_after_migration(self, connection) -> None:
        return
