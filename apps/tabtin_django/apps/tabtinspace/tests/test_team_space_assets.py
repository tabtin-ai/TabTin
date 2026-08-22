from __future__ import annotations

from uuid import uuid4
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase


class TeamSpaceAssetTests(TestCase):
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
        from apps.tabtinspace.models import Device, Space, SpaceMembership, Organization, OrganizationMember, ProjectMembership

        self.owner = self._user("owner")
        self.invited = self._user("invited")
        self.removed = self._user("removed")
        # single_pg 下 default / postgresql 是同一物理库的两条连接；把 default
        # 事务里刚插入的用户再从 postgresql alias bulk_create，会互等未提交锁。
        # 业务代码统一走 postgres_app_db_alias，测试夹具只写一次即可。

        self.organization = Organization.objects.create(
            name="Team Space Assets",
            owner=self.owner,
            type="team",
        )
        for user, role in (
            (self.owner, "owner"),
            (self.invited, "editor"),
            (self.removed, "editor"),
        ):
            OrganizationMember.objects.create(organization=self.organization, user=user, role=role)

        self.offline_device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Offline Mac",
            fingerprint=f"asset-test-{uuid4()}",
            status="offline",
        )
        self.execution_space = Space.objects.create(
            organization=self.organization,
            name="Owner execution",
            status="active",
            type=Space.SpaceType.WORKSPACE,
            bound_device=self.offline_device,
            control_device=self.offline_device,
        )
        self.team_space = Space.objects.create(
            organization=self.organization,
            name="Shared deliverables",
            status="active",
            type=Space.SpaceType.TEAM_SPACE,
            execution_space=self.execution_space,
            visibility="shared",
        )
        for user, role in (
            (self.owner, "owner"),
            (self.invited, "editor"),
            (self.removed, "editor"),
        ):
            ProjectMembership.objects.create(
                project=self.team_space,
                user=user,
                role=role,
                is_active=True,
            )

    @staticmethod
    def _user(prefix: str):
        User = get_user_model()
        return User.objects.create_user(
            phone=f"+86139{uuid4().int % 100000000:08d}",
            password="x",
            nickname=f"asset-{prefix}",
        )

    def _file_record(self, *, upload_user: str):
        from apps.services.oss.models import FileRecord

        suffix = uuid4().hex
        return FileRecord.objects.create(
            file_name=f"{suffix}.txt",
            file_key=f"team-assets/{suffix}.txt",
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
    def test_invited_member_can_upload_list_and_open_team_space_asset(self, _mock_update_search):
        from apps.tabtinspace.services.context_item_service import ContextItemService
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        file_record = self._file_record(upload_user=str(self.invited.id))

        item = TabFilesService(user=self.invited).upload_to_space(
            space_id=self.team_space.id,
            file_record_id=file_record.id,
        )

        self.assertIsNotNone(item)
        self.assertEqual(item.metadata["asset_source"]["kind"], "member_upload")
        self.assertEqual(item.metadata["asset_source"]["member_user_id"], str(self.invited.id))

        items, total = ContextItemService(user=self.invited).list_items(
            space_id=self.team_space.id,
            item_type="tabfiles",
        )
        self.assertEqual(total, 1)
        self.assertEqual(items[0].id, item.id)
        self.assertIsNotNone(ContextItemService(user=self.invited).get_item(item.id))

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_removed_member_loses_asset_list_open_and_upload_access(self, _mock_update_search):
        from apps.tabtinspace.models import OrganizationMember
        from apps.tabtinspace.services.context_item_service import ContextItemService
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        file_record = self._file_record(upload_user=str(self.owner.id))
        item = TabFilesService(user=self.owner).upload_to_space(
            space_id=self.team_space.id,
            file_record_id=file_record.id,
        )
        OrganizationMember.objects.filter(organization=self.organization, user=self.removed).delete()

        items, total = ContextItemService(user=self.removed).list_items(
            space_id=self.team_space.id,
            item_type="tabfiles",
        )
        self.assertEqual(items, [])
        self.assertEqual(total, 0)
        self.assertIsNone(ContextItemService(user=self.removed).get_item(item.id))

        another_file = self._file_record(upload_user=str(self.removed.id))
        self.assertIsNone(
            TabFilesService(user=self.removed).upload_to_space(
                space_id=self.team_space.id,
                file_record_id=another_file.id,
            )
        )

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_owner_offline_state_does_not_block_asset_listing_or_member_upload(self, _mock_update_search):
        from apps.tabtinspace.services.context_item_service import ContextItemService
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        self.assertEqual(self.offline_device.status, "offline")
        file_record = self._file_record(upload_user=str(self.invited.id))

        item = TabFilesService(user=self.invited).upload_to_space(
            space_id=self.team_space.id,
            file_record_id=file_record.id,
        )
        items, total = ContextItemService(user=self.invited).list_items(
            space_id=self.team_space.id,
            item_type="tabfiles",
        )

        self.assertEqual(total, 1)
        self.assertEqual(items[0].id, item.id)

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_ai_final_answer_is_represented_as_team_space_asset(self, _mock_update_search):
        from apps.chat.conversation.models import ChatMessage, ChatSession
        from apps.tabtinspace.models import ContextItem
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
            agent_run_id="run-asset-1",
        )

        published = TabFilesService.publish_message_assets(message.id)

        self.assertEqual(len(published), 1)
        item = ContextItem.objects.get(id=published[0].id)
        self.assertEqual(item.item_type, "team_asset")
        self.assertEqual(item.resource_id, f"chat_message:{message.id}")
        self.assertEqual(item.metadata["asset_source"]["kind"], "ai_final_answer")
        self.assertEqual(
            item.metadata["asset_source"]["conversation_origin"]["chat_session_id"],
            str(session.id),
        )
        self.assertEqual(
            item.metadata["asset_source"]["run_origin"]["agent_run_id"],
            "run-asset-1",
        )

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_companion_session_final_answer_is_published_to_project(self, _mock_update_search):
        from apps.chat.conversation.models import ChatMessage, ChatSession
        from apps.tabtinspace.models import ContextItem, Space
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        companion_space = Space.objects.create(
            organization=self.organization,
            name="Owner project execution",
            status="active",
            type=Space.SpaceType.WORKSPACE,
            project=self.team_space,
        )
        session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            space=companion_space,
            title="Mobile Project Task",
        )
        message = ChatMessage.objects.create(
            session=session,
            role="assistant",
            message_kind="llm",
            text_summary="最终结论：移动端任务已完成。",
            content_blocks_json=[
                {"type": "text", "text": "最终结论：移动端任务已完成。"}
            ],
            stop_reason="end_turn",
            agent_run_id="run-mobile-project",
        )

        published = TabFilesService.publish_message_assets(message.id)

        self.assertEqual(len(published), 1)
        item = ContextItem.objects.get(id=published[0].id)
        self.assertEqual(item.project_id, self.team_space.id)
        self.assertEqual(
            item.metadata["asset_source"]["conversation_origin"]["team_space_id"],
            str(self.team_space.id),
        )
        self.assertFalse(
            ContextItem.objects.filter(workspace_id=companion_space.id).exists()
        )

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_companion_session_cloud_file_deliverable_is_published_to_project(
        self,
        _mock_update_search,
    ):
        from apps.chat.conversation.models import ChatMessage, ChatSession
        from apps.tabtinspace.models import ContextItem, Space
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        companion_space = Space.objects.create(
            organization=self.organization,
            name="Owner project execution",
            status="active",
            type=Space.SpaceType.WORKSPACE,
            project=self.team_space,
        )
        session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            space=companion_space,
            title="Mobile Project File Task",
        )
        file_record = self._file_record(upload_user=str(self.owner.id))
        message = ChatMessage.objects.create(
            session=session,
            role="assistant",
            message_kind="tool_artifact",
            text_summary=file_record.file_name,
            content_blocks_json=[
                {
                    "type": "tabtin_rich_content",
                    "kind": "file",
                    "payload": {
                        "artifact_kind": "oss_file",
                        "file_record_id": str(file_record.id),
                        "title": file_record.file_name,
                    },
                }
            ],
            stop_reason="end_turn",
            agent_run_id="run-mobile-project-file",
        )

        published = TabFilesService.publish_message_assets(message.id)

        self.assertEqual(len(published), 1)
        item = ContextItem.objects.get(id=published[0].id)
        self.assertEqual(item.project_id, self.team_space.id)
        self.assertEqual(item.item_type, "tabfiles")
        self.assertEqual(item.resource_id, str(file_record.id))
        self.assertEqual(
            item.metadata["asset_source"]["kind"],
            "ai_deliverable",
        )
        self.assertFalse(
            ContextItem.objects.filter(workspace_id=companion_space.id).exists()
        )

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_local_file_artifact_without_file_record_is_not_published(self, _mock_update_search):
        from apps.chat.conversation.models import ChatMessage, ChatSession
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            space=self.team_space,
            title="Local artifact",
        )
        message = ChatMessage.objects.create(
            session=session,
            role="assistant",
            message_kind="tool_artifact",
            text_summary="report.xlsx",
            content_blocks_json=[
                {
                    "type": "tabtin_rich_content",
                    "kind": "local_file_artifact",
                    "payload": {
                        "artifact_kind": "local_file",
                        "relative_path": "artifacts/report.xlsx",
                        "absolute_path": "/tmp/report.xlsx",
                    },
                }
            ],
            stop_reason="end_turn",
        )

        self.assertEqual(TabFilesService.publish_message_assets(message.id), [])

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_team_space_tabdoc_is_enriched_as_deliverable_asset(self, _mock_update_search):
        from apps.tabdoc.models import Document
        from apps.tabtinspace.models import ContextItem
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.team_space.id,
            owner_id=self.owner.id,
            title="甜风格设计方向整理",
            description_json={"type": "doc", "content": []},
            description_markdown="# 甜风格",
            description_plaintext="甜风格",
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
        self.assertEqual(item.metadata.get("asset_source", {}).get("kind"), "ai_deliverable")
