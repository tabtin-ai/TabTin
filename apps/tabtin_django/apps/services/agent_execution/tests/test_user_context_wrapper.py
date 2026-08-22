"""
user_context_wrapper 测试（阶段 6 议题 2）。

主要目标：与 TS 端
``packages/agent-prompt/src/__tests__/user-context-wrapper.test.ts``
fixture 1-4 输出**逐字节等价**。任一边渲染算法漂移都会失败。

依赖：标准库 unittest（不要求 Django runner）。
"""
import unittest

from apps.services.agent_execution.user_context_wrapper import (
    build_user_context_wrapper,
    find_first_user_context_wrapper,
    find_all_user_context_wrappers,
)


class TestBuildUserContextWrapper(unittest.TestCase):
    def test_environment_no_attrs(self):
        out = build_user_context_wrapper(
            type="environment", body="current_datetime: 2026-05-21",
        )
        self.assertEqual(
            out,
            '<context type="environment">\ncurrent_datetime: 2026-05-21\n</context>',
        )

    def test_referenced_with_stale_after_turn(self):
        out = build_user_context_wrapper(
            type="referenced",
            body="## 表: 营销表\n字段：name, age",
            attrs={"stale_after_turn": "msg-123"},
        )
        self.assertEqual(
            out,
            '<context type="referenced" stale_after_turn="msg-123">\n## 表: 营销表\n字段：name, age\n</context>',
        )

    def test_attached_dict_sorted_attrs(self):
        # 字典序：filename < stale_after_turn → filename 在前
        out = build_user_context_wrapper(
            type="attached",
            body="[文档: foo.pdf]\ncontent",
            attrs={"filename": "foo.pdf", "stale_after_turn": "msg-xyz"},
        )
        self.assertEqual(
            out,
            '<context type="attached" filename="foo.pdf" stale_after_turn="msg-xyz">\n'
            '[文档: foo.pdf]\ncontent\n</context>',
        )

    def test_skip_empty_string_attr(self):
        out = build_user_context_wrapper(
            type="referenced",
            body="body",
            attrs={"stale_after_turn": "", "filename": "x"},
        )
        self.assertEqual(out, '<context type="referenced" filename="x">\nbody\n</context>')

    def test_skip_none_attr(self):
        out = build_user_context_wrapper(
            type="attached",
            body="body",
            attrs={"stale_after_turn": None, "filename": "real.pdf"},
        )
        self.assertEqual(out, '<context type="attached" filename="real.pdf">\nbody\n</context>')

    def test_xml_escape_all_four(self):
        out = build_user_context_wrapper(
            type="referenced", body="body", attrs={"filename": 'a&b<c>"d'},
        )
        self.assertEqual(
            out,
            '<context type="referenced" filename="a&amp;b&lt;c&gt;&quot;d">\nbody\n</context>',
        )

    def test_body_no_escape(self):
        out = build_user_context_wrapper(
            type="environment", body="before <nested>\ninner\n</nested>",
        )
        self.assertIn("<nested>\ninner\n</nested>", out)


class TestFindWrapper(unittest.TestCase):
    def test_parse_single_no_attrs(self):
        text = '<context type="environment">\ncurrent_datetime: x\n</context>'
        w = find_first_user_context_wrapper(text)
        self.assertIsNotNone(w)
        self.assertEqual(w.type, "environment")
        self.assertEqual(w.attrs, {})
        self.assertEqual(w.body, "current_datetime: x")
        self.assertEqual(w.start_offset, 0)
        self.assertEqual(w.end_offset, len(text))

    def test_parse_with_multiple_attrs(self):
        text = (
            '<context type="attached" filename="foo.pdf" stale_after_turn="msg-1">\n'
            '[文档: foo.pdf]\nbody\n</context>'
        )
        w = find_first_user_context_wrapper(text)
        self.assertIsNotNone(w)
        self.assertEqual(w.type, "attached")
        self.assertEqual(w.attrs, {"filename": "foo.pdf", "stale_after_turn": "msg-1"})
        self.assertEqual(w.body, "[文档: foo.pdf]\nbody")

    def test_find_all_multiple_wrappers(self):
        text = (
            "前缀\n"
            '<context type="referenced" stale_after_turn="m1">\nref body 1\n</context>\n\n'
            '<context type="attached" filename="a.pdf" stale_after_turn="m1">\nattached body\n</context>\n后缀'
        )
        all_w = find_all_user_context_wrappers(text)
        self.assertEqual(len(all_w), 2)
        self.assertEqual(all_w[0].type, "referenced")
        self.assertEqual(all_w[1].type, "attached")
        self.assertEqual(all_w[1].attrs["filename"], "a.pdf")

    def test_old_form_context_no_type_misses(self):
        text = "<context>\nold body\n</context>"
        self.assertIsNone(find_first_user_context_wrapper(text))

    def test_old_form_referenced_prefix_misses(self):
        text = "用户问题\n\n---\nReferenced context data:\n## 表 schema..."
        self.assertIsNone(find_first_user_context_wrapper(text))

    def test_old_form_attached_prefix_misses(self):
        text = "[文档: foo.pdf]\n文档正文"
        self.assertIsNone(find_first_user_context_wrapper(text))

    def test_xml_attr_unescape(self):
        text = (
            '<context type="referenced" filename="a&amp;b&lt;c&gt;&quot;d">\n'
            "body\n</context>"
        )
        w = find_first_user_context_wrapper(text)
        self.assertIsNotNone(w)
        self.assertEqual(w.attrs["filename"], 'a&b<c>"d')


class TestRoundTrip(unittest.TestCase):
    def test_environment_no_attrs(self):
        orig = build_user_context_wrapper(type="environment", body="body content")
        parsed = find_first_user_context_wrapper(orig)
        rebuilt = build_user_context_wrapper(
            type=parsed.type, body=parsed.body, attrs=parsed.attrs,
        )
        self.assertEqual(rebuilt, orig)

    def test_attached_full_attrs(self):
        orig = build_user_context_wrapper(
            type="attached",
            body="[文档: x.pdf]\ncontent",
            attrs={"filename": "x.pdf", "stale_after_turn": "msg-abc"},
        )
        parsed = find_first_user_context_wrapper(orig)
        rebuilt = build_user_context_wrapper(
            type=parsed.type, body=parsed.body, attrs=parsed.attrs,
        )
        self.assertEqual(rebuilt, orig)

    def test_special_chars_round_trip(self):
        orig = build_user_context_wrapper(
            type="referenced", body="body", attrs={"filename": 'a&b<c>"'},
        )
        parsed = find_first_user_context_wrapper(orig)
        self.assertEqual(parsed.attrs["filename"], 'a&b<c>"')
        rebuilt = build_user_context_wrapper(
            type=parsed.type, body=parsed.body, attrs=parsed.attrs,
        )
        self.assertEqual(rebuilt, orig)


class TestPythonTsByteIdentical(unittest.TestCase):
    """与 TS 端 fixture 1-4 输出字字节等价（contract test）。

    任一边渲染算法漂移 → 任一边失败 → CI 阻断。
    """

    def test_fixture_1_environment_no_attrs(self):
        self.assertEqual(
            build_user_context_wrapper(
                type="environment", body="current_datetime: 2026-05-21",
            ),
            '<context type="environment">\ncurrent_datetime: 2026-05-21\n</context>',
        )

    def test_fixture_2_referenced_stale_after_turn(self):
        self.assertEqual(
            build_user_context_wrapper(
                type="referenced",
                body="## 表: 营销表\n字段：name, age",
                attrs={"stale_after_turn": "msg-123"},
            ),
            '<context type="referenced" stale_after_turn="msg-123">\n## 表: 营销表\n字段：name, age\n</context>',
        )

    def test_fixture_3_attached_dict_sorted(self):
        self.assertEqual(
            build_user_context_wrapper(
                type="attached",
                body="[文档: foo.pdf]\ncontent",
                attrs={"filename": "foo.pdf", "stale_after_turn": "msg-xyz"},
            ),
            '<context type="attached" filename="foo.pdf" stale_after_turn="msg-xyz">\n'
            '[文档: foo.pdf]\ncontent\n</context>',
        )

    def test_fixture_4_escaped_chars(self):
        self.assertEqual(
            build_user_context_wrapper(
                type="attached", body="body", attrs={"filename": 'a&b"c<d>'},
            ),
            '<context type="attached" filename="a&amp;b&quot;c&lt;d&gt;">\nbody\n</context>',
        )


if __name__ == "__main__":
    unittest.main()
