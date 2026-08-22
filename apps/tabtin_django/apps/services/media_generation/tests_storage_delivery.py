"""媒体生成永久存储交付契约测试。"""

from types import SimpleNamespace
from unittest.mock import ANY, MagicMock, patch

from datetime import timedelta
import hashlib

from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from apps.services.media_generation.api import _legacy_result_urls


def _stored_file(index: int = 0) -> dict:
    return {
        "index": index,
        "file_id": f"file-{index}",
        "file_name": f"image-{index}.png",
        "mime_type": "image/png",
        "file_size": 1024 + index,
        "access_url": f"https://oss.example/image-{index}.png",
    }


class LegacyTaskResponseCompatibilityTest(SimpleTestCase):
    def test_partial_delivery_keeps_result_order_without_polluting_stored_urls(self):
        task = SimpleNamespace(
            result_urls=[
                "https://provider.example/temp-0.png",
                "https://provider.example/temp-1.png",
            ],
            stored_urls=["https://oss.example/permanent-1.png"],
            storage_status="partial",
            stored_files=[{
                "index": 1,
                "access_url": "https://oss.example/permanent-1.png",
            }],
        )

        self.assertEqual(_legacy_result_urls(task), [
            "https://provider.example/temp-0.png",
            "https://oss.example/permanent-1.png",
        ])
        self.assertEqual(task.stored_urls, ["https://oss.example/permanent-1.png"])

    @patch("apps.services.media_generation.tasks.storage.enqueue_media_artifact_delivery")
    @patch("apps.services.oss.models.FileUsage.objects")
    def test_old_worker_urls_upgrade_only_when_file_usage_proves_identity(self, usages, enqueue):
        from apps.services.media_generation.api import _reconcile_legacy_storage_delivery

        record = SimpleNamespace(
            id="file-legacy-1",
            file_name="legacy.png",
            mime_type="image/png",
            file_size=1024,
            access_url="https://oss.example/legacy.png",
        )
        usages.filter.return_value.select_related.return_value = [
            SimpleNamespace(file_record=record),
        ]
        task = MagicMock(
            id="task-legacy-1",
            storage_status="not_started",
            stored_files=[],
            stored_urls=[record.access_url, "https://provider.example/temporary.png"],
            result_urls=[
                "https://provider.example/original-0.png",
                "https://provider.example/temporary.png",
            ],
        )

        _reconcile_legacy_storage_delivery(task)

        saved = task.mark_storage_result.call_args.kwargs
        self.assertEqual(saved["storage_status"], "partial")
        self.assertEqual(len(saved["stored_files"]), 1)
        self.assertEqual(saved["stored_files"][0]["file_id"], "file-legacy-1")
        self.assertNotIn("https://provider.example/temporary.png", [
            item["access_url"] for item in saved["stored_files"]
        ])
        enqueue.assert_called_once_with(task)


class FinalizeMediaStorageTest(SimpleTestCase):
    """Celery chord 必须按 ``results, task_id`` 聚合永久产物。"""

    @patch("apps.services.media_generation.models.MediaTask.objects")
    def test_all_uploads_succeeded_store_stable_file_identity(self, objects):
        from apps.services.media_generation.tasks.storage import _finalize_media_storage

        task = MagicMock()
        task.id = "task-1"
        objects.get.return_value = task
        result = _stored_file()

        _finalize_media_storage([result], "task-1")

        objects.get.assert_called_once_with(id="task-1")
        task.mark_storage_result.assert_called_once()
        saved = task.mark_storage_result.call_args.kwargs
        self.assertEqual(saved["storage_status"], "succeeded")
        saved_file = dict(saved["stored_files"][0])
        artifact_message_id = saved_file.pop("artifact_message_id")
        self.assertEqual(saved_file, result)
        self.assertRegex(
            artifact_message_id,
            r"^[0-9a-f-]{36}$",
        )
        task.mark_storage_result.assert_called_once_with(
            storage_status="succeeded",
            stored_files=saved["stored_files"],
        )

    @patch("apps.services.media_generation.tasks.storage.enqueue_media_artifact_delivery")
    @patch("apps.services.media_generation.models.MediaTask.objects")
    def test_storage_success_enqueues_late_formal_artifact_delivery(self, objects, enqueue):
        from apps.services.media_generation.tasks.storage import _finalize_media_storage

        task = MagicMock(id="task-1", result_urls=["https://provider.example/temporary.png"])
        objects.get.return_value = task

        _finalize_media_storage([_stored_file()], "task-1")

        enqueue.assert_called_once_with(task)

    @patch("apps.services.media_generation.models.MediaTask.objects")
    def test_partial_upload_keeps_only_permanent_successes(self, objects):
        from apps.services.media_generation.tasks.storage import _finalize_media_storage

        task = MagicMock()
        task.result_urls = [
            "https://provider.example/temporary-0.png",
            "https://provider.example/temporary-1.png",
        ]
        objects.get.return_value = task
        success = _stored_file(0)

        _finalize_media_storage(
            [success, {"index": 1, "error": "upload failed"}],
            "task-2",
        )

        task.mark_storage_result.assert_called_once()
        self.assertEqual(task.mark_storage_result.call_args.kwargs["storage_status"], "partial")
        stored_files = task.mark_storage_result.call_args.kwargs["stored_files"]
        self.assertEqual(
            {key: value for key, value in stored_files[0].items() if key != "artifact_message_id"},
            success,
        )
        self.assertNotIn(task.result_urls[1], [item["access_url"] for item in stored_files])

    @patch("apps.services.media_generation.models.MediaTask.objects")
    def test_all_uploads_failed_leave_permanent_results_empty(self, objects):
        from apps.services.media_generation.tasks.storage import _finalize_media_storage

        task = MagicMock()
        task.result_urls = ["https://provider.example/temporary.png"]
        objects.get.return_value = task

        _finalize_media_storage([{"index": 0, "error": "upload failed"}], "task-3")

        task.mark_storage_result.assert_called_once_with(
            storage_status="failed",
            stored_files=[],
        )

    @patch("apps.services.media_generation.models.MediaTask.objects")
    def test_incomplete_file_identity_is_not_a_permanent_success(self, objects):
        from apps.services.media_generation.tasks.storage import _finalize_media_storage

        task = MagicMock()
        task.result_urls = ["https://provider.example/temporary.png"]
        objects.get.return_value = task
        incomplete = _stored_file()
        incomplete.pop("mime_type")

        _finalize_media_storage([incomplete], "task-4")

        task.mark_storage_result.assert_called_once_with(
            storage_status="failed",
            stored_files=[],
        )


class UploadSingleToOssDeliveryTest(SimpleTestCase):
    @patch("apps.services.oss.tasks.download_and_upload_from_url")
    def test_success_preserves_file_metadata(self, upload_task):
        from apps.services.media_generation.tasks.storage import _upload_single_to_oss

        upload_task.run.return_value = {
            "success": True,
            "data": {
                "file_id": "file-1",
                "file_name": "mountain.png",
                "mime_type": "image/png",
                "file_size": 2048,
                "access_url": "https://oss.example/mountain.png",
            },
        }

        result = _upload_single_to_oss(
            "https://provider.example/temporary.png",
            "media-gen/text2image/task.png",
            "task-1",
            "text2image",
            "org-1",
            "user-1",
            0,
        )

        self.assertEqual(result, _stored_file() | {
            "file_id": "file-1",
            "file_name": "mountain.png",
            "file_size": 2048,
            "access_url": "https://oss.example/mountain.png",
        })
        upload_task.run.assert_called_once()
        self.assertTrue(upload_task.run.call_args.kwargs["enforce_public_read_acl"])
        upload_task.apply.assert_not_called()

    @override_settings(MEDIA_GENERATION_PRIVATE_OSS_ENABLED=True)
    @patch("apps.services.oss.tasks.download_and_upload_from_url")
    def test_private_rollout_flag_stores_new_image_as_private(self, upload_task):
        from apps.services.media_generation.tasks.storage import _upload_single_to_oss

        upload_task.run.return_value = {
            "success": True,
            "data": {
                "file_id": "file-private",
                "file_name": "private.png",
                "mime_type": "image/png",
                "file_size": 1,
                "access_url": "https://oss.example/signed.png",
            },
        }

        _upload_single_to_oss(
            "https://provider.example/temporary.png",
            "media-gen/text2image/task.png",
            "task-private",
            "text2image",
            "org-private",
            "user-private",
            0,
        )

        self.assertFalse(upload_task.run.call_args.kwargs["is_public"])
        self.assertFalse(upload_task.run.call_args.kwargs["enforce_public_read_acl"])

    @patch("apps.services.oss.tasks.download_and_upload_from_url")
    def test_nested_oss_retry_retries_current_chord_task(self, upload_task):
        from celery.exceptions import Retry
        from apps.services.media_generation.tasks.storage import _upload_single_to_oss

        cause = TimeoutError("temporary download failure")
        upload_task.run.side_effect = Retry(exc=cause)

        with patch.object(
            _upload_single_to_oss,
            "retry",
            side_effect=RuntimeError("outer retry scheduled"),
        ) as retry_current:
            with self.assertRaisesRegex(RuntimeError, "outer retry scheduled"):
                _upload_single_to_oss(
                    "https://provider.example/temporary.png",
                    "media-gen/text2image/task.png",
                    "task-1",
                    "text2image",
                    "org-1",
                    "user-1",
                    0,
                )

        retry_current.assert_called_once_with(exc=cause)

    @patch("apps.services.oss.tasks.download_and_upload_from_url")
    def test_direct_transient_error_retries_current_chord_task(self, upload_task):
        from apps.services.media_generation.tasks.storage import _upload_single_to_oss

        cause = TimeoutError("temporary upload failure")
        upload_task.run.side_effect = cause

        with patch.object(
            _upload_single_to_oss,
            "retry",
            side_effect=RuntimeError("outer retry scheduled"),
        ) as retry_current:
            with self.assertRaisesRegex(RuntimeError, "outer retry scheduled"):
                _upload_single_to_oss(
                    "https://provider.example/temporary.png",
                    "media-gen/text2image/task.png",
                    "task-1",
                    "text2image",
                    "org-1",
                    "user-1",
                    0,
                )

        retry_current.assert_called_once_with(exc=cause)


class MediaTaskDeliverySchemaTest(SimpleTestCase):
    def test_task_detail_fields_are_optional_for_old_payloads(self):
        from apps.services.media_generation.schemas import TaskDetailResponse

        response = TaskDetailResponse(success=True, status="succeeded")

        self.assertIsNone(response.storage_status)
        self.assertIsNone(response.stored_files)


class StorageLeaseRecoveryTest(TestCase):
    def _task(self, *, storage_status="storing"):
        from apps.services.media_generation.models import MediaTask

        return MediaTask.objects.create(
            task_type="text2image",
            status="succeeded",
            storage_status=storage_status,
            user_id="user-lease",
            prompt="lease recovery",
            result_urls=["https://provider.example/temporary.png"],
            parameters={},
        )

    @patch("apps.services.media_generation.tasks.storage.chord")
    def test_fresh_storing_lease_is_not_reclaimed(self, chord):
        from apps.services.media_generation.tasks.storage import store_media_results

        task = self._task()
        store_media_results(str(task.id))

        chord.assert_not_called()

    @patch("apps.services.media_generation.tasks.storage.chord")
    def test_expired_storing_lease_is_reclaimed(self, chord):
        from apps.services.media_generation.models import MediaTask
        from apps.services.media_generation.tasks.storage import store_media_results

        task = self._task()
        MediaTask.objects.filter(id=task.id).update(
            updated_at=timezone.now() - timedelta(minutes=16),
        )
        chord.return_value = MagicMock()

        store_media_results(str(task.id))

        chord.assert_called_once()
        task.refresh_from_db()
        self.assertEqual(task.storage_status, "storing")
        self.assertGreater(task.updated_at, timezone.now() - timedelta(minutes=1))

    @patch("apps.services.media_generation.tasks.storage.store_media_results.delay")
    def test_periodic_recovery_requeues_only_expired_storage(self, delay):
        from apps.services.media_generation.models import MediaTask
        from apps.services.media_generation.tasks.storage import recover_stale_media_storage

        stale = self._task()
        fresh = self._task()
        MediaTask.objects.filter(id=stale.id).update(
            updated_at=timezone.now() - timedelta(minutes=16),
        )

        recovered = recover_stale_media_storage()

        self.assertEqual(recovered, 1)
        delay.assert_called_once_with(str(stale.id))
        self.assertNotEqual(str(fresh.id), delay.call_args.args[0])

    @patch("apps.services.media_generation.tasks.storage.store_media_results.delay")
    def test_periodic_recovery_requeues_storage_that_failed_to_enter_broker(self, delay):
        from apps.services.media_generation.models import MediaTask
        from apps.services.media_generation.tasks.storage import recover_stale_media_storage

        task = self._task(storage_status="not_started")
        task.result_metadata = {"storage_enqueue_error": "broker unavailable"}
        task.save(update_fields=["result_metadata", "updated_at"])

        recovered = recover_stale_media_storage()

        self.assertEqual(recovered, 1)
        delay.assert_called_once_with(str(task.id))

    @patch("apps.services.media_generation.tasks.storage.store_media_results.delay")
    def test_periodic_recovery_repairs_legacy_failed_broker_rows(self, delay):
        from apps.services.media_generation.tasks.storage import recover_stale_media_storage

        task = self._task(storage_status="failed")
        task.result_metadata = {"storage_enqueue_error": "legacy broker unavailable"}
        task.save(update_fields=["result_metadata", "updated_at"])

        self.assertEqual(recover_stale_media_storage(), 1)
        delay.assert_called_once_with(str(task.id))

    @patch("apps.services.media_generation.tasks.storage.store_media_results.delay", side_effect=RuntimeError("broker down"))
    def test_enqueue_failure_remains_recoverable(self, _delay):
        from apps.services.media_generation.tasks.storage import enqueue_media_storage

        task = self._task(storage_status="not_started")

        enqueue_media_storage(task)

        task.refresh_from_db()
        self.assertEqual(task.storage_status, "not_started")
        self.assertEqual(task.result_metadata["storage_enqueue_error"], "broker down")

    def test_object_key_is_stable_across_worker_retries(self):
        from apps.services.media_generation.tasks.storage import _storage_object_key

        first = _storage_object_key(
            task_id="11111111-1111-4111-8111-111111111111",
            task_type="text2image",
            user_id="22222222-2222-4222-8222-222222222222",
            index=0,
            extension=".png",
        )
        second = _storage_object_key(
            task_id="11111111-1111-4111-8111-111111111111",
            task_type="text2image",
            user_id="22222222-2222-4222-8222-222222222222",
            index=0,
            extension=".png",
        )

        self.assertEqual(first, second)
        self.assertEqual(
            first,
            "media-gen/text2image/22222222/11111111-1111-4111-8111-111111111111_0.png",
        )


class MediaArtifactDeliveryTest(SimpleTestCase):
    @patch("apps.services.media_generation.tasks.storage._sync_write_media_artifact")
    @patch("apps.services.media_generation.models.MediaTask.objects")
    def test_late_delivery_projects_stable_file_into_conversation(self, objects, sync_write):
        from apps.services.media_generation.tasks.storage import deliver_media_artifacts

        task = MagicMock()
        task.id = "11111111-1111-4111-8111-111111111111"
        task.user_id = "22222222-2222-4222-8222-222222222222"
        task.source_session_id = "33333333-3333-4333-8333-333333333333"
        task.source_tool_use_id = "tool-use-image-1"
        task.source_agent_run_id = "agent-run-1"
        task.storage_status = "succeeded"
        task.stored_files = [_stored_file() | {
            "artifact_message_id": "44444444-4444-4444-8444-444444444444",
        }]
        objects.get.return_value = task
        objects.filter.return_value.update.return_value = 1
        sync_write.return_value = True

        delivered = deliver_media_artifacts(str(task.id))

        self.assertEqual(delivered, 1)
        sync_write.assert_called_once()
        event = sync_write.call_args.kwargs["event"]
        self.assertEqual(event["payload"]["message_id"], task.stored_files[0]["artifact_message_id"])
        block = event["payload"]["blocks_json"][0]
        self.assertEqual(block["kind"], "image")
        self.assertEqual(block["payload"]["file_id"], "file-0")
        self.assertEqual(block["payload"]["source_tool_use_id"], "tool-use-image-1")
        objects.filter.return_value.update.assert_called_once_with(
            artifact_delivery_status="delivered",
            artifact_delivery_error="",
            artifact_delivered_at=ANY,
        )


class MediaArtifactDeliveryIntegrationTest(TestCase):
    @patch("apps.services.media_generation.tasks.storage.deliver_media_artifacts.delay")
    def test_periodic_recovery_requeues_only_undelivered_artifacts(self, delay):
        from apps.services.media_generation.models import MediaTask
        from apps.services.media_generation.tasks.storage import recover_media_artifact_delivery

        pending = MediaTask.objects.create(
            task_type="text2image",
            status="succeeded",
            storage_status="succeeded",
            artifact_delivery_status="pending",
            user_id="user-pending-delivery",
            source_session_id="session-pending-delivery",
            source_tool_use_id="tool-pending-delivery",
            prompt="pending delivery",
            stored_files=[_stored_file()],
        )
        MediaTask.objects.create(
            task_type="text2image",
            status="succeeded",
            storage_status="succeeded",
            artifact_delivery_status="delivered",
            user_id="user-delivered",
            source_session_id="session-delivered",
            source_tool_use_id="tool-delivered",
            prompt="already delivered",
            stored_files=[_stored_file()],
        )

        self.assertEqual(recover_media_artifact_delivery(), 1)
        delay.assert_called_once_with(str(pending.id))

    def test_late_delivery_persists_one_formal_message_and_file_usage(self):
        from django.contrib.auth import get_user_model
        from apps.chat.conversation.models import ChatMessage, ChatSession
        from apps.services.media_generation.models import MediaTask
        from apps.services.media_generation.tasks.storage import (
            artifact_message_id,
            deliver_media_artifacts,
        )
        from apps.services.oss.models import FileRecord, FileUsage

        user = get_user_model().objects.create_user(
            email="media-artifact-delivery@example.com",
            password="x",
        )
        session = ChatSession.objects.create(
            user=user,
            organization_id="org-artifact-delivery",
            title="late image delivery",
        )
        file_key = "media-gen/text2image/task-late_0.png"
        file_record = FileRecord.objects.create(
            file_name="late.png",
            file_key=file_key,
            file_key_hash=hashlib.sha256(file_key.encode()).hexdigest(),
            file_path="media-gen/text2image",
            file_size=2048,
            file_type="image",
            mime_type="image/png",
            file_extension="png",
            file_hash="late-hash",
            bucket_name="test-bucket",
            access_url="https://oss.example/late.png",
            upload_user=str(user.id),
            organization_id="org-artifact-delivery",
            status="completed",
        )
        task = MediaTask.objects.create(
            task_type="text2image",
            status="succeeded",
            storage_status="succeeded",
            artifact_delivery_status="pending",
            user_id=str(user.id),
            organization_id="org-artifact-delivery",
            source_session_id=str(session.id),
            source_tool_use_id="tool-use-late-image",
            source_agent_run_id="agent-run-late-image",
            prompt="late image",
            result_urls=["https://provider.example/late.png"],
        )
        message_id = artifact_message_id(
            task_id=str(task.id),
            file_id=str(file_record.id),
            index=0,
        )
        task.stored_files = [{
            "index": 0,
            "file_id": str(file_record.id),
            "file_name": file_record.file_name,
            "mime_type": file_record.mime_type,
            "file_size": file_record.file_size,
            "access_url": file_record.access_url,
            "artifact_message_id": message_id,
        }]
        task.stored_urls = [file_record.access_url]
        task.save(update_fields=["stored_files", "stored_urls", "updated_at"])

        self.assertEqual(deliver_media_artifacts(str(task.id)), 1)
        self.assertEqual(deliver_media_artifacts(str(task.id)), 1)

        message = ChatMessage.objects.get(id=message_id, session=session)
        self.assertEqual(message.message_kind, "tool_artifact")
        self.assertEqual(
            message.content_blocks_json[0]["payload"]["source_tool_use_id"],
            "tool-use-late-image",
        )
        self.assertEqual(ChatMessage.objects.filter(id=message_id).count(), 1)
        self.assertTrue(FileUsage.objects.filter(
            file_record=file_record,
            module="chat",
            context_type="message",
            context_id=message_id,
            is_active=True,
        ).exists())


class PublicReadMediaObjectAclTest(SimpleTestCase):
    @patch("apps.services.oss.tasks.FileRecord.objects")
    @patch("apps.services.oss.tasks.get_oss_service")
    @patch("apps.services.common.url_security.ssrf_safe_request")
    def test_generic_public_url_retry_does_not_change_acl_without_media_opt_in(
        self, request, get_oss_service, file_records,
    ):
        from apps.services.oss.tasks import download_and_upload_from_url

        object_key = "imports/public-but-inherited.png"
        record = MagicMock(
            id="generic-public-file",
            file_name="public-but-inherited.png",
            file_key=object_key,
            file_size=7,
            mime_type="image/png",
            access_url=f"https://oss.example/{object_key}",
            cdn_url="",
        )
        file_records.filter.return_value.first.return_value = record

        result = download_and_upload_from_url.run(
            "https://provider.example/public-but-inherited.png",
            object_key=object_key,
            is_public=True,
        )

        self.assertTrue(result["success"])
        request.assert_not_called()
        get_oss_service.return_value.set_object_public_read.assert_not_called()

    @patch("apps.services.oss.tasks.FileRecord.objects")
    @patch("apps.services.oss.tasks.get_oss_service")
    @patch("apps.services.common.url_security.ssrf_safe_request")
    def test_new_public_media_object_is_anonymously_readable(
        self, request, get_oss_service, file_records,
    ):
        from apps.services.oss.tasks import download_and_upload_from_url

        object_key = "media-gen/text2image/11111111/task-public_0.png"
        object_acls = {}
        oss_service = MagicMock()
        oss_service.config = {"bucket_name": "test-bucket"}

        def upload_file(_file_content, uploaded_key, **_kwargs):
            object_acls[uploaded_key] = "private"
            return {
                "success": True,
                "data": {
                    "access_url": f"https://oss.example/{uploaded_key}",
                    "cdn_url": "",
                },
            }

        def set_public_read(uploaded_key):
            object_acls[uploaded_key] = "public-read"
            return True

        oss_service.upload_file.side_effect = upload_file
        oss_service.set_object_public_read.side_effect = set_public_read
        get_oss_service.return_value = oss_service

        response = MagicMock()
        response.headers = {"Content-Type": "image/png", "Content-Length": "7"}
        response.iter_content.return_value = [b"pngdata"]
        request.return_value = response

        record = MagicMock()
        record.id = "file-public"
        record.file_name = "generated.png"
        record.file_key = object_key
        record.file_size = 7
        record.mime_type = "image/png"
        record.is_public = True
        record.status = "uploading"
        record.access_url = ""
        record.cdn_url = ""

        def mark_completed(access_url, cdn_url):
            record.status = "completed"
            record.access_url = access_url
            record.cdn_url = cdn_url

        record.mark_as_completed.side_effect = mark_completed
        file_records.filter.return_value.first.return_value = None
        file_records.create.return_value = record

        result = download_and_upload_from_url.run(
            "https://provider.example/generated.png",
            object_key=object_key,
            is_public=True,
            enforce_public_read_acl=True,
        )

        self.assertTrue(result["success"])
        self.assertTrue(record.is_public)
        self.assertEqual(record.status, "completed")
        self.assertEqual(object_acls[object_key], "public-read")

    @patch("apps.services.oss.tasks.FileRecord.objects")
    @patch("apps.services.oss.tasks.get_oss_service")
    @patch("apps.services.common.url_security.ssrf_safe_request")
    def test_completed_public_media_retry_repairs_object_acl(
        self, request, get_oss_service, file_records,
    ):
        from apps.services.oss.tasks import download_and_upload_from_url

        object_key = "media-gen/text2image/11111111/task-retry_0.png"
        object_acls = {object_key: "private"}
        oss_service = MagicMock()
        oss_service.set_object_public_read.side_effect = (
            lambda uploaded_key: object_acls.__setitem__(uploaded_key, "public-read") or True
        )
        get_oss_service.return_value = oss_service

        record = MagicMock()
        record.id = "file-retry"
        record.file_name = "retry.png"
        record.file_key = object_key
        record.file_size = 7
        record.mime_type = "image/png"
        record.is_public = True
        record.access_url = f"https://oss.example/{object_key}"
        record.cdn_url = ""
        file_records.filter.return_value.first.return_value = record

        result = download_and_upload_from_url.run(
            "https://provider.example/retry.png",
            object_key=object_key,
            is_public=True,
            enforce_public_read_acl=True,
        )

        request.assert_not_called()
        self.assertTrue(result["success"])
        self.assertEqual(object_acls[object_key], "public-read")

    @patch("apps.services.oss.tasks.FileRecord.objects")
    @patch("apps.services.oss.tasks.get_oss_service")
    @patch("apps.services.common.url_security.ssrf_safe_request")
    def test_multiple_public_media_objects_all_receive_public_read_acl(
        self, request, get_oss_service, file_records,
    ):
        from apps.services.oss.tasks import download_and_upload_from_url

        object_keys = [
            f"media-gen/text2image/11111111/task-batch_{index}.png"
            for index in range(3)
        ]
        object_acls = {}
        oss_service = MagicMock()
        oss_service.config = {"bucket_name": "test-bucket"}

        def upload_file(_file_content, uploaded_key, **_kwargs):
            object_acls[uploaded_key] = "private"
            return {
                "success": True,
                "data": {
                    "access_url": f"https://oss.example/{uploaded_key}",
                    "cdn_url": "",
                },
            }

        def set_public_read(uploaded_key):
            object_acls[uploaded_key] = "public-read"
            return True

        oss_service.upload_file.side_effect = upload_file
        oss_service.set_object_public_read.side_effect = set_public_read
        get_oss_service.return_value = oss_service

        response = MagicMock()
        response.headers = {"Content-Type": "image/png", "Content-Length": "7"}
        response.iter_content.return_value = [b"pngdata"]
        request.return_value = response
        file_records.filter.return_value.first.return_value = None

        created_count = 0

        def create_record(**kwargs):
            nonlocal created_count
            created_count += 1
            record = MagicMock()
            record.id = f"file-batch-{created_count}"
            record.file_name = kwargs["file_name"]
            record.file_key = kwargs["file_key"]
            record.file_size = kwargs["file_size"]
            record.mime_type = kwargs["mime_type"]
            record.is_public = kwargs["is_public"]
            record.status = "uploading"
            record.access_url = ""
            record.cdn_url = ""

            def mark_completed(access_url, cdn_url):
                record.status = "completed"
                record.access_url = access_url
                record.cdn_url = cdn_url

            record.mark_as_completed.side_effect = mark_completed
            return record

        file_records.create.side_effect = create_record

        results = [
            download_and_upload_from_url.run(
                f"https://provider.example/generated-{index}.png",
                object_key=object_key,
                is_public=True,
                enforce_public_read_acl=True,
            )
            for index, object_key in enumerate(object_keys)
        ]

        self.assertTrue(all(result["success"] for result in results))
        self.assertEqual(
            {object_key: object_acls[object_key] for object_key in object_keys},
            {object_key: "public-read" for object_key in object_keys},
        )


class StableObjectUploadReplayTest(TestCase):
    @patch("apps.services.common.url_security.ssrf_safe_request")
    def test_completed_stable_object_is_reused_without_redownload(self, request):
        from apps.services.oss.models import FileRecord
        from apps.services.oss.tasks import download_and_upload_from_url

        object_key = "media-gen/text2image/22222222/task-replay_0.png"
        record = FileRecord.objects.create(
            file_name="replay.png",
            file_key=object_key,
            file_key_hash=hashlib.sha256(object_key.encode()).hexdigest(),
            file_path="media-gen/text2image/22222222",
            file_size=4096,
            file_type="image",
            mime_type="image/png",
            file_extension="png",
            file_hash="replay-hash",
            bucket_name="test-bucket",
            access_url="https://oss.example/replay.png",
            status="completed",
        )

        result = download_and_upload_from_url.run(
            "https://provider.example/replay.png",
            object_key=object_key,
        )

        request.assert_not_called()
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["file_id"], str(record.id))

    def test_storage_recovery_is_registered_with_celery_beat(self):
        from apps.services.media_generation.tasks.polling import MEDIA_GENERATION_BEAT_SCHEDULE

        schedule = MEDIA_GENERATION_BEAT_SCHEDULE[
            "media-generation-recover-stale-storage"
        ]
        self.assertEqual(
            schedule["task"],
            "apps.services.media_generation.tasks.storage.recover_stale_media_storage",
        )
        self.assertEqual(schedule["schedule"], 300.0)

        artifact_schedule = MEDIA_GENERATION_BEAT_SCHEDULE[
            "media-generation-recover-artifact-delivery"
        ]
        self.assertEqual(
            artifact_schedule["task"],
            "apps.services.media_generation.tasks.storage.recover_media_artifact_delivery",
        )
        self.assertEqual(artifact_schedule["schedule"], 60.0)
