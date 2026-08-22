"""W3 §3.3.2 blocks_to_llm_context 单元测试 —— 覆盖每条 tabtin_* strip 规则。

每条规则一个 case；覆盖所有 6 种 tabtin_* 块 + Anthropic 标准块透传 + 未知块
fallback。

纯单元测试（无 DB / 无 IO） —— 不需要 @pytest.mark.django_db。
"""

from __future__ import annotations

import pytest

from apps.services.agent_engine.services.blocks_to_llm_context import (
    ANTHROPIC_STANDARD_BLOCK_TYPES,
    TABTIN_BLOCK_TYPES,
    chat_messages_to_llm_messages,
    strip_tabtin_blocks_for_llm,
)


class TestStripTabtinBlocksForLLM:
    """每个 tabtin_* 规则一个 case + Anthropic 标准块透传 + 未知 fallback。"""

    def test_empty_input_returns_empty(self):
        assert strip_tabtin_blocks_for_llm([]) == []
        assert strip_tabtin_blocks_for_llm(None) == []  # type: ignore

    def test_anthropic_text_passthrough(self):
        blocks = [{'type': 'text', 'text': 'hello world'}]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result == [{'type': 'text', 'text': 'hello world'}]
        # 必须 deep copy 不共享对象
        assert result[0] is not blocks[0]

    def test_anthropic_tool_use_passthrough(self):
        blocks = [{
            'type': 'tool_use',
            'id': 'toolu_xxx',
            'name': 'shell',
            'input': {'command': 'ls'},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result == blocks
        assert result[0] is not blocks[0]

    def test_anthropic_thinking_passthrough(self):
        blocks = [{'type': 'thinking', 'thinking': 'let me think', 'signature': 'sig'}]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result == blocks

    def test_anthropic_image_passthrough(self):
        blocks = [{
            'type': 'image',
            'source': {'type': 'url', 'url': 'https://example.com/x.png'},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result == blocks

    def test_tool_result_presentation_is_ui_only(self):
        blocks = [{
            'type': 'tool_result',
            'tool_use_id': 'tool-1',
            'content': '{"status":"completed"}',
            'presentation': {
                'kind': 'media_image_generation',
                'data': {'prompt': 'apple'},
            },
        }]

        result = strip_tabtin_blocks_for_llm(blocks)

        assert result == [{
            'type': 'tool_result',
            'tool_use_id': 'tool-1',
            'content': '{"status":"completed"}',
        }]
        assert blocks[0]['presentation']['kind'] == 'media_image_generation'

    # ── tabtin_source_ref → text ────────────────────────────────────────

    def test_tabtin_source_ref_web(self):
        blocks = [{
            'type': 'tabtin_source_ref',
            'source_id': 'src-1',
            'ref_kind': 'web',
            'snapshot': {
                'kind': 'web',
                'url': 'https://example.com/article',
                'title': 'Example Article',
                'selected_text': 'key insight here',
            },
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert len(result) == 1
        assert result[0]['type'] == 'text'
        assert 'web' in result[0]['text']
        assert 'Example Article' in result[0]['text']
        assert 'https://example.com/article' in result[0]['text']
        assert 'key insight here' in result[0]['text']

    def test_tabtin_source_ref_doc(self):
        blocks = [{
            'type': 'tabtin_source_ref',
            'source_id': 'src-2',
            'ref_kind': 'doc',
            'snapshot': {
                'kind': 'doc',
                'doc_id': 'doc-abc',
                'page': 5,
                'preview': '段落预览',
            },
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert 'doc-abc' in result[0]['text']
        assert '段落预览' in result[0]['text']

    def test_tabtin_source_ref_table(self):
        blocks = [{
            'type': 'tabtin_source_ref',
            'source_id': 'src-3',
            'ref_kind': 'table',
            'snapshot': {
                'kind': 'table',
                'table_id': 't-xyz',
                'csv_preview': 'col1,col2\n1,2',
            },
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert 't-xyz' in result[0]['text']
        assert 'col1,col2' in result[0]['text']

    def test_tabtin_source_ref_code(self):
        blocks = [{
            'type': 'tabtin_source_ref',
            'source_id': 'src-4',
            'ref_kind': 'code',
            'snapshot': {
                'kind': 'code',
                'file_path': '/x/y.py',
                'start_line': 10,
                'end_line': 20,
                'code_excerpt': 'def foo():\n    pass',
                'lang': 'python',
            },
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert '/x/y.py' in result[0]['text']
        assert 'def foo()' in result[0]['text']
        assert '```python' in result[0]['text']  # fenced code block

    def test_tabtin_source_ref_memo(self):
        blocks = [{
            'type': 'tabtin_source_ref',
            'source_id': 'src-5',
            'ref_kind': 'memo',
            'snapshot': {
                'kind': 'memo',
                'memo_id': 'memo-1',
                'preview': 'memo content',
            },
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert 'memo-1' in result[0]['text']
        assert 'memo content' in result[0]['text']

    # ── tabtin_rich_content → image / text ────────────────────────────────

    def test_tabtin_rich_content_image_with_url(self):
        blocks = [{
            'type': 'tabtin_rich_content',
            'kind': 'image',
            'summary': 'a screenshot',
            'payload': {'url': 'https://x.com/img.png'},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'image'
        assert result[0]['source']['type'] == 'url'
        assert result[0]['source']['url'] == 'https://x.com/img.png'

    def test_tabtin_rich_content_image_with_base64(self):
        blocks = [{
            'type': 'tabtin_rich_content',
            'kind': 'image',
            'summary': 'an image',
            'payload': {'base64': 'iVBORw0...', 'media_type': 'image/png'},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'image'
        assert result[0]['source']['type'] == 'base64'
        assert result[0]['source']['media_type'] == 'image/png'
        assert result[0]['source']['data'] == 'iVBORw0...'

    def test_tabtin_rich_content_image_with_file_id(self):
        blocks = [{
            'type': 'tabtin_rich_content',
            'kind': 'image',
            'summary': 'an image',
            'payload': {'file_id': 'file-abc'},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'image'
        assert result[0]['source']['type'] == 'file_id'
        assert result[0]['source']['file_id'] == 'file-abc'

    def test_tabtin_rich_content_image_no_source_falls_back_to_text(self):
        blocks = [{
            'type': 'tabtin_rich_content',
            'kind': 'image',
            'summary': 'no source',
            'payload': {},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert '[图片]' in result[0]['text']

    def test_tabtin_rich_content_table_preview_to_text(self):
        blocks = [{
            'type': 'tabtin_rich_content',
            'kind': 'table_preview',
            'summary': 'Sales 2024 数据',
            'payload': {'rows': 100, 'columns': ['name', 'value']},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert 'table_preview' in result[0]['text']
        assert 'Sales 2024' in result[0]['text']

    def test_tabtin_rich_content_search_results_to_text(self):
        blocks = [{
            'type': 'tabtin_rich_content',
            'kind': 'search_results',
            'summary': '5 个搜索结果',
            'payload': {'count': 5},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert '5 个搜索结果' in result[0]['text']

    # ── tabtin_composer_preset → text ───────────────────────────────────

    def test_tabtin_composer_preset(self):
        blocks = [{
            'type': 'tabtin_composer_preset',
            'preset_id': 'summarize_doc',
            'params': {'doc_id': 'd1', 'style': 'bullet'},
            'source': 'preset',
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert 'summarize_doc' in result[0]['text']
        assert 'bullet' in result[0]['text']

    # ── tabtin_skill_invocation → text ─────────────────────────────────

    def test_tabtin_skill_invocation_uses_injected_text(self):
        blocks = [{
            'type': 'tabtin_skill_invocation',
            'skill_id': 'sk-1',
            'skill_name': 'WebSearch',
            'injected_text': '请使用 web search skill 搜索 "Anthropic"',
            'injected_text_summary': '已注入 WebSearch skill',
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        # injected_text 直接当 text 给 LLM
        assert result[0]['text'] == '请使用 web search skill 搜索 "Anthropic"'

    def test_tabtin_skill_invocation_no_injected_text_fallback(self):
        blocks = [{
            'type': 'tabtin_skill_invocation',
            'skill_id': 'sk-2',
            'skill_name': 'EmptySkill',
            'injected_text': '',
            'injected_text_summary': '空',
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert 'EmptySkill' in result[0]['text']

    # ── tabtin_ask_user_fields → text ──────────────────────────────────

    def test_tabtin_ask_user_fields(self):
        blocks = [{
            'type': 'tabtin_ask_user_fields',
            'field_values': {'project_name': 'tabtin', 'version': '1.0'},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert 'project_name=tabtin' in result[0]['text']
        assert 'version=1.0' in result[0]['text']

    def test_tabtin_ask_user_fields_empty(self):
        blocks = [{
            'type': 'tabtin_ask_user_fields',
            'field_values': {},
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert '[用户未填写]' in result[0]['text']

    # ── tabtin_approval_request → text ─────────────────────────────────

    def test_tabtin_approval_request(self):
        blocks = [{
            'type': 'tabtin_approval_request',
            'approval_id': 'app-1',
            'prompt': '是否允许执行 rm -rf?',
            'options': [
                {'id': 'yes', 'label': '允许'},
                {'id': 'no', 'label': '拒绝'},
            ],
        }]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert result[0]['type'] == 'text'
        assert 'rm -rf' in result[0]['text']
        assert 'yes' in result[0]['text']
        assert 'no' in result[0]['text']

    # ── 未知块 fallback ─────────────────────────────────────────────────

    def test_unknown_block_type_falls_back_to_text(self):
        blocks = [{'type': 'future_block_type_xyz', 'foo': 'bar'}]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert len(result) == 1
        assert result[0]['type'] == 'text'
        assert 'future_block_type_xyz' in result[0]['text']

    def test_non_dict_block_skipped(self):
        blocks = [
            {'type': 'text', 'text': 'valid'},
            'not a dict',  # type: ignore
            {'type': 'text', 'text': 'also valid'},
        ]
        result = strip_tabtin_blocks_for_llm(blocks)
        assert len(result) == 2
        assert result[0]['text'] == 'valid'
        assert result[1]['text'] == 'also valid'


class TestChatMessagesToLLMMessages:
    """端到端组装：ChatMessage 数组 → LLM message 数组。"""

    def test_basic_user_assistant_pair(self):
        chat_messages = [
            {
                'role': 'user',
                'content_blocks': [{'type': 'text', 'text': '你好'}],
            },
            {
                'role': 'assistant',
                'content_blocks': [
                    {'type': 'text', 'text': '你好！'},
                    {'type': 'tool_use', 'id': 't1', 'name': 'search', 'input': {'q': 'hi'}},
                ],
            },
        ]
        result = chat_messages_to_llm_messages(chat_messages)
        assert len(result) == 2
        assert result[0]['role'] == 'user'
        assert result[0]['content'][0]['text'] == '你好'
        assert result[1]['role'] == 'assistant'
        assert len(result[1]['content']) == 2

    def test_tabtin_blocks_stripped_in_llm_messages(self):
        chat_messages = [
            {
                'role': 'user',
                'content_blocks': [
                    {'type': 'text', 'text': 'Q?'},
                    {
                        'type': 'tabtin_skill_invocation',
                        'skill_id': 'sk',
                        'skill_name': 'WebSearch',
                        'injected_text': '调用 WebSearch',
                        'injected_text_summary': '注入 WebSearch',
                    },
                ],
            },
        ]
        result = chat_messages_to_llm_messages(chat_messages)
        # tabtin_* 块被转成 text
        assert all(block['type'] != 'tabtin_skill_invocation' for block in result[0]['content'])
        # skill 注入文本进了 LLM context
        assert any('调用 WebSearch' in block.get('text', '') for block in result[0]['content'])

    def test_content_blocks_json_alias_supported(self):
        # 兼容输入字段名 content_blocks_json（与 chat_message 字段名同）
        chat_messages = [
            {
                'role': 'assistant',
                'content_blocks_json': [{'type': 'text', 'text': 'reply'}],
            },
        ]
        result = chat_messages_to_llm_messages(chat_messages)
        assert result[0]['content'][0]['text'] == 'reply'


class TestConstants:
    def test_tabtin_block_types_complete(self):
        # 6 种 tabtin_* 块都注册
        assert TABTIN_BLOCK_TYPES == frozenset({
            'tabtin_source_ref',
            'tabtin_rich_content',
            'tabtin_composer_preset',
            'tabtin_skill_invocation',
            'tabtin_ask_user_fields',
            'tabtin_approval_request',
        })

    def test_anthropic_standard_block_types_no_tabtin(self):
        # 标准块集合不包含任何 tabtin_*
        for t in TABTIN_BLOCK_TYPES:
            assert t not in ANTHROPIC_STANDARD_BLOCK_TYPES
