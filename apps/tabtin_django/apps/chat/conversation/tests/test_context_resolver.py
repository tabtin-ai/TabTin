"""context_resolver — `_resolve_tab_resource_ref` + `resolve_context_blocks`

覆盖目标：
1. 「添加到对话」轻量引用各 type 的渲染格式（webpage / memo / phone_device /
    tracker / agenda_event / whiteboard / terminal_session / folder）：
       - 标题、关键 ID 字段、来源标签都正确写入文本
2. title 兜底：preview 为空时退到主 ID 字段，避免输出 "## 网页: " 留空尾巴
3. resolve_context_blocks 集成：含 webpage block 的 list 正常解析，不抛错，
    context_text 含核心字段
4. 未知/缺字段兜底：preview 存在但缺关键 ID 字段时仍输出标题，但不输出 ID 行
5. tab_type 透传：来源标签作为独立行写入

设计原则（与生产代码同步）：
- _resolve_tab_resource_ref 是纯函数，不查询 DB，所以走 SimpleTestCase 而非
  TransactionTestCase（速度优先，且后端 settings 不稳定时 ORM TestCase 启动慢）
- 字段名（url / memo_id / canvas_id / device_id / session_id / tracker_id /
  event_id / folder_path / folder_kind 等）是前后端契约 —— 一旦命名漂移，
  Agent 调工具时拿到错误的资源 ID，整条链路就会断
"""

from django.test import SimpleTestCase

from apps.chat.conversation.services.context_resolver import (
    _resolve_doc_ref,
    _resolve_plan_ref,
    _resolve_tab_resource_ref,
    _resolve_web_annotation_ref,
    resolve_context_blocks,
)


class ResolveTabResourceRefTest(SimpleTestCase):
    """逐一验证每种 tab 资源类型的渲染格式。

    断言风格：用 assertIn 检查关键字段必须出现，不锁定整条文本顺序，
    避免渲染顺序微调（行间空格、字段顺序）就让测试红。
    """

    BUDGET = 200  # 单条引用 budget，所有用例统一用 —— 文本长度都在阈值内

    def test_web_annotation_renders_dom_rect_and_screenshot_pointer(self):
        text = _resolve_web_annotation_ref(
            {
                'type': 'web_annotation',
                'preview': '选中文字',
                'url': 'https://example.com',
                'page_title': 'Example',
                'selection': {'kind': 'text', 'text': '选中文字'},
                'rect': {'x': 10, 'y': 20, 'width': 100, 'height': 32},
                'dom': {'tag': 'p', 'selector': 'p:nth-of-type(1)'},
                'screenshot_filename': 'browser-annotation-1.png',
            },
            self.BUDGET,
        )

        self.assertIn('## 网页注释: Example', text)
        self.assertIn('来源: https://example.com', text)
        self.assertIn('选中文本', text)
        self.assertIn('选中文字', text)
        self.assertIn('区域: x=10, y=20, width=100, height=32', text)
        self.assertIn('selector: p:nth-of-type(1)', text)
        self.assertIn('截图附件: browser-annotation-1.png', text)

    def test_web_annotation_renders_content_snapshot(self):
        """#7038：注释落点内容快照渲染给 Agent，标注可直接使用、无需再开浏览器"""
        text = _resolve_web_annotation_ref(
            {
                'type': 'web_annotation',
                'preview': 'bili-comments',
                'url': 'https://example.com',
                'page_title': 'Example',
                'selection': {'kind': 'element', 'text': 'bili-comments'},
                'content_snapshot': {'text': '评论 1 站起来 评论 2 恭迎君王', 'truncated': False},
            },
            1000,
        )

        self.assertIn('内容快照', text)
        self.assertIn('无需再打开浏览器', text)
        self.assertIn('评论 1 站起来 评论 2 恭迎君王', text)
        self.assertNotIn('快照超长已截断', text)

    def test_web_annotation_content_snapshot_truncated_hint(self):
        """快照被采集端截断时，提示 Agent 需要更多内容再走浏览器"""
        text = _resolve_web_annotation_ref(
            {
                'type': 'web_annotation',
                'url': 'https://example.com',
                'content_snapshot': {'text': '前半段内容', 'truncated': True},
            },
            1000,
        )

        self.assertIn('前半段内容', text)
        self.assertIn('快照超长已截断', text)

    def test_web_annotation_without_snapshot_keeps_legacy_shape(self):
        """无快照的存量注释不输出内容快照段落（向后兼容）"""
        text = _resolve_web_annotation_ref(
            {
                'type': 'web_annotation',
                'url': 'https://example.com',
                'selection': {'kind': 'text', 'text': '选中文字'},
            },
            1000,
        )

        self.assertNotIn('内容快照', text)

    def test_webpage_renders_title_url_and_tab_type(self):
        """网页：标题 + url + 来源标签都齐全"""
        text = _resolve_tab_resource_ref(
            {
                'type': 'webpage',
                'preview': 'Google',
                'url': 'https://google.com',
                'page_title': 'Google',
                'tab_type': 'tabweb',
            },
            self.BUDGET,
        )
        self.assertIn('## 网页: Google', text)
        self.assertIn('url: https://google.com', text)
        self.assertIn('来源标签: tabweb', text)

    def test_memo_renders_memo_id(self):
        """笔记：memo_id 字段必须出现（Agent 调 memo_get 工具的入参）"""
        text = _resolve_tab_resource_ref(
            {
                'type': 'memo',
                'preview': '项目周报',
                'memo_id': 'memo_xx',
                'tab_type': 'tabmemo',
            },
            self.BUDGET,
        )
        self.assertIn('## 笔记: 项目周报', text)
        self.assertIn('memo_id: memo_xx', text)
        self.assertIn('来源标签: tabmemo', text)

    def test_whiteboard_renders_canvas_id(self):
        text = _resolve_tab_resource_ref(
            {
                'type': 'whiteboard',
                'preview': '架构图',
                'canvas_id': 'cnv_001',
                'tab_type': 'tabwhiteboard',
            },
            self.BUDGET,
        )
        self.assertIn('## 画板: 架构图', text)
        self.assertIn('canvas_id: cnv_001', text)

    def test_phone_device_renders_device_id(self):
        text = _resolve_tab_resource_ref(
            {
                'type': 'phone_device',
                'preview': 'iPhone 15',
                'device_id': 'dev_p001',
                'tab_type': 'tabphone',
            },
            self.BUDGET,
        )
        self.assertIn('## 手机: iPhone 15', text)
        self.assertIn('device_id: dev_p001', text)
        self.assertIn('来源标签: tabphone', text)

    def test_tracker_renders_tracker_id(self):
        """新增 type tracker：tracker_id 字段必须存在"""
        text = _resolve_tab_resource_ref(
            {
                'type': 'tracker',
                'preview': '迭代 W12',
                'tracker_id': 'trk_001',
                'tab_type': 'tabtracker',
            },
            self.BUDGET,
        )
        self.assertIn('## 任务追踪器: 迭代 W12', text)
        self.assertIn('tracker_id: trk_001', text)

    def test_agenda_event_renders_event_id(self):
        """新增 type agenda_event：event_id 字段必须存在"""
        text = _resolve_tab_resource_ref(
            {
                'type': 'agenda_event',
                'preview': '周会',
                'event_id': 'evt_001',
                'tab_type': 'tabtracker',
            },
            self.BUDGET,
        )
        self.assertIn('## 日程: 周会', text)
        self.assertIn('event_id: evt_001', text)

    def test_terminal_session_renders_session_id_and_cwd(self):
        """终端：主 ID 是 session_id，附加 cwd 也应作为独立行"""
        text = _resolve_tab_resource_ref(
            {
                'type': 'terminal_session',
                'preview': 'workspace',
                'session_id': 'sess_a',
                'cwd': '/home/me/repo',
                'tab_type': 'terminal',
            },
            self.BUDGET,
        )
        self.assertIn('## 终端会话: workspace', text)
        self.assertIn('session_id: sess_a', text)
        self.assertIn('cwd: /home/me/repo', text)

    def test_folder_renders_folder_path_and_kind(self):
        """folder：folder_path + folder_kind 都要输出（kind 区分 user / sandbox）"""
        text = _resolve_tab_resource_ref(
            {
                'type': 'folder',
                'preview': 'workspace',
                'folder_path': '/Users/me/code',
                'folder_kind': 'user',
                'tab_type': 'tabfolder',
            },
            self.BUDGET,
        )
        self.assertIn('## 文件夹: workspace', text)
        self.assertIn('folder_path: /Users/me/code', text)
        self.assertIn('folder_kind: user', text)

    def test_file_renders_file_id(self):
        """#6229：file 引用必须把 file_id 注入 prompt，供 Agent 调 parse_document / 读文件"""
        text = _resolve_tab_resource_ref(
            {
                'type': 'file',
                'preview': 'CLAUDE.md',
                'file_id': '084aa15a-d224-4764-9c2f-f45c92026f05',
                'tab_type': 'file',
            },
            self.BUDGET,
        )
        self.assertIn('## 文件: CLAUDE.md', text)
        self.assertIn('file_id: 084aa15a-d224-4764-9c2f-f45c92026f05', text)
        self.assertIn('来源标签: file', text)


class TitleFallbackTest(SimpleTestCase):
    """title 兜底：preview 为空时不输出 "## 网页: " 这种空尾巴"""

    BUDGET = 200

    def test_webpage_empty_preview_falls_back_to_url(self):
        """webpage preview 空时用 url 兜底为标题"""
        text = _resolve_tab_resource_ref(
            {
                'type': 'webpage',
                'preview': '',
                'url': 'https://example.com',
            },
            self.BUDGET,
        )
        # 不能出现 "## 网页: " 末尾空尾巴（也不能 "## 网页:" 空冒号）
        self.assertNotIn('## 网页: \n', text)
        self.assertNotIn('## 网页: \n', text + '\n')
        self.assertIn('## 网页: https://example.com', text)

    def test_memo_empty_preview_falls_back_to_memo_id(self):
        text = _resolve_tab_resource_ref(
            {'type': 'memo', 'preview': '', 'memo_id': 'memo_xy'},
            self.BUDGET,
        )
        self.assertIn('## 笔记: memo_xy', text)

    def test_webpage_no_title_no_id_only_label(self):
        """preview 空且 url 缺失 → 只输出资源类型标签（保底，不留空尾巴）"""
        text = _resolve_tab_resource_ref(
            {'type': 'webpage', 'preview': ''},
            self.BUDGET,
        )
        # 至少要有 "## 网页"（不是 "## 网页: " 空尾）
        self.assertTrue(text.startswith('## 网页'))
        self.assertNotIn('## 网页: \n', text)


class ResolveContextBlocksIntegrationTest(SimpleTestCase):
    """resolve_context_blocks 集成 — 包含 webpage 的 block 列表能正确解析"""

    def test_doc_selection_prefers_full_text_over_preview(self):
        """文档块拖拽：Agent 上下文必须拿完整块文本，而不是 200 字 preview。"""
        text = _resolve_doc_ref(
            {
                'type': 'doc_selection',
                'doc_id': '',
                'preview': '短预览',
                'full_text': '完整文档块内容',
            },
            user_id='user-1',
            budget=200,
        )
        self.assertIn('完整文档块内容', text)
        self.assertNotIn('短预览', text)

    def test_resolve_context_blocks_with_webpage(self):
        """单条 webpage block：返回非空 context_text，含 url + 标题"""
        blocks = [
            {
                'type': 'webpage',
                'preview': 'Google 搜索',
                'url': 'https://google.com',
                'tab_type': 'tabweb',
            }
        ]
        context_text, resolved = resolve_context_blocks(blocks, user_id='user-1')
        self.assertIn('## 网页: Google 搜索', context_text)
        self.assertIn('https://google.com', context_text)
        self.assertEqual(len(resolved), 1)
        # _resolved_text 被写回 block，方便后续 DB 持久化
        self.assertIn('_resolved_text', resolved[0])

    def test_resolve_context_blocks_with_multiple_tab_resources(self):
        """混合多种 tab 资源：每条都被独立渲染并用 ---- 分隔"""
        blocks = [
            {
                'type': 'webpage',
                'preview': 'Google',
                'url': 'https://google.com',
            },
            {
                'type': 'memo',
                'preview': '周报',
                'memo_id': 'memo_001',
            },
            {
                'type': 'tracker',
                'preview': '迭代',
                'tracker_id': 'trk_001',
            },
        ]
        context_text, _ = resolve_context_blocks(blocks, user_id='user-1')
        self.assertIn('## 网页: Google', context_text)
        self.assertIn('## 笔记: 周报', context_text)
        self.assertIn('## 任务追踪器: 迭代', context_text)
        # 多条引用之间用 \n\n---\n\n 分隔（resolver 的拼接约定）
        self.assertIn('---', context_text)

    def test_resolve_context_blocks_skips_unrelated_blocks(self):
        """非 ref 类 block（如 text 块）应被跳过，不抛错"""
        blocks = [
            {'type': 'text', 'text': '正文消息'},
            {'type': 'webpage', 'preview': 'X', 'url': 'https://x.com'},
        ]
        context_text, _ = resolve_context_blocks(blocks, user_id='user-1')
        # 只有 webpage 被渲染，text 块不进 context_text
        self.assertIn('## 网页: X', context_text)
        self.assertNotIn('正文消息', context_text)

    def test_resolve_context_blocks_with_file(self):
        """#6229：file block 进入白名单后应解析出 file_id，不再被当成 legacy-unknown"""
        blocks = [
            {
                'type': 'file',
                'preview': 'CLAUDE.md',
                'file_id': 'file-uuid-001',
                'tab_type': 'file',
                'space_id': 'sp-agent',
            }
        ]
        context_text, resolved = resolve_context_blocks(blocks, user_id='user-1')
        self.assertIn('## 文件: CLAUDE.md', context_text)
        self.assertIn('file_id: file-uuid-001', context_text)
        self.assertIn('_resolved_text', resolved[0])
        self.assertIn('file_id: file-uuid-001', resolved[0]['_resolved_text'])

    def test_resolve_context_blocks_empty_returns_empty_text(self):
        """没有 ref block → 返回空字符串而非抛错"""
        context_text, resolved = resolve_context_blocks([], user_id='user-1')
        self.assertEqual(context_text, '')
        self.assertEqual(resolved, [])


class ResolvePlanRefTest(SimpleTestCase):
    """#2857：plan 执行引用只注入指针 + 执行前重读引导，不塞正文。"""

    BUDGET = 400

    def test_file_ref_injects_pointer_and_reread_hint(self):
        text = _resolve_plan_ref(
            {
                'type': 'plan',
                'plan_name': '重构导出流程',
                'plan_ref': {'kind': 'file', 'path': '.tabtin/plans/2026-07-04-refactor.plan.md'},
            },
            self.BUDGET,
        )
        self.assertIn('已批准的计划：重构导出流程', text)
        self.assertIn('.tabtin/plans/2026-07-04-refactor.plan.md', text)
        self.assertIn('file_read', text)
        self.assertIn('执行前请先读取', text)

    def test_document_ref_injects_doc_id(self):
        text = _resolve_plan_ref(
            {
                'type': 'plan',
                'plan_name': '上线方案',
                'plan_ref': {'kind': 'document', 'document_id': 'doc_abc'},
            },
            self.BUDGET,
        )
        self.assertIn('已批准的计划：上线方案', text)
        self.assertIn('doc_abc', text)
        self.assertIn('tabdoc', text)

    def test_missing_pointer_still_renders_header(self):
        """指针缺失时不崩，仍输出已批准计划引导（不留空尾巴）。"""
        text = _resolve_plan_ref({'type': 'plan'}, self.BUDGET)
        self.assertIn('已批准的计划', text)
        self.assertIn('执行前请先读取', text)


class ResolveContextBlocksPlanIntegrationTest(SimpleTestCase):
    """#2857 P1-B：plan block 必须进 context_ref_types 白名单，否则 _resolve_plan_ref
    是死代码——桌面「执行」发的 type='plan' 引用不会被注入 Agent 上下文。"""

    def test_plan_block_is_resolved_not_dropped(self):
        blocks = [
            {
                'type': 'plan',
                'plan_name': '执行计划A',
                'plan_ref': {'kind': 'file', 'path': '.tabtin/plans/a.plan.md'},
            }
        ]
        context_text, resolved = resolve_context_blocks(blocks, user_id='user-1')
        self.assertIn('已批准的计划：执行计划A', context_text)
        self.assertIn('.tabtin/plans/a.plan.md', context_text)
        self.assertIn('_resolved_text', resolved[0])


class WebpageMissingFieldGracefulTest(SimpleTestCase):
    """关键字段缺失时不应让整条 resolver 崩，而是退到 preview 渲染"""

    BUDGET = 200

    def test_webpage_with_preview_but_no_url_only_title_line(self):
        """缺 url：仍输出 "## 网页: 标题"，但没 url 行（不输出 url:）"""
        text = _resolve_tab_resource_ref(
            {'type': 'webpage', 'preview': 'X 网站', 'tab_type': 'foo'},
            self.BUDGET,
        )
        self.assertIn('## 网页: X 网站', text)
        # 没 url 字段时不应输出 "url:" 行
        self.assertNotIn('\nurl:', text)
        self.assertIn('来源标签: foo', text)
