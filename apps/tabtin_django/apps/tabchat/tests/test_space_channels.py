import os
import sys


def _ensure_django():
    django_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir)
    )
    if django_root not in sys.path:
        sys.path.insert(0, django_root)
    if "DJANGO_SETTINGS_MODULE" not in os.environ:
        os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"
    import django
    from django.apps import apps
    if not apps.ready:
        django.setup()


_ensure_django()

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase, override_settings

from apps.tabchat.constants import IMEventType
from apps.tabchat.api import archive_space_channel, rename_space_channel
from apps.tabchat.models import Conversation, ConversationMember, IMEventOutbox
from apps.tabchat.schemas import UpdateConversationRequest
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import Organization, OrganizationMember, Project, ProjectMembership
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.services.space_visibility import SpaceVisibility
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _make_project(organization, name="Team Room", visibility="private"):
    from apps.tabtinspace.models import Project
    return Project.objects.create(
        organization=organization,
        name=name,
        status=Project.Status.ACTIVE,
        visibility=visibility,
    )


def _pm(project, user, role="owner"):
    from apps.tabtinspace.models import ProjectMembership
    return ProjectMembership.objects.create(
        project=project,
        user=user,
        role=role,
        is_active=True,
        status=ProjectMembership.Status.ACTIVE,
    )


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "space channel tests bootstrap",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class TeamSpaceChannelTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username="space_channel_owner",
            email="space_channel_owner@test.com",
            password="pass123",
            nickname="Owner",
        )
        self.member = User.objects.create_user(
            username="space_channel_member",
            email="space_channel_member@test.com",
            password="pass123",
            nickname="Member",
        )
        self.organization = Organization.objects.create(
            name="Space Channel Team",
            owner=self.owner,
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.member, role="editor")

    def _create_team_space(self, name: str = "Launch Room"):
        with self.captureOnCommitCallbacks(
            using=postgres_app_db_alias(),
            execute=True,
        ):
            team_space = _make_project(self.organization, name=name, visibility=SpaceVisibility.PRIVATE)
            _pm(team_space, self.owner, role="owner")
            ConversationService.ensure_default_team_space_channels(
                team_space,
                creator_id=str(self.owner.id),
            )
        self.assertIsNotNone(team_space)
        return team_space

    def _active_channel_names(self, team_space) -> set[str]:
        return set(
            Conversation.objects.filter(
                organization_id=str(self.organization.id),
                space_id=team_space.id,
                is_archived=False,
            ).values_list("name", flat=True)
        )

    def test_new_team_space_gets_default_channels_without_broadening_access(self):
        team_space = self._create_team_space()
        team_space.refresh_from_db()

        self.assertEqual(team_space.visibility, SpaceVisibility.PRIVATE)
        self.assertEqual(
            self._active_channel_names(team_space),
            {"#general", "#agent-updates"},
        )

        owner_list = ConversationService.list_conversations(
            str(self.organization.id),
            str(self.owner.id),
        )
        self.assertEqual({item["name"] for item in owner_list}, {"#general", "#agent-updates"})
        self.assertTrue(all(item["is_team_space_channel"] for item in owner_list))
        self.assertEqual({item["space_name"] for item in owner_list}, {team_space.name})

        member_list = ConversationService.list_conversations(
            str(self.organization.id),
            str(self.member.id),
        )
        self.assertEqual(member_list, [])

    def test_ensure_default_channels_backfills_existing_team_space_idempotently(self):
        team_space = _make_project(self.organization, name="Existing Project", visibility=SpaceVisibility.PRIVATE)
        _pm(team_space, self.owner, role="owner")
        _pm(team_space, self.member, role="editor")
        self.assertEqual(self._active_channel_names(team_space), set())

        ConversationService.ensure_default_team_space_channels(
            team_space,
            creator_id=str(self.owner.id),
        )
        ConversationService.ensure_default_team_space_channels(
            team_space,
            creator_id=str(self.owner.id),
        )

        self.assertEqual(
            self._active_channel_names(team_space),
            {"#general", "#agent-updates"},
        )
        self.assertEqual(
            Conversation.objects.filter(space_id=team_space.id, is_archived=False).count(),
            2,
        )
        general = Conversation.objects.get(space_id=team_space.id, name="#general")
        self.assertEqual(general.member_count, 2)
        self.assertFalse(
            ConversationMember.objects.filter(conversation=general, agent_id__isnull=False).exists()
        )

    def test_team_space_channel_detail_has_no_implicit_execution_agent(self):
        team_space = _make_project(self.organization, name="Legacy Execution Project", visibility=SpaceVisibility.PRIVATE)
        _pm(team_space, self.owner, role="owner")
        ConversationService.ensure_default_team_space_channels(
            team_space,
            creator_id=str(self.owner.id),
        )
        general = Conversation.objects.get(space_id=team_space.id, name="#general")

        detail = ConversationService.get_conversation_detail(str(general.id), str(self.owner.id))

        agent_members = [m for m in detail["members"] if m["member_type"] == "agent"]
        self.assertEqual(agent_members, [])
        self.assertEqual(general.member_count, 1)

    def test_ensure_default_channels_repairs_missing_project_member(self):
        team_space = _make_project(self.organization, name="Repair Project Member", visibility=SpaceVisibility.PRIVATE)
        _pm(team_space, self.owner, role="owner")
        ConversationService.ensure_default_team_space_channels(
            team_space,
            creator_id=str(self.owner.id),
        )
        general = Conversation.objects.get(space_id=team_space.id, name="#general")
        ConversationMember.objects.filter(
            conversation=general,
            user_id=str(self.owner.id),
        ).delete()
        Conversation.objects.filter(id=general.id).update(member_count=0)

        ConversationService.ensure_default_team_space_channels(
            team_space,
            creator_id=str(self.owner.id),
        )

        general.refresh_from_db()
        self.assertEqual(general.member_count, 1)
        self.assertTrue(
            ConversationMember.objects.filter(
                conversation=general,
                user_id=str(self.owner.id),
            ).exists()
        )

    def test_non_space_member_cannot_create_or_list_space_channels(self):
        team_space = self._create_team_space()

        with self.assertRaises(PermissionError):
            ConversationService.create_space_channel(
                organization_id=str(self.organization.id),
                space_id=str(team_space.id),
                creator_id=str(self.member.id),
                name="Planning",
            )

        self.assertEqual(
            ConversationService.list_conversations(str(self.organization.id), str(self.member.id)),
            [],
        )

    def test_space_member_can_create_channel_visible_to_space_members(self):
        team_space = self._create_team_space()
        _pm(team_space, self.member, role="editor")

        channel = ConversationService.create_space_channel(
            organization_id=str(self.organization.id),
            space_id=str(team_space.id),
            creator_id=str(self.member.id),
            name="Planning Notes",
        )

        self.assertEqual(channel.name, "#Planning-Notes")
        self.assertEqual(str(channel.space_id), str(team_space.id))
        self.assertEqual(channel.member_count, 2)
        self.assertEqual(
            set(
                ConversationMember.objects
                .filter(conversation=channel)
                .filter(user_id__isnull=False)
                .values_list("user_id", flat=True)
            ),
            {str(self.owner.id), str(self.member.id)},
        )
        self.assertFalse(
            ConversationMember.objects
            .filter(conversation=channel, agent_id__isnull=False)
            .exists()
        )
        member_list = ConversationService.list_conversations(
            str(self.organization.id),
            str(self.member.id),
        )
        channel_summary = next(item for item in member_list if item["id"] == str(channel.id))
        self.assertTrue(channel_summary["is_team_space_channel"])
        self.assertEqual(channel_summary["space_id"], str(team_space.id))
        self.assertEqual(channel_summary["space_name"], team_space.name)
        channel_detail = ConversationService.get_conversation_detail(
            str(channel.id),
            str(self.member.id),
        )
        self.assertIsNotNone(channel_detail)
        self.assertTrue(channel_detail["is_team_space_channel"])
        self.assertEqual(channel_detail["space_name"], team_space.name)

    def test_team_space_regular_channel_message_only_updates_unread_quietly(self):
        team_space = self._create_team_space()
        _pm(team_space, self.member, role="editor")
        channel = Conversation.objects.get(space_id=team_space.id, name="#general")
        message = MessageService.send_message(
            str(channel.id),
            str(self.owner.id),
            "普通频道同步，不需要桌面横幅",
        )
        event = IMEventOutbox.objects.get(
            message=message,
            event_type=IMEventType.UNREAD_UPDATE,
        )
        self.assertEqual(event.target_channels, [f"personal:{self.member.id}"])
        self.assertFalse(event.payload["data"]["mention"])
        self.assertEqual(event.payload["data"]["conversation_id"], str(channel.id))
        self.assertEqual(event.payload["data"]["organization_id"], str(self.organization.id))

    def test_team_space_human_mention_keeps_high_priority_mention_event(self):
        team_space = self._create_team_space()
        _pm(team_space, self.member, role="editor")
        channel = Conversation.objects.get(space_id=team_space.id, name="#general")
        message = MessageService.send_message(
            str(channel.id),
            str(self.owner.id),
            "@Member 需要你看一下",
            metadata={"mentioned_user_ids": [str(self.member.id)]},
        )
        events = IMEventOutbox.objects.filter(
            message=message,
            event_type=IMEventType.UNREAD_UPDATE,
        )
        self.assertEqual(events.count(), 1)
        event = events.get()
        self.assertEqual(event.target_channels, [f"personal:{self.member.id}"])
        self.assertTrue(event.payload["data"]["mention"])
        self.assertEqual(event.payload["data"]["conversation_id"], str(channel.id))
        self.assertEqual(event.payload["data"]["organization_id"], str(self.organization.id))

    def test_regular_group_message_still_carries_preview_for_desktop_notification(self):
        group = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.owner.id),
            name="普通项目群",
            member_ids=[str(self.member.id)],
        )
        message = MessageService.send_message(
            str(group.id),
            str(self.owner.id),
            "普通群聊仍然需要通知预览",
        )
        event = IMEventOutbox.objects.get(
            message=message,
            event_type=IMEventType.UNREAD_UPDATE,
        )
        self.assertEqual(event.target_channels, [f"personal:{self.member.id}"])
        self.assertEqual(event.payload["data"]["conversation_id"], str(group.id))
        self.assertEqual(event.payload["data"]["organization_id"], str(self.organization.id))
        self.assertEqual(event.payload["data"]["sender_id"], str(self.owner.id))
        self.assertIn("preview", event.payload["data"])

    def test_agent_updates_summary_carries_preview_for_strong_notification(self):
        team_space = self._create_team_space()
        _pm(team_space, self.member, role="editor")
        channel = Conversation.objects.get(space_id=team_space.id, name="#agent-updates")
        message = MessageService.send_message(
            str(channel.id),
            str(self.owner.id),
            "Agent 任务已完成：上线复盘",
            metadata={"team_space_agent_update": True, "session_id": "sess-1"},
        )
        event = IMEventOutbox.objects.get(
            message=message,
            event_type=IMEventType.UNREAD_UPDATE,
        )
        self.assertEqual(event.target_channels, [f"personal:{self.member.id}"])
        self.assertIn("preview", event.payload["data"])

    def test_channel_lifecycle_records_activity_events(self):
        from apps.tabtinspace.models import SpaceActivityEvent

        team_space = self._create_team_space()
        with self.captureOnCommitCallbacks(using=postgres_app_db_alias(), execute=True):
            channel = ConversationService.create_space_channel(
                organization_id=str(self.organization.id),
                space_id=str(team_space.id),
                creator_id=str(self.owner.id),
                name="release-notes",
            )
            ConversationService.rename_space_channel(
                str(team_space.id),
                str(channel.id),
                str(self.owner.id),
                "release-updates",
            )
            ConversationService.archive_space_channel(
                str(team_space.id),
                str(channel.id),
                str(self.owner.id),
            )

        events = list(
            SpaceActivityEvent.objects.filter(space_id=team_space.id)
            .order_by("created_at")
            .values_list("event_type", flat=True)
        )
        self.assertIn(SpaceActivityEvent.EventType.CHANNEL_CREATED, events)
        self.assertIn(SpaceActivityEvent.EventType.CHANNEL_RENAMED, events)
        self.assertIn(SpaceActivityEvent.EventType.CHANNEL_ARCHIVED, events)

    def test_owner_can_rename_and_archive_channel_without_hard_delete(self):
        team_space = self._create_team_space()
        _pm(team_space, self.member, role="editor")
        channel = ConversationService.create_space_channel(
            organization_id=str(self.organization.id),
            space_id=str(team_space.id),
            creator_id=str(self.member.id),
            name="triage",
        )

        with self.assertRaises(PermissionError):
            ConversationService.rename_space_channel(
                str(team_space.id),
                str(channel.id),
                str(self.member.id),
                "member rename",
            )
        with self.assertRaises(PermissionError):
            ConversationService.archive_space_channel(
                str(team_space.id),
                str(channel.id),
                str(self.member.id),
            )

        renamed = ConversationService.rename_space_channel(
            str(team_space.id),
            str(channel.id),
            str(self.owner.id),
            "release triage",
        )
        self.assertIsNotNone(renamed)
        self.assertEqual(renamed.name, "#release-triage")

        self.assertTrue(
            ConversationService.archive_space_channel(
                str(team_space.id),
                str(channel.id),
                str(self.owner.id),
            )
        )
        channel.refresh_from_db()
        self.assertTrue(channel.is_archived)
        self.assertEqual(channel.archived_by, str(self.owner.id))

        active_ids = {
            item["id"]
            for item in ConversationService.list_conversations(
                str(self.organization.id),
                str(self.member.id),
            )
        }
        self.assertNotIn(str(channel.id), active_ids)
        self.assertIsNotNone(
            ConversationService.get_conversation_detail(str(channel.id), str(self.member.id))
        )

    def test_rename_and_archive_validate_path_space_before_writing(self):
        team_space = self._create_team_space("Launch Room")
        other_space = self._create_team_space("Other Room")
        channel = ConversationService.create_space_channel(
            organization_id=str(self.organization.id),
            space_id=str(team_space.id),
            creator_id=str(self.owner.id),
            name="triage",
        )

        renamed = ConversationService.rename_space_channel(
            str(other_space.id),
            str(channel.id),
            str(self.owner.id),
            "wrong path",
        )
        self.assertIsNone(renamed)
        channel.refresh_from_db()
        self.assertEqual(channel.name, "#triage")

        archived = ConversationService.archive_space_channel(
            str(other_space.id),
            str(channel.id),
            str(self.owner.id),
        )
        self.assertFalse(archived)
        channel.refresh_from_db()
        self.assertFalse(channel.is_archived)

    def test_api_rename_and_archive_path_mismatch_has_no_side_effect(self):
        team_space = self._create_team_space("Launch Room")
        other_space = self._create_team_space("Other Room")
        channel = ConversationService.create_space_channel(
            organization_id=str(self.organization.id),
            space_id=str(team_space.id),
            creator_id=str(self.owner.id),
            name="triage",
        )

        rename_request = self.factory.patch("/api/im/test")
        rename_request.auth = self.owner
        rename_response = rename_space_channel(
            rename_request,
            str(other_space.id),
            str(channel.id),
            UpdateConversationRequest(name="wrong path"),
        )
        self.assertEqual(rename_response.code, 404)
        channel.refresh_from_db()
        self.assertEqual(channel.name, "#triage")

        archive_request = self.factory.post("/api/im/test")
        archive_request.auth = self.owner
        archive_response = archive_space_channel(
            archive_request,
            str(other_space.id),
            str(channel.id),
        )
        self.assertEqual(archive_response.code, 404)
        channel.refresh_from_db()
        self.assertFalse(channel.is_archived)
