"""移动端通过 Electron 控制设备执行回退的后端调度契约。"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.chat.conversation.api.rollback import (
    _parse_runtime_rewind_result,
    _request_runtime_file_preview,
    _request_runtime_timeline_rewind,
)


class ControlDeviceRollbackDispatchTests(SimpleTestCase):
    """保证后端把文件锚点交给 Electron，并只接受真实文件回退确认。"""

    @patch(
        'apps.chat.conversation.api.rollback._resolve_rewind_anchor_id',
        return_value='run-with-file-change',
    )
    @patch(
        'apps.services.agent_engine.services.frontend_action_service.get_frontend_action_service',
    )
    @patch(
        'apps.tabtinspace.services.execution_binding.resolve_control_device',
    )
    def test_mobile_to_electron_dispatches_file_anchor_before_projection(
        self,
        mock_resolve_device,
        mock_get_action_service,
        _mock_resolve_anchor,
    ):
        """有已追踪文件改动时，Electron 必须收到同一轮的 per-file 锚点。"""
        session = SimpleNamespace(
            id='session-1',
            thread_id='chat-session-session-1',
            workspace=object(),
            workspace_id='workspace-1',
            organization_id='organization-1',
        )
        target = SimpleNamespace(
            id='message-1',
            role='user',
            # 空文本避免该纯调度测试依赖 ORM 消息查询；文件锚点由上方 patch 模拟。
            text_summary='',
        )
        mock_resolve_device.return_value = SimpleNamespace(
            device_type='electron',
            status='online',
            fingerprint='electron-control-device',
        )
        action_service = MagicMock()
        action_service.publish_action.return_value = 1
        action_service.wait_for_result.return_value = {
            'success': True,
            'data': {
                'applied': True,
                'file_restore_coordinated': True,
                'file_restore_success': True,
                'failed_files': [],
            },
        }
        mock_get_action_service.return_value = action_service

        result = _request_runtime_timeline_rewind(
            session,
            target,
            mode='editAndResend',
        )

        self.assertTrue(result.applied)
        self.assertTrue(result.file_restore_coordinated)
        self.assertTrue(result.file_restore_success)
        action_service.publish_action.assert_called_once()
        published_event = action_service.publish_action.call_args.args[1]
        self.assertEqual(
            published_event['data']['params']['file_rewind_anchor_id'],
            'run-with-file-change',
        )
        self.assertEqual(
            published_event['data']['params']['mode'],
            'editAndResend',
        )
        self.assertEqual(
            action_service.publish_action.call_args.kwargs['target_device_fingerprint'],
            'electron-control-device',
        )

    def test_old_electron_cannot_confirm_file_backed_rewind(self):
        """旧端仅确认 transcript 时，后端不得把文件回退投影为成功。"""
        result = _parse_runtime_rewind_result(
            {'success': True, 'data': {'applied': True}},
            has_electron_file_anchor=True,
            strict_file_confirmation=True,
        )

        self.assertFalse(result.applied)
        self.assertIn('文件回退', result.error or '')

    def test_no_file_history_is_reported_as_unavailable(self):
        """缺少本机账本不是“无文件影响”，但不能丢失已完成的对话回退。"""
        result = _parse_runtime_rewind_result(
            {
                'success': True,
                'data': {
                    'applied': True,
                    'file_restore_coordinated': True,
                    'file_restore_success': False,
                    'file_restore_status': 'unavailable',
                    'file_restore_reason': 'no_file_history',
                    'failed_files': [],
                },
            },
            has_electron_file_anchor=True,
            strict_file_confirmation=True,
        )

        self.assertTrue(result.applied)
        self.assertFalse(result.file_restore_success)
        self.assertEqual(result.file_restore_status, 'unavailable')
        self.assertEqual(result.file_restore_reason, 'no_file_history')

    @patch(
        'apps.services.agent_engine.services.frontend_action_service.get_frontend_action_service',
    )
    @patch(
        'apps.tabtinspace.services.execution_binding.resolve_control_device',
    )
    def test_mobile_preview_reads_electron_file_ledger_before_confirmation(
        self,
        mock_resolve_device,
        mock_get_action_service,
    ):
        """移动端预览必须向绑定 Electron 查询文件账本，不能把空清单当无影响。"""
        session = SimpleNamespace(
            id='session-1',
            thread_id='chat-session-session-1',
            workspace=object(),
            workspace_id='workspace-1',
            organization_id='organization-1',
        )
        mock_resolve_device.return_value = SimpleNamespace(
            device_type='electron',
            status='online',
            fingerprint='electron-control-device',
        )
        action_service = MagicMock()
        action_service.publish_action.return_value = 1
        action_service.wait_for_result.return_value = {
            'success': True,
            'data': {
                'file_preview_status': 'available',
                'affected_paths': ['/workspace/src/app.ts'],
                'file_preview_revision': 'v2:file-state',
            },
        }
        mock_get_action_service.return_value = action_service

        result = _request_runtime_file_preview(session, 'run-with-file-change')

        self.assertEqual(result.status, 'available')
        self.assertEqual(result.affected_paths, ('/workspace/src/app.ts',))
        self.assertEqual(result.revision, 'v2:file-state')
        published_event = action_service.publish_action.call_args.args[1]
        self.assertEqual(published_event['data']['type'], 'file_history_preview')
        self.assertEqual(published_event['data']['params']['anchor_id'], 'run-with-file-change')
