import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.http import JsonResponse
from django.test import TestCase as DjangoTestCase

PDF_PREVIEW_MAX_BYTES = 100 * 1024 * 1024


def _response_body(response):
    return json.loads(response.content) if isinstance(response, JsonResponse) else response


class TabFilesDownloadUrlAuthTests(TestCase):
    def _request(self):
        return SimpleNamespace(auth=SimpleNamespace(id=uuid4()))

    @patch("apps.tabtinspace.routers.tabfiles.ContextItem")
    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_download_url_requires_space_viewer_permission(
        self,
        mock_service_cls,
        mock_context_item,
    ):
        from apps.tabtinspace.routers.tabfiles import get_file_download_url

        mock_service = MagicMock()
        mock_service.check_space_permission.return_value = False
        mock_service_cls.return_value = mock_service

        response = get_file_download_url(self._request(), uuid4(), uuid4())

        self.assertEqual(response.status_code, 403)
        mock_context_item.objects.filter.assert_not_called()
        mock_service_cls.get_download_url.assert_not_called()

    @patch("apps.tabtinspace.routers.tabfiles.ContextItem")
    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_download_url_returns_signed_url_for_authorized_viewer(
        self,
        mock_service_cls,
        mock_context_item,
    ):
        from apps.tabtinspace.routers.tabfiles import get_file_download_url

        file_record_id = uuid4()
        mock_service = MagicMock()
        mock_service.check_space_permission.return_value = True
        mock_service_cls.return_value = mock_service
        mock_context_item.objects.filter.return_value.first.return_value = SimpleNamespace(
            resource_id=str(file_record_id),
            metadata={"file_name": "report.pdf", "mime_type": "application/pdf", "file_size": 1234},
            title="fallback.pdf",
        )
        mock_service_cls.get_download_url.return_value = "https://oss.example/signed"
        mock_service_cls.get_file_size.return_value = 1234

        response = get_file_download_url(self._request(), uuid4(), uuid4())

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["url"], "https://oss.example/signed")
        self.assertEqual(response["data"]["file_name"], "report.pdf")
        self.assertEqual(response["data"]["file_size"], 1234)
        mock_service.check_space_permission.assert_called_once()
        mock_service_cls.get_download_url.assert_called_once_with(
            file_record_id,
            as_attachment=True,
        )
        mock_service_cls.get_file_size.assert_called_once_with(file_record_id)

    @patch("apps.tabtinspace.routers.tabfiles.ContextItem")
    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_pdf_exactly_at_preview_limit_still_gets_signed_url(
        self,
        mock_service_cls,
        mock_context_item,
    ):
        from apps.tabtinspace.routers.tabfiles import get_file_download_url

        file_record_id = uuid4()
        mock_service = MagicMock()
        mock_service.check_space_permission.return_value = True
        mock_service_cls.return_value = mock_service
        mock_context_item.objects.filter.return_value.first.return_value = SimpleNamespace(
            resource_id=str(file_record_id),
            metadata={"file_name": "boundary.pdf", "mime_type": "application/pdf"},
            title="boundary.pdf",
        )
        mock_service_cls.get_file_size.return_value = PDF_PREVIEW_MAX_BYTES
        mock_service_cls.get_download_url.return_value = "https://oss.example/signed"

        response = get_file_download_url(
            self._request(),
            uuid4(),
            uuid4(),
            preview_max_bytes=PDF_PREVIEW_MAX_BYTES,
        )

        self.assertTrue(response["data"]["preview_eligible"])
        self.assertEqual(response["data"]["url"], "https://oss.example/signed")
        mock_service_cls.get_download_url.assert_called_once_with(
            file_record_id,
            as_attachment=False,
        )

    @patch(
        "apps.tabtinspace.services.cloud_resource_acl.check_item_resource_permission",
        return_value=True,
    )
    @patch("apps.tabtinspace.routers.tabfiles.ContextItem")
    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_small_markdown_with_generic_stored_mime_is_previewable(
        self,
        mock_service_cls,
        mock_context_item,
        _mock_resource_permission,
    ):
        from apps.tabtinspace.routers.tabfiles import get_file_download_url

        file_record_id = uuid4()
        mock_service = MagicMock()
        mock_service.check_space_permission.return_value = True
        mock_service_cls.return_value = mock_service
        mock_context_item.objects.get.return_value = SimpleNamespace(
            resource_id=str(file_record_id),
            metadata={
                "file_name": "T12_cloud_drive_marker_20260807.md",
                "mime_type": "application/octet-stream",
            },
            title="T12_cloud_drive_marker_20260807.md",
        )
        mock_service_cls.get_file_size.return_value = 345
        mock_service_cls.get_download_url.return_value = "https://oss.example/signed"

        response = _response_body(
            get_file_download_url(
                self._request(),
                uuid4(),
                uuid4(),
                preview_max_bytes=1024,
            )
        )

        self.assertTrue(response["data"]["preview_eligible"])
        self.assertTrue(response["data"]["mime_preview_safe"])
        self.assertEqual(response["data"]["mime_type"], "application/octet-stream")
        self.assertEqual(response["data"]["url"], "https://oss.example/signed")
        mock_service_cls.get_download_url.assert_called_once_with(
            file_record_id,
            as_attachment=False,
        )

    @patch("apps.tabtinspace.routers.tabfiles.ContextItem")
    @patch("apps.tabtinspace.routers.tabfiles.TabFilesService")
    def test_pdf_over_preview_limit_does_not_generate_signed_url(
        self,
        mock_service_cls,
        mock_context_item,
    ):
        from apps.tabtinspace.routers.tabfiles import get_file_download_url

        file_record_id = uuid4()
        mock_service = MagicMock()
        mock_service.check_space_permission.return_value = True
        mock_service_cls.return_value = mock_service
        mock_context_item.objects.filter.return_value.first.return_value = SimpleNamespace(
            resource_id=str(file_record_id),
            metadata={"file_name": "oversize.pdf", "mime_type": "application/pdf"},
            title="oversize.pdf",
        )
        mock_service_cls.get_file_size.return_value = PDF_PREVIEW_MAX_BYTES + 1

        response = get_file_download_url(
            self._request(),
            uuid4(),
            uuid4(),
            preview_max_bytes=PDF_PREVIEW_MAX_BYTES,
        )

        self.assertFalse(response["data"]["preview_eligible"])
        self.assertEqual(response["data"]["url"], "")
        mock_service_cls.get_download_url.assert_not_called()

    @patch("apps.services.oss.services.factory.get_oss_service")
    @patch("apps.tabtinspace.services.tabfiles_service.FileRecord")
    def test_explicit_download_signature_forces_attachment(
        self,
        mock_file_record,
        mock_get_oss_service,
    ):
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        mock_file_record.objects.get.return_value = SimpleNamespace(
            file_key='tabfiles/random.exe',
            file_name='installer.exe',
        )
        oss = MagicMock()
        oss.generate_presigned_url.return_value = 'https://oss.example/signed'
        mock_get_oss_service.return_value = oss

        url = TabFilesService.get_download_url(uuid4(), as_attachment=True)

        self.assertEqual(url, 'https://oss.example/signed')
        call_kwargs = oss.generate_presigned_url.call_args.kwargs
        self.assertEqual(call_kwargs['expiration'], 3600)
        self.assertTrue(
            call_kwargs['response_content_disposition'].startswith('attachment;'),
        )


class TabFilesUploadScopeTests(TestCase):
    def _service(self, user_id: str | None = None):
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        return TabFilesService(user=SimpleNamespace(id=user_id or uuid4()))

    def test_file_record_with_organization_must_match_target_space_organization(self):
        from apps.tabtinspace.services.base import ServiceError

        service = self._service()
        file_record = SimpleNamespace(
            organization_id=str(uuid4()),
            upload_user=str(service.user.id),
        )
        space = SimpleNamespace(organization_id=str(uuid4()))

        with self.assertRaises(ServiceError) as ctx:
            service._assert_file_record_scope(file_record, space)

        self.assertEqual(ctx.exception.code, "FILE_ACCESS_DENIED")
        self.assertEqual(ctx.exception.status, 403)

    def test_file_record_with_matching_organization_can_be_mounted_by_space_editor(self):
        organization_id = str(uuid4())
        service = self._service()
        file_record = SimpleNamespace(
            organization_id=organization_id,
            upload_user=str(uuid4()),
        )
        space = SimpleNamespace(organization_id=organization_id)

        service._assert_file_record_scope(file_record, space)

    def test_legacy_file_without_organization_requires_current_uploader(self):
        service = self._service()
        file_record = SimpleNamespace(
            organization_id="",
            upload_user=str(service.user.id),
        )
        space = SimpleNamespace(organization_id=str(uuid4()))

        service._assert_file_record_scope(file_record, space)

    @patch("apps.tabtinspace.services.tabfiles_service.FileUsage")
    @patch("apps.tabtinspace.services.tabfiles_service.ContextItem")
    @patch("apps.tabtinspace.services.tabfiles_service.FileRecord")
    @patch("apps.tabtinspace.services.tabfiles_service.Project")
    @patch("apps.tabtinspace.services.tabfiles_service.Workspace")
    def test_upload_to_space_rejects_cross_organization_file_before_creating_item(
        self,
        mock_workspace_cls,
        mock_project_cls,
        mock_file_record_cls,
        mock_context_item_cls,
        mock_file_usage_cls,
    ):
        from apps.tabtinspace.services.base import ServiceError

        service = self._service()
        service.check_space_permission = MagicMock(return_value=True)
        mock_workspace_cls.objects.filter.return_value.first.return_value = SimpleNamespace(
            organization_id=str(uuid4()),
        )
        mock_project_cls.objects.filter.return_value.first.return_value = None
        mock_file_record_cls.objects.get.return_value = SimpleNamespace(
            organization_id=str(uuid4()),
            upload_user=str(service.user.id),
        )

        with self.assertRaises(ServiceError) as ctx:
            service.upload_to_space.__wrapped__(
                service,
                space_id=uuid4(),
                file_record_id=uuid4(),
            )

        self.assertEqual(ctx.exception.code, "FILE_ACCESS_DENIED")
        mock_context_item_cls.objects.create.assert_not_called()
        mock_file_usage_cls.add_usage.assert_not_called()


class TabFilesUploadScopeIntegrationTests(DjangoTestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization

        cls._post_save = post_save
        cls._create_default_organization = create_default_organization
        post_save.disconnect(create_default_organization, sender=get_user_model())

    @classmethod
    def tearDownClass(cls):
        cls._post_save.connect(cls._create_default_organization, sender=get_user_model())
        super().tearDownClass()

    def setUp(self):
        from apps.tabtinspace.models import (
            Organization,
            OrganizationMember,
            Project,
            ProjectMembership,
        )

        User = get_user_model()
        self.user = User.objects.create_user(
            phone=f"+86138{uuid4().int % 100000000:08d}",
            password="x",
            nickname="tabfiles",
        )
        self.other_user_id = str(uuid4())

        self.organization = Organization.objects.create(
            name="TabFiles Auth Team",
            owner=self.user,
            type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.user.id),
            role="editor",
        )
        # ：团队云盘宿主为 Project，不再创建退役 Space 壳
        self.space = Project.objects.create(
            organization=self.organization,
            name="TabFiles Auth Project",
            status="active",
        )
        ProjectMembership.objects.create(
            project=self.space,
            user=self.user,
            role="editor",
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        )

        self.other_organization = Organization.objects.create(
            name="Other Team",
            owner=self.user,
            type="team",
        )

    def _file_record(self, *, organization_id: str, upload_user: str):
        from apps.services.oss.models import FileRecord

        suffix = uuid4().hex
        return FileRecord.objects.create(
            file_name=f"{suffix}.txt",
            file_key=f"tabfiles/{suffix}.txt",
            file_path=f"/tmp/{suffix}.txt",
            file_size=16,
            file_type="document",
            mime_type="text/plain",
            file_extension=".txt",
            file_hash=suffix,
            bucket_name="test-bucket",
            upload_user=upload_user,
            organization_id=organization_id,
            status="completed",
        )

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector")
    def test_space_editor_can_mount_file_from_same_organization(self, _mock_update_search):
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        file_record = self._file_record(
            organization_id=str(self.organization.id),
            upload_user=self.other_user_id,
        )

        item = TabFilesService(user=self.user).upload_to_space(
            space_id=self.space.id,
            file_record_id=file_record.id,
        )

        self.assertEqual(item.space_id, self.space.id)
        self.assertEqual(item.resource_id, str(file_record.id))

    def test_space_editor_cannot_mount_file_from_other_organization(self):
        from apps.tabtinspace.services.base import ServiceError
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        file_record = self._file_record(
            organization_id=str(self.other_organization.id),
            upload_user=str(self.user.id),
        )

        with self.assertRaises(ServiceError) as ctx:
            TabFilesService(user=self.user).upload_to_space(
                space_id=self.space.id,
                file_record_id=file_record.id,
            )

        self.assertEqual(ctx.exception.code, "FILE_ACCESS_DENIED")

    def test_space_editor_cannot_mount_legacy_file_uploaded_by_someone_else(self):
        from apps.tabtinspace.services.base import ServiceError
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        file_record = self._file_record(
            organization_id="",
            upload_user=self.other_user_id,
        )

        with self.assertRaises(ServiceError) as ctx:
            TabFilesService(user=self.user).upload_to_space(
                space_id=self.space.id,
                file_record_id=file_record.id,
            )

        self.assertEqual(ctx.exception.code, "FILE_ACCESS_DENIED")
