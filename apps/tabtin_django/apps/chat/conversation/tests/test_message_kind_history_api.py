"""
W1b 协议层 message_kind 历史 API 行为测试。


覆盖：
- ChatMessageSchema 序列化包含 `message_kind` + `has_artifacts` 字段
- `GET /api/chat/sessions/<id>/messages` 默认 `?expand_artifacts=false` 过滤 tool_artifact
- `?expand_artifacts=true` 显式返回所有 ChatMessage（含 tool_artifact）
- `has_artifacts` 按"同 agent_run_id 是否有 tool_artifact"计算（一次 SQL，无 N+1）
- error_envelope 在默认过滤下保留（仅 tool_artifact 被过滤）
- fork 路径正确透传 message_kind（防 tool_artifact 被打回 'llm'）
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.services.common.ws.handlers.relay_message_writer import (
    SyncWriteResult,
    _write_persist_messages,
)
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


class MessageKindHistoryApiTestCase(TestCase):
    """W1b 协议层 message_kind 历史 API + has_artifacts 行为测试。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 与 test_checkpoint_api.py 同款：disable organization 自动创建副作用
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization

        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization

        post_save.connect(create_default_organization, sender=User)

    def setUp(self):
        self.user = User.objects.create_user(
            username='msgkind_user',
            email='msgkind@example.com',
            password='testpass123',
        )
        self.raw_session_key = 'msgkind_test_session_key_00000000000000000000001'
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(self.raw_session_key),
            session_type='web',
            ip_address='127.0.0.1',
            user_agent='msgkind-test-agent',
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        self.token = generate_jwt_token(
            self.user,
            expire_hours=1,
            token_type='access',
            session_key=self.raw_session_key,
        )
        self.auth_headers = {
            'HTTP_AUTHORIZATION': f'Bearer {self.token}',
        }
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id='test-organization',
            title='message_kind history test',
        )

    def _get(self, url: str):
        return self.client.get(url, **self.auth_headers)

    @staticmethod
    def _payload(resp):
        body = resp.json()
        return body.get('data', body)

    def _create_llm_message(self, *, agent_run_id: str = '', content: str = 'llm reply'):
        return ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary=content,
            message_kind='llm',
            agent_run_id=agent_run_id,
        )

    def _create_tool_artifact(self, *, agent_run_id: str, content: str = 'widget svg'):
        return ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary=content,
            message_kind='tool_artifact',
            agent_run_id=agent_run_id,
            content_blocks_json=[
                {
                    'type': 'tabtin_rich_content',
                    'kind': 'widget',
                    'widget_id': 'wgt_test_001',
                    'code': '<svg></svg>',
                    'summary': content,
                }
            ],
        )

    def _create_error_envelope(self, *, content: str = 'context overflow'):
        return ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary=content,
            message_kind='error_envelope',
        )

    # ── Schema 序列化测试 ──────────────────────────────────────────

    def test_message_kind_default_llm_for_legacy_messages(self):
        """老消息（migration 之前的）应 default='llm'。"""
        # bare ChatMessage.objects.create 不传 message_kind → 走 model default
        msg = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='legacy message',
        )
        self.assertEqual(msg.message_kind, 'llm')

    def test_message_kind_can_be_set_to_three_kinds(self):
        """三档枚举都能正常写库。"""
        llm = self._create_llm_message()
        artifact = self._create_tool_artifact(agent_run_id='run_x')
        envelope = self._create_error_envelope()

        # 反查确认字段值
        self.assertEqual(ChatMessage.objects.get(id=llm.id).message_kind, 'llm')
        self.assertEqual(ChatMessage.objects.get(id=artifact.id).message_kind, 'tool_artifact')
        self.assertEqual(ChatMessage.objects.get(id=envelope.id).message_kind, 'error_envelope')

    def test_history_api_returns_message_kind_field(self):
        """API 响应每条 ChatMessage 含 message_kind 字段。"""
        self._create_llm_message(content='llm-1')
        url = f'/api/chat/sessions/{self.session.id}/messages'
        resp = self._get(url)
        self.assertEqual(resp.status_code, 200)
        payload = self._payload(resp)
        messages = payload['messages']
        self.assertEqual(len(messages), 1)
        self.assertIn('message_kind', messages[0])
        self.assertEqual(messages[0]['message_kind'], 'llm')
        self.assertIn('has_artifacts', messages[0])

    # ── expand_artifacts 行为测试 ──────────────────────────────────

    def test_expand_artifacts_false_default_filters_tool_artifact(self):
        """默认 ?expand_artifacts=false 时 tool_artifact 行不出现在响应中。"""
        self._create_llm_message(agent_run_id='run_a', content='llm-a')
        self._create_tool_artifact(agent_run_id='run_a', content='artifact-a')
        self._create_llm_message(agent_run_id='run_b', content='llm-b')

        url = f'/api/chat/sessions/{self.session.id}/messages'
        resp = self._get(url)
        self.assertEqual(resp.status_code, 200)
        payload = self._payload(resp)
        messages = payload['messages']

        kinds = [m['message_kind'] for m in messages]
        self.assertEqual(kinds, ['llm', 'llm'])
        # total 也按过滤后 qs.count() 算
        self.assertEqual(payload['total'], 2)

    def test_expand_artifacts_true_includes_tool_artifact(self):
        """?expand_artifacts=true 时 tool_artifact 行返回。"""
        self._create_llm_message(agent_run_id='run_a', content='llm-a')
        self._create_tool_artifact(agent_run_id='run_a', content='artifact-a')

        url = f'/api/chat/sessions/{self.session.id}/messages?expand_artifacts=true'
        resp = self._get(url)
        self.assertEqual(resp.status_code, 200)
        payload = self._payload(resp)
        messages = payload['messages']
        kinds = [m['message_kind'] for m in messages]
        self.assertEqual(kinds, ['llm', 'tool_artifact'])

    def test_history_api_keeps_block_arrival_fields(self):
        """历史回放透传块级 arrival 字段，前端按需拍平聚合。"""
        artifact = self._create_tool_artifact(agent_run_id='run_a', content='artifact-a')
        artifact.content_blocks_json = [
            {
                'type': 'tabtin_rich_content',
                'kind': 'widget',
                'summary': 'artifact-a',
                'arrival_seq': 30,
                'arrived_at': '2026-06-28T00:00:00Z',
            }
        ]
        artifact.save(update_fields=['content_blocks_json'])

        llm = self._create_llm_message(agent_run_id='run_a', content='llm-a')
        llm.content_blocks_json = [
            {
                'type': 'tool_use',
                'id': 'toolu_1',
                'name': 'present_to_user',
                'input': {},
                'arrival_seq': 20,
                'arrived_at': '2026-06-28T00:00:00Z',
            },
        ]
        llm.save(update_fields=['content_blocks_json'])

        url = f'/api/chat/sessions/{self.session.id}/messages?expand_artifacts=true'
        resp = self._get(url)
        self.assertEqual(resp.status_code, 200)
        payload = self._payload(resp)
        messages = payload['messages']
        self.assertEqual([m['id'] for m in messages], [str(llm.id), str(artifact.id)])
        by_id = {m['id']: m for m in messages}

        self.assertEqual(by_id[str(llm.id)]['content_blocks_json'][0]['arrival_seq'], 20)
        self.assertEqual(by_id[str(artifact.id)]['content_blocks_json'][0]['arrival_seq'], 30)
        self.assertIn('arrived_at', by_id[str(llm.id)]['content_blocks_json'][0])
        self.assertIn('arrived_at', by_id[str(artifact.id)]['content_blocks_json'][0])

        after_resp = self._get(
            f'/api/chat/sessions/{self.session.id}/messages?expand_artifacts=true&after={llm.id}',
        )
        self.assertEqual(after_resp.status_code, 200)
        after_messages = self._payload(after_resp)['messages']
        self.assertEqual([m['id'] for m in after_messages], [str(artifact.id)])

    def test_persist_message_preserves_existing_block_arrival(self):
        """persist_message 覆盖完整 blocks 时不能抹掉 reassembler 的块级到达时间。"""
        llm = self._create_llm_message(agent_run_id='run_a', content='llm-a')
        llm.content_blocks_json = [
            {
                'type': 'text',
                'text': 'before',
                'block_id': 'blk_text',
                'arrival_seq': 10,
                'arrived_at': '2026-06-28T00:00:00Z',
                'event_seq': 1,
            },
            {
                'type': 'tool_use',
                'id': 'toolu_1',
                'name': 'present_to_user',
                'input': {},
                'block_id': 'blk_tool',
                'arrival_seq': 20,
                'arrived_at': '2026-06-28T00:00:01Z',
                'event_seq': 2,
            },
        ]
        llm.save(update_fields=['content_blocks_json'])

        result = SyncWriteResult()
        _write_persist_messages(
            str(self.session.id),
            None,
            [{
                'type': 'agent.stream.persist_message',
                'payload': {
                    'message_id': str(llm.id),
                    'client_event_id': str(llm.id),
                    'role': 'assistant',
                    'arrival_seq': 900,
                    'message_kind': 'llm',
                    'blocks_json': [
                        {
                            'type': 'text',
                            'text': 'before final',
                            'arrival_seq': 900,
                            'arrived_at': '2026-06-28T00:09:00Z',
                            'event_seq': 90,
                        },
                        {
                            'type': 'tool_use',
                            'id': 'toolu_1',
                            'name': 'present_to_user',
                            'input': {},
                            'arrival_seq': 901,
                            'arrived_at': '2026-06-28T00:09:01Z',
                            'event_seq': 91,
                        },
                        {
                            'type': 'tool_result',
                            'tool_use_id': 'toolu_1',
                            'content': 'presented',
                        },
                    ],
                },
            }],
            result,
        )

        self.assertTrue(result.success)
        refreshed = ChatMessage.objects.get(id=llm.id)
        blocks = refreshed.content_blocks_json
        self.assertEqual(blocks[0]['arrival_seq'], 10)
        self.assertEqual(blocks[0]['arrived_at'], '2026-06-28T00:00:00Z')
        self.assertEqual(blocks[0]['event_seq'], 1)
        self.assertEqual(blocks[0]['block_id'], 'blk_text')
        self.assertEqual(blocks[1]['arrival_seq'], 20)
        self.assertEqual(blocks[1]['arrived_at'], '2026-06-28T00:00:01Z')
        self.assertEqual(blocks[1]['event_seq'], 2)
        self.assertEqual(blocks[1]['block_id'], 'blk_tool')
        self.assertEqual(blocks[2]['arrival_seq'], 902)

    def test_history_api_normalizes_legacy_nanosecond_arrival_for_cursor(self):
        """服务端分页排序与前端一致：旧纳秒 arrival 先归一成微秒再比较。"""
        base_micro = 1_780_000_000_000_000
        artifact = self._create_tool_artifact(agent_run_id='run_ns', content='artifact-ns')
        artifact.content_blocks_json = [
            {
                'type': 'tabtin_rich_content',
                'kind': 'widget',
                'summary': 'artifact-ns',
                'arrival_seq': base_micro + 30_000,
                'arrived_at': '2026-06-28T00:00:03Z',
            }
        ]
        artifact.save(update_fields=['content_blocks_json'])

        llm = self._create_llm_message(agent_run_id='run_ns', content='llm-ns')
        llm.content_blocks_json = [
            {
                'type': 'tool_use',
                'id': 'toolu_ns',
                'name': 'present_to_user',
                'input': {},
                # 历史数据曾以纳秒落库；服务端必须除以 1000 后再参与分页游标。
                'arrival_seq': (base_micro + 20_000) * 1000,
                'arrived_at': '2026-06-28T00:00:02Z',
            },
        ]
        llm.save(update_fields=['content_blocks_json'])

        url = f'/api/chat/sessions/{self.session.id}/messages?expand_artifacts=true'
        resp = self._get(url)
        self.assertEqual(resp.status_code, 200)
        messages = self._payload(resp)['messages']
        self.assertEqual([m['id'] for m in messages], [str(llm.id), str(artifact.id)])

        after_resp = self._get(
            f'/api/chat/sessions/{self.session.id}/messages?expand_artifacts=true&after={llm.id}',
        )
        self.assertEqual(after_resp.status_code, 200)
        after_messages = self._payload(after_resp)['messages']
        self.assertEqual([m['id'] for m in after_messages], [str(artifact.id)])

    def test_error_envelope_kept_when_expand_artifacts_false(self):
        """error_envelope 不被默认过滤（仅 tool_artifact 被过滤）。"""
        self._create_llm_message(content='llm-1')
        self._create_error_envelope(content='oops')
        self._create_tool_artifact(agent_run_id='run_x', content='artifact-x')

        url = f'/api/chat/sessions/{self.session.id}/messages'
        resp = self._get(url)
        payload = self._payload(resp)
        messages = payload['messages']
        kinds = [m['message_kind'] for m in messages]
        # llm + error_envelope 保留，tool_artifact 过滤
        self.assertEqual(kinds, ['llm', 'error_envelope'])

    # ──  include_hitl_facts 行为测试 ──────────────────────────

    def _create_hitl_interaction(self, *, request_key: str = 'batch-hitl-1'):
        return ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='',
            message_kind='hitl_interaction',
            metadata={
                'hitl': {
                    'kind': 'tool_approval',
                    'request_key': request_key,
                    'status': 'pending',
                    'payload': {'batch_id': request_key, 'action_requests': []},
                },
            },
        )

    def test_hitl_interaction_excluded_by_default(self):
        """#4999：默认不下发 hitl_interaction——保护不认识该 kind 的旧客户端/移动端。"""
        self._create_llm_message(content='llm-1')
        self._create_hitl_interaction()

        url = f'/api/chat/sessions/{self.session.id}/messages'
        resp = self._get(url)
        self.assertEqual(resp.status_code, 200)
        payload = self._payload(resp)
        kinds = [m['message_kind'] for m in payload['messages']]
        self.assertEqual(kinds, ['llm'])
        self.assertEqual(payload['total'], 1)

    def test_hitl_interaction_included_with_opt_in(self):
        """#4999：?include_hitl_facts=1 时下发事实行（新客户端面板派生/恢复用）。"""
        self._create_llm_message(content='llm-1')
        self._create_hitl_interaction(request_key='batch-opt-in')

        url = f'/api/chat/sessions/{self.session.id}/messages?include_hitl_facts=1'
        resp = self._get(url)
        self.assertEqual(resp.status_code, 200)
        payload = self._payload(resp)
        kinds = [m['message_kind'] for m in payload['messages']]
        self.assertEqual(kinds, ['llm', 'hitl_interaction'])
        hitl_msg = payload['messages'][1]
        self.assertEqual(hitl_msg['metadata']['hitl']['request_key'], 'batch-opt-in')
        self.assertEqual(hitl_msg['metadata']['hitl']['status'], 'pending')

    # ── has_artifacts 计算测试（避免 N+1）──────────────────────────

    def test_has_artifacts_true_when_same_run_id_has_tool_artifact(self):
        """LLM 主消息有同 agent_run_id 的 tool_artifact → has_artifacts=true。"""
        self._create_llm_message(agent_run_id='run_with_widget', content='llm-1')
        self._create_tool_artifact(agent_run_id='run_with_widget')

        url = f'/api/chat/sessions/{self.session.id}/messages'
        resp = self._get(url)
        payload = self._payload(resp)
        llm_msg = payload['messages'][0]
        self.assertEqual(llm_msg['message_kind'], 'llm')
        self.assertTrue(llm_msg['has_artifacts'])

    def test_has_artifacts_false_when_no_tool_artifact(self):
        """LLM 主消息无同 run_id 的 tool_artifact → has_artifacts=false。"""
        self._create_llm_message(agent_run_id='run_no_widget', content='llm-1')

        url = f'/api/chat/sessions/{self.session.id}/messages'
        resp = self._get(url)
        payload = self._payload(resp)
        llm_msg = payload['messages'][0]
        self.assertEqual(llm_msg['message_kind'], 'llm')
        self.assertFalse(llm_msg['has_artifacts'])

    def test_has_artifacts_false_for_tool_artifact_itself(self):
        """tool_artifact 自身 has_artifacts 永远 false（不展开自己）。"""
        self._create_llm_message(agent_run_id='run_x', content='llm-1')
        self._create_tool_artifact(agent_run_id='run_x')

        url = f'/api/chat/sessions/{self.session.id}/messages?expand_artifacts=true'
        resp = self._get(url)
        payload = self._payload(resp)
        messages = payload['messages']
        for msg in messages:
            if msg['message_kind'] == 'tool_artifact':
                self.assertFalse(msg['has_artifacts'])

    def test_has_artifacts_false_for_error_envelope(self):
        """error_envelope 自身 has_artifacts 始终 false。"""
        self._create_error_envelope(content='oops')

        url = f'/api/chat/sessions/{self.session.id}/messages'
        resp = self._get(url)
        payload = self._payload(resp)
        envelope_msg = payload['messages'][0]
        self.assertEqual(envelope_msg['message_kind'], 'error_envelope')
        self.assertFalse(envelope_msg['has_artifacts'])

    def test_has_artifacts_cross_run_isolation(self):
        """run_a 有 tool_artifact 不影响 run_b 的 LLM 消息 has_artifacts 判定。"""
        # run_a：LLM + tool_artifact
        self._create_llm_message(agent_run_id='run_a', content='llm-a')
        self._create_tool_artifact(agent_run_id='run_a')
        # run_b：仅 LLM（无 artifact）
        self._create_llm_message(agent_run_id='run_b', content='llm-b')

        url = f'/api/chat/sessions/{self.session.id}/messages'
        resp = self._get(url)
        payload = self._payload(resp)
        msgs_by_run = {m['agent_run_id']: m for m in payload['messages']}
        self.assertTrue(msgs_by_run['run_a']['has_artifacts'])
        self.assertFalse(msgs_by_run['run_b']['has_artifacts'])

    def test_has_artifacts_query_is_single_sql_not_n_plus_1(self):
        """has_artifacts 计算是一次 SQL（聚合 LLM 消息 agent_run_id 集合后批量查）。"""
        from django.test.utils import CaptureQueriesContext
        from django.db import connection

        # 创建 5 条 LLM 消息（不同 agent_run_id）+ 3 条对应的 tool_artifact
        for i in range(5):
            self._create_llm_message(agent_run_id=f'run_{i}', content=f'llm-{i}')
        for i in range(3):
            self._create_tool_artifact(agent_run_id=f'run_{i}')

        url = f'/api/chat/sessions/{self.session.id}/messages'
        with CaptureQueriesContext(connection) as ctx:
            resp = self._get(url)
        self.assertEqual(resp.status_code, 200)
        # 找含 message_kind='tool_artifact' 的查询应该只有 1 条——
        # 不应该 per-message 一次（N+1）。
        artifact_queries = [
            q for q in ctx.captured_queries
            if 'tool_artifact' in q['sql']
        ]
        # 1 条主 SELECT exclude + 1 条 has_artifacts 聚合查询 = 至多 2 条
        # （甚至可能只有 1 条聚合——主 SELECT 走 message_kind 列也算计入）
        self.assertLessEqual(
            len(artifact_queries), 2,
            f"has_artifacts 计算疑似 N+1: 命中 {len(artifact_queries)} 条 SQL\n"
            f"{[q['sql'][:120] for q in artifact_queries]}",
        )


# 源码守护测试搬到姊妹文件 `test_message_kind_source_guards.py`——那个文件
# 不继承 TestCase，CI 默认 SQLite test substitute 也能跑（结构性 invariant
# 守护，零 DB 副作用）。
#
# 本文件仅保留需要真 MySQL DB 的 API 行为测试（继承 TestCase），
# conftest._REQUIRES_PG_NATIVE 标记 → 默认 CI deselect by marker，本地真 MySQL
# 环境手动跑：`pytest apps/chat/conversation/tests/test_message_kind_history_api.py
# -m requires_pg_native --no-cov`
