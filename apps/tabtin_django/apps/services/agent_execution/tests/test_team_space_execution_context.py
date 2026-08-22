"""Project 协作场景自执行语义测试。

分层模型（principle/workspace-project.md）：协作场里的任务落到**发起人自己的
伴生 Workspace**，执行归属人 = 发起人本人（自己执行、自己审批），不再路由到
Owner。发起人在该 Project 尚未供给伴生 Workspace 时被拦截引导。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from apps.chat.conversation.api import _get_session_with_shared_access
from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.services.agent_engine.models import PendingInteraction
from apps.services.agent_engine.services.pending_interaction_service import (
    list_pending_interactions_for_thread,
    upsert_tool_approval_interaction,
)
from apps.services.agent_engine.services.agent_router import RoutingDecision
from apps.services.agent_execution.chat_service import ChatService
from apps.services.agent_execution.team_space_execution import (
    OWNER_EXECUTION_UNAVAILABLE_CATEGORY,
    resolve_chat_execution_context,
    resolve_owner_execution_availability,
)
from apps.tabtinspace.models import Device, Space, OrganizationMember
from apps.tabtinspace.services.access_service import SpaceAccessService
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.tests.fixtures import create_test_user, create_test_organization


class TeamSpaceExecutionWorkspaceSelectionTests(SimpleTestCase):
    @patch(
        "apps.services.agent_execution.team_space_execution."
        "_resolve_initiator_workspace",
        return_value=None,
    )
    def test_shared_project_never_borrows_session_owner_workspace(
        self,
        _resolve_workspace,
    ) -> None:
        project = SimpleNamespace(
            id="project-1",
            _meta=SimpleNamespace(model_name="project"),
        )
        owner_workspace = SimpleNamespace(id="owner-workspace")
        initiator = SimpleNamespace(id="member-1")
        session = SimpleNamespace(
            project=project,
            project_id="project-1",
            workspace=owner_workspace,
            workspace_id="owner-workspace",
        )

        context = resolve_chat_execution_context(
            session=session,
            initiator_user=initiator,
        )

        self.assertTrue(context.is_team_space)
        self.assertIsNone(context.execution_space)
        availability = resolve_owner_execution_availability(context)
        self.assertFalse(availability.available)
        self.assertEqual(availability.reason, "member_workspace_unset")


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class TeamSpaceExecutionContextTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.owner = create_test_user(prefix="ts-exec-owner", nickname="Owner User")
        self.invited = create_test_user(prefix="ts-exec-invited", nickname="Invited User")
        self.organization = create_test_organization(owner=self.owner, prefix="ts-exec")
        OrganizationMember.objects.create(
            organization=self.organization, user=self.invited, role="editor",
        )

        # Owner 的设备与 Workspace：先创建，Project 创建后再回填伴生关系。
        self.owner_device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint=f"ts-exec-owner-device-{self.owner.id}",
            status="online",
        )
        self.owner_workspace = SpaceService(user=self.owner).create_space(
            organization_id=self.organization.id,
            name="Owner Personal Space",
            device_id=self.owner_device.id,
            working_dir="/Users/owner/work/team-exec",
            working_dir_type="code",
        )

        # 发起人（invited）拥有自己的设备与 Workspace —— 执行落到这里。
        self.invited_device = Device.objects.create(
            organization=self.organization,
            user=self.invited,
            name="Invited Mac",
            device_type="electron",
            role="control",
            fingerprint=f"ts-exec-invited-device-{self.invited.id}",
            status="online",
        )
        self.invited_workspace = SpaceService(user=self.invited).create_space(
            organization_id=self.organization.id,
            name="Invited Personal Space",
            device_id=self.invited_device.id,
            working_dir="/Users/invited/work/team-exec",
            working_dir_type="code",
        )

        # Project 协作场景（execution_space_id 仅为历史占位，新解析器忽略）。
        self.team_space = SpaceService(user=self.owner).create_space(
            organization_id=self.organization.id,
            name="Team Room",
            space_type=Space.SpaceType.TEAM_SPACE,
            execution_space_id=self.owner_workspace.id,
        )
        SpaceAccessService(user=self.owner).add_space_membership(
            space_id=self.team_space.id,
            user_id=str(self.invited.id),
            role="editor",
        )
        # 测试中的两个 Workspace 分别作为两名成员在该 Project 下的伴生 Space。
        Space.objects.filter(id__in=[self.owner_workspace.id, self.invited_workspace.id]).update(
            project=self.team_space,
        )
        self.owner_workspace.refresh_from_db()
        self.invited_workspace.refresh_from_db()
        # session 属主为 owner；各测试的"发起人"身份都显式传入，不依赖 session.user，
        # 这样 invited 对该 session 属于共享访问（覆盖协作场共享语义）。
        self.session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            space=self.team_space,
            title="Shared Team Conversation",
        )

    def test_resolver_maps_team_room_to_initiator_workspace(self) -> None:
        ctx = resolve_chat_execution_context(
            session=self.session, initiator_user=self.invited,
        )

        self.assertTrue(ctx.is_team_space)
        self.assertEqual(ctx.collaboration_space_id, str(self.team_space.id))
        # 执行落到发起人自己的 Workspace，执行归属人 = 发起人。
        self.assertEqual(ctx.execution_space_id, str(self.invited_workspace.id))
        self.assertEqual(ctx.initiator_user_id, str(self.invited.id))
        self.assertEqual(ctx.execution_owner_user_id, str(self.invited.id))

    def test_resolver_recovers_project_from_companion_session(self) -> None:
        companion_session = ChatSession.objects.create(
            user=self.invited,
            organization_id=str(self.organization.id),
            space=self.invited_workspace,
            title="Mobile Project Task",
        )

        ctx = resolve_chat_execution_context(
            session=companion_session,
            initiator_user=self.invited,
        )

        self.assertTrue(ctx.is_team_space)
        self.assertEqual(ctx.collaboration_space_id, str(self.team_space.id))
        self.assertEqual(ctx.execution_space_id, str(self.invited_workspace.id))
        self.assertEqual(ctx.initiator_user_id, str(self.invited.id))

    def test_invited_member_can_access_team_space_session(self) -> None:
        session, is_shared = _get_session_with_shared_access(self.session.id, self.invited)

        self.assertTrue(is_shared)
        self.assertEqual(session.id, self.session.id)

    def test_chat_service_routes_companion_session_with_project_context(self) -> None:
        client_message_id = "11111111-1111-4111-8111-111111111111"
        companion_session = ChatSession.objects.create(
            user=self.invited,
            organization_id=str(self.organization.id),
            space=self.invited_workspace,
            title="Mobile Project Task",
        )
        prep = ChatService._PrepareResult(
            model_instance=None,
            model_fell_back=False,
            final_model_id=None,
            user_selected_model=False,
            resolved_agent_name="tin",
            effective_thread_id=str(companion_session.id),
            config={"configurable": {"thread_id": str(companion_session.id)}},
            ws_id="",
            uid=str(self.invited.id),
        )
        routing = RoutingDecision(
            target="external",
            handled=True,
            dispatch_result={"published": 1, "backend_type": "local", "task_id": "task-1"},
        )

        with patch.object(ChatService, "_stage_prepare", return_value=prep), \
            patch(
                "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
            ), \
            patch("apps.services.agent_execution.chat_service.spawn_title_thread"), \
            patch(
                "apps.services.agent_execution.chat_service._resolve_route",
                return_value=routing,
            ) as resolve_route, \
            patch(
                "apps.services.agent_execution.chat_service._handle_routing_decision",
                return_value={"message_id": "ok", "reply": ""},
            ):
            ChatService._process_message_sync_core(
                session=companion_session,
                user=self.invited,
                messages=["Please do the team task"],
                model_id=None,
                thread_id=str(companion_session.id),
                agent_name=None,
                blocks=None,
                attachments=None,
                client_type="electron",
                execution_profile=None,
                app_context=None,
                agent_mode=None,
                api_token_space_ids=None,
                client_message_id=client_message_id,
            )

        route_kwargs = resolve_route.call_args.kwargs
        # 执行现场 = 发起人自己的 Workspace。
        self.assertEqual(route_kwargs["space_id"], str(self.invited_workspace.id))
        self.assertEqual(
            route_kwargs["input_state"]["user_id"], str(self.invited.id),
        )
        self.assertEqual(
            route_kwargs["input_state"]["team_space_execution"]["initiator_user_id"],
            str(self.invited.id),
        )
        self.assertEqual(
            route_kwargs["execution_context"].execution_owner_user_id,
            str(self.invited.id),
        )

        user_message = ChatMessage.objects.get(session=companion_session, role="user")
        self.assertEqual(user_message.sender_user_id, str(self.invited.id))
        meta = user_message.metadata["team_space_execution"]
        self.assertEqual(meta["collaboration_space_id"], str(self.team_space.id))
        self.assertEqual(meta["execution_space_id"], str(self.invited_workspace.id))
        self.assertEqual(meta["initiator_user_id"], str(self.invited.id))
        self.assertEqual(meta["execution_owner_user_id"], str(self.invited.id))

    def test_member_without_workspace_is_blocked_before_queue(self) -> None:
        # 第三个成员：加入团队与协作场，但没有自己的 Workspace。
        stranger = create_test_user(prefix="ts-exec-stranger", nickname="No Workspace")
        OrganizationMember.objects.create(
            organization=self.organization, user=stranger, role="editor",
        )
        SpaceAccessService(user=self.owner).add_space_membership(
            space_id=self.team_space.id,
            user_id=str(stranger.id),
            role="editor",
        )

        with patch(
            "apps.services.agent_engine.services.message_queue_service.MessageQueueService.acquire_lock",
        ) as acquire_lock, patch.object(ChatService, "_stage_prepare") as stage_prepare:
            result = ChatService.send_message_sync(
                str(self.session.id),
                stranger,
                "Please execute without my own workspace",
                client_type="electron",
            )

        self.assertEqual(result["error_category"], OWNER_EXECUTION_UNAVAILABLE_CATEGORY)
        self.assertFalse(result["dispatched_external"])
        self.assertEqual(
            result["team_space_execution"]["reason"], "member_workspace_unset",
        )
        acquire_lock.assert_not_called()
        stage_prepare.assert_not_called()
        self.assertFalse(
            ChatMessage.objects.filter(
                session=self.session,
                role="user",
                text_summary="Please execute without my own workspace",
            ).exists()
        )

    def test_team_space_pending_approval_redacts_for_non_initiator(self) -> None:
        ctx = resolve_chat_execution_context(
            session=self.session, initiator_user=self.invited,
        )
        payload = {
            "batch_id": "22222222-2222-4222-8222-222222222222",
            "approval_type": "tool_permission",
            "action_requests": [
                {
                    "request_id": "33333333-3333-4333-8333-333333333333",
                    "tool_call_id": "tc-team",
                    "tool_name": "run_terminal_command",
                    "tool_input": {"command": "touch team.txt"},
                    "decision_reason": {"type": "user_interactive", "scope": "once"},
                    "allowed_scopes": ["once"],
                    "allowed_outcomes": ["allow", "deny"],
                    "risk_level": "medium",
                }
            ],
            "runtime_mode": "interactive",
            "expires_at": int((timezone.now().timestamp() + 120) * 1000),
            "schema_version": 1,
            "team_space_execution": ctx.to_message_metadata()["team_space_execution"],
        }

        interaction = upsert_tool_approval_interaction(
            thread_id=f"chat-session-{self.session.id}",
            payload=payload,
            source_device_fingerprint="invited-electron",
        )

        self.assertIsNotNone(interaction)
        # 执行归属人 = 发起人（invited），审批归属发起人。
        self.assertEqual(str(interaction.user_id), str(self.invited.id))
        self.assertEqual(PendingInteraction.objects.count(), 1)
        thread_id = f"chat-session-{self.session.id}"
        initiator_items = list_pending_interactions_for_thread(str(self.invited.id), thread_id)
        other_items = list_pending_interactions_for_thread(str(self.owner.id), thread_id)
        self.assertEqual(len(initiator_items), 1)
        self.assertEqual(len(other_items), 1)
        # 发起人看到完整详情。
        self.assertEqual(
            initiator_items[0]["payload"]["action_requests"][0]["tool_input"]["command"],
            "touch team.txt",
        )
        # 非发起人成员看到脱敏详情。
        self.assertEqual(
            other_items[0]["payload"]["team_space_execution"]["execution_owner_user_id"],
            str(self.invited.id),
        )
        self.assertEqual(
            other_items[0]["payload"]["team_space_execution"]["initiator_user_id"],
            str(self.invited.id),
        )
        self.assertTrue(other_items[0]["payload"]["details_redacted"])
        self.assertNotIn(
            "tool_input", other_items[0]["payload"]["action_requests"][0],
        )
