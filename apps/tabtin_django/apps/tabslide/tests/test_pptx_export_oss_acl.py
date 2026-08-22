from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.tabslide.services.slide_service import SlideService


class PPTXExportOSSACLTests(SimpleTestCase):
    def setUp(self):
        self.temp_dir = TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.pptx_path = Path(self.temp_dir.name) / "deck.pptx"
        self.pptx_path.write_bytes(b"pptx-content")

    @staticmethod
    def _successful_upload_result():
        return {
            "success": True,
            "data": {
                "access_url": "https://bucket.example/deck.pptx",
                "cdn_url": "",
            },
        }

    def test_successful_upload_sets_public_read_before_returning_url(self):
        oss = MagicMock()
        oss.config = {"access_mode": "private"}
        oss.upload_file.return_value = self._successful_upload_result()
        oss.set_object_public_read.return_value = True

        with patch(
            "apps.tabslide.services.slide_service._get_oss_service",
            return_value=oss,
        ):
            result = SlideService._upload_pptx_to_oss(
                str(self.pptx_path),
                "project-1",
            )

        self.assertEqual(result, "https://bucket.example/deck.pptx")
        object_key = oss.upload_file.call_args.args[1]
        oss.set_object_public_read.assert_called_once_with(object_key)
        oss.delete_file.assert_not_called()

    def test_upload_failure_does_not_attempt_acl_change(self):
        oss = MagicMock()
        oss.config = {"access_mode": "private"}
        oss.upload_file.return_value = {
            "success": False,
            "error_code": "AccessDenied",
            "message": "denied",
        }

        with patch(
            "apps.tabslide.services.slide_service._get_oss_service",
            return_value=oss,
        ):
            result = SlideService._upload_pptx_to_oss(
                str(self.pptx_path),
                "project-1",
            )

        self.assertIsNone(result)
        oss.set_object_public_read.assert_not_called()
        oss.delete_file.assert_not_called()

    def test_private_bucket_acl_failure_deletes_unusable_object(self):
        oss = MagicMock()
        oss.config = {"access_mode": "private"}
        oss.upload_file.return_value = self._successful_upload_result()
        oss.set_object_public_read.return_value = False
        oss.delete_file.return_value = {"success": True}

        with patch(
            "apps.tabslide.services.slide_service._get_oss_service",
            return_value=oss,
        ), patch(
            "apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file",
        ) as register_uploaded_file:
            result = SlideService._upload_pptx_to_oss(
                str(self.pptx_path),
                "project-1",
                organization_id="organization-1",
            )

        self.assertIsNone(result)
        object_key = oss.upload_file.call_args.args[1]
        oss.delete_file.assert_called_once_with(object_key)
        register_uploaded_file.assert_not_called()

    def test_private_bucket_cleanup_failure_is_logged(self):
        oss = MagicMock()
        oss.config = {"access_mode": "private"}
        oss.upload_file.return_value = self._successful_upload_result()
        oss.set_object_public_read.return_value = False
        oss.delete_file.return_value = {
            "success": False,
            "error_code": "AccessDenied",
            "message": "delete denied",
        }

        with patch(
            "apps.tabslide.services.slide_service._get_oss_service",
            return_value=oss,
        ), self.assertLogs(
            "apps.tabslide.services.slide_service",
            level="WARNING",
        ) as captured_logs:
            result = SlideService._upload_pptx_to_oss(
                str(self.pptx_path),
                "project-1",
            )

        self.assertIsNone(result)
        self.assertTrue(
            any("清理 ACL 失败的 PPTX 对象失败" in line for line in captured_logs.output)
        )

    def test_public_bucket_acl_failure_keeps_bucket_level_public_url(self):
        oss = MagicMock()
        oss.config = {"access_mode": "public-read"}
        oss.upload_file.return_value = self._successful_upload_result()
        oss.set_object_public_read.return_value = False

        with patch(
            "apps.tabslide.services.slide_service._get_oss_service",
            return_value=oss,
        ):
            result = SlideService._upload_pptx_to_oss(
                str(self.pptx_path),
                "project-1",
            )

        self.assertEqual(result, "https://bucket.example/deck.pptx")
        oss.delete_file.assert_not_called()
