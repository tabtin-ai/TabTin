"""
媒体生成 Celery 任务回归测试

SVC-14: store_media_results 并行化
SVC-34: poll_count 原子更新
SVC-35: 轮询任务队列路由
SVC-13: store_media_results 队列路由
"""

from django.test import SimpleTestCase, override_settings
from unittest.mock import patch, MagicMock, PropertyMock
from decimal import Decimal
import uuid


class MediaSubmissionFailureTest(SimpleTestCase):
    """提交失败必须关闭已创建任务，且媒体 API 必须校验组织成员关系。"""

    def test_marks_created_task_failed(self):
        from apps.services.media_generation.api import _mark_submission_failed

        task = MagicMock()
        task.is_terminal = False

        _mark_submission_failed(task, code="AUTH_FAILED", message="invalid key")

        task.mark_failed.assert_called_once_with(
            error_code="AUTH_FAILED",
            error_message="invalid key",
        )

    def test_does_not_overwrite_terminal_task(self):
        from apps.services.media_generation.api import _mark_submission_failed

        task = MagicMock()
        task.is_terminal = True

        _mark_submission_failed(task, code="STORAGE_ERROR", message="late failure")

        task.mark_failed.assert_not_called()

    def test_media_generate_endpoints_enforce_organization_permission(self):
        import inspect
        from apps.services.media_generation import api

        source = inspect.getsource(api)
        self.assertIn(
            'scene_key="media_image_generate"',
            source,
        )
        self.assertIn(
            'scene_key="media_video_generate"',
            source,
        )

    def test_provider_auth_failure_maps_to_bad_gateway(self):
        from apps.services.media_generation.api import _media_error_http_status
        from apps.services.media_generation.errors import MediaErrorCode, MediaServiceError

        status = _media_error_http_status(MediaServiceError(
            code=MediaErrorCode.AUTH_FAILED,
            message="provider key expired",
            status_code=401,
        ))

        self.assertEqual(status, 502)

    @patch("apps.services.media_generation.tasks.storage.store_media_results.delay")
    def test_storage_enqueue_failure_does_not_fail_generated_task(self, mock_delay):
        from apps.services.media_generation.tasks.storage import enqueue_media_storage

        mock_delay.side_effect = RuntimeError("broker unavailable")
        task = MagicMock()
        task.id = uuid.uuid4()
        task.storage_status = "not_started"
        task.result_metadata = {"request_id": "ark-1"}

        enqueue_media_storage(task)

        self.assertEqual(task.result_metadata["request_id"], "ark-1")
        self.assertEqual(task.result_metadata["storage_enqueue_error"], "broker unavailable")
        self.assertEqual(task.storage_status, "not_started")
        task.save.assert_called_once_with(
            update_fields=["result_metadata", "updated_at"],
        )


class StoreMediaResultsGroupTest(SimpleTestCase):
    """验证 store_media_results 用 chord 并行上传且只由一个任务接管。"""

    @patch('apps.services.media_generation.tasks.storage.chord')
    @patch('apps.services.media_generation.tasks.storage._upload_single_to_oss')
    def test_chord_called_for_multiple_urls(self, mock_upload_task, mock_chord):
        """多 URL 时应通过 chord 并行分发并异步聚合。"""
        from apps.services.media_generation.tasks.storage import store_media_results

        mock_task = MagicMock()
        mock_task.id = uuid.uuid4()
        mock_task.status = 'succeeded'
        mock_task.storage_status = 'not_started'
        mock_task.result_urls = ['http://example.com/a.png', 'http://example.com/b.png']
        mock_task.stored_urls = []
        mock_task.task_type = 'text2image'
        mock_task.user_id = str(uuid.uuid4())
        mock_task.organization_id = str(uuid.uuid4())
        mock_task.parameters = {}

        callback_runner = MagicMock()
        mock_chord.return_value = callback_runner

        with patch('apps.services.media_generation.models.MediaTask.objects') as mock_qs:
            mock_qs.get.return_value = mock_task
            mock_qs.filter.return_value.update.return_value = 1
            store_media_results(str(mock_task.id))

        mock_chord.assert_called_once()
        callback_runner.assert_called_once()

    @patch('apps.services.media_generation.tasks.storage.chord')
    @patch('apps.services.media_generation.tasks.storage._upload_single_to_oss')
    def test_chord_dispatch_failure_releases_claim_before_retry(self, mock_upload_task, mock_chord):
        from apps.services.media_generation.tasks.storage import store_media_results

        mock_task = MagicMock()
        mock_task.id = uuid.uuid4()
        mock_task.status = 'succeeded'
        mock_task.storage_status = 'not_started'
        mock_task.result_urls = ['http://example.com/a.png']
        mock_task.task_type = 'text2image'
        mock_task.user_id = str(uuid.uuid4())
        mock_task.organization_id = str(uuid.uuid4())
        mock_task.parameters = {}
        mock_chord.return_value.side_effect = RuntimeError('broker unavailable')

        with patch('apps.services.media_generation.models.MediaTask.objects') as mock_qs, \
             patch.object(store_media_results, 'retry', side_effect=RuntimeError('retry')):
            mock_qs.get.return_value = mock_task
            mock_qs.filter.return_value.update.return_value = 1
            with self.assertRaisesRegex(RuntimeError, 'retry'):
                store_media_results(str(mock_task.id))

        failed_claim = mock_qs.filter.call_args_list[-1]
        self.assertEqual(failed_claim.kwargs, {
            'id': mock_task.id,
            'storage_status': 'storing',
        })
        mock_qs.filter.return_value.update.assert_called_with(
            storage_status='not_started',
            result_metadata={'storage_enqueue_error': 'broker unavailable'},
        )

    @patch('apps.services.media_generation.tasks.storage.chord')
    def test_skip_when_another_worker_already_claimed_storage(self, mock_chord):
        from apps.services.media_generation.tasks.storage import store_media_results

        mock_task = MagicMock()
        mock_task.id = uuid.uuid4()
        mock_task.status = 'succeeded'
        mock_task.storage_status = 'storing'
        mock_task.result_urls = ['http://example.com/a.png']
        mock_task.stored_urls = []
        mock_task.task_type = 'text2image'
        mock_task.user_id = str(uuid.uuid4())
        mock_task.organization_id = str(uuid.uuid4())
        mock_task.parameters = {}

        with patch('apps.services.media_generation.models.MediaTask.objects') as mock_qs:
            mock_qs.get.return_value = mock_task
            mock_qs.filter.return_value.update.return_value = 0
            store_media_results(str(mock_task.id))

        mock_chord.assert_not_called()

    @patch('apps.services.media_generation.tasks.storage.chord')
    def test_skip_if_already_stored(self, mock_chord):
        """已转存任务应跳过。"""
        from apps.services.media_generation.tasks.storage import store_media_results

        mock_task = MagicMock()
        mock_task.id = uuid.uuid4()
        mock_task.status = 'succeeded'
        mock_task.storage_status = 'succeeded'
        mock_task.result_urls = ['http://example.com/a.png']
        mock_task.stored_urls = ['https://oss/a.png']

        with patch('apps.services.media_generation.models.MediaTask.objects') as mock_qs:
            mock_qs.get.return_value = mock_task
            store_media_results(str(mock_task.id))

        mock_chord.assert_not_called()


class UploadSingleToOssTest(SimpleTestCase):
    """SVC-14: 验证子任务 _upload_single_to_oss 返回正确结构。"""

    @patch('apps.services.oss.tasks.download_and_upload_from_url')
    def test_success_returns_stable_file_identity(self, mock_oss_task):
        from apps.services.media_generation.tasks.storage import _upload_single_to_oss

        mock_oss_task.run.return_value = {
            'success': True,
            'data': {
                'file_id': 'file-1',
                'file_name': 'a.png',
                'mime_type': 'image/png',
                'file_size': 1024,
                'access_url': 'https://oss/permanent.png',
            },
        }

        result = _upload_single_to_oss(
            'http://tmp.com/a.png', 'media-gen/test/key.png',
            'task-1', 'text2image', 'ws-1', 'user-1', 0,
        )
        self.assertEqual(result['access_url'], 'https://oss/permanent.png')
        self.assertEqual(result['file_id'], 'file-1')
        self.assertEqual(result['mime_type'], 'image/png')
        self.assertEqual(result['index'], 0)
        mock_oss_task.run.assert_called_once()
        mock_oss_task.apply.assert_not_called()

    def test_import_error_returns_fallback(self):
        """OSS 不可用时应优雅降级。"""
        from apps.services.media_generation.tasks.storage import _upload_single_to_oss

        with patch.dict('sys.modules', {'apps.services.oss.tasks': None}):
            result = _upload_single_to_oss(
                'http://tmp.com/a.png', 'key.png',
                'task-1', 'text2image', 'ws-1', 'user-1', 0,
            )
            self.assertEqual(result['error'], 'oss_service_unavailable')


class PollCountAtomicUpdateTest(SimpleTestCase):
    """SVC-34: 验证 poll_count 使用 F() 原子更新而非内存递增。"""

    @patch('apps.services.media_generation.tasks.polling.MediaTask', create=True)
    def test_poll_count_uses_f_expression(self, _mock):
        """验证代码中使用了 F('poll_count') + 1 而非 task.poll_count += 1。"""
        import inspect
        from apps.services.media_generation.tasks import polling

        source = inspect.getsource(polling.poll_media_task)
        self.assertNotIn('task.poll_count += 1', source,
                         "poll_count 应使用 F() 原子更新，不应直接 +=")
        self.assertIn("F('poll_count') + 1", source,
                       "poll_count 应使用 F('poll_count') + 1 原子更新")


class MediaTaskQueueRouteTest(SimpleTestCase):
    """SVC-13/SVC-35: 验证媒体生成任务路由到 media 队列。"""

    def _assert_media_queue(self, key: str):
        from django.conf import settings
        routes = settings.CELERY_TASK_ROUTES
        self.assertIn(key, routes)
        self.assertEqual(routes[key]['queue'], 'media')

    def test_store_media_results_routed_to_heavy(self):
        self._assert_media_queue('apps.services.media_generation.tasks.storage.store_media_results')

    def test_upload_single_to_oss_routed_to_heavy(self):
        self._assert_media_queue('apps.services.media_generation.tasks.storage._upload_single_to_oss')

    def test_poll_media_task_routed_to_heavy(self):
        self._assert_media_queue('apps.services.media_generation.tasks.polling.poll_media_task')

    def test_execute_media_generation_routed_to_heavy(self):
        self._assert_media_queue('apps.services.media_generation.tasks.execution.execute_media_generation')
