"""SessionShare v2 迁移在真实 PostgreSQL 上的升级场景。"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class SessionShareV2MigrationScenario(PostgresMigrationScenarioTestCase):
    """历史共享升级后保留数据，并获得安全的 v2 默认值。"""

    __test__ = True

    covered_migrations = (
        ("conversation", "0096_sessionshare_v2_contract"),
        ("conversation", "0098_merge_release_and_sessionshare_v2"),
    )
    app_label = "conversation"
    migrate_from = "0095_merge_20260810_2130"
    migrate_to = "0098_merge_release_and_sessionshare_v2"

    def test_existing_share_survives_v2_schema_upgrade(self) -> None:
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
        self.share_id = uuid4()
        self.organization_id = uuid4()

        owner = User.objects.create(
            id=self.owner_id,
            username=f"share-v2-owner-{self.owner_id.hex[:8]}",
            email=f"share-v2-owner-{self.owner_id.hex[:8]}@tabtin.test",
            password="!",
        )
        User.objects.create(
            id=self.grantee_id,
            username=f"share-v2-grantee-{self.grantee_id.hex[:8]}",
            email=f"share-v2-grantee-{self.grantee_id.hex[:8]}@tabtin.test",
            password="!",
        )
        session = ChatSession.objects.create(
            id=self.session_id,
            user=owner,
            organization_id=str(self.organization_id),
            title="SessionShare v2 migration session",
            status="active",
        )
        SessionShare.objects.create(
            id=self.share_id,
            session=session,
            organization_id=str(self.organization_id),
            owner_user_id=str(self.owner_id),
            grantee_user_id=str(self.grantee_id),
            can_fork=False,
            can_chat=True,
            status="active",
        )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        SessionShare = new_apps.get_model("conversation", "SessionShare")
        SessionContinuation = new_apps.get_model(
            "conversation",
            "SessionContinuation",
        )
        SessionContinuationEvent = new_apps.get_model(
            "conversation",
            "SessionContinuationEvent",
        )

        share = SessionShare.objects.get(id=self.share_id)
        self.assertEqual(share.status, "active")
        self.assertEqual(share.card_contract, "session_share")
        self.assertEqual(share.card_schema_version, 1)
        self.assertEqual(share.version, 1)
        self.assertEqual(share.access_epoch, 1)
        self.assertEqual(share.delivery_status, "confirmed")
        self.assertEqual(share.eligibility_status, "eligible")
        self.assertEqual(share.ineligibility_reason, "")
        self.assertIsNotNone(share.updated_at)

        continuation = SessionContinuation.objects.create(
            organization_id=str(self.organization_id),
            source_session_id=self.session_id,
            sender_user_id=str(self.owner_id),
            recipient_user_id=str(self.grantee_id),
            client_request_id=uuid4(),
            card_message_ref=uuid4(),
        )
        SessionContinuationEvent.objects.create(
            continuation=continuation,
            actor_user_id=str(self.owner_id),
            event_type="created",
        )
        self.assertEqual(continuation.events.count(), 1)
