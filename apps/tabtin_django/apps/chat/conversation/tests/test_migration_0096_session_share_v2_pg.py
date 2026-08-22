"""PostgreSQL upgrade coverage for the session-share v2 schema."""

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class SessionShare0096MigrationScenario(PostgresMigrationScenarioTestCase):
    __test__ = True
    covered_migrations = (("conversation", "0096_sessionshare_v2_contract"),)
    app_label = "conversation"
    migrate_from = "0093_chatmessagewithdrawevent"
    migrate_to = "0096_sessionshare_v2_contract"

    def test_existing_active_share_keeps_access_and_v2_defaults(self) -> None:
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
        SessionShare = old_apps.get_model("conversation", "SessionShare")

        self.owner_id = uuid4()
        self.grantee_id = uuid4()
        self.session_id = uuid4()
        self.share_id = uuid4()
        self.organization_id = uuid4()

        owner = User.objects.create(
            id=self.owner_id,
            username=f"share-0096-owner-{self.owner_id.hex[:8]}",
            email=f"share-0096-owner-{self.owner_id.hex[:8]}@tabtin.test",
            password="!",
        )
        User.objects.create(
            id=self.grantee_id,
            username=f"share-0096-grantee-{self.grantee_id.hex[:8]}",
            email=f"share-0096-grantee-{self.grantee_id.hex[:8]}@tabtin.test",
            password="!",
        )
        session = ChatSession.objects.create(
            id=self.session_id,
            user=owner,
            organization_id=str(self.organization_id),
            title="SessionShare 0096 migration session",
            status="active",
        )
        SessionShare.objects.create(
            id=self.share_id,
            session=session,
            organization_id=str(self.organization_id),
            owner_user_id=str(self.owner_id),
            grantee_user_id=str(self.grantee_id),
            can_fork=False,
            can_chat=False,
            status="active",
        )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(
            connection,
            self._resolve_targets(self.migrate_to, required=True),
        )
        SessionShare = new_apps.get_model("conversation", "SessionShare")

        share = SessionShare.objects.get(id=self.share_id)
        self.assertEqual(str(share.session_id), str(self.session_id))
        self.assertEqual(share.organization_id, str(self.organization_id))
        self.assertEqual(share.owner_user_id, str(self.owner_id))
        self.assertEqual(share.grantee_user_id, str(self.grantee_id))
        self.assertEqual(share.status, "active")
        self.assertEqual(share.card_contract, "session_share")
        self.assertEqual(share.delivery_status, "confirmed")
        self.assertEqual(share.eligibility_status, "eligible")
        self.assertEqual(share.version, 1)
        self.assertEqual(share.access_epoch, 1)
