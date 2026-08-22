import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse

from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from apps.services.common.exceptions import OSSServiceException

from .services.local_file_oss import LocalFileOSSService
from .models import FileRecord


class FileAccessResolverTests(SimpleTestCase):
    def setUp(self):
        self.owner = SimpleNamespace(id="owner")
        self.record = SimpleNamespace(
            id="file-id",
            file_key="private/demo.txt",
            access_url="https://bucket.example/private/demo.txt",
            cdn_url="https://cdn.example/private/demo.txt",
            is_public=False,
            upload_user="owner",
            organization_id="organization-a",
        )

    @patch("apps.chat.conversation.api._common.user_can_access_session", return_value=True)
    @patch("apps.chat.conversation.models.ChatMessage.objects")
    @patch("apps.services.oss.models.FileUsage.objects")
    @patch("apps.tabdata.services.attachment_service.AttachmentService")
    def test_shared_chat_message_reference_authorizes_private_file(
        self,
        attachment_service,
        file_usages,
        chat_messages,
        user_can_access_session,
    ):
        from apps.services.oss.api import _check_business_resource_file_access

        attachment_service.return_value.can_access_existing_reference.return_value = False
        file_usages.filter.return_value.exclude.return_value.values_list.return_value = ["message-1"]
        chat_messages.filter.return_value.values_list.return_value.distinct.return_value = ["session-1"]
        collaborator = SimpleNamespace(id="collaborator")

        self.assertTrue(_check_business_resource_file_access(self.record, collaborator))
        user_can_access_session.assert_called_once_with("session-1", collaborator)

    @patch("apps.chat.conversation.api._common.user_can_access_session", return_value=False)
    @patch("apps.chat.conversation.models.ChatMessage.objects")
    @patch("apps.services.oss.models.FileUsage.objects")
    @patch("apps.tabdata.services.attachment_service.AttachmentService")
    def test_unshared_chat_message_reference_does_not_authorize_private_file(
        self,
        attachment_service,
        file_usages,
        chat_messages,
        user_can_access_session,
    ):
        from apps.services.oss.api import _check_business_resource_file_access

        attachment_service.return_value.can_access_existing_reference.return_value = False
        file_usages.filter.return_value.exclude.return_value.values_list.return_value = ["message-1"]
        chat_messages.filter.return_value.values_list.return_value.distinct.return_value = ["session-1"]
        stranger = SimpleNamespace(id="stranger")

        self.assertFalse(_check_business_resource_file_access(self.record, stranger))
        user_can_access_session.assert_called_once_with("session-1", stranger)

    @patch("apps.services.oss.services.file_access.is_organization_member", return_value=True)
    @patch(
        "apps.services.oss.services.file_access.build_public_asset_url",
        return_value="https://public.example/public/demo.txt",
    )
    def test_public_file_returns_stable_url_without_expiry(self, _public_url, _membership):
        from .services.file_access import resolve_file_access

        self.record.is_public = True
        self.record.access_url = ""
        result = resolve_file_access(self.record, self.owner, oss_service=Mock())

        self.assertEqual(result.url, "https://public.example/public/demo.txt")
        self.assertEqual(result.access_mode, "public")
        self.assertIsNone(result.expires_at)
        self.assertIsNone(result.expires_in)

    @patch("apps.services.oss.services.file_access.is_organization_member", return_value=True)
    def test_private_file_returns_signed_url_and_ttl(self, _membership):
        from .services.file_access import resolve_file_access

        oss_service = Mock()
        oss_service.config = {"access_mode": "public-read"}
        oss_service.generate_presigned_url.return_value = "https://bucket.example/signed?token=secret"
        before = timezone.now()
        result = resolve_file_access(self.record, self.owner, expiration=900, oss_service=oss_service)

        self.assertEqual(result.url, "https://bucket.example/signed?token=secret")
        self.assertEqual(result.access_mode, "signed")
        self.assertEqual(result.expires_in, 900)
        self.assertGreaterEqual(result.expires_at, before)
        self.assertLessEqual(result.expires_at, timezone.now() + timezone.timedelta(seconds=900))
        oss_service.generate_presigned_url.assert_called_once_with(
            self.record.file_key,
            expiration=900,
            method="GET",
        )
        oss_service.get_accessible_url.assert_not_called()

    @patch("apps.services.oss.services.file_access.is_organization_member", return_value=True)
    def test_private_file_never_prefers_bare_cdn_url(self, _membership):
        from .services.file_access import resolve_file_access

        oss_service = Mock()
        oss_service.generate_presigned_url.return_value = "https://bucket.example/signed?token=secret"
        result = resolve_file_access(self.record, self.owner, oss_service=oss_service)

        self.assertNotEqual(result.url, self.record.cdn_url)
        self.assertEqual(result.url, "https://bucket.example/signed?token=secret")

    @patch("apps.services.oss.services.file_access.is_organization_member", return_value=False)
    def test_cross_organization_private_file_is_hidden(self, _membership):
        from .services.file_access import FileAccessNotFound, resolve_file_access

        with self.assertRaises(FileAccessNotFound):
            resolve_file_access(self.record, self.owner, oss_service=Mock())

    @patch("apps.services.oss.services.file_access.is_organization_member", return_value=True)
    def test_non_owner_private_file_is_hidden(self, _membership):
        from .services.file_access import FileAccessNotFound, resolve_file_access

        with self.assertRaises(FileAccessNotFound):
            resolve_file_access(self.record, SimpleNamespace(id="other"), oss_service=Mock())

    @patch("apps.services.oss.services.file_access.is_organization_member", return_value=True)
    def test_old_client_can_resolve_business_authorized_private_file(self, _membership):
        from .services.file_access import resolve_file_access

        oss_service = Mock()
        oss_service.generate_presigned_url.return_value = "https://bucket.example/signed?token=collaborator"
        collaborator = SimpleNamespace(id="collaborator")

        result = resolve_file_access(
            self.record,
            collaborator,
            oss_service=oss_service,
            business_access_checker=lambda file_record, user: (
                file_record is self.record and user is collaborator
            ),
        )

        self.assertEqual(result.url, "https://bucket.example/signed?token=collaborator")

    def test_authorized_business_resource_can_use_shared_delivery_core(self):
        """业务域完成授权后，共用层只负责安全交付，不重复套上传者规则。"""
        from .services.file_access import resolve_authorized_file

        oss_service = Mock()
        oss_service.generate_presigned_url.return_value = "https://bucket.example/signed?token=business"

        result = resolve_authorized_file(
            self.record,
            expiration=600,
            oss_service=oss_service,
        )

        self.assertEqual(result.url, "https://bucket.example/signed?token=business")
        self.assertEqual(result.access_mode, "signed")
        self.assertEqual(result.expires_in, 600)


class LocalPrivateFileAccessTests(SimpleTestCase):
    def test_local_signature_expires_at_declared_ttl(self):
        from django.core.signing import TimestampSigner
        from .api import _verify_local_oss_signature

        with patch("django.core.signing.time.time", return_value=1_000):
            signature = TimestampSigner().sign("GET:private/demo.txt:300")
        with patch("django.core.signing.time.time", return_value=1_301):
            self.assertFalse(_verify_local_oss_signature(
                "private/demo.txt",
                "GET",
                signature,
                300,
            ))

    def test_local_accessible_url_is_signed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local-dev",
                "root_path": temp_dir,
                "public_base_url": "http://127.0.0.1:6060/api/services/oss/local-object",
                "upload_base_url": "http://127.0.0.1:6060/api/services/oss/local-upload",
                "access_mode": "public-read",
            })

            accessible_url = service.get_accessible_url("private/demo.txt", expiration=300)
            params = parse_qs(urlparse(accessible_url).query)

        self.assertEqual(params["method"], ["GET"])
        self.assertEqual(params["expires"], ["300"])
        self.assertIn("signature", params)

    def test_local_presign_rejects_unsupported_write_methods(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local-dev",
                "root_path": temp_dir,
                "public_base_url": "http://127.0.0.1:6060/api/services/oss/local-object",
                "upload_base_url": "http://127.0.0.1:6060/api/services/oss/local-upload",
                "access_mode": "public-read",
            })

            with self.assertRaises(OSSServiceException):
                service.generate_presigned_url("private/demo.txt", method="DELETE")

    @override_settings(SERVICES_OSS_PROVIDER="local")
    def test_local_private_signed_get_passes_signature_gate(self):
        from .api import local_object

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local-dev",
                "root_path": temp_dir,
                "public_base_url": "http://127.0.0.1:6060/api/services/oss/local-object",
                "upload_base_url": "http://127.0.0.1:6060/api/services/oss/local-upload",
                "access_mode": "public-read",
            })
            service.upload_bytes(b"private", "private/demo.txt", content_type="text/plain")
            signed_url = service.generate_presigned_url("private/demo.txt", expiration=300, method="GET")
            params = parse_qs(urlparse(signed_url).query)
            request = RequestFactory().get("/api/services/oss/local-object", data={
                key: values[0] for key, values in params.items()
            })

            private_record = Mock()
            private_record.is_public = False
            with patch("apps.services.oss.api.FileRecord.objects.filter") as file_filter, \
                    patch("apps.services.oss.api.get_oss_service", return_value=service):
                file_filter.return_value.only.return_value.first.return_value = private_record
                response = local_object(
                    request,
                    object_key=params["object_key"][0],
                    method=params["method"][0],
                    expires=int(params["expires"][0]),
                    signature=params["signature"][0],
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"private")
        self.assertEqual(response["Cache-Control"], "private, no-store")

    @override_settings(SERVICES_OSS_PROVIDER="local")
    def test_local_public_attachment_keeps_immutable_cache_policy(self):
        from .api import local_object

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local-dev",
                "root_path": temp_dir,
                "public_base_url": "http://127.0.0.1:6060/api/services/oss/local-object",
                "upload_base_url": "http://127.0.0.1:6060/api/services/oss/local-upload",
                "access_mode": "public-read",
            })
            service.upload_bytes(b"public", "public/demo.txt", content_type="text/plain")
            with patch("apps.services.oss.api.FileRecord.objects.filter") as file_filter, \
                    patch("apps.services.oss.api.get_oss_service", return_value=service):
                file_filter.return_value.only.return_value.first.return_value = None
                response = local_object(
                    RequestFactory().get("/api/services/oss/local-object"),
                    object_key="public/demo.txt",
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "private, max-age=604800, immutable")

    @override_settings(SERVICES_OSS_PROVIDER="local")
    def test_local_private_html_keeps_no_store_cache_policy(self):
        from .api import local_object

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local-dev",
                "root_path": temp_dir,
                "public_base_url": "http://127.0.0.1:6060/api/services/oss/local-object",
                "upload_base_url": "http://127.0.0.1:6060/api/services/oss/local-upload",
                "access_mode": "public-read",
            })
            object_key = "tabdoc/html/private-demo.html"
            service.upload_bytes(b"<p>private</p>", object_key, content_type="text/html")
            signed_url = service.generate_presigned_url(object_key, expiration=300, method="GET")
            params = parse_qs(urlparse(signed_url).query)
            private_record = Mock(is_public=False)
            with patch("apps.services.oss.api.FileRecord.objects.filter") as file_filter, \
                    patch("apps.services.oss.api.get_oss_service", return_value=service):
                file_filter.return_value.only.return_value.first.return_value = private_record
                response = local_object(
                    RequestFactory().get("/api/services/oss/local-object"),
                    object_key=params["object_key"][0],
                    method=params["method"][0],
                    expires=int(params["expires"][0]),
                    signature=params["signature"][0],
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "private, no-store")

    @override_settings(SERVICES_OSS_PROVIDER="local")
    def test_local_private_signature_rejects_tampered_ttl(self):
        from .api import local_object

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local-dev",
                "root_path": temp_dir,
                "public_base_url": "http://127.0.0.1:6060/api/services/oss/local-object",
                "upload_base_url": "http://127.0.0.1:6060/api/services/oss/local-upload",
                "access_mode": "public-read",
            })
            service.upload_bytes(b"private", "private/demo.txt", content_type="text/plain")
            signed_url = service.generate_presigned_url("private/demo.txt", expiration=300, method="GET")
            params = parse_qs(urlparse(signed_url).query)

            private_record = Mock()
            private_record.is_public = False
            with patch("apps.services.oss.api.FileRecord.objects.filter") as file_filter, \
                    patch("apps.services.oss.api.get_oss_service", return_value=service):
                file_filter.return_value.only.return_value.first.return_value = private_record
                response = local_object(
                    RequestFactory().get("/api/services/oss/local-object"),
                    object_key=params["object_key"][0],
                    method=params["method"][0],
                    expires=86400,
                    signature=params["signature"][0],
                )

        self.assertEqual(response.status_code, 404)


class FileInfoAccessibleUrlApiTests(TestCase):
    databases = "__all__"

    def setUp(self):
        self.client = Client()
        self.user = SimpleNamespace(id="owner", username="owner")
        self.record = FileRecord.objects.create(
            file_name="demo.txt",
            file_key="private/demo.txt",
            file_path="/private/",
            file_size=7,
            file_type="document",
            mime_type="text/plain",
            file_extension="txt",
            file_hash="a" * 32,
            bucket_name="test-bucket",
            organization_id="organization-a",
            upload_user="owner",
            status="completed",
            is_public=False,
            access_url="https://bucket.example/private/demo.txt",
            cdn_url="https://cdn.example/private/demo.txt",
        )

    def test_private_file_info_returns_signed_compatibility_urls_and_metadata(self):
        oss_service = Mock()
        oss_service.generate_presigned_url.return_value = "https://bucket.example/signed?token=secret"
        with patch("apps.users.auth.permissions.JWTAuth.__call__", return_value=self.user), \
                patch("apps.services.oss.api._check_organization_membership", return_value=True), \
                patch("apps.services.oss.services.file_access.get_oss_service", return_value=oss_service):
            response = self.client.get(
                f"/api/services/oss/files/{self.record.id}",
                HTTP_AUTHORIZATION="Bearer fake-token",
            )

        payload = response.json()
        self.assertTrue(payload["success"], payload)
        data = payload["data"]
        self.assertEqual(data["access_url"], "https://bucket.example/signed?token=secret")
        self.assertEqual(data["cdn_url"], "")
        self.assertEqual(data["resolved_url"], "https://bucket.example/signed?token=secret")
        self.assertEqual(data["access_mode"], "signed")
        self.assertEqual(data["expires_in"], 21600)
        self.assertIsNotNone(data["expires_at"])
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertIn("Authorization", response["Vary"])

    def test_business_authorized_collaborator_keeps_old_file_info_contract(self):
        collaborator = SimpleNamespace(id="collaborator", username="collaborator")
        oss_service = Mock()
        oss_service.generate_presigned_url.return_value = "https://bucket.example/signed?token=collaborator"
        with patch("apps.users.auth.permissions.JWTAuth.__call__", return_value=collaborator), \
                patch("apps.services.oss.api._check_organization_membership", return_value=True), \
                patch("apps.services.oss.api._check_business_resource_file_access", return_value=True), \
                patch("apps.services.oss.services.file_access.get_oss_service", return_value=oss_service):
            response = self.client.get(
                f"/api/services/oss/files/{self.record.id}",
                HTTP_AUTHORIZATION="Bearer fake-token",
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["data"]["access_url"],
            "https://bucket.example/signed?token=collaborator",
        )

    def test_public_file_info_keeps_stable_urls_without_expiry(self):
        self.record.is_public = True
        public_url = "https://public.example/demo.txt"
        self.record.access_url = public_url
        self.record.cdn_url = public_url
        self.record.save(update_fields=["is_public", "access_url", "cdn_url"])

        with patch("apps.users.auth.permissions.JWTAuth.__call__", return_value=self.user), \
                patch("apps.services.oss.api._check_organization_membership", return_value=True), \
                patch("apps.services.oss.services.file_access.build_public_asset_url", return_value=public_url), \
                patch("apps.services.oss.services.public_assets.build_public_asset_url", return_value=public_url):
            response = self.client.get(
                f"/api/services/oss/files/{self.record.id}",
                HTTP_AUTHORIZATION="Bearer fake-token",
            )

        payload = response.json()
        self.assertTrue(payload["success"], payload)
        data = payload["data"]
        self.assertEqual(data["access_url"], public_url)
        self.assertEqual(data["cdn_url"], public_url)
        self.assertEqual(data["resolved_url"], public_url)
        self.assertEqual(data["access_mode"], "public")
        self.assertIsNone(data["expires_at"])
        self.assertIsNone(data["expires_in"])

    def test_cross_organization_file_info_returns_http_404(self):
        with patch("apps.users.auth.permissions.JWTAuth.__call__", return_value=self.user), \
                patch("apps.services.oss.api._check_organization_membership", return_value=False):
            response = self.client.get(
                f"/api/services/oss/files/{self.record.id}",
                HTTP_AUTHORIZATION="Bearer fake-token",
            )

        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.json()["success"])
        self.assertEqual(response.json()["error_code"], "FILE_NOT_FOUND")
