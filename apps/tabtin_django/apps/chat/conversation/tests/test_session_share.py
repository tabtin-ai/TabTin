"""共享 Agent 任务（ 文档协同式）后端核心域测试。

覆盖：
- 每张共享卡的 SessionShare 独立授权与精确恢复；
- 非 owner 建 share / 跨 org grantee / 共享给自己 → 拒绝；
- 主鉴权第三分支：grantee 经 get_session / get_messages 读**全量**消息
  （含 thinking / tool_use 块——组织内全量透明）；revoked / 陌生人拒；
  ``user_can_access_session`` 对 grantee 为 True、revoked 为 False；
- 写端点仍拒 grantee：改标题 / 删会话（owner 过滤）+ 通用 fork
  （include_session_share=False）；
- shared-fork：无 can_fork 位 403、agent / workspace 归属校验、快照带
  工具行 / 附件行（不再打码）、forked_session_id 回填最新、重复 fork 各建新副本；
- shared-chat：无 can_chat 403 / revoked 403 / 陌生人 403；can_chat 放行时
  以 owner 身份进 ChatService（app_context 带 _shared_chat_by）+ chatted 审计；
- ``resolve_sender_attribution``：发言归属 override 的单元语义。
"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import MagicMock, patch
from urllib.parse import quote

from django.contrib.auth import get_user_model
from django.test import RequestFactory, SimpleTestCase, TestCase
from django.utils import timezone

from apps.chat.conversation.api._common import user_can_access_session
from apps.chat.conversation.api.fork import fork_session
from apps.chat.conversation.api.message import get_messages
from apps.chat.conversation.api.session import (
    delete_session,
    get_session,
    update_session,
)
from apps.chat.conversation.api.session_share import (
    shared_chat,
    shared_execution_status,
    shared_fork,
)
from apps.chat.conversation.models import (
    ChatMessage,
    ChatSession,
    SessionContinuation,
    SessionShare,
    SessionShareEvent,
    SessionShareResourceGrant,
    SessionWorkspaceFileReference,
)
from apps.chat.conversation.tasks import sync_session_share_resource_grants
from apps.chat.conversation.schemas import (
    ForkSessionRequest,
    SharedChatRequest,
    SharedForkRequest,
    UpdateSessionRequest,
)
from apps.chat.conversation.services import (
    session_continuation_service,
    session_share_card_service,
    session_share_service,
)
from apps.chat.conversation.services.session_share_service import (
    SessionShareAccessError,
)
from apps.agent.models import Agent
from apps.services.agent_engine.models import ExecutionRun, SessionRunProjection
from apps.tabdata.models import Table, TablePermission
from apps.tabdoc.models import Document, DocumentPermission
from apps.services.oss.models import FileRecord
from apps.tabtinspace.models import (
    Device,
    FilePermission,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)

User = get_user_model()

_CHAT_SERVICE_PATH = (
    "apps.services.agent_execution.chat_service.ChatService.send_message_sync"
)


def _make_workspace(organization, user, name: str, fingerprint: str) -> Workspace:
    device = Device.objects.create(
        organization=organization,
        user=user,
        name=f"{name} Device",
        device_type="electron",
        role="control",
        fingerprint=fingerprint,
        status="online",
    )
    workspace = Workspace.objects.create(
        organization=organization,
        device=device,
        created_by=user,
        name=name,
        working_dir=f"/tmp/{fingerprint}",
        normalized_working_dir=f"/tmp/{fingerprint}",
        kind=Workspace.Kind.STANDARD,
    )
    SpaceMembership.objects.create(
        workspace=workspace, user=user, role="owner", is_active=True,
    )
    return workspace


class SessionShareTestCase(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username="share_owner",
            email="share_owner@test.com",
            password="pass123",
        )
        self.grantee = User.objects.create_user(
            username="share_grantee",
            email="share_grantee@test.com",
            password="pass123",
        )
        self.stranger = User.objects.create_user(
            username="share_stranger",
            email="share_stranger@test.com",
            password="pass123",
        )
        self.outsider = User.objects.create_user(
            username="share_outsider",
            email="share_outsider@test.com",
            password="pass123",
        )

        self.organization = Organization.objects.create(
            name="Share Org", owner=self.owner,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.grantee, role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.stranger, role="viewer",
        )
        self.other_org = Organization.objects.create(
            name="Other Org", owner=self.outsider,
        )
        OrganizationMember.objects.create(
            organization=self.other_org, user=self.outsider, role="owner",
        )

        self.owner_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="Owner Agent",
        )
        self.grantee_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.grantee,
            name="Grantee Agent",
            settings={"default_mode": "agent"},
        )
        self.owner_workspace = _make_workspace(
            self.organization, self.owner, "Owner WS", "share-owner-ws",
        )
        self.grantee_workspace = _make_workspace(
            self.organization, self.grantee, "Grantee WS", "share-grantee-ws",
        )

        self.session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            agent=self.owner_agent,
            workspace=self.owner_workspace,
            title="数据管道排查",
        )
        base_time = timezone.now() - timedelta(hours=1)

        def _msg(role, blocks, *, minute, **extra):
            msg = ChatMessage.objects.create(
                session=self.session,
                role=role,
                content_blocks_json=blocks,
                text_summary="\n".join(
                    b.get("text", "") for b in blocks if b.get("type") == "text"
                )[:200],
                **extra,
            )
            ChatMessage.objects.filter(id=msg.id).update(
                created_at=base_time + timedelta(minutes=minute),
            )
            msg.refresh_from_db()
            return msg

        self.msg_user = _msg(
            "user",
            [{
                "type": "text",
                "text": "帮我看下 /Users/developer/dev/TabTin/apps/tabtin_django/settings.py 的配置",
            }],
            minute=0,
            sender_user_id=str(self.owner.id),
        )
        self.msg_assistant = _msg(
            "assistant",
            [
                {"type": "thinking", "thinking": "机密推理 secret-plan"},
                {"type": "text", "text": "配置在 /home/deploy/app/.env 里，我看过了"},
                {
                    "type": "tool_use",
                    "id": "tu_1",
                    "name": "read_file",
                    "input": {"path": "/Users/developer/secret"},
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "tu_1",
                    "content": "SECRET_TOKEN=abc",
                },
            ],
            minute=1,
            usage_json={"input_tokens": 10, "output_tokens": 5},
            error_info_json={"error_class": "FakeError", "error_message": "boom"},
        )
        self.msg_user_file = _msg(
            "user",
            [
                {"type": "text", "text": "这是数据样本，请分析"},
                {
                    "type": "file",
                    "file_id": "file-123",
                    "filename": "data.csv",
                    "size": 2048,
                },
            ],
            minute=2,
            sender_user_id=str(self.owner.id),
        )
        # 以下三条不在主时间线 llm 口径内（fork 快照 / 主时间线均排除）
        self.msg_subagent = _msg(
            "assistant",
            [{"type": "text", "text": "子Agent输出不应出现"}],
            minute=3,
            subagent_run_id="sub-1",
        )
        self.msg_artifact = _msg(
            "assistant",
            [{"type": "text", "text": "产物气泡不应出现"}],
            minute=4,
            message_kind="tool_artifact",
        )
        self.msg_env = _msg(
            "user",
            [{"type": "text", "text": "environment 快照不应出现"}],
            minute=5,
            message_kind="environment_context",
        )

    # ── helpers ──────────────────────────────────────────────────────

    def _create_share(self, *, can_fork=False, can_chat=False) -> SessionShare:
        return session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            can_fork=can_fork,
            can_chat=can_chat,
            status="active",
        )

    def test_share_defaults_to_active_for_legacy_callers(self):
        share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
        )

        self.assertEqual(SessionShare._meta.get_field("status").default, "active")
        self.assertEqual(share.status, "active")

    def test_v2_share_stays_inactive_until_recipient_joins(self):
        share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            can_chat=True,
            card_contract="session_share_v2",
        )

        self.assertEqual(share.status, "pending")
        self.assertEqual(share.delivery_status, "pending")
        self.assertIsNone(session_share_service.get_active_share(
            session_id=str(self.session.id),
            user=self.grantee,
        ))

        confirmed = session_share_service.confirm_share_delivery(
            share=share,
            conversation_id="conversation-1",
            message_ref="019fcaa1-3333-7333-8333-333333333333",
            message_sequence=42,
        )

        self.assertEqual(confirmed.status, "pending")
        self.assertEqual(confirmed.delivery_status, "confirmed")
        self.assertEqual(confirmed.version, 2)
        detail = session_share_card_service.get_share_detail(
            viewer_user=self.grantee,
            share_id=str(share.id),
        )
        self.assertEqual(detail["phase"], "awaitingJoin")
        self.assertTrue(detail["actions"]["can_join"])
        self.assertIsNone(detail["session_id"])
        self.assertIsNone(session_share_service.get_active_share(
            session_id=str(self.session.id),
            user=self.grantee,
        ))
        with self.assertRaises(session_share_service.SessionShareAccessError):
            session_share_card_service.accept_and_refresh_card(
                actor_user=self.owner,
                share_id=str(share.id),
            )

        with patch(
            "apps.chat.conversation.services.session_collaboration_events.send_collaboration_state_changed",
        ) as publish_changed:
            joined = session_share_card_service.accept_and_refresh_card(
                actor_user=self.grantee,
                share_id=str(share.id),
            )

        publish_changed.assert_called_once()
        self.assertEqual(publish_changed.call_args.args[0].id, share.id)
        self.assertEqual(publish_changed.call_args.kwargs, {"revoked": False})

        self.assertEqual(joined["phase"], "activeCollaborate")
        self.assertEqual(joined["version"], 3)
        self.assertFalse(joined["actions"]["can_join"])
        self.assertEqual(
            session_share_service.get_active_share(
                session_id=str(self.session.id),
                user=self.grantee,
            ).id,
            share.id,
        )

    def test_v2_detail_projects_unconfirmed_delivery_without_granting_access(self):
        share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            card_contract="session_share_v2",
        )
        share = session_share_service.set_share_delivery_status(share, "unconfirmed")

        item = session_share_card_service.batch_get_share_details(
            object_ids=[str(share.id)],
            viewer_user=self.grantee,
        )[0]

        self.assertEqual(item["detail"]["phase"], "deliveryUnconfirmed")
        self.assertFalse(item["detail"]["actions"]["can_open"])

    def test_v2_detail_projects_latest_state_onto_older_cards(self):
        older = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            can_chat=True,
            card_contract="session_share_v2",
            status="active",
        )
        latest = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            card_contract="session_share_v2",
            status="active",
        )
        SessionShare.objects.filter(id__in=[older.id, latest.id]).update(
            delivery_status="confirmed",
        )
        session_share_service.revoke_share(
            share_id=str(latest.id),
            actor_user=self.owner,
        )

        items = session_share_card_service.batch_get_share_details(
            object_ids=[str(older.id), str(latest.id)],
            viewer_user=self.grantee,
        )

        self.assertEqual([item["detail"]["phase"] for item in items], ["stopped", "stopped"])
        self.assertEqual([item["detail"]["status"] for item in items], ["revoked", "revoked"])
        self.assertEqual(
            [item["detail"]["object_id"] for item in items],
            [str(older.id), str(latest.id)],
        )

    def test_v2_detail_includes_last_live_snapshot_without_new_state_table(self):
        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[{"type": "text", "text": "纯文本回复"}],
            text_summary="纯文本回复",
        )
        share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            card_contract="session_share_v2",
            status="active",
        )
        share.delivery_status = "confirmed"
        share.save(update_fields=["delivery_status"])

        detail = session_share_card_service.get_share_detail(
            viewer_user=self.grantee,
            share_id=str(share.id),
        )

        self.assertIsNone(detail["live"]["run_state"])
        self.assertEqual(detail["live"]["step_count"], 2)
        self.assertEqual(detail["live"]["recent_steps"][0]["title"], "read_file")
        self.assertEqual(detail["live"]["recent_steps"][0]["status"], "done")

    def test_v2_detail_keeps_task_dialogue_count_when_a_new_run_starts(self):
        now = timezone.now()
        run = ExecutionRun.objects.create(
            run_id=uuid.uuid4(),
            thread_id=f"chat-session-{self.session.id}",
            graph_type="chat",
            session_id=str(self.session.id),
            organization_id=str(self.organization.id),
            user_id=str(self.owner.id),
            status=ExecutionRun.Status.RUNNING,
            sequence=1,
            revision=1,
            started_at=now,
            state_changed_at=now,
        )
        SessionRunProjection.objects.create(
            session=self.session,
            current_run=run,
            sequence=1,
            revision=1,
            status=ExecutionRun.Status.RUNNING,
            started_at=now,
            state_changed_at=now,
        )
        share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            card_contract="session_share_v2",
            status="active",
        )
        share.delivery_status = "confirmed"
        share.save(update_fields=["delivery_status"])

        detail = session_share_card_service.get_share_detail(
            viewer_user=self.grantee,
            share_id=str(share.id),
        )

        self.assertEqual(detail["live"]["step_count"], 1)

    def test_v2_fork_tier_survives_join_and_allows_shared_fork(self):
        share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            can_fork=True,
            card_contract="session_share_v2",
        )
        share = session_share_service.confirm_share_delivery(
            share=share,
            conversation_id="conversation-fork",
            message_ref="019fcaa1-3333-7333-8333-444444444444",
            message_sequence=43,
        )

        joined = session_share_card_service.accept_and_refresh_card(
            actor_user=self.grantee,
            share_id=str(share.id),
        )

        self.assertEqual(joined["access_mode"], "fork")
        self.assertTrue(joined["can_fork"])
        self.assertFalse(joined["can_chat"])

    @patch.object(
        session_continuation_service,
        "send_user_business_projection",
        return_value={"seq": 99},
    )
    @patch.object(
        session_continuation_service,
        "resolve_direct_conversation",
        return_value="conversation-1",
    )
    @patch.object(
        session_continuation_service,
        "refresh_user_business_projection",
        return_value={},
    )
    def test_continuation_preserves_existing_live_shares(
        self,
        _refresh_projection,
        _resolve_conversation,
        send_projection,
    ):
        legacy_share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            can_fork=True,
            card_contract="session_share",
            status="active",
        )
        current_share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            can_chat=True,
            card_contract="session_share_v2",
            status="active",
        )
        self.assertTrue(
            user_can_access_session(
                str(self.session.id),
                self.grantee,
                session_share_id=str(current_share.id),
            )
        )

        with patch(
            "apps.chat.conversation.services.session_collaboration_events.send_collaboration_state_changed"
        ) as send_collaboration_state_changed:
            session_continuation_service.create_and_send(
                sender_user=self.owner,
                source_session_id=str(self.session.id),
                recipient_user_id=str(self.grantee.id),
                client_request_id="019fcaa1-4343-7434-8434-434343434343",
            )
            session_continuation_service.create_and_send(
                sender_user=self.owner,
                source_session_id=str(self.session.id),
                recipient_user_id=str(self.grantee.id),
                client_request_id="019fcaa1-4343-7434-8434-434343434343",
            )

        legacy_share.refresh_from_db()
        current_share.refresh_from_db()
        self.assertEqual(legacy_share.status, "active")
        self.assertEqual(current_share.status, "active")
        send_projection.assert_called_once()
        send_collaboration_state_changed.assert_not_called()
        self.assertTrue(
            user_can_access_session(
                str(self.session.id),
                self.grantee,
                session_share_id=str(current_share.id),
            )
        )

    @patch.object(
        session_continuation_service,
        "send_user_business_projection",
        return_value={"seq": 99},
    )
    @patch.object(
        session_continuation_service,
        "resolve_direct_conversation",
        return_value="conversation-1",
    )
    @patch.object(
        session_continuation_service,
        "refresh_user_business_projection",
        return_value={},
    )
    def test_continuation_freezes_context_and_materializes_once(
        self,
        refresh_projection,
        _resolve_conversation,
        _send_projection,
    ):
        detail = session_continuation_service.create_and_send(
            sender_user=self.owner,
            source_session_id=str(self.session.id),
            recipient_user_id=str(self.grantee.id),
            client_request_id="019fcaa1-4444-7444-8444-444444444444",
        )
        continuation = SessionContinuation.objects.get(id=detail["object_id"])
        frozen = list(continuation.frozen_context_json)

        ChatMessage.objects.create(
            session=self.session,
            role="user",
            content_blocks_json=[{"type": "text", "text": "发送卡片后的编辑"}],
        )
        request_id = "019fcaa1-5555-7555-8555-555555555555"
        first = session_continuation_service.create_task(
            continuation_id=str(continuation.id),
            recipient_user=self.grantee,
            agent_id=str(self.grantee_agent.id),
            workspace_id=str(self.grantee_workspace.id),
            client_request_id=request_id,
        )
        replay = session_continuation_service.create_task(
            continuation_id=str(continuation.id),
            recipient_user=self.grantee,
            agent_id=str(self.grantee_agent.id),
            workspace_id=str(self.grantee_workspace.id),
            client_request_id=request_id,
        )

        continuation.refresh_from_db()
        self.assertEqual(continuation.frozen_context_json, frozen)
        self.assertNotIn("发送卡片后的编辑", json.dumps(frozen, ensure_ascii=False))
        self.assertEqual(first["linked_session_id"], replay["linked_session_id"])
        refresh_projection.assert_called_once()
        refreshed_card = refresh_projection.call_args.kwargs["metadata"]["card"]
        self.assertEqual(refreshed_card["object_id"], str(continuation.id))
        self.assertEqual(refreshed_card["version"], continuation.version)

    @patch.object(
        session_continuation_service,
        "send_user_business_projection",
        return_value={"seq": 99},
    )
    @patch.object(
        session_continuation_service,
        "resolve_direct_conversation",
        return_value="conversation-1",
    )
    def test_continuation_create_failure_refreshes_card_status(
        self,
        _resolve_conversation,
        _send_projection,
    ):
        detail = session_continuation_service.create_and_send(
            sender_user=self.owner,
            source_session_id=str(self.session.id),
            recipient_user_id=str(self.grantee.id),
            client_request_id="019fcaa1-6666-7666-8666-666666666666",
        )

        with (
            patch.object(
                session_continuation_service,
                "materialize_session_from_turns",
                side_effect=RuntimeError("materialize failed"),
            ),
            patch.object(session_continuation_service, "_refresh_card") as refresh_card,
            self.assertRaises(RuntimeError),
        ):
            session_continuation_service.create_task(
                continuation_id=detail["object_id"],
                recipient_user=self.grantee,
                agent_id=str(self.grantee_agent.id),
                workspace_id=str(self.grantee_workspace.id),
                client_request_id="019fcaa1-7777-7777-8777-777777777777",
            )

        continuation = SessionContinuation.objects.get(id=detail["object_id"])
        self.assertEqual(continuation.creation_status, "failed")
        self.assertEqual(continuation.last_error_code, "MATERIALIZE_FAILED")
        refresh_card.assert_called_once_with(continuation)

    @patch.object(
        session_continuation_service,
        "send_user_business_projection",
        return_value={"seq": 99},
    )
    @patch.object(
        session_continuation_service,
        "resolve_direct_conversation",
        return_value="conversation-1",
    )
    def test_continuation_hands_off_material_refs_and_access(
        self,
        _resolve_conversation,
        _send_projection,
    ):
        uploaded_local_file_id = None

        def _dispatch_file_action(**kwargs):
            action = kwargs.get("action")
            params = kwargs.get("params") or {}
            if action == "fs.materialize_file_ref" and params.get("phase") == "probe":
                return {
                    "success": True,
                    "data": {
                        "content_version": "sha256:local-file-v1",
                        "size_bytes": 2048,
                        "mime_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    },
                }
            if action == "fs.materialize_file_ref" and params.get("phase") == "upload":
                return {
                    "success": True,
                    "data": {
                        "content_version": "sha256:local-file-v1",
                        "size_bytes": 2048,
                        "mime_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    },
                }
            if action == "fs.restore_file_from_url":
                return {
                    "success": True,
                    "data": {
                        "relative_path": params.get("target_relative_path"),
                        "size_bytes": params.get("expected_size_bytes"),
                    },
                }
            return {"success": False, "error": "unexpected action"}

        def _register_uploaded_local_file(**kwargs):
            nonlocal uploaded_local_file_id
            record = FileRecord.objects.create(
                file_name=kwargs["file_name"],
                file_key=kwargs["object_key"],
                file_path="session-continuation",
                file_size=kwargs["file_size"],
                file_type="document",
                mime_type=kwargs["content_type"],
                file_extension="pptx",
                file_hash="continuation-local-file-handoff",
                bucket_name="test-bucket",
                organization_id=str(self.organization.id),
                status="completed",
                upload_user=str(self.owner.id),
            )
            uploaded_local_file_id = record.id
            return record

        fake_oss = MagicMock()
        fake_oss.generate_presigned_url.return_value = "https://oss.example.test/signed"
        table = Table.objects.create(
            organization_id=self.organization.id,
            owner_id=self.owner.id,
            name="金价原始数据",
        )
        document = Document.objects.create(
            organization_id=self.organization.id,
            owner_id=self.owner.id,
            title="金价分析文档",
        )
        file_record = FileRecord.objects.create(
            file_name="成都7天旅游攻略.pptx",
            file_key=f"tests/{self.session.id}/成都7天旅游攻略.pptx",
            file_path="tests/成都7天旅游攻略.pptx",
            file_size=1024,
            file_type="document",
            mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            file_extension="pptx",
            file_hash="continuation-file-handoff",
            bucket_name="test-bucket",
            organization_id=str(self.organization.id),
            status="completed",
            upload_user=str(self.owner.id),
        )
        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[{
                "kind": "resource_ref",
                "payload": {
                    "resource_type": "table",
                    "resource_id": str(table.id),
                },
                "type": "tabtin_rich_content",
            }, {
                "kind": "resource_ref",
                "payload": {
                    "resource_type": "document",
                    "resource_id": str(document.id),
                },
                "type": "tabtin_rich_content",
            }, {
                "kind": "file",
                "payload": {
                    "artifact_kind": "oss_file",
                    "file_id": str(file_record.id),
                    "filename": "成都7天旅游攻略.pptx",
                },
                "type": "tabtin_rich_content",
            }, {
                "kind": "file",
                "payload": {
                    "artifact_kind": "local_file",
                    "filename": "成都7天旅游攻略.pptx",
                    "relative_path": "artifacts/成都7天旅游攻略.pptx",
                },
                "type": "tabtin_rich_content",
            }],
        )

        with (
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "DeviceRuntimeQueryService.dispatch_owner_workspace_fs_action",
                side_effect=_dispatch_file_action,
            ) as dispatch_file_action,
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "get_oss_service",
                return_value=fake_oss,
            ),
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "FileRegistryService.register_uploaded_file",
                side_effect=_register_uploaded_local_file,
            ),
        ):
            detail = session_continuation_service.create_and_send(
                sender_user=self.owner,
                source_session_id=str(self.session.id),
                recipient_user_id=str(self.grantee.id),
                client_request_id="019fcaa1-8888-7888-8888-888888888888",
            )

            self.assertEqual(detail["resource_status"], "unavailable")
            self.assertEqual(
                {resource["kind"] for resource in detail["resources"]},
                {"tabdata", "tabdoc", "tabfiles", "local_file"},
            )
            created = session_continuation_service.create_task(
                continuation_id=detail["object_id"],
                recipient_user=self.grantee,
                agent_id=str(self.grantee_agent.id),
                workspace_id=str(self.grantee_workspace.id),
                client_request_id="019fcaa1-9999-7999-8999-999999999999",
            )
            actions = [call.kwargs["action"] for call in dispatch_file_action.call_args_list]
            self.assertEqual(
                actions,
                [
                    "fs.materialize_file_ref",
                    "fs.materialize_file_ref",
                    "fs.restore_file_from_url",
                ],
            )
        self.assertEqual(created["resource_status"], "complete")
        new_session = ChatSession.objects.get(id=created["linked_session_id"])

        self.assertTrue(TablePermission.objects.filter(
            table=table,
            subject_type="user",
            subject_id=str(self.grantee.id),
            permission="viewer",
            is_active=True,
        ).exists())
        self.assertTrue(DocumentPermission.objects.filter(
            document=document,
            subject_type="user",
            subject_id=str(self.grantee.id),
            permission="viewer",
            is_active=True,
        ).exists())
        self.assertTrue(FilePermission.objects.filter(
            file_record_id=file_record.id,
            subject_type="user",
            subject_id=str(self.grantee.id),
            permission="viewer",
            is_active=True,
        ).exists())
        self.assertTrue(FilePermission.objects.filter(
            file_record_id=uploaded_local_file_id,
            subject_type="user",
            subject_id=str(self.grantee.id),
            permission="viewer",
            is_active=True,
        ).exists())
        briefing = new_session.messages.get(metadata__share_briefing=True)
        briefing_text = next(
            (
                block.get("text")
                for block in briefing.content_blocks_json
                if isinstance(block, dict) and block.get("text")
            ),
            briefing.text_summary,
        )
        self.assertIn("金价原始数据", briefing_text)
        self.assertIn("金价分析文档", briefing_text)
        self.assertIn("成都7天旅游攻略.pptx", briefing_text)
        self.assertIn(f"tabtin://resource/table/{table.id}", briefing_text)
        self.assertIn(f"tabtin://resource/document/{document.id}", briefing_text)
        self.assertIn(f"tabtin://resource/file/{file_record.id}", briefing_text)
        self.assertNotIn("tabtin://resource/tabdata/", briefing_text)
        self.assertNotIn("tabtin://resource/tabdoc/", briefing_text)
        self.assertNotIn("tabtin://resource/tabfiles/", briefing_text)
        self.assertNotIn("tabtin://resource/local_file/", briefing_text)
        snapshot_blocks = [
            block
            for message in new_session.messages.filter(metadata__share_snapshot=True)
            for block in message.content_blocks_json
        ]
        self.assertTrue(any(
            block.get("kind") == "resource_ref"
            and (block.get("payload") or {}).get("resource_id") == str(table.id)
            for block in snapshot_blocks
        ))
        local_payloads = [
            block.get("payload") or {}
            for block in snapshot_blocks
            if block.get("kind") == "file"
            and (block.get("payload") or {}).get("artifact_kind") == "local_file"
        ]
        self.assertEqual(len(local_payloads), 1)
        restored_path = local_payloads[0]["relative_path"]
        self.assertTrue(restored_path.startswith("artifacts/continuations/"))
        self.assertIn(
            f"tabtin://resource/file/{quote(restored_path, safe='')}",
            briefing_text,
        )
        self.assertEqual(str(local_payloads[0]["handoff_file_id"]), str(uploaded_local_file_id))
        self.assertTrue(SessionWorkspaceFileReference.objects.filter(
            session=new_session,
            relative_path=restored_path,
            is_active=True,
        ).exists())

    @patch.object(
        session_continuation_service,
        "send_user_business_projection",
        return_value={"seq": 99},
    )
    @patch.object(
        session_continuation_service,
        "resolve_direct_conversation",
        return_value="conversation-1",
    )
    def test_continuation_local_files_with_same_basename_restore_to_distinct_paths(
        self,
        _resolve_conversation,
        _send_projection,
    ):
        uploaded_local_file_ids = []

        def _dispatch_file_action(**kwargs):
            action = kwargs.get("action")
            params = kwargs.get("params") or {}
            if action == "fs.materialize_file_ref" and params.get("phase") == "probe":
                return {
                    "success": True,
                    "data": {
                        "content_version": "sha256:same-basename",
                        "size_bytes": 128,
                        "mime_type": "text/plain",
                    },
                }
            if action == "fs.materialize_file_ref" and params.get("phase") == "upload":
                return {
                    "success": True,
                    "data": {
                        "content_version": "sha256:same-basename",
                        "size_bytes": 128,
                        "mime_type": "text/plain",
                    },
                }
            if action == "fs.restore_file_from_url":
                return {
                    "success": True,
                    "data": {
                        "relative_path": params.get("target_relative_path"),
                        "size_bytes": params.get("expected_size_bytes"),
                    },
                }
            return {"success": False, "error": "unexpected action"}

        def _register_uploaded_local_file(**kwargs):
            record = FileRecord.objects.create(
                file_name=kwargs["file_name"],
                file_key=kwargs["object_key"],
                file_path="session-continuation",
                file_size=kwargs["file_size"],
                file_type="document",
                mime_type=kwargs["content_type"],
                file_extension="txt",
                file_hash="continuation-local-file-same-basename",
                bucket_name="test-bucket",
                organization_id=str(self.organization.id),
                status="completed",
                upload_user=str(self.owner.id),
                upload_source="session_continuation",
            )
            uploaded_local_file_ids.append(record.id)
            return record

        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[{
                "kind": "file",
                "payload": {
                    "artifact_kind": "local_file",
                    "filename": "report.txt",
                    "relative_path": "artifacts/a/report.txt",
                },
                "type": "tabtin_rich_content",
            }, {
                "kind": "file",
                "payload": {
                    "artifact_kind": "local_file",
                    "filename": "report.txt",
                    "relative_path": "artifacts/b/report.txt",
                },
                "type": "tabtin_rich_content",
            }],
        )
        fake_oss = MagicMock()
        fake_oss.generate_presigned_url.return_value = "https://oss.example.test/signed"

        with (
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "DeviceRuntimeQueryService.dispatch_owner_workspace_fs_action",
                side_effect=_dispatch_file_action,
            ),
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "get_oss_service",
                return_value=fake_oss,
            ),
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "FileRegistryService.register_uploaded_file",
                side_effect=_register_uploaded_local_file,
            ),
        ):
            detail = session_continuation_service.create_and_send(
                sender_user=self.owner,
                source_session_id=str(self.session.id),
                recipient_user_id=str(self.grantee.id),
                client_request_id="019fcaa1-cccc-7ccc-8ccc-cccccccccccc",
            )
            created = session_continuation_service.create_task(
                continuation_id=detail["object_id"],
                recipient_user=self.grantee,
                agent_id=str(self.grantee_agent.id),
                workspace_id=str(self.grantee_workspace.id),
                client_request_id="019fcaa1-cddd-7ddd-8ddd-dddddddddddd",
            )

        local_resources = [
            resource for resource in detail["resources"]
            if resource.get("kind") == "local_file"
        ]
        self.assertEqual(len(local_resources), 2)
        target_paths = {resource["target_relative_path"] for resource in local_resources}
        self.assertEqual(len(target_paths), 2)
        self.assertTrue(all(path.endswith("-report.txt") for path in target_paths))

        new_session = ChatSession.objects.get(id=created["linked_session_id"])
        local_payloads = [
            block.get("payload") or {}
            for message in new_session.messages.filter(metadata__share_snapshot=True)
            for block in message.content_blocks_json
            if block.get("kind") == "file"
            and (block.get("payload") or {}).get("artifact_kind") == "local_file"
        ]
        self.assertEqual(
            {payload["relative_path"] for payload in local_payloads},
            target_paths,
        )
        self.assertEqual(
            {str(payload["handoff_file_id"]) for payload in local_payloads},
            {str(file_id) for file_id in uploaded_local_file_ids},
        )

    @patch.object(
        session_continuation_service,
        "send_user_business_projection",
        return_value={"seq": 99},
    )
    @patch.object(
        session_continuation_service,
        "resolve_direct_conversation",
        return_value="conversation-1",
    )
    def test_continuation_local_file_upload_failure_cleans_previous_uploads(
        self,
        _resolve_conversation,
        _send_projection,
    ):
        uploaded_local_file_ids = []

        def _dispatch_file_action(**kwargs):
            action = kwargs.get("action")
            params = kwargs.get("params") or {}
            relative_path = params.get("relative_path")
            if (
                action == "fs.materialize_file_ref"
                and params.get("phase") == "probe"
                and relative_path == "artifacts/b/report.txt"
            ):
                return {"success": False, "error": "source file missing"}
            if action == "fs.materialize_file_ref" and params.get("phase") == "probe":
                return {
                    "success": True,
                    "data": {
                        "content_version": "sha256:first-file",
                        "size_bytes": 128,
                        "mime_type": "text/plain",
                    },
                }
            if action == "fs.materialize_file_ref" and params.get("phase") == "upload":
                return {
                    "success": True,
                    "data": {
                        "content_version": "sha256:first-file",
                        "size_bytes": 128,
                        "mime_type": "text/plain",
                    },
                }
            return {"success": False, "error": "unexpected action"}

        def _register_uploaded_local_file(**kwargs):
            record = FileRecord.objects.create(
                file_name=kwargs["file_name"],
                file_key=kwargs["object_key"],
                file_path="session-continuation",
                file_size=kwargs["file_size"],
                file_type="document",
                mime_type=kwargs["content_type"],
                file_extension="txt",
                file_hash="continuation-local-file-upload-cleanup",
                bucket_name="test-bucket",
                organization_id=str(self.organization.id),
                status="completed",
                upload_user=str(self.owner.id),
                upload_source="session_continuation",
            )
            uploaded_local_file_ids.append(record.id)
            return record

        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[{
                "kind": "file",
                "payload": {
                    "artifact_kind": "local_file",
                    "filename": "report.txt",
                    "relative_path": "artifacts/a/report.txt",
                },
                "type": "tabtin_rich_content",
            }, {
                "kind": "file",
                "payload": {
                    "artifact_kind": "local_file",
                    "filename": "report.txt",
                    "relative_path": "artifacts/b/report.txt",
                },
                "type": "tabtin_rich_content",
            }],
        )
        fake_oss = MagicMock()
        fake_oss.generate_presigned_url.return_value = "https://oss.example.test/signed"

        with (
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "DeviceRuntimeQueryService.dispatch_owner_workspace_fs_action",
                side_effect=_dispatch_file_action,
            ),
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "get_oss_service",
                return_value=fake_oss,
            ),
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "FileRegistryService.register_uploaded_file",
                side_effect=_register_uploaded_local_file,
            ),
            self.assertRaisesRegex(ValueError, "source file missing"),
        ):
            session_continuation_service.create_and_send(
                sender_user=self.owner,
                source_session_id=str(self.session.id),
                recipient_user_id=str(self.grantee.id),
                client_request_id="019fcaa1-ceee-7eee-8eee-eeeeeeeeeeee",
            )

        self.assertEqual(len(uploaded_local_file_ids), 1)
        record = FileRecord.objects.get(id=uploaded_local_file_ids[0])
        self.assertEqual(record.status, "deleted")
        self.assertEqual(record.ref_count, 0)
        fake_oss.delete_file.assert_called_once()

    @patch.object(
        session_continuation_service,
        "send_user_business_projection",
        return_value={"seq": 99},
    )
    @patch.object(
        session_continuation_service,
        "resolve_direct_conversation",
        return_value="conversation-1",
    )
    def test_continuation_restore_local_file_failure_blocks_task_creation(
        self,
        _resolve_conversation,
        _send_projection,
    ):
        def _dispatch_file_action(**kwargs):
            action = kwargs.get("action")
            params = kwargs.get("params") or {}
            if action == "fs.materialize_file_ref" and params.get("phase") == "probe":
                return {
                    "success": True,
                    "data": {
                        "content_version": "sha256:local-file-v1",
                        "size_bytes": 128,
                        "mime_type": "text/plain",
                    },
                }
            if action == "fs.materialize_file_ref" and params.get("phase") == "upload":
                return {
                    "success": True,
                    "data": {
                        "content_version": "sha256:local-file-v1",
                        "size_bytes": 128,
                        "mime_type": "text/plain",
                    },
                }
            if action == "fs.restore_file_from_url":
                return {"success": False, "error": "download failed"}
            return {"success": False, "error": "unexpected action"}

        def _register_uploaded_local_file(**kwargs):
            return FileRecord.objects.create(
                file_name=kwargs["file_name"],
                file_key=kwargs["object_key"],
                file_path="session-continuation",
                file_size=kwargs["file_size"],
                file_type="document",
                mime_type=kwargs["content_type"],
                file_extension="txt",
                file_hash="continuation-local-file-restore-fail",
                bucket_name="test-bucket",
                organization_id=str(self.organization.id),
                status="completed",
                upload_user=str(self.owner.id),
            )

        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[{
                "kind": "file",
                "payload": {
                    "artifact_kind": "local_file",
                    "filename": "notes.txt",
                    "relative_path": "artifacts/notes.txt",
                },
                "type": "tabtin_rich_content",
            }],
        )
        fake_oss = MagicMock()
        fake_oss.generate_presigned_url.return_value = "https://oss.example.test/signed"

        with (
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "DeviceRuntimeQueryService.dispatch_owner_workspace_fs_action",
                side_effect=_dispatch_file_action,
            ),
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "get_oss_service",
                return_value=fake_oss,
            ),
            patch(
                "apps.chat.conversation.services.session_continuation_local_files."
                "FileRegistryService.register_uploaded_file",
                side_effect=_register_uploaded_local_file,
            ),
        ):
            detail = session_continuation_service.create_and_send(
                sender_user=self.owner,
                source_session_id=str(self.session.id),
                recipient_user_id=str(self.grantee.id),
                client_request_id="019fcaa1-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
            )
            before_count = ChatSession.objects.count()

            with self.assertRaisesRegex(ValueError, "download failed"):
                session_continuation_service.create_task(
                    continuation_id=detail["object_id"],
                    recipient_user=self.grantee,
                    agent_id=str(self.grantee_agent.id),
                    workspace_id=str(self.grantee_workspace.id),
                    client_request_id="019fcaa1-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
                )

        self.assertEqual(ChatSession.objects.count(), before_count)

    @patch(
        "apps.chat.conversation.services.session_continuation_service.send_user_business_projection",
        return_value={"seq": 1},
    )
    @patch(
        "apps.chat.conversation.services.session_continuation_service.resolve_direct_conversation",
        return_value="conversation-1",
    )
    def test_continuation_resource_handoff_preserves_stronger_access(
        self,
        _resolve_conversation,
        _send_projection,
    ):
        table = Table.objects.create(
            organization_id=self.organization.id,
            owner_id=self.owner.id,
            name="可编辑数据表",
        )
        TablePermission.objects.create(
            table=table,
            subject_type="user",
            subject_id=str(self.grantee.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[{
                "kind": "resource_ref",
                "payload": {
                    "resource_type": "table",
                    "resource_id": str(table.id),
                },
                "type": "tabtin_rich_content",
            }],
        )

        detail = session_continuation_service.create_and_send(
            sender_user=self.owner,
            source_session_id=str(self.session.id),
            recipient_user_id=str(self.grantee.id),
            client_request_id="019fcaa1-7777-7777-8777-777777777777",
        )
        self.assertEqual(detail["resource_status"], "complete")

        session_continuation_service.create_task(
            continuation_id=detail["object_id"],
            recipient_user=self.grantee,
            agent_id=str(self.grantee_agent.id),
            workspace_id=str(self.grantee_workspace.id),
            client_request_id="019fcaa1-7777-7777-8777-888888888888",
        )

        permission = TablePermission.objects.get(
            table=table,
            subject_type="user",
            subject_id=str(self.grantee.id),
        )
        self.assertEqual(permission.permission, "editor")

    def test_active_share_grants_new_table_when_resource_message_is_persisted(self):
        share = self._create_share(can_chat=True)
        table = Table.objects.create(
            organization_id=self.organization.id,
            owner_id=self.owner.id,
            name="共享后新增表格",
        )

        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[{
                "kind": "resource_ref",
                "payload": {
                    "resource_type": "table",
                    "resource_id": str(table.id),
                },
            }],
        )
        sync_session_share_resource_grants()

        permission = TablePermission.objects.get(
            table=table,
            subject_type="user",
            subject_id=str(self.grantee.id),
        )
        self.assertTrue(permission.is_active)
        self.assertEqual(permission.permission, "editor")
        self.assertTrue(SessionShareResourceGrant.objects.filter(
            share=share,
            resource_type="table",
            resource_id=table.id,
            grantee_user_id=str(self.grantee.id),
            granted_permission="editor",
            is_active=True,
        ).exists())

    def test_new_table_uses_latest_share_permission_instead_of_older_control(self):
        older = self._create_share(can_chat=True)
        latest = self._create_share(can_chat=False)
        table = Table.objects.create(
            organization_id=self.organization.id,
            owner_id=self.owner.id,
            name="最新共享权限表格",
        )

        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[{
                "kind": "resource_ref",
                "payload": {
                    "resource_type": "table",
                    "resource_id": str(table.id),
                },
            }],
        )
        sync_session_share_resource_grants()

        permission = TablePermission.objects.get(
            table=table,
            subject_type="user",
            subject_id=str(self.grantee.id),
        )
        self.assertEqual(permission.permission, "viewer")
        self.assertFalse(older.resource_grants.filter(resource_id=table.id).exists())
        self.assertTrue(latest.resource_grants.filter(
            resource_id=table.id,
            granted_permission="viewer",
            is_active=True,
        ).exists())

    def test_latest_revoked_share_blocks_new_table_grant(self):
        self._create_share(can_chat=True)
        latest = self._create_share(can_chat=False)
        session_share_service.revoke_share(
            share_id=str(latest.id),
            actor_user=self.owner,
        )
        table = Table.objects.create(
            organization_id=self.organization.id,
            owner_id=self.owner.id,
            name="撤销后新增表格",
        )

        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[{
                "kind": "resource_ref",
                "payload": {
                    "resource_type": "table",
                    "resource_id": str(table.id),
                },
            }],
        )
        sync_session_share_resource_grants()

        self.assertFalse(TablePermission.objects.filter(
            table=table,
            subject_type="user",
            subject_id=str(self.grantee.id),
            is_active=True,
        ).exists())
        self.assertFalse(SessionShareResourceGrant.objects.filter(
            resource_id=table.id,
            grantee_user_id=str(self.grantee.id),
            is_active=True,
        ).exists())

    def test_share_projection_includes_source_workspace_identity(self):
        owner_workspace = _make_workspace(
            self.organization, self.owner, "Owner WS", "share-owner-source-ws",
        )
        self.session.workspace = owner_workspace
        self.session.save(update_fields=["workspace"])
        share = self._create_share()

        payload = session_share_service.serialize_share(share)

        self.assertEqual(payload["workspace_id"], str(owner_workspace.id))
        self.assertEqual(payload["workspace_name"], "Owner WS")

    def test_pending_share_is_visible_to_owner_but_hidden_from_peer_list(self):
        pending = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            status="pending",
        )

        self.assertEqual(
            list(session_share_service.list_shares_for_session(
                session_id=str(self.session.id),
                owner_user=self.owner,
            )),
            [pending],
        )
        self.assertEqual(
            list(session_share_service.list_shares_between(
                user_id=str(self.owner.id),
                peer_user_id=str(self.grantee.id),
            )),
            [pending],
        )
        self.assertFalse(
            session_share_service.list_shares_between(
                user_id=str(self.grantee.id),
                peer_user_id=str(self.owner.id),
            ).exists(),
        )

    def test_stale_pending_instance_cannot_reactivate_revoked_share(self):
        pending = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            status="pending",
        )
        stale_pending = SessionShare.objects.get(id=pending.id)
        session_share_service.revoke_share(
            share_id=str(pending.id),
            actor_user=self.owner,
        )

        with self.assertRaisesRegex(ValueError, "已撤销"):
            session_share_service.activate_share(
                share=stale_pending,
                actor_user=self.owner,
            )

        pending.refresh_from_db()
        self.assertEqual(pending.status, "revoked")

    def _get_session(self, user, session_id=None, share_id=None):
        request = self.factory.get(
            f"/api/chat/sessions/{session_id or self.session.id}",
        )
        request.auth = user
        return get_session(
            request,
            str(session_id or self.session.id),
            share_id=str(share_id) if share_id is not None else None,
        )

    def test_shared_session_detail_exposes_safe_agent_face(self):
        self.owner_agent.settings = {"avatar_url": "https://example.com/owner-agent.png"}
        self.owner_agent.save(update_fields=["settings"])
        share = self._create_share(can_chat=True)

        response = self._get_session(self.grantee, share_id=share.id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["agent_id"], str(self.owner_agent.id))
        self.assertEqual(response["data"]["agent_name"], "Owner Agent")
        self.assertEqual(
            response["data"]["agent_avatar"],
            "https://example.com/owner-agent.png",
        )

    def _get_messages(self, user, session_id=None, share_id=None):
        request = self.factory.get(
            f"/api/chat/sessions/{session_id or self.session.id}/messages",
        )
        request.auth = user
        return get_messages(
            request,
            str(session_id or self.session.id),
            share_id=str(share_id) if share_id is not None else None,
        )

    def _fork(
        self, user, *, agent_id=None, workspace_id=None, session_id=None, share_id=None,
    ):
        request = self.factory.post(
            f"/api/chat/sessions/{session_id or self.session.id}/shared-fork",
        )
        request.auth = user
        return shared_fork(
            request,
            str(session_id or self.session.id),
            SharedForkRequest(
                agent_id=str(agent_id or self.grantee_agent.id),
                workspace_id=str(workspace_id or self.grantee_workspace.id),
                share_id=str(share_id) if share_id else None,
            ),
        )

    def _chat(
        self,
        user,
        text="帮忙补一下重试逻辑",
        session_id=None,
        share_id=None,
    ):
        request = self.factory.post(
            f"/api/chat/sessions/{session_id or self.session.id}/shared-chat",
        )
        request.auth = user
        return shared_chat(
            request,
            str(session_id or self.session.id),
            SharedChatRequest(
                text=text,
                share_id=str(share_id) if share_id is not None else None,
            ),
        )

    def _execution_status(self, user, session_id=None, share_id=None):
        request = self.factory.get(
            f"/api/chat/sessions/{session_id or self.session.id}/shared-execution-status",
        )
        request.auth = user
        return shared_execution_status(
            request,
            str(session_id or self.session.id),
            share_id=str(share_id) if share_id is not None else None,
        )

    @staticmethod
    def _error_payload(response):
        return json.loads(response.content)

    # ── 模型 / 服务：每卡独立授权与约束 ─────────────────────────────

    def test_repeated_share_creates_independent_permission_grants(self):
        share = self._create_share(can_fork=False)
        self.assertEqual(share.status, "active")
        self.assertFalse(share.can_fork)
        self.assertTrue(share.events.filter(event_type="created").exists())

        again = self._create_share(can_fork=True, can_chat=True)
        self.assertNotEqual(again.id, share.id)
        self.assertEqual(SessionShare.objects.filter(session=self.session).count(), 2)
        share.refresh_from_db()
        self.assertFalse(share.can_fork)
        self.assertFalse(share.can_chat)
        self.assertTrue(again.can_fork)
        self.assertTrue(again.can_chat)
        self.assertTrue(again.events.filter(event_type="created").exists())
        self.assertEqual(
            list(session_share_service.list_shares_between(
                user_id=str(self.owner.id),
                peer_user_id=str(self.grantee.id),
            )),
            [again],
        )
        self.assertEqual(
            list(session_share_service.list_shares_between(
                user_id=str(self.grantee.id),
                peer_user_id=str(self.owner.id),
            )),
            [again],
        )

    def test_only_latest_confirmed_share_authorizes_the_grantee(self):
        older = self._create_share(can_fork=True, can_chat=True)
        latest = self._create_share(can_fork=False, can_chat=False)

        resolved = session_share_service.get_active_share(
            session_id=str(self.session.id),
            user=self.grantee,
        )
        self.assertEqual(resolved.id, latest.id)
        self.assertIsNone(
            session_share_service.get_active_share_by_id_for_user(
                share_id=str(older.id),
                session_id=str(self.session.id),
                user=self.grantee,
            ),
        )
        self.assertEqual(
            session_share_service.get_active_share_by_id_for_user(
                share_id=str(latest.id),
                session_id=str(self.session.id),
                user=self.grantee,
            ).id,
            latest.id,
        )

    def test_latest_revoked_share_disables_older_active_share(self):
        older = self._create_share(can_fork=True, can_chat=True)
        latest = self._create_share(can_fork=False, can_chat=False)
        session_share_service.revoke_share(
            share_id=str(latest.id),
            actor_user=self.owner,
        )

        self.assertIsNone(
            session_share_service.get_active_share(
                session_id=str(self.session.id),
                user=self.grantee,
            ),
        )
        self.assertIsNone(
            session_share_service.get_active_share_by_id_for_user(
                share_id=str(older.id),
                session_id=str(self.session.id),
                user=self.grantee,
            ),
        )

    def test_pending_share_does_not_replace_latest_confirmed_share(self):
        active = self._create_share(can_fork=True, can_chat=True)
        pending = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            can_fork=False,
            can_chat=False,
            status="pending",
        )

        self.assertEqual(
            session_share_service.get_active_share(
                session_id=str(self.session.id),
                user=self.grantee,
            ).id,
            active.id,
        )
        session_share_service.activate_share(share=pending, actor_user=self.owner)
        self.assertEqual(
            session_share_service.get_active_share(
                session_id=str(self.session.id),
                user=self.grantee,
            ).id,
            pending.id,
        )

    def test_pending_share_does_not_grant_session_access(self):
        """发卡确认前的 pending 授权不得放行 grantee 读会话。"""
        pending = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            can_fork=False,
            can_chat=False,
            status="pending",
        )
        self.assertEqual(pending.status, "pending")
        self.assertIsNone(
            session_share_service.get_active_share(
                session_id=str(self.session.id),
                user=self.grantee,
            ),
        )
        response = self._get_session(self.grantee)
        self.assertEqual(response.status_code, 404)

        activated = session_share_service.activate_share(
            share=pending,
            actor_user=self.owner,
        )
        self.assertEqual(activated.status, "active")
        self.assertIsNotNone(
            session_share_service.get_active_share(
                session_id=str(self.session.id),
                user=self.grantee,
            ),
        )

    def test_restore_reactivates_only_the_selected_share(self):
        share = self._create_share(can_fork=False)
        sibling = self._create_share(can_fork=True)

        revoked = session_share_service.revoke_share(
            share_id=str(share.id), actor_user=self.owner,
        )
        self.assertEqual(revoked.status, "revoked")
        self.assertIsNotNone(revoked.revoked_at)
        # 幂等：重复 revoke 不追加事件
        session_share_service.revoke_share(share_id=str(share.id), actor_user=self.owner)
        self.assertEqual(share.events.filter(event_type="revoked").count(), 1)

        reactivated = session_share_service.restore_share(
            share_id=str(share.id), owner_user=self.owner,
        )
        self.assertEqual(reactivated.id, share.id)
        self.assertEqual(reactivated.status, "active")
        self.assertFalse(reactivated.can_fork)
        self.assertIsNone(reactivated.revoked_at)
        sibling.refresh_from_db()
        self.assertEqual(sibling.status, "active")
        last_update = (
            share.events.filter(event_type="updated").order_by("-created_at").first()
        )
        self.assertTrue(last_update.payload_json.get("reactivated"))

    def test_non_owner_cannot_create_share(self):
        with self.assertRaises(SessionShareAccessError):
            session_share_service.create_or_update_share(
                session_id=str(self.session.id),
                owner_user=self.grantee,
                grantee_user_id=str(self.stranger.id),
                can_fork=False,
                can_chat=False,
            )

    def test_cross_org_grantee_rejected(self):
        with self.assertRaises(ValueError):
            session_share_service.create_or_update_share(
                session_id=str(self.session.id),
                owner_user=self.owner,
                grantee_user_id=str(self.outsider.id),
                can_fork=False,
                can_chat=False,
            )

    def test_share_to_self_rejected(self):
        with self.assertRaises(ValueError):
            session_share_service.create_or_update_share(
                session_id=str(self.session.id),
                owner_user=self.owner,
                grantee_user_id=str(self.owner.id),
                can_fork=False,
                can_chat=False,
            )

    def test_revoke_by_non_owner_rejected(self):
        share = self._create_share()
        with self.assertRaises(SessionShareAccessError):
            session_share_service.revoke_share(
                share_id=str(share.id), actor_user=self.grantee,
            )

    def test_get_share_for_user_visibility(self):
        share = self._create_share()
        self.assertEqual(
            session_share_service.get_share_for_user(
                share_id=str(share.id), user=self.owner,
            ).id,
            share.id,
        )
        self.assertEqual(
            session_share_service.get_share_for_user(
                share_id=str(share.id), user=self.grantee,
            ).id,
            share.id,
        )
        with self.assertRaises(SessionShareAccessError):
            session_share_service.get_share_for_user(
                share_id=str(share.id), user=self.stranger,
            )

    # ── 主鉴权第三分支：全量透明读 ──────────────────────────────────

    def test_main_auth_grantee_reads_session_detail(self):
        self._create_share()
        response = self._get_session(self.grantee)
        self.assertTrue(response["success"], response)
        self.assertEqual(response["data"]["id"], str(self.session.id))
        self.assertEqual(response["data"]["title"], "数据管道排查")

    def test_main_auth_grantee_reads_full_messages(self):
        """全量透明：grantee 经主链路 get_messages 拿到含 thinking / tool_use /
        tool_result 的完整消息，路径不打码——与 owner 看到的完全一致。"""
        self._create_share()
        system_notice = ChatMessage.objects.create(
            session=self.session,
            role="system",
            message_kind="llm",
            content_blocks_json=[{"type": "text", "text": "后台任务已完成"}],
            text_summary="后台任务已完成",
            metadata={"source": "background_task"},
        )
        response = self._get_messages(self.grantee)
        self.assertTrue(response["success"], response)
        serialized = json.dumps(response["data"], ensure_ascii=False, default=str)

        # 过程全可thinking / 工具调用与结果 / 原始路径
        self.assertIn("机密推理 secret-plan", serialized)
        self.assertIn("tool_use", serialized)
        self.assertIn("read_file", serialized)
        self.assertIn("SECRET_TOKEN", serialized)
        self.assertIn("/Users/developer", serialized)
        self.assertIn(
            str(system_notice.id),
            [message["id"] for message in response["data"]["messages"]],
        )

        # 同一个会话：grantee 与 owner 的消息窗口逐条一致（不做任何投影收窄）
        owner_response = self._get_messages(self.owner)
        self.assertEqual(
            [m["id"] for m in response["data"]["messages"]],
            [m["id"] for m in owner_response["data"]["messages"]],
        )

    def test_shared_message_includes_safe_agent_face(self):
        self.owner_agent.settings = {"avatar_url": "https://example.com/owner-agent.png"}
        self.owner_agent.save(update_fields=["settings"])
        self.msg_assistant.agent_id = self.owner_agent.id
        self.msg_assistant.save(update_fields=["agent_id"])
        self._create_share()

        response = self._get_messages(self.grantee)
        assistant = next(
            message for message in response["data"]["messages"]
            if message["id"] == str(self.msg_assistant.id)
        )
        self.assertEqual(assistant["agent_name"], "Owner Agent")
        self.assertEqual(
            assistant["agent_avatar"], "https://example.com/owner-agent.png",
        )

    def test_shared_message_tolerates_non_object_agent_settings(self):
        self.owner_agent.settings = ["legacy-setting"]
        self.owner_agent.save(update_fields=["settings"])
        self.msg_assistant.agent_id = self.owner_agent.id
        self.msg_assistant.save(update_fields=["agent_id"])
        self._create_share()

        response = self._get_messages(self.grantee)

        self.assertTrue(response["success"], response)
        assistant = next(
            message for message in response["data"]["messages"]
            if message["id"] == str(self.msg_assistant.id)
        )
        self.assertEqual(assistant["agent_name"], "Owner Agent")
        self.assertIsNone(assistant["agent_avatar"])

    def test_shared_message_tolerates_non_string_agent_avatar(self):
        self.owner_agent.settings = {"avatar_url": ["legacy-avatar"]}
        self.owner_agent.save(update_fields=["settings"])
        self.msg_assistant.agent_id = self.owner_agent.id
        self.msg_assistant.save(update_fields=["agent_id"])
        self._create_share()

        response = self._get_messages(self.grantee)

        self.assertTrue(response["success"], response)
        assistant = next(
            message for message in response["data"]["messages"]
            if message["id"] == str(self.msg_assistant.id)
        )
        self.assertEqual(assistant["agent_name"], "Owner Agent")
        self.assertIsNone(assistant["agent_avatar"])

    def test_main_auth_revoked_and_stranger_rejected(self):
        share = self._create_share()
        session_share_service.revoke_share(
            share_id=str(share.id), actor_user=self.owner,
        )
        # 主链路端点统一 NOT_FOUND 404（不泄露存在性）
        response = self._get_session(self.grantee)
        self.assertEqual(response.status_code, 404)
        response = self._get_messages(self.grantee)
        self.assertEqual(response.status_code, 404)

        self._create_share()  # 重新激活后陌生人仍拒
        response = self._get_session(self.stranger)
        self.assertEqual(response.status_code, 404)

    def test_revoked_share_scope_cannot_borrow_workspace_access(self):
        owner_workspace = self.owner_workspace
        SpaceMembership.objects.create(
            workspace=owner_workspace,
            user=self.grantee,
            role="editor",
            is_active=True,
        )
        self.session.workspace = owner_workspace
        self.session.save(update_fields=["workspace"])

        share = self._create_share()
        session_share_service.revoke_share(
            share_id=str(share.id), actor_user=self.owner,
        )
        sibling = self._create_share()

        # 普通任务入口继续尊重独立 Workspace 权限。
        self.assertTrue(self._get_session(self.grantee)["success"])
        self.assertTrue(self._get_messages(self.grantee)["success"])

        # 当前共享卡入口只认当前 shareId，不能借 Workspace 权限恢复正文。
        self.assertEqual(
            self._get_session(self.grantee, share_id=share.id).status_code,
            404,
        )
        self.assertEqual(
            self._get_messages(self.grantee, share_id=share.id).status_code,
            404,
        )
        self.assertTrue(
            self._get_session(self.grantee, share_id=sibling.id)["success"],
        )
        self.assertTrue(
            user_can_access_session(
                str(self.session.id),
                self.grantee,
                session_share_id=str(sibling.id),
            ),
        )
        self.assertFalse(
            user_can_access_session(
                str(self.session.id),
                self.grantee,
                session_share_id=str(share.id),
            ),
        )

    def test_user_can_access_session_capability(self):
        """WS 订阅鉴权同判据：grantee True；revoked / 陌生人 False。"""
        self.assertFalse(user_can_access_session(str(self.session.id), self.grantee))
        share = self._create_share()
        self.assertTrue(user_can_access_session(str(self.session.id), self.grantee))
        self.assertFalse(user_can_access_session(str(self.session.id), self.stranger))
        session_share_service.revoke_share(
            share_id=str(share.id), actor_user=self.owner,
        )
        self.assertFalse(user_can_access_session(str(self.session.id), self.grantee))

    def test_active_share_grants_access_to_artifact_created_after_sharing(self):
        """运行中任务在发卡后新产出的 TabDoc 也必须继承共享授权。"""
        from apps.tabdoc.models import Document, DocumentPermission

        self._create_share()
        document = Document.objects.create(
            organization_id=self.organization.id,
            owner_id=self.owner.id,
            created_by=self.owner,
            title="运行中新产出的报告",
        )

        with self.captureOnCommitCallbacks(execute=True):
            ChatMessage.objects.create(
                session=self.session,
                role="assistant",
                content_blocks_json=[{
                    "kind": "resource_ref",
                    "payload": {
                        "resource_type": "document",
                        "resource_id": str(document.id),
                    },
                }],
            )

        self.assertTrue(
            DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id=str(self.grantee.id),
                permission="viewer",
                is_active=True,
            ).exists(),
        )

    def test_loading_active_share_repairs_existing_artifact_permission(self):
        """升级前已经漏授权的 active 卡，打开详情时自愈。"""
        from apps.chat.conversation.services.session_share_card_service import (
            get_share_detail,
        )
        from apps.tabdoc.models import Document, DocumentPermission

        share = self._create_share()
        document = Document.objects.create(
            organization_id=self.organization.id,
            owner_id=self.owner.id,
            created_by=self.owner,
            title="存量报告",
        )
        ChatMessage.objects.bulk_create([
            ChatMessage(
                session=self.session,
                role="assistant",
                content_blocks_json=[{
                    "kind": "resource_ref",
                    "payload": {
                        "resource_type": "document",
                        "resource_id": str(document.id),
                    },
                }],
            ),
        ])

        get_share_detail(viewer_user=self.grantee, share_id=str(share.id))

        self.assertTrue(
            DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id=str(self.grantee.id),
                permission="viewer",
                is_active=True,
            ).exists(),
        )

    @patch(
        "apps.chat.conversation.services.session_share_card_service."
        "_refresh_card_with_retry_tracking"
    )
    @patch(
        "apps.tabtinspace.services.organization_service.OrganizationService."
        "_sync_collab_revoke"
    )
    @patch(
        "apps.tabtinspace.services.organization_service.OrganizationService."
        "_sync_im_dm_revoke"
    )
    def test_removing_member_stops_shared_task_relation(
        self,
        _mock_im_revoke,
        _mock_collab_revoke,
        mock_refresh_card,
    ):
        from apps.tabtinspace.services.organization_service import OrganizationService

        share = self._create_share()

        with self.captureOnCommitCallbacks(execute=True):
            OrganizationService(user=self.owner).remove_member(
                organization_id=self.organization.id,
                user_id=str(self.grantee.id),
            )

        share.refresh_from_db()
        self.assertEqual(share.status, "revoked")
        self.assertTrue(
            share.events.filter(
                event_type="revoked",
                payload_json__reason="organization_membership_ended",
            ).exists(),
        )
        mock_refresh_card.assert_called_once()

    @patch(
        "apps.chat.conversation.services.session_share_card_service."
        "_refresh_card_with_retry_tracking"
    )
    @patch(
        "apps.tabtinspace.services.organization_service.OrganizationService."
        "_schedule_collab_revoke"
    )
    @patch(
        "apps.tabtinspace.services.organization_service.OrganizationService."
        "_sync_im_dm_revoke"
    )
    def test_leaving_organization_stops_shared_task_relation(
        self,
        _mock_im_revoke,
        _mock_collab_revoke,
        mock_refresh_card,
    ):
        from apps.tabtinspace.services.organization_service import OrganizationService

        share = self._create_share()

        with self.captureOnCommitCallbacks(execute=True):
            OrganizationService(user=self.grantee).leave_organization(
                self.organization.id,
            )

        share.refresh_from_db()
        self.assertEqual(share.status, "revoked")
        mock_refresh_card.assert_called_once()

    # ── 写端点仍拒 grantee ──────────────────────────────────────────

    def test_write_endpoints_still_reject_grantee(self):
        """共享只授权「读 + 流」：改标题 / 删会话 / 通用 fork 对 grantee 全拒。"""
        self._create_share(can_fork=True, can_chat=True)

        # 改标题（owner 过滤）
        request = self.factory.put(f"/api/chat/sessions/{self.session.id}")
        request.auth = self.grantee
        response = update_session(
            request, str(self.session.id), UpdateSessionRequest(title="被改名"),
        )
        self.assertEqual(response.status_code, 404)
        self.session.refresh_from_db()
        self.assertEqual(self.session.title, "数据管道排查")

        # 删会话（owner 过滤）
        request = self.factory.delete(f"/api/chat/sessions/{self.session.id}")
        request.auth = self.grantee
        response = delete_session(request, str(self.session.id))
        self.assertEqual(response.status_code, 404)
        self.assertTrue(ChatSession.objects.filter(id=self.session.id).exists())

        # 通用 fork（include_session_share=False；grantee fork 只走 shared-fork）
        request = self.factory.post(f"/api/chat/sessions/{self.session.id}/fork")
        request.auth = self.grantee
        response = fork_session(request, str(self.session.id), ForkSessionRequest())
        self.assertEqual(response.status_code, 404)

    def test_archiving_requires_stopping_active_shares_first(self):
        share = self._create_share()
        request = self.factory.put(f"/api/chat/sessions/{self.session.id}")
        request.auth = self.owner

        response = update_session(
            request,
            str(self.session.id),
            UpdateSessionRequest(status="archived"),
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn("先停止共享", self._error_payload(response)["message"])
        self.session.refresh_from_db()
        share.refresh_from_db()
        self.assertNotEqual(self.session.status, "archived")
        self.assertEqual(share.status, "active")

    # ── shared-fork ─────────────────────────────────────────────────

    def test_shared_fork_requires_can_fork(self):
        view_only = self._create_share(can_fork=False)
        self._create_share(can_fork=True)
        response = self._fork(self.grantee, share_id=view_only.id)
        self.assertEqual(response.status_code, 403)
        self.assertIn("共享会话", self._error_payload(response)["message"])

    def test_shared_fork_uses_the_selected_forkable_share(self):
        self._create_share(can_fork=False)
        forkable = self._create_share(can_fork=True)
        response = self._fork(self.grantee, share_id=forkable.id)
        self.assertTrue(response["success"], response)

    def test_shared_fork_without_share_403(self):
        response = self._fork(self.grantee)
        self.assertEqual(response.status_code, 403)
        self.assertIn("不存在或无权查看", self._error_payload(response)["message"])

    def test_shared_fork_validates_agent_ownership(self):
        self._create_share(can_fork=True)
        response = self._fork(self.grantee, agent_id=self.owner_agent.id)
        self.assertEqual(response.status_code, 403)
        self.assertIn("Agent", self._error_payload(response)["message"])

    def test_shared_fork_validates_agent_org(self):
        self._create_share(can_fork=True)
        foreign_agent = Agent.objects.create(
            organization=self.other_org,
            owner_user=self.grantee,
            name="Foreign Agent",
        )
        response = self._fork(self.grantee, agent_id=foreign_agent.id)
        self.assertEqual(response.status_code, 400)
        self.assertIn("Organization", self._error_payload(response)["message"])

    def test_shared_fork_validates_workspace_ownership(self):
        self._create_share(can_fork=True)
        owner_workspace = self.owner_workspace
        response = self._fork(self.grantee, workspace_id=owner_workspace.id)
        self.assertEqual(response.status_code, 403)
        self.assertIn("Workspace", self._error_payload(response)["message"])

    def test_shared_fork_materializes_snapshot_session(self):
        share = self._create_share(can_fork=True)
        response = self._fork(self.grantee)
        self.assertTrue(response["success"], response)
        data = response["data"]

        new_session = ChatSession.objects.get(id=data["id"])
        self.assertEqual(str(new_session.user_id), str(self.grantee.id))
        self.assertEqual(str(new_session.agent_id), str(self.grantee_agent.id))
        self.assertEqual(str(new_session.workspace_id), str(self.grantee_workspace.id))
        self.assertEqual(new_session.organization_id, str(self.organization.id))
        self.assertIn("数据管道排查", new_session.title)
        # agent_mode 取 Agent.settings.default_mode
        self.assertEqual(new_session.agent_mode, "agent")

        messages = list(new_session.messages.order_by("created_at", "id"))
        # 1 briefing + 1 契约（上下文开头）+ 3 条快照
        self.assertEqual(len(messages), 5)

        snapshots = [m for m in messages if (m.metadata or {}).get("share_snapshot")]
        briefings = [m for m in messages if (m.metadata or {}).get("share_briefing")]
        contracts = [m for m in messages if (m.metadata or {}).get("share_contract")]
        self.assertEqual(len(snapshots), 3)
        self.assertEqual(len(briefings), 1)
        self.assertEqual(len(contracts), 1)

        # 上下文注入排在快照之前；快照仍保留源对话时间
        self.assertEqual(messages[0].id, briefings[0].id)
        self.assertEqual(messages[1].id, contracts[0].id)
        self.assertEqual(messages[2].id, snapshots[0].id)
        self.assertEqual(messages[2].created_at, self.msg_user.created_at)
        self.assertLess(briefings[0].created_at, snapshots[0].created_at)
        self.assertLess(contracts[0].created_at, snapshots[0].created_at)
        self.assertEqual(
            [m.role for m in snapshots], ["user", "assistant", "user"],
        )

        all_snapshot_text = json.dumps(
            [m.content_blocks_json for m in snapshots], ensure_ascii=False,
        )
        # 透明口径：正文与路径原样保留，不再打码
        self.assertIn("/Users/developer", all_snapshot_text)
        self.assertNotIn("path-redacted", all_snapshot_text)
        # 工具调用：保留结构化 tool_use，前端按正常消息渲染工具卡片。
        self.assertIn('"type": "tool_use"', all_snapshot_text)
        self.assertIn('"name": "read_file"', all_snapshot_text)
        self.assertIn('"label": "读取文件"', all_snapshot_text)
        self.assertNotIn("工具：读取文件", all_snapshot_text)
        tool_ids = [
            block["id"]
            for message in snapshots
            for block in message.content_blocks_json
            if isinstance(block, dict)
            and str(block.get("type") or "").endswith("tool_use")
        ]
        self.assertEqual(len(tool_ids), len(set(tool_ids)))
        # 附件：保留结构化 file block，接手后 Agent 可按 file_id 读取全文。
        self.assertIn('"type": "file"', all_snapshot_text)
        self.assertIn('"filename": "data.csv"', all_snapshot_text)
        self.assertIn('"file_id": "file-123"', all_snapshot_text)
        # 思考过程与工具执行细节仍不进快照
        self.assertNotIn("机密推理", all_snapshot_text)
        self.assertNotIn("SECRET_TOKEN", all_snapshot_text)
        # 主时间线之外的消息不进快照
        self.assertNotIn("子Agent输出", all_snapshot_text)
        self.assertNotIn("产物气泡", all_snapshot_text)
        self.assertNotIn("environment 快照", all_snapshot_text)

        # briefing / 契约：environment_context（UI 隐藏、进 LLM 上下文开头）
        self.assertEqual(briefings[0].role, "system")
        self.assertEqual(briefings[0].message_kind, "environment_context")
        self.assertIn("会话快照", briefings[0].content_blocks_json[0]["text"])
        self.assertEqual(contracts[0].role, "system")
        self.assertEqual(contracts[0].message_kind, "environment_context")
        contract_text = contracts[0].content_blocks_json[0]["text"]
        self.assertIn('<context type="session-share-fork"', contract_text)
        self.assertIn(str(self.session.id), contract_text)

        # 回填 + 审计
        share.refresh_from_db()
        self.assertEqual(share.forked_session_id, new_session.id)
        self.assertTrue(
            SessionShareEvent.objects.filter(
                share=share,
                event_type="forked",
                actor_user_id=str(self.grantee.id),
            ).exists()
        )
        # 不写 ConversationState（接收人首轮发消息走恢复口径重建）
        from apps.services.agent_engine.models import ConversationState
        self.assertFalse(
            ConversationState.objects.filter(
                thread_id=new_session.effective_thread_id,
            ).exists()
        )

    def test_v2_shared_fork_bumps_card_version_and_refreshes_projection(self):
        """forked_session_id 改变后必须失效双端详情缓存并刷新原卡。"""
        share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            can_fork=True,
            card_contract="session_share_v2",
            status="active",
        )
        share.delivery_status = "confirmed"
        share.card_conversation_id = "conversation-fork-refresh"
        share.card_message_ref = "019fcaa1-3333-7333-8333-555555555555"
        share.card_message_id = 44
        share.save(update_fields=[
            "delivery_status",
            "card_conversation_id",
            "card_message_ref",
            "card_message_id",
        ])
        original_version = share.version

        with patch.object(
            session_share_card_service,
            "_refresh_card_with_retry_tracking",
        ) as refresh_card:
            response = self._fork(self.grantee, share_id=share.id)

        self.assertTrue(response["success"], response)
        share.refresh_from_db()
        self.assertEqual(share.version, original_version + 1)
        self.assertEqual(
            str(share.forked_session_id),
            response["data"]["id"],
        )
        refresh_card.assert_called_once()
        refreshed_share = refresh_card.call_args.args[0]
        self.assertEqual(refreshed_share.id, share.id)
        self.assertEqual(refreshed_share.version, share.version)
        self.assertEqual(
            str(refreshed_share.forked_session_id),
            response["data"]["id"],
        )

    def test_shared_fork_creates_new_session_on_repeat(self):
        """#7916：每次显式 fork 都新建；forked_session_id 只记 latest；旧副本保留。"""
        share = self._create_share(can_fork=True)
        first = self._fork(self.grantee)
        self.assertTrue(first["success"])
        first_id = first["data"]["id"]

        again = self._fork(self.grantee)
        self.assertTrue(again["success"])
        second_id = again["data"]["id"]
        self.assertNotEqual(second_id, first_id)
        self.assertEqual(
            ChatSession.objects.filter(user=self.grantee).count(), 2,
        )
        self.assertTrue(ChatSession.objects.filter(id=first_id).exists())
        share.refresh_from_db()
        self.assertEqual(str(share.forked_session_id), second_id)
        self.assertEqual(
            SessionShareEvent.objects.filter(
                share=share, event_type="forked",
            ).count(),
            2,
        )

        # 删掉最新副本后再 fork：仍新建（不再依赖「已删才重建」短路）
        ChatSession.objects.filter(id=second_id).delete()
        rebuilt = self._fork(self.grantee)
        self.assertTrue(rebuilt["success"])
        self.assertNotEqual(rebuilt["data"]["id"], second_id)
        self.assertNotEqual(rebuilt["data"]["id"], first_id)
        share.refresh_from_db()
        self.assertEqual(str(share.forked_session_id), rebuilt["data"]["id"])
        self.assertTrue(ChatSession.objects.filter(id=first_id).exists())

    def test_collect_share_turns_truncation_keeps_latest(self):
        """超长会话截断保最新丢最早（fork 为了继续任务，近期上下文最要紧）。"""
        from apps.chat.conversation.services.share_fork_turns import (
            collect_share_turns,
        )

        turns, truncated = collect_share_turns(self.session, max_turns=2)
        self.assertTrue(truncated)
        self.assertEqual(len(turns), 2)
        # 夹具可见消息时间序：msg_user(0') → msg_assistant(1') → msg_user_file(2')
        # 保最新 = 后两条；且翻回时间升序，最早的 msg_user 被丢弃
        self.assertIn("配置在", turns[0]["text"])
        self.assertIn("数据样本", turns[1]["text"])
        self.assertIn("file-123", json.dumps(turns[1]["blocks"], ensure_ascii=False))
        self.assertNotIn("帮我看下", turns[0]["text"] + turns[1]["text"])

    def test_collect_share_turns_skips_internal_tool_only_messages(self):
        """纯内部工具轮保留为结构化工具块，而不是工具名文本。"""
        from apps.chat.conversation.services.share_fork_turns import (
            collect_share_turns,
        )

        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[
                {
                    "type": "tool_use",
                    "id": "tu_terminal",
                    "name": "run_terminal_command",
                    "input": {"cmd": "printf ok"},
                },
            ],
        )
        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[
                {
                    "type": "tool_use",
                    "id": "tu_skill",
                    "name": "skills_read",
                    "input": {"skill": "app:tabslide/html-spec"},
                },
            ],
        )
        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[
                {
                    "type": "mcp_tool_use",
                    "id": "tu_mcp",
                    "name": "mcp_lookup",
                    "input": {"query": "secret"},
                },
            ],
        )

        turns, _ = collect_share_turns(self.session)
        all_text = "\n".join(turn["text"] for turn in turns)
        all_blocks = json.dumps(
            [turn["blocks"] for turn in turns], ensure_ascii=False,
        )

        self.assertNotIn("工具：run_terminal_command", all_text)
        self.assertNotIn("工具：skills_read", all_text)
        self.assertIn('"type": "tool_use"', all_blocks)
        self.assertIn('"name": "run_terminal_command"', all_blocks)
        self.assertIn('"name": "skills_read"', all_blocks)
        self.assertIn('"type": "mcp_tool_use"', all_blocks)
        self.assertIn('"name": "mcp_lookup"', all_blocks)
        self.assertNotIn("printf ok", all_blocks)
        self.assertNotIn("app:tabslide/html-spec", all_blocks)
        self.assertNotIn("secret", all_blocks)
        tool_ids = [
            block["id"]
            for turn in turns
            for block in turn["blocks"]
            if isinstance(block, dict)
            and str(block.get("type") or "").endswith("tool_use")
        ]
        self.assertEqual(len(tool_ids), len(set(tool_ids)))

    def test_collect_share_turns_keeps_text_without_unknown_tool_name(self):
        """正文与工具调用分别保留为 text/tool_use 结构块。"""
        from apps.chat.conversation.services.share_fork_turns import (
            collect_share_turns,
        )

        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[
                {"type": "text", "text": "我先检查本地环境。"},
                {
                    "type": "tool_use",
                    "id": "tu_terminal",
                    "name": "run_terminal_command",
                    "input": {"cmd": "tabtin slide --help"},
                },
            ],
        )

        turns, _ = collect_share_turns(self.session)
        all_text = "\n".join(turn["text"] for turn in turns)
        all_blocks = json.dumps(
            [turn["blocks"] for turn in turns], ensure_ascii=False,
        )

        self.assertIn("我先检查本地环境。", all_text)
        self.assertNotIn("工具：run_terminal_command", all_text)
        self.assertIn('"name": "run_terminal_command"', all_blocks)
        self.assertNotIn("tabtin slide --help", all_blocks)

    def test_collect_share_turns_keeps_deliverable_tool_artifact(self):
        """可交付 tool_artifact 进快照；纯文本占位产物气泡仍排除。"""
        from apps.chat.conversation.services.session_materializer import (
            materialize_session_from_turns,
        )
        from apps.chat.conversation.services.share_fork_turns import (
            collect_share_resource_pointers,
            collect_share_turns,
        )

        file_record = FileRecord.objects.create(
            file_name="试点方案.pptx",
            file_key=f"tests/{self.session.id}/试点方案.pptx",
            file_path="tests/试点方案.pptx",
            file_size=2048,
            file_type="document",
            mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            file_extension="pptx",
            file_hash="share-artifact-handoff",
            bucket_name="test-bucket",
            organization_id=str(self.organization.id),
            status="completed",
            upload_user=str(self.owner.id),
        )
        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            message_kind="tool_artifact",
            content_blocks_json=[{
                "type": "tabtin_rich_content",
                "kind": "file",
                "summary": "试点方案.pptx",
                "payload": {
                    "artifact_kind": "oss_file",
                    "file_id": str(file_record.id),
                    "filename": "试点方案.pptx",
                },
            }],
        )

        turns, _ = collect_share_turns(self.session)
        artifact_turns = [
            turn for turn in turns if turn.get("message_kind") == "tool_artifact"
        ]
        self.assertEqual(len(artifact_turns), 1)
        self.assertEqual(artifact_turns[0]["role"], "assistant")
        self.assertEqual(
            artifact_turns[0]["blocks"][0]["payload"]["file_id"],
            str(file_record.id),
        )
        all_text = "\n".join(turn["text"] for turn in turns)
        self.assertNotIn("产物气泡", all_text)

        pointers = collect_share_resource_pointers(self.session)
        self.assertIn(("tabfiles", str(file_record.id)), pointers)

        new_session = materialize_session_from_turns(
            user=self.grantee,
            organization_id=str(self.organization.id),
            agent=self.grantee_agent,
            workspace=self.grantee_workspace,
            title="续接产物",
            turns=turns,
            briefing_text="会话快照",
            contract_payload={"type": "session-continuation"},
            source_meta={"source_type": "session_continuation"},
        )
        copied = new_session.messages.filter(message_kind="tool_artifact")
        self.assertEqual(copied.count(), 1)
        self.assertEqual(
            copied.first().content_blocks_json[0]["payload"]["file_id"],
            str(file_record.id),
        )
        self.assertTrue((copied.first().metadata or {}).get("share_snapshot"))

    # ── shared-execution-status（发送前预检）─────────────────────────

    def test_shared_execution_status_requires_can_chat(self):
        self._create_share(can_chat=False)
        response = self._execution_status(self.grantee)
        self.assertEqual(response.status_code, 403)
        self.assertIn("对话权限", self._error_payload(response)["message"])

    def test_shared_execution_status_without_share_403(self):
        response = self._execution_status(self.stranger)
        self.assertEqual(response.status_code, 403)

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service"
        ".PromptForwardService.probe_execution_device_reachable",
    )
    def test_shared_execution_status_reachable(self, mock_probe):
        mock_probe.return_value = {
            "reachable": True,
            "error_category": None,
            "runtime": "electron",
        }
        self._create_share(can_chat=True)
        response = self._execution_status(self.grantee)
        self.assertTrue(response["success"], response)
        self.assertTrue(response["data"]["reachable"])
        self.assertEqual(response["data"]["runtime"], "electron")
        mock_probe.assert_called_once()
        kwargs = mock_probe.call_args.kwargs
        self.assertEqual(kwargs["execution_owner_user_id"], str(self.owner.id))
        self.assertTrue(kwargs["allow_busy"])

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service"
        ".PromptForwardService.probe_execution_device_reachable",
    )
    def test_shared_execution_status_offline(self, mock_probe):
        mock_probe.return_value = {
            "reachable": False,
            "error_category": "device_offline",
            "runtime": None,
        }
        self._create_share(can_chat=True)
        response = self._execution_status(self.grantee)
        self.assertTrue(response["success"], response)
        self.assertFalse(response["data"]["reachable"])
        self.assertEqual(response["data"]["error_category"], "device_offline")

    # ── shared-chat（发言驱动）───────────────────────────────────────

    def test_shared_chat_requires_can_chat(self):
        self._create_share(can_chat=False)
        response = self._chat(self.grantee)
        self.assertEqual(response.status_code, 403)
        self.assertIn("对话权限", self._error_payload(response)["message"])

    def test_shared_chat_without_share_or_revoked_403(self):
        # 无 share（陌生人）
        response = self._chat(self.stranger)
        self.assertEqual(response.status_code, 403)
        self.assertIn("不存在或无权查看", self._error_payload(response)["message"])

        # revoked 后 grantee 也拒（防探测同口径）
        share = self._create_share(can_chat=True)
        session_share_service.revoke_share(
            share_id=str(share.id), actor_user=self.owner,
        )
        response = self._chat(self.grantee)
        self.assertEqual(response.status_code, 403)
        self.assertIn("不存在或无权查看", self._error_payload(response)["message"])
        # 未 dispatch、未记 chatted
        self.assertFalse(
            SessionShareEvent.objects.filter(event_type="chatted").exists()
        )

    @patch(_CHAT_SERVICE_PATH)
    def test_revoked_share_scope_cannot_borrow_chat_capability(self, mock_send):
        revoked = self._create_share(can_chat=True)
        session_share_service.revoke_share(
            share_id=str(revoked.id), actor_user=self.owner,
        )
        self._create_share(can_chat=True)

        response = self._execution_status(
            self.grantee,
            share_id=revoked.id,
        )
        self.assertEqual(response.status_code, 403)
        response = self._chat(
            self.grantee,
            share_id=revoked.id,
        )
        self.assertEqual(response.status_code, 403)
        mock_send.assert_not_called()

    def test_shared_chat_blank_text_rejected(self):
        self._create_share(can_chat=True)
        response = self._chat(self.grantee, text="   ")
        self.assertEqual(response.status_code, 400)

    @patch(_CHAT_SERVICE_PATH)
    def test_shared_chat_uses_chat_service_as_owner_and_audits(self, mock_send):
        """#7879：shared-chat 进 ChatService，执行身份 owner、归因 grantee。"""
        mock_send.return_value = {
            "message_id": None,
            "reply": "收到，我来补重试逻辑。",
            "content": "收到，我来补重试逻辑。",
            "model_id": "model-uuid-1",
            "model_name": "test-model",
            "trace_id": None,
            "error_category": None,
            "error_message": None,
            "_internal_flag": "task-1",
        }
        share = self._create_share(can_chat=True)

        response = self._chat(self.grantee, text="帮忙补一下重试逻辑")
        self.assertTrue(response["success"], response)
        data = response["data"]
        self.assertEqual(data["reply"], "收到，我来补重试逻辑。")
        self.assertEqual(data["model_id"], "model-uuid-1")
        self.assertIsNone(data["error_category"])
        # 内部字段不透传
        self.assertNotIn("_internal_flag", data)

        # 执行身份 = owner；app_context 带发言人归属标记
        mock_send.assert_called_once()
        kwargs = mock_send.call_args.kwargs
        self.assertEqual(str(kwargs["user"].id), str(self.owner.id))
        self.assertEqual(kwargs["session_id"], str(self.session.id))
        self.assertEqual(kwargs["message"], "帮忙补一下重试逻辑")
        self.assertEqual(kwargs["client_type"], "server")
        self.assertEqual(kwargs["execution_profile"], "conversational")
        app_context = kwargs["app_context"]
        self.assertEqual(app_context["_invoked_from"], "session_share_chat")
        self.assertEqual(app_context["_shared_chat_by"], str(self.grantee.id))
        self.assertEqual(app_context["share_id"], str(share.id))

        # chatted 审计落账（actor = grantee，payload 带规模与摘要）
        event = SessionShareEvent.objects.filter(
            share=share, event_type="chatted",
        ).first()
        self.assertIsNotNone(event)
        self.assertEqual(event.actor_user_id, str(self.grantee.id))
        self.assertEqual(event.payload_json["text_len"], len("帮忙补一下重试逻辑"))
        self.assertEqual(event.payload_json["preview"], "帮忙补一下重试逻辑")

    @patch(_CHAT_SERVICE_PATH)
    def test_shared_chat_offline_passthrough(self, mock_send):
        """设备离线：如实透传 ChatService 的 device_offline 结构化结果。"""
        mock_send.return_value = {
            "message_id": None,
            "reply": '当前设备 "Owner Device" 不在线，请打开客户端后重试。',
            "content": "",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "error_category": "device_offline",
            "error_message": "control_device Owner Device status=offline",
            "_remote_agent_device_name": "Owner Device",
        }
        self._create_share(can_chat=True)

        response = self._chat(self.grantee)
        self.assertTrue(response["success"], response)
        data = response["data"]
        self.assertEqual(data["error_category"], "device_offline")
        self.assertIn("不在线", data["reply"])
        self.assertNotIn("_remote_agent_device_name", data)


class ResolveSenderAttributionTests(TestCase):
    """forward / lightweight 两条持久化路径共用的发言归属 override。"""

    def test_default_without_marker_keeps_owner(self):
        from apps.services.agent_engine.services.persistence_pipeline import (
            resolve_sender_attribution,
        )

        sender, metadata = resolve_sender_attribution("owner-1", None)
        self.assertEqual(sender, "owner-1")
        self.assertIsNone(metadata)

        sender, metadata = resolve_sender_attribution(
            "owner-1", {"_origin_source": "tracker"},
        )
        self.assertEqual(sender, "owner-1")
        self.assertIsNone(metadata)

    def test_shared_chat_marker_overrides_sender(self):
        from apps.services.agent_engine.services.persistence_pipeline import (
            resolve_sender_attribution,
        )

        sender, metadata = resolve_sender_attribution(
            "owner-1",
            {"_shared_chat_by": "grantee-9", "share_id": "share-3"},
        )
        self.assertEqual(sender, "grantee-9")
        self.assertEqual(
            metadata,
            {"shared_chat": True, "shared_chat_by": "grantee-9", "share_id": "share-3"},
        )


class SharedForkRepeatNoDbTests(SimpleTestCase):
    """#7916：已有 forked_session_id 时仍应物化新会话（不依赖测试库 migrate）。"""

    def test_existing_forked_session_id_still_materializes(self):
        from uuid import uuid4

        grantee = MagicMock()
        grantee.id = "grantee-1"
        grantee.get_display_name = MagicMock(return_value="Grantee")

        source_session = MagicMock()
        source_session.id = uuid4()
        source_session.title = "源会话"
        source_session.organization_id = "org-1"

        existing_fork_id = uuid4()
        share = MagicMock()
        share.id = uuid4()
        share.can_fork = True
        share.forked_session_id = existing_fork_id
        share.session = source_session
        share.owner_user_id = "owner-1"
        share.organization_id = "org-1"

        agent = MagicMock()
        agent.id = uuid4()
        workspace = MagicMock()
        workspace.id = uuid4()

        new_session = MagicMock()
        new_session.id = uuid4()
        new_session.user_id = grantee.id

        request = RequestFactory().post("/api/chat/sessions/x/shared-fork")
        request.auth = grantee

        with (
            patch(
                "apps.chat.conversation.api.session_share._get_active_share_or_none",
                return_value=share,
            ),
            patch(
                "apps.chat.conversation.services.execution_target.resolve_execution_target",
                return_value=(agent, workspace),
            ),
            patch(
                "apps.chat.conversation.api.session_share.collect_share_turns",
                return_value=([{"role": "user", "text": "hi"}], False),
            ),
            patch(
                "apps.chat.conversation.services.session_materializer.materialize_session_from_turns",
                return_value=new_session,
            ) as mock_materialize,
            patch(
                "apps.chat.conversation.api.session_share.session_share_service.mark_share_forked",
            ) as mock_mark,
            patch(
                "apps.chat.conversation.api.session_share._session_to_schema",
            ) as mock_schema,
            patch(
                "apps.chat.conversation.api.session_share._visible_message_count",
                return_value=1,
            ),
            patch(
                "apps.chat.conversation.api.session_share.get_user_model",
            ) as mock_user_model,
        ):
            mock_user_model.return_value.objects.filter.return_value.first.return_value = None
            mock_schema.return_value.model_dump.return_value = {
                "id": str(new_session.id),
            }

            response = shared_fork(
                request,
                str(source_session.id),
                SharedForkRequest(
                    agent_id=str(agent.id),
                    workspace_id=str(workspace.id),
                ),
            )

        self.assertTrue(response["success"], response)
        self.assertEqual(response["data"]["id"], str(new_session.id))
        mock_materialize.assert_called_once()
        mock_mark.assert_called_once_with(share, grantee, new_session)
        self.assertNotEqual(str(new_session.id), str(existing_fork_id))
