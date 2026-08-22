from contextlib import nullcontext
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from apps.chat.conversation.models import ChatContext, ChatSession
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabdata.models_token import TableApiToken
from apps.tabtinspace.models import Organization, Space, SpaceMembership
from apps.tabtinspace.services import OrganizationService

User = get_user_model()


class OrganizationServiceDeleteCleanupTests(SimpleTestCase):
    @patch("apps.tabtinspace.services.organization_service.transaction.atomic")
    @patch("apps.tabtinspace.services.organization_service.transaction.on_commit")
    @patch("apps.tabtinspace.services.organization_service.OrganizationService.delete_organization_resources")
    def test_force_delete_organization_registers_default_db_cleanup_on_commit(
        self,
        mock_delete_organization_resources,
        mock_on_commit,
        mock_atomic,
    ):
        organization_id = uuid.uuid4()
        space_id = uuid.uuid4()
        organization = SimpleNamespace(id=organization_id)
        pruned_context = SimpleNamespace(
            recent_spaces=[str(space_id), "space-keep"],
            save=Mock(),
        )
        clean_context = SimpleNamespace(
            recent_spaces=["space-keep"],
            save=Mock(),
        )
        pruned_token = SimpleNamespace(
            space_ids=[str(space_id), "space-keep"],
            save=Mock(),
        )
        clean_token = SimpleNamespace(
            space_ids=["space-keep"],
            save=Mock(),
        )

        callbacks = []

        def _capture_on_commit(callback, using=None):
            callbacks.append((callback, using))

        mock_atomic.return_value = nullcontext()
        mock_on_commit.side_effect = _capture_on_commit

        with patch(
            "apps.services.billing.services.OrganizationLifecycleCleanupService.enqueue_cleanup"
        ) as mock_enqueue, patch(
            "apps.tabtinspace.models.Space.objects.filter"
        ) as mock_space_filter, patch(
            "apps.chat.conversation.models.ChatSession.objects.using"
        ) as mock_chat_session_using, patch(
            "apps.chat.conversation.models.ChatContext.objects.using"
        ) as mock_chat_context_using, patch(
            "apps.tabdata.models_token.TableApiToken.objects"
        ) as mock_token_objects, patch(
            "apps.tracker.models.Tracker.objects.filter"
        ) as mock_goal_filter, patch(
            "apps.tabtinspace.models.SpaceMembership.objects.filter"
        ) as mock_space_membership_filter, patch(
            "apps.tabtinspace.models.SpaceAppSettings.objects.filter"
        ) as mock_space_app_settings_filter, patch(
            "apps.tabtinspace.models.Collection.objects.filter"
        ) as mock_collection_filter, patch(
            "apps.tabtinspace.models.SpacePermission.objects.filter"
        ) as mock_space_permission_filter, patch(
            "apps.tabtinspace.models.OrganizationMember.objects.filter"
        ) as mock_organization_member_filter, patch(
            "apps.tabtinspace.models.OrganizationAppInstall.objects.filter"
        ) as mock_organization_app_install_filter, patch(
            "apps.tabtinspace.models.OrganizationInvitation.objects.filter"
        ) as mock_organization_invitation_filter, patch(
            "apps.tabtinspace.models.OrganizationControlPolicy.objects.filter"
        ) as mock_control_policy_filter, patch(
            "apps.tabtinspace.models.SecureCredential.objects.filter"
        ) as mock_secure_credential_filter, patch(
            "apps.tabtinspace.models.Agent.objects.filter"
        ) as mock_agent_filter, patch(
            "apps.tabtinspace.models.Device.objects.filter"
        ) as mock_device_filter, patch(
            "apps.tabtinspace.models.Organization.objects.filter"
        ) as mock_organization_filter:
            mock_space_filter.return_value.values_list.return_value = [space_id]
            mock_chat_context_using.return_value.exclude.return_value.exclude.return_value.only.return_value.iterator.return_value = [
                pruned_context,
                clean_context,
            ]
            mock_token_objects.exclude.return_value.exclude.return_value.only.return_value.iterator.return_value = [
                pruned_token,
                clean_token,
            ]

            OrganizationService.force_delete_organization(organization)

            mock_atomic.assert_called_once_with(using="default")
            mock_delete_organization_resources.assert_called_once_with(
                organization_id,
                [space_id],
            )
            mock_chat_session_using.return_value.filter.return_value.update.assert_called_once_with(
                space=None
            )
            mock_chat_context_using.return_value.filter.return_value.update.assert_called_once_with(
                current_space_id="",
            )
            self.assertEqual(pruned_context.recent_spaces, ["space-keep"])
            pruned_context.save.assert_called_once_with(update_fields=["recent_spaces", "updated_at"])
            clean_context.save.assert_not_called()
            mock_token_objects.filter.return_value.update.assert_called_once_with(
                space=None,
                is_active=False,
            )
            self.assertEqual(pruned_token.space_ids, ["space-keep"])
            pruned_token.save.assert_called_once_with(
                update_fields=["space_ids", "updated_at"],
                validate_scopes=False,
                validate_scope_targets=False,
                validate_delegation=False,
            )
            clean_token.save.assert_not_called()
            mock_goal_filter.return_value.delete.assert_called()
            mock_space_membership_filter.return_value.delete.assert_called_once()
            mock_space_app_settings_filter.return_value.delete.assert_called_once()
            mock_collection_filter.return_value.delete.assert_called_once()
            mock_space_permission_filter.return_value.delete.assert_called_once()
            mock_space_filter.return_value._raw_delete.assert_called_once_with(
                postgres_app_db_alias()
            )
            mock_organization_member_filter.return_value.delete.assert_called_once()
            mock_organization_app_install_filter.return_value.delete.assert_called_once()
            mock_organization_invitation_filter.return_value.delete.assert_called_once()
            mock_control_policy_filter.return_value.delete.assert_called_once()
            mock_secure_credential_filter.return_value.delete.assert_called_once()
            mock_agent_filter.return_value.delete.assert_called_once()
            mock_device_filter.return_value.delete.assert_called_once()
            #  墓碑管线：阶段 A 只兜底置墓碑，组织行保留到清理链末步。
            mock_organization_filter.return_value._raw_delete.assert_not_called()
            mock_organization_filter.return_value.exclude.return_value.update.assert_called_once()
            self.assertEqual(len(callbacks), 1)
            self.assertEqual(callbacks[0][1], postgres_app_db_alias())

            mock_enqueue.assert_not_called()
            callbacks[0][0]()
            mock_enqueue.assert_called_once_with(
                str(organization_id),
                trigger_source="organization_delete",
                run_inline=True,
                force=True,
            )

    @patch("apps.tabtinspace.services.organization_service.transaction.atomic")
    @patch("apps.tabtinspace.services.organization_service.transaction.on_commit")
    @patch("apps.tabtinspace.services.organization_service.OrganizationService.delete_organization_resources")
    def test_force_delete_organization_aborts_when_default_db_detach_fails(
        self,
        mock_delete_organization_resources,
        mock_on_commit,
        mock_atomic,
    ):
        organization_id = uuid.uuid4()
        space_id = uuid.uuid4()
        organization = SimpleNamespace(id=organization_id)

        mock_atomic.return_value = nullcontext()

        with patch(
            "apps.tabtinspace.models.Space.objects.filter"
        ) as mock_space_filter, patch(
            "apps.chat.conversation.models.ChatSession.objects.using"
        ) as mock_chat_session_using, patch(
            "apps.tracker.models.Tracker.objects.filter"
        ) as mock_goal_filter, patch(
            "apps.tabtinspace.models.Organization.objects.filter"
        ) as mock_organization_filter:
            mock_space_filter.return_value.values_list.return_value = [space_id]
            mock_chat_session_using.return_value.filter.return_value.update.side_effect = RuntimeError("detach failed")

            with self.assertRaisesRegex(RuntimeError, "detach failed"):
                OrganizationService.force_delete_organization(organization)

            mock_atomic.assert_called_once_with(using="default")
            mock_delete_organization_resources.assert_called_once_with(organization_id, [space_id])
            mock_goal_filter.return_value.delete.assert_called_once()
            mock_space_filter.return_value._raw_delete.assert_not_called()
            mock_organization_filter.return_value._raw_delete.assert_not_called()
            mock_on_commit.assert_not_called()


class OrganizationServiceCrossDatabaseDetachTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.db_manager("default").create_user(
            username="cleanup_owner",
            email="cleanup_owner@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Cleanup Team",
            owner_id=self.user.id,
            is_default=False,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            type="team",
            name="Cleanup Space",
            status="active",
        )
        self.other_space_id = str(uuid.uuid4())

    def test_detach_space_references_prunes_chat_context_and_token_scope(self):
        session = ChatSession.objects.db_manager("default").create(
            user=self.user,
            organization_id=str(self.organization.id),
            space_id=self.space.id,
            title="cleanup session",
        )
        context = ChatContext.objects.db_manager("default").create(
            session=session,
            current_space_id=str(self.space.id),
            recent_spaces=[str(self.space.id), self.other_space_id],
        )
        token = TableApiToken(
            name="cleanup-token",
            user_id=self.user.id,
            token_id="cleanup_t1",
            sign_hash="0" * 64,
            scopes=["record:read"],
            space_id=self.space.id,
            space_ids=[str(self.space.id), self.other_space_id],
            is_active=True,
            rate_limit=60,
        )
        token.save(
            force_insert=True,
            validate_scopes=False,
            validate_scope_targets=False,
            validate_delegation=False,
        )

        OrganizationService._detach_default_db_space_references([self.space.id])
        OrganizationService._detach_postgresql_space_references([self.space.id])

        session.refresh_from_db(using="default")
        context.refresh_from_db(using="default")
        token.refresh_from_db()

        self.assertIsNone(session.space_id)
        self.assertEqual(context.current_space_id, "")
        self.assertEqual(context.recent_spaces, [self.other_space_id])
        self.assertIsNone(token.space_id)
        self.assertEqual(token.space_ids, [self.other_space_id])


class OrganizationServiceForceDeleteE2ETests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.db_manager("default").create_user(
            username="e2e_owner",
            email="e2e_owner@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="E2E Delete Team",
            owner_id=self.user.id,
            is_default=False,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            type="team",
            name="E2E Space",
            status="active",
        )
        self.other_space_id = str(uuid.uuid4())

    @patch("apps.services.billing.services.OrganizationLifecycleCleanupService.enqueue_cleanup")
    @patch("apps.tabtinspace.services.organization_service.OrganizationService.delete_organization_resources")
    def test_force_delete_cleans_all_references(self, mock_delete_resources, mock_cleanup):
        space_id_str = str(self.space.id)

        session = ChatSession.objects.db_manager("default").create(
            user=self.user,
            organization_id=str(self.organization.id),
            space_id=self.space.id,
            title="e2e session",
        )
        context = ChatContext.objects.db_manager("default").create(
            session=session,
            current_space_id=space_id_str,
            recent_spaces=[space_id_str, self.other_space_id],
        )
        token = TableApiToken(
            name="e2e-token",
            user_id=self.user.id,
            token_id="e2e_t1",
            sign_hash="0" * 64,
            scopes=["record:read"],
            space_id=self.space.id,
            space_ids=[space_id_str, self.other_space_id],
            is_active=True,
            rate_limit=60,
        )
        token.save(
            force_insert=True,
            validate_scopes=False,
            validate_scope_targets=False,
            validate_delegation=False,
        )

        OrganizationService.force_delete_organization(self.organization)

        self.assertFalse(Space.objects.filter(id=self.space.id).exists())
        tombstone = Organization.objects.get(id=self.organization.id)
        self.assertEqual(tombstone.status, Organization.Status.DELETING)

        session.refresh_from_db(using="default")
        self.assertIsNone(session.space_id)

        context.refresh_from_db(using="default")
        self.assertEqual(context.current_space_id, "")
        self.assertNotIn(space_id_str, context.recent_spaces)
        self.assertIn(self.other_space_id, context.recent_spaces)

        token.refresh_from_db()
        self.assertIsNone(token.space_id)
        self.assertNotIn(space_id_str, token.space_ids)
        self.assertIn(self.other_space_id, token.space_ids)


class OrganizationTombstonePipelineE2ETests(TestCase):
    """#3832：删除后立即隐身，清理完成后再物理删除组织行。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = User.objects.db_manager("default").create_user(
            username="tombstone_owner",
            email="tombstone_owner@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Tombstone Team",
            owner_id=self.owner.id,
            type=Organization.OrganizationType.TEAM,
        )

    def _seed_lifecycle_rows(self):
        from decimal import Decimal

        from apps.services.billing.models import (
            BillingAdminAuditLog,
            BillingUsageEvent,
            OrganizationBillingPolicy,
        )
        from apps.tabtinspace.models import OrganizationMember
        from apps.users.wallet.models import OrganizationWallet, WalletTransaction

        organization_id = str(self.organization.id)
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        wallet = OrganizationWallet.objects.create(
            organization_id=organization_id,
            credits_precise=Decimal("10.0000"),
        )
        WalletTransaction.objects.create(
            organization_wallet=wallet,
            organization_id=organization_id,
            transaction_type="consume",
            amount=1,
            amount_precise=Decimal("1.0000"),
            balance_before=10,
            balance_before_precise=Decimal("10.0000"),
            balance_after=9,
            balance_after_precise=Decimal("9.0000"),
            description="tombstone e2e",
        )
        BillingUsageEvent.objects.create(
            organization_id=organization_id,
            user_id=str(self.owner.id),
            meter_key="llm.tokens",
            quantity=1,
            unit="tokens",
            unit_price=1,
            amount=1,
            currency="CREDITS",
        )
        OrganizationBillingPolicy.objects.create(organization_id=organization_id)
        return BillingAdminAuditLog.objects.create(
            admin_user_id=str(self.owner.id),
            action="tombstone_e2e",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
        )

    def test_tombstone_pipeline_end_to_end(self):
        from apps.services.billing.models import (
            BillingAdminAuditLog,
            OrganizationLifecycleCleanupJob,
        )
        from apps.tabtinspace.services.accessible_space_resolver import (
            AccessibleSpaceResolver,
        )
        from apps.tabtinspace.services.space_service import SpaceService
        from apps.tabtinspace.services.space_visibility import get_accessible_space_ids

        audit = self._seed_lifecycle_rows()
        organization_id = self.organization.id
        organization_id_str = str(organization_id)
        space = Space.objects.create(
            organization=self.organization,
            type=Space.SpaceType.WORKSPACE,
            name="Tombstone Space",
            status="active",
        )
        SpaceMembership.objects.create(
            workspace=space,
            user=self.owner,
            role="owner",
            is_active=True,
        )
        service = OrganizationService(user=self.owner)

        with self.captureOnCommitCallbacks(execute=False):
            self.assertTrue(service.delete_organization(organization_id))
        tombstone = Organization.objects.get(id=organization_id)
        self.assertEqual(tombstone.status, Organization.Status.DELETING)
        self.assertIsNotNone(tombstone.delete_requested_at)
        self.assertEqual(tombstone.delete_requested_by_id, str(self.owner.id))
        self.assertFalse(service.get_user_organizations().filter(id=organization_id).exists())
        self.assertFalse(service.check_organization_permission(organization_id_str, "viewer"))
        self.assertFalse(
            SpaceService(user=self.owner).check_space_permission(str(space.id), "viewer")
        )
        self.assertIsNone(SpaceService(user=self.owner).get_space(space.id))
        self.assertNotIn(
            space.id,
            get_accessible_space_ids(self.owner, organization_id=organization_id),
        )
        self.assertNotIn(space.id, get_accessible_space_ids(self.owner))
        self.assertEqual(
            AccessibleSpaceResolver(self.owner.id, organization_id).resolve(),
            set(),
        )

        with self.captureOnCommitCallbacks(execute=True):
            self.assertTrue(OrganizationService.purge_organization_by_id(organization_id_str))

        self.assertFalse(Organization.objects.filter(id=organization_id).exists())
        job = OrganizationLifecycleCleanupJob.objects.get(
            organization_id=organization_id_str,
        )
        self.assertEqual(job.status, "succeeded")
        self.assertEqual(job.last_success_summary.get("organization_row_finalized"), 1)
        self.assertTrue(BillingAdminAuditLog.objects.filter(id=audit.id).exists())
        self.assertFalse(OrganizationService.purge_organization_by_id(organization_id_str))

    def test_permanently_failed_cleanup_job_blocks_automatic_repurge(self):
        from apps.services.billing.models import OrganizationLifecycleCleanupJob
        from apps.services.billing.services import OrganizationLifecycleCleanupService

        organization_id_str = str(self.organization.id)
        self.organization.status = Organization.Status.DELETING
        self.organization.save(update_fields=["status", "updated_at"])
        job = OrganizationLifecycleCleanupJob.objects.create(
            organization_id=organization_id_str,
            trigger_source="organization_delete",
            status="permanently_failed",
            attempt_count=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
            max_attempts=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
            last_error="still broken",
        )

        with patch.object(
            OrganizationService,
            "force_delete_organization",
        ) as mock_force_delete:
            self.assertFalse(OrganizationService.purge_organization_by_id(organization_id_str))

        mock_force_delete.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.status, "permanently_failed")
        self.assertEqual(
            job.attempt_count,
            OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
        )
