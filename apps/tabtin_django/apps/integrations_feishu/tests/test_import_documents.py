"""飞书 Docx → TabDoc 导入阶段单测。"""

from __future__ import annotations

import uuid
from contextlib import nullcontext
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from apps.integrations_feishu.client import FeishuAPIError, FeishuAuthError, FeishuClient
from apps.integrations_feishu.import_documents import (
    _bind_private_image_assets,
    import_feishu_documents,
)
from apps.integrations_feishu.import_errors import ImportInterrupted
from apps.integrations_feishu.models import FeishuImportJob

User = get_user_model()


class ImportDocumentsTests(SimpleTestCase):
    def setUp(self):
        lock_patcher = patch(
            "apps.integrations_feishu.import_documents._locked_import_job",
            side_effect=lambda job: nullcontext(job),
        )
        lock_patcher.start()
        self.addCleanup(lock_patcher.stop)

    def test_private_image_binding_replaces_temporary_url_with_file_id(self):
        pm_json = {
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{
                    "type": "image",
                    "attrs": {
                        "src": "https://oss.example/private.png?sig=short",
                        "alt": "截图",
                    },
                }],
            }],
        }

        bound = _bind_private_image_assets(pm_json, [{
            "file_id": "11111111-1111-1111-1111-111111111111",
            "url": "https://oss.example/private.png?sig=short",
        }])

        attrs = pm_json["content"][0]["content"][0]["attrs"]
        self.assertEqual(bound, {"11111111-1111-1111-1111-111111111111"})
        self.assertEqual(attrs["fileId"], "11111111-1111-1111-1111-111111111111")
        self.assertEqual(attrs["src"], "")
        self.assertNotIn("sig=", str(pm_json))

    def test_import_documents_creates_tabdoc(self):
        user = MagicMock()
        user.id = uuid.uuid4()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = uuid.uuid4()
        job.result = {"progress": {"done": 2, "total": 2}, "issues": []}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = "# Hello\n\nworld"
        client.list_docx_blocks.return_value = []

        fake_doc = MagicMock()
        fake_doc.id = uuid.uuid4()
        issues: list = []

        with patch(
            "apps.tabdoc.services.document_service.DocumentService",
        ) as mock_svc_cls:
            mock_svc = mock_svc_cls.return_value
            mock_svc.create_document.return_value = fake_doc
            created = import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docxABC", "name": "示例文档", "doc_type": "docx"}],
                issues=issues,
            )

        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["doc_token"], "docxABC")
        self.assertEqual(created[0]["tabdoc_id"], str(fake_doc.id))
        mock_svc.create_document.assert_called_once()
        kwargs = mock_svc.create_document.call_args.kwargs
        self.assertEqual(kwargs["title"], "示例文档")
        self.assertEqual(kwargs["initial_content_markdown"], "# Hello\n\nworld")
        self.assertEqual(kwargs["collection_id"], str(job.collection_id))
        self.assertEqual(issues, [])

    def test_import_documents_processes_more_than_legacy_limit(self):
        user = MagicMock()
        user.id = uuid.uuid4()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = "# 正文"
        client.list_docx_blocks.return_value = []
        documents = [
            {"doc_token": f"docx-{index}", "name": f"文档 {index}", "doc_type": "docx"}
            for index in range(21)
        ]

        with patch(
            "apps.tabdoc.services.document_service.DocumentService",
        ) as mock_svc_cls:
            fake_doc = MagicMock()
            fake_doc.id = uuid.uuid4()
            mock_svc_cls.return_value.create_document.return_value = fake_doc
            created = import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=documents,
                issues=[],
            )

        self.assertEqual(len(created), 21)
        self.assertEqual(mock_svc_cls.return_value.create_document.call_count, 21)
        self.assertEqual(client.get_docx_markdown.call_count, 21)

    def test_import_documents_renders_whiteboard_flow_as_hierarchy(self):
        user = MagicMock()
        user.id = uuid.uuid4()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = ""
        client.list_docx_blocks.return_value = [
            {"block_type": 1, "page": {}},
            {"block_type": 43, "board": {"token": "whiteboard-token"}},
        ]
        client.list_whiteboard_nodes.return_value = [
            {
                "id": "root",
                "type": "composite_shape",
                "x": 0,
                "y": 0,
                "text": {"text": "流程1"},
            },
            {
                "id": "child",
                "type": "composite_shape",
                "x": 0,
                "y": 100,
                "text": {"text": "步骤2"},
            },
            {
                "id": "edge",
                "type": "connector",
                "connector": {
                    "start": {
                        "arrow_style": "none",
                        "attached_object": {"id": "root"},
                    },
                    "end": {
                        "arrow_style": "line_arrow",
                        "attached_object": {"id": "child"},
                    },
                },
            },
        ]
        fake_doc = MagicMock()
        fake_doc.id = uuid.uuid4()
        issues: list[str] = []

        with patch(
            "apps.tabdoc.services.document_service.DocumentService",
        ) as mock_svc_cls:
            mock_svc = mock_svc_cls.return_value
            mock_svc.create_document.return_value = fake_doc
            import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docx-flow", "name": "流程文档", "doc_type": "docx"}],
                issues=issues,
            )

        markdown = mock_svc.create_document.call_args.kwargs["initial_content_markdown"]
        self.assertIn("## 流程图：流程1", markdown)
        self.assertIn(
            "```text\n流程1\n└─ 步骤2\n```",
            markdown,
        )
        from apps.tabdoc.services.markdown_exchange import markdown_to_pm_json

        pm_json = markdown_to_pm_json(markdown)
        code_blocks = [
            node
            for node in pm_json.get("content", [])
            if node.get("type") == "codeBlock"
        ]
        self.assertEqual(len(code_blocks), 1)
        self.assertEqual(code_blocks[0]["attrs"]["language"], "text")
        self.assertEqual(
            code_blocks[0]["content"][0]["text"],
            "流程1\n└─ 步骤2",
        )
        client.list_whiteboard_nodes.assert_called_once_with(
            "u-token", "whiteboard-token",
        )

    def test_import_documents_retries_transient_whiteboard_failure(self):
        user = MagicMock()
        user.id = uuid.uuid4()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = ""
        client.list_docx_blocks.return_value = [
            {"block_type": 43, "board": {"token": "whiteboard-token"}},
        ]
        client.list_whiteboard_nodes.side_effect = [
            FeishuAPIError("rate limited", status_code=429),
            [{"id": "root", "type": "composite_shape", "text": {"text": "流程1"}}],
        ]
        fake_doc = MagicMock()
        fake_doc.id = uuid.uuid4()

        with (
            patch("apps.tabdoc.services.document_service.DocumentService") as mock_svc_cls,
            patch("apps.integrations_feishu.flow_view.time.sleep"),
        ):
            mock_svc_cls.return_value.create_document.return_value = fake_doc
            created = import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docx-flow", "name": "流程文档", "doc_type": "docx"}],
                issues=[],
            )

        self.assertEqual(len(created), 1)
        self.assertEqual(client.list_whiteboard_nodes.call_count, 2)

    def test_import_documents_does_not_create_document_after_persistent_rate_limit(self):
        user = MagicMock()
        user.id = uuid.uuid4()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = "# 正文"
        client.list_docx_blocks.return_value = [
            {"block_type": 43, "board": {"token": "whiteboard-token"}},
        ]
        client.list_whiteboard_nodes.side_effect = FeishuAPIError(
            "rate limited",
            status_code=429,
        )
        issues: list[str] = []

        with (
            patch("apps.tabdoc.services.document_service.DocumentService") as mock_svc_cls,
            patch("apps.integrations_feishu.flow_view.time.sleep"),
        ):
            created = import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docx-flow", "name": "流程文档", "doc_type": "docx"}],
                issues=issues,
            )

        self.assertEqual(created, [])
        self.assertEqual(client.list_whiteboard_nodes.call_count, 3)
        mock_svc_cls.return_value.create_document.assert_not_called()
        self.assertEqual(job.result["failed_documents"][0]["doc_token"], "docx-flow")
        self.assertEqual(
            job.result["failed_documents"][0]["error"],
            "飞书资源导入失败，请稍后重试",
        )

    def test_import_documents_retries_feishu_business_rate_limit_code(self):
        user = MagicMock()
        user.id = uuid.uuid4()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = ""
        client.list_docx_blocks.return_value = [
            {"block_type": 43, "board": {"token": "whiteboard-token"}},
        ]
        client.list_whiteboard_nodes.side_effect = [
            FeishuAPIError("rate limited", code=99991400, status_code=400),
            [{"id": "root", "type": "composite_shape", "text": {"text": "流程1"}}],
        ]
        fake_doc = MagicMock()
        fake_doc.id = uuid.uuid4()

        with (
            patch("apps.tabdoc.services.document_service.DocumentService") as mock_svc_cls,
            patch("apps.integrations_feishu.flow_view.time.sleep"),
        ):
            mock_svc_cls.return_value.create_document.return_value = fake_doc
            created = import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docx-flow", "name": "流程文档", "doc_type": "docx"}],
                issues=[],
            )

        self.assertEqual(len(created), 1)
        self.assertEqual(client.list_whiteboard_nodes.call_count, 2)

    def test_import_documents_fails_after_persistent_board_rate_limit_code(self):
        user = MagicMock()
        user.id = uuid.uuid4()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = "# 正文"
        client.list_docx_blocks.return_value = [
            {"block_type": 43, "board": {"token": "whiteboard-token"}},
        ]
        client.list_whiteboard_nodes.side_effect = FeishuAPIError(
            "too many requests",
            code=2890006,
            status_code=400,
        )

        with (
            patch("apps.tabdoc.services.document_service.DocumentService") as mock_svc_cls,
            patch("apps.integrations_feishu.flow_view.time.sleep"),
        ):
            created = import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docx-flow", "name": "流程文档", "doc_type": "docx"}],
                issues=[],
            )

        self.assertEqual(created, [])
        self.assertEqual(client.list_whiteboard_nodes.call_count, 3)
        mock_svc_cls.return_value.create_document.assert_not_called()
        self.assertEqual(job.result["failed_documents"][0]["doc_token"], "docx-flow")

    def test_import_documents_normalizes_escaped_html_tables(self):
        user = MagicMock()
        user.id = uuid.uuid4()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = (
            "\\<table\\>\\<tr\\>\\<td\\>A\\</td\\>\\<td\\>B\\</td\\>\\</tr\\>\\</table\\>"
        )
        client.list_docx_blocks.return_value = []
        fake_doc = MagicMock()
        fake_doc.id = uuid.uuid4()

        with patch(
            "apps.tabdoc.services.document_service.DocumentService",
        ) as mock_svc_cls:
            mock_svc = mock_svc_cls.return_value
            mock_svc.create_document.return_value = fake_doc
            import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docxT", "name": "表", "doc_type": "docx"}],
                issues=[],
            )

        md = mock_svc.create_document.call_args.kwargs["initial_content_markdown"]
        self.assertIn("<table>", md)
        self.assertNotIn("\\<", md)

    def test_import_documents_hides_unsupported_export_artifacts_and_reports_fidelity(self):
        user = MagicMock()
        user.id = uuid.uuid4()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = (
            "# 标题\n\n"
            "\\[附件方案\\.pptx\\]\n\n"
            "```Plain Text\n\n```\n\n"
            "1. 后续列表\n\n"
            "[https://www.example.com/video]()"
        )
        client.list_docx_blocks.return_value = [
            {"block_type": 1, "page": {}},
            {"block_type": 14, "code": {"elements": []}},
            {"block_type": 13, "ordered": {}},
            {"block_type": 33, "view": {"view_type": 2}},
            {
                "block_type": 23,
                "file": {"name": "附件方案.pptx", "token": "file-token"},
            },
            {
                "block_type": 26,
                "iframe": {
                    "component": {
                        "url": "https%3A%2F%2Fwww.example.com%2Fvideo",
                    },
                },
            },
        ]
        fake_doc = MagicMock()
        fake_doc.id = uuid.uuid4()
        issues: list[str] = []

        with patch(
            "apps.tabdoc.services.document_service.DocumentService",
        ) as mock_svc_cls:
            mock_svc = mock_svc_cls.return_value
            mock_svc.create_document.return_value = fake_doc
            created = import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docxT", "name": "混合块", "doc_type": "docx"}],
                issues=issues,
            )

        md = mock_svc.create_document.call_args.kwargs["initial_content_markdown"]
        self.assertNotIn("附件方案", md)
        self.assertNotIn("]()", md)
        self.assertIn("```Plain Text\n\n```", md)
        self.assertIn("1. 后续列表", md)
        self.assertEqual(client.list_docx_blocks.call_count, 1)
        self.assertEqual(len(issues), 2)
        self.assertIn("静态降级", issues[0])
        self.assertIn("暂不支持", issues[0])
        self.assertIn("已隐藏 2 处", issues[0])
        self.assertEqual(created[0]["fidelity"], {
            "source_images": 0,
            "imported_images": 0,
            "unsupported_file_blocks": 1,
        })
        self.assertTrue(any("1 个文件块" in issue for issue in issues))

    def test_import_documents_item_failure_does_not_raise(self):
        user = MagicMock()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.side_effect = FeishuAPIError(
            "docs deleted",
            status_code=403,
        )

        issues: list = []
        with patch("apps.tabdoc.services.document_service.DocumentService"):
            created = import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docxX", "name": "无权限", "doc_type": "docx"}],
                issues=issues,
            )

        self.assertEqual(created, [])
        self.assertEqual(len(issues), 1)
        self.assertIn("无权限", issues[0])
        self.assertEqual(
            job.result["failed_documents"],
            [{
                "doc_token": "docxX",
                "name": "无权限",
                "error": "资源已被删除或无法访问",
            }],
        )

    def test_import_documents_raises_auth_error_for_expired_access_token(self):
        job = MagicMock(spec=FeishuImportJob)
        job.user = MagicMock()
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        job.result = {}
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.side_effect = FeishuAPIError(
            "user access token expired",
            code=99991677,
        )

        with patch("apps.tabdoc.services.document_service.DocumentService"):
            with self.assertRaisesRegex(FeishuAuthError, "重新授权"):
                import_feishu_documents(
                    job,
                    client=client,
                    access_token="expired-token",
                    documents=[{"doc_token": "docxX", "name": "文档", "doc_type": "docx"}],
                    issues=[],
                )

    def test_import_documents_skips_already_created_on_retry(self):
        user = MagicMock()
        job = MagicMock(spec=FeishuImportJob)
        job.user = user
        job.organization_id = uuid.uuid4()
        job.collection_id = None
        prior_id = str(uuid.uuid4())
        job.result = {
            "created_documents": [
                {
                    "doc_token": "docxABC",
                    "name": "已导入",
                    "tabdoc_id": prior_id,
                    "doc_type": "docx",
                },
            ],
        }
        job.refresh_from_db = MagicMock()

        client = MagicMock(spec=FeishuClient)
        issues: list = []
        with patch(
            "apps.tabdoc.services.document_service.DocumentService",
        ) as mock_svc_cls:
            created = import_feishu_documents(
                job,
                client=client,
                access_token="u-token",
                documents=[{"doc_token": "docxABC", "name": "已导入", "doc_type": "docx"}],
                issues=issues,
            )

        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["tabdoc_id"], prior_id)
        mock_svc_cls.return_value.create_document.assert_not_called()
        client.get_docx_markdown.assert_not_called()


class ImportDocumentsInterruptionTests(TestCase):
    def test_reauthentication_stops_before_next_document_when_revoke_is_delayed(self):
        user = User.objects.create_user(
            email=f"feishu_docs_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        job = FeishuImportJob.objects.create(
            user=user,
            organization_id=uuid.uuid4(),
            documents=[
                {"doc_token": "docx-one", "name": "One", "doc_type": "docx"},
                {"doc_token": "docx-two", "name": "Two", "doc_type": "docx"},
            ],
            status=FeishuImportJob.Status.RUNNING,
            result={},
        )
        client = MagicMock(spec=FeishuClient)
        client.get_docx_markdown.return_value = "# body"
        client.list_docx_blocks.return_value = []
        first_document = MagicMock(id=uuid.uuid4())

        def interrupt_after_first_document(**_kwargs):
            FeishuImportJob.objects.filter(id=job.id).update(
                status=FeishuImportJob.Status.FAILED,
                error="组织飞书企业应用已重新认证，导入任务已终止",
                result={
                    "phase": "interrupted",
                    "interrupted_reason": "provider_reauthenticated",
                },
            )
            return first_document

        with (
            patch("apps.tabdoc.services.document_service.DocumentService") as service_cls,
            patch("apps.integrations_feishu.import_documents._DOC_GAP_SECONDS", 0),
        ):
            service_cls.return_value.create_document.side_effect = (
                interrupt_after_first_document
            )
            with self.assertRaises(ImportInterrupted):
                import_feishu_documents(
                    job,
                    client=client,
                    access_token="u-token",
                    documents=job.documents,
                    issues=[],
                )

        self.assertEqual(service_cls.return_value.create_document.call_count, 1)
        self.assertEqual(client.get_docx_markdown.call_count, 1)
        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.FAILED)
        self.assertEqual(job.result["phase"], "interrupted")
        self.assertEqual(
            job.result["interrupted_reason"],
            "provider_reauthenticated",
        )


class ListImportableResourcesKindsTests(SimpleTestCase):
    def test_normalize_kinds(self):
        self.assertEqual(
            FeishuClient._normalize_kinds(None),
            ["bitable", "docx"],
        )
        self.assertEqual(
            FeishuClient._normalize_kinds(["docx"]),
            ["docx"],
        )
        self.assertEqual(
            FeishuClient._kind_from_feishu_type("docx"),
            "docx",
        )
        self.assertEqual(
            FeishuClient._kind_from_feishu_type("bitable"),
            "bitable",
        )
        self.assertIsNone(FeishuClient._kind_from_feishu_type("sheet"))
