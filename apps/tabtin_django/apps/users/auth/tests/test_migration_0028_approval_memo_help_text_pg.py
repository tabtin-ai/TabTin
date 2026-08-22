"""users_auth.0028 legacy 审批记忆字段状态变更的 PostgreSQL 回归测试。

UserAgentApprovalMemo 仅是历史兼容表；当前审批记忆的权威源是
tabtinspace.Workspace.approval_memo，新写入不得回到 Agent 级记录。
"""

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class LegacyApprovalMemoHelpTextMigrationScenario(
    PostgresMigrationScenarioTestCase
):
    app_label = "users_auth"
    migrate_from = "0027_backfill_analytics_permissions"
    migrate_to = "0028_alter_useragentapprovalmemo_agent_help_text"

    def test_legacy_row_survives_help_text_state_change(self) -> None:
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        targets = self._resolve_targets(target, required=True)
        return executor.loader.project_state(targets).apps

    def seed_before_migration(self, connection) -> None:
        old_apps = self._state_apps(connection, self.migrate_from)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        LegacyApprovalMemo = old_apps.get_model(
            "users_auth",
            "UserAgentApprovalMemo",
        )

        self.user_id = str(uuid4())
        self.memo_id = uuid4()
        self.agent_id = uuid4()
        self.action_type = "execute_in_terminal"
        self.pattern = "pnpm test"
        self.rule_kind = "allow"

        user = User.objects.create(
            id=self.user_id,
            username=f"legacy-memo-{self.user_id[:8]}",
            email=f"legacy-memo-{self.user_id[:8]}@tabtin.test",
            password="!",
        )
        LegacyApprovalMemo.objects.create(
            id=self.memo_id,
            user=user,
            agent_id=self.agent_id,
            action_type=self.action_type,
            pattern=self.pattern,
            rule_kind=self.rule_kind,
        )

        self.assertEqual(
            LegacyApprovalMemo._meta.get_field("agent_id").help_text,
            "指向 tabtinspace.Agent.id；跨库不做 FK",
        )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(connection, self.migrate_to)
        LegacyApprovalMemo = new_apps.get_model(
            "users_auth",
            "UserAgentApprovalMemo",
        )

        memo = LegacyApprovalMemo.objects.get(id=self.memo_id)
        self.assertEqual(memo.id, self.memo_id)
        self.assertEqual(memo.user_id, self.user_id)
        self.assertEqual(memo.agent_id, self.agent_id)
        self.assertEqual(memo.action_type, self.action_type)
        self.assertEqual(memo.pattern, self.pattern)
        self.assertEqual(memo.rule_kind, self.rule_kind)
        self.assertEqual(
            LegacyApprovalMemo._meta.get_field("agent_id").help_text,
            "指向 agent.Agent.id；跨库不做 FK",
        )
