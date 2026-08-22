"""
DV-005 ~ DV-009 回归测试

DV-005: save_content 内容写入不再硬编码 editor_type="human"
DV-006: _create_fallback_version_history 调用不再硬编码 editor_type="human"
DV-007: save_content 路径更新 last_editor_type / last_editor_id
DV-009: _create_fallback_version_history 同时写 ChangeLog

注：DV-008（save_from_agent 触发 create_doc_history.delay）随 TD-4 Phase 4d
删除私有 DocHistory 写入路径而移除；版本历史统一由 VersionHistory 承载。
"""
from __future__ import annotations

import inspect
import os
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django
django.setup()

from apps.tabdoc.services.document_service import DocumentService


_fake_user = SimpleNamespace(id="user-001", is_authenticated=True)


class TestDV005EditorTypeInSaveContent(unittest.TestCase):
    """DV-005: save_content 内容写入必须使用动态 editor_type（不硬编码 human）。"""

    def test_no_hardcoded_human_in_save_content(self):
        src = inspect.getsource(DocumentService.save_content)
        self.assertNotIn(
            'editor_type="human"', src,
            "save_content 不应硬编码 editor_type=\"human\"，应使用 self._get_editor_type()",
        )

    def test_uses_get_editor_type_for_history(self):
        src = inspect.getsource(DocumentService.save_content)
        self.assertIn(
            "self._get_editor_type()", src,
            "save_content 应使用 self._get_editor_type() 动态获取编辑者类型",
        )


class TestDV006FallbackEditorType(unittest.TestCase):
    """DV-006: save_content fallback 路径不再硬编码 editor_type='human'。"""

    def test_no_hardcoded_human_in_fallback_call(self):
        src = inspect.getsource(DocumentService.save_content)
        lines = src.split("\n")
        for line in lines:
            if "_create_fallback_version_history" in line and "editor_type" in line:
                self.assertNotIn(
                    '"human"', line,
                    "save_content 中 _create_fallback_version_history 调用不应硬编码 'human'",
                )

    def test_fallback_uses_get_editor_type(self):
        # TD-4 重构后：save_content 先把 editor_type 解析到局部变量
        # （test_uses_get_editor_type_for_history 已校验用 self._get_editor_type()），
        # 再把动态 editor_type 透传给 _create_fallback_version_history，
        # 而非在调用处内联 _get_editor_type()。这里验证透传的是动态变量、非硬编码。
        src = inspect.getsource(DocumentService.save_content)
        fallback_idx = src.find("_create_fallback_version_history")
        self.assertNotEqual(fallback_idx, -1, "save_content 应调用 _create_fallback_version_history")
        fallback_block = src[fallback_idx:fallback_idx + 200]
        self.assertIn(
            "editor_type=editor_type", fallback_block,
            "_create_fallback_version_history 调用应透传动态 editor_type 变量",
        )


class TestDV007LastEditorFields(unittest.TestCase):
    """DV-007: save_content 路径更新 last_editor_type 和 last_editor_id。"""

    def test_update_query_includes_last_editor_fields(self):
        src = inspect.getsource(DocumentService.save_content)
        self.assertIn("last_editor_type=", src,
                       "save_content DB 更新应包含 last_editor_type")
        self.assertIn("last_editor_id=", src,
                       "save_content DB 更新应包含 last_editor_id")

    def test_save_content_sets_last_editor_on_document(self):
        """save_content 成功后 document 对象应有正确的 last_editor_type/id。"""
        service = DocumentService(user=_fake_user, editor_type="agent")
        service.check_document_permission = MagicMock(return_value=True)

        document = SimpleNamespace(
            id="doc-dv007",
            latest_version=1,
            title="Test",
            description_markdown="old",
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
            last_editor_type="",
            last_editor_id="",
        )
        update_qs = MagicMock()
        update_qs.update.return_value = 1

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()), \
             patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs), \
             patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"), \
             patch.object(service, "_update_search_vector"), \
             patch.object(service, "push_and_update_binary", return_value=None):
            result = service.save_content(
                document,
                base_version=1,
                content_pm_json={"type": "doc", "content": [{"type": "paragraph"}]},
                content_markdown="new",
                content_plaintext="new",
            )

        self.assertEqual(result.last_editor_type, "agent")
        self.assertEqual(result.last_editor_id, "user-001")

    def test_update_call_passes_last_editor_fields(self):
        """验证 DB update() 调用实际包含 last_editor_type 和 last_editor_id。"""
        service = DocumentService(user=_fake_user, editor_type="agent")
        service.check_document_permission = MagicMock(return_value=True)

        document = SimpleNamespace(
            id="doc-dv007-2",
            latest_version=1,
            title="Test",
            description_markdown="old",
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )
        update_qs = MagicMock()
        update_qs.update.return_value = 1

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()), \
             patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs), \
             patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"), \
             patch.object(service, "_update_search_vector"), \
             patch.object(service, "push_and_update_binary", return_value=None):
            service.save_content(
                document,
                base_version=1,
                content_pm_json={"type": "doc"},
                content_markdown="new",
                content_plaintext="new",
            )

        update_kwargs = update_qs.update.call_args[1]
        self.assertIn("last_editor_type", update_kwargs)
        self.assertEqual(update_kwargs["last_editor_type"], "agent")
        self.assertIn("last_editor_id", update_kwargs)
        self.assertEqual(update_kwargs["last_editor_id"], "user-001")


class TestDV009FallbackChangeLog(unittest.TestCase):
    """DV-009: _create_fallback_version_history 必须同时写 ChangeLog。"""

    def test_fallback_source_contains_changelog(self):
        src = inspect.getsource(DocumentService._create_fallback_version_history)
        self.assertIn("ChangeLog", src,
                       "_create_fallback_version_history 应引用 ChangeLog")

    def test_fallback_creates_changelog_with_correct_fields(self):
        # TD-4 重构后 ChangeLog 写入收敛到 _record_content_history（fallback 经它落库）。
        # fallback 自身以 change_type="update" 委托；字段透传在 _record_content_history。
        fallback_src = inspect.getsource(DocumentService._create_fallback_version_history)
        writer_src = inspect.getsource(DocumentService._record_content_history)
        self.assertIn('change_type="update"', fallback_src,
                       "fallback 应以 change_type='update' 写内容变更")
        self.assertIn('resource_type="docs"', writer_src,
                       "ChangeLog 的 resource_type 应为 'docs'")
        self.assertIn("editor_type=editor_type", writer_src,
                       "ChangeLog 应透传 editor_type 参数")
        self.assertIn("editor_id=editor_id", writer_src,
                       "ChangeLog 应透传 editor_id 参数")
        self.assertIn("version_history=vh", writer_src,
                       "ChangeLog 应关联到创建的 VersionHistory")

    def test_fallback_uses_postgresql_db(self):
        # 单库治理后不再硬编码 .using("postgresql")，统一走 _DB_ALIAS()（postgres_app_db_alias，
        # dual→postgresql / single_pg→default）。验证 fallback 的实际写入路径
        # （_record_content_history）通过该 alias helper 写 ChangeLog 与开事务。
        writer_src = inspect.getsource(DocumentService._record_content_history)
        self.assertIn(".using(_DB_ALIAS())", writer_src,
                       "ChangeLog 应通过 _DB_ALIAS() 别名写入（不再硬编码 postgresql）")
        self.assertIn("transaction.atomic(using=_DB_ALIAS())", writer_src,
                       "内容历史写入应在 _DB_ALIAS() 事务边界内")

    def test_fallback_creates_changelog_on_call(self):
        """模拟调用 _create_fallback_version_history，验证 ChangeLog.objects.using().create 被调用。"""
        mock_vh = MagicMock(name="VersionHistory")
        mock_svc = MagicMock()
        mock_svc.create_history.return_value = mock_vh

        mock_changelog_manager = MagicMock()
        mock_changelog_using = MagicMock()
        mock_changelog_manager.using.return_value = mock_changelog_using

        document = SimpleNamespace(
            id="doc-dv009",
            description_markdown="test",
            description_plaintext="test",
            organization_id="wt-001",
        )

        with patch("apps.collab.registry.get_adapter_or_raise") as mock_get_adapter, \
             patch("apps.collab.service.VersionHistoryService", return_value=mock_svc), \
             patch("apps.collab.models.ChangeLog") as MockChangeLog:
            MockChangeLog.objects = mock_changelog_manager

            DocumentService._create_fallback_version_history(
                document,
                {"type": "doc"},
                editor_type="agent",
                editor_id="agent-009",
            )

        mock_svc.create_history.assert_called_once()
        mock_changelog_manager.using.assert_called_once_with("postgresql")
        mock_changelog_using.create.assert_called_once()
        create_kwargs = mock_changelog_using.create.call_args[1]
        self.assertEqual(create_kwargs["resource_type"], "docs")
        self.assertEqual(create_kwargs["resource_id"], "doc-dv009")
        self.assertEqual(create_kwargs["change_type"], "update")
        self.assertEqual(create_kwargs["editor_type"], "agent")
        self.assertEqual(create_kwargs["editor_id"], "agent-009")
        self.assertEqual(create_kwargs["version_history"], mock_vh)


if __name__ == "__main__":
    unittest.main()
