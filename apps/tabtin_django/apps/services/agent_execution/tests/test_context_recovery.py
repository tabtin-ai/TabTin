from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from apps.services.agent_execution import context_assembler


class ContextAssemblerRecoveryTests(unittest.TestCase):
    def test_project_task_context_replaces_stale_contract(self):
        messages = [
            {'role': 'system', 'content': '<project_task_context>old</project_task_context>'},
            {'role': 'assistant', 'content': 'previous reply'},
        ]

        result = context_assembler._inject_project_task_turn_context(
            messages,
            '<project_task_context>current artifact</project_task_context>',
        )

        contracts = [
            message['content'] for message in result
            if message.get('role') == 'system'
            and '<project_task_context>' in str(message.get('content'))
        ]
        self.assertEqual(contracts, ['<project_task_context>current artifact</project_task_context>'])

    def test_project_task_session_injects_contract_before_runtime_dispatch(self):
        with patch.object(
            context_assembler,
            '_project_task_turn_instruction',
            return_value='<project_task_context>modify doc-1</project_task_context>',
        ):
            input_state = context_assembler.build_agent_input_state(
                session=SimpleNamespace(id='session-1', organization_id='org-1'),
                user=SimpleNamespace(id='user-1'),
                effective_thread_id='thread-1',
                context={'current_app_type': 'project_task', 'current_space_id': 'project-1'},
                plain_text='把预算改成 200 元',
                vision_parts=None,
                is_first_message=True,
                model_id='model-1',
                user_selected_model=False,
                client_type='electron',
                execution_profile='task',
                resolved_agent_name='Tin',
            )

        self.assertIn(
            '<project_task_context>modify doc-1</project_task_context>',
            [message.get('content') for message in input_state['messages']],
        )

    def test_chat_message_rows_to_recovery_messages_strips_and_wraps(self):
        rows = [
            {
                "role": "user",
                "content_blocks_json": [{"type": "text", "text": "之前的问题"}],
                "text_summary": "ignored",
            },
            {
                "role": "assistant",
                "content_blocks_json": [{
                    "type": "tabtin_skill_invocation",
                    "skill_id": "sk",
                    "skill_name": "Skill",
                    "injected_text": "技能注入内容",
                }],
                "text_summary": "",
            },
            {
                "role": "assistant",
                "content_blocks_json": [],
                "text_summary": "摘要兜底",
            },
            {
                "role": "tool",
                "content_blocks_json": [{"type": "text", "text": "不应进入主上下文"}],
                "text_summary": "",
            },
        ]

        messages = context_assembler._chat_message_rows_to_recovery_messages(rows)

        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "assistant"])
        self.assertEqual(
            messages[0]["content"][0]["text"],
            "<user_query>\n之前的问题\n</user_query>",
        )
        self.assertIn("技能注入内容", messages[1]["content"][0]["text"])
        self.assertEqual(messages[2]["content"][0]["text"], "摘要兜底")

    def test_internal_context_not_wrapped_as_user_query(self):
        """Runtime 内部 context / compaction_summary 不包 <user_query>。"""
        rows = [
            {
                "role": "user",
                "content_blocks_json": [{"type": "text", "text": '<context type="environment">\nenv\n</context>'}],
                "text_summary": "",
                "message_kind": "environment_context",
            },
            {
                "role": "user",
                "content_blocks_json": [{"type": "text", "text": '<context type="agent-profile">\n你是小 Tin。\n</context>'}],
                "text_summary": "",
                "message_kind": "agent_profile_context",
            },
            {
                "role": "user",
                "content_blocks_json": [{"type": "text", "text": "[对话摘要]\n\n前情\n\n[摘要结束]"}],
                "text_summary": "",
                "message_kind": "compaction_summary",
            },
            {
                "role": "user",
                "content_blocks_json": [{"type": "text", "text": "真提问"}],
                "text_summary": "",
                "message_kind": "llm",
            },
        ]

        messages = context_assembler._chat_message_rows_to_recovery_messages(rows)

        self.assertNotIn("<user_query>", messages[0]["content"][0]["text"])
        self.assertNotIn("<user_query>", messages[1]["content"][0]["text"])
        self.assertNotIn("<user_query>", messages[2]["content"][0]["text"])
        self.assertIn("<user_query>", messages[3]["content"][0]["text"])

    def test_persisted_system_context_projects_to_llm_user(self):
        rows = [{
            "role": "system",
            "content_blocks_json": [{
                "type": "text",
                "text": '<context type="environment">env</context>',
            }],
            "text_summary": "",
            "message_kind": "environment_context",
        }]

        messages = context_assembler._chat_message_rows_to_recovery_messages(rows)

        self.assertEqual(messages[0]["role"], "user")
        self.assertNotIn("<user_query>", messages[0]["content"][0]["text"])


    def test_system_prompt_context_not_wrapped_as_user_query(self):
        """system_prompt_context / compaction_summary 不包 <user_query>。"""
        rows = [
            {
                "role": "user",
                "content_blocks_json": [{"type": "text", "text": '<context type="environment">\nenv\n</context>'}],
                "text_summary": "",
                "message_kind": "environment_context",
            },
            {
                "role": "user",
                "content_blocks_json": [{"type": "text", "text": "[对话摘要]\n\n前情\n\n[摘要结束]"}],
                "text_summary": "",
                "message_kind": "compaction_summary",
            },
            {
                "role": "user",
                "content_blocks_json": [{"type": "text", "text": "真提问"}],
                "text_summary": "",
                "message_kind": "llm",
            },
        ]

        messages = context_assembler._chat_message_rows_to_recovery_messages(rows)

        self.assertNotIn("<user_query>", messages[0]["content"][0]["text"])
        self.assertNotIn("<user_query>", messages[1]["content"][0]["text"])
        self.assertIn("<user_query>", messages[2]["content"][0]["text"])

    def test_system_prompt_context_not_in_recovery_kinds(self):
        """#8550：system_prompt_context 仅审计落库，不进 recovery LLM 历史。"""
        self.assertNotIn(
            "system_prompt_context",
            context_assembler._RECOVERY_MESSAGE_KINDS,
        )
        self.assertIn("environment_context", context_assembler._RECOVERY_MESSAGE_KINDS)
        self.assertIn("agent_profile_context", context_assembler._RECOVERY_MESSAGE_KINDS)
        self.assertIn("external_archive_context", context_assembler._RECOVERY_MESSAGE_KINDS)

    def test_assistant_colocated_tool_results_split_to_user_message(self):
        """#5430：assistant 行 co-locate 的 tool_result 拆为后续 user 消息。"""
        rows = [
            {
                "role": "assistant",
                "content_blocks_json": [
                    {"type": "text", "text": "我来查一下"},
                    {"type": "tool_use", "id": "tc1", "name": "shell", "input": {"command": "ls"}},
                    {"type": "tool_result", "tool_use_id": "tc1", "content": "files"},
                ],
                "text_summary": "",
                "message_kind": "llm",
            },
        ]

        messages = context_assembler._chat_message_rows_to_recovery_messages(rows)

        self.assertEqual([m["role"] for m in messages], ["assistant", "user"])
        assistant_types = [b["type"] for b in messages[0]["content"]]
        self.assertEqual(assistant_types, ["text", "tool_use"])
        self.assertEqual(messages[1]["content"][0]["type"], "tool_result")
        self.assertEqual(messages[1]["content"][0]["tool_use_id"], "tc1")

    def test_repair_injects_expired_tool_result_for_anthropic_style(self):
        """#5430：Anthropic 风未配对 tool_use 注入合成 expired tool_result。"""
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "tc-lost", "name": "shell", "input": {}},
                ],
            },
        ]

        repaired = context_assembler.repair_incomplete_tool_calls(messages)

        self.assertEqual(len(repaired), 2)
        self.assertEqual(repaired[1]["role"], "user")
        block = repaired[1]["content"][0]
        self.assertEqual(block["type"], "tool_result")
        self.assertEqual(block["tool_use_id"], "tc-lost")
        self.assertIn("expired", block["content"])

    def test_share_snapshot_tool_cards_recover_as_history_text(self):
        rows = [
            {
                "role": "assistant",
                "content_blocks_json": [
                    {"type": "text", "text": "我先检查环境。"},
                    {
                        "type": "tool_use",
                        "id": "tu_snapshot",
                        "name": "run_terminal_command",
                        "label": "执行命令",
                        "input": {},
                    },
                ],
                "text_summary": "我先检查环境。",
                "message_kind": "llm",
                "metadata": {"share_snapshot": True},
            },
        ]

        messages = context_assembler._chat_message_rows_to_recovery_messages(rows)

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["role"], "assistant")
        block_types = [block["type"] for block in messages[0]["content"]]
        self.assertEqual(block_types, ["text", "text"])
        self.assertIn("历史工具调用", messages[0]["content"][1]["text"])

    def test_repair_skips_paired_anthropic_tool_use(self):
        messages = [
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "tc1", "name": "shell", "input": {}}],
            },
            {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "tc1", "content": "ok"}],
            },
        ]
        repaired = context_assembler.repair_incomplete_tool_calls(messages)
        self.assertEqual(len(repaired), 2)

    def test_recovery_truncates_at_last_compaction_checkpoint(self):
        """#5430：存在 compaction_summary 时从最后一个检查点起恢复。"""
        captured_rows = []

        def fake_convert(rows):
            captured_rows.extend(rows)
            return []

        fake_qs_rows = [
            {"role": "user", "content_blocks_json": [{"type": "text", "text": "old"}],
             "text_summary": "", "message_kind": "llm"},
            {"role": "user", "content_blocks_json": [{"type": "text", "text": "[对话摘要]…"}],
             "text_summary": "", "message_kind": "compaction_summary"},
            {"role": "user", "content_blocks_json": [{"type": "text", "text": "new"}],
             "text_summary": "", "message_kind": "llm"},
        ]

        with patch(
            "apps.chat.conversation.models.ChatMessage.objects"
        ) as manager, patch.object(
            context_assembler,
            "_chat_message_rows_to_recovery_messages",
            side_effect=fake_convert,
        ):
            chain = manager.filter.return_value.filter.return_value.order_by.return_value
            chain.values.return_value = fake_qs_rows

            context_assembler._load_recovery_messages_from_chat_messages("sess-1")

        kinds = [r.get("message_kind") for r in captured_rows]
        self.assertEqual(kinds, ["compaction_summary", "llm"])

    def test_missing_conversation_state_recovers_from_chat_messages_without_notice(self):
        recovered_messages = [
            {
                "role": "user",
                "content": [{"type": "text", "text": "<user_query>\n上一轮\n</user_query>"}],
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "上一轮回复"}],
            },
            {
                "role": "user",
                "content": [{"type": "text", "text": "<user_query>\n本轮\n</user_query>"}],
            },
        ]

        with patch(
            "apps.services.agent_engine.persistence.conversation_store.ConversationStore.load_state",
            return_value=None,
        ), patch(
            "apps.chat.conversation.models.ChatMessage.objects"
        ) as manager, patch.object(
            context_assembler,
            "_load_recovery_messages_from_chat_messages",
            return_value=recovered_messages,
        ), patch.object(
            context_assembler.Publisher,
            "publish_system_notice",
        ) as publish_notice:
            manager.filter.return_value.count.return_value = 3

            input_state = context_assembler.build_agent_input_state(
                session=SimpleNamespace(id="sess-1", organization_id="wt-1"),
                user=SimpleNamespace(id="user-1"),
                effective_thread_id="chat-session-sess-1",
                context={"current_space_id": "space-1"},
                plain_text="本轮",
                vision_parts=None,
                is_first_message=False,
                model_id="model-1",
                user_selected_model=True,
                client_type="mobile",
                execution_profile=None,
                resolved_agent_name="Tin",
            )

        self.assertEqual(input_state["messages"], recovered_messages)
        self.assertTrue(input_state["_recovered"])
        self.assertTrue(input_state["_recovered_from_chat_messages"])
        self.assertEqual(input_state["current_space_id"], "space-1")
        publish_notice.assert_not_called()


if __name__ == "__main__":
    unittest.main()
