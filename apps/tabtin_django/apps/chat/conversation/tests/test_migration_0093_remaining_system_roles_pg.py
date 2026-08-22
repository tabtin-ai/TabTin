"""0093 回填遗漏的系统作者消息。"""

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class TestRemainingSystemRolesMigrationScenario(PostgresMigrationScenarioTestCase):
    __test__ = True
    covered_migrations = (("conversation", "0093_backfill_remaining_system_authored_roles"),)
    migrate_from = (("conversation", "0092_backfill_system_authored_message_roles"),)
    migrate_to = (("conversation", "0093_backfill_remaining_system_authored_roles"),)

    def test_forward_normalizes_only_remaining_system_messages(self) -> None:
        self.run_migration_scenario()

    @staticmethod
    def _state_apps(connection, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        return executor.loader.project_state(list(targets)).apps

    def seed_before_migration(self, connection) -> None:
        old_apps = self._state_apps(
            connection,
            self._resolve_targets(self.migrate_from, required=True),
        )
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        ChatSession = old_apps.get_model("conversation", "ChatSession")
        ChatMessage = old_apps.get_model("conversation", "ChatMessage")

        user = User.objects.create(
            id=uuid4(),
            username=f"remaining-system-role-{uuid4().hex[:8]}",
            email=f"remaining-system-role-{uuid4().hex[:8]}@tabtin.test",
            password="!",
        )
        session = ChatSession.objects.create(
            id=uuid4(),
            user=user,
            organization_id=str(uuid4()),
            title="Remaining system role migration",
            status="active",
        )
        self.system_message_ids = []
        for message_kind, metadata in (
            ("external_archive_context", {}),
            ("llm", {"triggered_by": "parent_midflight"}),
        ):
            message_id = uuid4()
            self.system_message_ids.append(message_id)
            ChatMessage.objects.create(
                id=message_id,
                session=session,
                role="user",
                message_kind=message_kind,
                metadata=metadata,
                text_summary="system generated",
            )
        self.human_message_id = uuid4()
        ChatMessage.objects.create(
            id=self.human_message_id,
            session=session,
            role="user",
            message_kind="llm",
            metadata={"triggered_by": "user"},
            text_summary="human message",
        )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(
            connection,
            self._resolve_targets(self.migrate_to, required=True),
        )
        ChatMessage = new_apps.get_model("conversation", "ChatMessage")
        roles = dict(
            ChatMessage.objects.filter(id__in=self.system_message_ids)
            .values_list("id", "role")
        )
        self.assertEqual(set(roles.values()), {"system"})
        self.assertEqual(ChatMessage.objects.get(id=self.human_message_id).role, "user")
