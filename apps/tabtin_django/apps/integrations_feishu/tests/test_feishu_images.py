"""飞书 Docx 图片转存纯函数单测。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.integrations_feishu.client import FeishuAPIError, FeishuClient
from apps.integrations_feishu.feishu_images import (
    enrich_feishu_docx_markdown_images,
    extract_docx_images_in_order,
    insert_images_into_markdown,
    rewrite_inline_markdown_images,
)


class ExtractDocxImagesTests(SimpleTestCase):
    def test_dfs_order_with_anchor(self):
        blocks = [
            {
                "block_id": "page",
                "block_type": 1,
                "children": ["t1", "img1", "t2", "img2"],
            },
            {
                "block_id": "t1",
                "block_type": 2,
                "text": {"elements": [{"text_run": {"content": "前言段落"}}]},
                "children": [],
            },
            {
                "block_id": "img1",
                "block_type": 27,
                "image": {"token": "boxcnAAA"},
                "children": [],
            },
            {
                "block_id": "t2",
                "block_type": 3,
                "heading1": {"elements": [{"text_run": {"content": "第二节"}}]},
                "children": [],
            },
            {
                "block_id": "img2",
                "block_type": 27,
                "image": {"token": "boxcnBBB"},
                "children": [],
            },
        ]
        images = extract_docx_images_in_order(blocks)
        self.assertEqual([row["token"] for row in images], ["boxcnAAA", "boxcnBBB"])
        self.assertEqual(images[0]["anchor"], "前言段落")
        self.assertEqual(images[1]["anchor"], "第二节")


class RewriteInlineImagesTests(SimpleTestCase):
    def test_rewrites_feishu_stream_url(self):
        calls = []

        def download(token, tmp_url):
            calls.append((token, tmp_url))
            return b"\x89PNG\r\n\x1a\n" + b"x" * 8

        def upload(content, file_name, mime):
            self.assertEqual(mime, "image/png")
            return "https://cdn.example/img.png"

        md = "见下图\n\n![截图](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/boxcnXYZ)\n"
        issues: list = []
        out, tokens = rewrite_inline_markdown_images(
            md,
            download=download,
            upload=upload,
            issues=issues,
            doc_label="测",
        )
        self.assertIn("https://cdn.example/img.png", out)
        self.assertNotIn("internal-api-drive-stream", out)
        self.assertEqual(issues, [])
        self.assertTrue(calls)


class InsertImagesTests(SimpleTestCase):
    def test_insert_after_anchor_or_append(self):
        md = "# 标题\n\n前言段落\n\n更多文字\n"
        uploaded = [
            ({"alt": "图片", "anchor": "前言段落", "token": "a"}, "https://cdn/a.png"),
            ({"alt": "图片", "anchor": "", "token": "b"}, "https://cdn/b.png"),
        ]
        out = insert_images_into_markdown(md, uploaded)
        self.assertIn("![图片](https://cdn/a.png)", out)
        self.assertIn("![图片](https://cdn/b.png)", out)
        # a 应在「更多文字」之前
        self.assertLess(out.index("cdn/a.png"), out.index("更多文字"))


class EnrichMarkdownImagesTests(SimpleTestCase):
    def test_missing_docx_scope_records_issue(self):
        client = MagicMock(spec=FeishuClient)
        client.list_docx_blocks.side_effect = FeishuAPIError(
            "need docx", code=99991679,
        )
        issues: list = []
        out = enrich_feishu_docx_markdown_images(
            "# hi",
            client=client,
            access_token="u",
            doc_token="doc1",
            organization_id=uuid4(),
            user_id="u1",
            issues=issues,
            doc_title="示例",
        )
        self.assertEqual(out, "# hi")
        self.assertEqual(len(issues), 1)
        self.assertIn("重新授权", issues[0])

    def test_block_images_uploaded_into_markdown(self):
        client = MagicMock(spec=FeishuClient)
        client.list_docx_blocks.return_value = [
            {
                "block_id": "page",
                "block_type": 1,
                "children": ["t1", "img1"],
            },
            {
                "block_id": "t1",
                "block_type": 2,
                "text": {"elements": [{"text_run": {"content": "看图"}}]},
                "children": [],
            },
            {
                "block_id": "img1",
                "block_type": 27,
                "image": {"token": "boxcnIMG1"},
                "children": [],
            },
        ]
        client.download_media.return_value = b"\x89PNG\r\n\x1a\n" + b"data"

        fake_record = MagicMock()
        fake_record.id = uuid4()
        fake_record.is_public = False
        fake_record.file_key = "feishu_import/private.png"
        issues: list = []
        uploaded_assets: list = []

        with (
            patch(
                "apps.services.oss.services.factory.get_oss_service",
            ) as mock_oss,
            patch(
                "apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file",
                return_value=fake_record,
            ) as mock_register,
        ):
            mock_oss.return_value.upload_bytes.return_value = "https://oss.example/private.png"
            mock_oss.return_value.set_object_private.return_value = True
            mock_oss.return_value.generate_presigned_url.return_value = (
                "https://oss.example/private.png?sig=short"
            )
            out = enrich_feishu_docx_markdown_images(
                "# 标题\n\n看图\n\n结尾\n",
                client=client,
                access_token="u",
                doc_token="docImg",
                organization_id=uuid4(),
                user_id="u1",
                issues=issues,
                doc_title="有图文档",
                uploaded_assets=uploaded_assets,
            )

        self.assertIn("https://oss.example/private.png?sig=short", out)
        self.assertEqual(
            uploaded_assets,
            [{
                "file_id": str(fake_record.id),
                "url": "https://oss.example/private.png?sig=short",
            }],
        )
        self.assertEqual(issues, [])
        client.download_media.assert_called()
        mock_oss.return_value.set_object_private.assert_called_once()
        mock_oss.return_value.set_object_public_read.assert_not_called()
        self.assertFalse(mock_register.call_args.kwargs["is_public"])
