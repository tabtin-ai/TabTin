"""#1267: agent apply-ops 在 ExecutionRun.user_id 为空时回退 editor_id。"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

from django.test import SimpleTestCase

from apps.collab.services.permission import (
    CollabPermissionError,
    CollabResource,
    assert_collab_action_allowed,
    resolve_write_subject,
)


class TestAgentApplyOpsSubjectFallback(SimpleTestCase):
    def test_falls_back_to_editor_id_when_run_user_id_empty(self):
        user_id = str(uuid4())
        mock_user = MagicMock()

        with patch("apps.services.agent_engine.models.ExecutionRun.objects") as mock_run_objects:
            mock_run_objects.filter.return_value.values_list.return_value.first.return_value = None
            with patch("apps.collab.services.permission.get_user_model") as mock_get_user_model:
                mock_user_model = MagicMock()
                mock_user_model.objects.filter.return_value.first.return_value = mock_user
                mock_get_user_model.return_value = mock_user_model

                subject = resolve_write_subject(
                    editor_type="agent",
                    editor_id=user_id,
                    agent_run_id=str(uuid4()),
                )

        self.assertIs(subject, mock_user)
        mock_user_model.objects.filter.assert_called_once_with(id=user_id)


class TestShareWriteCollabSubject(SimpleTestCase):
    """分享编辑写入的 collab 主体解析与 share grant 放行。"""

    def test_share_editor_type_resolves_user_from_guest_id(self):
        user_id = str(uuid4())
        mock_user = MagicMock()
        guest_id = f"share:share-1:{user_id}"

        with patch("apps.collab.services.permission.get_user_model") as mock_get_user_model:
            mock_user_model = MagicMock()
            mock_user_model.objects.filter.return_value.first.return_value = mock_user
            mock_get_user_model.return_value = mock_user_model

            subject = resolve_write_subject(editor_type="share", editor_id=guest_id)

        self.assertIs(subject, mock_user)

    @patch("apps.collab.services.permission._assert_share_collab_write_allowed")
    def test_share_write_allowed_via_share_grant(self, mock_assert_share):
        fake = CollabResource("docs", "doc-1", MagicMock(), MagicMock())
        with patch(
            "apps.collab.services.permission.resolve_collab_resource",
            return_value=fake,
        ):
            result = assert_collab_action_allowed(
                resource_type="docs",
                resource_id="doc-1",
                action="edit",
                editor_type="share",
                editor_id="share:share-1:" + str(uuid4()),
            )
        self.assertIs(result, fake)
        mock_assert_share.assert_called_once()

    def test_system_trusted_internal_allowed_for_docs(self):
        """修复：已授权的分享写入以 system trusted_internal 身份放行，
        且不再触碰协作者权限校验（访客通常不是协作者）。"""
        fake_adapter = MagicMock()
        # docs 适配器无 allows_system_collab_write 钩子 → 默认放行
        del fake_adapter.allows_system_collab_write
        fake_resource = MagicMock()
        fake = CollabResource("docs", "doc-1", fake_adapter, fake_resource)
        with patch(
            "apps.collab.services.permission.resolve_collab_resource",
            return_value=fake,
        ):
            result = assert_collab_action_allowed(
                resource_type="docs",
                resource_id="doc-1",
                action="edit",
                editor_type="system",
                editor_id="system:share_sync",
                system_policy="trusted_internal",
            )
        self.assertIs(result, fake)
        fake_adapter.check_permission.assert_not_called()
