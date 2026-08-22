"""IM 上下文交接「由我继续」升级：scope 强制 + take-over 建会话。

对真 PG 跑：USE_SQLITE_FOR_TESTS=0 manage.py test apps.tabchat.tests.test_handoff_take_over
覆盖：
- scope=view_only 拒 take_over（act 老路径 + take-over-session 新端点双路）；
- take-over-session 正常链路（会话归接收人、快照消息带工具/附件行、
  briefing / 契约 metadata 正确）；
- linked_session_id 回填 + 幂等（含会话被删后允许重建）；
- revoked / 无快照 / rejected 拒绝；agent / workspace 归属校验失败路径；
- scope=continuable 的 act('take_over') 老按钮行为保持不变（不建会话）。

夹具自包含（刻意不 import test_handoff.HandoffTestBase，避免与并行改动耦合）。
"""

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

import json

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase

from apps.agent.models import Agent
from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.chat.conversation.services.execution_target import ExecutionTargetError
from apps.tabchat.handoff.api import TakeOverSessionRequest, take_over_handoff_session
from apps.tabchat.handoff.models import (
    HandoffEvent,
    HandoffPackage,
    HandoffRecipient,
)
from apps.tabchat.handoff.service import HandoffService
from apps.tabchat.models import IMEventOutbox
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabtinspace.models import (
    Device,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)
from apps.users.membership.models import MembershipTier

User = get_user_model()

_ATTACHMENT_FILE_ID = "76090ee0-851e-4319-8e26-ecf176b89d61"


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "handoff take-over tests bootstrap",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
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


class HandoffTakeOverTestBase(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.alice = User.objects.create_user(
            username="hto_alice", email="hto_alice@test.com", password="pass123", nickname="Alice",
        )
        self.bob = User.objects.create_user(
            username="hto_bob", email="hto_bob@test.com", password="pass123", nickname="Bob",
        )
        self.carol = User.objects.create_user(
            username="hto_carol", email="hto_carol@test.com", password="pass123", nickname="Carol",
        )
        self.outsider = User.objects.create_user(
            username="hto_out", email="hto_out@test.com", password="pass123", nickname="Out",
        )
        self.organization = Organization.objects.create(
            name="Handoff TakeOver Test", owner=self.alice,
        )
        for u, role in [(self.alice, "owner"), (self.bob, "editor"), (self.carol, "editor")]:
            OrganizationMember.objects.create(organization=self.organization, user=u, role=role)
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.alice.id),
            name="Handoff TakeOver Group",
            member_ids=[str(self.bob.id), str(self.carol.id)],
        )
        # 接收人 bob 自己的执行目标（take-over 物化落点）
        self.bob_agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.bob,
            name="Bob Agent",
            settings={"default_mode": "agent"},
        )
        self.bob_workspace = _make_workspace(
            self.organization, self.bob, "Bob WS", "hto-bob-ws",
        )
        self.factory = RequestFactory()

    # ── 夹具：发起人 alice 的源 Agent 会话（含工具 + 附件块）──────────

    def _make_source_session(self, *, title="竞品调研会话"):
        session = ChatSession.objects.create(
            user=self.alice,
            organization_id=str(self.organization.id),
            title=title,
        )
        ChatMessage.objects.create(
            session=session, role="user",
            content_blocks_json=[
                {"type": "text", "text": "帮我调研 5 家竞品定价"},
                {"type": "file", "file_id": _ATTACHMENT_FILE_ID,
                 "filename": "202605.00197v1.pdf", "mime_type": "application/pdf",
                 "size": 243814,
                 "url": "http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.pdf"},
            ],
        )
        ChatMessage.objects.create(
            session=session, role="assistant",
            content_blocks_json=[
                {"type": "thinking", "thinking": "内心独白不应出现"},
                {"type": "tool_use", "name": "read_file",
                 "input": {"path": "/Users/secret/pricing.csv"}},
                {"type": "text", "text": "已整理出 5 家竞品的定价对比"},
            ],
        )
        return session

    def _create_and_send(self, *, scope=HandoffPackage.Scope.CONTINUABLE,
                         with_session=True, recipients=None, **overrides):
        references = []
        if with_session:
            source = self._make_source_session()
            references = [{"ref_type": "chat_session", "resource_id": str(source.id)}]
        params = dict(
            conversation_id=str(self.conv.id),
            actor_user_id=str(self.alice.id),
            goal="完成竞品分析报告",
            progress=[{"text": "已收集 5 家竞品数据"}],
            next_steps=[{"text": "补充定价对比", "checked": False}],
            scope=scope,
            recipients=recipients or [str(self.bob.id)],
            references=references,
        )
        params.update(overrides)
        package = HandoffService.create_package(**params)
        return HandoffService.send_package(
            package_id=str(package.id), actor_user_id=str(self.alice.id),
        )

    def _take_over(self, package, *, user=None, agent=None, workspace=None):
        user = user or self.bob
        return HandoffService.take_over_session(
            package_id=str(package.id),
            actor_user_id=str(user.id),
            agent_id=str((agent or self.bob_agent).id),
            workspace_id=str((workspace or self.bob_workspace).id),
        )

    def _call_endpoint(self, package, *, user=None, agent_id=None, workspace_id=None):
        user = user or self.bob
        request = self.factory.post(
            f"/api/im/handoffs/{package.id}/take-over-session",
        )
        request.auth = user
        return take_over_handoff_session(
            request,
            str(package.id),
            TakeOverSessionRequest(
                agent_id=str(agent_id or self.bob_agent.id),
                workspace_id=str(workspace_id or self.bob_workspace.id),
            ),
        )


class HandoffScopeEnforcementTests(HandoffTakeOverTestBase):
    """scope=view_only：act 老路径与新端点双路都拒绝接手。"""

    def test_act_take_over_rejected_for_view_only(self):
        package = self._create_and_send(scope=HandoffPackage.Scope.VIEW_ONLY)
        with self.assertRaisesRegex(ValueError, "仅查看"):
            HandoffService.act(
                package_id=str(package.id), actor_user_id=str(self.bob.id),
                action="take_over",
            )

    def test_act_acknowledge_still_allowed_for_view_only(self):
        package = self._create_and_send(scope=HandoffPackage.Scope.VIEW_ONLY)
        data = HandoffService.act(
            package_id=str(package.id), actor_user_id=str(self.bob.id),
            action="acknowledge",
        )
        self.assertEqual(data["recipients"][0]["state"], "acknowledged")

    def test_take_over_session_rejected_for_view_only(self):
        package = self._create_and_send(scope=HandoffPackage.Scope.VIEW_ONLY)
        with self.assertRaisesRegex(ValueError, "仅查看"):
            self._take_over(package)

    def test_endpoint_rejects_view_only(self):
        package = self._create_and_send(scope=HandoffPackage.Scope.VIEW_ONLY)
        response = self._call_endpoint(package)
        self.assertFalse(response.success)
        self.assertEqual(response.code, 400)
        self.assertIn("仅查看", response.message)

    def test_scope_present_in_serialization(self):
        package = self._create_and_send(scope=HandoffPackage.Scope.VIEW_ONLY)
        data = HandoffService.serialize_package(
            package, viewer_user_id=str(self.bob.id),
        )
        self.assertEqual(data["scope"], "view_only")


class HandoffTakeOverSessionTests(HandoffTakeOverTestBase):
    """take-over-session：冻结快照物化成接收人自己的新会话。"""

    def test_take_over_session_happy_path(self):
        package = self._create_and_send()
        session = self._take_over(package)

        # 会话归接收人自己的 Agent × Workspace
        self.assertEqual(str(session.user_id), str(self.bob.id))
        self.assertEqual(str(session.agent_id), str(self.bob_agent.id))
        self.assertEqual(str(session.workspace_id), str(self.bob_workspace.id))
        self.assertEqual(session.organization_id, str(self.organization.id))
        self.assertEqual(session.title, "[接力] 完成竞品分析报告")
        # agent_mode 取接收人 Agent 模板默认
        self.assertEqual(session.agent_mode, "agent")

        messages = list(session.messages.order_by("created_at", "id"))
        snapshots = [m for m in messages if (m.metadata or {}).get("share_snapshot")]
        briefings = [m for m in messages if (m.metadata or {}).get("share_briefing")]
        contracts = [m for m in messages if (m.metadata or {}).get("share_contract")]
        self.assertEqual(len(snapshots), 2)
        self.assertEqual(len(briefings), 1)
        self.assertEqual(len(contracts), 1)
        self.assertEqual([m.role for m in snapshots], ["user", "assistant"])

        # 快照消息带结构化附件块，接手后 Agent 可按 file_id 读取全文。
        user_text = snapshots[0].content_blocks_json[0]["text"]
        self.assertIn("帮我调研 5 家竞品定价", user_text)
        self.assertEqual(snapshots[0].content_blocks_json[1]["type"], "file")
        self.assertEqual(
            snapshots[0].content_blocks_json[1]["file_id"], _ATTACHMENT_FILE_ID,
        )
        # 快照消息带结构化工具块；不携带思考过程与工具参数
        assistant_blocks = snapshots[1].content_blocks_json
        self.assertEqual(assistant_blocks[0]["type"], "tool_use")
        self.assertEqual(assistant_blocks[0]["name"], "read_file")
        self.assertEqual(assistant_blocks[0]["label"], "读取文件")
        self.assertEqual(assistant_blocks[0]["input"], {})
        self.assertTrue(assistant_blocks[0]["id"].startswith("tu_"))
        assistant_text = assistant_blocks[1]["text"]
        self.assertIn("已整理出 5 家竞品的定价对比", assistant_text)
        assistant_json = json.dumps(assistant_blocks, ensure_ascii=False)
        self.assertNotIn("工具：读取文件", assistant_json)
        self.assertNotIn("内心独白", assistant_json)
        self.assertNotIn("/Users/secret", assistant_json)

        # briefing 人可读来源说明；契约带 handoff-take-over 元数据
        briefing_text = briefings[0].content_blocks_json[0]["text"]
        self.assertIn("的交接《完成竞品分析报告》", briefing_text)
        contract_text = contracts[0].content_blocks_json[0]["text"]
        self.assertIn("handoff-take-over", contract_text)
        self.assertIn(str(package.id), contract_text)
        # source_meta 落到消息 metadata，供审计追溯
        self.assertEqual(
            (snapshots[0].metadata or {}).get("source"),
            {"source_type": "handoff", "source_id": str(package.id)},
        )

        # 接收者状态迁移 + linked_session_id 回填 + 审计 + 广播
        recipient = package.recipients.get(user_id=str(self.bob.id))
        self.assertEqual(recipient.state, HandoffRecipient.State.TAKING_OVER)
        self.assertEqual(recipient.linked_session_id, str(session.id))
        event = package.events.filter(
            event_type=HandoffEvent.EventType.TAKEN_OVER,
            actor_user_id=str(self.bob.id),
        ).get()
        self.assertEqual(event.payload_json["linked_session_id"], str(session.id))
        self.assertTrue(
            IMEventOutbox.objects.filter(
                event_type="im.handoff.update", conversation=self.conv,
            ).exists()
        )

    def test_take_over_turns_keeps_tools_as_structured_blocks(self):
        turns = HandoffService._compose_take_over_turns([
            {
                "role": "assistant",
                "tools": [
                    {"name": "run_terminal_command", "label": "run_terminal_command"},
                ],
            },
            {
                "role": "assistant",
                "tools": [{"name": "skills_read", "label": "skills_read"}],
            },
            {
                "role": "assistant",
                "text": "已完成资料整理",
                "tools": [{"name": "read_file", "label": "读取文件"}],
            },
        ])

        all_text = "\n".join(turn["text"] for turn in turns)
        all_blocks = json.dumps([turn["blocks"] for turn in turns], ensure_ascii=False)
        self.assertEqual(len(turns), 3)
        self.assertIn("已完成资料整理", all_text)
        self.assertIn('"type": "tool_use"', all_blocks)
        self.assertIn('"name": "run_terminal_command"', all_blocks)
        self.assertIn('"name": "skills_read"', all_blocks)
        self.assertIn('"name": "read_file"', all_blocks)
        self.assertIn('"label": "读取文件"', all_blocks)
        self.assertNotIn("工具：读取文件", all_blocks)
        self.assertNotIn("run_terminal_command", all_text)
        self.assertNotIn("skills_read", all_text)
        tool_ids = [
            block["id"]
            for turn in turns
            for block in turn["blocks"]
            if isinstance(block, dict)
            and str(block.get("type") or "").endswith("tool_use")
        ]
        self.assertEqual(len(tool_ids), len(set(tool_ids)))

    def test_take_over_session_idempotent(self):
        package = self._create_and_send()
        first = self._take_over(package)
        again = self._take_over(package)
        self.assertEqual(str(first.id), str(again.id))
        self.assertEqual(ChatSession.objects.filter(user=self.bob).count(), 1)
        self.assertEqual(
            package.events.filter(
                event_type=HandoffEvent.EventType.TAKEN_OVER,
            ).count(),
            1,
        )

    def test_linked_session_deleted_allows_rebuild(self):
        package = self._create_and_send()
        first = self._take_over(package)
        ChatSession.objects.filter(id=first.id).delete()
        rebuilt = self._take_over(package)
        self.assertNotEqual(str(rebuilt.id), str(first.id))
        recipient = package.recipients.get(user_id=str(self.bob.id))
        self.assertEqual(recipient.linked_session_id, str(rebuilt.id))

    def test_act_take_over_still_works_without_session(self):
        """老按钮 act('take_over') 行为保持不变：只改状态，不建会话。"""
        package = self._create_and_send()
        data = HandoffService.act(
            package_id=str(package.id), actor_user_id=str(self.bob.id),
            action="take_over",
        )
        self.assertEqual(data["recipients"][0]["state"], "taking_over")
        self.assertEqual(ChatSession.objects.filter(user=self.bob).count(), 0)
        recipient = package.recipients.get(user_id=str(self.bob.id))
        self.assertEqual(recipient.linked_session_id, "")

    def test_take_over_after_act_backfills_linked_session(self):
        """先按过老按钮（taking_over）再走新端点：幂等重入并回填会话。"""
        package = self._create_and_send()
        HandoffService.act(
            package_id=str(package.id), actor_user_id=str(self.bob.id),
            action="take_over",
        )
        session = self._take_over(package)
        recipient = package.recipients.get(user_id=str(self.bob.id))
        self.assertEqual(recipient.state, HandoffRecipient.State.TAKING_OVER)
        self.assertEqual(recipient.linked_session_id, str(session.id))

    def test_same_org_non_recipient_can_take_over(self):
        """转发场景口径对齐 act()：同 org 用户可自行加入接收并接手。"""
        package = self._create_and_send()
        carol_agent = Agent.objects.create(
            organization=self.organization, owner_user=self.carol, name="Carol Agent",
        )
        carol_workspace = _make_workspace(
            self.organization, self.carol, "Carol WS", "hto-carol-ws",
        )
        session = self._take_over(
            package, user=self.carol, agent=carol_agent, workspace=carol_workspace,
        )
        self.assertEqual(str(session.user_id), str(self.carol.id))
        recipient = package.recipients.get(user_id=str(self.carol.id))
        self.assertEqual(recipient.state, HandoffRecipient.State.TAKING_OVER)
        self.assertEqual(recipient.linked_session_id, str(session.id))

    def test_outsider_cannot_take_over(self):
        package = self._create_and_send()
        with self.assertRaises(PermissionError):
            self._take_over(package, user=self.outsider)

    def test_rejected_recipient_cannot_take_over(self):
        package = self._create_and_send()
        HandoffService.act(
            package_id=str(package.id), actor_user_id=str(self.bob.id),
            action="reject", note="这周没空",
        )
        with self.assertRaisesRegex(ValueError, "不允许"):
            self._take_over(package)

    def test_revoked_package_rejected(self):
        package = self._create_and_send()
        HandoffService.revoke(
            package_id=str(package.id), actor_user_id=str(self.alice.id),
        )
        with self.assertRaisesRegex(ValueError, "已撤销"):
            self._take_over(package)

    def test_no_chat_session_snapshot_rejected(self):
        package = self._create_and_send(with_session=False)
        with self.assertRaisesRegex(ValueError, "没有可接手的会话快照"):
            self._take_over(package)


class HandoffTakeOverExecutionTargetTests(HandoffTakeOverTestBase):
    """agent / workspace 归属校验（与 shared-fork 公共 helper 同口径）。"""

    def test_agent_ownership_validated(self):
        package = self._create_and_send()
        alice_agent = Agent.objects.create(
            organization=self.organization, owner_user=self.alice, name="Alice Agent",
        )
        with self.assertRaises(ExecutionTargetError) as ctx:
            self._take_over(package, agent=alice_agent)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("Agent", str(ctx.exception))

    def test_cross_org_agent_rejected(self):
        package = self._create_and_send()
        other_org = Organization.objects.create(name="Other Org", owner=self.outsider)
        foreign_agent = Agent.objects.create(
            organization=other_org, owner_user=self.bob, name="Foreign Agent",
        )
        with self.assertRaises(ExecutionTargetError) as ctx:
            self._take_over(package, agent=foreign_agent)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Organization", str(ctx.exception))

    def test_workspace_ownership_validated(self):
        package = self._create_and_send()
        alice_workspace = _make_workspace(
            self.organization, self.alice, "Alice WS", "hto-alice-ws",
        )
        with self.assertRaises(ExecutionTargetError) as ctx:
            self._take_over(package, workspace=alice_workspace)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("Workspace", str(ctx.exception))

    def test_validation_failure_does_not_touch_recipient_session(self):
        """校验失败不落 linked_session_id、不写 TAKEN_OVER 事件。"""
        package = self._create_and_send()
        alice_agent = Agent.objects.create(
            organization=self.organization, owner_user=self.alice, name="Alice Agent 2",
        )
        with self.assertRaises(ExecutionTargetError):
            self._take_over(package, agent=alice_agent)
        recipient = package.recipients.get(user_id=str(self.bob.id))
        self.assertEqual(recipient.linked_session_id, "")
        self.assertFalse(
            package.events.filter(
                event_type=HandoffEvent.EventType.TAKEN_OVER,
            ).exists()
        )
        self.assertEqual(ChatSession.objects.filter(user=self.bob).count(), 0)


class HandoffTakeOverEndpointTests(HandoffTakeOverTestBase):
    """API 端点：响应结构对齐 shared-fork（ChatSessionSchema）。"""

    def test_endpoint_happy_path_returns_session_schema(self):
        package = self._create_and_send()
        response = self._call_endpoint(package)
        self.assertTrue(response.success, response.message)
        data = response.data
        session = ChatSession.objects.get(id=data["id"])
        self.assertEqual(str(session.user_id), str(self.bob.id))
        self.assertEqual(data["title"], "[接力] 完成竞品分析报告")
        self.assertEqual(data["agent_id"], str(self.bob_agent.id))
        self.assertEqual(data["workspace_id"], str(self.bob_workspace.id))
        # 响应可 JSON 序列化（前端契约）
        json.dumps(data)

    def test_endpoint_maps_execution_target_error_status(self):
        package = self._create_and_send()
        alice_agent = Agent.objects.create(
            organization=self.organization, owner_user=self.alice, name="Alice Agent 3",
        )
        response = self._call_endpoint(package, agent_id=alice_agent.id)
        self.assertFalse(response.success)
        self.assertEqual(response.code, 403)
        self.assertIn("Agent", response.message)

    def test_endpoint_idempotent_returns_same_session(self):
        package = self._create_and_send()
        first = self._call_endpoint(package)
        again = self._call_endpoint(package)
        self.assertTrue(first.success and again.success)
        self.assertEqual(first.data["id"], again.data["id"])
