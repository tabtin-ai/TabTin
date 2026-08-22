from __future__ import annotations

import importlib
from types import SimpleNamespace
from uuid import uuid4

from django.apps import apps as django_apps
from django.db import connections
from django.test import TestCase

from apps.services.common.db_router import postgres_app_db_alias
from apps.chat.conversation.models import ChatContext, ChatSession
from apps.tabchat.constants import ConversationType
from apps.tabchat.models import Conversation
from apps.tabdata.models import Table
from apps.tabdata.models_token import TableApiToken
from apps.tabmemo.models import MemoCollection
from apps.tabtinspace.models import (
    Agent,
    ContextItem,
    Space,
    SpaceAppSettings,
    SpaceMembership,
    SpacePermission,
)
from apps.tabtinspace.tests.fixtures import (
    create_test_user,
    create_test_organization,
)


MIGRATION_MODULE = "apps.tabtinspace.migrations.0064_space_first_shadow_space_cleanup"
LEGACY_SPACE_TYPE_DM = "dm"
LEGACY_SPACE_TYPE_GROUP = "group"
LEGACY_SPACE_TYPE_TEAM = "team"


class SpaceFirstShadowSpaceCleanupMigrationTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.db_alias = postgres_app_db_alias()
        self.connection = connections[self.db_alias]
        self.owner = create_test_user(prefix="sf_phase3")
        self.organization = create_test_organization(owner=self.owner, prefix="sf_phase3")
        self.target_agent = Agent.objects.using(self.db_alias).create(
            organization=self.organization,
            owner_user=self.owner,
            name="Target Bot",
            type="bot",
            is_active=True,
        )
        self.target_space = Space.objects.using(self.db_alias).create(
            organization=self.organization,
            agent=self.target_agent,
            type=Space.SpaceType.WORKSPACE,
            name="Target Bot Space",
            status="active",
        )

    def _run_migration(self) -> None:
        migration = importlib.import_module(MIGRATION_MODULE)
        schema_editor = SimpleNamespace(connection=self.connection)
        migration.cleanup_shadow_spaces(django_apps, schema_editor)

    def _make_shadow_conversation(self, space_type: str = LEGACY_SPACE_TYPE_GROUP) -> tuple[Space, Conversation]:
        """构造 Phase 3 迁移要清理的历史 dm/group shadow Space 行。"""
        shadow_space = Space.objects.using(self.db_alias).create(
            organization=self.organization,
            type=space_type,
            name=f"Shadow {space_type} {uuid4().hex[:8]}",
            status="active",
        )
        SpaceMembership.objects.using(self.db_alias).create(
            space=shadow_space,
            user_id=self.owner.id,
            role="participant",
            is_active=True,
        )
        conversation = Conversation.objects.using(self.db_alias).create(
            organization_id=str(self.organization.id),
            space_id=shadow_space.id,
            type=(
                ConversationType.DM.value
                if space_type == LEGACY_SPACE_TYPE_DM
                else ConversationType.GROUP.value
            ),
            created_by=str(self.owner.id),
            name="legacy shadow conversation",
        )
        return shadow_space, conversation

    def _audit_rows_for_space(self, space_id) -> list[tuple[str, str | None, str | None]]:
        table = self.connection.ops.quote_name("tabtinspace_shadow_space_cleanup_audit")
        with self.connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT action, conversation_id::text, old_space_id::text
                FROM {table}
                WHERE old_space_id = %s
                ORDER BY id
                """,
                [str(space_id)],
            )
            return list(cursor.fetchall())

    def _team_audit_counts(self) -> list[int]:
        table = self.connection.ops.quote_name("tabtinspace_shadow_space_cleanup_audit")
        with self.connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT (details->>'team_space_count')::int
                FROM {table}
                WHERE action = 'team_space_audit'
                ORDER BY id DESC
                """
            )
            return [int(row[0]) for row in cursor.fetchall()]

    def _relocation_targets_for_space(self, space_id) -> list[str]:
        table = self.connection.ops.quote_name("tabtinspace_shadow_space_cleanup_audit")
        with self.connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT details->>'target_space_id'
                FROM {table}
                WHERE old_space_id = %s
                  AND action IN ('shadow_space_relocation_target', 'shadow_space_ref_relocate',
                                 'shadow_space_json_ref_relocate')
                ORDER BY id
                """,
                [str(space_id)],
            )
            return [row[0] for row in cursor.fetchall()]

    def test_cleanup_detaches_conversation_and_deletes_shadow_space_with_only_memberships(self) -> None:
        shadow_space, conversation = self._make_shadow_conversation(LEGACY_SPACE_TYPE_DM)

        self._run_migration()

        conversation.refresh_from_db(using=self.db_alias)
        self.assertIsNone(conversation.space_id)
        self.assertFalse(Space.objects.using(self.db_alias).filter(id=shadow_space.id).exists())
        self.assertFalse(
            SpaceMembership.objects.using(self.db_alias).filter(workspace_id=shadow_space.id).exists()
        )

        audit_rows = self._audit_rows_for_space(shadow_space.id)
        self.assertIn(
            ("conversation_space_detach", str(conversation.id), str(shadow_space.id)),
            audit_rows,
        )
        self.assertIn(("shadow_space_delete", None, str(shadow_space.id)), audit_rows)
        self.assertIn(str(self.target_space.id), self._relocation_targets_for_space(shadow_space.id))

    def _assert_reference_is_relocated(self, create_reference, assert_relocated) -> None:
        shadow_space, conversation = self._make_shadow_conversation(LEGACY_SPACE_TYPE_GROUP)
        ref = create_reference(shadow_space)

        self._run_migration()

        conversation.refresh_from_db(using=self.db_alias)
        self.assertIsNone(conversation.space_id)
        self.assertFalse(Space.objects.using(self.db_alias).filter(id=shadow_space.id).exists())
        assert_relocated(ref, shadow_space)

    def test_missing_target_bot_space_aborts_without_half_cleanup(self) -> None:
        self.target_space.delete()
        self.target_agent.delete()
        shadow_space, conversation = self._make_shadow_conversation(LEGACY_SPACE_TYPE_GROUP)

        with self.assertRaisesRegex(RuntimeError, "without active bot Space"):
            self._run_migration()

        conversation.refresh_from_db(using=self.db_alias)
        self.assertEqual(conversation.space_id, shadow_space.id)
        self.assertTrue(Space.objects.using(self.db_alias).filter(id=shadow_space.id).exists())

    def test_context_item_relocates_to_bot_space(self) -> None:
        def create_ref(space: Space) -> ContextItem:
            return ContextItem.objects.using(self.db_alias).create(
                space=space,
                item_type="tabdoc",
                title="real context item",
                status="active",
                resource_id=str(uuid4()),
                is_archived=False,
            )

        def assert_relocated(item: ContextItem, _space: Space) -> None:
            item.refresh_from_db(using=self.db_alias)
            self.assertEqual(item.space_id, self.target_space.id)

        self._assert_reference_is_relocated(create_ref, assert_relocated)

    def test_resource_softref_relocates_to_bot_space(self) -> None:
        def create_ref(space: Space) -> Table:
            return Table.objects.using(self.db_alias).create(
                organization_id=self.organization.id,
                space_id=space.id,
                owner=self.owner,
                name="real table",
            )

        def assert_relocated(table: Table, _space: Space) -> None:
            table.refresh_from_db(using=self.db_alias)
            self.assertEqual(table.space_id, self.target_space.id)

        self._assert_reference_is_relocated(create_ref, assert_relocated)

    def test_non_table_resource_softref_relocates_to_bot_space(self) -> None:
        def create_ref(space: Space) -> MemoCollection:
            return MemoCollection.objects.using(self.db_alias).create(
                organization_id=self.organization.id,
                space_id=space.id,
                title="real memo collection",
                created_by=self.owner,
            )

        def assert_relocated(collection: MemoCollection, _space: Space) -> None:
            collection.refresh_from_db(using=self.db_alias)
            self.assertEqual(collection.space_id, self.target_space.id)

        self._assert_reference_is_relocated(create_ref, assert_relocated)

    def test_space_app_settings_is_deleted_with_shadow_space(self) -> None:
        def create_ref(space: Space) -> SpaceAppSettings:
            return SpaceAppSettings.objects.using(self.db_alias).create(
                space=space,
                user=self.owner,
            )

        def assert_deleted(settings: SpaceAppSettings, _space: Space) -> None:
            self.assertFalse(
                SpaceAppSettings.objects.using(self.db_alias).filter(id=settings.id).exists()
            )

        self._assert_reference_is_relocated(create_ref, assert_deleted)

    def test_space_permission_is_deleted_with_shadow_space(self) -> None:
        def create_ref(space: Space) -> SpacePermission:
            return SpacePermission.objects.using(self.db_alias).create(
                space=space,
                subject_type="user",
                subject_id=str(self.owner.id),
                permission="viewer",
                granted_by=str(self.owner.id),
            )

        def assert_deleted(permission: SpacePermission, _space: Space) -> None:
            self.assertFalse(
                SpacePermission.objects.using(self.db_alias).filter(id=permission.id).exists()
            )

        self._assert_reference_is_relocated(create_ref, assert_deleted)

    def test_table_api_token_space_ids_json_relocates_to_bot_space(self) -> None:
        def create_ref(space: Space) -> TableApiToken:
            token = TableApiToken(
                name="shadow-json-token",
                user_id=self.owner.id,
                token_id=f"sf64{uuid4().hex[:8]}",
                sign_hash="0" * 64,
                scopes=["record:read"],
                space_id=None,
                space_ids=[str(space.id), str(uuid4())],
                is_active=True,
                rate_limit=60,
            )
            token.save(
                using=self.db_alias,
                force_insert=True,
                validate_scopes=False,
                validate_scope_targets=False,
                validate_delegation=False,
            )
            return token

        def assert_relocated(token: TableApiToken, shadow_space: Space) -> None:
            token.refresh_from_db(using=self.db_alias)
            self.assertIn(str(self.target_space.id), token.space_ids)
            self.assertNotIn(str(shadow_space.id), token.space_ids)

        self._assert_reference_is_relocated(create_ref, assert_relocated)

    def test_chat_context_recent_spaces_json_relocates_to_bot_space(self) -> None:
        def create_ref(space: Space) -> ChatContext:
            session = ChatSession.objects.using(self.db_alias).create(
                user=self.owner,
                organization_id=str(self.organization.id),
                space_id=None,
                title="shadow json session",
            )
            ChatContext.objects.using(self.db_alias).create(
                session=session,
                current_space_id="",
                recent_spaces=[str(space.id), str(uuid4())],
            )
            return session.context

        def assert_relocated(context: ChatContext, shadow_space: Space) -> None:
            context.refresh_from_db(using=self.db_alias)
            self.assertIn(str(self.target_space.id), context.recent_spaces)
            self.assertNotIn(str(shadow_space.id), context.recent_spaces)

        self._assert_reference_is_relocated(create_ref, assert_relocated)

    def test_team_space_is_audited_but_not_detached_or_deleted(self) -> None:
        team_space = Space.objects.using(self.db_alias).create(
            organization=self.organization,
            # Phase 3 仅审计历史 team Space，不做删除；Phase 4 后不再作为
            # Space.SpaceType 枚举成员暴露。
            type=LEGACY_SPACE_TYPE_TEAM,
            name=f"Team {uuid4().hex[:8]}",
            status="active",
        )
        conversation = Conversation.objects.using(self.db_alias).create(
            organization_id=str(self.organization.id),
            space_id=team_space.id,
            type=ConversationType.GROUP.value,
            created_by=str(self.owner.id),
            name="team conversation",
        )

        self._run_migration()

        conversation.refresh_from_db(using=self.db_alias)
        self.assertEqual(conversation.space_id, team_space.id)
        self.assertTrue(Space.objects.using(self.db_alias).filter(id=team_space.id).exists())
        self.assertIn(1, self._team_audit_counts())
