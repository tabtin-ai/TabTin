from __future__ import annotations

import unittest

from apps.tabdoc.services.markdown_exchange import (
    markdown_to_pm_json,
    normalize_leaked_htmlblock_markdown,
    pm_json_to_html,
    pm_json_to_markdown,
    pm_json_to_plaintext,
    repair_leaked_htmlblock_in_pm_json,
    render_markdown_html,
    sanitize_html,
)


class MarkdownExchangeTests(unittest.TestCase):
    def test_pm_markdown_projection_tolerates_infinite_embed_dimensions(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {
                        "tableId": "tbl-safe",
                        "title": "任务表",
                        "maxHeight": float("inf"),
                    },
                },
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "fileId": "file-safe",
                        "title": "说明页",
                        "height": float("inf"),
                    },
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "安全正文"}],
                },
            ],
        }

        markdown = pm_json_to_markdown(pm_json)

        self.assertIn('tableId="tbl-safe"', markdown)
        self.assertNotIn("maxHeight", markdown)
        self.assertIn('height="480"', markdown)
        self.assertIn("安全正文", markdown)

    def test_pm_projections_skip_pathological_depth_without_losing_safe_sibling(self):
        deep_node = {"type": "text", "text": "深层内容"}
        for _ in range(1_200):
            deep_node = {"type": "futureContainer", "content": [deep_node]}
        pm_json = {
            "type": "doc",
            "content": [
                deep_node,
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "安全正文"}],
                },
            ],
        }

        self.assertEqual(pm_json_to_markdown(pm_json), "安全正文")
        self.assertEqual(pm_json_to_plaintext(pm_json), "安全正文")

    def test_pm_projections_ignore_structured_values_in_visible_text_fields(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": {"recordId": "rec-secret"}},
                        {"type": "text", "text": "安全正文"},
                    ],
                },
                {
                    "type": "tabdataBlock",
                    "attrs": {
                        "tableId": "tbl-public-contract",
                        "title": {"recordId": "rec-secret"},
                    },
                },
            ],
        }

        markdown = pm_json_to_markdown(pm_json)
        plaintext = pm_json_to_plaintext(pm_json)

        self.assertIn("安全正文", markdown)
        self.assertIn("安全正文", plaintext)
        self.assertNotIn("rec-secret", markdown)
        self.assertNotIn("rec-secret", plaintext)
        self.assertNotIn("recordId", markdown)
        self.assertNotIn("recordId", plaintext)

    def test_pm_json_to_plaintext_preserves_visible_semantics_without_internal_ids(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "加粗正文",
                            "marks": [{"type": "bold"}],
                        }
                    ],
                },
                {
                    "type": "futureContainer",
                    "attrs": {"internalId": "opaque-secret"},
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "未知块可见文字"}],
                        }
                    ],
                },
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl-secret", "title": "项目任务表"},
                },
                {
                    "type": "tabwhiteboard",
                    "attrs": {"canvasId": "canvas-secret", "title": "架构草图"},
                },
                {
                    "type": "htmlBlock",
                    "attrs": {"fileId": "file-secret", "title": "嵌入说明页"},
                },
            ],
        }

        plaintext = pm_json_to_plaintext(pm_json)

        self.assertEqual(
            plaintext,
            "加粗正文\n未知块可见文字\n项目任务表\n架构草图\n嵌入说明页",
        )
        for internal_value in (
            "futureContainer",
            "tabdataBlock",
            "tbl-secret",
            "canvas-secret",
            "file-secret",
        ):
            self.assertNotIn(internal_value, plaintext)

    def test_markdown_to_pm_json_supports_core_blocks(self):
        markdown = """# 标题\n\n- [x] 任务一\n- [ ] 任务二\n\n- 列表项\n\n| 列1 | 列2 |\n| --- | --- |\n| a | b |\n"""
        pm_json = markdown_to_pm_json(markdown)
        self.assertEqual(pm_json.get("type"), "doc")
        node_types = [node.get("type") for node in pm_json.get("content", [])]
        self.assertIn("heading", node_types)
        self.assertIn("taskList", node_types)
        self.assertIn("bulletList", node_types)
        self.assertIn("table", node_types)

    def test_markdown_to_pm_json_parses_tabdata_directive(self):
        markdown = ':::tabdata{tableId="tbl-001" viewId="view-a" maxHeight="620" title="销售数据"}\n:::'
        pm_json = markdown_to_pm_json(markdown)
        node = pm_json["content"][0]
        self.assertEqual(node["type"], "tabdataBlock")
        self.assertEqual(node["attrs"]["tableId"], "tbl-001")
        self.assertEqual(node["attrs"]["viewId"], "view-a")
        self.assertEqual(node["attrs"]["title"], "销售数据")
        self.assertEqual(node["attrs"]["maxHeight"], 620)

    def test_markdown_to_pm_json_rejects_unquoted_or_empty_tabdata_table_id(self):
        """：无引号 / 空 tableId 不得静默落成「未关联表格」。"""
        cases = [
            ':::tabdata{tableId=tbl-001}\n:::',
            ':::tabdata{tableId=""}\n:::',
            ':::tabdata{title="无表"}\n:::',
            ':::tabdata{}\n:::',
            ':::tabdata{tableId="tbl-001"\n:::',
        ]
        for markdown in cases:
            with self.subTest(markdown=markdown):
                with self.assertRaises(ValueError) as ctx:
                    markdown_to_pm_json(markdown)
                self.assertIn("tableId", str(ctx.exception))

    def test_tabdata_attribute_names_require_exact_boundaries(self):
        markdown = (
            ':::tabdata{tableId="tbl-ok" stableViewId="bad" '
            'mytitle="bad" mymaxHeight="999"}\n:::'
        )
        node = markdown_to_pm_json(markdown)["content"][0]
        self.assertEqual(node["attrs"]["tableId"], "tbl-ok")
        self.assertIsNone(node["attrs"]["viewId"])
        self.assertEqual(node["attrs"]["title"], "未命名表格")
        self.assertEqual(node["attrs"]["maxHeight"], 400)

    def test_markdown_pipe_table_is_not_tabdata_block(self):
        """普通 markdown 管道表 ≠ 多维表 tabdataBlock。"""
        markdown = "| 列1 | 列2 |\n| --- | --- |\n| a | b |\n"
        pm_json = markdown_to_pm_json(markdown)
        types = [node.get("type") for node in pm_json.get("content", [])]
        self.assertIn("table", types)
        self.assertNotIn("tabdataBlock", types)

    def test_markdown_to_pm_json_parses_html_table(self):
        """对齐前端 parseHtmlTableBlock：裸 HTML table → PM table。"""
        markdown = (
            "<table>\n"
            '<tr><th colspan="2">Header</th></tr>\n'
            "<tr><td>A</td><td>B</td></tr>\n"
            "</table>\n"
        )
        pm_json = markdown_to_pm_json(markdown)
        table = pm_json["content"][0]
        self.assertEqual(table["type"], "table")
        header = table["content"][0]["content"][0]
        self.assertEqual(header["type"], "tableHeader")
        self.assertEqual(header["attrs"]["colspan"], 2)
        self.assertNotIn("</td>", str(pm_json))

    def test_pm_json_to_markdown_roundtrip_basic(self):
        source = {
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 2},
                    "content": [{"type": "text", "text": "章节"}],
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "正文"}],
                },
            ],
        }
        markdown = pm_json_to_markdown(source)
        self.assertIn("## 章节", markdown)
        self.assertIn("正文", markdown)

    def test_sanitize_html_blocks_script_and_js_url(self):
        unsafe = '<p onclick="alert(1)">ok</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>'
        safe = sanitize_html(unsafe)
        self.assertNotIn("<script", safe.lower())
        self.assertNotIn("onclick", safe.lower())
        self.assertNotIn("javascript:", safe.lower())

    def test_render_markdown_html_is_sanitized(self):
        markdown = "# Hello\n\n<script>alert(1)</script>"
        html = render_markdown_html(markdown)
        self.assertIn("<h1>", html)
        self.assertNotIn("<script", html.lower())

    def test_pm_json_to_html_renders_table(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "table",
                    "content": [
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableHeader",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "content": [{"type": "text", "text": "A"}],
                                        }
                                    ],
                                },
                                {
                                    "type": "tableHeader",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "content": [{"type": "text", "text": "B"}],
                                        }
                                    ],
                                },
                            ],
                        }
                    ],
                }
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn("<table>", html)
        self.assertIn("<th>", html)


    def test_pm_json_to_markdown_preserves_bold(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "normal "},
                        {"type": "text", "text": "bold", "marks": [{"type": "strong"}]},
                        {"type": "text", "text": " text"},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("**bold**", md)
        self.assertIn("normal", md)

    def test_pm_json_to_markdown_preserves_italic(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "emphasis", "marks": [{"type": "em"}]},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("*emphasis*", md)

    def test_pm_json_to_markdown_preserves_inline_code(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "use "},
                        {"type": "text", "text": "useState", "marks": [{"type": "code"}]},
                        {"type": "text", "text": " hook"},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("`useState`", md)

    def test_pm_json_to_markdown_preserves_link(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "visit "},
                        {
                            "type": "text",
                            "text": "Google",
                            "marks": [{"type": "link", "attrs": {"href": "https://google.com"}}],
                        },
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("[Google](https://google.com)", md)

    def test_pm_json_to_markdown_preserves_strikethrough(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "deleted", "marks": [{"type": "strike"}]},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("~~deleted~~", md)

    def test_pm_json_to_markdown_combined_marks(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "important",
                            "marks": [{"type": "strong"}, {"type": "em"}],
                        },
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("**", md)
        self.assertIn("*", md)
        self.assertIn("important", md)

    def test_pm_json_to_markdown_heading_with_marks(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 1},
                    "content": [
                        {"type": "text", "text": "Title with "},
                        {"type": "text", "text": "bold", "marks": [{"type": "strong"}]},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("# Title with **bold**", md)

    def test_pm_json_to_markdown_list_with_marks(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "bulletList",
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [
                                        {"type": "text", "text": "item with "},
                                        {"type": "text", "text": "code", "marks": [{"type": "code"}]},
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("- item with `code`", md)

    def test_pm_json_to_markdown_code_block_no_marks(self):
        """Code block content should remain plain text (no inline marks)."""
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "codeBlock",
                    "attrs": {"language": "python"},
                    "content": [{"type": "text", "text": "print('hello')"}],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("```python", md)
        self.assertIn("print('hello')", md)

    def test_markdown_to_pm_json_preserves_bold(self):
        pm_json = markdown_to_pm_json("Hello **world**")
        para = pm_json["content"][0]
        self.assertEqual(para["type"], "paragraph")
        texts = para["content"]
        bold_nodes = [n for n in texts if any(m.get("type") == "bold" for m in n.get("marks", []))]
        self.assertTrue(len(bold_nodes) > 0, "Should have bold marked text node")
        self.assertEqual(bold_nodes[0]["text"], "world")

    def test_markdown_to_pm_json_preserves_link(self):
        pm_json = markdown_to_pm_json("Visit [Google](https://google.com) now")
        para = pm_json["content"][0]
        link_nodes = [n for n in para["content"] if any(m.get("type") == "link" for m in n.get("marks", []))]
        self.assertTrue(len(link_nodes) > 0)
        self.assertEqual(link_nodes[0]["text"], "Google")
        href = link_nodes[0]["marks"][0]["attrs"]["href"]
        self.assertEqual(href, "https://google.com")

    def test_markdown_to_pm_json_preserves_code(self):
        pm_json = markdown_to_pm_json("Use `useState` hook")
        para = pm_json["content"][0]
        code_nodes = [n for n in para["content"] if any(m.get("type") == "code" for m in n.get("marks", []))]
        self.assertTrue(len(code_nodes) > 0)
        self.assertEqual(code_nodes[0]["text"], "useState")

    def test_markdown_to_pm_json_heading_with_bold(self):
        pm_json = markdown_to_pm_json("# Title **bold**")
        heading = pm_json["content"][0]
        self.assertEqual(heading["type"], "heading")
        bold_nodes = [n for n in heading["content"] if any(m.get("type") == "bold" for m in n.get("marks", []))]
        self.assertTrue(len(bold_nodes) > 0)

    def test_pm_json_to_markdown_horizontal_rule(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "above"}]},
                {"type": "horizontalRule"},
                {"type": "paragraph", "content": [{"type": "text", "text": "below"}]},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("---", md)

    # ── image / mathematics / youtube 节点（上一轮新增能力） ────────

    def test_pm_json_to_markdown_image_node(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "https://img.example.com/a.png", "alt": "截图", "title": ""}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("![截图](https://img.example.com/a.png)", md)

    def test_pm_json_to_markdown_image_node_with_platform_object_key(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "tabdoc/images/hash.png", "alt": "本地对象"}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("![本地对象](tabdoc/images/hash.png)", md)

    def test_pm_json_to_markdown_image_node_with_data_uri(self):
        data_uri = "data:image/png;base64,iVBORw0KGgo="
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": data_uri, "alt": "内联图"}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn(f"![内联图]({data_uri})", md)

    def test_pm_json_to_markdown_image_ignores_dimensions(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "image",
                    "attrs": {
                        "src": "https://img.example.com/a.png",
                        "alt": "截图",
                        "width": 320,
                        "height": 180,
                    },
                },
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("![截图](https://img.example.com/a.png)", md)

    def test_pm_json_to_markdown_ignores_unsupported_rich_marks(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "重点文本",
                            "marks": [
                                {"type": "underline"},
                                {"type": "textStyle", "attrs": {"color": "#9333EA"}},
                                {"type": "highlight", "attrs": {"color": "#fef9c3"}},
                            ],
                        }
                    ],
                },
            ],
        }

        md = pm_json_to_markdown(pm_json)

        self.assertEqual("重点文本", md)

    def test_pm_json_to_markdown_mathematics_inline(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "mathematics", "attrs": {"latex": "x^2+1", "display": False}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("$x^2+1$", md)
        self.assertNotIn("$$", md)

    def test_pm_json_to_markdown_mathematics_display(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "mathematics", "attrs": {"latex": "\\int_0^1 f(x)dx", "display": True}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("$$", md)
        self.assertIn("\\int_0^1 f(x)dx", md)

    def test_pm_json_to_markdown_youtube_node(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "youtube", "attrs": {"src": "https://www.youtube.com/watch?v=abc"}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("[YouTube]", md)
        self.assertIn("https://www.youtube.com/watch?v=abc", md)

    def test_pm_json_to_html_image_node(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "https://img.example.com/b.jpg", "alt": "photo"}},
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn("<img", html)
        self.assertIn('src="https://img.example.com/b.jpg"', html)
        self.assertIn('alt="photo"', html)

    def test_pm_json_to_html_image_preserves_dimensions(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "image",
                    "attrs": {
                        "src": "https://img.example.com/b.jpg",
                        "alt": "photo",
                        "width": "240px",
                        "height": "135",
                    },
                },
            ],
        }
        result_html = pm_json_to_html(pm_json)
        self.assertIn('width="240"', result_html)
        self.assertIn('height="135"', result_html)
        self.assertIn('style="width: 240px; height: 135px"', result_html)

    def test_pm_json_to_html_mathematics_node(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "mathematics", "attrs": {"latex": "a^2+b^2=c^2", "display": True}},
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn("math", html)
        self.assertIn("a^2+b^2=c^2", html)

    def test_pm_json_to_html_unsafe_image_src_filtered(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "javascript:alert(1)", "alt": "xss"}},
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertNotIn("javascript:", html)
        self.assertNotIn("<img", html)

    def test_sanitize_html_preserves_math_tags(self):
        html_input = '<div class="math">$$E=mc^2$$</div><span class="math">$x$</span>'
        safe = sanitize_html(html_input)
        self.assertIn("E=mc^2", safe)
        self.assertIn("$x$", safe)
        self.assertIn('<div class="math">', safe)
        self.assertIn('<span class="math">', safe)


    # ── Round 3: bold/italic mark 名称兼容 ─────────────────────────

    def test_pm_json_to_markdown_bold_mark_compat(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "normal "},
                        {"type": "text", "text": "加粗", "marks": [{"type": "bold"}]},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("**加粗**", md)

    def test_pm_json_to_markdown_italic_mark_compat(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "斜体", "marks": [{"type": "italic"}]},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("*斜体*", md)

    def test_pm_json_to_html_bold_italic_mark_compat(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "粗体", "marks": [{"type": "bold"}]},
                        {"type": "text", "text": "斜体", "marks": [{"type": "italic"}]},
                    ],
                }
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn("<strong>粗体</strong>", html)
        self.assertIn("<em>斜体</em>", html)

    # ── Round 3: tabdataBlock 导出 ──────────────────────────────

    def test_pm_json_to_markdown_tabdata_block(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl-001", "viewId": "view-a", "title": "销售数据", "maxHeight": 620},
                },
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn(':::tabdata{', md)
        self.assertIn('tableId="tbl-001"', md)
        self.assertIn('viewId="view-a"', md)
        self.assertIn('maxHeight="620"', md)
        self.assertIn('title="销售数据"', md)
        self.assertIn(':::', md)

    def test_pm_json_to_markdown_tabdata_block_no_view_id(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl-002", "title": "汇总表"},
                },
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn('tableId="tbl-002"', md)
        self.assertNotIn('viewId=', md)

    def test_pm_json_to_markdown_tabdata_block_defaults_title(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl-003"},
                },
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn('title="未命名表格"', md)

    def test_pm_json_to_markdown_tabdata_block_empty_table_id(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "tabdataBlock", "attrs": {"tableId": "", "title": "空ID"}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertNotIn(':::tabdata', md)
        self.assertIn('[表格: 空ID]', md)

    def test_pm_json_to_html_tabdata_block_empty_table_id(self):
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "tabdataBlock", "attrs": {"tableId": "", "title": "空ID表格"}},
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn("[表格: 空ID表格]", html)
        self.assertNotIn('data-table-id', html)

    def test_pm_json_to_html_tabdata_block_xss_title(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl-xss", "title": '"><script>alert(1)</script>'},
                },
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_sanitize_html_preserves_tabdata_data_attrs(self):
        html_input = (
            '<div data-type="tabdata-block" data-table-id="tbl-001"'
            ' data-table-title="报表" data-view-id="v1"'
            ' class="tabdata-block"><p>报表</p></div>'
        )
        safe = sanitize_html(html_input)
        self.assertIn('data-type="tabdata-block"', safe)
        self.assertIn('data-table-id="tbl-001"', safe)
        self.assertIn('data-table-title="报表"', safe)
        self.assertIn('data-view-id="v1"', safe)

    def test_pm_json_to_html_tabdata_block(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": "tbl-001", "viewId": "v1", "title": "报表", "maxHeight": 560},
                },
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn('data-type="tabdata-block"', html)
        self.assertIn('data-table-id="tbl-001"', html)
        self.assertIn('data-table-title="报表"', html)
        self.assertIn('data-view-id="v1"', html)
        self.assertIn('data-max-height="560"', html)
        self.assertIn('class="tabdata-block"', html)

    # ── Round 3: 行内 image/mathematics ─────────────────────────

    def test_inline_image_in_paragraph_markdown(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "看这张图 "},
                        {"type": "image", "attrs": {"src": "https://img.example.com/a.png", "alt": "截图"}},
                        {"type": "text", "text": " 很好看"},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("![截图](https://img.example.com/a.png)", md)
        self.assertIn("看这张图", md)
        self.assertIn("很好看", md)

    def test_inline_image_in_paragraph_html(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "图片: "},
                        {"type": "image", "attrs": {"src": "https://img.example.com/b.jpg", "alt": "photo"}},
                    ],
                }
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn("<img", html)
        self.assertIn('src="https://img.example.com/b.jpg"', html)
        self.assertIn("图片:", html)

    def test_inline_image_in_paragraph_html_preserves_dimensions(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "图片: "},
                        {
                            "type": "image",
                            "attrs": {
                                "src": "https://img.example.com/b.jpg",
                                "alt": "photo",
                                "width": 120,
                                "height": 80,
                            },
                        },
                    ],
                }
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn('width="120"', html)
        self.assertIn('height="80"', html)

    def test_inline_math_in_paragraph_markdown(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "公式 "},
                        {"type": "mathematics", "attrs": {"latex": "x^2+1"}},
                        {"type": "text", "text": " 成立"},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("$x^2+1$", md)
        self.assertIn("公式", md)

    def test_inline_math_in_paragraph_html(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "其中 "},
                        {"type": "mathematics", "attrs": {"latex": "a+b"}},
                    ],
                }
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn('<span class="math">', html)
        self.assertIn("a+b", html)

    # ── Round 3: 嵌套列表 ───────────────────────────────────────

    def test_nested_bullet_list_markdown(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "bulletList",
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {"type": "paragraph", "content": [{"type": "text", "text": "一级"}]},
                                {
                                    "type": "bulletList",
                                    "content": [
                                        {
                                            "type": "listItem",
                                            "content": [
                                                {"type": "paragraph", "content": [{"type": "text", "text": "二级A"}]},
                                            ],
                                        },
                                        {
                                            "type": "listItem",
                                            "content": [
                                                {"type": "paragraph", "content": [{"type": "text", "text": "二级B"}]},
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            "type": "listItem",
                            "content": [
                                {"type": "paragraph", "content": [{"type": "text", "text": "另一个一级"}]},
                            ],
                        },
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("- 一级", md)
        self.assertIn("  - 二级A", md)
        self.assertIn("  - 二级B", md)
        self.assertIn("- 另一个一级", md)

    def test_nested_ordered_list_markdown(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "orderedList",
                    "attrs": {"start": 1},
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {"type": "paragraph", "content": [{"type": "text", "text": "第一步"}]},
                                {
                                    "type": "orderedList",
                                    "attrs": {"start": 1},
                                    "content": [
                                        {
                                            "type": "listItem",
                                            "content": [
                                                {"type": "paragraph", "content": [{"type": "text", "text": "子步骤"}]},
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("1. 第一步", md)
        self.assertIn("  1. 子步骤", md)


    # ── image-in-link 嵌套解析 ────────────────────────────────────

    def test_markdown_to_pm_json_image_in_link(self):
        """[![alt](img-url)](link-url) should produce an image node with a link mark."""
        pm_json = markdown_to_pm_json("[![photo](https://img.example.com/a.png)](https://example.com)")
        para = pm_json["content"][0]
        self.assertEqual(para["type"], "paragraph")
        img_nodes = [n for n in para["content"] if n.get("type") == "image"]
        self.assertEqual(len(img_nodes), 1, "Should have exactly one image node")
        img = img_nodes[0]
        self.assertEqual(img["attrs"]["src"], "https://img.example.com/a.png")
        self.assertEqual(img["attrs"]["alt"], "photo")
        link_marks = [m for m in img.get("marks", []) if m.get("type") == "link"]
        self.assertEqual(len(link_marks), 1, "Image should carry a link mark")
        self.assertEqual(link_marks[0]["attrs"]["href"], "https://example.com")

    def test_markdown_to_pm_json_standalone_image(self):
        """![alt](url) without link wrapper should produce a plain image node."""
        pm_json = markdown_to_pm_json("![截图](https://img.example.com/b.png)")
        para = pm_json["content"][0]
        img_nodes = [n for n in para["content"] if n.get("type") == "image"]
        self.assertEqual(len(img_nodes), 1)
        self.assertEqual(img_nodes[0]["attrs"]["src"], "https://img.example.com/b.png")
        self.assertFalse(img_nodes[0].get("marks"))

    def test_markdown_to_pm_json_standalone_html_image_preserves_dimensions(self):
        pm_json = markdown_to_pm_json(
            '<img src="https://img.example.com/b.png" alt="截图" width="320" height="180">'
        )
        para = pm_json["content"][0]
        img_nodes = [n for n in para["content"] if n.get("type") == "image"]
        self.assertEqual(len(img_nodes), 1)
        self.assertEqual(img_nodes[0]["attrs"]["src"], "https://img.example.com/b.png")
        self.assertEqual(img_nodes[0]["attrs"]["alt"], "截图")
        self.assertEqual(img_nodes[0]["attrs"]["width"], 320)
        self.assertEqual(img_nodes[0]["attrs"]["height"], 180)

    def test_markdown_to_pm_json_standalone_html_image_clamps_dimensions(self):
        pm_json = markdown_to_pm_json(
            '<img src="https://img.example.com/b.png" alt="截图" width="999999999" height="20000">'
        )
        para = pm_json["content"][0]
        img_nodes = [n for n in para["content"] if n.get("type") == "image"]
        self.assertEqual(len(img_nodes), 1)
        self.assertEqual(img_nodes[0]["attrs"]["width"], 10000)
        self.assertEqual(img_nodes[0]["attrs"]["height"], 10000)

    def test_markdown_to_pm_json_image_with_surrounding_text(self):
        """Image in text context should preserve surrounding text nodes."""
        pm_json = markdown_to_pm_json("before ![alt](https://img.com/a.png) after")
        para = pm_json["content"][0]
        types = [n.get("type") for n in para["content"]]
        self.assertEqual(types, ["text", "image", "text"])
        self.assertEqual(para["content"][0]["text"], "before ")
        self.assertEqual(para["content"][2]["text"], " after")

    def test_pm_json_to_markdown_image_with_link_mark(self):
        """Image node with link mark should serialize to [![alt](src)](href)."""
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "image",
                            "attrs": {"src": "https://img.example.com/a.png", "alt": "photo"},
                            "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}],
                        }
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("[![photo](https://img.example.com/a.png)](https://example.com)", md)

    def test_pm_json_to_html_image_with_link_mark(self):
        """Image node with link mark should render as <a><img/></a> in HTML."""
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "image",
                            "attrs": {"src": "https://img.example.com/a.png", "alt": "photo"},
                            "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}],
                        }
                    ],
                }
            ],
        }
        result_html = pm_json_to_html(pm_json)
        self.assertIn('<a href="https://example.com">', result_html)
        self.assertIn('<img src="https://img.example.com/a.png"', result_html)
        self.assertIn("</a>", result_html)

    def test_image_in_link_roundtrip(self):
        """Markdown → PM JSON → Markdown roundtrip for image-in-link."""
        source_md = "[![photo](https://img.example.com/a.png)](https://example.com)"
        pm_json = markdown_to_pm_json(source_md)
        md = pm_json_to_markdown(pm_json)
        self.assertIn("[![photo](https://img.example.com/a.png)](https://example.com)", md)

    def test_markdown_to_pm_json_bold_containing_link(self):
        """**[text](url)** should produce a text node with both bold and link marks."""
        pm_json = markdown_to_pm_json("**[click](https://example.com)**")
        para = pm_json["content"][0]
        linked = [n for n in para["content"] if any(m.get("type") == "link" for m in n.get("marks", []))]
        self.assertTrue(len(linked) > 0)
        self.assertTrue(any(m.get("type") == "bold" for m in linked[0].get("marks", [])))

    def test_pm_json_to_html_image_with_unsafe_link(self):
        """Image with javascript: link should not render the link wrapper."""
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "image",
                            "attrs": {"src": "https://img.example.com/a.png", "alt": "photo"},
                            "marks": [{"type": "link", "attrs": {"href": "javascript:alert(1)"}}],
                        }
                    ],
                }
            ],
        }
        result_html = pm_json_to_html(pm_json)
        self.assertNotIn("javascript:", result_html)
        self.assertIn("<img", result_html)
        self.assertNotIn("<a", result_html)


    def test_code_block_with_nested_fences_roundtrip(self):
        """Code block whose content contains triple backticks should roundtrip cleanly."""
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "codeBlock",
                    "attrs": {"language": None},
                    "content": [
                        {"type": "text", "text": "# Hello\n\n```python\ndef foo():\n    pass\n```\n\nMore text"}
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertTrue(md.startswith("````"), f"Expected 4+ backtick fence, got: {md[:20]}")
        reparsed = markdown_to_pm_json(md)
        self.assertEqual(len(reparsed["content"]), 1, "Should parse as a single code block")
        self.assertEqual(reparsed["content"][0]["type"], "codeBlock")

    def test_variable_length_fence_parsing(self):
        """Parser should respect variable-length code fences per CommonMark."""
        md = "````\n```python\ndef x():\n    pass\n```\n````"
        pm_json = markdown_to_pm_json(md)
        self.assertEqual(len(pm_json["content"]), 1)
        self.assertEqual(pm_json["content"][0]["type"], "codeBlock")
        code_text = pm_json["content"][0]["content"][0]["text"]
        self.assertIn("```python", code_text)

    def test_code_fence_with_spaced_info_string_closes_before_following_blocks(self):
        """Feishu emits labels such as ``Plain Text`` after an opening fence."""
        md = "```Plain Text\n\n```\n\n1. Gs\n\n# gsttu1"

        pm_json = markdown_to_pm_json(md)

        self.assertEqual(
            [node["type"] for node in pm_json["content"]],
            ["codeBlock", "orderedList", "heading"],
        )
        self.assertEqual(pm_json["content"][0]["attrs"]["language"], "Plain Text")
        self.assertEqual(pm_json["content"][0]["content"], [])


    # ── XP-07: mathematicsBlock 序列化 ───────────────────────────

    def test_pm_json_to_markdown_mathematics_block_node(self):
        """mathematicsBlock should serialize to $$...$$."""
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "mathematicsBlock", "attrs": {"latex": "\\sum_{i=1}^{n} x_i"}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("$$", md)
        self.assertIn("\\sum_{i=1}^{n} x_i", md)

    def test_pm_json_to_markdown_mathematics_block_empty_latex(self):
        """mathematicsBlock with empty latex should produce no output."""
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "mathematicsBlock", "attrs": {"latex": ""}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertEqual(md.strip(), "")

    def test_pm_json_to_html_mathematics_block_node(self):
        """mathematicsBlock should render as <div class="math">."""
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "mathematicsBlock", "attrs": {"latex": "E=mc^2"}},
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn('<div class="math">', html)
        self.assertIn("E=mc^2", html)
        self.assertIn("$$", html)

    def test_mathematics_block_roundtrip(self):
        """mathematicsBlock → markdown → pm_json should produce mathematicsBlock."""
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "mathematicsBlock", "attrs": {"latex": "a^2 + b^2 = c^2"}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        reparsed = markdown_to_pm_json(md)
        math_nodes = [n for n in reparsed["content"] if n.get("type") == "mathematicsBlock"]
        self.assertEqual(len(math_nodes), 1)
        self.assertEqual(math_nodes[0]["attrs"]["latex"], "a^2 + b^2 = c^2")

    # ── XP-09: hardBreak 往返 ─────────────────────────────────────

    def test_hard_break_deserialization(self):
        """Trailing double spaces should produce hardBreak nodes."""
        md = "line one  \nline two"
        pm_json = markdown_to_pm_json(md)
        para = pm_json["content"][0]
        self.assertEqual(para["type"], "paragraph")
        node_types = [n.get("type") for n in para["content"]]
        self.assertIn("hardBreak", node_types)

    def test_hard_break_roundtrip(self):
        """hardBreak → markdown → pm_json should preserve hardBreak."""
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "first line"},
                        {"type": "hardBreak"},
                        {"type": "text", "text": "second line"},
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("  \n", md)
        reparsed = markdown_to_pm_json(md)
        para = reparsed["content"][0]
        types = [n.get("type") for n in para["content"]]
        self.assertIn("hardBreak", types)
        texts = [n.get("text", "") for n in para["content"] if n.get("type") == "text"]
        self.assertIn("first line", texts)
        self.assertIn("second line", texts)

    def test_hard_break_no_false_positive(self):
        """Single trailing space should NOT produce hardBreak."""
        md = "line one \nline two"
        pm_json = markdown_to_pm_json(md)
        para = pm_json["content"][0]
        node_types = [n.get("type") for n in para["content"]]
        self.assertNotIn("hardBreak", node_types)

    # ── XP-10: Setext 标题识别 ────────────────────────────────────

    def test_setext_h1_parsing(self):
        """Text followed by === should parse as H1."""
        md = "My Title\n========"
        pm_json = markdown_to_pm_json(md)
        self.assertEqual(len(pm_json["content"]), 1)
        heading = pm_json["content"][0]
        self.assertEqual(heading["type"], "heading")
        self.assertEqual(heading["attrs"]["level"], 1)
        text = heading["content"][0]["text"]
        self.assertEqual(text, "My Title")

    def test_setext_h2_parsing(self):
        """Text followed by --- should parse as H2, not paragraph + HR."""
        md = "My Subtitle\n-----------"
        pm_json = markdown_to_pm_json(md)
        self.assertEqual(len(pm_json["content"]), 1)
        heading = pm_json["content"][0]
        self.assertEqual(heading["type"], "heading")
        self.assertEqual(heading["attrs"]["level"], 2)
        text = heading["content"][0]["text"]
        self.assertEqual(text, "My Subtitle")

    def test_setext_h2_not_confused_with_hr(self):
        """--- preceded by text = H2; --- alone = HR."""
        md = "Heading\n---\n\n---"
        pm_json = markdown_to_pm_json(md)
        types = [n.get("type") for n in pm_json["content"]]
        self.assertEqual(types, ["heading", "horizontalRule"])
        self.assertEqual(pm_json["content"][0]["attrs"]["level"], 2)

    def test_standalone_hr_still_works(self):
        """--- without preceding paragraph text should remain an HR."""
        md = "above\n\n---\n\nbelow"
        pm_json = markdown_to_pm_json(md)
        types = [n.get("type") for n in pm_json["content"]]
        self.assertEqual(types, ["paragraph", "horizontalRule", "paragraph"])

    def test_setext_h1_with_inline_marks(self):
        """Setext H1 should preserve inline marks like bold."""
        md = "Title **bold**\n=============="
        pm_json = markdown_to_pm_json(md)
        heading = pm_json["content"][0]
        self.assertEqual(heading["type"], "heading")
        self.assertEqual(heading["attrs"]["level"], 1)
        bold_nodes = [n for n in heading["content"]
                      if any(m.get("type") in ("strong", "bold") for m in n.get("marks", []))]
        self.assertTrue(len(bold_nodes) > 0)


    # ── EI-003 / EIP-028: blockquote 递归深度保护 ──────────────────

    def test_deep_nested_blockquote_no_crash(self):
        """50+ 层嵌套 blockquote 应安全降级为段落，不触发 RecursionError。"""
        depth = 60
        md = ">" * depth + " deep content"
        pm_json = markdown_to_pm_json(md)
        self.assertEqual(pm_json["type"], "doc")
        self.assertTrue(len(pm_json["content"]) > 0)

    def test_blockquote_depth_20_still_works(self):
        """20 层以内的 blockquote 嵌套应正常递归解析。"""
        lines = []
        for i in range(15):
            lines.append(">" * (i + 1) + " level " + str(i + 1))
        md = "\n".join(lines)
        pm_json = markdown_to_pm_json(md)
        self.assertEqual(pm_json["type"], "doc")

    # ── EI-014: 零宽字符不应干扰 flanking ─────────────────────────

    def test_zero_width_space_around_underscore(self):
        """U+200B 零宽空格不应导致 _word_ 被误解析为斜体。"""
        md = "text\u200b_word_\u200bmore"
        pm_json = markdown_to_pm_json(md)
        para = pm_json["content"][0]
        has_italic = any(
            any(m.get("type") == "italic" for m in n.get("marks", []))
            for n in para.get("content", [])
        )
        self.assertFalse(has_italic, "Zero-width space should not enable underscore italic")

    # ── EI-015 / EIP-027: CJK 文本 _ 不应触发斜体 ─────────────────

    def test_cjk_underscore_no_italic(self):
        """中文旁的 _word_ 不应被解析为斜体（flanking 规则）。"""
        md = "中文_word_继续"
        pm_json = markdown_to_pm_json(md)
        para = pm_json["content"][0]
        has_italic = any(
            any(m.get("type") == "italic" for m in n.get("marks", []))
            for n in para.get("content", [])
        )
        self.assertFalse(has_italic, "CJK context should prevent underscore italic")

    def test_underscore_word_boundary_italic(self):
        """空格后的 _word_ 应正常解析为斜体。"""
        md = "hello _world_ end"
        pm_json = markdown_to_pm_json(md)
        para = pm_json["content"][0]
        italic_nodes = [
            n for n in para.get("content", [])
            if any(m.get("type") == "italic" for m in n.get("marks", []))
        ]
        self.assertTrue(len(italic_nodes) > 0, "Underscore at word boundary should produce italic")
        self.assertEqual(italic_nodes[0]["text"], "world")

    def test_snake_case_no_italic(self):
        """foo_bar_baz 蛇形命名不应触发斜体。"""
        md = "use foo_bar_baz variable"
        pm_json = markdown_to_pm_json(md)
        para = pm_json["content"][0]
        has_italic = any(
            any(m.get("type") == "italic" for m in n.get("marks", []))
            for n in para.get("content", [])
        )
        self.assertFalse(has_italic, "Snake case foo_bar_baz should not trigger italic")

    # ── EIP-005: 列表空行不应截断 ─────────────────────────────────

    def test_list_items_with_blank_lines(self):
        """列表项之间有空行不应截断列表。"""
        md = "- item 1\n\n- item 2\n\n- item 3"
        pm_json = markdown_to_pm_json(md)
        bullet_lists = [n for n in pm_json["content"] if n.get("type") == "bulletList"]
        self.assertEqual(len(bullet_lists), 1, "Should produce a single bulletList")
        items = bullet_lists[0]["content"]
        self.assertEqual(len(items), 3, "All three items should be in the same list")

    def test_ordered_list_with_blank_lines(self):
        """有序列表项之间有空行不应截断。"""
        md = "1. first\n\n2. second\n\n3. third"
        pm_json = markdown_to_pm_json(md)
        ordered_lists = [n for n in pm_json["content"] if n.get("type") == "orderedList"]
        self.assertEqual(len(ordered_lists), 1, "Should produce a single orderedList")
        items = ordered_lists[0]["content"]
        self.assertEqual(len(items), 3)

    def test_nested_list_after_blank_line(self):
        """嵌套子列表前有空行不应导致子列表脱离父级。"""
        md = "- parent\n\n  - child 1\n  - child 2"
        pm_json = markdown_to_pm_json(md)
        bullet_lists = [n for n in pm_json["content"] if n.get("type") == "bulletList"]
        self.assertEqual(len(bullet_lists), 1, "Nested list should stay in parent")
        parent_item = bullet_lists[0]["content"][0]
        nested = [c for c in parent_item.get("content", []) if c.get("type") == "bulletList"]
        self.assertEqual(len(nested), 1, "Child list should be nested")

    # ── EIP-025: 嵌套 mark 深度保护 ───────────────────────────────

    def test_deeply_nested_marks_no_crash(self):
        """30+ 层嵌套 bold/italic 不应栈溢出。"""
        md = "***" * 30 + "deep" + "***" * 30
        pm_json = markdown_to_pm_json(md)
        self.assertEqual(pm_json["type"], "doc")
        self.assertTrue(len(pm_json["content"]) > 0)

    # ── EIP-029: 大量未匹配 * 不应过慢 ───────────────────────────

    def test_many_unmatched_stars_performance(self):
        """大量未匹配的 * 字符不应导致过长的解析时间。"""
        import time
        md = "* " * 500
        start = time.monotonic()
        pm_json = markdown_to_pm_json(md)
        elapsed = time.monotonic() - start
        self.assertEqual(pm_json["type"], "doc")
        self.assertLess(elapsed, 5.0, "Parsing 500 unmatched stars should complete within 5s")

    # ── : htmlBlock（HTML 嵌入块）───────────────────────────

    def test_markdown_to_pm_json_parses_htmlblock_directive(self):
        markdown = (
            ':::htmlblock{fileId="file-001" src="https://oss.example.com/a.html"'
            ' title="架构图" height="600"}\n:::'
        )
        pm_json = markdown_to_pm_json(markdown)
        node = pm_json["content"][0]
        self.assertEqual(node["type"], "htmlBlock")
        self.assertEqual(node["attrs"]["fileId"], "file-001")
        self.assertEqual(node["attrs"]["src"], "https://oss.example.com/a.html")
        self.assertEqual(node["attrs"]["title"], "架构图")
        self.assertEqual(node["attrs"]["height"], 600)

    def test_markdown_to_pm_json_htmlblock_defaults(self):
        """属性缺省 → title/height 走默认值，fileId/src 为空串。"""
        markdown = ':::htmlblock{fileId="only-id"}\n:::'
        pm_json = markdown_to_pm_json(markdown)
        node = pm_json["content"][0]
        self.assertEqual(node["type"], "htmlBlock")
        self.assertEqual(node["attrs"]["fileId"], "only-id")
        self.assertEqual(node["attrs"]["src"], "")
        self.assertEqual(node["attrs"]["title"], "未命名 HTML")
        self.assertEqual(node["attrs"]["height"], 480)

    def test_markdown_to_pm_json_htmlblock_invalid_height_fallback(self):
        markdown = ':::htmlblock{src="https://x.com/a.html" height="abc"}\n:::'
        node = markdown_to_pm_json(markdown)["content"][0]
        self.assertEqual(node["attrs"]["height"], 480)

    def test_markdown_to_pm_json_htmlblock_nonpositive_height_fallback(self):
        markdown = ':::htmlblock{src="https://x.com/a.html" height="0"}\n:::'
        node = markdown_to_pm_json(markdown)["content"][0]
        self.assertEqual(node["attrs"]["height"], 480)

    def test_pm_json_to_markdown_htmlblock_full_attrs(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "fileId": "file-001",
                        "src": "https://oss.example.com/a.html",
                        "title": "架构图",
                        "height": 600,
                    },
                },
            ],
        }
        md = pm_json_to_markdown(pm_json)
        # 属性顺序固定 fileId, src, title, height 且全量输出。
        self.assertIn(
            ':::htmlblock{fileId="file-001" src="https://oss.example.com/a.html"'
            ' title="架构图" height="600"}',
            md,
        )
        self.assertIn(":::", md)

    def test_pm_json_to_markdown_htmlblock_defaults_full_output(self):
        """即使 title/height 为默认值，也全量输出四个属性（保证与 TS 版往返一致）。"""
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"fileId": "f1", "src": "https://x.com/a.html"}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn('fileId="f1"', md)
        self.assertIn('src="https://x.com/a.html"', md)
        self.assertIn('title="未命名 HTML"', md)
        self.assertIn('height="480"', md)

    def test_pm_json_to_markdown_htmlblock_empty_ids_degrades(self):
        """src/fileId 均为空 → 降级输出 [HTML: 标题]，不产生指令。"""
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"fileId": "", "src": "", "title": "空块"}},
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertNotIn(":::htmlblock", md)
        self.assertIn("[HTML: 空块]", md)

    def test_htmlblock_roundtrip_stable(self):
        """markdown → PM JSON → markdown → PM JSON 往返稳定。"""
        markdown = (
            ':::htmlblock{fileId="file-001" src="https://oss.example.com/a.html"'
            ' title="架构图" height="600"}\n:::'
        )
        pm1 = markdown_to_pm_json(markdown)
        md2 = pm_json_to_markdown(pm1)
        pm2 = markdown_to_pm_json(md2)
        self.assertEqual(pm1["content"][0]["attrs"], pm2["content"][0]["attrs"])

    def test_htmlblock_title_escape_roundtrip(self):
        """title 含双引号/反斜杠时，序列化转义 + 反解析可无损往返。"""
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "fileId": "f1",
                        "src": "https://x.com/a.html",
                        "title": '我的"图\\表"',
                        "height": 480,
                    },
                },
            ],
        }
        md = pm_json_to_markdown(pm_json)
        # 转义后：\" 与 \\
        self.assertIn(r'\"', md)
        self.assertIn(r"\\", md)
        parsed = markdown_to_pm_json(md)["content"][0]
        self.assertEqual(parsed["attrs"]["title"], '我的"图\\表"')

    def test_normalize_leaked_htmlblock_markdown_single_line(self):
        leaked = (
            ':::htmlblock{fileId="f1" src="https://x.com/a.html" title="T" height="480"} :::'
        )
        normalized = normalize_leaked_htmlblock_markdown(leaked)
        self.assertEqual(
            normalized,
            ':::htmlblock{fileId="f1" src="https://x.com/a.html" title="T" height="480"}\n:::',
        )

    def test_repair_leaked_htmlblock_in_pm_json(self):
        leaked_md = (
            ':::htmlblock{fileId="f1" src="https://x.com/a.html" title="T" height="480"} :::'
        )
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "attrs": {"blockId": "blk-44"},
                    "content": [{"type": "text", "text": leaked_md}],
                },
            ],
        }
        repaired, changed = repair_leaked_htmlblock_in_pm_json(pm_json)
        self.assertTrue(changed)
        node = repaired["content"][0]
        self.assertEqual(node["type"], "htmlBlock")
        self.assertEqual(node["attrs"]["fileId"], "f1")
        self.assertEqual(node["attrs"]["blockId"], "blk-44")

    def test_pm_json_to_html_htmlblock_iframe(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "fileId": "file-001",
                        "src": "https://oss.example.com/a.html",
                        "title": "架构图",
                        "height": 600,
                    },
                },
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertIn('data-type="html-block"', html)
        self.assertIn('data-file-id="file-001"', html)
        self.assertIn('data-src="https://oss.example.com/a.html"', html)
        self.assertIn('data-title="架构图"', html)
        self.assertIn('data-height="600"', html)
        self.assertIn('<iframe src="https://oss.example.com/a.html"', html)
        self.assertIn('sandbox="allow-scripts allow-popups"', html)
        self.assertIn('loading="lazy"', html)
        # 安全红线：sandbox 绝不含 allow-same-origin。
        self.assertNotIn("allow-same-origin", html)

    def test_pm_json_to_html_htmlblock_rejects_javascript_src(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {"fileId": "f1", "src": "javascript:alert(1)", "title": "坏块"},
                },
            ],
        }
        html = pm_json_to_html(pm_json)
        # 不安全协议不输出活跃 iframe，只留占位 div。
        self.assertNotIn("<iframe", html)
        self.assertIn('data-type="html-block"', html)
        # data-src 作为静态属性仍出现，但被转义为不可执行文本。
        self.assertIn('data-src="javascript:alert(1)"', html)

    def test_pm_json_to_html_htmlblock_rejects_non_http_src(self):
        """iframe src 只认绝对 http/https（与 TS 侧一致）：相对路径 / mailto / data: 均不输出活跃 iframe。"""
        for bad_src in ("/relative/path.html", "mailto:a@b.com", "data:text/html;base64,PGI+", "//evil.com/x.html"):
            pm_json = {
                "type": "doc",
                "content": [
                    {"type": "htmlBlock", "attrs": {"fileId": "f1", "src": bad_src}},
                ],
            }
            html = pm_json_to_html(pm_json)
            self.assertNotIn("<iframe", html, f"src={bad_src} 不应输出 iframe")

    def test_pm_json_to_html_htmlblock_xss_title_escaped(self):
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "fileId": "f1",
                        "src": "https://x.com/a.html",
                        "title": '"><script>alert(1)</script>',
                    },
                },
            ],
        }
        html = pm_json_to_html(pm_json)
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_sanitize_html_preserves_htmlblock_iframe_and_attrs(self):
        """经 sanitize_html 后，沙箱 iframe 与 div data-* 属性完整保留。"""
        raw = pm_json_to_html({
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "fileId": "file-001",
                        "src": "https://oss.example.com/a.html",
                        "title": "架构图",
                        "height": 600,
                    },
                },
            ],
        })
        safe = sanitize_html(raw)
        self.assertIn('data-type="html-block"', safe)
        self.assertIn('data-file-id="file-001"', safe)
        self.assertIn('data-src="https://oss.example.com/a.html"', safe)
        self.assertIn("<iframe", safe)
        self.assertIn('sandbox="allow-scripts allow-popups"', safe)
        self.assertNotIn("allow-same-origin", safe)


if __name__ == "__main__":
    unittest.main()
