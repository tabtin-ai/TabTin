"""
团队 Space 动态流（阶段3）测试

覆盖：
  1. record_team_space_activity 写入契约：team_space 记录 / 非 team_space 跳过 /
     未知事件类型拒绝 / 异常不冒泡
  2. 业务埋点：成员加入/退出/角色变更（SpaceAccessService）、资产上传
     （TabFilesService）、设置变更（SpaceService.update_space）
  3. Agent run 留痕：relay_trace_writer 的 _resolve_team_space_for_activity /
     _record_team_space_run_activity
  4. 列表读取：分页 + viewer 权限 + 非成员拒绝
"""
from __future__ import annotations

from uuid import uuid4
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings


class SpaceActivityTestBase(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization

        cls._post_save = post_save
        cls._create_default_organization = create_default_organization
        post_save.disconnect(create_default_organization, sender=get_user_model())

    @classmethod
    def tearDownClass(cls):
        cls._post_save.connect(cls._create_default_organization, sender=get_user_model())
        super().tearDownClass()

    def setUp(self):
        from apps.tabtinspace.models import Space, SpaceMembership, Organization, OrganizationMember, ProjectMembership

        # 注意：不要沿用旧测试的 `.using("postgresql").bulk_create(users)` 双写
        # pattern——single_pg 模式下真 PG 跑测试时（USE_SQLITE_FOR_TESTS=0），
        # default 与 postgresql 是同库的两条独立连接，双写会在唯一键上互等
        # 未提交事务的锁，测试永久挂起。业务代码只走 default（见
        # postgres_app_db_alias），无需双写。
        self.owner = self._user("owner")
        self.member = self._user("member")
        self.outsider = self._user("outsider")

        self.organization = Organization.objects.create(
            name="Activity Team",
            owner=self.owner,
            type="team",
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.member, role="editor")

        self.execution_space = Space.objects.create(
            organization=self.organization,
            name="Owner execution",
            status="active",
            type=Space.SpaceType.WORKSPACE,
        )
        SpaceMembership.objects.create(
            workspace=self.execution_space, user=self.owner, role="owner", is_active=True,
        )
        self.team_space = Space.objects.create(
            organization=self.organization,
            name="Activity Room",
            status="active",
            type=Space.SpaceType.TEAM_SPACE,
            execution_space=self.execution_space,
            visibility="shared",
        )
        ProjectMembership.objects.create(
            project=self.team_space, user=self.owner, role="owner", is_active=True,
        )

    @staticmethod
    def _user(prefix: str):
        User = get_user_model()
        return User.objects.create_user(
            phone=f"+86138{uuid4().int % 100000000:08d}",
            password="x",
            nickname=f"act-{prefix}",
        )

    def _events(self, space=None):
        from apps.tabtinspace.models import SpaceActivityEvent

        return list(
            SpaceActivityEvent.objects.filter(
                space_id=(space or self.team_space).id
            ).order_by("created_at")
        )


class RecordTeamSpaceActivityTests(SpaceActivityTestBase):
    """record_team_space_activity 写入契约。"""

    def test_records_event_for_team_space(self):
        from apps.tabtinspace.models import SpaceActivityEvent
        from apps.tabtinspace.services.space_activity_service import record_team_space_activity

        event = record_team_space_activity(
            self.team_space,
            SpaceActivityEvent.EventType.MEMBER_JOINED,
            actor_user=self.owner,
            target_type="member",
            target_id=str(self.member.id),
            target_name="act-member",
            metadata={"role": "editor"},
        )

        self.assertIsNotNone(event)
        self.assertEqual(event.space_id, self.team_space.id)
        self.assertEqual(event.organization_id, self.organization.id)
        self.assertEqual(event.actor_user_id, str(self.owner.id))
        self.assertEqual(event.actor_name, "act-owner")
        self.assertEqual(event.metadata, {"role": "editor"})

    def test_skips_non_team_space(self):
        from apps.tabtinspace.models import SpaceActivityEvent
        from apps.tabtinspace.services.space_activity_service import record_team_space_activity

        event = record_team_space_activity(
            self.execution_space,
            SpaceActivityEvent.EventType.MEMBER_JOINED,
            actor_user=self.owner,
        )

        self.assertIsNone(event)
        self.assertEqual(self._events(self.execution_space), [])

    def test_rejects_unknown_event_type(self):
        from apps.tabtinspace.services.space_activity_service import record_team_space_activity

        event = record_team_space_activity(self.team_space, "made_up_event")

        self.assertIsNone(event)
        self.assertEqual(self._events(), [])

    def test_never_raises_on_failure(self):
        from apps.tabtinspace.models import SpaceActivityEvent
        from apps.tabtinspace.services.space_activity_service import record_team_space_activity

        with patch(
            "apps.tabtinspace.services.space_activity_service.SpaceActivityEvent.objects.create",
            side_effect=RuntimeError("db down"),
        ):
            event = record_team_space_activity(
                self.team_space,
                SpaceActivityEvent.EventType.MEMBER_JOINED,
                actor_user=self.owner,
            )

        self.assertIsNone(event)


class TabDocAssetActivityTests(SpaceActivityTestBase):
    """Team Space TabDoc 资产动态的幂等性。"""

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_tabdoc_update_does_not_duplicate_asset_created_activity(self, _mock_update_search):
        from apps.tabdoc.models import Document
        from apps.tabtinspace.models import ContextItem, SpaceActivityEvent
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.team_space.id,
            owner_id=self.owner.id,
            title="团队交付文档",
            description_json={"type": "doc", "content": []},
            description_markdown="# 团队交付文档",
            description_plaintext="团队交付文档",
            latest_version=1,
            created_by=self.owner,
            updated_by=self.owner,
        )
        ResourceBridge.on_create(document, user=self.owner)

        item = ContextItem.objects.get(
            space_id=self.team_space.id,
            item_type="tabdoc",
            resource_id=str(document.id),
        )
        self.assertEqual(item.metadata.get("asset_kind"), "tabdoc")

        document.title = "团队交付文档 v2"
        document.description_plaintext = "更新后的团队交付文档"
        document.save(update_fields=["title", "description_plaintext", "updated_at"])
        with patch("apps.services.common.ws.bus.publish_ws_event") as publish_ws_event:
            ResourceBridge.on_update(document, user=self.owner)

        item.refresh_from_db()
        events = SpaceActivityEvent.objects.filter(
            space_id=self.team_space.id,
            event_type=SpaceActivityEvent.EventType.ASSET_CREATED,
            target_id=str(item.id),
        )
        self.assertEqual(events.count(), 1)
        self.assertEqual(item.metadata.get("asset_kind"), "tabdoc")
        self.assertEqual(item.metadata.get("asset_source", {}).get("kind"), "ai_deliverable")
        updated_envelopes = [
            call.kwargs["envelope"]
            for call in publish_ws_event.call_args_list
            if call.kwargs["envelope"]["type"] == "resource_updated"
        ]
        self.assertTrue(updated_envelopes)
        self.assertTrue(
            all(
                envelope["metadata"].get("asset_kind") == "tabdoc"
                and envelope["metadata"].get("asset_source", {}).get("kind") == "ai_deliverable"
                for envelope in updated_envelopes
            )
        )

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_tabdoc_update_repairs_missing_asset_source_without_new_activity(self, _mock_update_search):
        from apps.tabdoc.models import Document
        from apps.tabtinspace.models import ContextItem, SpaceActivityEvent
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.team_space.id,
            owner_id=self.owner.id,
            title="待补齐资产来源的文档",
            description_json={"type": "doc", "content": []},
            description_markdown="# 待补齐资产来源的文档",
            description_plaintext="待补齐资产来源的文档",
            latest_version=1,
            created_by=self.owner,
            updated_by=self.owner,
        )
        ResourceBridge.on_create(document, user=self.owner)

        item = ContextItem.objects.get(
            space_id=self.team_space.id,
            item_type="tabdoc",
            resource_id=str(document.id),
        )
        item.metadata = {"asset_kind": "tabdoc", "asset_source": {}}
        item.save(update_fields=["metadata", "updated_at"])

        ResourceBridge.on_update(document, user=self.owner)

        item.refresh_from_db()
        events = SpaceActivityEvent.objects.filter(
            space_id=self.team_space.id,
            event_type=SpaceActivityEvent.EventType.ASSET_CREATED,
            target_id=str(item.id),
        )
        self.assertEqual(events.count(), 1)
        self.assertEqual(item.metadata.get("asset_kind"), "tabdoc")
        self.assertEqual(item.metadata.get("asset_source", {}).get("kind"), "ai_deliverable")


class MembershipActivityHookTests(SpaceActivityTestBase):
    """成员加入/退出/角色变更埋点（on_commit 后写入）。"""

    def test_add_member_records_member_joined(self):
        from apps.tabtinspace.services.access_service import SpaceAccessService

        with self.captureOnCommitCallbacks(execute=True):
            SpaceAccessService(user=self.owner).add_space_membership(
                self.team_space.id,
                user_id=str(self.member.id),
                role="editor",
            )

        events = self._events()
        self.assertEqual([e.event_type for e in events], ["member_joined"])
        event = events[0]
        self.assertEqual(event.actor_user_id, str(self.owner.id))
        self.assertEqual(event.target_type, "member")
        self.assertEqual(event.target_id, str(self.member.id))
        self.assertEqual(event.target_name, "act-member")
        self.assertEqual(event.metadata, {"role": "editor"})

    def test_role_change_records_member_role_changed(self):
        from apps.tabtinspace.services.access_service import SpaceAccessService

        service = SpaceAccessService(user=self.owner)
        with self.captureOnCommitCallbacks(execute=True):
            service.add_space_membership(
                self.team_space.id, user_id=str(self.member.id), role="viewer",
            )
        with self.captureOnCommitCallbacks(execute=True):
            service.add_space_membership(
                self.team_space.id, user_id=str(self.member.id), role="editor",
            )

        events = self._events()
        self.assertEqual(
            [e.event_type for e in events],
            ["member_joined", "member_role_changed"],
        )
        self.assertEqual(
            events[1].metadata,
            {"old_role": "viewer", "new_role": "editor"},
        )

    def test_project_member_removal_is_deferred_without_member_left_activity(self):
        from apps.tabtinspace.services.access_service import SpaceAccessService
        from apps.tabtinspace.services.base import ServiceError

        service = SpaceAccessService(user=self.owner)
        with self.captureOnCommitCallbacks(execute=True):
            membership = service.add_space_membership(
                self.team_space.id, user_id=str(self.member.id), role="editor",
            )
        with self.assertRaises(ServiceError) as context:
            with self.captureOnCommitCallbacks(execute=True):
                service.remove_space_membership(self.team_space.id, membership.id)

        self.assertEqual(context.exception.code, "PROJECT_MEMBERSHIP_REMOVAL_DEFERRED")
        membership.refresh_from_db()
        self.assertTrue(membership.is_active)
        events = self._events()
        self.assertEqual([e.event_type for e in events], ["member_joined"])


class AssetActivityHookTests(SpaceActivityTestBase):
    """资产上传/归档埋点。"""

    def _file_record(self, *, upload_user: str):
        from apps.services.oss.models import FileRecord

        suffix = uuid4().hex
        return FileRecord.objects.create(
            file_name=f"{suffix}.txt",
            file_key=f"activity/{suffix}.txt",
            file_path=f"/tmp/{suffix}.txt",
            file_size=32,
            file_type="document",
            mime_type="text/plain",
            file_extension=".txt",
            file_hash=suffix,
            bucket_name="test-bucket",
            upload_user=upload_user,
            organization_id=str(self.organization.id),
            status="completed",
        )

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_upload_records_asset_created(self, _mock_search):
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        file_record = self._file_record(upload_user=str(self.owner.id))
        with self.captureOnCommitCallbacks(execute=True):
            item = TabFilesService(user=self.owner).upload_to_space(
                space_id=self.team_space.id,
                file_record_id=file_record.id,
            )

        events = self._events()
        self.assertEqual([e.event_type for e in events], ["asset_created"])
        event = events[0]
        self.assertEqual(event.target_type, "asset")
        self.assertEqual(event.target_id, str(item.id))
        self.assertEqual(event.metadata["source_kind"], "member_upload")

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_duplicate_upload_does_not_record_twice(self, _mock_search):
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        file_record = self._file_record(upload_user=str(self.owner.id))
        service = TabFilesService(user=self.owner)
        with self.captureOnCommitCallbacks(execute=True):
            service.upload_to_space(space_id=self.team_space.id, file_record_id=file_record.id)
        with self.captureOnCommitCallbacks(execute=True):
            service.upload_to_space(space_id=self.team_space.id, file_record_id=file_record.id)

        self.assertEqual(len(self._events()), 1)

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_archive_records_asset_archived(self, _mock_search):
        from apps.tabtinspace.services.context_item_service import ContextItemService
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        file_record = self._file_record(upload_user=str(self.owner.id))
        with self.captureOnCommitCallbacks(execute=True):
            item = TabFilesService(user=self.owner).upload_to_space(
                space_id=self.team_space.id,
                file_record_id=file_record.id,
            )
        with self.captureOnCommitCallbacks(execute=True):
            ContextItemService(user=self.owner).archive_item(item.id)

        events = self._events()
        self.assertEqual(
            [e.event_type for e in events],
            ["asset_created", "asset_archived"],
        )
        self.assertEqual(events[1].target_id, str(item.id))

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_ai_final_answer_publish_records_asset_created(self, _mock_search):
        from apps.chat.conversation.models import ChatMessage, ChatSession
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            space=self.team_space,
            title="Launch plan",
        )
        message = ChatMessage.objects.create(
            session=session,
            role="assistant",
            message_kind="llm",
            text_summary="最终结论：明天发布。",
            content_blocks_json=[{"type": "text", "text": "最终结论：明天发布。"}],
            stop_reason="end_turn",
        )

        with self.captureOnCommitCallbacks(execute=True):
            published = TabFilesService.publish_message_assets(message.id)

        self.assertEqual(len(published), 1)
        events = self._events()
        self.assertEqual([e.event_type for e in events], ["asset_created"])
        self.assertEqual(events[0].metadata["source_kind"], "ai_final_answer")


@override_settings(TABTIN_ENABLE_PROJECTS=True)
class SpaceSettingsActivityHookTests(SpaceActivityTestBase):
    """设置变更 + 团队 Space 创建埋点。"""

    def test_update_space_records_settings_updated(self):
        from apps.tabtinspace.services.space_service import SpaceService

        with self.captureOnCommitCallbacks(execute=True):
            SpaceService(user=self.owner).update_space(
                self.team_space.id,
                name="Renamed Room",
                description="new desc",
            )

        events = self._events()
        self.assertEqual([e.event_type for e in events], ["settings_updated"])
        metadata = events[0].metadata
        self.assertEqual(set(metadata["changed_fields"]), {"name", "description"})
        self.assertEqual(metadata["old_name"], "Activity Room")
        self.assertEqual(metadata["new_name"], "Renamed Room")

    def test_noop_update_does_not_record(self):
        from apps.tabtinspace.services.space_service import SpaceService

        with self.captureOnCommitCallbacks(execute=True):
            SpaceService(user=self.owner).update_space(
                self.team_space.id,
                name="Activity Room",
            )

        self.assertEqual(self._events(), [])

    def test_workspace_update_does_not_record(self):
        from apps.tabtinspace.services.space_service import SpaceService

        with self.captureOnCommitCallbacks(execute=True):
            SpaceService(user=self.owner).update_space(
                self.execution_space.id,
                name="Renamed execution",
            )

        self.assertEqual(self._events(self.execution_space), [])

    def test_create_team_space_records_space_created(self):
        from apps.tabtinspace.services.space_service import SpaceService

        with self.captureOnCommitCallbacks(execute=True):
            space = SpaceService(user=self.owner).create_space(
                organization_id=self.organization.id,
                name="Second Room",
                space_type="team_space",
                execution_space_id=self.execution_space.id,
            )

        events = self._events(space)
        # Project 创建会同步供给两个默认讨论频道，因此这里还会有合法的
        # channel_created 动态；本用例只验证 Project 本身恰好留下一条创建记录。
        created_events = [event for event in events if event.event_type == "space_created"]
        self.assertEqual(len(created_events), 1)
        self.assertEqual(created_events[0].actor_user_id, str(self.owner.id))
        self.assertEqual(created_events[0].target_name, "Second Room")


class AgentRunActivityHookTests(SpaceActivityTestBase):
    """relay_trace_writer 的 run 留痕辅助函数。"""

    def test_resolve_team_space_returns_direct_project_and_companion_project(self):
        from apps.services.common.ws.handlers.relay_trace_writer import (
            _resolve_team_space_for_activity,
        )
        from apps.tabtinspace.models import Space

        resolved = _resolve_team_space_for_activity(str(self.team_space.id))
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.id, self.team_space.id)

        companion_space = Space.objects.create(
            organization=self.organization,
            name="Member project execution",
            status="active",
            type=Space.SpaceType.WORKSPACE,
            project=self.team_space,
        )
        resolved_from_companion = _resolve_team_space_for_activity(
            str(companion_space.id)
        )
        self.assertIsNotNone(resolved_from_companion)
        self.assertEqual(resolved_from_companion.id, self.team_space.id)

        self.assertIsNone(_resolve_team_space_for_activity(str(self.execution_space.id)))
        self.assertIsNone(_resolve_team_space_for_activity(None))

    def test_run_started_and_completed_events(self):
        from apps.services.common.ws.handlers.relay_trace_writer import (
            _record_team_space_run_activity,
        )

        trace_id = str(uuid4())
        _record_team_space_run_activity(
            self.team_space,
            actor_user_id=str(self.member.id),
            session_id=str(uuid4()),
            session_title="部署检查",
            trace_id=trace_id,
            run_started=True,
            finalize=None,
        )
        _record_team_space_run_activity(
            self.team_space,
            actor_user_id=str(self.member.id),
            session_id=str(uuid4()),
            session_title="部署检查",
            trace_id=trace_id,
            run_started=False,
            finalize=("completed", None, "lifecycle"),
        )

        events = self._events()
        self.assertEqual(
            [e.event_type for e in events],
            ["agent_run_started", "agent_run_completed"],
        )
        self.assertEqual(events[0].actor_user_id, str(self.member.id))
        self.assertEqual(events[0].target_id, trace_id)
        self.assertEqual(events[0].target_name, "部署检查")

    def test_run_failed_event_carries_error(self):
        from apps.services.common.ws.handlers.relay_trace_writer import (
            _record_team_space_run_activity,
        )

        _record_team_space_run_activity(
            self.team_space,
            actor_user_id=str(self.member.id),
            session_id=str(uuid4()),
            session_title="失败任务",
            trace_id=str(uuid4()),
            run_started=False,
            finalize=("error", "boom", "done"),
        )

        events = self._events()
        self.assertEqual([e.event_type for e in events], ["agent_run_failed"])
        self.assertEqual(events[0].metadata["error"], "boom")

    def test_run_completion_posts_agent_updates_message(self):
        from apps.services.common.ws.handlers.relay_trace_writer import (
            _record_team_space_run_activity,
        )
        from apps.tabchat.models import Conversation, Message
        from apps.tabtinspace.models import SpaceMembership

        ProjectMembership.objects.create(
            project=self.team_space, user=self.member, role="editor", is_active=True,
        )
        updates_channel = Conversation.objects.create(
            organization_id=str(self.organization.id),
            space_id=self.team_space.id,
            name="#agent-updates",
            created_by=str(self.owner.id),
            member_count=0,
        )
        session_id = str(uuid4())
        trace_id = str(uuid4())

        _record_team_space_run_activity(
            self.team_space,
            actor_user_id=str(self.member.id),
            session_id=session_id,
            session_title="上线复盘",
            trace_id=trace_id,
            run_started=False,
            finalize=("completed", None, "done"),
        )

        message = Message.objects.get(conversation=updates_channel)
        self.assertEqual(message.message_type, 1)
        self.assertIn("Agent 任务已完成：上线复盘", message.content)
        self.assertEqual(message.metadata["session_id"], session_id)
        self.assertEqual(message.metadata["trace_id"], trace_id)
        self.assertTrue(message.metadata["team_space_agent_update"])

    def test_run_failure_does_not_post_agent_updates_message(self):
        from apps.services.common.ws.handlers.relay_trace_writer import (
            _record_team_space_run_activity,
        )
        from apps.tabchat.models import Conversation, Message
        from apps.tabtinspace.models import SpaceMembership

        ProjectMembership.objects.create(
            project=self.team_space, user=self.member, role="editor", is_active=True,
        )
        Conversation.objects.create(
            organization_id=str(self.organization.id),
            space_id=self.team_space.id,
            name="#agent-updates",
            created_by=str(self.owner.id),
            member_count=0,
        )
        trace_id = str(uuid4())

        _record_team_space_run_activity(
            self.team_space,
            actor_user_id=str(self.member.id),
            session_id=str(uuid4()),
            session_title="上线复盘",
            trace_id=trace_id,
            run_started=False,
            finalize=("error", "boom", "done"),
        )

        self.assertEqual(Message.objects.filter(metadata__team_space_agent_update=True).count(), 0)


class ListActivitiesTests(SpaceActivityTestBase):
    """列表读取：分页 + 权限。"""

    def _seed_events(self, count: int):
        from apps.tabtinspace.models import SpaceActivityEvent
        from apps.tabtinspace.services.space_activity_service import record_team_space_activity

        for i in range(count):
            record_team_space_activity(
                self.team_space,
                SpaceActivityEvent.EventType.ASSET_CREATED,
                actor_user=self.owner,
                target_type="asset",
                target_id=str(uuid4()),
                target_name=f"asset-{i}",
            )

    def test_pagination_returns_newest_first(self):
        from apps.tabtinspace.services.space_activity_service import SpaceActivityService

        self._seed_events(5)
        service = SpaceActivityService(user=self.owner)

        page1 = service.list_activities(self.team_space.id, page=1, limit=3)
        self.assertEqual(page1["total"], 5)
        self.assertEqual(len(page1["items"]), 3)
        self.assertEqual(page1["items"][0]["target_name"], "asset-4")

        page2 = service.list_activities(self.team_space.id, page=2, limit=3)
        self.assertEqual(len(page2["items"]), 2)
        self.assertEqual(page2["items"][-1]["target_name"], "asset-0")

    def test_limit_is_capped(self):
        from apps.tabtinspace.services.space_activity_service import (
            MAX_ACTIVITY_PAGE_SIZE,
            SpaceActivityService,
        )

        result = SpaceActivityService(user=self.owner).list_activities(
            self.team_space.id, page=1, limit=10_000,
        )
        self.assertEqual(result["limit"], MAX_ACTIVITY_PAGE_SIZE)

    def test_legacy_task_level_agent_start_is_hidden(self):
        from apps.tabtinspace.models import SpaceActivityEvent
        from apps.tabtinspace.services.space_activity_service import (
            SpaceActivityService,
            record_team_space_activity,
        )

        record_team_space_activity(
            self.team_space,
            SpaceActivityEvent.EventType.AGENT_RUN_STARTED,
            actor_user=self.owner,
            target_type="task",
            target_id=str(uuid4()),
            target_name="Legacy task start",
        )
        record_team_space_activity(
            self.team_space,
            SpaceActivityEvent.EventType.AGENT_RUN_STARTED,
            actor_user=self.owner,
            target_type="agent_run",
            target_id=str(uuid4()),
            target_name="Runtime start",
        )

        result = SpaceActivityService(user=self.owner).list_activities(self.team_space.id)

        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["target_name"], "Runtime start")

    def test_member_with_viewer_role_can_read(self):
        from apps.tabtinspace.models import SpaceMembership
        from apps.tabtinspace.services.space_activity_service import SpaceActivityService

        ProjectMembership.objects.create(
            project=self.team_space, user=self.member, role="viewer", is_active=True,
        )
        self._seed_events(1)

        result = SpaceActivityService(user=self.member).list_activities(self.team_space.id)
        self.assertEqual(result["total"], 1)

    def test_outsider_is_denied(self):
        from apps.tabtinspace.services.base import ServiceError
        from apps.tabtinspace.services.space_activity_service import SpaceActivityService

        with self.assertRaises(ServiceError) as ctx:
            SpaceActivityService(user=self.outsider).list_activities(self.team_space.id)
        self.assertEqual(ctx.exception.code, "PERMISSION_DENIED")
