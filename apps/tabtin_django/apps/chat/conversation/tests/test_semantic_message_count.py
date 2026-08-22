"""#2447 回退语义消息计数单测。"""

from django.test import SimpleTestCase

from apps.chat.conversation.services.semantic_message_count import (
    count_semantic_messages,
    count_semantic_messages_from_values,
    is_context_injection_message,
    is_context_injection_row,
)


class _Msg:
    __slots__ = ('role', 'message_kind', 'agent_run_id', 'text_summary', 'metadata')

    def __init__(
        self, *, role, message_kind='llm', agent_run_id='', text_summary='', metadata=None,
    ):
        self.role = role
        self.message_kind = message_kind
        self.agent_run_id = agent_run_id
        self.text_summary = text_summary
        self.metadata = metadata


class SemanticMessageCountTests(SimpleTestCase):
    def test_environment_context_excluded(self):
        msgs = [
            _Msg(role='user', text_summary='hello'),
            _Msg(role='user', message_kind='environment_context', text_summary='<context type="environment">\nx\n</context>'),
            _Msg(role='assistant', agent_run_id='run-1', text_summary='reply'),
        ]
        self.assertEqual(count_semantic_messages(msgs), 2)

    def test_system_role_environment_context_excluded(self):
        msg = _Msg(
            role='system',
            message_kind='environment_context',
            text_summary='<context type="environment">x</context>',
        )
        self.assertTrue(is_context_injection_message(msg))
        self.assertEqual(count_semantic_messages([msg]), 0)

    def test_agent_profile_context_excluded(self):
        msgs = [
            _Msg(role='user', text_summary='hello'),
            _Msg(
                role='user',
                message_kind='agent_profile_context',
                text_summary='<context type="agent-profile">\n你是小 Tin。\n</context>',
            ),
            _Msg(role='assistant', agent_run_id='run-1', text_summary='reply'),
        ]
        self.assertEqual(count_semantic_messages(msgs), 2)

    def test_system_prompt_context_excluded(self):
        msg = _Msg(
            role='user',
            message_kind='system_prompt_context',
            text_summary='<identity>\nsystem rules\n</identity>',
        )
        self.assertTrue(is_context_injection_message(msg))
        self.assertEqual(count_semantic_messages([msg, _Msg(role='user', text_summary='real')]), 1)

    def test_assistant_same_run_counts_as_one(self):
        msgs = [
            _Msg(role='user', text_summary='q'),
            _Msg(role='assistant', agent_run_id='run-1', text_summary='part1'),
            _Msg(role='assistant', message_kind='tool_artifact', agent_run_id='run-1', text_summary='widget'),
            _Msg(role='assistant', agent_run_id='run-1', text_summary='part2'),
        ]
        self.assertEqual(count_semantic_messages(msgs), 2)

    def test_adjacent_different_agent_runs_merge(self):
        msgs = [
            _Msg(role='assistant', agent_run_id='run-1', text_summary='a1'),
            _Msg(role='assistant', agent_run_id='run-2', text_summary='a2'),
        ]
        self.assertEqual(count_semantic_messages(msgs), 1)

    def test_pseudo_user_and_system_excluded(self):
        msgs = [
            _Msg(role='user', message_kind='compaction_summary', text_summary='[摘要]'),
            _Msg(
                role='user',
                text_summary='push',
                metadata={'triggered_by': 'push-notification'},
            ),
            _Msg(
                role='user',
                text_summary='skill',
                metadata={'source': 'skill_invoke'},
            ),
            _Msg(role='system', text_summary='noise'),
            _Msg(role='user', text_summary='hello'),
            _Msg(role='assistant', text_summary='reply'),
        ]
        self.assertEqual(count_semantic_messages(msgs), 2)

    def test_real_user_breaks_adjacent_agent_merge(self):
        msgs = [
            _Msg(role='assistant', agent_run_id='run-1', text_summary='a1'),
            _Msg(role='user', text_summary='mid'),
            _Msg(role='assistant', agent_run_id='run-2', text_summary='a2'),
        ]
        self.assertEqual(count_semantic_messages(msgs), 3)

    def test_error_envelope_merges_with_adjacent_agents(self):
        msgs = [
            _Msg(role='assistant', agent_run_id='run-1', text_summary='part'),
            _Msg(role='assistant', message_kind='error_envelope', text_summary='err'),
            _Msg(role='assistant', agent_run_id='run-2', text_summary='more'),
        ]
        self.assertEqual(count_semantic_messages(msgs), 1)

    def test_user_plus_adjacent_agents_with_tool_artifact(self):
        msgs = [
            _Msg(role='user', text_summary='q'),
            _Msg(role='assistant', agent_run_id='run-1', text_summary='part1'),
            _Msg(
                role='assistant',
                message_kind='tool_artifact',
                agent_run_id='run-1',
                text_summary='widget',
            ),
            _Msg(role='assistant', agent_run_id='run-2', text_summary='part2'),
        ]
        self.assertEqual(count_semantic_messages(msgs), 2)

    def test_legacy_environment_wrapper_excluded(self):
        msg = _Msg(
            role='user',
            text_summary='<context type="environment">\ncurrent_datetime: 2026\n</context>',
        )
        self.assertTrue(is_context_injection_message(msg))
        self.assertEqual(count_semantic_messages([msg, _Msg(role='user', text_summary='real')]), 1)

    def test_legacy_agent_profile_wrapper_excluded(self):
        msg = _Msg(
            role='user',
            message_kind='llm',
            text_summary='<context type="agent-profile">\n你是小 Tin。\n</context>',
        )
        self.assertTrue(is_context_injection_message(msg))
        self.assertEqual(count_semantic_messages([msg, _Msg(role='user', text_summary='real')]), 1)

    def test_referenced_context_still_counts(self):
        msg = _Msg(
            role='user',
            text_summary='<context type="referenced" stale_after_turn="x">\nschema\n</context>\n请分析',
        )
        self.assertFalse(is_context_injection_message(msg))
        self.assertEqual(count_semantic_messages([msg]), 1)

    def test_share_briefing_and_contract_excluded(self):
        briefing = _Msg(
            role='user',
            message_kind='environment_context',
            text_summary='本会话由共享任务副本创建。',
            metadata={'share_briefing': True},
        )
        legacy_contract = _Msg(
            role='system',
            message_kind='llm',
            text_summary='<context type="session-share-fork">{}</context>',
            metadata={'share_contract': True},
        )
        self.assertTrue(is_context_injection_message(briefing))
        self.assertTrue(is_context_injection_message(legacy_contract))
        self.assertEqual(
            count_semantic_messages([
                briefing,
                legacy_contract,
                _Msg(role='user', text_summary='hello'),
                _Msg(role='assistant', text_summary='reply'),
            ]),
            2,
        )

    def test_is_context_injection_row(self):
        # ：回退预览列表按行排除 environment_context，与语义计数口径一致。
        self.assertTrue(is_context_injection_row({
            'role': 'user', 'message_kind': 'environment_context',
            'text_summary': '<context type="environment"> current_datetime...',
        }))
        self.assertTrue(is_context_injection_row({
            'role': 'user', 'message_kind': 'system_prompt_context',
            'text_summary': '<identity>system rules</identity>',
        }))
        self.assertTrue(is_context_injection_row({
            'role': 'user', 'message_kind': 'llm',
            'text_summary': '<context type="environment">\nx\n</context>',
        }))
        # ：与前端对齐，external-archive wrapper / kind 也算注入
        self.assertTrue(is_context_injection_row({
            'role': 'user', 'message_kind': 'external_archive_context',
            'text_summary': '<context type="external-archive">\narchive\n</context>',
        }))
        self.assertTrue(is_context_injection_row({
            'role': 'user', 'message_kind': 'llm',
            'text_summary': '<context type="external-archive">\narchive\n</context>',
        }))
        # 真实用户消息 / assistant 回复不算 context 注入
        self.assertFalse(is_context_injection_row({'role': 'user', 'text_summary': '今天天气怎么样'}))
        self.assertFalse(is_context_injection_row({'role': 'assistant', 'text_summary': '1、2、3'}))

    def test_from_values_sorted_by_created_at(self):
        rows = [
            {
                'id': '2',
                'role': 'assistant',
                'message_kind': 'llm',
                'agent_run_id': 'run-1',
                'text_summary': 'b',
                'created_at': 2,
            },
            {
                'id': '1',
                'role': 'assistant',
                'message_kind': 'tool_artifact',
                'agent_run_id': 'run-1',
                'text_summary': 'a',
                'created_at': 1,
            },
        ]
        self.assertEqual(count_semantic_messages_from_values(rows), 1)
