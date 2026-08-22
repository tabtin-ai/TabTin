"""SessionShare state-only migrations 的 PostgreSQL 升级场景。"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class SessionShare0074MigrationScenario(PostgresMigrationScenarioTestCase):
    """覆盖 0074 的 choices/help_text state-only AlterField。

    migration_risk_check 会把 non-null AlterField 当成需要场景测试的高风险项。
    这里用真实 PG 路径证明：0073 已建出的非空列在 0074 升级后保持数据，
    且新增的 ``chatted`` choices 口径不会阻止审计事件写入。
    """

    covered_migrations = (
        ("conversation", "0074_alter_sessionshare_can_chat_and_more"),
    )
    app_label = "conversation"
    migrate_from = "0073_sessionshare_sessionshareevent_and_more"
    migrate_to = "0074_alter_sessionshare_can_chat_and_more"

    def test_state_only_alter_fields_preserve_existing_share_data(self) -> None:
        self.run_migration_scenario()

    @staticmethod
    def _state_apps(connection, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        return executor.loader.project_state(list(targets)).apps

    def seed_before_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_from, required=True)
        old_apps = self._state_apps(connection, targets)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        ChatSession = old_apps.get_model("conversation", "ChatSession")
        SessionShare = old_apps.get_model("conversation", "SessionShare")
        SessionShareEvent = old_apps.get_model("conversation", "SessionShareEvent")

        self.owner_id = uuid4()
        self.grantee_id = uuid4()
        self.session_id = uuid4()
        self.share_id = uuid4()
        self.organization_id = uuid4()

        owner = User.objects.create(
            id=self.owner_id,
            username=f"share-0074-owner-{self.owner_id.hex[:8]}",
            email=f"share-0074-owner-{self.owner_id.hex[:8]}@tabtin.test",
            password="!",
        )
        User.objects.create(
            id=self.grantee_id,
            username=f"share-0074-grantee-{self.grantee_id.hex[:8]}",
            email=f"share-0074-grantee-{self.grantee_id.hex[:8]}@tabtin.test",
            password="!",
        )
        session = ChatSession.objects.create(
            id=self.session_id,
            user=owner,
            organization_id=str(self.organization_id),
            title="SessionShare 0074 migration session",
            status="active",
        )
        share = SessionShare.objects.create(
            id=self.share_id,
            session=session,
            organization_id=str(self.organization_id),
            owner_user_id=str(self.owner_id),
            grantee_user_id=str(self.grantee_id),
            can_fork=False,
            can_chat=True,
            status="active",
        )
        SessionShareEvent.objects.create(
            share=share,
            actor_user_id=str(self.owner_id),
            event_type="created",
            payload_json={"can_fork": False, "can_chat": True},
        )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        SessionShare = new_apps.get_model("conversation", "SessionShare")
        SessionShareEvent = new_apps.get_model("conversation", "SessionShareEvent")

        share = SessionShare.objects.get(id=self.share_id)
        self.assertEqual(str(share.session_id), str(self.session_id))
        self.assertEqual(share.organization_id, str(self.organization_id))
        self.assertEqual(share.owner_user_id, str(self.owner_id))
        self.assertEqual(share.grantee_user_id, str(self.grantee_id))
        self.assertFalse(share.can_fork)
        self.assertTrue(share.can_chat)
        self.assertEqual(share.status, "active")
        self.assertEqual(SessionShareEvent.objects.filter(share=share).count(), 1)

        SessionShareEvent.objects.create(
            share=share,
            actor_user_id=str(self.grantee_id),
            event_type="chatted",
            payload_json={"message": "0074 accepts chatted event type"},
        )
        self.assertTrue(
            SessionShareEvent.objects.filter(
                share=share,
                event_type="chatted",
            ).exists()
        )


class SessionShare0075MigrationScenario(PostgresMigrationScenarioTestCase):
    """覆盖 0075 的 forked_session_id help_text state-only AlterField。

    migration_risk_check 无法从 AlterField 中区分纯 state 变更，会把 UUIDField
    识别为 type-change 风险。这里用真实 PG 路径证明：0074 已存在的 fork
    指针在 0075 升级后保持不变。
    """

    covered_migrations = (
        ("conversation", "0075_alter_sessionshare_forked_session_id"),
    )
    app_label = "conversation"
    migrate_from = "0074_alter_sessionshare_can_chat_and_more"
    migrate_to = "0075_alter_sessionshare_forked_session_id"

    def test_state_only_forked_session_id_alter_preserves_pointer(self) -> None:
        self.run_migration_scenario()

    @staticmethod
    def _state_apps(connection, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        return executor.loader.project_state(list(targets)).apps

    def seed_before_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_from, required=True)
        old_apps = self._state_apps(connection, targets)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        ChatSession = old_apps.get_model("conversation", "ChatSession")
        SessionShare = old_apps.get_model("conversation", "SessionShare")

        self.owner_id = uuid4()
        self.grantee_id = uuid4()
        self.session_id = uuid4()
        self.forked_session_id = uuid4()
        self.share_id = uuid4()
        self.organization_id = uuid4()

        owner = User.objects.create(
            id=self.owner_id,
            username=f"share-0075-owner-{self.owner_id.hex[:8]}",
            email=f"share-0075-owner-{self.owner_id.hex[:8]}@tabtin.test",
            password="!",
        )
        User.objects.create(
            id=self.grantee_id,
            username=f"share-0075-grantee-{self.grantee_id.hex[:8]}",
            email=f"share-0075-grantee-{self.grantee_id.hex[:8]}@tabtin.test",
            password="!",
        )
        ChatSession.objects.create(
            id=self.session_id,
            user=owner,
            organization_id=str(self.organization_id),
            title="SessionShare 0075 source session",
            status="active",
        )
        ChatSession.objects.create(
            id=self.forked_session_id,
            user=owner,
            organization_id=str(self.organization_id),
            title="SessionShare 0075 forked session",
            status="active",
        )
        SessionShare.objects.create(
            id=self.share_id,
            session_id=self.session_id,
            organization_id=str(self.organization_id),
            owner_user_id=str(self.owner_id),
            grantee_user_id=str(self.grantee_id),
            can_fork=True,
            can_chat=True,
            forked_session_id=self.forked_session_id,
            status="active",
        )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        SessionShare = new_apps.get_model("conversation", "SessionShare")

        share = SessionShare.objects.get(id=self.share_id)
        self.assertEqual(str(share.session_id), str(self.session_id))
        self.assertEqual(str(share.forked_session_id), str(self.forked_session_id))
        self.assertEqual(share.organization_id, str(self.organization_id))
        self.assertEqual(share.owner_user_id, str(self.owner_id))
        self.assertEqual(share.grantee_user_id, str(self.grantee_id))
        self.assertTrue(share.can_fork)
        self.assertTrue(share.can_chat)
        self.assertEqual(share.status, "active")
