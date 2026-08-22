"""tabchat.0017 HandoffReference 字段 AlterField 的 PostgreSQL 场景测试。

0017 对 ref_type 增加 choices「chat_session」、source_link 更新 help_text。
两字段在 0016 创建时即为 NOT NULL（CharField 默认 / JSONField 带 default=dict），
0017 不改可空性——此测试证明已有行迁移后完好。
"""

from uuid import uuid4

from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class HandoffReferenceAlterFieldScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabchat"
    migrate_from = "0016_handoffpackage_handoffevent_handoffreference_and_more"
    migrate_to = "0017_handoffreference_frozen_snapshot_json_and_more"

    def test_existing_reference_survives_alter(self) -> None:
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        targets = self._resolve_targets(target, required=True)
        return executor.loader.project_state(targets).apps

    def seed_before_migration(self, connection) -> None:
        old_apps = self._state_apps(connection, self.migrate_from)
        Conversation = old_apps.get_model("tabchat", "Conversation")
        HandoffPackage = old_apps.get_model("tabchat", "HandoffPackage")
        HandoffReference = old_apps.get_model("tabchat", "HandoffReference")

        self.user_id = str(uuid4())
        self.org_id = str(uuid4())
        self.package_id = uuid4()
        self.ref_id = uuid4()

        conversation = Conversation.objects.create(
            organization_id=self.org_id,
            type=2,
            created_by=self.user_id,
        )

        package = HandoffPackage.objects.create(
            id=self.package_id,
            conversation=conversation,
            organization_id=self.org_id,
            initiator_user_id=self.user_id,
            goal="测试 0017 字段变更",
        )

        HandoffReference.objects.create(
            id=self.ref_id,
            package=package,
            ref_type="attachment",
            resource_id=str(uuid4()),
            source_link={"conversation_id": str(uuid4()), "message_id": str(uuid4())},
        )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(connection, self.migrate_to)
        HandoffReference = new_apps.get_model("tabchat", "HandoffReference")

        ref = HandoffReference.objects.get(id=self.ref_id)
        self.assertEqual(ref.ref_type, "attachment")
        self.assertIn("conversation_id", ref.source_link)
        self.assertFalse(self.column_nullable("tabchat_handoff_reference", "ref_type"))
        self.assertFalse(self.column_nullable("tabchat_handoff_reference", "source_link"))
