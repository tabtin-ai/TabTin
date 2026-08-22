"""
BE-01/BE-02/BE-03/BE-05 权限安全修复 — 回归测试

覆盖场景：
- BE-01: save_from_agent 必须检查 editor 权限
- BE-02: save_from_hocuspocus 必须检查 editor 权限（human editor 路径）
- BE-03: permanent_delete_document 必须要求 admin 权限
- BE-05: get_document_binary / store_document_update 路由必须声明 auth
"""
from __future__ import annotations

import uuid
import unittest
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from django.db import connections

from apps.tabdoc.models import Document, DocumentPermission, DocUpdate
from apps.tabdoc.services import DocumentService


class PermissionSecurityFixTests(unittest.TestCase):
    """权限安全修复回归测试"""

    def setUp(self):
        try:
            connection = connections["postgresql"]
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")

            existing_tables = set(connection.introspection.table_names())
            with connection.schema_editor() as schema_editor:
                if Document._meta.db_table not in existing_tables:
                    schema_editor.create_model(Document)
                    existing_tables.add(Document._meta.db_table)
                if DocumentPermission._meta.db_table not in existing_tables:
                    schema_editor.create_model(DocumentPermission)
                    existing_tables.add(DocumentPermission._meta.db_table)
                if DocUpdate._meta.db_table not in existing_tables:
                    schema_editor.create_model(DocUpdate)
                    existing_tables.add(DocUpdate._meta.db_table)

            self.db_available = True
        except Exception:
            self.db_available = False

    def _create_document(self, status="active", **kwargs):
        defaults = dict(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="权限测试文档",
            description_json={"type": "doc", "content": [{"type": "paragraph"}]},
            description_markdown="# 内容",
            description_plaintext="内容",
            latest_version=1,
            status=status,
        )
        defaults.update(kwargs)
        return Document.objects.create(**defaults)

    def _make_service(self, user=None):
        return DocumentService(user=user)

    def _patch_permission_denied(self):
        """模拟权限检查返回 False（无权限）"""
        return patch(
            "apps.tabdoc.services.document_service.DocumentService.check_document_permission",
            return_value=False,
        )

    def _patch_permission_granted(self):
        """模拟权限检查返回 True（有权限）"""
        return patch(
            "apps.tabdoc.services.document_service.DocumentService.check_document_permission",
            return_value=True,
        )

    # ═══════════════════════════════════════════════════════════════
    # BE-01: save_from_agent 权限检查
    # ═══════════════════════════════════════════════════════════════

    def test_be01_save_from_agent_rejects_without_editor_permission(self):
        """BE-01: save_from_agent 在无 editor 权限时应抛出 PermissionError"""
        if not self.db_available:
            self.skipTest("PostgreSQL 不可用")

        doc = self._create_document()
        service = self._make_service(user=None)

        with self._patch_permission_denied():
            with self.assertRaises(PermissionError):
                service.save_from_agent(
                    doc,
                    content_pm_json={"type": "doc", "content": []},
                    content_html="",
                    agent_id="test-agent",
                )

    def test_be01_save_from_agent_allows_with_editor_permission(self):
        """BE-01: save_from_agent 在有 editor 权限时应正常执行"""
        if not self.db_available:
            self.skipTest("PostgreSQL 不可用")

        doc = self._create_document()
        service = self._make_service(user=None)

        with self._patch_permission_granted(), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ), patch(
            "apps.tabdoc.services.document_service.DocumentService.push_and_update_binary",
        ):
            result = service.save_from_agent(
                doc,
                content_pm_json={"type": "doc", "content": []},
                content_html="",
                agent_id="test-agent",
            )
            self.assertEqual(result.id, doc.id)

    def test_be01_push_from_agent_rejects_without_editor_permission(self):
        """BE-01: push_from_agent 在无 editor 权限时应抛出 PermissionError"""
        if not self.db_available:
            self.skipTest("PostgreSQL 不可用")

        doc = self._create_document()
        service = self._make_service(user=None)

        with self._patch_permission_denied():
            with self.assertRaises(PermissionError):
                service.push_from_agent(
                    doc,
                    content_pm_json={"type": "doc", "content": []},
                    agent_id="test-agent",
                )

    # ═══════════════════════════════════════════════════════════════
    # BE-02: save_from_hocuspocus 权限检查
    # ═══════════════════════════════════════════════════════════════

    def test_be02_save_from_hocuspocus_rejects_human_without_permission(self):
        """BE-02: save_from_hocuspocus 在 human editor 无权限时应抛出 PermissionError"""
        if not self.db_available:
            self.skipTest("PostgreSQL 不可用")

        doc = self._create_document()
        service = self._make_service(user=None)

        mock_user = SimpleNamespace(id=uuid.uuid4())

        with patch("django.contrib.auth.get_user_model") as mock_get_user:
            MockUser = MagicMock()
            MockUser.objects.get.return_value = mock_user
            mock_get_user.return_value = MockUser

            with self._patch_permission_denied():
                with self.assertRaises(PermissionError):
                    service.save_from_hocuspocus(
                        doc,
                        update_blob=b"\x00\x01\x02",
                        editor_type="user",
                        editor_id=str(mock_user.id),
                    )

    def test_be02_save_from_hocuspocus_rejects_nonexistent_human_editor(self):
        """BE-02: save_from_hocuspocus 在 human editor 不存在时应抛出 PermissionError"""
        if not self.db_available:
            self.skipTest("PostgreSQL 不可用")

        doc = self._create_document()
        service = self._make_service(user=None)

        with patch("django.contrib.auth.get_user_model") as mock_get_user:
            MockUser = MagicMock()
            MockUser.DoesNotExist = Exception
            MockUser.objects.get.side_effect = MockUser.DoesNotExist("not found")
            mock_get_user.return_value = MockUser

            with self.assertRaises(PermissionError):
                service.save_from_hocuspocus(
                    doc,
                    update_blob=b"\x00\x01\x02",
                    editor_type="user",
                    editor_id="nonexistent-user-id",
                )

    def test_be02_save_from_hocuspocus_allows_human_with_permission(self):
        """BE-02: save_from_hocuspocus 在 human editor 有权限时应正常执行"""
        if not self.db_available:
            self.skipTest("PostgreSQL 不可用")

        doc = self._create_document()
        service = self._make_service(user=None)

        mock_user = SimpleNamespace(id=uuid.uuid4())

        with patch("django.contrib.auth.get_user_model") as mock_get_user:
            MockUser = MagicMock()
            MockUser.objects.get.return_value = mock_user
            mock_get_user.return_value = MockUser

            with self._patch_permission_granted():
                result = service.save_from_hocuspocus(
                    doc,
                    update_blob=b"\x00\x01\x02\x03",
                    editor_type="user",
                    editor_id=str(mock_user.id),
                )
                self.assertIsNotNone(result)

    # ═══════════════════════════════════════════════════════════════
    # BE-03: permanent_delete_document 权限要求 admin
    # ═══════════════════════════════════════════════════════════════

    def test_be03_permanent_delete_requires_admin_not_editor(self):
        """BE-03: permanent_delete_document 应要求 admin 权限"""
        if not self.db_available:
            self.skipTest("PostgreSQL 不可用")

        doc = self._create_document(status="trashed")
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service(user=None)

        # 模拟 check_document_permission: editor=True, admin=False
        def mock_check(document, required_role="viewer"):
            return required_role in ("viewer", "editor")

        with patch.object(DocumentService, "check_document_permission", side_effect=mock_check):
            with self.assertRaises(PermissionError):
                service.permanent_delete_document(doc)

    def test_be03_permanent_delete_allows_admin(self):
        """BE-03: permanent_delete_document 在 admin 权限下应正常执行"""
        if not self.db_available:
            self.skipTest("PostgreSQL 不可用")

        doc = self._create_document(status="trashed")
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service(user=None)

        with self._patch_permission_granted(), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_delete",
        ), patch(
            "apps.rag.signals._is_rag_enabled", return_value=False,
        ):
            service.permanent_delete_document(doc)
            self.assertFalse(Document.objects.using("postgresql").filter(id=doc.id).exists())

    # ═══════════════════════════════════════════════════════════════
    # BE-05: 路由 auth 声明检查
    # ═══════════════════════════════════════════════════════════════

    def test_be05_get_document_binary_has_auth_declaration(self):
        """BE-05: get_document_binary 端点应声明 auth（已迁移到 InternalServiceAuth）"""
        import inspect
        from apps.tabdoc import api as tabdoc_api
        source = inspect.getsource(tabdoc_api)
        self.assertIn("auth=[jwt_auth, internal_service_auth]", source,
                       "get_document_binary 路由应声明 auth=[jwt_auth, internal_service_auth]")

    def test_be05_internal_service_auth_instance_exists(self):
        """BE-05: InternalServiceAuth 应正确导入并实例化"""
        from apps.tabdoc.api import internal_service_auth
        from apps.services.common.auth import InternalServiceAuth
        self.assertIsNotNone(internal_service_auth)
        self.assertIsInstance(internal_service_auth, InternalServiceAuth)
        self.assertTrue(hasattr(internal_service_auth, "authenticate"),
                        "internal_service_auth 应有 authenticate 方法")
