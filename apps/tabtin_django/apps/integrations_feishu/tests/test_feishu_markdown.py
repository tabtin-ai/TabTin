"""飞书 Docx Markdown 归一化与表格导入。"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.integrations_feishu.feishu_markdown import (
    classify_feishu_docx_blocks,
    find_feishu_docx_structure_issues,
    normalize_feishu_docx_markdown,
    sanitize_feishu_docx_markdown_artifacts,
)
from apps.tabdoc.services.markdown_exchange import markdown_to_pm_json


class FeishuMarkdownNormalizeTests(SimpleTestCase):
    def test_unescapes_angle_brackets_and_callouts(self):
        raw = (
            "前言\n\n"
            '\\<div class="callout"\\>\n\n'
            "重点信息\n\n"
            "\\</div\\>\n\n"
            "\\<table\\>\\<tbody\\>\\<tr\\> \\<td\\>\n\n"
            "版本号\n\n"
            "\\</td\\> \\<td\\>\n\n"
            "日期\n\n"
            "\\</td\\> \\</tr\\>\\</tbody\\>\\</table\\>\n"
        )
        out = normalize_feishu_docx_markdown(raw)
        self.assertNotIn("\\<", out)
        self.assertIn("<table>", out)
        self.assertNotIn('class="callout"', out)
        self.assertIn("重点信息", out)

    def test_normalized_feishu_table_becomes_pm_table(self):
        raw = (
            "# 标题\n\n"
            "\\<table\\>\\<tbody\\> \\<tr\\> \\<td\\>\n\n"
            "**时间**\n\n"
            "\\</td\\> \\<td\\>\n\n"
            "**版本号**\n\n"
            "\\</td\\> \\</tr\\> \\<tr\\> \\<td\\>\n\n"
            "今天\n\n"
            "\\</td\\> \\<td\\>\n\n"
            "1.0\n\n"
            "\\</td\\> \\</tr\\> \\</tbody\\>\\</table\\>\n\n"
            "## 五、需求范围\n"
        )
        md = normalize_feishu_docx_markdown(raw)
        pm = markdown_to_pm_json(md)
        types = [n.get("type") for n in pm.get("content", [])]
        self.assertIn("table", types)
        self.assertIn("heading", types)

        blob = str(pm)
        self.assertNotIn("</td>", blob)
        self.assertNotIn("<table>", blob)

        table = next(n for n in pm["content"] if n.get("type") == "table")
        rows = table.get("content") or []
        self.assertEqual(len(rows), 2)
        first_cell_text = (
            rows[0]["content"][0]["content"][0]["content"][0]["text"]
        )
        self.assertEqual(first_cell_text, "时间")

    def test_filters_only_artifacts_proven_by_unsupported_block_metadata(self):
        raw = (
            "前文\n\n"
            "\\[《方案》播客品牌方案\\.pptx\\]\n\n"
            "[https://www.example.com/video?id=1]()\n\n"
            "普通正文里的《方案》播客品牌方案.pptx 应保留\n\n"
            "后文"
        )
        blocks = [
            {"block_type": 1, "page": {}},
            {"block_type": 33, "view": {"view_type": 2}},
            {
                "block_type": 23,
                "file": {"name": "《方案》播客品牌方案.pptx", "token": "file-token"},
            },
            {
                "block_type": 26,
                "iframe": {
                    "component": {
                        "url": "https%3A%2F%2Fwww.example.com%2Fvideo%3Fid%3D1",
                    },
                },
            },
        ]

        out, removed = sanitize_feishu_docx_markdown_artifacts(raw, blocks)

        self.assertEqual(removed, 2)
        self.assertNotIn("\\[《方案》", out)
        self.assertNotIn("]()", out)
        self.assertIn("普通正文里的《方案》播客品牌方案.pptx 应保留", out)
        self.assertIn("前文", out)
        self.assertIn("后文", out)

    def test_preserves_unproven_artifacts_and_all_fenced_code_content(self):
        raw = (
            "```text\n"
            "[report.pdf]\n"
            "[https://www.example.com/embed]()\n"
            "```\n\n"
            "\\[report\\.pdf\\]\n\n"
            "[用户主动留下的说明]()"
        )
        blocks = [
            {
                "block_type": 23,
                "file": {"name": "report.pdf", "token": "file-token"},
            },
            {
                "block_type": 26,
                "iframe": {
                    "component": {
                        "url": "https%3A%2F%2Fwww.example.com%2Fembed",
                    },
                },
            },
        ]

        out, removed = sanitize_feishu_docx_markdown_artifacts(raw, blocks)

        self.assertEqual(removed, 1)
        self.assertIn("[report.pdf]", out)
        self.assertIn("[https://www.example.com/embed]()", out)
        self.assertNotIn("\\[report\\.pdf\\]", out)
        self.assertIn("[用户主动留下的说明]()", out)

        no_metadata, removed_without_metadata = sanitize_feishu_docx_markdown_artifacts(
            "[用户主动留下的说明]()",
            [],
        )
        self.assertEqual(no_metadata, "[用户主动留下的说明]()")
        self.assertEqual(removed_without_metadata, 0)

    def test_filters_the_artifact_at_its_source_block_position(self):
        iframe_url = "https://www.example.com/embed"
        raw = (
            "文件正文前\n\n"
            "[report.pdf]\n\n"
            "文件正文后\n\n"
            "\\[report\\.pdf\\]\n\n"
            "嵌入正文前\n\n"
            f"[{iframe_url}]()\n\n"
            "嵌入正文后\n\n"
            f"[{iframe_url}]()\n\n"
            "尾声"
        )
        blocks = [
            {
                "block_id": "page",
                "block_type": 1,
                "children": [
                    "user-file-label",
                    "file",
                    "user-iframe-label",
                    "iframe",
                ],
            },
            {
                "block_id": "user-file-label",
                "block_type": 2,
                "text": {"elements": [{"text_run": {"content": "[report.pdf]"}}]},
            },
            {
                "block_id": "file",
                "block_type": 23,
                "file": {"name": "report.pdf", "token": "file-token"},
            },
            {
                "block_id": "user-iframe-label",
                "block_type": 2,
                "text": {
                    "elements": [
                        {"text_run": {"content": f"[{iframe_url}]()"}},
                    ],
                },
            },
            {
                "block_id": "iframe",
                "block_type": 26,
                "iframe": {
                    "component": {
                        "url": "https%3A%2F%2Fwww.example.com%2Fembed",
                    },
                },
            },
        ]

        out, removed = sanitize_feishu_docx_markdown_artifacts(raw, blocks)

        self.assertEqual(removed, 2)
        self.assertEqual(
            [line for line in out.splitlines() if line],
            [
                "文件正文前",
                "[report.pdf]",
                "文件正文后",
                "嵌入正文前",
                f"[{iframe_url}]()",
                "嵌入正文后",
                "尾声",
            ],
        )

    def test_preserves_authored_candidate_when_the_source_artifact_is_absent(self):
        raw = "前文\n\n[report.pdf]\n\n后文"
        blocks = [
            {
                "block_id": "page",
                "block_type": 1,
                "children": ["file", "authored-label"],
            },
            {
                "block_id": "file",
                "block_type": 23,
                "file": {"name": "report.pdf", "token": "file-token"},
            },
            {
                "block_id": "authored-label",
                "block_type": 2,
                "text": {"elements": [{"text_run": {"content": "[report.pdf]"}}]},
            },
        ]

        out, removed = sanitize_feishu_docx_markdown_artifacts(raw, blocks)

        self.assertEqual(out, raw)
        self.assertEqual(removed, 0)

    def test_classifies_direct_static_and_hidden_feishu_blocks(self):
        blocks = [
            {"block_type": 1},
            {"block_type": 14},
            {"block_type": 31},
            {"block_type": 49},
            {"block_type": 2},
            {"block_type": 23},
            {"block_type": 26},
            {"block_type": 999},
            {"block_type": 12345},
        ]

        summary = classify_feishu_docx_blocks(blocks)

        self.assertEqual(summary, {"supported": 4, "degraded": 1, "hidden": 4})

    def test_reports_when_an_empty_source_code_block_swallows_following_text(self):
        blocks = [
            {
                "block_type": 14,
                "code": {"elements": []},
            },
            {
                "block_type": 13,
                "ordered": {
                    "elements": [{"text_run": {"content": "后续列表"}}],
                },
            },
        ]

        issues = find_feishu_docx_structure_issues(
            "```python\n\n1. 后续列表",
            blocks,
        )

        self.assertEqual(len(issues), 1)
        self.assertIn("源空代码块", issues[0])
        self.assertIn("吞入", issues[0])

    def test_structure_check_accepts_spaced_info_string_with_a_real_close(self):
        blocks = [
            {"block_type": 14, "code": {"elements": []}},
            {"block_type": 13, "ordered": {}},
        ]

        issues = find_feishu_docx_structure_issues(
            "```Plain Text\n\n```\n\n1. 后续列表",
            blocks,
        )

        self.assertEqual(issues, [])

    def test_structure_check_uses_block_tree_reading_order(self):
        blocks = [
            {
                "block_id": "page",
                "block_type": 1,
                "children": ["code-nonempty", "code-empty"],
            },
            {
                "block_id": "code-empty",
                "block_type": 14,
                "code": {"elements": []},
            },
            {
                "block_id": "code-nonempty",
                "block_type": 14,
                "code": {
                    "elements": [{"text_run": {"content": "print(1)"}}],
                },
            },
        ]

        issues = find_feishu_docx_structure_issues(
            "```python\nprint(1)\n```\n\n```Plain Text\n\n```",
            blocks,
        )

        self.assertEqual(issues, [])
