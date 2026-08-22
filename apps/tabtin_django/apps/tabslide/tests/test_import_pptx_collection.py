import json
from types import SimpleNamespace
from unittest.mock import MagicMock, mock_open, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabslide import api as slide_api
from apps.tabslide.tasks import import_pptx_oss_task, import_pptx_task


class ImportPptxCollectionTests(SimpleTestCase):
    def setUp(self):
        self.organization_id = str(uuid4())
        self.space_id = str(uuid4())
        self.collection_id = uuid4()
        self.request = SimpleNamespace(auth=SimpleNamespace(id=uuid4()))

    @staticmethod
    def _file():
        uploaded = MagicMock()
        uploaded.name = "deck.pptx"
        uploaded.size = 128
        uploaded.read.return_value = b"PK\x03\x04"
        uploaded.chunks.return_value = [b"PK\x03\x04payload"]
        return uploaded

    @staticmethod
    def _object_key():
        return f"temp-parse/tabslide-import/{uuid4().hex}.pptx"

    def test_valid_collection_is_forwarded_to_background_task(self):
        collection_query = MagicMock()
        collection_query.exists.return_value = True
        service = MagicMock()
        service.check_space_permission.return_value = True
        oss_service = MagicMock()
        oss_service.upload_file.return_value = {"success": True, "data": {}}
        task_result = MagicMock(id="task-with-collection")

        with patch("apps.tabslide.api.ensure_space_in_organization"), \
             patch.object(slide_api.Collection.objects, "filter", return_value=collection_query), \
             patch("apps.tabslide.api._build_service", return_value=service), \
             patch(
                 "apps.services.oss.services.factory.get_oss_service",
                 return_value=oss_service,
             ), \
             patch("apps.tabslide.tasks.import_pptx_oss_task.delay", return_value=task_result) as delay:
            response = slide_api.import_pptx(
                self.request,
                organization_id=self.organization_id,
                space_id=self.space_id,
                collection_id=self.collection_id,
                file=self._file(),
            )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["task_id"], "task-with-collection")
        self.assertEqual(delay.call_args.kwargs["collection_id"], str(self.collection_id))
        self.assertTrue(
            delay.call_args.kwargs["object_key"].startswith(
                "temp-parse/tabslide-import/"
            )
        )
        oss_service.upload_file.assert_called_once()

    def test_staging_failure_is_reported_and_partial_object_is_cleaned(self):
        service = MagicMock()
        service.check_space_permission.return_value = True
        oss_service = MagicMock()
        oss_service.upload_file.return_value = {
            "success": False,
            "message": "staging unavailable",
        }

        with patch("apps.tabslide.api.ensure_space_in_organization"), \
             patch("apps.tabslide.api._build_service", return_value=service), \
             patch(
                 "apps.services.oss.services.factory.get_oss_service",
                 return_value=oss_service,
             ), \
             patch("apps.tabslide.tasks.import_pptx_oss_task.delay") as delay:
            response = slide_api.import_pptx(
                self.request,
                organization_id=self.organization_id,
                space_id=self.space_id,
                file=self._file(),
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            json.loads(response.content)["message"],
            "文件暂存失败，请稍后重试",
        )
        oss_service.delete_file.assert_called_once()
        delay.assert_not_called()

    def test_oss_service_initialization_failure_returns_import_error(self):
        service = MagicMock()
        service.check_space_permission.return_value = True

        with patch("apps.tabslide.api.ensure_space_in_organization"), \
             patch("apps.tabslide.api._build_service", return_value=service), \
             patch(
                 "apps.services.oss.services.factory.get_oss_service",
                 side_effect=RuntimeError("OSS is unavailable"),
             ), \
             patch("apps.tabslide.tasks.import_pptx_oss_task.delay") as delay:
            response = slide_api.import_pptx(
                self.request,
                organization_id=self.organization_id,
                space_id=self.space_id,
                file=self._file(),
            )

        self.assertEqual(response.status_code, 400)
        self.assertNotIn("OSS is unavailable", response.content.decode())
        delay.assert_not_called()

    def test_dispatch_failure_is_generic_and_staged_object_is_cleaned(self):
        service = MagicMock()
        service.check_space_permission.return_value = True
        oss_service = MagicMock()
        oss_service.upload_file.return_value = {"success": True, "data": {}}
        oss_service.delete_file.return_value = {"success": True, "data": {}}

        with patch("apps.tabslide.api.ensure_space_in_organization"), \
             patch("apps.tabslide.api._build_service", return_value=service), \
             patch(
                 "apps.services.oss.services.factory.get_oss_service",
                 return_value=oss_service,
             ), \
             patch(
                 "apps.tabslide.tasks.import_pptx_oss_task.delay",
                 side_effect=RuntimeError("broker host is secret"),
             ):
            with self.assertLogs("apps.tabslide.api", level="INFO") as logs:
                response = slide_api.import_pptx(
                    self.request,
                    organization_id=self.organization_id,
                    space_id=self.space_id,
                    file=self._file(),
                )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            json.loads(response.content)["message"],
            "PPTX 导入任务派发失败，请稍后重试",
        )
        self.assertNotIn("broker host is secret", response.content.decode())
        self.assertNotIn("broker host is secret", "\n".join(logs.output))
        self.assertIn("stage=staging", "\n".join(logs.output))
        oss_service.delete_file.assert_called_once()

    def test_foreign_collection_is_rejected_before_task_dispatch(self):
        collection_query = MagicMock()
        collection_query.exists.return_value = False
        service = MagicMock()
        service.check_space_permission.return_value = True

        with patch("apps.tabslide.api.ensure_space_in_organization"), \
             patch.object(slide_api.Collection.objects, "filter", return_value=collection_query), \
             patch("apps.tabslide.api._build_service", return_value=service), \
             patch("apps.tabslide.tasks.import_pptx_oss_task.delay") as delay:
            response = slide_api.import_pptx(
                self.request,
                organization_id=self.organization_id,
                space_id=self.space_id,
                collection_id=self.collection_id,
                file=self._file(),
            )

        self.assertEqual(response.status_code, 404)
        delay.assert_not_called()

    def test_permission_is_checked_before_collection_existence(self):
        service = MagicMock()
        service.check_space_permission.return_value = False

        with patch("apps.tabslide.api.ensure_space_in_organization"), \
             patch("apps.tabslide.api._build_service", return_value=service), \
             patch.object(slide_api.Collection.objects, "filter") as collection_filter:
            response = slide_api.import_pptx(
                self.request,
                organization_id=self.organization_id,
                space_id=self.space_id,
                collection_id=self.collection_id,
                file=self._file(),
            )

        self.assertEqual(response.status_code, 403)
        collection_filter.assert_not_called()

    def test_background_task_forwards_collection_to_slide_service(self):
        user_model = MagicMock()
        user_model.objects.get.return_value = self.request.auth
        service = MagicMock()
        service.import_pptx.return_value = (SimpleNamespace(id=uuid4()), [])
        service.get_font_meta.return_value = {}
        file_handle = mock_open(read_data=b"pptx")
        file_handle.return_value.read.side_effect = [b"pptx", b""]
        oss_service = MagicMock()
        oss_service.download_file.return_value = {"success": True, "data": {}}
        oss_service.delete_file.return_value = {"success": True, "data": {}}
        object_key = self._object_key()
        cache_set = MagicMock()

        with patch("django.contrib.auth.get_user_model", return_value=user_model), \
             patch("apps.tabslide.services.slide_service.SlideService", return_value=service), \
             patch(
                 "apps.services.oss.services.factory.get_oss_service",
                 return_value=oss_service,
             ), \
             patch("builtins.open", file_handle), \
             patch("django.core.cache.cache.set", cache_set), \
             patch("apps.tabslide.tasks.os.unlink"):
            import_pptx_oss_task.run(
                organization_id=self.organization_id,
                space_id=self.space_id,
                file_name="deck.pptx",
                user_id=str(self.request.auth.id),
                collection_id=str(self.collection_id),
                object_key=object_key,
            )

        self.assertEqual(
            service.import_pptx.call_args.kwargs["collection_id"],
            str(self.collection_id),
        )
        oss_service.download_file.assert_called_once()
        oss_service.delete_file.assert_called_once_with(object_key)
        progress_stages = [
            call.args[1]["stage"]
            for call in cache_set.call_args_list
            if call.args[1].get("status") == "processing"
        ]
        self.assertEqual(progress_stages, ["validating", "downloading", "parsing"])

    def test_new_task_rejects_object_outside_tabslide_temp_prefix(self):
        with patch(
            "apps.services.oss.services.factory.get_oss_service"
        ) as get_oss_service, patch("django.core.cache.cache.set") as cache_set:
            with self.assertRaisesRegex(RuntimeError, "PPTX import failed"):
                import_pptx_oss_task.run(
                    organization_id=self.organization_id,
                    space_id=self.space_id,
                    file_name="deck.pptx",
                    user_id=str(self.request.auth.id),
                    object_key="persistent/user/report.pptx",
                )

        get_oss_service.assert_not_called()
        failed_payload = cache_set.call_args_list[-1].args[1]
        self.assertEqual(failed_payload["status"], "failed")
        self.assertEqual(failed_payload["error"], "PPTX 导入失败，请稍后重试")

    def test_download_failure_cleans_local_and_staged_objects(self):
        oss_service = MagicMock()
        oss_service.download_file.return_value = {
            "success": False,
            "message": "internal endpoint detail",
        }
        oss_service.delete_file.return_value = {"success": True}
        object_key = self._object_key()

        with patch(
            "apps.services.oss.services.factory.get_oss_service",
            return_value=oss_service,
        ), patch("django.core.cache.cache.set") as cache_set, patch(
            "apps.tabslide.tasks.os.unlink"
        ) as unlink:
            with self.assertLogs("apps.tabslide.tasks", level="INFO") as logs:
                with self.assertRaisesRegex(RuntimeError, "PPTX import failed"):
                    import_pptx_oss_task.run(
                        organization_id=self.organization_id,
                        space_id=self.space_id,
                        file_name="deck.pptx",
                        user_id=str(self.request.auth.id),
                        object_key=object_key,
                    )

        unlink.assert_called_once()
        oss_service.delete_file.assert_called_once_with(object_key)
        failed_payload = cache_set.call_args_list[-1].args[1]
        self.assertEqual(failed_payload["error"], "PPTX 导入失败，请稍后重试")
        self.assertNotIn("internal endpoint detail", "\n".join(logs.output))
        self.assertIn("stage=downloading", "\n".join(logs.output))

    def test_legacy_task_keeps_file_path_contract(self):
        with patch("apps.tabslide.tasks._execute_import_pptx_task") as execute:
            import_pptx_task.run(
                file_path="C:/temp/legacy.pptx",
                organization_id=self.organization_id,
                space_id=self.space_id,
                file_name="legacy.pptx",
                user_id=str(self.request.auth.id),
                collection_id=str(self.collection_id),
            )

        self.assertEqual(execute.call_args.kwargs["file_path"], "C:/temp/legacy.pptx")
        self.assertNotIn("object_key", execute.call_args.kwargs)
