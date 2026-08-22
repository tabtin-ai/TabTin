"""新用户默认 Space onboarding 回归测试。"""
from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import SimpleTestCase, TestCase

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.management.commands.fix_organization_integrity import Command
from apps.tabtinspace.models import Agent, Device, Space, SpaceMembership, Workspace, Organization, OrganizationMember
from apps.tabtinspace.services.access_service import SpaceAccessService
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.services.organization_service import (
    DEFAULT_ONBOARDING_AGENT_NAME,
    DEFAULT_ONBOARDING_SPACE_NAME,
    DEFAULT_ONBOARDING_SPACE_DESCRIPTION,
    OrganizationService,
)


class OrganizationSettingDefaultsTests(SimpleTestCase):
    def test_personal_organization_enables_member_yolo_by_default(self) -> None:
        settings = OrganizationService._build_personal_organization_settings()

        self.assertTrue(settings["allow_member_yolo"])

    def test_team_organization_enables_member_yolo_by_default(self) -> None:
        settings = OrganizationService._with_default_organization_settings({})

        self.assertTrue(settings["allow_member_yolo"])

    def test_explicit_member_yolo_setting_overrides_default(self) -> None:
        personal_settings = OrganizationService._build_personal_organization_settings(
            {"allow_member_yolo": False},
        )
        team_settings = OrganizationService._with_default_organization_settings(
            {"allow_member_yolo": False},
        )

        self.assertFalse(personal_settings["allow_member_yolo"])
        self.assertFalse(team_settings["allow_member_yolo"])


class WorkspaceApprovalDefaultsTests(SimpleTestCase):
    def test_new_workspace_defaults_to_full_access(self) -> None:
        field = Workspace._meta.get_field("approval_grant")

        self.assertEqual(field.get_default(), Workspace.ApprovalGrant.FULL_ACCESS)


class DefaultSpaceOnboardingTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        from apps.users.auth.signals import create_user_profile

        cls._create_user_profile_signal = create_user_profile
        post_save.disconnect(receiver=create_user_profile, sender=get_user_model())

    @classmethod
    def tearDownClass(cls) -> None:
        post_save.connect(receiver=cls._create_user_profile_signal, sender=get_user_model())
        super().tearDownClass()

    @patch(
        "apps.tabtinspace.services.app_catalog_service."
        "OrganizationAppCatalogService.auto_install_core_apps"
    )
    @patch.object(OrganizationService, "provision_builtin_extensions")
    @patch.object(OrganizationService, "provision_billing")
    def test_new_user_registration_creates_agent_without_unbound_space(
        self,
        _mock_provision_billing,
        _mock_provision_builtin_extensions,
        _mock_auto_install_core_apps,
    ) -> None:
        User = get_user_model()
        user = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"default-agent-onboarding-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="New User",
            is_active=True,
        )

        organization = Organization.objects.get(
            owner_id=user.id,
            type=Organization.OrganizationType.PERSONAL,
        )
        bot_agent = Agent.objects.get(
            organization=organization,
            owner_user=user,
            type="bot",
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            is_active=True,
        )
        self.assertTrue(bot_agent.is_default)
        self.assertFalse(
            Space.objects.filter(
                organization=organization,
                type=Space.SpaceType.WORKSPACE,
            ).exists()
        )

        spaces, total = SpaceService(user=user).list_spaces(
            organization_id=organization.id,
            space_type=Space.SpaceType.WORKSPACE,
            is_archived=False,
        )
        self.assertEqual(total, 0)
        self.assertEqual(spaces, [])

        visible_bot_agent_ids = set(
            SpaceAccessService(user=user)
            .list_organization_agents(organization.id)
            .filter(type="bot")
            .values_list("id", flat=True)
        )
        self.assertEqual(visible_bot_agent_ids, {bot_agent.id})

    def test_integrity_fix_repairs_owner_without_creating_unbound_space(self) -> None:
        User = get_user_model()
        from apps.tabtinspace.signals import create_default_organization

        post_save.disconnect(receiver=create_default_organization, sender=User)
        try:
            owner = User.objects.db_manager(postgres_app_db_alias()).create_user(
                email=f"integrity-default-agent-{uuid4().hex[:8]}@tabtin.test",
                password="TabtinTest#2026",
                nickname="Owner",
                is_active=True,
            )
        finally:
            post_save.connect(receiver=create_default_organization, sender=User)

        organization = Organization.objects.create(
            name="Needs Default Agent",
            owner=owner,
            type=Organization.OrganizationType.PERSONAL,
            is_default=True,
            settings={"is_default": True, "auto_created": True},
        )

        fixed_member, fixed_space, _fixed_counts = Command()._check_and_fix(
            organization,
            dry_run=False,
        )

        self.assertEqual(fixed_member, 1)
        self.assertEqual(fixed_space, 0)
        self.assertTrue(
            OrganizationMember.objects.filter(
                organization=organization,
                user_id=owner.id,
                role="owner",
            ).exists()
        )
        self.assertFalse(Space.objects.filter(organization=organization).exists())

    @patch(
        "apps.tabtinspace.services.app_catalog_service."
        "OrganizationAppCatalogService.auto_install_core_apps"
    )
    @patch.object(OrganizationService, "provision_builtin_extensions")
    @patch.object(OrganizationService, "provision_billing")
    def test_create_organization_initializes_default_space_execution_fields(
        self,
        _mock_provision_billing,
        _mock_provision_builtin_extensions,
        _mock_auto_install_core_apps,
    ) -> None:
        User = get_user_model()
        owner = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"default-space-execution-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Owner",
            is_active=True,
        )
        device_team = Organization.objects.get(
            owner_id=owner.id,
            type=Organization.OrganizationType.PERSONAL,
        )
        device = Device.objects.create(
            organization=device_team,
            user=owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint=f"electron-{uuid4()}",
        )

        organization = OrganizationService(user=owner).create_organization(
            name="Fresh Team",
            default_agent_device_fingerprint=device.fingerprint,
            default_agent_working_dir="/Users/me/TabTin/Fresh Team/默认 Space",
            default_agent_working_dir_type="mixed",
            enforce_owner_limit=False,
        )

        bot_agent = Agent.objects.get(
            organization=organization,
            owner_user=owner,
            type="bot",
            name=DEFAULT_ONBOARDING_AGENT_NAME,
        )
        bot_space = Space.objects.get(organization=organization, agent=bot_agent, is_default=True)
        workspace = Workspace.objects.get(id=bot_space.id)

        self.assertEqual(workspace.device_id, device.id)
        self.assertEqual(workspace.kind, Workspace.Kind.HOME)
        self.assertEqual(workspace.working_dir, "/Users/me/TabTin/Fresh Team/默认 Space")
        self.assertEqual(workspace.working_dir_type, "mixed")
        self.assertEqual(bot_space.control_device_id, device.id)
        self.assertEqual(bot_space.bound_device_id, device.id)
        self.assertEqual(bot_space.name, DEFAULT_ONBOARDING_SPACE_NAME)
        self.assertEqual(bot_space.working_dir, "/Users/me/TabTin/Fresh Team/默认 Space")
        self.assertEqual(bot_space.normalized_working_dir, "/Users/me/TabTin/Fresh Team/默认 Space")
        self.assertEqual(bot_space.working_dir_type, "mixed")

    @patch(
        "apps.tabtinspace.services.app_catalog_service."
        "OrganizationAppCatalogService.auto_install_core_apps"
    )
    @patch.object(OrganizationService, "provision_builtin_extensions")
    @patch.object(OrganizationService, "provision_billing")
    def test_create_organization_home_is_isolated_from_another_organization(
        self,
        _mock_provision_billing,
        _mock_provision_builtin_extensions,
        _mock_auto_install_core_apps,
    ) -> None:
        """设备已有其他组织 HOME 时，新组织仍应拥有自己的 HOME。"""
        User = get_user_model()
        owner = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"second-org-home-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Owner",
            is_active=True,
        )
        personal = Organization.objects.get(
            owner_id=owner.id,
            type=Organization.OrganizationType.PERSONAL,
        )
        device = Device.objects.create(
            organization=personal,
            user=owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint=f"electron-{uuid4()}",
        )
        Workspace.objects.create(
            organization=personal,
            device=device,
            name="Home",
            working_dir="/Users/me/TabTin/Home",
            normalized_working_dir="/Users/me/TabTin/Home",
            working_dir_type="mixed",
            created_by=owner,
            kind=Workspace.Kind.HOME,
            trust_status=Workspace.TrustStatus.TRUSTED,
            trust_source=Workspace.TrustSource.SYSTEM_PROVISIONED,
        )

        organization = OrganizationService(user=owner).create_organization(
            name="Second Team",
            default_agent_device_fingerprint=device.fingerprint,
            default_agent_working_dir="/Users/me/TabTin/Second Team/默认 Space",
            default_agent_working_dir_type="mixed",
            enforce_owner_limit=False,
        )

        workspace = Workspace.objects.get(organization=organization)
        self.assertEqual(workspace.kind, Workspace.Kind.HOME)
        self.assertEqual(workspace.device_id, device.id)
        self.assertEqual(
            Workspace.objects.filter(device=device, kind=Workspace.Kind.HOME).count(),
            2,
        )

    @patch(
        "apps.tabtinspace.services.app_catalog_service."
        "OrganizationAppCatalogService.auto_install_core_apps"
    )
    @patch.object(OrganizationService, "provision_builtin_extensions")
    @patch.object(OrganizationService, "provision_billing")
    def test_create_second_organization_on_same_device_gets_its_own_home(
        self,
        _mock_provision_billing,
        _mock_provision_builtin_extensions,
        _mock_auto_install_core_apps,
    ) -> None:
        """主场按组织和用户隔离：同设备上的每个组织各有一个 HOME。"""
        User = get_user_model()
        owner = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"second-org-same-device-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Owner",
            is_active=True,
        )
        personal = Organization.objects.get(
            owner_id=owner.id,
            type=Organization.OrganizationType.PERSONAL,
        )
        device = Device.objects.create(
            organization=personal,
            user=owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint=f"electron-{uuid4()}",
        )
        service = OrganizationService(user=owner)

        first = service.create_organization(
            name="First Team",
            default_agent_device_fingerprint=device.fingerprint,
            default_agent_working_dir="/Users/me/TabTin/First Team/默认 Workspace",
            default_agent_working_dir_type="mixed",
            enforce_owner_limit=False,
        )
        second = service.create_organization(
            name="Second Team",
            default_agent_device_fingerprint=device.fingerprint,
            default_agent_working_dir="/Users/me/TabTin/Second Team/默认 Workspace",
            default_agent_working_dir_type="mixed",
            enforce_owner_limit=False,
        )

        first_ws = Workspace.objects.get(organization=first)
        second_ws = Workspace.objects.get(organization=second)
        self.assertEqual(first_ws.kind, Workspace.Kind.HOME)
        self.assertEqual(second_ws.kind, Workspace.Kind.HOME)
        self.assertEqual(
            Workspace.objects.filter(device=device, kind=Workspace.Kind.HOME).count(),
            2,
        )

    def test_owner_empty_organization_list_spaces_does_not_create_unbound_space(self) -> None:
        User = get_user_model()
        owner = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"owner-empty-space-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Owner",
            is_active=True,
        )
        organization = Organization.objects.create(
            name="Owner Empty Team",
            owner=owner,
            type=Organization.OrganizationType.TEAM,
            is_default=False,
        )

        spaces, total = SpaceService(user=owner).list_spaces(
            organization_id=organization.id,
            space_type=Space.SpaceType.WORKSPACE,
            is_archived=False,
        )

        self.assertEqual(total, 0)
        self.assertEqual(spaces, [])
        self.assertFalse(Space.objects.filter(organization=organization).exists())

    def test_editor_empty_organization_list_spaces_does_not_create_unbound_space(self) -> None:
        User = get_user_model()
        owner = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"editor-empty-owner-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Owner",
            is_active=True,
        )
        member = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"editor-empty-member-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Member",
            is_active=True,
        )
        organization = Organization.objects.create(
            name="Invited Empty Team",
            owner=owner,
            type=Organization.OrganizationType.TEAM,
            is_default=False,
        )
        OrganizationMember.objects.create(organization=organization, user=owner, role="owner")
        OrganizationMember.objects.create(organization=organization, user=member, role="editor")

        spaces, total = SpaceService(user=member).list_spaces(
            organization_id=organization.id,
            space_type=Space.SpaceType.WORKSPACE,
            is_archived=False,
        )

        self.assertEqual(total, 0)
        self.assertEqual(spaces, [])
        self.assertFalse(Space.objects.filter(organization=organization).exists())

    def test_owner_empty_organization_repeated_list_stays_empty(self) -> None:
        User = get_user_model()
        owner = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"owner-empty-idempotent-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Owner",
            is_active=True,
        )
        organization = Organization.objects.create(
            name="Owner Empty Idempotent Team",
            owner=owner,
            type=Organization.OrganizationType.TEAM,
            is_default=False,
        )

        service = SpaceService(user=owner)
        first_spaces, first_total = service.list_spaces(
            organization_id=organization.id,
            space_type=Space.SpaceType.WORKSPACE,
            is_archived=False,
        )
        second_spaces, second_total = service.list_spaces(
            organization_id=organization.id,
            space_type=Space.SpaceType.WORKSPACE,
            is_archived=False,
        )

        self.assertEqual(first_total, 0)
        self.assertEqual(second_total, 0)
        self.assertEqual(first_spaces, [])
        self.assertEqual(second_spaces, [])
        self.assertEqual(
            Space.objects.filter(
                organization=organization,
                type=Space.SpaceType.WORKSPACE,
                is_archived=False,
            ).count(),
            0,
        )
        self.assertEqual(
            Agent.objects.filter(
                organization=organization,
                owner_user=owner,
                type="bot",
                name=DEFAULT_ONBOARDING_AGENT_NAME,
            ).count(),
            0,
        )

    def test_viewer_empty_organization_list_spaces_stays_empty(self) -> None:
        User = get_user_model()
        owner = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"viewer-empty-owner-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Owner",
            is_active=True,
        )
        viewer = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"viewer-empty-member-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Viewer",
            is_active=True,
        )
        organization = Organization.objects.create(
            name="Viewer Empty Team",
            owner=owner,
            type=Organization.OrganizationType.TEAM,
            is_default=False,
        )
        OrganizationMember.objects.create(organization=organization, user=owner, role="owner")
        OrganizationMember.objects.create(organization=organization, user=viewer, role="viewer")

        spaces, total = SpaceService(user=viewer).list_spaces(
            organization_id=organization.id,
            space_type=Space.SpaceType.WORKSPACE,
            is_archived=False,
        )

        self.assertEqual(total, 0)
        self.assertEqual(spaces, [])
        self.assertFalse(
            Space.objects.filter(
                organization=organization,
                type=Space.SpaceType.WORKSPACE,
                is_archived=False,
            ).exists()
        )

    def test_api_key_organization_constraint_blocks_default_space_backfill(self) -> None:
        from apps.users.auth.api_key_context import set_api_key_organization_constraint

        User = get_user_model()
        owner = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"apikey-empty-owner-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Owner",
            is_active=True,
        )
        member = User.objects.db_manager(postgres_app_db_alias()).create_user(
            email=f"apikey-empty-member-{uuid4().hex[:8]}@tabtin.test",
            password="TabtinTest#2026",
            nickname="Member",
            is_active=True,
        )
        allowed_organization = Organization.objects.create(
            name="API Key Allowed Team",
            owner=owner,
            type=Organization.OrganizationType.TEAM,
            is_default=False,
        )
        blocked_organization = Organization.objects.create(
            name="API Key Blocked Team",
            owner=owner,
            type=Organization.OrganizationType.TEAM,
            is_default=False,
        )
        OrganizationMember.objects.create(organization=allowed_organization, user=member, role="editor")
        OrganizationMember.objects.create(organization=blocked_organization, user=member, role="editor")

        set_api_key_organization_constraint(str(allowed_organization.id))
        try:
            spaces, total = SpaceService(user=member).list_spaces(
                organization_id=blocked_organization.id,
                space_type=Space.SpaceType.WORKSPACE,
                is_archived=False,
            )
        finally:
            set_api_key_organization_constraint("")

        self.assertEqual(total, 0)
        self.assertEqual(spaces, [])
        self.assertFalse(
            Space.objects.filter(
                organization=blocked_organization,
                type=Space.SpaceType.WORKSPACE,
                is_archived=False,
            ).exists()
        )

        from apps.tabtinspace.services.membership_utils import ensure_user_membership

        bot_agent = Agent.objects.create(
            organization=blocked_organization,
            owner_user=member,
            name=DEFAULT_ONBOARDING_AGENT_NAME,
            type="bot",
            is_active=True,
        )
        blocked_space = Space.objects.create(
            organization=blocked_organization,
            agent=bot_agent,
            type=Space.SpaceType.WORKSPACE,
            name=DEFAULT_ONBOARDING_SPACE_NAME,
            status="active",
            is_default=True,
            is_archived=False,
        )
        ensure_user_membership(blocked_space, member.id, "owner")

        set_api_key_organization_constraint(str(allowed_organization.id))
        try:
            spaces, total = SpaceService(user=member).list_spaces(
                organization_id=blocked_organization.id,
                space_type=Space.SpaceType.WORKSPACE,
                is_archived=False,
            )
        finally:
            set_api_key_organization_constraint("")

        self.assertEqual(total, 0)
        self.assertEqual(spaces, [])
