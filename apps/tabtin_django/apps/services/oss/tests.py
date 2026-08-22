import json
import inspect
import io
import tempfile
import uuid
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from unittest.mock import MagicMock, Mock, patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, SimpleTestCase, TestCase, override_settings

from apps.services.billing.models import OrganizationStorageUsage

from .models import FileRecord, FileUsage, OSSAdminActionLog, UploadTask
from .services.file_registry import FileRegistryService


class ProductAssetVisibilityCompatibilityTests(SimpleTestCase):
    """New clients opt into private assets without breaking old wire contracts."""

    def test_tabdata_and_tabdoc_honor_explicit_visibility(self):
        from .api import _effective_is_public_for_module

        self.assertFalse(_effective_is_public_for_module("tabdata", False))
        self.assertFalse(_effective_is_public_for_module("tabdoc", False))
        self.assertTrue(_effective_is_public_for_module("tabdata", True))
        self.assertTrue(_effective_is_public_for_module("tabdoc", True))


class LocalFileOssServiceTestCase(SimpleTestCase):
    """Single-server local OSS provider keeps the shared upload contract."""

    def test_upload_download_and_presign_use_local_http_endpoints(self):
        from .services.local_file_oss import LocalFileOSSService

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local-dev",
                "root_path": temp_dir,
                "public_base_url": "http://127.0.0.1:6060/api/services/oss/local-object",
                "upload_base_url": "http://127.0.0.1:6060/api/services/oss/local-upload",
                "access_mode": "public-read",
            })

            uploaded = service.upload_bytes(b"hello", "chat/demo", content_type="text/custom")
            self.assertIn("/api/services/oss/local-object", uploaded)
            self.assertTrue(service.file_exists("chat/demo"))

            info = service.get_file_info("chat/demo")
            self.assertTrue(info["success"])
            self.assertEqual(info["data"]["content_length"], 5)
            self.assertEqual(info["data"]["content_type"], "text/custom")

            downloaded = service.download_file("chat/demo")
            self.assertEqual(downloaded["data"]["content"], b"hello")
            self.assertEqual(downloaded["data"]["content_type"], "text/custom")

            presigned = service.generate_presigned_url(
                "chat/demo",
                expiration=300,
                method="PUT",
                content_type="text/custom",
            )
            self.assertIn("/api/services/oss/local-upload", presigned)
            self.assertIn("signature=", presigned)

            preview_url = service.generate_presigned_url("chat/demo", expiration=300)
            preview_params = parse_qs(urlparse(preview_url).query)
            self.assertEqual(preview_params["download"], ["0"])

    @override_settings(
        DEBUG=True,
        SERVICES_OSS_PROVIDER="local",
        LOCAL_OSS_PUBLIC_BASE_URL="http://127.0.0.1:6060/api/services/oss/local-object",
        LOCAL_OSS_UPLOAD_BASE_URL="http://127.0.0.1:6060/api/services/oss/local-upload",
    )
    def test_local_presigned_put_endpoint_writes_file_for_confirm_chain(self):
        from django.test import RequestFactory
        from .api import local_object, local_presigned_upload
        from .services.factory import get_oss_service

        with tempfile.TemporaryDirectory() as temp_dir, override_settings(LOCAL_OSS_ROOT=temp_dir):
            service = get_oss_service(force_refresh=True)
            presigned = service.generate_presigned_url(
                "chat/demo",
                expiration=300,
                method="PUT",
                content_type="text/custom",
            )
            params = parse_qs(urlparse(presigned).query)

            request = RequestFactory().put(
                "/api/services/oss/local-upload",
                data=b"hello",
                content_type="text/custom",
            )
            response = local_presigned_upload(
                request,
                object_key=params["object_key"][0],
                method=params["method"][0],
                expires=int(params["expires"][0]),
                signature=params["signature"][0],
                content_type=params["content_type"][0],
            )
            self.assertEqual(response.status_code, 204)

            info = service.get_file_info("chat/demo")
            self.assertTrue(info["success"])
            self.assertEqual(info["data"]["content_type"], "text/custom")

            with patch("apps.services.oss.api.FileRecord.objects.filter") as file_filter:
                file_filter.return_value.only.return_value.first.return_value = None
                get_response = local_object(
                    RequestFactory().get("/api/services/oss/local-object"),
                    object_key="chat/demo",
                )
            self.assertEqual(get_response.status_code, 200)
            self.assertEqual(get_response.content, b"hello")
            self.assertEqual(get_response["Content-Type"], "text/custom")
            self.assertEqual(get_response["Cache-Control"], "private, max-age=604800, immutable")
            self.assertTrue(get_response["ETag"])

    @override_settings(
        DEBUG=True,
        SERVICES_OSS_PROVIDER="local",
        LOCAL_OSS_PUBLIC_BASE_URL="http://127.0.0.1:6060/api/services/oss/local-object",
        LOCAL_OSS_UPLOAD_BASE_URL="http://127.0.0.1:6060/api/services/oss/local-upload",
    )
    def test_bounded_local_upload_rejects_a_different_body_size(self):
        from django.test import RequestFactory

        from .api import local_presigned_upload
        from .services.factory import get_oss_service

        with tempfile.TemporaryDirectory() as temp_dir, override_settings(LOCAL_OSS_ROOT=temp_dir):
            service = get_oss_service(force_refresh=True)
            upload = service.generate_bounded_upload(
                "diagnostics/demo.zip",
                expiration=300,
                content_type="application/zip",
                content_length=5,
            )
            params = parse_qs(urlparse(upload["url"]).query)
            request = RequestFactory().put(
                "/api/services/oss/local-upload",
                data=b"too-long",
                content_type="application/zip",
            )

            response = local_presigned_upload(
                request,
                object_key=params["object_key"][0],
                method=params["method"][0],
                expires=int(params["expires"][0]),
                signature=params["signature"][0],
                content_type=params["content_type"][0],
                content_length=int(params["content_length"][0]),
            )

            self.assertEqual(response.status_code, 413)
            self.assertFalse(service.file_exists("diagnostics/demo.zip"))

    @override_settings(
        SERVICES_OSS_PROVIDER="local",
        LOCAL_OSS_PUBLIC_BASE_URL="http://127.0.0.1:6060/api/services/oss/local-object",
    )
    def test_public_asset_url_uses_local_provider_base(self):
        from .services.public_assets import build_public_asset_url, public_asset_object_key_from_ref

        self.assertEqual(
            build_public_asset_url("avatars/demo.png"),
            "http://127.0.0.1:6060/api/services/oss/local-object?object_key=avatars%2Fdemo.png",
        )
        self.assertEqual(
            public_asset_object_key_from_ref(
                "http://127.0.0.1:6060/api/services/oss/local-object?object_key=avatars%2Fdemo.png"
            ),
            "avatars/demo.png",
        )

    def test_tabdata_object_key_access_url_exceeds_legacy_200_char_limit(self):
        from .services.local_file_oss import LocalFileOSSService

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local-dev",
                "root_path": temp_dir,
                "public_base_url": "http://127.0.0.1:6060/api/services/oss/local-object",
                "upload_base_url": "http://127.0.0.1:6060/api/services/oss/local-upload",
                "access_mode": "public-read",
            })
            key = (
                "tabdata/ef481c9f-631d-42bb-93b1-2da0a0f371f0/"
                "1adcb77b-3396-43e5-9b64-59ec501deffa/"
                "20260709062233_51a53d41_eb37bc83e1bc46319e5dbcbbd540f579.jpeg"
            )
            url = service.build_access_url(key)
            self.assertGreater(len(url), 200)

    def test_upload_file_streams_in_bounded_chunks(self):
        from .services.local_file_oss import LocalFileOSSService

        class BoundedReader(io.BytesIO):
            requested_sizes: list[int]

            def __init__(self, payload: bytes):
                super().__init__(payload)
                self.requested_sizes = []

            def read(self, size: int = -1) -> bytes:
                self.requested_sizes.append(size)
                if size < 0:
                    raise AssertionError("unbounded read is forbidden")
                return super().read(size)

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local",
                "root_path": temp_dir,
                "public_base_url": "http://192.168.8.10:8080/api/services/oss/local-object",
                "upload_base_url": "http://192.168.8.10:8080/api/services/oss/local-upload",
                "access_mode": "public-read",
                "max_file_size": 4 * 1024 * 1024,
            })
            reader = BoundedReader(b"a" * (2 * 1024 * 1024 + 17))

            result = service.upload_file(reader, "chat/large.bin")

            self.assertTrue(result["success"], result)
            self.assertEqual(result["data"]["file_size"], 2 * 1024 * 1024 + 17)
            self.assertTrue(all(size == service._COPY_CHUNK_SIZE for size in reader.requested_sizes))

    def test_independent_service_instances_share_persistent_root(self):
        """Django 与 Celery 只要挂载同一目录，就能跨进程读写同一对象。"""
        from .services.local_file_oss import LocalFileOSSService

        with tempfile.TemporaryDirectory() as temp_dir:
            config = {
                "bucket_name": "tabtin-local",
                "root_path": temp_dir,
                "public_base_url": "https://tabtin.example.com/api/services/oss/local-object",
                "upload_base_url": "https://tabtin.example.com/api/services/oss/local-upload",
                "access_mode": "public-read",
            }
            django_service = LocalFileOSSService(config)
            celery_service = LocalFileOSSService(config)

            uploaded = django_service.upload_bytes(
                b"shared-media",
                "diagnostics/shared-media.bin",
                content_type="application/octet-stream",
            )
            downloaded = celery_service.download_file("diagnostics/shared-media.bin")

            self.assertIn("object_key=diagnostics%2Fshared-media.bin", uploaded)
            self.assertTrue(downloaded["success"], downloaded)
            self.assertEqual(downloaded["data"]["content"], b"shared-media")

            self.assertTrue(celery_service.delete_file("diagnostics/shared-media.bin")["success"])
            self.assertFalse(django_service.file_exists("diagnostics/shared-media.bin"))

    def test_multipart_completion_streams_parts_and_preserves_content_type(self):
        from pathlib import Path
        from .services.local_file_oss import LocalFileOSSService

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local",
                "root_path": temp_dir,
                "public_base_url": "https://tabtin.example.com/api/services/oss/local-object",
                "upload_base_url": "https://tabtin.example.com/api/services/oss/local-upload",
                "access_mode": "public-read",
                "max_file_size": 1024,
            })
            initialized = service.init_multipart_upload(
                "tabdata/multipart.txt",
                content_type="text/plain",
            )
            upload_id = initialized["data"]["upload_id"]
            service.upload_part("tabdata/multipart.txt", upload_id, 1, b"hello ")
            service.upload_part("tabdata/multipart.txt", upload_id, 2, b"world")

            with patch.object(Path, "read_bytes", side_effect=AssertionError("part read_bytes forbidden")):
                completed = service.complete_multipart_upload(
                    "tabdata/multipart.txt",
                    upload_id,
                    [{"part_number": 1}, {"part_number": 2}],
                )

            self.assertTrue(completed["success"], completed)
            self.assertEqual(service._path("tabdata/multipart.txt").read_text(), "hello world")
            self.assertEqual(
                service.get_file_info("tabdata/multipart.txt")["data"]["content_type"],
                "text/plain",
            )

    def test_health_probe_failure_is_safe_and_unhealthy(self):
        from apps.services.common.exceptions import OSSServiceException
        from .services.local_file_oss import LocalFileOSSService

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local",
                "root_path": temp_dir,
                "public_base_url": "https://tabtin.example.com/api/services/oss/local-object",
                "upload_base_url": "https://tabtin.example.com/api/services/oss/local-upload",
                "access_mode": "public-read",
            })
            with patch.object(
                service,
                "_assert_storage_ready",
                side_effect=OSSServiceException("本地对象存储目录不可读写"),
            ):
                result = service.get_bucket_info()

            self.assertFalse(result["success"])
            self.assertIn("不可读写", result["message"])
            self.assertNotIn(temp_dir, str(result))

    def test_local_upload_endpoint_does_not_buffer_request_body(self):
        from .api import local_presigned_upload

        self.assertNotIn("request.body", inspect.getsource(local_presigned_upload))

    @override_settings(DEBUG=False)
    def test_production_local_config_requires_one_public_non_loopback_origin(self):
        from apps.services.common.exceptions import ConfigurationException
        from .services.factory import _validate_local_config

        valid = {
            "root_path": "/var/lib/tabtin/objects",
            "public_base_url": "http://192.168.8.10:8080/api/services/oss/local-object",
            "upload_base_url": "http://192.168.8.10:8080/api/services/oss/local-upload",
        }
        _validate_local_config(valid)

        for invalid in (
            {**valid, "public_base_url": "http://127.0.0.1:8080/api/services/oss/local-object"},
            {**valid, "upload_base_url": "http://caddy/api/services/oss/local-upload"},
            {**valid, "upload_base_url": "http://192.168.8.11:8080/api/services/oss/local-upload"},
            {**valid, "upload_base_url": "http://user:pass@192.168.8.10:8080/api/services/oss/local-upload"},
            {**valid, "upload_base_url": "http://192.168.8.10:8080/api/other"},
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ConfigurationException):
                    _validate_local_config(invalid)

    @override_settings(
        SERVICES_OSS_PROVIDER="aliyun",
        ALIYUN_USE_ECS_ROLE=False,
        ALIYUN_OSS_BUCKET_NAME="example-assets",
        ALIYUN_OSS_ENDPOINT="oss-cn-shanghai.aliyuncs.com",
        ALIYUN_OSS_REGION="oss-cn-shanghai",
        ALIYUN_ACCESS_KEY_ID=None,
        ALIYUN_ACCESS_KEY_SECRET=None,
    )
    def test_explicit_aliyun_with_missing_credentials_never_falls_back_local(self):
        from apps.services.common.exceptions import AuthenticationException
        from .services.factory import get_oss_service

        with patch("apps.services.oss.services.factory.LocalFileOSSService") as local_service:
            with self.assertRaises(AuthenticationException):
                get_oss_service(force_refresh=True)
        local_service.assert_not_called()


class LocalOssLifecycleTestCase(TestCase):
    """Local provider supports the complete client upload and access lifecycle."""

    databases = '__all__'

    @override_settings(
        DEBUG=True,
        SERVICES_OSS_PROVIDER="local",
        LOCAL_OSS_BUCKET_NAME="tabtin-local-test",
        LOCAL_OSS_PUBLIC_BASE_URL="http://192.168.8.10:8080/api/services/oss/local-object",
        LOCAL_OSS_UPLOAD_BASE_URL="http://192.168.8.10:8080/api/services/oss/local-upload",
    )
    def test_presign_put_confirm_signed_get_and_delete(self):
        from .services.local_file_oss import LocalFileOSSService

        payload = b"local oss lifecycle"
        user_id = str(uuid.uuid4())
        auth_user = SimpleNamespace(id=user_id, username="local-user")

        with tempfile.TemporaryDirectory() as temp_dir:
            service = LocalFileOSSService({
                "bucket_name": "tabtin-local-test",
                "root_path": temp_dir,
                "public_base_url": "http://192.168.8.10:8080/api/services/oss/local-object",
                "upload_base_url": "http://192.168.8.10:8080/api/services/oss/local-upload",
                "access_mode": "public-read",
            })
            client = Client()

            with patch(
                "apps.users.auth.permissions.JWTAuth.__call__",
                return_value=auth_user,
            ), patch(
                "apps.services.oss.api._oss_resolve_organization",
                return_value="",
            ), patch(
                "apps.services.oss.api._check_upload_permission",
                return_value=None,
            ), patch(
                "apps.services.oss.api._cache_presign_token",
            ), patch(
                "apps.services.oss.api._verify_presign_ownership",
                return_value=None,
            ), patch(
                "apps.services.oss.api.get_oss_service",
                return_value=service,
            ), patch(
                "apps.services.oss.services.factory.get_oss_service",
                return_value=service,
            ):
                presign_response = client.post(
                    "/api/services/oss/presign-upload",
                    data=json.dumps({
                        "filename": "lifecycle.txt",
                        "file_size": len(payload),
                        "content_type": "text/plain",
                        "module": "chat",
                        "context_type": "message",
                        "context_id": "local-oss-lifecycle",
                        "is_public": False,
                    }),
                    content_type="application/json",
                    HTTP_AUTHORIZATION="Bearer fake-token",
                )
                self.assertEqual(presign_response.status_code, 200)
                presign_data = presign_response.json()["data"]
                self.assertFalse(presign_data["instant"])
                self.assertEqual(
                    urlparse(presign_data["presigned_url"]).netloc,
                    "192.168.8.10:8080",
                )

                upload_url = urlparse(presign_data["presigned_url"])
                upload_response = client.put(
                    f"{upload_url.path}?{upload_url.query}",
                    data=payload,
                    content_type="text/plain",
                )
                self.assertEqual(upload_response.status_code, 204)

                confirm_response = client.post(
                    "/api/services/oss/confirm-upload",
                    data=json.dumps({
                        "object_key": presign_data["object_key"],
                        "file_name": "lifecycle.txt",
                        "file_size": len(payload),
                        "content_type": "text/plain",
                        "module": "chat",
                        "context_type": "message",
                        "context_id": "local-oss-lifecycle",
                        "is_public": False,
                    }),
                    content_type="application/json",
                    HTTP_AUTHORIZATION="Bearer fake-token",
                )
                self.assertEqual(confirm_response.status_code, 200)
                confirmed = confirm_response.json()
                self.assertTrue(confirmed["success"], confirmed)
                file_id = confirmed["data"]["file_id"]
                access_url = urlparse(confirmed["data"]["access_url"])

                download_response = client.get(f"{access_url.path}?{access_url.query}")
                self.assertEqual(download_response.status_code, 200)
                self.assertEqual(download_response.content, payload)
                self.assertEqual(download_response["Cache-Control"], "private, no-store")

                delete_response = client.delete(
                    f"/api/services/oss/files/{file_id}",
                    HTTP_AUTHORIZATION="Bearer fake-token",
                )
                self.assertEqual(delete_response.status_code, 200)
                self.assertTrue(delete_response.json()["success"])

                deleted_download = client.get(f"{access_url.path}?{access_url.query}")
                self.assertEqual(deleted_download.status_code, 404)


class LocalObjectHtmlEmbedHeadersTestCase(SimpleTestCase):
    """#3763: local-object 提供的 HTML artifact 必须能被宿主 iframe 嵌入，且不把安全头冻进缓存。"""

    def _serve(self, object_key: str, content: bytes, content_type: str):
        from .api import local_object

        request = SimpleNamespace(GET={}, META={}, path="/api/services/oss/local-object")
        fake_service = Mock()
        fake_service.download_file.return_value = {
            "success": True,
            "data": {"content": content, "content_type": content_type},
        }
        with patch("apps.services.oss.api._is_local_oss_provider", return_value=True), \
                patch("apps.services.oss.api.get_oss_service", return_value=fake_service), \
                patch("apps.services.oss.api.FileRecord.objects.filter") as file_filter:
            file_filter.return_value.only.return_value.first.return_value = None
            return local_object(request, object_key=object_key)

    def test_html_artifact_is_embeddable_and_force_sandboxed(self):
        response = self._serve(
            "tabdoc/html/demo.html", b"<html><body>ok</body></html>", "text/html",
        )
        # 视图声明豁免，交由 XFrameOptions / SecurityHeaders 中间件让路
        self.assertTrue(getattr(response, "xframe_options_exempt", False))
        self.assertTrue(getattr(response, "csp_override", False))
        csp = response["Content-Security-Policy"]
        self.assertNotIn("frame-ancestors 'none'", csp)
        # 宿主钉死到已知来源（含打包态 scheme），不用端口通配
        self.assertIn("http://127.0.0.1:5175", csp)
        self.assertIn("tabtin-file:", csp)
        self.assertNotIn("http://127.0.0.1:*", csp)
        # 服务端强制沙箱：URL 被直接在浏览器打开时也拿不到 API origin 的凭证
        self.assertIn("sandbox allow-scripts allow-popups", csp)
        self.assertNotIn("allow-same-origin", csp)
        # sandbox 不管网络出口，自包含 artifact 不该有外传通道
        self.assertIn("connect-src 'none'", csp)

    def test_html_artifact_is_not_cached_immutable_and_etag_tracks_content(self):
        """安全头随策略变化，immutable 会让存量客户端永远吃旧头（本 issue 的直接根因）。"""
        first = self._serve("tabdoc/html/demo.html", b"<html>v1</html>", "text/html; charset=utf-8")
        self.assertEqual(first["Cache-Control"], "private, no-cache")
        # 同 key 改写内容后 ETag 必须变，否则补上 ConditionalGet / CDN 后会 304 命中旧内容
        second = self._serve("tabdoc/html/demo.html", b"<html>v2</html>", "text/html; charset=utf-8")
        self.assertNotEqual(first["ETag"], second["ETag"])

    def test_html_outside_artifact_namespace_gets_no_relaxed_policy(self):
        """content_type 由上传方自报且不校验，只有 tabdoc/html/ 命名空间才配放宽策略。"""
        response = self._serve("chat/attachment.txt", b"<html>evil</html>", "text/html")
        self.assertFalse(getattr(response, "xframe_options_exempt", False))
        self.assertFalse(getattr(response, "csp_override", False))
        self.assertNotIn("Content-Security-Policy", response)
        self.assertEqual(response["Cache-Control"], "private, max-age=604800, immutable")

    def test_non_html_object_keeps_immutable_cache_and_default_headers(self):
        """图片等附件内容与头都不可变，长缓存维持原样。"""
        response = self._serve("chat/a.png", b"\x89PNG", "image/png")
        self.assertEqual(response["Cache-Control"], "private, max-age=604800, immutable")
        self.assertFalse(getattr(response, "xframe_options_exempt", False))
        self.assertNotIn("Content-Security-Policy", response)


class FileRecordUrlFieldTestCase(TestCase):
    databases = ['default']

    def test_persists_local_oss_access_url_over_200_chars(self):
        long_access_url = (
            'http://127.0.0.1:6060/api/services/oss/local-object?object_key='
            'tabdata%2Fef481c9f-631d-42bb-93b1-2da0a0f371f0%2F1adcb77b-3396-43e5-9b64-'
            '59ec501deffa%2F20260709062233_51a53d41_eb37bc83e1bc46319e5dbcbbd540f579.jpeg'
        )
        self.assertGreater(len(long_access_url), 200)
        key = (
            'tabdata/ef481c9f-631d-42bb-93b1-2da0a0f371f0/1adcb77b-3396-43e5-9b64-'
            '59ec501deffa/20260709062233_51a53d41_eb37bc83e1bc46319e5dbcbbd540f579.jpeg'
        )
        record = FileRecord.objects.create(
            file_name='封面.jpeg',
            file_key=key,
            file_path='tabdata/demo',
            file_size=1024,
            file_type='image',
            mime_type='image/jpeg',
            file_extension='jpeg',
            file_hash=uuid.uuid4().hex,
            bucket_name='tabtin-local-dev',
            access_url=long_access_url,
            status='completed',
        )
        record.refresh_from_db()
        self.assertEqual(record.access_url, long_access_url)


class OssImageUploadConfigTestCase(SimpleTestCase):
    """图片上传格式配置应与前端 IMAGE preset 保持一致。"""

    def test_windows_common_cover_formats_pass_presign_validation(self):
        from .api import _validate_upload_params

        cases = [
            ('cover.apng', 'image/apng', 'apng'),
            ('cover.jfif', 'image/jpeg', 'jfif'),
            ('cover.bmp', 'image/x-ms-bmp', 'bmp'),
        ]

        for filename, mime_type, expected_ext in cases:
            with self.subTest(filename=filename, mime_type=mime_type):
                self.assertEqual(
                    _validate_upload_params(filename, 1, mime_type),
                    expected_ext,
                )

    def test_tabdoc_html_formats_pass_presign_validation(self):
        from .api import _validate_upload_params

        cases = [
            ('doc.html', 'text/html', 'html'),
            ('doc.htm', 'text/html', 'htm'),
        ]
        for filename, mime_type, expected_ext in cases:
            with self.subTest(filename=filename, mime_type=mime_type):
                self.assertEqual(
                    _validate_upload_params(filename, 1, mime_type),
                    expected_ext,
                )

    def test_private_space_tabfiles_accepts_arbitrary_file_types(self):
        from .api import _validate_upload_params

        cases = [
            ('notes.mark', 'text/markdown', 'mark'),
            ('notes.markdown', 'text/markdown', 'markdown'),
            ('notes.mardown', 'text/plain', 'mardown'),
            ('installer.exe', 'application/x-msdownload', 'exe'),
            ('archive.tar.gz', 'application/gzip', 'gz'),
            ('README', 'text/plain', 'bin'),
            ('.env', 'text/plain', 'bin'),
        ]
        for filename, mime_type, expected_extension in cases:
            with self.subTest(filename=filename, mime_type=mime_type):
                self.assertEqual(
                    _validate_upload_params(
                        filename,
                        1,
                        mime_type,
                        module='tabfiles',
                        context_type='space',
                        is_public=False,
                    ),
                    expected_extension,
                )

    def test_arbitrary_file_types_remain_restricted_outside_private_space_tabfiles(self):
        from .api import _validate_upload_params
        from ..common.exceptions import ValidationException

        for module, filename, mime_type in (
            ('chat', 'installer.exe', 'application/x-msdownload'),
            ('other', 'notes.xyz', 'text/markdown'),
        ):
            with self.subTest(module=module, filename=filename):
                with self.assertRaises(ValidationException):
                    _validate_upload_params(
                        filename,
                        1,
                        mime_type,
                        module=module,
                        context_type='space',
                        is_public=False,
                    )

    def test_tabdoc_markdown_extensions_pass_presign_validation(self):
        from .api import _validate_upload_params

        cases = [
            ('notes.md', 'text/markdown', 'md'),
            ('notes.markdown', 'text/markdown', 'markdown'),
            ('notes.mark', 'text/markdown', 'mark'),
            ('notes.txt', 'text/plain', 'txt'),
        ]
        for filename, mime_type, expected_ext in cases:
            with self.subTest(filename=filename, mime_type=mime_type):
                self.assertEqual(
                    _validate_upload_params(
                        filename,
                        1,
                        mime_type,
                        module='tabdoc',
                        context_type='space',
                        is_public=False,
                    ),
                    expected_ext,
                )

    def test_space_tabfiles_rejects_public_uploads(self):
        from .api import _validate_upload_params
        from ..common.exceptions import ValidationException

        with self.assertRaisesRegex(ValidationException, '私有'):
            _validate_upload_params(
                'installer.exe',
                1,
                'application/x-msdownload',
                module='tabfiles',
                context_type='space',
                is_public=True,
            )

    @patch("apps.services.oss.api.django_cache")
    def test_confirm_scope_must_match_presign_scope(self, mock_cache):
        from .api import _verify_presign_ownership

        mock_cache.get.return_value = {
            'user_id': 'user-1',
            'reserved_bytes': 1,
            'module': 'chat',
            'context_type': 'message',
            'is_public': False,
        }

        result = _verify_presign_ownership(
            'uploads/random.bin',
            'user-1',
            module='tabfiles',
            context_type='space',
            is_public=False,
        )

        self.assertEqual(result['error_code'], 'PRESIGN_SCOPE_MISMATCH')

    @patch("apps.services.oss.api.django_cache")
    def test_confirm_cannot_switch_presigned_organization(self, mock_cache):
        from .api import _verify_presign_ownership

        mock_cache.get.return_value = {
            'user_id': 'user-1',
            'reserved_bytes': 1,
            'module': 'tabfiles',
            'context_type': 'space',
            'context_id': 'space-item',
            'organization_id': 'organization-a',
            'is_public': False,
        }

        result = _verify_presign_ownership(
            'tabfiles/random.exe',
            'user-1',
            module='tabfiles',
            context_type='space',
            context_id='space-item',
            organization_id='organization-b',
            is_public=False,
        )

        self.assertEqual(result['error_code'], 'PRESIGN_SCOPE_MISMATCH')

    def test_tabfiles_unsafe_or_overlong_extension_uses_neutral_object_key_suffix(self):
        from .api import _generate_presign_item

        oss = MagicMock()
        oss.generate_presigned_url.return_value = 'https://oss.example/presigned'
        oss.build_access_url.return_value = 'https://oss.example/access'
        oss.build_cdn_url.return_value = ''

        for filename in ('payload.💥', f"payload.{'a' * 33}"):
            with self.subTest(filename=filename):
                item = _generate_presign_item(
                    oss,
                    filename=filename,
                    folder='tabfiles',
                    content_type='application/octet-stream',
                    file_size=1,
                    module='tabfiles',
                    context_type='space',
                    is_public=False,
                )
                self.assertTrue(item['object_key'].startswith('tabfiles/'))
                self.assertTrue(item['object_key'].endswith('.bin'))
                self.assertNotIn('payload', item['object_key'])


class OssPresignErrorResponseTestCase(SimpleTestCase):
    """presign 异常响应必须可诊断且不泄露底层敏感值。"""

    def test_presign_failure_response_formats_safe_detail(self):
        from apps.i18n import _
        from .api import _safe_error_response, _safe_presign_failure_detail

        exc = RuntimeError("OSS_ACCESS_KEY_SECRET=plain-text-secret is invalid")
        safe_detail = _safe_presign_failure_detail(exc)
        payload = _safe_error_response(
            exc,
            _("oss.presign_upload_failed", detail=safe_detail),
            error_code="PRESIGN_FAILED",
            log_context="test presign failure",
            detail=safe_detail,
        )

        self.assertFalse(payload["success"])
        self.assertEqual(payload["error_code"], "PRESIGN_FAILED")
        self.assertEqual(payload["detail"], "OSS 配置不完整")
        self.assertIn("OSS 配置不完整", payload["message"])
        self.assertNotIn("{detail}", payload["message"])
        self.assertNotIn("plain-text-secret", str(payload))

    def test_presign_upload_exception_response_uses_safe_detail(self):
        from django.test import RequestFactory
        from .api import presign_upload
        from .schemas import PresignUploadRequest

        request = RequestFactory().post("/api/services/oss/presign-upload")
        data = PresignUploadRequest(
            filename="avatar.png",
            content_type="image/png",
            file_size=1024,
            module="profile",
            context_type="avatar",
            context_id="user-profile",
        )

        with patch("apps.services.oss.api._get_user_id", return_value="user-1"), \
                patch("apps.services.oss.api._oss_resolve_organization", return_value=""), \
                patch("apps.services.oss.api._check_upload_permission", return_value=None), \
                patch("apps.services.oss.api.get_oss_service") as mock_get_oss:
            mock_get_oss.side_effect = RuntimeError("OSS_ACCESS_KEY_SECRET=plain-text-secret is invalid")
            payload = presign_upload(request, data)

        self.assertFalse(payload["success"])
        self.assertEqual(payload["error_code"], "PRESIGN_FAILED")
        self.assertEqual(payload["detail"], "OSS 配置不完整")
        self.assertIn("OSS 配置不完整", payload["message"])
        self.assertNotIn("{detail}", payload["message"])
        self.assertNotIn("plain-text-secret", str(payload))


class OssBatchConfirmScopeSecurityTestCase(SimpleTestCase):
    def test_batch_confirm_checks_each_item_organization_permission(self):
        from django.test import RequestFactory
        from .api import confirm_upload_batch
        from .schemas import ConfirmUploadBatchRequest

        forbidden = {
            'success': False,
            'message': '无权上传到目标组织',
            'data': None,
            'error_code': 'PERMISSION_DENIED',
            'timestamp': '',
        }
        data = ConfirmUploadBatchRequest(items=[{
            'object_key': 'tabfiles/random.exe',
            'file_name': 'installer.exe',
            'file_size': 1,
            'content_type': 'application/x-msdownload',
            'module': 'tabfiles',
            'context_type': 'space',
            'context_id': 'space-item',
            'organization_id': 'organization-forbidden',
            'is_public': False,
        }])
        request = RequestFactory().post('/api/services/oss/confirm-upload-batch')

        def check_permission(_request, organization_id):
            return forbidden if organization_id == 'organization-forbidden' else None

        with patch('apps.services.oss.api._get_user_id', return_value='user-1'), \
                patch('apps.services.oss.api._oss_resolve_organization', return_value='organization-default'), \
                patch('apps.services.oss.api._check_upload_permission', side_effect=check_permission), \
                patch('apps.services.oss.api._check_organization_resource_write_policy', return_value=None), \
                patch('apps.services.oss.api.get_oss_service'):
            payload = confirm_upload_batch(request, data)

        self.assertEqual(payload, forbidden)


class OssAdminApiTestCase(TestCase):
    """OSS 后台治理 API 测试。"""

    databases = '__all__'

    def setUp(self):
        self.client = Client()

    def _create_file_record(
        self,
        *,
        organization_id: str,
        file_size: int = 1024,
        status: str = 'completed',
        file_key: str | None = None,
        include_organization_in_metadata: bool = True,
    ) -> FileRecord:
        key = file_key or f'uploads/{organization_id}/{uuid.uuid4().hex}.txt'
        metadata = {'space_id': f'space-{organization_id}'}
        if include_organization_in_metadata:
            metadata['organization_id'] = organization_id
        return FileRecord.objects.create(
            file_name=f'{organization_id}-demo.txt',
            file_key=key,
            file_path=f'/{key}',
            file_size=file_size,
            file_type='document',
            mime_type='text/plain',
            file_extension='txt',
            file_hash=uuid.uuid4().hex,
            bucket_name='test-bucket',
            status=status,
            organization_id=organization_id,
            metadata=metadata,
        )

    @staticmethod
    def _build_target_file_ids_text(file_ids: list[str]) -> str:
        normalized = [str(file_id).strip() for file_id in file_ids if str(file_id).strip()]
        if not normalized:
            return ''
        return f"|{'|'.join(normalized)}|"

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_list_operations_should_support_filters(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        file_a = self._create_file_record(organization_id='ws-a')
        file_b = self._create_file_record(organization_id='ws-b')

        operator_uuid = uuid.uuid4()
        OSSAdminActionLog.objects.create(
            action_type='batch_delete',
            operator_id=operator_uuid,
            operator_name='ops-admin',
            organization_id='ws-a',
            organization_ids=['ws-a'],
            organization_ids_text='|ws-a|',
            target_file_ids=[str(file_a.id)],
            target_file_ids_text=self._build_target_file_ids_text([str(file_a.id)]),
            requested_count=1,
            processed_count=1,
            deleted_count=0,
            skipped_count=0,
            dry_run=True,
            success=True,
            message='dry-run ok',
            trace_id='trace-success',
        )
        OSSAdminActionLog.objects.create(
            action_type='batch_delete',
            operator_id=uuid.uuid4(),
            operator_name='ops-admin-2',
            organization_id='ws-b',
            organization_ids=['ws-b'],
            organization_ids_text='|ws-b|',
            target_file_ids=[str(file_b.id)],
            target_file_ids_text=self._build_target_file_ids_text([str(file_b.id)]),
            requested_count=1,
            processed_count=1,
            deleted_count=0,
            skipped_count=1,
            dry_run=False,
            success=False,
            error_message='delete failed',
            trace_id='trace-failed',
        )

        response = self.client.get(
            f'/api/auth/admin/oss/operations?action_type=batch_delete&success=true&file_id={file_a.id}&organization_id=ws-a'
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['pagination']['total'], 1)
        self.assertEqual(len(payload['items']), 1)
        self.assertEqual(payload['items'][0]['target_file_ids'], [str(file_a.id)])
        self.assertEqual(payload['items'][0]['organization_id'], 'ws-a')
        self.assertEqual(payload['items'][0]['organization_ids'], ['ws-a'])
        self.assertTrue(payload['items'][0]['success'])
        self.assertEqual(payload['summary']['total_operations'], 1)
        self.assertEqual(payload['summary']['success_operations'], 1)
        self.assertEqual(payload['summary']['failed_operations'], 0)
        self.assertEqual(payload['summary']['dry_run_operations'], 1)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_get_costs_should_aggregate_file_and_metered_usage(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        self._create_file_record(
            organization_id='ws-a',
            file_size=1000,
            status='completed',
            include_organization_in_metadata=False,
        )
        self._create_file_record(
            organization_id='ws-a',
            file_size=500,
            status='deleted',
            include_organization_in_metadata=False,
        )
        self._create_file_record(
            organization_id='ws-b',
            file_size=3000,
            status='completed',
            include_organization_in_metadata=False,
        )
        self._create_file_record(
            organization_id='',
            file_size=700,
            status='completed',
            include_organization_in_metadata=False,
        )

        OrganizationStorageUsage.objects.create(
            organization_id='ws-a',
            active_file_count=1,
            active_storage_bytes=900,
        )
        OrganizationStorageUsage.objects.create(
            organization_id='ws-c',
            active_file_count=2,
            active_storage_bytes=700,
        )

        response = self.client.get('/api/auth/admin/oss/costs?page=1&page_size=20')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['summary']['organization_count'], 3)
        self.assertEqual(payload['summary']['file_organization_count'], 2)
        self.assertEqual(payload['summary']['metered_organization_count'], 2)
        self.assertEqual(payload['summary']['total_file_storage_bytes'], 4000)
        self.assertEqual(payload['summary']['total_metered_storage_bytes'], 1600)
        self.assertEqual(payload['summary']['total_storage_gap_bytes'], 2400)
        self.assertEqual(payload['summary']['file_only_organization_count'], 1)
        self.assertEqual(payload['summary']['metered_only_organization_count'], 1)
        self.assertEqual(payload['summary']['organization_gap_count'], 3)
        self.assertEqual(payload['summary']['unowned_files'], 1)
        self.assertEqual(payload['summary']['unowned_file_storage_bytes'], 700)

        item_map = {item['organization_id']: item for item in payload['items']}
        self.assertEqual(item_map['ws-a']['file_storage_bytes'], 1000)
        self.assertEqual(item_map['ws-a']['metered_storage_bytes'], 900)
        self.assertEqual(item_map['ws-a']['storage_gap_bytes'], 100)
        self.assertEqual(item_map['ws-b']['metered_storage_bytes'], 0)
        self.assertEqual(item_map['ws-c']['file_storage_bytes'], 0)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_list_files_should_filter_by_direct_organization_id(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        direct_only = self._create_file_record(
            organization_id='ws-direct-only',
            include_organization_in_metadata=False,
        )
        self._create_file_record(organization_id='ws-other')

        response = self.client.get('/api/auth/admin/oss/files?organization_id=ws-direct-only')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['pagination']['total'], 1)
        self.assertEqual(payload['items'][0]['id'], str(direct_only.id))
        self.assertEqual(payload['items'][0]['organization_id'], 'ws-direct-only')

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_list_files_should_support_unowned_only_filter(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        unowned_file = self._create_file_record(
            organization_id='',
            file_size=256,
            status='completed',
            include_organization_in_metadata=False,
        )
        self._create_file_record(
            organization_id='ws-direct',
            file_size=512,
            status='completed',
            include_organization_in_metadata=False,
        )
        legacy_owned_file = self._create_file_record(
            organization_id='ws-legacy-only',
            file_size=768,
            status='completed',
            include_organization_in_metadata=True,
        )
        legacy_owned_file.organization_id = ''
        legacy_owned_file.save(update_fields=['organization_id'])

        response = self.client.get('/api/auth/admin/oss/files?unowned_only=true')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['pagination']['total'], 1)
        self.assertEqual(len(payload['items']), 1)
        self.assertEqual(payload['items'][0]['id'], str(unowned_file.id))
        self.assertEqual(payload['items'][0]['organization_id'], None)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_list_files_summary_should_include_unowned_breakdown(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        owned_file = self._create_file_record(
            organization_id='ws-owned',
            file_size=1024,
            status='completed',
            include_organization_in_metadata=False,
        )
        owned_file.ref_count = 1
        owned_file.save(update_fields=['ref_count'])
        self._create_file_record(
            organization_id='',
            file_size=256,
            status='completed',
            include_organization_in_metadata=False,
        )
        self._create_file_record(
            organization_id='',
            file_size=128,
            status='uploading',
            include_organization_in_metadata=False,
        )
        self._create_file_record(
            organization_id='ws-deleted',
            file_size=512,
            status='deleted',
            include_organization_in_metadata=False,
        )

        response = self.client.get('/api/auth/admin/oss/files?page=1&page_size=20')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['summary']['total_files'], 4)
        self.assertEqual(payload['summary']['deleted_files'], 1)
        self.assertEqual(payload['summary']['total_size'], 1408)
        self.assertEqual(payload['summary']['owned_files'], 1)
        self.assertEqual(payload['summary']['owned_size'], 1024)
        self.assertEqual(payload['summary']['unowned_files'], 2)
        self.assertEqual(payload['summary']['unowned_size'], 384)
        self.assertEqual(payload['summary']['orphan_files'], 1)
        self.assertEqual(payload['summary']['orphan_size'], 256)
        self.assertEqual(payload['summary']['orphan_unowned_files'], 1)
        self.assertEqual(payload['summary']['orphan_unowned_size'], 256)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_list_files_summary_should_include_organization_repair_breakdown(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        repairable_file = self._create_file_record(
            organization_id='',
            file_size=256,
            status='completed',
            include_organization_in_metadata=False,
        )
        repairable_task = UploadTask.objects.create(
            task_name='repairable-task',
            task_type='batch',
            status='completed',
            organization_id='ws-repairable',
            total_files=1,
            completed_files=1,
            total_size=256,
            uploaded_size=256,
        )
        repairable_task.files.add(repairable_file)

        conflict_file = self._create_file_record(
            organization_id='',
            file_size=512,
            status='completed',
            include_organization_in_metadata=False,
        )
        UploadTask.objects.create(
            task_name='conflict-task-a',
            task_type='batch',
            status='completed',
            organization_id='ws-conflict-a',
            total_files=1,
            completed_files=1,
            total_size=512,
            uploaded_size=512,
        ).files.add(conflict_file)
        UploadTask.objects.create(
            task_name='conflict-task-b',
            task_type='batch',
            status='completed',
            organization_id='ws-conflict-b',
            total_files=1,
            completed_files=1,
            total_size=512,
            uploaded_size=512,
        ).files.add(conflict_file)

        self._create_file_record(
            organization_id='',
            file_size=128,
            status='completed',
            include_organization_in_metadata=False,
        )

        response = self.client.get('/api/auth/admin/oss/files?page=1&page_size=20')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['summary']['unowned_files'], 3)
        self.assertEqual(payload['summary']['repairable_unowned_files'], 1)
        self.assertEqual(payload['summary']['conflict_unowned_files'], 1)
        self.assertEqual(payload['summary']['unverifiable_unowned_files'], 1)
        self.assertEqual(payload['summary']['repairable_from_upload_task_files'], 1)
        self.assertEqual(payload['summary']['repairable_from_attachment_reference_files'], 0)
        self.assertEqual(payload['summary']['repairable_from_dual_evidence_files'], 0)
        self.assertEqual(payload['summary']['conflict_upload_task_files'], 1)
        self.assertEqual(payload['summary']['conflict_reference_files'], 0)
        self.assertEqual(payload['summary']['conflict_cross_source_files'], 0)
        self.assertEqual(payload['summary']['missing_evidence_unowned_files'], 1)
        self.assertEqual(payload['summary']['lookup_error_unowned_files'], 0)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_list_files_should_support_repair_state_filter(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        repairable_file = self._create_file_record(
            organization_id='',
            file_size=256,
            status='completed',
            include_organization_in_metadata=False,
        )
        repairable_task = UploadTask.objects.create(
            task_name='repairable-filter',
            task_type='batch',
            status='completed',
            organization_id='ws-filter-target',
            total_files=1,
            completed_files=1,
            total_size=256,
            uploaded_size=256,
        )
        repairable_task.files.add(repairable_file)

        conflict_file = self._create_file_record(
            organization_id='',
            file_size=128,
            status='completed',
            include_organization_in_metadata=False,
        )
        UploadTask.objects.create(
            task_name='conflict-filter-a',
            task_type='batch',
            status='completed',
            organization_id='ws-filter-a',
            total_files=1,
            completed_files=1,
            total_size=128,
            uploaded_size=128,
        ).files.add(conflict_file)
        UploadTask.objects.create(
            task_name='conflict-filter-b',
            task_type='batch',
            status='completed',
            organization_id='ws-filter-b',
            total_files=1,
            completed_files=1,
            total_size=128,
            uploaded_size=128,
        ).files.add(conflict_file)

        response = self.client.get('/api/auth/admin/oss/files?repair_state=repairable')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['pagination']['total'], 1)
        self.assertEqual(payload['items'][0]['id'], str(repairable_file.id))
        self.assertEqual(payload['items'][0]['organization_repair']['repair_state'], 'repairable')
        self.assertEqual(
            payload['items'][0]['organization_repair']['reason_code'],
            'unique_upload_task_organization',
        )
        self.assertEqual(
            payload['items'][0]['organization_repair']['recommended_action_code'],
            'auto_repair',
        )
        self.assertEqual(
            payload['items'][0]['organization_repair']['recommended_action_label'],
            '可直接批量修复',
        )
        self.assertEqual(
            payload['items'][0]['organization_repair']['resolved_organization_id'],
            'ws-filter-target',
        )

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_list_files_should_support_repair_reason_code_filter(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        self._create_file_record(
            organization_id='',
            file_size=256,
            status='completed',
            include_organization_in_metadata=False,
        )

        lookup_error_file = self._create_file_record(
            organization_id='',
            file_size=128,
            status='completed',
            include_organization_in_metadata=False,
        )

        with patch(
            'apps.services.oss.admin_api._collect_attachment_reference_organization_ids_batch',
            return_value=({}, 'lookup_error'),
        ):
            response = self.client.get(
                '/api/auth/admin/oss/files?repair_reason_code=attachment_reference_lookup_error'
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['pagination']['total'], 2)
        self.assertEqual(payload['items'][0]['organization_repair']['reason_code'], 'attachment_reference_lookup_error')
        self.assertEqual(payload['items'][0]['organization_repair']['recommended_action_code'], 'retry_reference_lookup')
        self.assertEqual(payload['items'][0]['organization_repair']['recommended_action_label'], '排查引用查询链路')
        self.assertIn('AttachmentReference', payload['items'][0]['organization_repair']['recommended_action_detail'])
        self.assertIn(
            str(lookup_error_file.id),
            {item['id'] for item in payload['items']},
        )

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_get_file_detail_should_include_organization_repair_assessment(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        file_record = self._create_file_record(
            organization_id='',
            file_size=256,
            status='completed',
            include_organization_in_metadata=False,
        )
        upload_task = UploadTask.objects.create(
            task_name='detail-repair',
            task_type='batch',
            status='completed',
            organization_id='ws-detail-target',
            total_files=1,
            completed_files=1,
            total_size=256,
            uploaded_size=256,
        )
        upload_task.files.add(file_record)

        response = self.client.get(f'/api/auth/admin/oss/files/{file_record.id}')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['file']['organization_id'], None)
        self.assertEqual(payload['file']['organization_repair']['repair_state'], 'repairable')
        self.assertEqual(
            payload['file']['organization_repair']['reason_code'],
            'unique_upload_task_organization',
        )
        self.assertEqual(
            payload['file']['organization_repair']['recommended_action_code'],
            'auto_repair',
        )
        self.assertEqual(
            payload['file']['organization_repair']['recommended_action_label'],
            '可直接批量修复',
        )
        self.assertIn(
            '归属修复',
            payload['file']['organization_repair']['recommended_action_detail'],
        )
        self.assertEqual(
            payload['file']['organization_repair']['resolved_organization_id'],
            'ws-detail-target',
        )
        self.assertEqual(payload['file']['organization_repair']['evidence_source'], 'upload_task')
        self.assertEqual(payload['reference_count'], 0)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_repair_organization_scope_should_preview_without_persisting(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=True,
        )

        file_record = self._create_file_record(
            organization_id='',
            file_size=256,
            status='completed',
            include_organization_in_metadata=False,
        )
        upload_task = UploadTask.objects.create(
            task_name='repair-preview',
            task_type='batch',
            status='completed',
            organization_id='ws-upload-preview',
            total_files=1,
            completed_files=1,
            total_size=256,
            uploaded_size=256,
        )
        upload_task.files.add(file_record)

        response = self.client.post(
            '/api/auth/admin/oss/files/batch/repair-organization',
            data=json.dumps({'file_ids': [str(file_record.id)], 'dry_run': True}),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertTrue(payload['dry_run'])
        self.assertEqual(payload['repaired_count'], 1)
        self.assertEqual(payload['skipped_count'], 0)
        self.assertEqual(payload['results'][0]['reason_code'], 'unique_upload_task_organization')
        self.assertEqual(payload['results'][0]['recommended_action_code'], 'auto_repair')
        self.assertEqual(payload['results'][0]['resolved_organization_id'], 'ws-upload-preview')
        self.assertEqual(payload['results'][0]['evidence_source'], 'upload_task')

        file_record.refresh_from_db()
        self.assertEqual(file_record.organization_id, '')
        self.assertNotIn('organization_id', file_record.metadata)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_repair_organization_scope_should_persist_unique_upload_task_organization(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=True,
        )

        file_record = self._create_file_record(
            organization_id='',
            file_size=512,
            status='completed',
            include_organization_in_metadata=False,
        )
        upload_task = UploadTask.objects.create(
            task_name='repair-apply',
            task_type='batch',
            status='completed',
            organization_id='ws-upload-apply',
            total_files=1,
            completed_files=1,
            total_size=512,
            uploaded_size=512,
        )
        upload_task.files.add(file_record)

        response = self.client.post(
            '/api/auth/admin/oss/files/batch/repair-organization',
            data=json.dumps({'file_ids': [str(file_record.id)], 'dry_run': False}),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertFalse(payload['dry_run'])
        self.assertEqual(payload['repaired_count'], 1)
        self.assertEqual(payload['results'][0]['reason_code'], 'unique_upload_task_organization')
        self.assertEqual(payload['results'][0]['recommended_action_code'], 'auto_repair')
        self.assertEqual(payload['results'][0]['resolved_organization_id'], 'ws-upload-apply')

        file_record.refresh_from_db()
        self.assertEqual(file_record.organization_id, 'ws-upload-apply')
        self.assertEqual(file_record.metadata['organization_id'], 'ws-upload-apply')
        self.assertTrue(
            OSSAdminActionLog.objects.filter(action_type='repair_organization_scope').exists()
        )

    @patch('apps.services.oss.admin_api._collect_attachment_reference_organization_ids')
    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_repair_organization_scope_should_skip_conflicting_evidence(
        self,
        mock_auth,
        mock_reference_organization_ids,
    ):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=True,
        )
        mock_reference_organization_ids.return_value = (['ws-from-reference'], None)

        file_record = self._create_file_record(
            organization_id='',
            file_size=512,
            status='completed',
            include_organization_in_metadata=False,
        )
        upload_task = UploadTask.objects.create(
            task_name='repair-conflict',
            task_type='batch',
            status='completed',
            organization_id='ws-from-upload',
            total_files=1,
            completed_files=1,
            total_size=512,
            uploaded_size=512,
        )
        upload_task.files.add(file_record)

        response = self.client.post(
            '/api/auth/admin/oss/files/batch/repair-organization',
            data=json.dumps({'file_ids': [str(file_record.id)], 'dry_run': True}),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['repaired_count'], 0)
        self.assertEqual(payload['skipped_count'], 1)
        self.assertEqual(payload['results'][0]['reason_code'], 'cross_source_organization_conflict')
        self.assertEqual(
            payload['results'][0]['recommended_action_code'],
            'review_cross_source_conflict',
        )
        self.assertEqual(payload['results'][0]['reason'], '引用 organization 与上传任务 organization 冲突')

        file_record.refresh_from_db()
        self.assertEqual(file_record.organization_id, '')

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_list_tasks_should_support_organization_filter(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        UploadTask.objects.create(
            task_name='task-a',
            task_type='batch',
            total_files=1,
            completed_files=1,
            total_size=100,
            uploaded_size=100,
            status='completed',
            progress=100.0,
            created_by='user-a',
            organization_id='ws-task-a',
        )
        UploadTask.objects.create(
            task_name='task-b',
            task_type='batch',
            total_files=1,
            completed_files=1,
            total_size=100,
            uploaded_size=100,
            status='completed',
            progress=100.0,
            created_by='user-b',
            organization_id='ws-task-b',
        )

        response = self.client.get('/api/auth/admin/oss/tasks?organization_id=ws-task-a')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['pagination']['total'], 1)
        self.assertEqual(payload['items'][0]['organization_id'], 'ws-task-a')

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_list_operations_should_match_mixed_organization_scope(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        file_a = self._create_file_record(organization_id='ws-mixed-a')
        file_b = self._create_file_record(organization_id='ws-mixed-b')
        OSSAdminActionLog.objects.create(
            action_type='batch_delete',
            operator_name='ops-admin',
            organization_id='',
            organization_ids=['ws-mixed-a', 'ws-mixed-b'],
            organization_ids_text='|ws-mixed-a|ws-mixed-b|',
            target_file_ids=[str(file_a.id), str(file_b.id)],
            target_file_ids_text=self._build_target_file_ids_text([str(file_a.id), str(file_b.id)]),
            requested_count=2,
            processed_count=2,
            deleted_count=0,
            skipped_count=2,
            dry_run=True,
            success=True,
            message='mixed scope',
            trace_id='trace-mixed',
        )

        response = self.client.get('/api/auth/admin/oss/operations?organization_id=ws-mixed-a')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['pagination']['total'], 1)
        self.assertEqual(payload['items'][0]['organization_id'], '')
        self.assertEqual(payload['items'][0]['organization_ids'], ['ws-mixed-a', 'ws-mixed-b'])

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_batch_delete_dry_run_should_write_audit_log(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='root-admin',
            is_staff=True,
            is_superuser=True,
        )
        file_record = self._create_file_record(organization_id='ws-dry-run')

        response = self.client.post(
            '/api/auth/admin/oss/files/batch/delete',
            data=json.dumps(
                {
                    'file_ids': [str(file_record.id)],
                    'dry_run': True,
                }
            ),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload['dry_run'])
        self.assertEqual(payload['processed_count'], 1)
        self.assertEqual(payload['deleted_count'], 0)

        file_record.refresh_from_db()
        self.assertEqual(file_record.status, 'completed')

        log = OSSAdminActionLog.objects.get()
        self.assertTrue(log.dry_run)
        self.assertTrue(log.success)
        self.assertEqual(log.requested_count, 1)
        self.assertEqual(log.processed_count, 1)
        self.assertEqual(log.deleted_count, 0)
        self.assertEqual(log.target_file_ids, [str(file_record.id)])

    @patch('apps.services.oss.admin_api.get_oss_service')
    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_batch_delete_execute_should_soft_delete_and_record_log(self, mock_auth, mock_get_oss_service):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='root-admin',
            is_staff=True,
            is_superuser=True,
        )

        file_success = self._create_file_record(organization_id='ws-exec-1')
        file_failed = self._create_file_record(organization_id='ws-exec-2')

        mock_service = Mock()
        mock_service.delete_file.side_effect = [
            {'success': True},
            {'success': False, 'message': 'not found'},
        ]
        mock_get_oss_service.return_value = mock_service

        response = self.client.post(
            '/api/auth/admin/oss/files/batch/delete',
            data=json.dumps(
                {
                    'file_ids': [str(file_success.id), str(file_failed.id)],
                    'dry_run': False,
                }
            ),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload['dry_run'])
        self.assertEqual(payload['deleted_count'], 1)
        self.assertEqual(len(payload['skipped']), 1)

        file_success.refresh_from_db()
        file_failed.refresh_from_db()
        self.assertEqual(file_success.status, 'deleted')
        self.assertEqual(file_failed.status, 'completed')

        log = OSSAdminActionLog.objects.get()
        self.assertFalse(log.dry_run)
        self.assertTrue(log.success)
        self.assertEqual(log.requested_count, 2)
        self.assertEqual(log.processed_count, 2)
        self.assertEqual(log.deleted_count, 1)
        self.assertEqual(log.skipped_count, 1)

    @patch('apps.services.oss.admin_api.get_oss_service')
    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_batch_delete_should_record_failed_log_when_service_init_error(
        self,
        mock_auth,
        mock_get_oss_service,
    ):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='root-admin',
            is_staff=True,
            is_superuser=True,
        )
        file_record = self._create_file_record(organization_id='ws-init-fail')
        mock_get_oss_service.side_effect = RuntimeError('init failed')

        response = self.client.post(
            '/api/auth/admin/oss/files/batch/delete',
            data=json.dumps(
                {
                    'file_ids': [str(file_record.id)],
                    'dry_run': False,
                }
            ),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 500)

        log = OSSAdminActionLog.objects.get()
        self.assertFalse(log.dry_run)
        self.assertFalse(log.success)
        self.assertEqual(log.requested_count, 1)
        self.assertIn('init failed', log.error_message)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_read_endpoints_should_require_staff_user(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='normal-user',
            is_staff=False,
            is_superuser=False,
        )

        operations_resp = self.client.get('/api/auth/admin/oss/operations')
        costs_resp = self.client.get('/api/auth/admin/oss/costs')

        self.assertEqual(operations_resp.status_code, 403)
        self.assertEqual(costs_resp.status_code, 403)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_write_endpoint_should_require_superuser(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='staff-user',
            is_staff=True,
            is_superuser=False,
        )

        file_record = self._create_file_record(organization_id='ws-no-superuser')
        response = self.client.post(
            '/api/auth/admin/oss/files/batch/delete',
            data=json.dumps(
                {
                    'file_ids': [str(file_record.id)],
                    'dry_run': True,
                }
            ),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(OSSAdminActionLog.objects.count(), 0)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_endpoints_should_require_authentication(self, mock_auth):
        mock_auth.return_value = None

        operations_resp = self.client.get('/api/auth/admin/oss/operations')
        delete_resp = self.client.post(
            '/api/auth/admin/oss/files/batch/delete',
            data=json.dumps(
                {
                    'file_ids': [str(uuid.uuid4())],
                    'dry_run': True,
                }
            ),
            content_type='application/json',
        )

        self.assertEqual(operations_resp.status_code, 401)
        self.assertEqual(delete_resp.status_code, 401)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_operations_should_validate_query_params(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        invalid_action_resp = self.client.get('/api/auth/admin/oss/operations?action_type=invalid')
        invalid_operator_resp = self.client.get(
            '/api/auth/admin/oss/operations?operator_id=not-a-uuid'
        )
        invalid_file_resp = self.client.get('/api/auth/admin/oss/operations?file_id=bad-uuid')

        self.assertEqual(invalid_action_resp.status_code, 400)
        self.assertEqual(invalid_operator_resp.status_code, 400)
        self.assertEqual(invalid_file_resp.status_code, 400)

    @patch('apps.users.auth.api.JWTAuth.__call__')
    def test_costs_should_support_organization_keyword_filter(self, mock_auth):
        mock_auth.return_value = SimpleNamespace(
            id=str(uuid.uuid4()),
            username='ops-admin',
            is_staff=True,
            is_superuser=False,
        )

        self._create_file_record(organization_id='alpha-workspace', file_size=1200, status='completed')
        self._create_file_record(organization_id='beta-workspace', file_size=800, status='completed')
        OrganizationStorageUsage.objects.create(
            organization_id='alpha-workspace',
            active_file_count=1,
            active_storage_bytes=1000,
        )
        OrganizationStorageUsage.objects.create(
            organization_id='gamma-workspace',
            active_file_count=1,
            active_storage_bytes=500,
        )

        response = self.client.get('/api/auth/admin/oss/costs?organization_keyword=alpha')
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload['pagination']['total'], 1)
        self.assertEqual(payload['summary']['organization_count'], 1)
        self.assertEqual(payload['items'][0]['organization_id'], 'alpha-workspace')


# ──────────────────────────────────────────────────────────────────
# FileRegistryService + upload_bytes
# ──────────────────────────────────────────────────────────────────


_MOCK_OSS_PATCH = "apps.services.oss.services.factory.get_oss_service"


def _make_mock_oss_service():
    svc = MagicMock()
    svc.build_access_url.side_effect = lambda key: f"https://bucket.oss.example.com/{key}"
    svc.build_cdn_url.side_effect = lambda key: f"https://cdn.example.com/{key}"
    svc.config = {"bucket_name": "test-bucket"}
    return svc


class FileRegistryServiceTests(TestCase):
    """register_uploaded_file 核心路径测试"""

    @patch(_MOCK_OSS_PATCH, return_value=_make_mock_oss_service())
    def test_register_creates_file_record_and_usage(self, _):
        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())

        record = FileRegistryService.register_uploaded_file(
            object_key="tabvideo/ws1/tts/demo.wav",
            file_name="demo.wav",
            file_size=4096,
            content_type="audio/wav",
            module="tabvideo",
            user_id=user_id,
            organization_id=organization_id,
            context_type="tts_audio",
            context_id="clip-1",
            file_hash="abc123",
        )

        self.assertIsInstance(record, FileRecord)
        self.assertEqual(record.status, "completed")
        self.assertEqual(record.file_name, "demo.wav")
        self.assertEqual(record.file_size, 4096)
        self.assertEqual(record.file_hash, "abc123")
        self.assertFalse(record.is_public)
        self.assertIn("cdn.example.com", record.cdn_url)

        usage = FileUsage.objects.get(file_record=record, module="tabvideo")
        self.assertTrue(usage.is_active)
        self.assertEqual(usage.context_type, "tts_audio")
        self.assertEqual(usage.context_id, "clip-1")

        record.refresh_from_db()
        self.assertEqual(record.ref_count, 1)

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    @patch(_MOCK_OSS_PATCH, return_value=_make_mock_oss_service())
    def test_register_with_organization_calls_billing(self, _, mock_billing):
        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())

        record = FileRegistryService.register_uploaded_file(
            object_key="tabvideo/ws1/tts/file.wav",
            file_name="file.wav",
            file_size=2048,
            content_type="audio/wav",
            module="tabvideo",
            user_id=user_id,
            organization_id=organization_id,
            context_type="tts_audio",
            context_id="clip-2",
        )

        mock_billing.assert_called_once()
        call_kwargs = mock_billing.call_args.kwargs
        self.assertEqual(call_kwargs["organization_id"], organization_id)
        self.assertEqual(call_kwargs["delta_bytes"], 2048)
        self.assertEqual(call_kwargs["file_id"], str(record.id))

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    @patch(_MOCK_OSS_PATCH, return_value=_make_mock_oss_service())
    def test_register_without_organization_skips_billing(self, _, mock_billing):
        user_id = str(uuid.uuid4())
        FileRegistryService.register_uploaded_file(
            object_key="misc/file.txt",
            file_name="file.txt",
            file_size=100,
            content_type="text/plain",
            module="other",
            user_id=user_id,
            organization_id="",
        )
        mock_billing.assert_not_called()

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    @patch(_MOCK_OSS_PATCH, return_value=_make_mock_oss_service())
    def test_register_billing_failure_does_not_block(self, _, mock_billing):
        user_id = str(uuid.uuid4())
        mock_billing.side_effect = RuntimeError("billing down")

        record = FileRegistryService.register_uploaded_file(
            object_key="tabvideo/ws1/file.wav",
            file_name="file.wav",
            file_size=1024,
            content_type="audio/wav",
            module="tabvideo",
            user_id=user_id,
            organization_id="ws-1",
            context_type="tts",
            context_id="c-1",
        )

        self.assertIsNotNone(record.id)
        self.assertEqual(record.status, "completed")

    @patch(_MOCK_OSS_PATCH, return_value=_make_mock_oss_service())
    def test_register_with_upload_ip(self, _):
        user_id = str(uuid.uuid4())
        record = FileRegistryService.register_uploaded_file(
            object_key="uploads/file.pdf",
            file_name="file.pdf",
            file_size=5000,
            content_type="application/pdf",
            module="chat",
            user_id=user_id,
            organization_id="ws-1",
            upload_source="direct_upload",
            upload_ip="192.168.1.1",
        )

        record.refresh_from_db()
        self.assertEqual(record.upload_ip, "192.168.1.1")

    @patch(_MOCK_OSS_PATCH, return_value=_make_mock_oss_service())
    def test_default_register_creates_private_file(self, _):
        record = FileRegistryService.register_uploaded_file(
            object_key="uploads/private-by-default.txt",
            file_name="private-by-default.txt",
            file_size=32,
            content_type="text/plain",
            module="chat",
            user_id=str(uuid.uuid4()),
            organization_id="ws-private-default",
            context_type="message",
            context_id="msg-1",
        )

        self.assertFalse(record.is_public)

    @patch(_MOCK_OSS_PATCH, return_value=_make_mock_oss_service())
    def test_overlong_extension_is_preserved_in_metadata_with_safe_record_value(self, _):
        extension = 'a' * 11
        record = FileRegistryService.register_uploaded_file(
            object_key='tabfiles/random.bin',
            file_name=f'payload.{extension}',
            file_size=32,
            content_type='application/octet-stream',
            module='tabfiles',
            user_id=str(uuid.uuid4()),
            context_type='space',
            context_id='space-item',
        )

        self.assertEqual(record.file_extension, 'bin')
        self.assertEqual(record.metadata['original_extension'], extension)
        self.assertEqual(record.file_name, f'payload.{extension}')


class IsPublicDefaultRegressionTests(TestCase):
    """OSS public 默认值收紧回归。"""

    databases = '__all__'

    _USER_AUTH_PATCH = 'apps.users.auth.permissions.JWTAuth.__call__'
    _UPLOAD_PERM_PATCH = 'apps.services.oss.api._check_upload_permission'
    _OWNERSHIP_PATCH = 'apps.services.oss.api._verify_presign_ownership'
    _API_OSS_PATCH = 'apps.services.oss.api.get_oss_service'
    _FACTORY_OSS_PATCH = 'apps.services.oss.services.factory.get_oss_service'
    _RESERVATION_PATCH = 'apps.services.oss.services.storage_reservation.assert_storage_with_reservation'
    _BILLING_PATCH = 'apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta'

    def setUp(self):
        self.client = Client()
        self.user_id = str(uuid.uuid4())

    @staticmethod
    def _mock_oss_service():
        svc = _make_mock_oss_service()
        svc.generate_presigned_url.return_value = 'https://oss.example.com/presigned-put-url'
        svc.file_exists.return_value = True
        svc.get_file_info.return_value = {
            'success': True,
            'data': {
                'content_length': 12,
                'content_type': 'text/plain',
            },
        }
        svc.upload_file.return_value = {
            'success': True,
            'data': {
                'access_url': 'https://bucket.oss.example.com/uploads/form.txt',
                'cdn_url': 'https://cdn.example.com/uploads/form.txt',
            },
        }
        return svc

    def _post_json(self, path: str, body: dict) -> 'tuple[int, dict]':
        resp = self.client.post(
            path,
            data=json.dumps(body),
            content_type='application/json',
            HTTP_AUTHORIZATION='Bearer fake-token',
        )
        try:
            payload = resp.json()
        except ValueError:
            payload = {'_raw': resp.content.decode('utf-8', errors='replace')}
        return resp.status_code, payload

    def test_presign_and_confirm_schema_default_is_private(self):
        from .schemas import ConfirmUploadRequest, PresignUploadFileItem, PresignUploadRequest

        presign = PresignUploadRequest(
            filename='demo.txt',
            file_size=1,
            content_type='text/plain',
        )
        batch_item = PresignUploadFileItem(
            filename='demo.txt',
            file_size=1,
            content_type='text/plain',
        )
        confirm = ConfirmUploadRequest(
            object_key='uploads/demo.txt',
            file_name='demo.txt',
            file_size=1,
            content_type='text/plain',
            context_id='ctx-1',
        )

        self.assertFalse(presign.is_public)
        self.assertFalse(batch_item.is_public)
        self.assertFalse(confirm.is_public)

    def test_confirm_upload_missing_is_public_creates_private_file_and_logs(self):
        oss = self._mock_oss_service()
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OWNERSHIP_PATCH, return_value=None), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._FACTORY_OSS_PATCH, return_value=oss), \
                patch(self._BILLING_PATCH), \
                self.assertLogs('apps.services.oss.api', level='WARNING') as logs:
            status, payload = self._post_json(
                '/api/services/oss/confirm-upload',
                {
                    'object_key': 'uploads/private-confirm.txt',
                    'file_name': 'private-confirm.txt',
                    'file_size': 12,
                    'content_type': 'text/plain',
                    'module': 'chat',
                    'context_type': 'message',
                    'context_id': 'msg-implicit',
                    'organization_id': 'ws-confirm-private',
                },
            )

        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get('success'), payload)
        record = FileRecord.objects.get(file_key='uploads/private-confirm.txt')
        self.assertFalse(record.is_public)
        self.assertTrue(any('is_public 未显式声明' in msg for msg in logs.output))

    def test_confirm_upload_tabfiles_defaults_to_public(self):
        oss = self._mock_oss_service()
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OWNERSHIP_PATCH, return_value=None), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._FACTORY_OSS_PATCH, return_value=oss), \
                patch(self._BILLING_PATCH):
            status, payload = self._post_json(
                '/api/services/oss/confirm-upload',
                {
                    'object_key': 'tabfiles/uploads/cloud-drive.txt',
                    'file_name': 'cloud-drive.txt',
                    'file_size': 12,
                    'content_type': 'text/plain',
                    'module': 'tabfiles',
                    'context_type': 'team_space_asset',
                    'context_id': 'space-1',
                    'organization_id': 'ws-tabfiles-public',
                },
            )

        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get('success'), payload)
        record = FileRecord.objects.get(file_key='tabfiles/uploads/cloud-drive.txt')
        self.assertTrue(record.is_public)
        oss.set_object_public_read.assert_called_once_with('tabfiles/uploads/cloud-drive.txt')

    def test_confirm_upload_tabfiles_forces_public_when_client_sends_false(self):
        oss = self._mock_oss_service()
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OWNERSHIP_PATCH, return_value=None), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._FACTORY_OSS_PATCH, return_value=oss), \
                patch(self._BILLING_PATCH):
            status, payload = self._post_json(
                '/api/services/oss/confirm-upload',
                {
                    'object_key': 'tabfiles/uploads/explicit-private.txt',
                    'file_name': 'explicit-private.txt',
                    'file_size': 12,
                    'content_type': 'text/plain',
                    'module': 'tabfiles',
                    'context_type': 'team_space_asset',
                    'context_id': 'space-2',
                    'organization_id': 'ws-tabfiles-public',
                    'is_public': False,
                },
            )

        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get('success'), payload)
        record = FileRecord.objects.get(file_key='tabfiles/uploads/explicit-private.txt')
        self.assertTrue(record.is_public)
        oss.set_object_public_read.assert_called_once_with('tabfiles/uploads/explicit-private.txt')

    def test_presign_upload_tabfiles_defaults_to_public(self):
        oss = self._mock_oss_service()
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._RESERVATION_PATCH, return_value={}):
            status, payload = self._post_json(
                '/api/services/oss/presign-upload',
                {
                    'filename': 'cloud-drive.txt',
                    'file_size': 12,
                    'content_type': 'text/plain',
                    'module': 'tabfiles',
                    'context_type': 'team_space_asset',
                    'context_id': 'space-3',
                    'organization_id': 'ws-tabfiles-public',
                },
            )

        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get('success'), payload)
        self.assertTrue(payload.get('data', {}).get('is_public'))

    def test_space_tabfiles_confirm_stores_executable_without_execution(self):
        oss = self._mock_oss_service()
        oss.get_file_info.return_value = {
            'success': True,
            'data': {
                'content_length': 12,
                'content_type': 'application/x-msdownload',
            },
        }
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OWNERSHIP_PATCH, return_value=None), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._FACTORY_OSS_PATCH, return_value=oss), \
                patch(self._BILLING_PATCH):
            status, payload = self._post_json(
                '/api/services/oss/confirm-upload',
                {
                    'object_key': 'tabfiles/random.exe',
                    'file_name': 'installer.exe',
                    'file_size': 12,
                    'content_type': 'application/x-msdownload',
                    'module': 'tabfiles',
                    'context_type': 'space',
                    'context_id': 'space-item',
                    'organization_id': str(uuid.uuid4()),
                    'is_public': False,
                },
            )

        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get('success'), payload)
        record = FileRecord.objects.get(file_key='tabfiles/random.exe')
        self.assertEqual(record.mime_type, 'application/x-msdownload')
        self.assertTrue(record.is_public)
        oss.set_object_public_read.assert_called_once_with('tabfiles/random.exe')

    def test_confirm_fails_closed_when_oss_head_cannot_verify_real_size(self):
        oss = self._mock_oss_service()
        oss.get_file_info.return_value = {
            'success': False,
            'data': None,
        }
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OWNERSHIP_PATCH, return_value=None), \
                patch(self._API_OSS_PATCH, return_value=oss):
            status, payload = self._post_json(
                '/api/services/oss/confirm-upload',
                {
                    'object_key': 'tabfiles/random.exe',
                    'file_name': 'installer.exe',
                    'file_size': 1,
                    'content_type': 'application/x-msdownload',
                    'module': 'tabfiles',
                    'context_type': 'space',
                    'context_id': 'space-item',
                    'is_public': False,
                },
            )

        self.assertEqual(status, 200, payload)
        self.assertFalse(payload.get('success'))
        self.assertIn('无法核验文件真实大小', payload['message'])
        self.assertFalse(
            FileRecord.objects.filter(file_key='tabfiles/random.exe').exists(),
        )

    def test_form_upload_explicit_public_works(self):
        oss = self._mock_oss_service()
        upload = SimpleUploadedFile('form.txt', b'hello public', content_type='text/plain')

        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._RESERVATION_PATCH, return_value={}), \
                patch(self._BILLING_PATCH):
            response = self.client.post(
                '/api/services/oss/upload',
                data={
                    'file': upload,
                    'folder': 'uploads',
                    'is_public': 'true',
                    'organization_id': 'ws-form-public',
                    'module': 'chat',
                    'context_type': 'message',
                    'context_id': 'msg-form-public',
                },
                HTTP_AUTHORIZATION='Bearer fake-token',
            )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertTrue(payload.get('success'), payload)
        record = FileRecord.objects.get(file_name='form.txt')
        self.assertTrue(record.is_public)


class UploadBytesTests(TestCase):
    """upload_bytes 委托 upload_file 的行为测试"""

    def test_upload_bytes_returns_cdn_url(self):
        from apps.services.oss.services.aliyun_oss import AliyunOSSService

        svc = AliyunOSSService.__new__(AliyunOSSService)
        svc.config = {"bucket_name": "test", "endpoint": "oss.example.com", "cdn_domain": "cdn.example.com"}
        svc.logger = MagicMock()

        svc.upload_file = MagicMock(return_value={
            "success": True,
            "data": {
                "cdn_url": "https://cdn.example.com/audio/demo.wav",
                "access_url": "https://bucket.oss.example.com/audio/demo.wav",
            },
        })

        url = svc.upload_bytes(b"fake-audio-data", "audio/demo.wav", content_type="audio/wav")

        self.assertEqual(url, "https://cdn.example.com/audio/demo.wav")
        svc.upload_file.assert_called_once()

    def test_upload_bytes_falls_back_to_access_url(self):
        """无 CDN 时返回 get_accessible_url；public-read 时等同于 build_access_url"""
        from apps.services.oss.services.aliyun_oss import AliyunOSSService

        svc = AliyunOSSService.__new__(AliyunOSSService)
        svc.config = {
            "bucket_name": "test",
            "endpoint": "oss.example.com",
            "access_mode": "public-read",
        }
        svc.logger = MagicMock()

        svc.upload_file = MagicMock(return_value={
            "success": True,
            "data": {
                "cdn_url": "",
                "access_url": "https://test.oss.example.com/audio/demo.wav",
            },
        })

        url = svc.upload_bytes(b"data", "audio/demo.wav")

        self.assertEqual(url, "https://test.oss.example.com/audio/demo.wav")

    def test_upload_bytes_raises_on_failure(self):
        from apps.services.oss.services.aliyun_oss import AliyunOSSService
        from apps.services.common.exceptions import OSSServiceException

        svc = AliyunOSSService.__new__(AliyunOSSService)
        svc.config = {"bucket_name": "test", "endpoint": "oss.example.com"}
        svc.logger = MagicMock()

        svc.upload_file = MagicMock(return_value={
            "success": False,
            "message": "upload failed",
        })

        with self.assertRaises(OSSServiceException):
            svc.upload_bytes(b"data", "audio/bad.wav")


# ──────────────────────────────────────────────────────────────────
# deactivate_file_usages_and_release_storage helper
# ──────────────────────────────────────────────────────────────────


class DeactivateHelperTests(TestCase):
    """deactivate_file_usages_and_release_storage 通用 helper 测试"""

    def _create_record_and_usage(self, *, organization_id="ws-1", module="tabvideo", context_id="ctx-1", file_size=2048):
        record = FileRecord.objects.create(
            file_name="test.mp4",
            file_key=f"uploads/{uuid.uuid4().hex}.mp4",
            file_path="/uploads/",
            file_size=file_size,
            file_type="video",
            mime_type="video/mp4",
            file_extension="mp4",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=organization_id,
        )
        usage = FileUsage.objects.create(
            file_record=record,
            module=module,
            context_type="clip",
            context_id=context_id,
            user_id=uuid.uuid4(),
            is_active=True,
        )
        return record, usage

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    def test_deactivates_and_releases_billing(self, mock_billing):
        from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage

        record, usage = self._create_record_and_usage()

        count = deactivate_file_usages_and_release_storage(
            module="tabvideo",
            context_filter={"context_type": "clip", "context_id": "ctx-1"},
            organization_id="ws-1",
            user_id="",
            biz_type="test_deactivate",
            biz_id="test-1",
            log_prefix="Test",
        )

        self.assertEqual(count, 1)
        usage.refresh_from_db()
        self.assertFalse(usage.is_active)
        mock_billing.assert_called_once()
        call_kwargs = mock_billing.call_args[1]
        self.assertEqual(call_kwargs["delta_bytes"], -2048)
        self.assertEqual(call_kwargs["organization_id"], "ws-1")

    def test_skips_billing_when_no_organization(self):
        from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage

        _record, usage = self._create_record_and_usage(organization_id="")

        count = deactivate_file_usages_and_release_storage(
            module="tabvideo",
            context_filter={"context_type": "clip", "context_id": "ctx-1"},
            organization_id="",
            user_id="",
            biz_type="test_no_ws",
            biz_id="test-2",
        )

        self.assertEqual(count, 1)
        usage.refresh_from_db()
        self.assertFalse(usage.is_active)

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta", side_effect=Exception("boom"))
    def test_billing_failure_does_not_block_deactivation(self, _mock_billing):
        from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage

        _record, usage = self._create_record_and_usage()

        count = deactivate_file_usages_and_release_storage(
            module="tabvideo",
            context_filter={"context_type": "clip", "context_id": "ctx-1"},
            organization_id="ws-1",
            user_id="",
            biz_type="test_fail",
            biz_id="test-3",
        )

        self.assertEqual(count, 1)
        usage.refresh_from_db()
        self.assertFalse(usage.is_active)

    def test_returns_zero_when_no_matching_usages(self):
        from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage

        count = deactivate_file_usages_and_release_storage(
            module="tabvideo",
            context_filter={"context_id": "nonexistent"},
            organization_id="ws-1",
            user_id="",
            biz_type="test_empty",
            biz_id="test-4",
        )

        self.assertEqual(count, 0)

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    def test_exclude_file_record_id_skips_matching_usage(self, mock_billing):
        from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage

        record_old, usage_old = self._create_record_and_usage(context_id="proj-1")
        record_new, usage_new = self._create_record_and_usage(context_id="proj-1")

        count = deactivate_file_usages_and_release_storage(
            module="tabvideo",
            context_filter={"context_type": "clip", "context_id": "proj-1"},
            exclude_file_record_id=str(record_new.id),
            organization_id="ws-1",
            user_id="",
            biz_type="test_exclude",
            biz_id="proj-1",
        )

        self.assertEqual(count, 1)
        usage_old.refresh_from_db()
        self.assertFalse(usage_old.is_active)
        usage_new.refresh_from_db()
        self.assertTrue(usage_new.is_active)


# ──────────────────────────────────────────────────────────────────
# TabMail pre_delete signal
# ──────────────────────────────────────────────────────────────────




# ──────────────────────────────────────────────────────────────────
# _apply_file_usage_and_billing helper
# ──────────────────────────────────────────────────────────────────


class ApplyFileUsageAndBillingTests(TestCase):
    """tasks._apply_file_usage_and_billing 直接单元测试"""

    def _make_file_record(self, *, organization_id="", file_size=2048):
        return FileRecord.objects.create(
            file_name="test.bin",
            file_key=f"uploads/{uuid.uuid4().hex}.bin",
            file_path="/uploads/",
            file_size=file_size,
            file_type="binary",
            mime_type="application/octet-stream",
            file_extension="bin",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=organization_id,
        )

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    def test_creates_file_usage_when_module_provided(self, mock_billing):
        from .tasks import _apply_file_usage_and_billing

        record = self._make_file_record()
        user_id = str(uuid.uuid4())

        _apply_file_usage_and_billing(
            record, 2048,
            module="tabvideo",
            user_id=user_id,
            context_type="clip",
            context_id="c-1",
        )

        usage = FileUsage.objects.get(file_record=record, module="tabvideo")
        self.assertTrue(usage.is_active)
        self.assertEqual(usage.context_type, "clip")
        self.assertEqual(usage.context_id, "c-1")
        self.assertEqual(str(usage.user_id), user_id)

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    def test_calls_billing_when_organization_provided(self, mock_billing):
        from .tasks import _apply_file_usage_and_billing

        ws_id = "ws-billing-test"
        record = self._make_file_record()
        user_id = str(uuid.uuid4())

        _apply_file_usage_and_billing(
            record, 4096,
            organization_id=ws_id,
            user_id=user_id,
        )

        record.refresh_from_db()
        self.assertEqual(record.organization_id, ws_id)
        self.assertEqual(record.upload_user, user_id)

        mock_billing.assert_called_once()
        kw = mock_billing.call_args[1]
        self.assertEqual(kw["organization_id"], ws_id)
        self.assertEqual(kw["delta_bytes"], 4096)
        self.assertEqual(kw["file_id"], str(record.id))
        self.assertEqual(kw["user_id"], user_id)

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    def test_skips_file_usage_when_module_empty(self, mock_billing):
        from .tasks import _apply_file_usage_and_billing

        record = self._make_file_record()

        _apply_file_usage_and_billing(record, 1024, module="")

        self.assertFalse(FileUsage.objects.filter(file_record=record).exists())

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    def test_skips_billing_when_organization_empty(self, mock_billing):
        from .tasks import _apply_file_usage_and_billing

        record = self._make_file_record()

        _apply_file_usage_and_billing(
            record, 1024,
            organization_id="",
            module="tabvideo",
            user_id=str(uuid.uuid4()),
            context_type="clip",
            context_id="c-x",
        )

        mock_billing.assert_not_called()

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    def test_skips_billing_when_file_size_zero(self, mock_billing):
        from .tasks import _apply_file_usage_and_billing

        record = self._make_file_record()

        _apply_file_usage_and_billing(
            record, 0,
            organization_id="ws-zero",
        )

        mock_billing.assert_not_called()

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta")
    @patch("apps.services.oss.models.FileUsage.add_usage", side_effect=RuntimeError("db error"))
    def test_file_usage_failure_does_not_block(self, _mock_add, mock_billing):
        from .tasks import _apply_file_usage_and_billing

        ws_id = "ws-usage-fail"
        record = self._make_file_record()

        _apply_file_usage_and_billing(
            record, 2048,
            organization_id=ws_id,
            module="tabvideo",
            user_id=str(uuid.uuid4()),
            context_type="clip",
            context_id="c-f",
        )

        self.assertFalse(FileUsage.objects.filter(file_record=record).exists())
        mock_billing.assert_called_once()

    @patch("apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta",
           side_effect=RuntimeError("billing down"))
    def test_billing_failure_does_not_block(self, _mock_billing):
        from .tasks import _apply_file_usage_and_billing

        ws_id = "ws-bill-fail"
        record = self._make_file_record()

        _apply_file_usage_and_billing(
            record, 2048,
            organization_id=ws_id,
            module="tabvideo",
            user_id=str(uuid.uuid4()),
            context_type="clip",
            context_id="c-bf",
        )

        usage = FileUsage.objects.filter(file_record=record, module="tabvideo")
        self.assertTrue(usage.exists())


# ──────────────────────────────────────────────────────────────────
# P0 IDOR 修复回归 — 秒传 / presigned-url 必须按 organization 隔离
# 详见 apps/services/oss/PRD-presign-organization-isolation-fix.md
# ──────────────────────────────────────────────────────────────────


class PresignUploadOrganizationIsolationTests(TestCase):
    """秒传 / presigned-url 必须按 organization 隔离（P0 IDOR / 数据泄漏修复回归）。

    覆盖三处修法：
    1. POST /presign-upload 秒传查询加 organization_id 过滤
    2. POST /presign-upload-batch 秒传查询加 organization_id 过滤
    3. POST /presigned-url 加 _check_organization_membership 校验
    """

    databases = '__all__'

    # mock 路径（patch 的是源定义处，不是 import 处）
    _USER_AUTH_PATCH = 'apps.users.auth.permissions.JWTAuth.__call__'
    _UPLOAD_PERM_PATCH = 'apps.services.oss.api._check_upload_permission'
    _ORGANIZATION_CHECK_PATCH = 'apps.services.oss.api._check_organization_membership'
    _OSS_PATCH = 'apps.services.oss.api.get_oss_service'
    _RESERVATION_PATCH = 'apps.services.oss.services.storage_reservation.assert_storage_with_reservation'
    _BILLING_PATCH = 'apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta'

    def setUp(self):
        self.client = Client()
        self.user_a_id = str(uuid.uuid4())
        self.user_b_id = str(uuid.uuid4())
        # organization_id 用短串保证可读；和 prompt 示例的 'wt_a'/'wt_b' 风格一致
        self.organization_a = 'wt-a-' + uuid.uuid4().hex[:8]
        self.organization_b = 'wt-b-' + uuid.uuid4().hex[:8]
        # 多个测试共用同一 hash 但每个 TestCase 重建（事务回滚），无冲突
        self.shared_hash = 'sharedhash' + uuid.uuid4().hex[:16]
        # organization A 的"老"文件：私有 + completed + 已知 hash，作为后续秒传探测目标
        self.record_a = FileRecord.objects.create(
            file_name='shared.txt',
            file_key=f'uploads/{self.organization_a}/{uuid.uuid4().hex}.txt',
            file_path='/uploads/',
            file_size=2048,
            file_type='document',
            mime_type='text/plain',
            file_extension='txt',
            file_hash=self.shared_hash,
            hash_algorithm='md5',
            bucket_name='test-bucket',
            organization_id=self.organization_a,
            upload_user=self.user_a_id,
            status='completed',
            is_public=False,
            access_url='https://oss.example.com/a/shared.txt',
        )

    @staticmethod
    def _mock_oss_service():
        svc = MagicMock()
        svc.build_access_url.side_effect = lambda key: f'https://bucket.oss.example.com/{key}'
        svc.build_cdn_url.side_effect = lambda key: f'https://cdn.example.com/{key}'
        svc.generate_presigned_url.return_value = 'https://oss.example.com/presigned-put-url'
        svc.config = {'bucket_name': 'test-bucket'}
        return svc

    def _post_json(self, path: str, body: dict, *, bearer: str = 'fake-token') -> 'tuple[int, dict]':
        resp = self.client.post(
            path,
            data=json.dumps(body),
            content_type='application/json',
            HTTP_AUTHORIZATION=f'Bearer {bearer}',
        )
        try:
            payload = resp.json()
        except ValueError:
            payload = {'_raw': resp.content.decode('utf-8', errors='replace')}
        return resp.status_code, payload

    def test_presign_upload_instant_organization_isolation_single(self):
        """organization B 用同 hash 调 /presign-upload 必须新建（不命中秒传）— IDOR 修复回归。"""
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_b_id, username='user-b')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OSS_PATCH, return_value=self._mock_oss_service()), \
                patch(self._RESERVATION_PATCH, return_value={}), \
                patch(self._BILLING_PATCH) as mock_billing:
            status, payload = self._post_json(
                '/api/services/oss/presign-upload',
                {
                    'filename': 'shared.txt',
                    'file_size': 2048,
                    'content_type': 'text/plain',
                    'file_hash': self.shared_hash,
                    'hash_algorithm': 'md5',
                    'organization_id': self.organization_b,
                    'module': 'tabdoc',
                    'context_type': 'document',
                    'context_id': 'doc-from-b',
                },
                bearer='token-b',
            )

        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get('success'), payload)
        data = payload['data']
        # 关键回归断言：organization B 不应命中 organization A 的秒传记录
        self.assertFalse(
            data.get('instant'),
            f'organization B 不应命中 organization A 的秒传（IDOR 漏洞）: {data}',
        )
        # 没有返回 organization A 的 file_id（不应泄漏对方文件元信息）
        self.assertNotEqual(data.get('file_id'), str(self.record_a.id))
        # 返回的是新的 presigned PUT URL，等待 B 真实上传
        self.assertIn('presigned_url', data)
        self.assertIn('object_key', data)

        # organization A 的 FileRecord 没有为 user_b 创建 FileUsage（秒传逻辑未触发）
        self.assertFalse(
            FileUsage.objects.filter(
                file_record=self.record_a, user_id=self.user_b_id,
            ).exists(),
        )
        # 不应触发 oss_instant_upload 计费（不能让 B 替 A 扛存储费）
        instant_billing_calls = [
            call for call in mock_billing.call_args_list
            if (call.kwargs or {}).get('biz_type') == 'oss_instant_upload'
        ]
        self.assertEqual(
            instant_billing_calls, [],
            f'organization B 跨越秒传不应触发任何 oss_instant_upload 计费: {mock_billing.call_args_list}',
        )

    def test_presign_upload_instant_same_organization_hits(self):
        """organization A 用同 hash 调 /presign-upload 必须命中秒传 — 正向不破回归。"""
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_a_id, username='user-a')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OSS_PATCH, return_value=self._mock_oss_service()), \
                patch(self._RESERVATION_PATCH, return_value={}), \
                patch(self._BILLING_PATCH):
            status, payload = self._post_json(
                '/api/services/oss/presign-upload',
                {
                    'filename': 'shared.txt',
                    'file_size': 2048,
                    'content_type': 'text/plain',
                    'file_hash': self.shared_hash,
                    'hash_algorithm': 'md5',
                    'organization_id': self.organization_a,
                    'module': 'tabdoc',
                    'context_type': 'document',
                    'context_id': 'doc-from-a',
                },
                bearer='token-a',
            )

        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get('success'), payload)
        data = payload['data']
        self.assertTrue(
            data.get('instant'),
            f'同 organization 同 hash 必须命中秒传（不能误杀正向场景）: {data}',
        )
        self.assertEqual(data.get('file_id'), str(self.record_a.id))

    def test_presign_upload_batch_organization_isolation(self):
        """/presign-upload-batch 同样按 organization 隔离。"""
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_b_id, username='user-b')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OSS_PATCH, return_value=self._mock_oss_service()), \
                patch(self._RESERVATION_PATCH, return_value={}), \
                patch(self._BILLING_PATCH) as mock_billing:
            status, payload = self._post_json(
                '/api/services/oss/presign-upload-batch',
                {
                    'files': [{
                        'filename': 'shared.txt',
                        'file_size': 2048,
                        'content_type': 'text/plain',
                        'file_hash': self.shared_hash,
                        'hash_algorithm': 'md5',
                        'module': 'tabdoc',
                        'context_type': 'document',
                        'context_id': 'doc-from-b-batch',
                    }],
                    'organization_id': self.organization_b,
                },
                bearer='token-b',
            )

        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get('success'), payload)
        data = payload['data']
        items = data.get('items') or []
        self.assertEqual(len(items), 1, data)
        item = items[0]
        self.assertFalse(
            item.get('instant'),
            f'batch organization B 不应命中 organization A 的秒传: {item}',
        )
        self.assertNotEqual(item.get('file_id'), str(self.record_a.id))
        self.assertIn('presigned_url', item)

        self.assertFalse(
            FileUsage.objects.filter(
                file_record=self.record_a, user_id=self.user_b_id,
            ).exists(),
        )
        instant_billing_calls = [
            call for call in mock_billing.call_args_list
            if (call.kwargs or {}).get('biz_type') == 'oss_instant_upload_batch'
        ]
        self.assertEqual(
            instant_billing_calls, [],
            f'organization B 跨越批量秒传不应触发 oss_instant_upload_batch 计费: {mock_billing.call_args_list}',
        )

    def test_presigned_url_endpoint_organization_check(self):
        """organization B 拿 organization A 的私有 file_id 调 /presigned-url 必须 404 file_not_found。

        本端点是 IDOR 攻击放大器（拿到签名 URL 后可分发 / 缓存 / 嵌入），所以
        修复时 organization 校验放在 owner/public 判断之前，即使 is_public=True
        也会拦截跨 organization 探测。本测试覆盖 is_public=False 的私有文件场景；
        is_public=True 的设计本身是公开（虽然 direct upload 默认 True 是单独的
        问题，见 PRD 延伸建议 1），不在本回归范围内。
        """
        def membership_side_effect(user, organization_id):
            # 用户 B 不在 organization A
            user_id = str(getattr(user, 'id', '')) if user else ''
            if user_id == self.user_b_id and organization_id == self.organization_a:
                return False
            return True

        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_b_id, username='user-b')), \
                patch(self._ORGANIZATION_CHECK_PATCH, side_effect=membership_side_effect):
            status, payload = self._post_json(
                '/api/services/oss/presigned-url',
                {
                    'file_id': str(self.record_a.id),
                    'expiration': 3600,
                    'method': 'GET',
                },
                bearer='token-b',
            )

        self.assertEqual(status, 200, payload)
        self.assertFalse(payload.get('success'), payload)
        # 修复后必须返回 file_not_found 而不是 file_access_denied
        # （file_not_found 防 file_id 存在性侧信道；access_denied 反而透露 file 存在）
        self.assertEqual(
            payload.get('error_code'), 'FILE_NOT_FOUND',
            f'跨 organization 探测必须返回 FILE_NOT_FOUND（避免侧信道泄漏 file_id 存在性）: {payload}',
        )


class TabDocHtmlPrivateUploadGuardTests(TestCase):
    """#7767：拒绝新 TabDoc HTML 公开上传；confirm 强制 object-private；local-object 拒裸私有 key。"""

    databases = '__all__'

    _USER_AUTH_PATCH = 'apps.users.auth.permissions.JWTAuth.__call__'
    _UPLOAD_PERM_PATCH = 'apps.services.oss.api._check_upload_permission'
    _OWNERSHIP_PATCH = 'apps.services.oss.api._verify_presign_ownership'
    _API_OSS_PATCH = 'apps.services.oss.api.get_oss_service'
    _FACTORY_OSS_PATCH = 'apps.services.oss.services.factory.get_oss_service'
    _BILLING_PATCH = 'apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta'
    _RESERVATION_PATCH = 'apps.services.oss.services.storage_reservation.assert_storage_with_reservation'

    def setUp(self):
        self.client = Client()
        self.user_id = str(uuid.uuid4())
        self.organization_id = str(uuid.uuid4())

    def _post_json(self, path: str, body: dict) -> 'tuple[int, dict]':
        resp = self.client.post(
            path,
            data=json.dumps(body),
            content_type='application/json',
            HTTP_AUTHORIZATION='Bearer fake-token',
        )
        try:
            payload = resp.json()
        except ValueError:
            payload = {'_raw': resp.content.decode('utf-8', errors='replace')}
        return resp.status_code, payload

    def test_presign_rejects_public_tabdoc_html(self):
        oss = _make_mock_oss_service()
        oss.generate_presigned_url.return_value = 'https://oss.example.com/presigned-put-url'
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._FACTORY_OSS_PATCH, return_value=oss), \
                patch(self._RESERVATION_PATCH, return_value=None):
            status, payload = self._post_json(
                '/api/services/oss/presign-upload',
                {
                    'filename': 'demo.html',
                    'file_size': 32,
                    'content_type': 'text/html',
                    'module': 'tabdoc',
                    'folder': 'tabdoc/html',
                    'context_type': 'document',
                    'context_id': str(uuid.uuid4()),
                    'organization_id': self.organization_id,
                    'is_public': True,
                },
            )
        self.assertEqual(status, 200, payload)
        self.assertFalse(payload.get('success'), payload)
        self.assertEqual(payload.get('error_code'), 'TABDOC_HTML_PUBLIC_UPLOAD_FORBIDDEN', payload)

    def test_confirm_rejects_public_tabdoc_html(self):
        oss = _make_mock_oss_service()
        oss.file_exists.return_value = True
        oss.get_file_info.return_value = {
            'success': True,
            'data': {'content_length': 32, 'content_type': 'text/html'},
        }
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OWNERSHIP_PATCH, return_value=None), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._FACTORY_OSS_PATCH, return_value=oss), \
                patch(self._BILLING_PATCH), \
                patch(self._RESERVATION_PATCH, return_value=None):
            status, payload = self._post_json(
                '/api/services/oss/confirm-upload',
                {
                    'object_key': f'tabdoc/html/{uuid.uuid4().hex}.html',
                    'file_name': 'demo.html',
                    'file_size': 32,
                    'content_type': 'text/html',
                    'module': 'tabdoc',
                    'context_type': 'document',
                    'context_id': str(uuid.uuid4()),
                    'organization_id': self.organization_id,
                    'is_public': True,
                },
            )
        self.assertEqual(status, 200, payload)
        self.assertFalse(payload.get('success'), payload)
        self.assertEqual(payload.get('error_code'), 'TABDOC_HTML_PUBLIC_UPLOAD_FORBIDDEN')

    def test_confirm_private_tabdoc_html_calls_set_object_private(self):
        object_key = f'tabdoc/html/{uuid.uuid4().hex}.html'
        oss = _make_mock_oss_service()
        oss.file_exists.return_value = True
        oss.get_file_info.return_value = {
            'success': True,
            'data': {'content_length': 32, 'content_type': 'text/html'},
        }
        oss.set_object_private.return_value = True
        oss.generate_presigned_url.return_value = (
            "https://bucket.oss.example.com/tabdoc/html/demo.html?sig=short"
        )
        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._UPLOAD_PERM_PATCH, return_value=None), \
                patch(self._OWNERSHIP_PATCH, return_value=None), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._FACTORY_OSS_PATCH, return_value=oss), \
                patch(self._BILLING_PATCH), \
                patch(self._RESERVATION_PATCH, return_value=None):
            status, payload = self._post_json(
                '/api/services/oss/confirm-upload',
                {
                    'object_key': object_key,
                    'file_name': 'demo.html',
                    'file_size': 32,
                    'content_type': 'text/html',
                    'module': 'tabdoc',
                    'context_type': 'document',
                    'context_id': str(uuid.uuid4()),
                    'organization_id': self.organization_id,
                    'is_public': False,
                },
            )
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get('success'), payload)
        record = FileRecord.objects.get(file_key=object_key)
        self.assertFalse(record.is_public)
        oss.set_object_private.assert_called_with(object_key)
        self.assertEqual(
            payload["data"]["access_url"],
            "https://bucket.oss.example.com/tabdoc/html/demo.html?sig=short",
        )

    def test_local_object_rejects_private_file_record(self):
        from .api import local_object

        object_key = f'tabdoc/html/{uuid.uuid4().hex}.html'
        FileRecord.objects.create(
            file_name='private.html',
            file_key=object_key,
            file_path='/tabdoc/html/',
            file_size=12,
            file_type='document',
            mime_type='text/html',
            file_extension='html',
            file_hash=uuid.uuid4().hex,
            bucket_name='test-bucket',
            status='completed',
            organization_id=self.organization_id,
            is_public=False,
        )
        request = SimpleNamespace(GET={}, META={}, path='/api/services/oss/local-object')
        fake_service = Mock()
        fake_service.download_file.return_value = {
            'success': True,
            'data': {'content': b'<html>secret</html>', 'content_type': 'text/html'},
        }
        with patch('apps.services.oss.api._is_local_oss_provider', return_value=True), \
                patch('apps.services.oss.api.get_oss_service', return_value=fake_service):
            response = local_object(request, object_key=object_key)
        self.assertEqual(response.status_code, 404)
        fake_service.download_file.assert_not_called()

    def test_form_upload_private_acl_failure_deletes_object_and_returns_error(self):
        """#7767：中转 /upload 在 set_object_private 失败时必须 fail-closed（删对象、无 FileRecord）。"""
        oss = _make_mock_oss_service()
        oss.upload_file.return_value = {
            'success': True,
            'data': {
                'access_url': 'https://bucket.oss.example.com/tabdoc/html/demo.html',
                'cdn_url': 'https://cdn.example.com/tabdoc/html/demo.html',
            },
        }
        oss.set_object_private.return_value = False
        oss.delete_file.return_value = {'success': True}
        oss._get_timestamp.return_value = ''
        upload = SimpleUploadedFile('demo.html', b'<html>x</html>', content_type='text/html')
        doc_id = str(uuid.uuid4())

        with patch(self._USER_AUTH_PATCH, return_value=SimpleNamespace(id=self.user_id, username='user')), \
                patch(self._API_OSS_PATCH, return_value=oss), \
                patch(self._RESERVATION_PATCH, return_value=None), \
                patch(
                    'apps.services.oss.services.storage_reservation.release_bytes',
                ) as release_bytes, \
                patch(self._BILLING_PATCH):
            response = self.client.post(
                '/api/services/oss/upload',
                data={
                    'file': upload,
                    'folder': 'tabdoc/html',
                    'is_public': 'false',
                    'organization_id': self.organization_id,
                    'module': 'tabdoc',
                    'context_type': 'document',
                    'context_id': doc_id,
                },
                HTTP_AUTHORIZATION='Bearer fake-token',
            )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertFalse(payload.get('success'), payload)
        self.assertEqual(payload.get('error_code'), 'PRIVATE_ACL_FAILED', payload)
        self.assertFalse(
            FileRecord.objects.filter(file_name='demo.html', upload_user=self.user_id).exists(),
            'ACL 失败后不得留下可用 FileRecord',
        )
        oss.set_object_private.assert_called_once()
        oss.delete_file.assert_called_once()
        deleted_key = oss.delete_file.call_args[0][0]
        self.assertTrue(str(deleted_key).startswith('tabdoc/html/'), deleted_key)
        release_bytes.assert_called_once_with(self.organization_id, len(b'<html>x</html>'))

    def test_private_tabdoc_html_instant_hit_rejects_public_record(self):
        """#7767：私有上传不得秒传复用历史公开 HTML FileRecord。"""
        from .api import _is_instant_hit_compatible_with_upload_scope

        public_html = FileRecord.objects.create(
            file_name='legacy.html',
            file_key=f'tabdoc/html/{uuid.uuid4().hex}.html',
            file_path='/tabdoc/html/',
            file_size=120_000,
            file_type='document',
            mime_type='text/html',
            file_extension='html',
            file_hash=uuid.uuid4().hex,
            bucket_name='test-bucket',
            status='completed',
            organization_id=self.organization_id,
            is_public=True,
        )
        self.assertFalse(
            _is_instant_hit_compatible_with_upload_scope(
                public_html,
                module='tabdoc',
                context_type='document',
                is_public=False,
                folder='tabdoc/html',
                object_key=public_html.file_key,
            )
        )
        private_html = FileRecord.objects.create(
            file_name='private.html',
            file_key=f'tabdoc/html/{uuid.uuid4().hex}.html',
            file_path='/tabdoc/html/',
            file_size=120_000,
            file_type='document',
            mime_type='text/html',
            file_extension='html',
            file_hash=uuid.uuid4().hex,
            bucket_name='test-bucket',
            status='completed',
            organization_id=self.organization_id,
            is_public=False,
        )
        self.assertTrue(
            _is_instant_hit_compatible_with_upload_scope(
                private_html,
                module='tabdoc',
                context_type='document',
                is_public=False,
                folder='tabdoc/html',
                object_key=private_html.file_key,
            )
        )
