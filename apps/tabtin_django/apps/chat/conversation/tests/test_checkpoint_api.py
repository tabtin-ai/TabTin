"""
Checkpoint API tests.

Tests cover:
- PATCH /messages/{id}/checkpoint — input validation
- POST /sessions/{id}/rollback — soft rollback (revert_message_id mark)
- POST /sessions/{id}/unrevert — undo rollback
- GET /sessions/{id}/messages — respects soft-rollback visibility filter
"""

import json
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.chat.conversation.api._common import (
    _build_rollback_apply_result,
    _build_session_rollback_state,
)
from apps.chat.conversation.api.rollback import (
    _RuntimeFilePreviewResult,
    _RuntimeRewindResult,
    _build_reapply_resource_items,
    _compute_restore_plan,
    _merge_rollback_apply_state,
    _parse_runtime_rewind_result,
    _resolve_rewind_anchor_id,
)
from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.services.agent_engine.services.daemon_checkpoint_service import (
    DaemonCheckpointService,
)
from apps.services.common.db_router import postgres_app_db_alias
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


class CheckpointApiTestCase(TestCase):
    databases = {'default', 'postgresql'}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
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
            username='ckpt_user',
            email='ckpt@example.com',
            password='testpass123',
        )
        self.raw_session_key = 'checkpoint_test_session_key_00000000000000000001'
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(self.raw_session_key),
            session_type='web',
            ip_address='127.0.0.1',
            user_agent='checkpoint-test-agent',
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
            title='checkpoint test',
        )

    def _post(self, url: str, payload: dict):
        if url.endswith('/rollback') and 'runtime_rewind_applied' not in payload:
            payload = {
                **payload,
                'runtime_rewind_applied': True,
                'runtime_keep_message_count': 0,
            }
        return self.client.post(
            url,
            data=json.dumps(payload),
            content_type='application/json',
            **self.auth_headers,
        )

    def _patch(self, url: str, payload: dict):
        return self.client.patch(
            url,
            data=json.dumps(payload),
            content_type='application/json',
            **self.auth_headers,
        )

    def _get(self, url: str):
        return self.client.get(url, **self.auth_headers)

    @staticmethod
    def _payload(resp):
        body = resp.json()
        return body.get('data', body)

    # ── PATCH /messages/{id}/checkpoint ──

    def test_update_checkpoint_rejects_non_assistant_message(self):
        msg = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='hello',
        )

        resp = self._patch(
            f'/api/chat/messages/{msg.id}/checkpoint',
            {'checkpoint_hash': 'abc123'},
        )

        self.assertEqual(resp.status_code, 400)
        self.assertIn('assistant', resp.json().get('message', ''))

    def test_update_checkpoint_rejects_blank_hash(self):
        msg = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='answer',
        )

        resp = self._patch(
            f'/api/chat/messages/{msg.id}/checkpoint',
            {'checkpoint_hash': '   '},
        )

        self.assertEqual(resp.status_code, 400)
        self.assertIn('checkpoint_hash', resp.json().get('message', ''))

    # ── POST /sessions/{id}/rollback — soft rollback ──

    def test_rollback_ignores_empty_checkpoint_hash(self):
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='assistant checkpoint',
            checkpoint_hash='goodhash',
            checkpoint_state_index=3,
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='assistant empty checkpoint',
            checkpoint_hash='',
            checkpoint_state_index=99,
        )
        target_user_msg = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='need edit',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(target_user_msg.id)},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body.get('checkpoint_hash'), 'goodhash')

    def test_rollback_rejects_system_role_target(self):
        """system role messages cannot be rollback targets"""
        target_system = ChatMessage.objects.create(
            session=self.session,
            role='system',
            text_summary='system msg',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(target_system.id)},
        )

        self.assertEqual(resp.status_code, 400)

    def test_rollback_requires_runtime_rewind_proof(self):
        """Rollback apply cannot be called as Django-first without runtime proof."""
        target_user = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='need runtime first',
        )
        resp = self.client.post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            data=json.dumps({'target_message_id': str(target_user.id)}),
            content_type='application/json',
            **self.auth_headers,
        )
        self.assertEqual(resp.status_code, 400)

    def test_rollback_to_assistant_sets_revert_mark(self):
        """Rollback to assistant: sets revert_message_id, messages NOT physically deleted."""
        msg_u1 = ChatMessage.objects.create(
            session=self.session, role='user', text_summary='q1',
        )
        msg_a1 = ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1',
            checkpoint_hash='hash_a1', checkpoint_state_index=2,
        )
        ChatMessage.objects.create(
            session=self.session, role='user', text_summary='q2',
        )
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a2',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(msg_a1.id)},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['checkpoint_hash'], 'hash_a1')
        self.assertEqual(body['truncated_message_count'], 2)

        # 4 original + 1 system message from rollback
        self.assertEqual(self.session.messages.count(), 5)

        # Session is marked as reverted
        self.session.refresh_from_db()
        self.assertEqual(self.session.revert_message_id, msg_a1.id)

        # GET messages API returns visible messages (u1 + a1 + system)
        resp = self._get(f'/api/chat/sessions/{self.session.id}/messages?limit=50')
        self.assertEqual(resp.status_code, 200)
        visible_ids = [m['id'] for m in self._payload(resp)['messages']]
        self.assertEqual(len(visible_ids), 3)
        self.assertIn(str(msg_u1.id), visible_ids)
        self.assertIn(str(msg_a1.id), visible_ids)
        assistant_payload = next(m for m in self._payload(resp)['messages'] if m['id'] == str(msg_a1.id))
        self.assertIsInstance(assistant_payload.get('checkpoint_record'), dict)
        self.assertEqual(assistant_payload['checkpoint_record']['checkpoint_id'], str(msg_a1.id))
        self.assertEqual(assistant_payload['checkpoint_record']['status'], 'degraded')

    def test_rollback_to_user_sets_revert_mark(self):
        """Rollback to user: target and later messages hidden, NOT physically deleted."""
        msg_u1 = ChatMessage.objects.create(
            session=self.session, role='user', text_summary='q1',
        )
        msg_a1 = ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1',
            checkpoint_hash='hash_a1', checkpoint_state_index=2,
        )
        target_u2 = ChatMessage.objects.create(
            session=self.session, role='user', text_summary='q2',
        )
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a2',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(target_u2.id)},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['checkpoint_hash'], 'hash_a1')
        self.assertEqual(body['truncated_message_count'], 2)

        # 4 original + 1 system message from rollback
        self.assertEqual(self.session.messages.count(), 5)

        self.session.refresh_from_db()
        self.assertEqual(self.session.revert_message_id, target_u2.id)

        # Visible: u1 + a1 + system (target_u2 excluded because role=user)
        resp = self._get(f'/api/chat/sessions/{self.session.id}/messages?limit=50')
        visible_ids = [m['id'] for m in self._payload(resp)['messages']]
        self.assertEqual(len(visible_ids), 3)
        self.assertIn(str(msg_u1.id), visible_ids)
        self.assertIn(str(msg_a1.id), visible_ids)

    def test_rollback_stores_safety_snapshot_hash(self):
        """safety_snapshot_hash is persisted on session for unrevert use."""
        msg_a1 = ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1',
            checkpoint_hash='hash_a1',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {
                'target_message_id': str(msg_a1.id),
                'safety_snapshot_hash': 'safety_abc123',
            },
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body.get('overall_status'), 'success')
        self.assertIsInstance(body.get('rollback_state'), dict)
        self.assertTrue(body['rollback_state']['revert_active'])
        self.assertEqual(body['rollback_state']['cleanup_status'], 'pending')
        self.assertTrue(body['rollback_state']['can_unrevert'])
        self.assertIsInstance(body.get('checkpoint_record'), dict)
        self.assertEqual(body['checkpoint_record']['checkpoint_id'], str(msg_a1.id))
        self.assertEqual(body['checkpoint_record']['status'], 'degraded')
        self.assertIsInstance(body.get('apply_result'), dict)
        self.assertEqual(body['apply_result']['overall_status'], 'success')
        self.assertEqual(body['apply_result']['session_state']['cleanup_status'], 'pending')
        self.session.refresh_from_db()
        self.assertEqual(self.session.revert_snapshot_hash, 'safety_abc123')

    # ── per-file 回退锚点（§3.9 规则 3，off-by-one 修复）────────────────────────
    # 以下用例统一使用 W3 当前消息字段 `text_summary` / `agent_run_id`，
    # 直接覆盖本次切换的核心——anchor 解析语义。

    def test_resolve_rewind_anchor_id_user_target_picks_following_assistant(self):
        """user 目标（编辑+恢复并发送）→ 取**之后第一条** assistant 的 agent_run_id。

        这正是 §3.9 修掉的 off-by-one：旧 shadow-git 取「目标**前**最近 assistant」，
        per-file 必须取「目标触发的那一轮」= 之后第一条 assistant。
        """
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q1')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1', agent_run_id='run-1',
        )
        target_u2 = ChatMessage.objects.create(session=self.session, role='user', text_summary='q2')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a2', agent_run_id='run-2',
        )

        anchor = _resolve_rewind_anchor_id(self.session, target_u2)
        self.assertEqual(anchor, 'run-2')
        # 绝不退回旧 off-by-one 的「目标前最近 assistant」run-1。
        self.assertNotEqual(anchor, 'run-1')

    def test_resolve_rewind_anchor_id_assistant_target_uses_following_run_id(self):
        """assistant 目标保留该轮结果，文件锨点取下一轮 agent_run_id。"""
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q1')
        target_a1 = ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1', agent_run_id='run-1',
        )
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q2')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a2', agent_run_id='run-2',
        )

        anchor = _resolve_rewind_anchor_id(self.session, target_a1)
        self.assertEqual(anchor, 'run-2')
        self.assertNotEqual(anchor, 'run-1')

    def test_resolve_rewind_anchor_id_last_assistant_returns_none(self):
        """assistant 目标是最后一条 → 无下一轮文件锨点。"""
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q1')
        target_a1 = ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1', agent_run_id='run-1',
        )

        self.assertIsNone(_resolve_rewind_anchor_id(self.session, target_a1))

    def test_resolve_rewind_anchor_id_user_without_following_assistant_returns_none(self):
        """user 目标之后还没有 assistant（未触发回复）→ None（调用方跳过文件恢复，不报错）。"""
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q1')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1', agent_run_id='run-1',
        )
        target_u2 = ChatMessage.objects.create(session=self.session, role='user', text_summary='q2')

        self.assertIsNone(_resolve_rewind_anchor_id(self.session, target_u2))

    def test_resolve_rewind_anchor_id_following_assistant_without_run_id_returns_none(self):
        """user 目标之后第一条 assistant 无 agent_run_id（老消息 / 流式占位）→ None。"""
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q1')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1', agent_run_id='run-1',
        )
        target_u2 = ChatMessage.objects.create(session=self.session, role='user', text_summary='q2')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a2', agent_run_id='',
        )

        self.assertIsNone(_resolve_rewind_anchor_id(self.session, target_u2))

    def test_maybe_file_history_rewind_non_daemon_returns_local_host(self):
        """非 Daemon 宿主（无绑定 daemon 设备）→ host='local'、success=True，后端不碰文件。

        宿主分流的本地分支：文件层交还前端 fileHistoryIpc.rewind，后端不 dispatch。
        """
        outcome = DaemonCheckpointService.maybe_file_history_rewind(
            self.session.effective_thread_id, 'run-1',
        )
        self.assertEqual(outcome.host, 'local')
        self.assertTrue(outcome.success)
        self.assertEqual(outcome.failed_files, [])

    def test_maybe_file_history_rewind_empty_anchor_returns_local_noop(self):
        """空 anchor（无可回退锚点）→ host='local'、success=True，直接 no-op。"""
        outcome = DaemonCheckpointService.maybe_file_history_rewind(
            self.session.effective_thread_id, '',
        )
        self.assertEqual(outcome.host, 'local')
        self.assertTrue(outcome.success)

    # ── FH-3：宿主分流独立于 anchor + C-FH6：dispatch 带 space_id ──────────────

    _DAEMON_CTX = {
        'device_fingerprint': 'fp-test',
        'project_path': '/work/test',
        'space_id': 'space-test-xyz',
    }

    def test_maybe_file_history_rewind_empty_anchor_daemon_returns_daemon_host(self):
        """FH-3：Daemon 宿主即使 anchor=None 也回 host='daemon'（no-op、success=True），
        别让前端在 daemon thread 上盲调本地 rewind 报假失败；且不 dispatch（无可回退）。"""
        with patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._resolve_daemon_context',
            return_value=dict(self._DAEMON_CTX),
        ), patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._dispatch_checkpoint_action',
        ) as mock_dispatch:
            outcome = DaemonCheckpointService.maybe_file_history_rewind(
                self.session.effective_thread_id, '',
            )
        self.assertEqual(outcome.host, 'daemon')
        self.assertTrue(outcome.success)
        self.assertEqual(outcome.failed_files, [])
        mock_dispatch.assert_not_called()

    def test_maybe_file_history_rewind_dispatch_includes_space_id(self):
        """C-FH6：rewind dispatch 带 session 的 space_id（来自 ctx），让 daemon path
        guard 用真实 session 根解析 allowedPaths，而非回落 config.workspace_root。"""
        with patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._resolve_daemon_context',
            return_value=dict(self._DAEMON_CTX),
        ), patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._dispatch_checkpoint_action',
            return_value={'failed_files': []},
        ) as mock_dispatch:
            outcome = DaemonCheckpointService.maybe_file_history_rewind(
                self.session.effective_thread_id, 'run-1',
            )
        self.assertEqual(outcome.host, 'daemon')
        self.assertTrue(outcome.success)
        kwargs = mock_dispatch.call_args.kwargs
        self.assertEqual(kwargs['action_type'], 'file_history_rewind')
        self.assertEqual(kwargs['params'].get('anchor_id'), 'run-1')
        self.assertEqual(kwargs['params'].get('space_id'), 'space-test-xyz')

    # ── FH-4：Daemon 宿主 per-file 回退预览 ───────────────────────────────────

    def test_maybe_file_history_preview_non_daemon_returns_local(self):
        """非 Daemon 宿主 preview → host='local'、affected_paths 空，后端不 dispatch
        （预览交还前端 fileHistoryIpc.getAffectedPaths 本地算）。"""
        outcome = DaemonCheckpointService.maybe_file_history_preview(
            self.session.effective_thread_id, 'run-1',
        )
        self.assertEqual(outcome.host, 'local')
        self.assertEqual(outcome.affected_paths, [])
        self.assertTrue(outcome.success)

    def test_maybe_file_history_preview_daemon_returns_affected_paths_with_space_id(self):
        """FH-4 + C-FH6：Daemon 宿主 preview → host='daemon' + 真实 affected_paths，
        且 dispatch file_history_preview 带 space_id。"""
        with patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._resolve_daemon_context',
            return_value=dict(self._DAEMON_CTX),
        ), patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._dispatch_checkpoint_action',
            return_value={'affected_paths': ['src/a.ts', 'src/b.ts']},
        ) as mock_dispatch:
            outcome = DaemonCheckpointService.maybe_file_history_preview(
                self.session.effective_thread_id, 'run-1', space_id='space-explicit',
            )
        self.assertEqual(outcome.host, 'daemon')
        self.assertEqual(outcome.affected_paths, ['src/a.ts', 'src/b.ts'])
        self.assertTrue(outcome.success)
        kwargs = mock_dispatch.call_args.kwargs
        self.assertEqual(kwargs['action_type'], 'file_history_preview')
        self.assertEqual(kwargs['params'].get('anchor_id'), 'run-1')
        # 显式传入的 space_id 优先于 ctx 解析值。
        self.assertEqual(kwargs['params'].get('space_id'), 'space-explicit')

    def test_maybe_file_history_preview_empty_anchor_daemon_no_dispatch(self):
        """FH-3 同款：Daemon 宿主但 anchor=None → host='daemon'、affected_paths 空、
        非失败，且不 dispatch（无可预览）。"""
        with patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._resolve_daemon_context',
            return_value=dict(self._DAEMON_CTX),
        ), patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._dispatch_checkpoint_action',
        ) as mock_dispatch:
            outcome = DaemonCheckpointService.maybe_file_history_preview(
                self.session.effective_thread_id, '',
            )
        self.assertEqual(outcome.host, 'daemon')
        self.assertEqual(outcome.affected_paths, [])
        self.assertTrue(outcome.success)
        mock_dispatch.assert_not_called()

    def test_rollback_preview_daemon_host_returns_affected_paths(self):
        """契约①：Daemon 宿主 rollback preview API 返回 per-file affected_paths +
        file_restore_host='daemon' + rewind_anchor_id（= 目标那一轮 agentRunId）。"""
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q1')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1', agent_run_id='run-1',
        )
        target_u2 = ChatMessage.objects.create(session=self.session, role='user', text_summary='q2')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a2', agent_run_id='run-2',
        )

        with patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._resolve_daemon_context',
            return_value=dict(self._DAEMON_CTX),
        ), patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._dispatch_checkpoint_action',
            return_value={'affected_paths': ['src/a.ts', 'src/b.ts']},
        ):
            resp = self._post(
                f'/api/chat/sessions/{self.session.id}/rollback/preview',
                {'target_message_id': str(target_u2.id)},
            )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['file_restore_host'], 'daemon')
        self.assertEqual(body['affected_paths'], ['src/a.ts', 'src/b.ts'])
        # user 目标 → 之后第一条 assistant 的 run id（§3.9 off-by-one 修复）。
        self.assertEqual(body['rewind_anchor_id'], 'run-2')

    def test_rollback_preview_local_host_omits_backend_affected_paths(self):
        """非 Daemon 宿主 preview API：file_restore_host='local'、affected_paths 空，
        前端据此走本地 fileHistoryIpc 路径（不破坏 Electron 本地链路）。"""
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q1')
        target_a1 = ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1', agent_run_id='run-1',
        )
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q2')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a2', agent_run_id='run-2',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target_a1.id)},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['file_restore_host'], 'local')
        self.assertEqual(body['affected_paths'], [])
        # 点 a1 回退会保留 a1 这一轮及其文件，因此锚到下一轮 run-2 的开始前。
        self.assertEqual(body['rewind_anchor_id'], 'run-2')

    @patch(
        'apps.chat.conversation.api.rollback._request_runtime_file_preview',
        return_value=_RuntimeFilePreviewResult(
            status='unavailable',
            reason='no_file_history',
        ),
    )
    def test_mobile_rollback_preview_queries_bound_electron_before_confirmation(
        self,
        mock_file_preview,
    ):
        """手机没有本机 IPC，预览必须由绑定 Electron 明确确认文件影响。"""
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='question to edit',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='answer',
            agent_run_id='00000000-0000-0000-0000-000000000102',
        )

        resp = self.client.post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            data=json.dumps({'target_message_id': str(target.id)}),
            content_type='application/json',
            HTTP_X_CLIENT_TYPE='ios',
            **self.auth_headers,
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertFalse(body['file_preview_success'])
        self.assertEqual(body['file_preview_status'], 'unavailable')
        self.assertEqual(body['file_preview_reason'], 'no_file_history')
        self.assertEqual(body['affected_paths'], [])
        mock_file_preview.assert_called_once_with(
            self.session,
            '00000000-0000-0000-0000-000000000102',
        )

    @patch(
        'apps.collab.models.ChangeLog.objects.using',
        side_effect=RuntimeError('resource ledger unavailable'),
    )
    def test_rollback_preview_marks_resource_query_failure_unavailable(self, _mock_using):
        """资源账本读取失败不能伪装成“无资源影响”。"""
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='rewrite this request',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='resource-changing answer',
            agent_run_id='00000000-0000-0000-0000-000000000201',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['resource_preview_status'], 'unavailable')
        self.assertEqual(body['resource_preview_reason'], 'resource_change_query_failed')
        self.assertFalse(body['no_impact'])

    def test_rollback_preview_confirms_no_resource_impact(self):
        """只有成功查过资源账本才能返回 not_applicable。"""
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='plain chat request',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='plain answer',
            agent_run_id='00000000-0000-0000-0000-000000000202',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['resource_preview_status'], 'not_applicable')
        self.assertIsNone(body['resource_preview_reason'])

    def test_rollback_preview_keeps_virtual_files_out_of_resource_plan(self):
        """代码文件只属于 workspace files 层，不能重复伪装成不可恢复资源。"""
        from apps.collab.models import ChangeLog

        run_id = '00000000-0000-0000-0000-000000000205'
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='edit a code file',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='file updated',
            agent_run_id=run_id,
        )
        ChangeLog.objects.using(postgres_app_db_alias()).create(
            resource_type='file',
            resource_id=uuid4(),
            change_type='update',
            summary='src/app.ts',
            agent_run_id=run_id,
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['resource_changes'], [])
        self.assertEqual(body['resource_restore_plan'], [])
        self.assertEqual(body['resource_preview_status'], 'not_applicable')

    @patch(
        'apps.collab.models.VersionHistory.objects.using',
        side_effect=RuntimeError('version store unavailable'),
    )
    def test_rollback_preview_marks_resource_version_query_failure_unavailable(self, _mock_using):
        """版本库查询失败是 unknown，不能降级成已知无版本。"""
        from apps.collab.models import ChangeLog

        run_id = '00000000-0000-0000-0000-000000000203'
        resource_id = uuid4()
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='edit resource request',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='resource answer',
            agent_run_id=run_id,
        )
        ChangeLog.objects.using(postgres_app_db_alias()).create(
            resource_type='docs',
            resource_id=resource_id,
            change_type='update',
            summary='update doc',
            agent_run_id=run_id,
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['resource_preview_status'], 'unavailable')
        self.assertEqual(body['resource_preview_reason'], 'resource_version_query_failed')
        self.assertEqual(body['resource_restore_plan'], [])

    def test_rollback_daemon_host_without_anchor_still_daemon(self):
        """契约②：Daemon 宿主 rollback 即使 rewind_anchor_id=None（目标 user 之后无
        assistant），也回 file_restore_host='daemon'，不让前端误试本地 rewind；
        无锚点 → no-op，不 dispatch file_history_rewind。"""
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q0')
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a0', agent_run_id='run-0',
        )
        target_u = ChatMessage.objects.create(
            session=self.session, role='user', text_summary='last user, no following assistant',
        )

        with patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._resolve_daemon_context',
            return_value=dict(self._DAEMON_CTX),
        ), patch(
            'apps.services.agent_engine.services.daemon_checkpoint_service._dispatch_checkpoint_action',
        ) as mock_dispatch:
            resp = self._post(
                f'/api/chat/sessions/{self.session.id}/rollback',
                {'target_message_id': str(target_u.id)},
            )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['file_restore_host'], 'daemon')
        self.assertTrue(body['file_restore_success'])
        # anchor=None 只表示文件层无可用锚点；对话 transcript 仍需回退。
        self.assertEqual(mock_dispatch.call_count, 1)
        self.assertEqual(
            mock_dispatch.call_args.kwargs['action_type'],
            'session_transcript_truncate',
        )
        self.assertNotIn('file_rewind_anchor_id', mock_dispatch.call_args.kwargs['params'])

    def test_rollback_preview_returns_effective_checkpoint_view(self):
        """rollback preview returns aggregated effective checkpoint and impact summary."""
        ChatMessage.objects.create(
            session=self.session, role='user', text_summary='q1',
        )
        msg_a1 = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='a1',
            checkpoint_hash='hash_a1',
            checkpoint_state_index=2,
        )
        ChatMessage.objects.create(
            session=self.session, role='user', text_summary='q2',
        )
        ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a2',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(msg_a1.id)},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['target_message_id'], str(msg_a1.id))
        self.assertFalse(body['no_impact'])
        self.assertEqual(body['impact']['messages']['to_remove'], 2)
        self.assertTrue(body['impact']['files']['available'])
        self.assertIsInstance(body.get('effective_checkpoint'), dict)
        self.assertEqual(body['effective_checkpoint']['checkpoint_id'], str(msg_a1.id))
        self.assertEqual(body['effective_checkpoint']['status'], 'degraded')
        self.assertIn('missing_resource_snapshot', body['degraded_reasons'])
        self.assertTrue(body['effective_checkpoint']['capability_scope']['file_restore'])
        self.assertFalse(body['effective_checkpoint']['capability_scope']['resource_restore'])
        self.assertTrue(body['effective_checkpoint']['capability_scope']['unrevert'])

    def test_get_messages_uses_space_checkpoint_summary_for_checkpoint_record(self):
        """messages API should expose the same resource_restore semantics as preview/apply."""
        self.session.space_id = uuid4()
        self.session.save(update_fields=['space_id'])
        msg = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='checkpoint ready',
            checkpoint_hash='hash_ready',
        )

        with patch(
            'apps.chat.conversation.api.message._get_space_checkpoint_summaries',
            return_value={
                'hash_ready': {
                    'id': 'cp-1',
                    'version_refs': {'docs:doc-1': 'vh-1'},
                    'agent_run_id': 'run-1',
                    'created_at': timezone.now(),
                },
            },
        ):
            resp = self._get(f'/api/chat/sessions/{self.session.id}/messages?limit=50')

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        msg_view = next(item for item in body['messages'] if item['id'] == str(msg.id))
        checkpoint_record = msg_view['checkpoint_record']
        self.assertEqual(checkpoint_record['status'], 'ready')
        self.assertTrue(checkpoint_record['capability_scope']['file_restore'])
        self.assertTrue(checkpoint_record['capability_scope']['resource_restore'])
        self.assertEqual(checkpoint_record['resource_snapshot_ref']['version_ref_count'], 1)

    def test_get_messages_returns_conversation_rewind_anchor_when_only_state_anchor_exists(self):
        """没有文件/资源快照时，assistant turn 仍应作为可见的对话回退锚点。"""
        msg = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='state-only anchor',
            checkpoint_state_index=2,
        )

        resp = self._get(f'/api/chat/sessions/{self.session.id}/messages?limit=50')

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        msg_view = next(item for item in body['messages'] if item['id'] == str(msg.id))
        checkpoint_record = msg_view['checkpoint_record']
        self.assertEqual(checkpoint_record['status'], 'degraded')
        self.assertCountEqual(
            checkpoint_record['degraded_reasons'],
            ['missing_file_snapshot', 'missing_resource_snapshot'],
        )
        self.assertTrue(checkpoint_record['capability_scope']['message_preview'])
        self.assertFalse(checkpoint_record['capability_scope']['file_diff'])
        self.assertFalse(checkpoint_record['capability_scope']['file_restore'])
        self.assertFalse(checkpoint_record['capability_scope']['resource_restore'])
        self.assertTrue(checkpoint_record['capability_scope']['unrevert'])

    def test_get_messages_returns_conversation_rewind_anchor_without_checkpoint_metadata(self):
        """普通 AI 回复不应因为未改文件而丢失“回退到这里”入口。"""
        msg = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='plain answer without file changes',
        )

        resp = self._get(f'/api/chat/sessions/{self.session.id}/messages?limit=50')

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        msg_view = next(item for item in body['messages'] if item['id'] == str(msg.id))
        checkpoint_record = msg_view['checkpoint_record']
        self.assertEqual(checkpoint_record['status'], 'degraded')
        self.assertEqual(checkpoint_record['anchor_message_id'], str(msg.id))
        self.assertTrue(checkpoint_record['capability_scope']['message_preview'])
        self.assertFalse(checkpoint_record['capability_scope']['file_restore'])

    @patch(
        'apps.chat.conversation.api.rollback._request_runtime_timeline_rewind',
        return_value=_RuntimeRewindResult(applied=True, keep_message_count=1),
    )
    def test_execute_rollback_coordinates_runtime_before_projection(self, mock_runtime_rewind):
        """控制端必须先拿到 runtime rewind 确认，才会进入会话回退投影。"""
        ChatMessage.objects.create(session=self.session, role='user', text_summary='q1')
        target = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='answer to keep',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='later turn to remove',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {'target_message_id': str(target.id)},
        )

        self.assertEqual(resp.status_code, 200)
        mock_runtime_rewind.assert_called_once()
        self.assertTrue(self._payload(resp)['rollback_state']['revert_active'])
        self.session.refresh_from_db()
        self.assertEqual(self.session.revert_message_id, target.id)

    @patch(
        'apps.chat.conversation.api.rollback._request_runtime_timeline_rewind',
        return_value=_RuntimeRewindResult(applied=False, error='device offline'),
    )
    def test_execute_rollback_does_not_project_when_runtime_rewind_fails(self, mock_runtime_rewind):
        target = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='answer',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {'target_message_id': str(target.id)},
        )

        self.assertEqual(resp.status_code, 409)
        mock_runtime_rewind.assert_called_once()
        self.session.refresh_from_db()
        self.assertIsNone(self.session.revert_message_id)

    @patch(
        'apps.chat.conversation.api.rollback._request_runtime_timeline_rewind',
        return_value=_RuntimeRewindResult(applied=True, keep_message_count=0),
    )
    def test_edit_resend_v2_accepts_matching_preview_revision(self, mock_runtime_rewind):
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='answer',
            agent_run_id='00000000-0000-0000-0000-000000000301',
        )
        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        ))

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
            },
        )

        self.assertEqual(resp.status_code, 200)
        mock_runtime_rewind.assert_called_once()

        repeated = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
            },
        )
        self.assertEqual(repeated.status_code, 409)
        self.assertEqual(repeated.json()['code'], 'ROLLBACK_OPERATION_CONSUMED')
        mock_runtime_rewind.assert_called_once()

    def test_direct_electron_v2_file_restore_is_pending_until_exact_finalize(self):
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='edit files',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='changed files',
            agent_run_id='00000000-0000-0000-0000-000000000399',
        )
        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        ))

        rollback = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
                'defer_local_file_restore_finalize': True,
            },
        )

        self.assertEqual(rollback.status_code, 200, rollback.content)
        rollback_body = self._payload(rollback)
        self.assertTrue(rollback_body['file_restore_finalize_required'])
        self.assertEqual(rollback_body['file_restore_status'], 'pending')
        self.assertEqual(
            rollback_body['apply_result']['layers']['workspace_files']['status'],
            'pending',
        )
        apply_id = rollback_body['apply_result']['apply_id']

        finalize_payload = {
            'apply_id': apply_id,
            'rollback_contract_version': 2,
            'preview_revision': preview['preview_revision'],
            'file_preview_revision': preview['file_preview_revision'],
            'file_restore_status': 'success',
            'file_restore_reason': None,
            'failed_files': [],
            'unrestorable_files': [],
        }
        finalized = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/files/finalize',
            finalize_payload,
        )

        self.assertEqual(finalized.status_code, 200, finalized.content)
        finalized_body = self._payload(finalized)
        self.assertTrue(finalized_body['file_restore_success'])
        self.assertEqual(finalized_body['file_restore_status'], 'success')
        self.assertEqual(finalized_body['apply_result']['apply_id'], apply_id)
        self.assertEqual(
            finalized_body['apply_result']['layers']['workspace_files']['status'],
            'success',
        )

        # 完全相同的网络重试幂等成功；同一 apply 的不同结果不得覆盖审计。
        repeated = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/files/finalize',
            finalize_payload,
        )
        self.assertEqual(repeated.status_code, 200)
        conflict = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/files/finalize',
            {**finalize_payload, 'file_restore_status': 'failed', 'file_restore_reason': 'rewind_failed'},
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()['code'], 'FILE_RESTORE_FINALIZE_CONFLICT')

        self.session.refresh_from_db()
        history_entry = next(
            entry for entry in reversed(self.session.revert_history)
            if entry.get('apply_id') == apply_id
        )
        self.assertEqual(history_entry['file_restore_status'], 'success')
        self.assertFalse(history_entry['file_restore_finalize_required'])

    def test_file_restore_finalize_rejects_revision_mismatch_without_consuming_pending_apply(self):
        target = ChatMessage.objects.create(session=self.session, role='user', text_summary='edit files')
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='changed files',
            agent_run_id='00000000-0000-0000-0000-000000000398',
        )
        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        ))
        rollback = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
                'defer_local_file_restore_finalize': True,
            },
        ))
        apply_id = rollback['apply_result']['apply_id']

        stale = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/files/finalize',
            {
                'apply_id': apply_id,
                'rollback_contract_version': 2,
                'preview_revision': 'stale-preview',
                'file_preview_revision': preview['file_preview_revision'],
                'file_restore_status': 'success',
            },
        )

        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()['code'], 'ROLLBACK_PREVIEW_STALE')
        self.session.refresh_from_db()
        entry = next(item for item in self.session.revert_history if item.get('apply_id') == apply_id)
        self.assertEqual(entry['file_restore_status'], 'pending')
        self.assertTrue(entry['file_restore_finalize_required'])

    def test_pending_file_finalize_blocks_competing_timeline_operations(self):
        target = ChatMessage.objects.create(session=self.session, role='user', text_summary='edit files')
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='changed files',
            agent_run_id='00000000-0000-0000-0000-000000000397',
        )
        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        ))
        rollback = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
                'defer_local_file_restore_finalize': True,
            },
        ))
        self.assertTrue(rollback['file_restore_finalize_required'])

        unrevert = self._post(f'/api/chat/sessions/{self.session.id}/unrevert', {})
        resources = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/resources',
            {
                'items': [{
                    'resource_type': 'docs',
                    'resource_id': str(uuid4()),
                    'action': 'skip',
                }],
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
            },
        )
        second_rollback = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
            },
        )

        for response in (unrevert, resources, second_rollback):
            self.assertEqual(response.status_code, 409, response.content)
            self.assertEqual(response.json()['code'], 'FILE_RESTORE_FINALIZE_PENDING')

    def test_expired_file_finalize_rejects_old_host_and_keeps_timeline_frozen(self):
        target = ChatMessage.objects.create(session=self.session, role='user', text_summary='edit files')
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='changed files',
            agent_run_id='00000000-0000-0000-0000-000000000396',
        )
        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        ))
        rollback = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
                'defer_local_file_restore_finalize': True,
            },
        ))
        apply_id = rollback['apply_result']['apply_id']
        self.session.refresh_from_db()
        history = list(self.session.revert_history)
        for entry in history:
            if entry.get('apply_id') == apply_id:
                entry['file_restore_finalize_expires_at'] = (
                    timezone.now() - timedelta(seconds=1)
                ).isoformat()
        self.session.revert_history = history
        self.session.save(update_fields=['revert_history', 'updated_at'])

        stale_finalize = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/files/finalize',
            {
                'apply_id': apply_id,
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
                'file_restore_status': 'success',
            },
        )
        self.assertEqual(stale_finalize.status_code, 409, stale_finalize.content)
        self.assertEqual(stale_finalize.json()['code'], 'FILE_RESTORE_FINALIZE_EXPIRED')

        self.session.refresh_from_db()
        expired_entry = next(item for item in self.session.revert_history if item.get('apply_id') == apply_id)
        self.assertEqual(expired_entry['file_restore_status'], 'failed')
        self.assertEqual(expired_entry['file_restore_reason'], 'file_restore_result_unknown')
        self.assertEqual(expired_entry['failed_files'], [])
        self.assertTrue(expired_entry['file_restore_reconfirmation_required'])
        self.assertFalse(expired_entry['file_restore_finalize_required'])
        self.assertEqual(
            expired_entry['partial_success_details']['workspace_files']['reason'],
            'file_restore_result_unknown',
        )

        unrevert = self._post(f'/api/chat/sessions/{self.session.id}/unrevert', {})
        self.assertEqual(unrevert.status_code, 409, unrevert.content)
        self.assertEqual(unrevert.json()['code'], 'FILE_RESTORE_RESULT_UNKNOWN')

    def test_file_finalize_rejects_apply_that_is_no_longer_active_target(self):
        first_target = ChatMessage.objects.create(session=self.session, role='user', text_summary='first edit')
        second_target = ChatMessage.objects.create(session=self.session, role='user', text_summary='later target')
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='changed files',
            agent_run_id='00000000-0000-0000-0000-000000000395',
        )
        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(first_target.id)},
        ))
        rollback = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {
                'target_message_id': str(first_target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
                'defer_local_file_restore_finalize': True,
            },
        ))
        self.session.refresh_from_db()
        self.session.revert_message_id = second_target.id
        self.session.save(update_fields=['revert_message_id', 'updated_at'])

        stale = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/files/finalize',
            {
                'apply_id': rollback['apply_result']['apply_id'],
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
                'file_restore_status': 'success',
            },
        )
        self.assertEqual(stale.status_code, 409, stale.content)
        self.assertEqual(stale.json()['code'], 'ROLLBACK_OPERATION_STALE')

    @patch('apps.chat.conversation.api.rollback._request_runtime_timeline_rewind')
    def test_edit_resend_v2_rejects_stale_preview_before_runtime(self, mock_runtime_rewind):
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='answer',
            agent_run_id='00000000-0000-0000-0000-000000000302',
        )
        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        ))
        ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='new collaborator message after confirmation',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
            },
        )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['code'], 'ROLLBACK_PREVIEW_STALE')
        mock_runtime_rewind.assert_not_called()

    @patch('apps.chat.conversation.api.rollback._request_runtime_timeline_rewind')
    def test_edit_resend_v2_requires_preview_revision(self, mock_runtime_rewind):
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
            },
        )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['code'], 'ROLLBACK_PREVIEW_REQUIRED')
        mock_runtime_rewind.assert_not_called()

    @patch('apps.chat.conversation.api.rollback._request_runtime_timeline_rewind')
    @patch('apps.chat.conversation.api.rollback._resolve_file_preview_for_client')
    def test_edit_resend_v2_requires_explicit_ack_for_known_file_gap(
        self,
        mock_file_preview,
        mock_runtime_rewind,
    ):
        """稳定的文件版本缺口可以选择仅重写对话，但服务端必须看到显式授权。"""
        mock_file_preview.return_value = SimpleNamespace(
            host='local',
            status='unavailable',
            affected_paths=(),
            reason='no_file_history',
            revision='v2:file-gap',
            unrestorable_files=(),
            device_fingerprint='device-1',
            success=False,
        )
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='answer',
            agent_run_id='00000000-0000-0000-0000-000000000303',
        )
        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        ))

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
            },
        )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['code'], 'FILE_PREVIEW_ACK_REQUIRED')
        mock_runtime_rewind.assert_not_called()

    @patch(
        'apps.chat.conversation.api.rollback._request_runtime_timeline_rewind',
        return_value=_RuntimeRewindResult(
            applied=True,
            keep_message_count=0,
            file_restore_coordinated=True,
            file_restore_success=False,
            file_restore_status='unavailable',
            file_restore_reason='no_file_history',
        ),
    )
    @patch('apps.chat.conversation.api.rollback._resolve_file_preview_for_client')
    def test_edit_resend_v2_accepts_matching_file_gap_ack(
        self,
        mock_file_preview,
        mock_runtime_rewind,
    ):
        mock_file_preview.return_value = SimpleNamespace(
            host='local',
            status='unavailable',
            affected_paths=(),
            reason='no_file_history',
            revision='v2:file-gap',
            unrestorable_files=(),
            device_fingerprint='device-1',
            success=False,
        )
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='answer',
            agent_run_id='00000000-0000-0000-0000-000000000304',
        )
        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        ))

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
                'acknowledged_file_preview_reason': 'no_file_history',
            },
        )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._payload(resp)['file_restore_reason'], 'no_file_history')
        mock_runtime_rewind.assert_called_once()

    @patch('apps.chat.conversation.api.rollback._request_runtime_timeline_rewind')
    def test_v2_resource_restore_rejects_collaborator_edit_after_preview(
        self,
        mock_runtime_rewind,
    ):
        """预览后资源当前版本变化时，旧 revision 必须在任何恢复副作用前失效。"""
        from apps.collab.models import ChangeLog, VersionHistory

        resource_db = postgres_app_db_alias()
        resource_id = uuid4()
        run_id = str(uuid4())
        base_time = timezone.now() - timedelta(minutes=5)
        pre_vh = VersionHistory.objects.using(resource_db).create(
            resource_type='docs',
            resource_id=resource_id,
            blob=b'pre',
            blob_size=3,
            is_snapshot=True,
            created_at=base_time,
        )
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='edit this document',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='document updated',
            agent_run_id=run_id,
        )
        post_vh = VersionHistory.objects.using(resource_db).create(
            resource_type='docs',
            resource_id=resource_id,
            blob=b'post',
            blob_size=4,
            is_snapshot=True,
            created_at=base_time + timedelta(minutes=1),
        )
        ChangeLog.objects.using(resource_db).create(
            resource_type='docs',
            resource_id=resource_id,
            change_type='update',
            summary='agent update',
            agent_run_id=run_id,
            version_history=post_vh,
            created_at=base_time + timedelta(minutes=1),
        )

        preview = self._payload(self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(target.id)},
        ))
        plan = preview['resource_restore_plan']
        self.assertTrue(plan, preview)
        self.assertEqual(plan[0]['restore_to_version_id'], str(pre_vh.id))
        self.assertTrue(plan[0]['expected_current_state_revision'])

        # 首次 revision 校验后、Electron runtime 已截 transcript/文件时资源版本变化。
        # nested rollback_session 必须复用副作用前冻结的预览，不能二次重算后 409；
        # 资源端点随后仍用自己的 CAS 阻断恢复与自动发送。
        def runtime_rewind_then_collaborator_edit(*_args, **_kwargs):
            VersionHistory.objects.using(resource_db).create(
                resource_type='docs',
                resource_id=resource_id,
                blob=b'collaborator-during-runtime',
                blob_size=27,
                is_snapshot=True,
                editor_type='user',
                created_at=timezone.now(),
            )
            return _RuntimeRewindResult(applied=True, keep_message_count=0)

        mock_runtime_rewind.side_effect = runtime_rewind_then_collaborator_edit

        execute = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
                'rollback_contract_version': 2,
                'preview_revision': preview['preview_revision'],
                'file_preview_revision': preview['file_preview_revision'],
            },
        )
        self.assertEqual(execute.status_code, 200)
        mock_runtime_rewind.assert_called_once()

        with patch('apps.collab.service.VersionHistoryService.restore_to_version') as mock_restore:
            restore = self._post(
                f'/api/chat/sessions/{self.session.id}/rollback/resources',
                {
                    'rollback_contract_version': 2,
                    'preview_revision': preview['preview_revision'],
                    'items': [{
                        'resource_type': 'docs',
                        'resource_id': str(resource_id),
                        'action': plan[0]['action'],
                        'restore_to_version_id': plan[0]['restore_to_version_id'],
                    }],
                },
            )

        self.assertEqual(restore.status_code, 409)
        self.assertEqual(restore.json()['code'], 'ROLLBACK_PREVIEW_STALE')
        mock_restore.assert_not_called()

    def test_runtime_rewind_result_requires_new_electron_file_confirmation_for_file_anchor(self):
        """旧 Electron 只回 applied 不能再让带文件锚点的移动端回退假成功。"""
        parsed = _parse_runtime_rewind_result(
            {'success': True, 'data': {'applied': True, 'keep_message_count': 2}},
            has_electron_file_anchor=True,
            strict_file_confirmation=True,
        )

        self.assertFalse(parsed.applied)
        self.assertIn('文件回退', parsed.error or '')

    def test_legacy_runtime_rewind_keeps_conversation_but_marks_files_unavailable(self):
        """v1 旧桌面端可继续对话回退，但不得把未返回的文件结果伪装成成功。"""
        parsed = _parse_runtime_rewind_result(
            {'success': True, 'data': {'applied': True, 'keep_message_count': 2}},
            has_electron_file_anchor=True,
            strict_file_confirmation=False,
        )

        self.assertTrue(parsed.applied)
        self.assertTrue(parsed.file_restore_coordinated)
        self.assertFalse(parsed.file_restore_success)
        self.assertEqual(parsed.file_restore_status, 'unavailable')
        self.assertEqual(parsed.file_restore_reason, 'desktop_upgrade_required')

    @patch(
        'apps.chat.conversation.api.rollback._request_runtime_timeline_rewind',
        return_value=_RuntimeRewindResult(
            applied=True,
            keep_message_count=1,
            file_restore_coordinated=True,
            file_restore_success=False,
            file_restore_failed_file_count=1,
        ),
    )
    def test_execute_rollback_projects_confirmed_electron_file_partial_result(self, mock_runtime_rewind):
        """移动端→Electron 的文件回退失败必须落为 partial，而非 local 宿主默认成功。"""
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='please change the tracked file',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='file changed',
            agent_run_id='run-with-file-change',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='later turn to make rollback non-noop',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {'target_message_id': str(target.id)},
        )

        self.assertEqual(resp.status_code, 200)
        mock_runtime_rewind.assert_called_once()
        body = self._payload(resp)
        self.assertFalse(body['file_restore_success'])
        self.assertEqual(body['file_restore_host'], 'local')
        self.assertEqual(body['overall_status'], 'partial_success')
        self.assertEqual(
            body['rollback_state']['partial_success_details']['workspace_files']['reason'],
            'control_device_file_restore_failed',
        )
        self.assertEqual(
            body['rollback_state']['partial_success_details']['workspace_files']['status'],
            'failed',
        )
        self.assertFalse(
            body['rollback_state']['partial_success_details']['workspace_files']['success'],
        )
        self.assertEqual(
            body['apply_result']['layers']['workspace_files']['reason'],
            'control_device_file_restore_failed',
        )

    @patch(
        'apps.chat.conversation.api.rollback._request_runtime_timeline_rewind',
        return_value=_RuntimeRewindResult(
            applied=True,
            keep_message_count=0,
            file_restore_coordinated=True,
            file_restore_success=False,
            file_restore_status='unavailable',
            file_restore_reason='no_file_history',
        ),
    )
    def test_edit_resend_without_file_history_is_partial_and_has_no_rollback_notice(
        self,
        mock_runtime_rewind,
    ):
        """缺少文件账本应诚实返回 partial，但 editAndResend 不插入长期普通通知。"""
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original question',
        )
        ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='original answer',
            agent_run_id='00000000-0000-0000-0000-000000000101',
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/execute',
            {
                'target_message_id': str(target.id),
                'mode': 'editAndResend',
            },
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertFalse(body['file_restore_success'])
        self.assertEqual(body['file_restore_status'], 'unavailable')
        self.assertEqual(body['file_restore_reason'], 'no_file_history')
        self.assertEqual(body['mode'], 'editAndResend')
        self.assertEqual(body['overall_status'], 'partial_success')
        self.assertEqual(
            body['rollback_state']['partial_success_details']['workspace_files']['reason'],
            'no_file_history',
        )
        self.assertEqual(
            body['rollback_state']['last_operation_mode'],
            'editAndResend',
        )
        self.assertFalse(
            self.session.messages.filter(role='system', text_summary__startswith='回退完成').exists(),
        )
        mock_runtime_rewind.assert_called_once_with(
            self.session,
            target,
            mode='editAndResend',
            contract_version=1,
            expected_file_preview_revision=None,
        )

    def test_no_impact_preview_does_not_enter_revert_active(self):
        """preview no_impact must stay consistent with apply and not create a soft-revert state."""
        ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='q1',
        )
        msg_a1 = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='latest answer without checkpoint',
        )

        preview_resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/preview',
            {'target_message_id': str(msg_a1.id)},
        )

        self.assertEqual(preview_resp.status_code, 200)
        preview_body = self._payload(preview_resp)
        self.assertTrue(preview_body['no_impact'])
        self.assertEqual(preview_body['impact']['messages']['to_remove'], 0)
        self.assertFalse(preview_body['impact']['files']['available'])
        self.assertFalse(preview_body['impact']['resources']['available'])

        apply_resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(msg_a1.id)},
        )

        self.assertEqual(apply_resp.status_code, 200)
        apply_body = self._payload(apply_resp)
        self.assertEqual(apply_body.get('overall_status'), 'success')
        self.assertEqual(apply_body['truncated_message_count'], 0)
        self.assertIn('无需进入回退态', apply_body['message'])
        self.assertIsInstance(apply_body.get('rollback_state'), dict)
        self.assertFalse(apply_body['rollback_state']['revert_active'])
        self.assertEqual(apply_body['rollback_state']['cleanup_status'], 'not_started')
        self.assertFalse(apply_body['rollback_state']['can_unrevert'])
        self.assertIsInstance(apply_body.get('apply_result'), dict)
        self.assertFalse(apply_body['apply_result']['session_state']['revert_active'])
        self.assertEqual(apply_body['apply_result']['session_state']['cleanup_status'], 'not_started')

        self.session.refresh_from_db()
        self.assertIsNone(self.session.revert_message_id)
        self.assertIsNone(self.session.revert_snapshot_hash)
        self.assertFalse(self.session.revert_history)

    def test_pending_retry_cleanup_state_and_partial_success_apply_result(self):
        """pending_retry and partial_success are preserved in aggregated rollback views."""
        self.session.revert_state_index = 7
        self.session.revert_history = [{
            'type': 'rollback',
            'apply_result': 'partial_success',
            'partial_success_details': {
                'workspace_files': {'reason': 'daemon_restore_failed'},
            },
        }]
        self.session.save(update_fields=['revert_state_index', 'revert_history'])

        rollback_state = _build_session_rollback_state(self.session)
        self.assertEqual(rollback_state.cleanup_status, 'pending_retry')
        self.assertEqual(rollback_state.last_apply_result, 'partial_success')
        self.assertIsNotNone(rollback_state.partial_success_details)
        self.assertEqual(
            rollback_state.partial_success_details.workspace_files.reason,
            'daemon_restore_failed',
        )

        apply_result = _build_rollback_apply_result(
            apply_id='rollback:test',
            session=self.session,
            overall_status='partial_success',
            file_restore_success=False,
            restored_count=1,
            failed_count=1,
            retryable_items=[{'resource_type': 'doc', 'resource_id': '1'}],
            collab_sync_warnings=[{'resource': 'doc:1', 'warning': 'force_close_failed'}],
        )
        self.assertEqual(apply_result.session_state.cleanup_status, 'pending_retry')
        self.assertEqual(apply_result.layers.workspace_files.status, 'failed')
        self.assertEqual(apply_result.layers.workspace_files.reason, 'daemon_restore_failed')
        self.assertEqual(apply_result.layers.resources.status, 'partial_success')
        self.assertEqual(apply_result.layers.pg_state.status, 'failed')
        self.assertEqual(apply_result.layers.pg_state.reason, 'cleanup_pending_retry')

    def test_merge_rollback_apply_state_preserves_previous_file_failure(self):
        """resource rollback success must not overwrite prior workspace file failure."""
        merged_status, merged_details, file_restore_success = _merge_rollback_apply_state(
            previous_apply_result='partial_success',
            previous_partial_success_details={
                'workspace_files': {'reason': 'daemon_restore_failed'},
            },
            current_apply_result='success',
            current_partial_success_details=None,
        )

        self.assertEqual(merged_status, 'partial_success')
        self.assertFalse(file_restore_success)
        self.assertEqual(
            merged_details,
            {'workspace_files': {'reason': 'daemon_restore_failed'}},
        )

    @patch('apps.chat.conversation.api.rollback._compute_rollback_preview')
    def test_v2_resource_restore_rejects_plan_drift(self, mock_preview):
        """v2 不允许客户端把预览中的目标版本替换成任意版本。"""
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original',
        )
        self.session.revert_message_id = target.id
        self.session.revert_history = [{
            'type': 'rollback',
            'mode': 'editAndResend',
            'target_message_id': str(target.id),
            'rollback_contract_version': 2,
            'preview_revision': 'v1:confirmed',
            'resource_restore_status': 'pending',
        }]
        self.session.save(update_fields=['revert_message_id', 'revert_history', 'updated_at'])
        resource_id = str(uuid4())
        expected_version = str(uuid4())
        mock_preview.return_value = SimpleNamespace(
            preview_revision='v1:confirmed',
            resource_preview_status='available',
            resource_restore_plan=[{
                'resource_type': 'docs',
                'resource_id': resource_id,
                'action': 'restore_version',
                'can_restore': True,
                'restore_to_version_id': expected_version,
            }],
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/resources',
            {
                'rollback_contract_version': 2,
                'preview_revision': 'v1:confirmed',
                'items': [{
                    'resource_type': 'docs',
                    'resource_id': resource_id,
                    'action': 'restore_version',
                    'restore_to_version_id': str(uuid4()),
                }],
            },
        )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['code'], 'RESOURCE_RESTORE_PLAN_STALE')

    @patch('apps.chat.conversation.api.rollback._compute_rollback_preview')
    def test_v2_resource_restore_requires_explicit_decision_for_every_plan_item(
        self,
        mock_preview,
    ):
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original',
        )
        self.session.revert_message_id = target.id
        self.session.revert_history = [{
            'type': 'rollback',
            'mode': 'editAndResend',
            'target_message_id': str(target.id),
            'rollback_contract_version': 2,
            'preview_revision': 'v1:confirmed',
            'resource_restore_status': 'pending',
        }]
        self.session.save(update_fields=['revert_message_id', 'revert_history', 'updated_at'])
        resource_ids = [str(uuid4()), str(uuid4())]
        mock_preview.return_value = SimpleNamespace(
            preview_revision='v1:confirmed',
            resource_preview_status='available',
            resource_restore_plan=[
                {
                    'resource_type': 'docs',
                    'resource_id': resource_id,
                    'action': 'no_version',
                    'can_restore': False,
                    'restore_to_version_id': None,
                }
                for resource_id in resource_ids
            ],
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/resources',
            {
                'rollback_contract_version': 2,
                'preview_revision': 'v1:confirmed',
                'items': [{
                    'resource_type': 'docs',
                    'resource_id': resource_ids[0],
                    'action': 'skip',
                }],
            },
        )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['code'], 'RESOURCE_RESTORE_PLAN_INCOMPLETE')

    @patch('apps.chat.conversation.api.rollback._compute_rollback_preview')
    def test_v2_resource_restore_accepts_explicit_skip_without_side_effect(
        self,
        mock_preview,
    ):
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original',
        )
        self.session.revert_message_id = target.id
        self.session.revert_history = [{
            'type': 'rollback',
            'mode': 'editAndResend',
            'target_message_id': str(target.id),
            'rollback_contract_version': 2,
            'preview_revision': 'v1:confirmed',
            'resource_restore_status': 'pending',
        }]
        self.session.save(update_fields=['revert_message_id', 'revert_history', 'updated_at'])
        resource_id = str(uuid4())
        mock_preview.return_value = SimpleNamespace(
            preview_revision='v1:confirmed',
            resource_preview_status='available',
            resource_restore_plan=[{
                'resource_type': 'docs',
                'resource_id': resource_id,
                'action': 'no_version',
                'can_restore': False,
                'restore_to_version_id': None,
            }],
        )

        with patch('apps.chat.conversation.api.rollback._trash_resource') as mock_trash, patch(
            'apps.collab.service.VersionHistoryService.restore_to_version',
        ) as mock_restore:
            resp = self._post(
                f'/api/chat/sessions/{self.session.id}/rollback/resources',
                {
                    'rollback_contract_version': 2,
                    'preview_revision': 'v1:confirmed',
                    'items': [{
                        'resource_type': 'docs',
                        'resource_id': resource_id,
                        'action': 'skip',
                    }],
                },
            )

        self.assertEqual(resp.status_code, 200)
        self.assertTrue(self._payload(resp)['success'])
        mock_trash.assert_not_called()
        mock_restore.assert_not_called()

    @patch('apps.chat.conversation.api.rollback._trash_resource', return_value=True)
    @patch('apps.chat.conversation.api.rollback._get_allowed_rollback_resources')
    @patch('apps.chat.conversation.api.rollback._compute_rollback_preview')
    def test_v2_resource_restore_accepts_exact_preview_plan(
        self,
        mock_preview,
        mock_allowed,
        _mock_trash,
    ):
        """v2 仅执行覆盖全集且 action/version 与预览完全一致的资源计划。"""
        target = ChatMessage.objects.create(
            session=self.session,
            role='user',
            text_summary='original',
        )
        self.session.revert_message_id = target.id
        self.session.revert_history = [{
            'type': 'rollback',
            'mode': 'editAndResend',
            'target_message_id': str(target.id),
            'rollback_contract_version': 2,
            'preview_revision': 'v1:confirmed',
            'resource_restore_status': 'pending',
        }]
        self.session.save(update_fields=['revert_message_id', 'revert_history', 'updated_at'])
        resource_id = str(uuid4())
        mock_preview.return_value = SimpleNamespace(
            preview_revision='v1:confirmed',
            resource_preview_status='available',
            resource_restore_plan=[{
                'resource_type': 'docs',
                'resource_id': resource_id,
                'action': 'trash',
                'can_restore': True,
                'restore_to_version_id': None,
            }],
        )
        mock_allowed.return_value = {('docs', resource_id)}

        with patch('apps.collab.registry.get_adapter', return_value=None), patch(
            'apps.collab.api._force_close_collab_document',
            return_value={'success': True, 'loaded': False, 'connections_closed': 0},
        ):
            resp = self._post(
                f'/api/chat/sessions/{self.session.id}/rollback/resources',
                {
                    'rollback_contract_version': 2,
                    'preview_revision': 'v1:confirmed',
                    'items': [{
                        'resource_type': 'docs',
                        'resource_id': resource_id,
                        'action': 'trash',
                    }],
                },
            )

        self.assertEqual(resp.status_code, 200)
        self.assertTrue(self._payload(resp)['success'])

        repeated = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/resources',
            {
                'rollback_contract_version': 2,
                'preview_revision': 'v1:confirmed',
                'items': [{
                    'resource_type': 'docs',
                    'resource_id': resource_id,
                    'action': 'trash',
                }],
            },
        )
        self.assertEqual(repeated.status_code, 409)
        self.assertEqual(repeated.json()['code'], 'ROLLBACK_OPERATION_CONSUMED')

    def test_rollback_resources_returns_partial_success_apply_result(self):
        """resource rollback returns envelope-aligned partial_success payload."""
        msg_a1 = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='a1',
            checkpoint_hash='hash_a1',
        )
        self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(msg_a1.id)},
        )

        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/rollback/resources',
            {
                'items': [
                    {
                        'resource_type': 'docs',
                        'resource_id': 'doc-1',
                        'action': 'trash',
                    },
                ],
            },
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertFalse(body['success'])
        self.assertEqual(body['overall_status'], 'partial_success')
        self.assertEqual(body['failed_count'], 1)
        self.assertIsInstance(body.get('rollback_state'), dict)
        self.assertTrue(body['rollback_state']['revert_active'])
        self.assertIsInstance(body.get('apply_result'), dict)
        self.assertEqual(body['apply_result']['overall_status'], 'partial_success')
        self.assertEqual(body['apply_result']['layers']['resources']['status'], 'partial_success')
        self.assertEqual(body['apply_result']['layers']['resources']['failed_count'], 1)
        self.assertEqual(
            body['partial_success_details']['resources']['retryable'],
            [{
                'resource_type': 'docs',
                'resource_id': 'doc-1',
                'action': 'trash',
                'restore_to_version_id': None,
            }],
        )
        self.assertEqual(body['results'][0]['error'], '资源不在本次回退范围内')

        history_resp = self._get(f'/api/chat/sessions/{self.session.id}/revert-history')
        history_body = self._payload(history_resp)
        self.assertEqual(history_body['history'][-1]['type'], 'resource_rollback')
        self.assertEqual(history_body['history'][-1]['apply_result'], 'partial_success')
        self.assertEqual(
            history_body['history'][-1]['partial_success_details']['resources']['retryable'],
            [{
                'resource_type': 'docs',
                'resource_id': 'doc-1',
                'action': 'trash',
                'restore_to_version_id': None,
            }],
        )

    @override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
    def test_revert_history_skips_cleanup_entries(self):
        """#2101: cleanup 内部状态条目不得让 revert-history 接口校验崩溃。

        revert_history 混写了系统消息清理状态（type=cleanup），而展示接口只认
        rollback / resource_rollback / unrevert。回归保证 cleanup 条目被过滤、
        接口返回 200 而非 500，且只返回用户回退操作条目并保持顺序。
        """
        self.session.revert_history = [
            {
                'type': 'rollback',
                'target_message_id': 'msg-1',
                'apply_result': 'success',
                'created_at': '2026-06-30T00:00:00+00:00',
            },
            {
                'type': 'cleanup',
                'cleanup_status': 'done',
                'deleted_count': 3,
                'created_at': '2026-06-30T00:01:00+00:00',
            },
            {
                'type': 'cleanup',
                'cleanup_status': 'failed',
                'reason': 'pg truncation failed',
                'created_at': '2026-06-30T00:02:00+00:00',
            },
            {
                'type': 'unrevert',
                'apply_result': 'success',
                'created_at': '2026-06-30T00:03:00+00:00',
            },
        ]
        self.session.save(update_fields=['revert_history'])

        resp = self._get(f'/api/chat/sessions/{self.session.id}/revert-history')
        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        types = [entry['type'] for entry in body['history']]
        self.assertEqual(types, ['rollback', 'unrevert'])

    @override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
    def test_revert_history_all_cleanup_returns_empty(self):
        """#2101: 仅含 cleanup 条目的会话返回空列表而非报错。"""
        self.session.revert_history = [
            {
                'type': 'cleanup',
                'cleanup_status': 'done',
                'deleted_count': 1,
                'created_at': '2026-06-30T00:00:00+00:00',
            },
        ]
        self.session.save(update_fields=['revert_history'])

        resp = self._get(f'/api/chat/sessions/{self.session.id}/revert-history')
        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['history'], [])

    def test_rollback_resources_force_closes_after_version_restore(self):
        """restore_version rollback must notify collab clients to reload restored snapshots."""
        from unittest.mock import MagicMock

        resource_id = str(uuid4())
        version_id = str(uuid4())
        baseline_id = uuid4()
        msg_a1 = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='a1',
            checkpoint_hash='hash_a1',
        )
        self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(msg_a1.id)},
        )

        resource = MagicMock()
        resource.id = resource_id
        resource.organization_id = uuid4()
        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = resource
        mock_adapter.check_permission.return_value = True
        mock_adapter.get_version_data.return_value = {'format': 'json_snapshot', 'title': 'rollback before title'}
        baseline_vh = MagicMock()
        baseline_vh.id = baseline_id
        mock_svc = MagicMock()
        mock_svc.create_history.return_value = baseline_vh
        mock_svc.restore_to_version.return_value = MagicMock()

        with patch(
            'apps.chat.conversation.api.rollback._get_allowed_rollback_resources',
            return_value={('docs', resource_id)},
        ), patch(
            'apps.collab.registry.get_adapter',
            return_value=mock_adapter,
        ), patch(
            'apps.collab.service.VersionHistoryService',
            return_value=mock_svc,
        ), patch(
            'apps.collab.api._force_close_collab_document',
            return_value={'success': True, 'loaded': True, 'connections_closed': 1},
        ) as mock_force_close:
            resp = self._post(
                f'/api/chat/sessions/{self.session.id}/rollback/resources',
                {
                    'items': [
                        {
                            'resource_type': 'docs',
                            'resource_id': resource_id,
                            'action': 'restore_version',
                            'restore_to_version_id': version_id,
                        },
                    ],
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertTrue(body['success'])
        self.assertEqual(body['restored_count'], 1)
        mock_force_close.assert_called_once_with(
            'docs',
            resource_id,
            reason='document_restored',
        )

    def test_rollback_resources_records_instant_unrevert_baseline(self):
        """TD-16: revert_resource_state must point at the just-created baseline VH."""
        from unittest.mock import MagicMock

        resource_uuid = uuid4()
        resource_id = str(resource_uuid)
        rollback_target_vh_id = str(uuid4())
        baseline_vh_id = uuid4()
        msg_a1 = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='a1',
            checkpoint_hash='hash_a1',
        )
        self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(msg_a1.id)},
        )

        resource = MagicMock()
        resource.id = resource_uuid
        resource.organization_id = uuid4()
        baseline_snapshot = {
            'format': 'json_snapshot',
            'title': '回退前标题',
            'description_markdown': '# 回退前正文',
        }
        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = resource
        mock_adapter.check_permission.return_value = True
        mock_adapter.get_version_data.return_value = baseline_snapshot
        baseline_vh = MagicMock()
        baseline_vh.id = baseline_vh_id
        mock_svc = MagicMock()
        mock_svc.create_history.return_value = baseline_vh
        mock_svc.restore_to_version.return_value = MagicMock()

        with patch(
            'apps.chat.conversation.api.rollback._get_allowed_rollback_resources',
            return_value={('docs', resource_id)},
        ), patch(
            'apps.collab.registry.get_adapter',
            return_value=mock_adapter,
        ), patch(
            'apps.collab.service.VersionHistoryService',
            return_value=mock_svc,
        ), patch(
            'apps.collab.api._force_close_collab_document',
            return_value={'success': True, 'loaded': True, 'connections_closed': 1},
        ):
            resp = self._post(
                f'/api/chat/sessions/{self.session.id}/rollback/resources',
                {
                    'items': [
                        {
                            'resource_type': 'docs',
                            'resource_id': resource_id,
                            'action': 'restore_version',
                            'restore_to_version_id': rollback_target_vh_id,
                        },
                    ],
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertTrue(body['success'])
        mock_svc.create_history.assert_called_once()
        self.assertEqual(mock_svc.create_history.call_args.kwargs['data'], baseline_snapshot)
        self.assertTrue(mock_svc.create_history.call_args.kwargs['force_snapshot'])
        self.assertTrue(mock_svc.create_history.call_args.kwargs['skip_throttle'])
        self.assertEqual(mock_svc.create_history.call_args.kwargs['organization_id'], resource.organization_id)

        self.session.refresh_from_db()
        self.assertEqual(self.session.revert_resource_state, [{
            'resource_type': 'docs',
            'resource_id': resource_id,
            'action': 'restore_version',
            'restore_to_version_id': rollback_target_vh_id,
            'pre_version_id': str(baseline_vh_id),
            'success': True,
        }])
        history_entry = self.session.revert_history[-1]
        self.assertEqual(history_entry['type'], 'resource_rollback')
        self.assertEqual(history_entry['reapply_resource_items'], [{
            'resource_type': 'docs',
            'resource_id': resource_id,
            'action': 'restore_version',
            'restore_to_version_id': rollback_target_vh_id,
        }])

    def test_restore_plan_uses_version_history_time_before_changelog(self):
        """ChangeLog points at the post-change VH; rollback must pick the prior VH."""
        from apps.collab.models import ChangeLog, VersionHistory

        resource_db = postgres_app_db_alias()
        resource_id = uuid4()
        run_id = 'run-http-400'
        t0 = timezone.now() - timedelta(seconds=4)
        t1 = t0 + timedelta(seconds=1)
        t2 = timezone.now() - timedelta(seconds=2)
        t3 = timezone.now() - timedelta(seconds=1)

        pre_vh = VersionHistory.objects.using(resource_db).create(
            resource_type='docs',
            resource_id=resource_id,
            blob=b'pre',
            blob_size=3,
            is_snapshot=True,
            editor_type='user',
            created_at=t0,
        )
        post_vh = VersionHistory.objects.using(resource_db).create(
            resource_type='docs',
            resource_id=resource_id,
            blob=b'post',
            blob_size=4,
            is_snapshot=True,
            editor_type='agent',
            created_at=t1,
        )
        ChangeLog.objects.using(resource_db).create(
            resource_type='docs',
            resource_id=resource_id,
            change_type='update',
            summary='无版本记录的同轮变更',
            agent_run_id=run_id,
            created_at=t0 - timedelta(seconds=1),
        )
        ChangeLog.objects.using(resource_db).create(
            resource_type='docs',
            resource_id=resource_id,
            change_type='update',
            summary='内容更新',
            agent_run_id=run_id,
            version_history=post_vh,
            created_at=t2,
        )
        ChangeLog.objects.using(resource_db).create(
            resource_type='docs',
            resource_id=resource_id,
            change_type='update',
            summary='后续无版本记录的同轮变更',
            agent_run_id=run_id,
            created_at=t3,
        )

        plan = _compute_restore_plan(
            [{
                'resource_type': 'docs',
                'resource_id': str(resource_id),
                'change_type': 'update',
                'summary': '内容更新',
                'agent_run_id': run_id,
            }],
            {('docs', str(resource_id)): 'GH400 doc'},
        )

        self.assertEqual(plan[0]['action'], 'restore_version')
        self.assertTrue(plan[0]['can_restore'])
        self.assertEqual(plan[0]['restore_to_version_id'], str(pre_vh.id))
        self.assertNotEqual(plan[0]['restore_to_version_id'], str(post_vh.id))

    # ── H8: rollback_resources 协作者通知 ──

    def test_rollback_resources_publishes_notice_on_success(self):
        """rollback_resources 成功恢复资源后通过 WS 推送系统通知。"""
        from unittest.mock import MagicMock

        test_rid = str(uuid4())
        msg_a1 = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='a1',
            checkpoint_hash='hash_a1',
        )
        self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(msg_a1.id)},
        )

        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = None

        with patch(
            'apps.chat.conversation.api.rollback._get_allowed_rollback_resources',
            return_value={('docs', test_rid)},
        ), patch(
            'apps.chat.conversation.api.rollback._trash_resource',
            return_value=True,
        ), patch(
            'apps.collab.registry.get_adapter',
            return_value=mock_adapter,
        ), patch(
            'apps.collab.api._force_close_collab_document',
            return_value={'success': True, 'loaded': True, 'connections_closed': 1},
        ), patch(
            'apps.chat.conversation.api.rollback._resolve_resource_names',
            return_value={},
        ), patch(
            'apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_system_notice',
        ) as mock_notice:
            resp = self._post(
                f'/api/chat/sessions/{self.session.id}/rollback/resources',
                {
                    'items': [
                        {
                            'resource_type': 'docs',
                            'resource_id': test_rid,
                            'action': 'trash',
                        },
                    ],
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertTrue(body['success'])
        self.assertEqual(body['restored_count'], 1)
        mock_notice.assert_called_once()
        notice_text = mock_notice.call_args[0][1]
        self.assertIn('回退', notice_text)
        self.assertIn('回收站', notice_text)

    def test_rollback_resources_no_notice_when_nothing_restored(self):
        """rollback_resources 无成功恢复时不发送通知。"""
        msg_a1 = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='a1',
            checkpoint_hash='hash_a1',
        )
        self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {'target_message_id': str(msg_a1.id)},
        )

        with patch(
            'apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_system_notice',
        ) as mock_notice:
            resp = self._post(
                f'/api/chat/sessions/{self.session.id}/rollback/resources',
                {
                    'items': [
                        {
                            'resource_type': 'docs',
                            'resource_id': 'doc-notfound',
                            'action': 'trash',
                        },
                    ],
                },
            )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['restored_count'], 0)
        mock_notice.assert_not_called()

    # ── POST /sessions/{id}/unrevert ──

    def test_unrevert_clears_revert_state(self):
        """Unrevert clears all revert fields and returns snapshot_hash."""
        msg_a1 = ChatMessage.objects.create(
            session=self.session, role='assistant', text_summary='a1',
            checkpoint_hash='hash_a1',
        )
        ChatMessage.objects.create(
            session=self.session, role='user', text_summary='q2',
        )

        # First rollback
        self._post(
            f'/api/chat/sessions/{self.session.id}/rollback',
            {
                'target_message_id': str(msg_a1.id),
                'safety_snapshot_hash': 'safety_xyz',
            },
        )

        # Then unrevert
        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/unrevert',
            {},
        )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        self.assertEqual(body['snapshot_hash'], 'safety_xyz')
        self.assertEqual(body.get('overall_status'), 'success')
        self.assertIsInstance(body.get('rollback_state'), dict)
        self.assertFalse(body['rollback_state']['revert_active'])
        self.assertEqual(body['rollback_state']['cleanup_status'], 'done')
        self.assertFalse(body['rollback_state']['can_unrevert'])
        self.assertIsInstance(body.get('apply_result'), dict)
        self.assertEqual(body['apply_result']['overall_status'], 'success')
        self.assertEqual(body['apply_result']['session_state']['cleanup_status'], 'done')

        self.session.refresh_from_db()
        self.assertIsNone(self.session.revert_message_id)
        self.assertIsNone(self.session.revert_snapshot_hash)

        # All messages visible again (a1 + q2 + system_rollback + system_unrevert)
        resp = self._get(f'/api/chat/sessions/{self.session.id}/messages?limit=50')
        visible_ids = [m['id'] for m in self._payload(resp)['messages']]
        self.assertEqual(len(visible_ids), 4)

    def test_unrevert_returns_reapply_resource_items(self):
        """TD-16: unrevert keeps the resource plan needed to rollback the same change again."""
        msg_a1 = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='a1',
            checkpoint_hash='hash_a1',
        )
        rollback_target_vh_id = str(uuid4())
        baseline_vh_id = str(uuid4())
        self.session.revert_message_id = msg_a1.id
        self.session.revert_snapshot_hash = 'safety_xyz'
        self.session.revert_resource_state = [{
            'resource_type': 'docs',
            'resource_id': 'doc-1',
            'action': 'restore_version',
            'restore_to_version_id': rollback_target_vh_id,
            'pre_version_id': baseline_vh_id,
            'success': True,
        }]
        self.session.save(update_fields=[
            'revert_message_id',
            'revert_snapshot_hash',
            'revert_resource_state',
            'updated_at',
        ])

        with patch(
            'apps.chat.conversation.api.rollback._unrevert_resources',
            return_value=[],
        ):
            resp = self._post(
                f'/api/chat/sessions/{self.session.id}/unrevert',
                {},
            )

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        expected_items = [{
            'resource_type': 'docs',
            'resource_id': 'doc-1',
            'action': 'restore_version',
            'restore_to_version_id': rollback_target_vh_id,
        }]
        self.assertEqual(body['reapply_resource_items'], expected_items)

        self.session.refresh_from_db()
        self.assertIsNone(self.session.revert_resource_state)
        history_entry = self.session.revert_history[-1]
        self.assertEqual(history_entry['type'], 'unrevert')
        self.assertEqual(history_entry['reapply_resource_items'], expected_items)

    def test_unrevert_rejects_non_reverted_session(self):
        """Unrevert on a non-reverted session returns 400."""
        resp = self._post(
            f'/api/chat/sessions/{self.session.id}/unrevert',
            {},
        )
        self.assertEqual(resp.status_code, 400)

    # ── Phase 0 checkpoint traceability tests ──

    def test_checkpoint_record_context_summary_from_metadata(self):
        """checkpoint_record should include context_summary from SpaceCheckpoint metadata,
        and checkpoint_id should prefer SpaceCheckpoint.id over message.id."""
        self.session.space_id = uuid4()
        self.session.save(update_fields=['space_id'])
        msg = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='context test',
            checkpoint_hash='hash_ctx',
            agent_run_id='run-ctx-1',
        )
        sp_id = str(uuid4())
        mock_summaries = {
            'hash_ctx': {
                'id': sp_id,
                'version_refs': {'docs:doc-1': 'vh-1'},
                'agent_run_id': 'run-ctx-1',
                'created_at': timezone.now(),
                'metadata': {
                    'checkpoint_context': {
                        'user_prompt': '帮我优化 parser 的性能',
                        'session_id': str(self.session.id),
                        'assistant_message_id': str(msg.id),
                        'agent_run_id': 'run-ctx-1',
                        'impact': {
                            'files': ['src/parser.ts', 'src/tokenizer.ts'],
                            'files_truncated': False,
                            'files_total_count': 2,
                            'resources': [
                                {'type': 'docs', 'id': 'doc-1', 'action': 'update', 'summary': '更新了文档'},
                            ],
                            'resources_truncated': False,
                            'resources_total_count': 1,
                        },
                    },
                },
            },
        }

        with patch(
            'apps.chat.conversation.api.message._get_space_checkpoint_summaries',
            return_value=mock_summaries,
        ):
            resp = self._get(f'/api/chat/sessions/{self.session.id}/messages?limit=50')

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        msg_view = next(item for item in body['messages'] if item['id'] == str(msg.id))
        cr = msg_view['checkpoint_record']

        self.assertEqual(cr['checkpoint_id'], sp_id)
        self.assertIsNotNone(cr.get('context_summary'))
        ctx = cr['context_summary']
        self.assertEqual(ctx['user_prompt'], '帮我优化 parser 的性能')
        self.assertEqual(ctx['session_id'], str(self.session.id))
        self.assertEqual(ctx['agent_run_id'], 'run-ctx-1')
        self.assertIsNotNone(ctx.get('impact'))
        self.assertEqual(len(ctx['impact']['files']), 2)
        self.assertEqual(len(ctx['impact']['resources']), 1)

    def test_checkpoint_record_no_context_when_metadata_empty(self):
        """Backward compat: old SpaceCheckpoints without checkpoint_context
        should return context_summary as null."""
        self.session.space_id = uuid4()
        self.session.save(update_fields=['space_id'])
        msg = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='old checkpoint',
            checkpoint_hash='hash_old',
        )
        mock_summaries = {
            'hash_old': {
                'id': str(uuid4()),
                'version_refs': {'docs:doc-2': 'vh-2'},
                'agent_run_id': '',
                'created_at': timezone.now(),
                'metadata': {},
            },
        }

        with patch(
            'apps.chat.conversation.api.message._get_space_checkpoint_summaries',
            return_value=mock_summaries,
        ):
            resp = self._get(f'/api/chat/sessions/{self.session.id}/messages?limit=50')

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        msg_view = next(item for item in body['messages'] if item['id'] == str(msg.id))
        cr = msg_view['checkpoint_record']

        self.assertIsNone(cr.get('context_summary'))
        self.assertEqual(cr['status'], 'degraded')

    def test_checkpoint_id_fallback_to_message_id_without_space(self):
        """Without space_id (no SpaceCheckpoint), checkpoint_id should
        fall back to message.id."""
        msg = ChatMessage.objects.create(
            session=self.session,
            role='assistant',
            text_summary='no space checkpoint',
            checkpoint_hash='hash_nospc',
        )

        resp = self._get(f'/api/chat/sessions/{self.session.id}/messages?limit=50')

        self.assertEqual(resp.status_code, 200)
        body = self._payload(resp)
        msg_view = next(item for item in body['messages'] if item['id'] == str(msg.id))
        cr = msg_view['checkpoint_record']

        self.assertEqual(cr['checkpoint_id'], str(msg.id))
        self.assertIsNone(cr.get('context_summary'))
