from __future__ import annotations

import asyncio
import base64
import json
import uuid
import unittest
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.db import connections, transaction

from apps.tabdoc.models import DocChunk, DocHistory, DocUpdate, Document, DocumentPermission, DocumentRevision, DocumentVersion
from apps.tabdoc.api import get_document_binary
from apps.tabdoc.services import ConflictError, DocumentExchangeService, DocumentService
from apps.tabdoc.services.document_service import (
    classify_tabdoc_content_state,
    normalize_tabdata_markdown,
    should_fallback_to_latest_revision,
)
from apps.tabdoc.tasks import create_document_version


class TabdocIntegrationFlowTests(unittest.TestCase):
    """Tabdoc 端到端主链路集成测试（创建 -> 编辑 -> 导出 -> 恢复）"""

    def setUp(self):
        try:
            connection = connections["postgresql"]
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")

            # 轻量测试模式（SQLite）下 manage.py test 不会自动建表，这里按需建 tabdoc 必要表。
            existing_tables = set(connection.introspection.table_names())
            with connection.schema_editor() as schema_editor:
                if Document._meta.db_table not in existing_tables:
                    schema_editor.create_model(Document)
                    existing_tables.add(Document._meta.db_table)
                if DocumentPermission._meta.db_table not in existing_tables:
                    schema_editor.create_model(DocumentPermission)
                    existing_tables.add(DocumentPermission._meta.db_table)
                if DocHistory._meta.db_table not in existing_tables:
                    schema_editor.create_model(DocHistory)
                    existing_tables.add(DocHistory._meta.db_table)
                if DocUpdate._meta.db_table not in existing_tables:
                    schema_editor.create_model(DocUpdate)
                    existing_tables.add(DocUpdate._meta.db_table)
                if DocumentVersion._meta.db_table not in existing_tables:
                    schema_editor.create_model(DocumentVersion)
                    existing_tables.add(DocumentVersion._meta.db_table)
                if DocumentRevision._meta.db_table not in existing_tables:
                    schema_editor.create_model(DocumentRevision)
                    existing_tables.add(DocumentRevision._meta.db_table)
        except Exception as exc:
            self.skipTest(f"postgresql 不可用，跳过集成测试: {exc}")

    def test_create_edit_export_restore_full_flow(self):
        organization_id = str(uuid.uuid4())
        project_id = str(uuid.uuid4())

        service = DocumentService(user=None)
        exchange_service = DocumentExchangeService(user=None)

        with transaction.atomic(using="postgresql"), patch(
            "apps.tabdoc.services.document_service.DocumentService._ensure_space_context",
            return_value=None,
        ), patch(
            "apps.tabdoc.services.document_service.DocumentService.check_space_permission",
            return_value=True,
        ), patch(
            "apps.tabdoc.services.document_service.DocumentService._update_search_vector",
            return_value=None,
        ), patch(
            "apps.tabdoc.services.document_service.DocumentService.check_document_permission",
            return_value=True,
        ), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_create",
        ), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ):
            document = service.create_document(
                organization_id=organization_id,
                space_id=project_id,
                parent_id=None,
                title="集成测试文档",
                initial_content_pm_json={"type": "doc", "content": []},
                initial_content_markdown="# V1",
                initial_content_plaintext="V1",
            )

            self.assertEqual(document.latest_version, 1)
            self.assertEqual(document.description_markdown, "# V1")

            document = service.save_content(
                document,
                base_version=1,
                content_pm_json={"type": "doc", "content": [{"type": "heading", "attrs": {"level": 2}}]},
                content_markdown="## V2",
                content_plaintext="V2",
            )
            self.assertEqual(document.latest_version, 2)
            self.assertEqual(document.description_markdown, "## V2")

            # 模拟异步任务落库快照
            create_document_version.run(str(document.id), None)

            revisions = service.list_revisions(document, limit=20)
            self.assertGreaterEqual(len(revisions), 1)
            self.assertEqual(getattr(revisions[0], "version", None), 2)

            exported_md = exchange_service.export_document_content(
                document,
                export_format="markdown",
            )
            self.assertEqual(exported_md["format"], "markdown")
            self.assertIn("V2", exported_md["content"])

            document = service.save_content(
                document,
                base_version=2,
                content_pm_json={"type": "doc", "content": [{"type": "heading", "attrs": {"level": 3}}]},
                content_markdown="### V3",
                content_plaintext="V3",
            )
            self.assertEqual(document.latest_version, 3)
            create_document_version.run(str(document.id), None)

            versions = service.list_versions(document, limit=20)
            target_v2 = next((item for item in versions if item.version == 2), None)
            self.assertIsNotNone(target_v2)

            restored = service.restore_version(document, version_id=str(target_v2.id))
            self.assertEqual(restored.latest_version, 4)
            self.assertEqual(restored.description_markdown, "## V2")
            self.assertEqual(restored.description_plaintext, "V2")

            exported_after_restore = exchange_service.export_document_content(
                restored,
                export_format="markdown",
            )
            self.assertIn("V2", exported_after_restore["content"])

            # ── 多格式导出验证 ──────────────────────────────────────

            exported_html = exchange_service.export_document_content(
                restored, export_format="html",
            )
            self.assertEqual(exported_html["format"], "html")
            self.assertTrue(len(exported_html["content"]) > 0)
            self.assertEqual(exported_html["mime_type"], "text/html; charset=utf-8")

            exported_txt = exchange_service.export_document_content(
                restored, export_format="txt",
            )
            self.assertEqual(exported_txt["format"], "txt")
            self.assertIn("V2", exported_txt["content"])
            self.assertEqual(exported_txt["mime_type"], "text/plain; charset=utf-8")

            exported_docx = exchange_service.export_document_content(
                restored, export_format="docx",
            )
            self.assertEqual(exported_docx["format"], "docx")
            docx_bytes = exported_docx["content_bytes"]
            self.assertIsInstance(docx_bytes, bytes)
            self.assertTrue(docx_bytes[:2] == b"PK", "DOCX should be a valid ZIP")
            self.assertTrue(exported_docx["filename"].endswith(".docx"))

            # 回滚本测试写入，避免污染本地开发库
            transaction.set_rollback(True, using="postgresql")

    def test_normalize_document_content_preserves_existing_binary(self):
        """#7022: tabdataBlock 规范化只修 markdown，不得清空 description_binary。"""
        organization_id = uuid.uuid4()
        project_id = uuid.uuid4()
        legacy_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl_legacy", "title": "旧表格"},
                }
            ],
        }
        # markdown 缺少 :::tabdata{，触发派生字段修正
        legacy_markdown = (
            '<div data-type="tabdata-block" data-table-id="tbl_legacy"'
            ' class="tabdata-block"><p>旧表格</p></div>\n'
        )
        existing_binary = b"keep-me-binary"

        service = DocumentService(user=None)

        with patch(
            "apps.tabdoc.services.document_service.DocumentService._update_search_vector",
            return_value=None,
        ), patch(
            "apps.tabdoc.services.markdown_exchange.pm_json_to_markdown",
            return_value=':::tabdata{tableId="tbl_legacy" title="旧表格"}\n:::\n',
        ):
            document = Document.objects.create(
                organization_id=organization_id,
                space_id=project_id,
                title="旧命名文档",
                description_binary=existing_binary,
                description_json=legacy_json,
                description_markdown=legacy_markdown,
                description_plaintext="旧表格",
                latest_version=1,
            )

            changed = service.normalize_document_content_if_needed(document)
            self.assertTrue(changed)
            self.assertEqual(
                document.description_json["content"][0]["type"],
                "tabdataBlock",
            )
            self.assertIn(":::tabdata{", document.description_markdown)
            self.assertEqual(bytes(document.description_binary), existing_binary)

            # 幂等：再次 normalize 不得再改
            changed_again = service.normalize_document_content_if_needed(document)
            self.assertFalse(changed_again)
            document.refresh_from_db()
            self.assertEqual(bytes(document.description_binary), existing_binary)

    def test_get_document_binary_returns_existing_binary_unchanged_for_tabdata_docs(self):
        """#7022: 已有 binary + 已规范化 tabdataBlock 时，连续 GET 原样返回且不写库/不 replace。"""
        legacy_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl_legacy", "title": "旧表格"},
                }
            ],
        }
        legacy_markdown = ':::tabdata{tableId="tbl_legacy" title="旧表格"}\n:::\n'
        existing_binary = b"\x01\x02stable-yjs-binary"
        request = SimpleNamespace(headers={"X-Live-Secret": "ok"}, auth="collab-live-service")

        with patch(
            "apps.tabdoc.api.DocumentService.push_and_update_binary",
            return_value=None,
        ) as push_mock, patch(
            "apps.tabdoc.api.DocumentService.ensure_description_binary",
            return_value=False,
        ) as ensure_mock, patch(
            "apps.tabdoc.api.DocumentService.normalize_document_content_if_needed",
            return_value=True,
        ) as normalize_mock:
            document = Document.objects.create(
                organization_id=uuid.uuid4(),
                space_id=uuid.uuid4(),
                title="已有 binary 的 tabdata 文档",
                description_binary=existing_binary,
                description_json=legacy_json,
                description_markdown=legacy_markdown,
                description_plaintext="旧表格",
                latest_version=3,
            )

            first = asyncio.run(get_document_binary(request, str(document.id)))
            second = asyncio.run(get_document_binary(request, str(document.id)))

            expected_b64 = base64.b64encode(existing_binary).decode()
            self.assertTrue(first["data"]["has_binary"])
            self.assertEqual(first["data"]["binary_b64"], expected_b64)
            self.assertEqual(first["data"]["binary_b64"], second["data"]["binary_b64"])
            self.assertEqual(first["data"]["latest_version"], 3)
            self.assertEqual(second["data"]["latest_version"], 3)
            # 有 binary 时不应附带 fallback 正文，避免 collab-live 误迁移
            self.assertEqual(first["data"]["description_markdown"], "")
            self.assertIsNone(first["data"]["description_json"])

            document.refresh_from_db()
            self.assertEqual(bytes(document.description_binary), existing_binary)
            push_mock.assert_not_called()
            ensure_mock.assert_not_called()
            normalize_mock.assert_not_called()

    def test_get_document_binary_returns_fallback_fields_only_when_binary_missing(self):
        """#7022: 缺 binary 时只返回已有 PM JSON/Markdown，不在 GET 内 push/normalize。"""
        legacy_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl_legacy", "title": "旧表格"},
                }
            ],
        }
        legacy_markdown = ':::tabdata{tableId="tbl_legacy" title="旧表格"}\n:::\n'
        request = SimpleNamespace(headers={"X-Live-Secret": "ok"}, auth="collab-live-service")

        with patch(
            "apps.tabdoc.api.DocumentService.push_and_update_binary",
            return_value=None,
        ) as push_mock, patch(
            "apps.tabdoc.api.DocumentService.normalize_document_content_if_needed",
            return_value=True,
        ) as normalize_mock:
            document = Document.objects.create(
                organization_id=uuid.uuid4(),
                space_id=uuid.uuid4(),
                title="缺 binary 文档",
                description_binary=None,
                description_json=legacy_json,
                description_markdown=legacy_markdown,
                description_plaintext="旧表格",
                latest_version=1,
            )

            response = asyncio.run(get_document_binary(request, str(document.id)))
            data = response["data"]

            self.assertEqual(data["binary_b64"], "")
            self.assertFalse(data["has_binary"])
            self.assertIn(":::tabdata{", data["description_markdown"])
            self.assertEqual(data["description_json"]["content"][0]["type"], "tabdataBlock")

            document.refresh_from_db()
            self.assertIsNone(document.description_binary)
            push_mock.assert_not_called()
            normalize_mock.assert_not_called()

    def test_get_document_binary_unwraps_binary_snapshot_and_persists_raw_binary(self):
        raw_binary = b"\x01\x02tabdoc-yjs-update"
        wrapped_binary = json.dumps({
            "format": "binary_snapshot",
            "title": "wrapped",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }).encode("utf-8")
        request = SimpleNamespace(headers={"X-Live-Secret": "ok"}, auth="collab-live-service")

        document = Document.objects.create(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="wrapped binary 文档",
            description_binary=wrapped_binary,
            description_json={},
            description_markdown="# wrapped",
            description_plaintext="wrapped",
            latest_version=1,
        )

        response = asyncio.run(get_document_binary(request, str(document.id)))
        data = response["data"]

        self.assertTrue(data["has_binary"])
        self.assertEqual(data["binary_b64"], base64.b64encode(raw_binary).decode())
        self.assertEqual(data["description_markdown"], "")

        document.refresh_from_db()
        self.assertEqual(bytes(document.description_binary), raw_binary)

    def test_get_latest_revision_does_not_override_markdown_only_document(self):
        service = DocumentService(user=None)
        document = Document.objects.create(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="markdown-only 文档",
            description_json={},
            description_markdown="# 已恢复内容",
            description_plaintext="已恢复内容",
            latest_version=4,
        )
        DocumentRevision.objects.create(
            document=document,
            version=1,
            content_pm_json={"type": "doc", "content": [{"type": "paragraph"}]},
            content_markdown="# 旧 revision",
            content_plaintext="旧 revision",
        )

        latest_revision = service.get_latest_revision(document)

        self.assertIsNone(latest_revision)

    def test_get_latest_revision_falls_back_for_empty_shell_content(self):
        service = DocumentService(user=None)
        document = Document.objects.create(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="空壳文档",
            description_json={"type": "doc", "content": []},
            description_markdown="<p></p>",
            description_plaintext="",
            latest_version=1,
        )
        revision = DocumentRevision.objects.create(
            document=document,
            version=1,
            content_pm_json={"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "旧内容"}]}]},
            content_markdown="# 旧 revision",
            content_plaintext="旧 revision",
        )

        latest_revision = service.get_latest_revision(document)

        self.assertIsNotNone(latest_revision)
        self.assertEqual(latest_revision.id, revision.id)

    def test_get_latest_revision_does_not_fallback_for_intentionally_cleared_document(self):
        service = DocumentService(user=None)
        document = Document.objects.create(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="已清空文档",
            description_json={"type": "doc", "content": []},
            description_markdown="<p></p>",
            description_plaintext="",
            latest_version=2,
        )
        DocumentRevision.objects.create(
            document=document,
            version=1,
            content_pm_json={"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "旧内容"}]}]},
            content_markdown="# 旧 revision",
            content_plaintext="旧 revision",
        )

        latest_revision = service.get_latest_revision(document)

        self.assertIsNone(latest_revision)

    def test_normalize_tabdata_markdown_only_rewrites_real_block_markers(self):
        markdown = (
            '正文里提到 tabdataBlock 和 tabdata-block，不应被改写。\n\n'
            '示例字符串 :::tabdata{tableId="demo"} 也不应因为不在行首而被改写。\n\n'
            '```ts\n'
            'const legacy = "tabdata-block tabdataBlock :::tabdata{demo}"\n'
            '```\n\n'
            '<div data-type="tabdata-block" class="foo tabdata-block bar"></div>\n\n'
            ':::tabdata{tableId="tbl_1" title="旧表格"}\n:::'
        )

        normalized = normalize_tabdata_markdown(markdown)

        self.assertIn("正文里提到 tabdataBlock 和 tabdata-block，不应被改写。", normalized)
        self.assertIn('const legacy = "tabdata-block tabdataBlock :::tabdata{demo}"', normalized)
        self.assertIn('data-type="tabdata-block"', normalized)
        self.assertIn('class="foo tabdata-block bar"', normalized)
        self.assertIn(':::tabdata{tableId="tbl_1" title="旧表格"}', normalized)

    def test_restore_history_json_snapshot_clears_stale_binary(self):
        service = DocumentService(user=None)
        legacy_snapshot = {
            "format": "json_snapshot",
            "description_json": {
                "type": "doc",
                "content": [
                    {
                        "type": "tabdataBlock",
                        "attrs": {"tableId": "tbl_history", "title": "历史表格"},
                    }
                ],
            },
            "description_markdown": (
                '<div data-type="tabdata-block" data-table-id="tbl_history"'
                ' class="tabdata-block"><p>历史表格</p></div>\n\n'
                ':::tabdata{tableId="tbl_history" title="历史表格"}\n:::'
            ),
            "description_plaintext": "历史表格",
        }
        document = Document.objects.create(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="恢复历史文档",
            description_binary=b"stale-binary",
            description_json={"type": "doc", "content": []},
            description_markdown="# 当前内容",
            description_plaintext="当前内容",
            latest_version=3,
        )
        history = DocHistory.objects.create(
            document=document,
            organization_id=document.organization_id,
            blob=json.dumps(legacy_snapshot, ensure_ascii=False).encode("utf-8"),
            is_snapshot=True,
            editor_type="user",
            editor_id="tester",
        )
        DocUpdate.objects.create(
            document=document,
            blob=b"stale-update",
            editor_type="user",
            editor_id="tester",
        )

        with patch(
            "apps.tabdoc.services.document_service.DocumentService.check_document_permission",
            return_value=True,
        ), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ), patch(
            "apps.tabdoc.services.document_service.DocumentService.push_and_update_binary",
        ):
            restored = service.restore_history(document, str(history.id))

        restored.refresh_from_db()
        self.assertEqual(restored.latest_version, 4)
        self.assertIsNone(restored.description_binary)
        self.assertEqual(restored.description_json["content"][0]["type"], "tabdataBlock")
        self.assertIn("tabdata-block", restored.description_markdown)
        self.assertIn(":::tabdata{", restored.description_markdown)
        self.assertEqual(DocUpdate.objects.filter(document=document).count(), 0)

    def test_save_from_hocuspocus_skips_version_bump_for_already_synced_binary(self):
        service = DocumentService(user=None)
        document = Document.objects.create(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="同步 binary 文档",
            description_binary=b"same-binary",
            description_json={"type": "doc", "content": []},
            description_markdown="<p>同步内容</p>",
            description_plaintext="同步内容",
            latest_version=5,
        )

        with patch(
            "apps.tabdoc.services.document_service.DocumentService._update_search_vector",
            return_value=None,
        ):
            service.save_from_hocuspocus(
                document,
                update_blob=b"same-binary",
                editor_type="agent",
                editor_id="system:restore_history",
                description_html="<p>同步内容</p>",
                description_json={"type": "doc", "content": []},
            )

        document.refresh_from_db()
        self.assertEqual(document.latest_version, 5)

    def test_save_from_hocuspocus_skips_semantic_noop_with_different_yjs_binary(self):
        """打开文档回放缓存元数据时，不应伪造一次文档更新。"""
        service = DocumentService(user=None)
        document = Document.objects.create(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="语义无变化文档",
            description_binary=b"server-binary",
            description_json={"type": "doc", "content": []},
            description_markdown="",
            description_plaintext="",
            latest_version=5,
        )
        original_updated_at = document.updated_at

        with patch(
            "apps.tabdoc.services.document_service.DocumentService._update_search_vector",
            return_value=None,
        ), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ) as bridge_update:
            result = service.save_from_hocuspocus(
                document,
                update_blob=b"client-binary-with-only-metadata",
                editor_type="user",
                editor_id="",
                description_html="",
                description_json={"type": "doc", "content": []},
            )

        self.assertIsNone(result)
        document.refresh_from_db()
        self.assertEqual(document.latest_version, 5)
        self.assertEqual(bytes(document.description_binary), b"server-binary")
        self.assertEqual(document.updated_at, original_updated_at)
        self.assertEqual(DocUpdate.objects.filter(document=document).count(), 0)
        bridge_update.assert_not_called()

    def test_restore_history_yjs_binary_requires_format_conversion(self):
        service = DocumentService(user=None)
        document = Document.objects.create(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="恢复 YJS 历史文档",
            description_binary=b"current-binary",
            description_json={"type": "doc", "content": [{"type": "paragraph"}]},
            description_markdown="# 当前内容",
            description_plaintext="当前内容",
            latest_version=3,
        )
        history = DocHistory.objects.create(
            document=document,
            organization_id=document.organization_id,
            blob=b"\x01restored-yjs-binary",
            is_snapshot=True,
            editor_type="user",
            editor_id="tester",
        )

        with patch(
            "apps.tabdoc.services.document_service.DocumentService.check_document_permission",
            return_value=True,
        ), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ), patch(
            "apps.tabdoc.services.document_service.call_live_api",
            side_effect=RuntimeError("collab-live unavailable"),
        ):
            with self.assertRaisesRegex(ValueError, "暂时无法解析"):
                service.restore_history(document, str(history.id))

        document.refresh_from_db()
        self.assertEqual(document.latest_version, 3)
        self.assertEqual(document.description_binary, b"current-binary")
        self.assertEqual(document.description_markdown, "# 当前内容")


class DocumentStatusGateTests(unittest.TestCase):
    """文档状态门禁：trashed/archived/active 的查看、编辑、协作写入控制"""

    def setUp(self):
        try:
            connection = connections["postgresql"]
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
            existing_tables = set(connection.introspection.table_names())
            with connection.schema_editor() as schema_editor:
                for model in (Document, DocumentPermission, DocHistory, DocUpdate, DocumentVersion, DocumentRevision, DocChunk):
                    if model._meta.db_table not in existing_tables:
                        schema_editor.create_model(model)
                        existing_tables.add(model._meta.db_table)
        except Exception as exc:
            self.skipTest(f"postgresql 不可用，跳过集成测试: {exc}")

    def _create_document(self, status="active", **kwargs):
        defaults = dict(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            title="门禁测试文档",
            description_json={"type": "doc", "content": [{"type": "paragraph"}]},
            description_markdown="# 内容",
            description_plaintext="内容",
            latest_version=1,
            status=status,
        )
        defaults.update(kwargs)
        return Document.objects.create(**defaults)

    def _make_service(self):
        return DocumentService(user=None)

    def _patch_permission(self):
        return patch(
            "apps.tabdoc.services.document_service.DocumentService.check_document_permission",
            return_value=True,
        )

    # ── trashed 文档门禁 ──

    def test_trashed_document_blocked_by_get_document(self):
        doc = self._create_document()
        doc.status = "trashed"
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "回收站"):
                service.get_document(str(doc.id), required_role="viewer")

    def test_trashed_document_accessible_with_allow_trashed(self):
        doc = self._create_document()
        doc.status = "trashed"
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self._patch_permission():
            result = service.get_document(str(doc.id), required_role="editor", allow_trashed=True)
            self.assertEqual(result.id, doc.id)

    def test_trashed_document_blocked_save_content(self):
        doc = self._create_document()
        doc.status = "trashed"
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "回收站"):
                service.save_content(
                    doc,
                    base_version=1,
                    content_pm_json={"type": "doc"},
                    content_markdown="# X",
                    content_plaintext="X",
                )

    def test_trashed_document_blocked_hocuspocus_store(self):
        doc = self._create_document()
        doc.status = "trashed"
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self.assertRaisesRegex(ValueError, "回收站"):
            service.save_from_hocuspocus(
                doc,
                update_blob=b"test-blob",
                editor_type="user",
                editor_id="tester",
            )

    def test_trashed_document_blocked_restore_history(self):
        doc = self._create_document()
        history = DocHistory.objects.create(
            document=doc,
            organization_id=doc.organization_id,
            blob=b"{}",
            is_snapshot=True,
        )
        doc.status = "trashed"
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "回收站"):
                service.restore_history(doc, str(history.id))

    def test_trashed_document_blocked_create_named_version(self):
        doc = self._create_document()
        doc.status = "trashed"
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "回收站"):
                service.create_named_version(doc, name="快照")

    # ── archived 文档门禁 ──

    def test_archived_document_viewable(self):
        doc = self._create_document(status="archived")
        service = self._make_service()
        service.assert_document_viewable(doc)  # 不抛异常

    def test_archived_document_blocked_save_content(self):
        doc = self._create_document(status="archived")
        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "归档"):
                service.save_content(
                    doc,
                    base_version=1,
                    content_pm_json={"type": "doc"},
                    content_markdown="# X",
                    content_plaintext="X",
                )

    def test_archived_document_blocked_collab_write(self):
        doc = self._create_document(status="archived")
        service = self._make_service()
        with self.assertRaisesRegex(ValueError, "active"):
            service.save_from_hocuspocus(
                doc,
                update_blob=b"test-blob",
                editor_type="user",
                editor_id="tester",
            )

    # ── active 文档正常通过 ──

    def test_active_document_all_gates_pass(self):
        doc = self._create_document(status="active")
        service = self._make_service()
        service.assert_document_viewable(doc)
        service.assert_document_content_editable(doc)
        service.assert_document_collab_writable(doc)

    # ── trash_document ──

    def test_trash_document_success(self):
        doc = self._create_document(status="active")
        service = self._make_service()
        with self._patch_permission(), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_trash",
        ), patch(
            "apps.tabdoc.services.document_service.DocumentService._deactivate_document_file_usages",
        ):
            trashed = service.trash_document(doc)
        trashed.refresh_from_db()
        self.assertEqual(trashed.status, "trashed")
        self.assertIsNotNone(trashed.trashed_at)

    def test_trash_document_idempotent_for_trashed(self):
        """#7546：源已 trashed 再 trash 应成功并补齐 ContextItem 投影。"""
        doc = self._create_document(status="trashed")
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self._patch_permission(), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_trash",
            return_value=True,
        ) as on_trash:
            result = service.trash_document(doc)
        self.assertIs(result, doc)
        on_trash.assert_called_once()

    # ── restore_document ──

    def test_restore_document_success(self):
        doc = self._create_document(status="active")
        doc.status = "trashed"
        doc.previous_status = "active"
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at", "previous_status"])

        service = self._make_service()
        with self._patch_permission(), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_restore",
        ), patch(
            "apps.tabdoc.services.document_service.DocumentService._reactivate_document_file_usages",
        ), patch(
            "apps.services.oss.services.reactivate_utils.check_restore_storage_quota",
        ):
            restored = service.restore_document(doc)
        restored.refresh_from_db()
        self.assertEqual(restored.status, "active")
        self.assertIsNone(restored.trashed_at)

    def test_restore_document_rejects_non_trashed(self):
        doc = self._create_document(status="active")
        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "不在回收站"):
                service.restore_document(doc)

    # ── permanent_delete_document ──

    def test_permanent_delete_document_success(self):
        doc = self._create_document(status="trashed")
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])
        doc_id = doc.id

        service = self._make_service()
        with self._patch_permission(), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_delete",
        ), patch(
            "apps.rag.signals._is_rag_enabled", return_value=False,
        ):
            service.permanent_delete_document(doc)
        self.assertFalse(Document.objects.using("postgresql").filter(id=doc_id).exists())

    def test_permanent_delete_rejects_non_trashed(self):
        doc = self._create_document(status="active")
        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "只能永久删除回收站"):
                service.permanent_delete_document(doc)

    # ── update_document gate ──

    def test_update_document_blocked_for_trashed(self):
        doc = self._create_document(status="trashed")
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "回收站"):
                service.update_document(doc, title="new title")

    def test_update_document_blocked_for_archived(self):
        doc = self._create_document(status="archived")
        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "归档"):
                service.update_document(doc, title="new title")

    def test_update_document_bumps_latest_version_with_base_version(self):
        doc = self._create_document(title="旧标题", latest_version=3)
        service = self._make_service()
        with self._patch_permission(), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ):
            updated = service.update_document(
                doc,
                base_version=3,
                title="新标题",
            )

        self.assertEqual(updated.title, "新标题")
        self.assertEqual(updated.latest_version, 4)
        doc.refresh_from_db()
        self.assertEqual(doc.title, "新标题")
        self.assertEqual(doc.latest_version, 4)

    def test_update_document_raises_conflict_on_stale_base_version(self):
        doc = self._create_document(title="旧标题", latest_version=5)
        service = self._make_service()
        with self._patch_permission(), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ):
            with self.assertRaises(ConflictError):
                service.update_document(
                    doc,
                    base_version=4,
                    title="新标题",
                )

        doc.refresh_from_db()
        self.assertEqual(doc.title, "旧标题")
        self.assertEqual(doc.latest_version, 5)

    def test_save_content_can_update_title_in_same_version(self):
        doc = self._create_document(
            title="旧标题",
            latest_version=2,
            description_json={"type": "doc", "content": [{"type": "paragraph"}]},
            description_markdown="旧正文",
            description_plaintext="旧正文",
        )
        service = self._make_service()
        with self._patch_permission(), patch(
            "apps.tabdoc.services.document_service.DocumentService._update_search_vector",
            return_value=None,
        ), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ), patch.object(
            service,
            "push_and_update_binary",
            return_value=None,
        ):
            updated = service.save_content(
                doc,
                base_version=2,
                title="新标题",
                content_pm_json={
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "新正文"}],
                        }
                    ],
                },
                content_markdown="新正文",
                content_plaintext="新正文",
            )

        self.assertEqual(updated.title, "新标题")
        self.assertEqual(updated.latest_version, 3)
        doc.refresh_from_db()
        self.assertEqual(doc.title, "新标题")
        self.assertEqual(doc.description_markdown, "新正文")
        self.assertEqual(doc.latest_version, 3)

    def test_save_content_conflicts_after_concurrent_metadata_update(self):
        doc = self._create_document(
            title="读取时旧标题",
            latest_version=2,
            description_json={"type": "doc", "content": [{"type": "paragraph"}]},
            description_markdown="旧正文",
            description_plaintext="旧正文",
        )
        Document.objects.filter(id=doc.id).update(
            title="并发新标题",
            updated_at=doc.updated_at + timedelta(seconds=1),
        )

        service = self._make_service()
        with self._patch_permission(), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ), patch(
            "apps.tabdoc.services.document_service.DocumentService._update_search_vector",
            return_value=None,
        ):
            with self.assertRaises(ConflictError):
                service.save_content(
                    doc,
                    base_version=2,
                    base_updated_at=(doc.updated_at - timedelta(seconds=5)).isoformat(),
                    content_pm_json={"type": "doc", "content": [{"type": "paragraph"}]},
                    content_markdown="并发后正文",
                    content_plaintext="并发后正文",
                )

        doc.refresh_from_db()
        self.assertEqual(doc.title, "并发新标题")
        self.assertEqual(doc.description_markdown, "旧正文")
        self.assertEqual(doc.latest_version, 2)

    # ── rename_version / delete_named_version gate ──

    def test_rename_version_blocked_for_trashed(self):
        doc = self._create_document(status="trashed")
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "回收站"):
                service.rename_version(doc, str(uuid.uuid4()), "name")

    def test_delete_named_version_blocked_for_archived(self):
        doc = self._create_document(status="archived")
        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "归档"):
                service.delete_named_version(doc, str(uuid.uuid4()))

    # ── archive_document gate ──

    def test_archive_document_blocked_for_trashed(self):
        doc = self._create_document(status="trashed")
        from django.utils import timezone as tz
        doc.trashed_at = tz.now()
        doc.save(update_fields=["status", "trashed_at"])

        service = self._make_service()
        with self._patch_permission():
            with self.assertRaisesRegex(ValueError, "回收站"):
                service.archive_document(doc)


class ContentFallbackClassificationTests(unittest.TestCase):
    """统一 classify_tabdoc_content_state / should_fallback_to_latest_revision 的判定测试"""

    def test_has_primary_content_with_json(self):
        state = classify_tabdoc_content_state(
            description_json={"type": "doc", "content": [{"type": "paragraph"}]},
            description_markdown=None,
            description_plaintext=None,
        )
        self.assertEqual(state, "has_primary_content")

    def test_has_primary_content_with_markdown(self):
        state = classify_tabdoc_content_state(
            description_json={},
            description_markdown="# Hello",
            description_plaintext=None,
        )
        self.assertEqual(state, "has_primary_content")

    def test_has_primary_content_with_plaintext(self):
        state = classify_tabdoc_content_state(
            description_json={},
            description_markdown=None,
            description_plaintext="有内容",
        )
        self.assertEqual(state, "has_primary_content")

    def test_intentionally_empty_when_version_ahead(self):
        state = classify_tabdoc_content_state(
            description_json={"type": "doc", "content": []},
            description_markdown="<p></p>",
            description_plaintext="",
            latest_version=5,
            latest_revision_version=1,
        )
        self.assertEqual(state, "intentionally_empty")

    def test_intentionally_empty_when_no_revision(self):
        state = classify_tabdoc_content_state(
            description_json={"type": "doc", "content": []},
            description_markdown="<p></p>",
            description_plaintext="",
            latest_version=1,
            latest_revision_version=None,
        )
        self.assertEqual(state, "intentionally_empty")

    def test_intentionally_empty_when_has_binary(self):
        state = classify_tabdoc_content_state(
            description_json={"type": "doc", "content": []},
            description_markdown="",
            description_plaintext="",
            latest_version=1,
            latest_revision_version=1,
            has_description_binary=True,
        )
        self.assertEqual(state, "intentionally_empty")

    def test_legacy_needs_fallback(self):
        state = classify_tabdoc_content_state(
            description_json={"type": "doc", "content": []},
            description_markdown="<p></p>",
            description_plaintext="",
            latest_version=1,
            latest_revision_version=1,
        )
        self.assertEqual(state, "legacy_needs_fallback")

    def test_should_fallback_true(self):
        self.assertTrue(should_fallback_to_latest_revision(
            description_json={},
            description_markdown="",
            description_plaintext="",
            latest_version=1,
            latest_revision_version=2,
        ))

    def test_should_fallback_false_with_content(self):
        self.assertFalse(should_fallback_to_latest_revision(
            description_json={"type": "doc", "content": [{"type": "paragraph"}]},
            description_markdown="# OK",
            description_plaintext="OK",
            latest_version=1,
            latest_revision_version=1,
        ))

    def test_should_fallback_false_version_ahead(self):
        self.assertFalse(should_fallback_to_latest_revision(
            description_json={},
            description_markdown="",
            description_plaintext="",
            latest_version=3,
            latest_revision_version=1,
        ))


class DocEventServiceContractTests(unittest.TestCase):
    """DocEventService 事件封装不再传 document_id 关键字，不报 TypeError"""

    def test_publish_save_no_type_error(self):
        from apps.tabdoc.services.doc_event_service import DocEventService
        svc = DocEventService()
        with patch("apps.tabdoc.services.doc_event_service.publish_ws_event_reliable") as mock_pub, \
             patch.object(svc, "_bridge_to_event_bus"):
            result = svc.publish_save(
                "doc-123",
                editor_type="user",
                editor_id="user-1",
                latest_version=5,
            )
            self.assertTrue(result)
            envelope = mock_pub.call_args[0][1]
            self.assertEqual(envelope["type"], "doc.events.save")
            self.assertNotIn("document_id", envelope)
            self.assertEqual(envelope["payload"]["document_id"], "doc-123")
            self.assertNotIn("updated_at", envelope["payload"])

    def test_publish_save_includes_updated_at_when_document_provided(self):
        from datetime import datetime, timezone
        from apps.tabdoc.services.doc_event_service import DocEventService
        from types import SimpleNamespace

        svc = DocEventService()
        doc = SimpleNamespace(updated_at=datetime(2026, 7, 14, 3, 25, 14, tzinfo=timezone.utc))
        with patch("apps.tabdoc.services.doc_event_service.publish_ws_event_reliable") as mock_pub, \
             patch.object(svc, "_bridge_to_event_bus"):
            result = svc.publish_save(
                "doc-123",
                editor_type="user",
                editor_id="user-1",
                latest_version=3,
                document=doc,
            )
            self.assertTrue(result)
            payload = mock_pub.call_args[0][1]["payload"]
            self.assertEqual(payload["latest_version"], 3)
            self.assertEqual(payload["updated_at"], "2026-07-14T03:25:14+00:00")

    def test_publish_editor_change_no_type_error(self):
        from apps.tabdoc.services.doc_event_service import DocEventService
        svc = DocEventService()
        with patch("apps.tabdoc.services.doc_event_service.publish_ws_event_reliable") as mock_pub, \
             patch.object(svc, "_bridge_to_event_bus"):
            result = svc.publish_editor_change(
                "doc-456",
                editor_type="agent",
                editor_id="agent-x",
                action="start",
            )
            self.assertTrue(result)
            envelope = mock_pub.call_args[0][1]
            self.assertEqual(envelope["type"], "doc.events.editor")
            self.assertNotIn("document_id", envelope)

    def test_publish_version_created_no_type_error(self):
        from apps.tabdoc.services.doc_event_service import DocEventService
        svc = DocEventService()
        with patch("apps.tabdoc.services.doc_event_service.publish_ws_event_reliable") as mock_pub, \
             patch.object(svc, "_bridge_to_event_bus"):
            result = svc.publish_version_created(
                "doc-789",
                history_id="hist-1",
            )
            self.assertTrue(result)
            envelope = mock_pub.call_args[0][1]
            self.assertEqual(envelope["type"], "doc.events.version")
            self.assertNotIn("document_id", envelope)
