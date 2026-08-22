import base64
import hashlib
import hmac
import io
import json
import uuid
from datetime import timedelta
import zipfile
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from django.test import SimpleTestCase
from django.utils import timezone
from ninja.errors import HttpError

from .api import (
    CompleteBundleRequest,
    CreateBundleRequest,
    _owned_bundle,
    complete_bundle,
    create_bundle,
    create_download,
    list_admin_bundles,
)
from .models import DiagnosticBundle
from .tasks import (
    _scan_zip,
    expire_diagnostic_bundles,
    recover_stale_diagnostic_scans,
    scan_diagnostic_bundle,
)


def _zip_bytes(name: str = "meta.json", content: bytes = b"{}") -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, content)
    return output.getvalue()


class DiagnosticZipScannerTests(SimpleTestCase):
    def test_accepts_small_safe_zip_with_matching_integrity(self):
        content = _zip_bytes()
        bundle = SimpleNamespace(
            expected_size=len(content),
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
        result = _scan_zip(content, bundle)
        self.assertEqual(result["file_count"], 1)

    def test_rejects_path_traversal(self):
        content = _zip_bytes("../secret.txt", b"secret")
        bundle = SimpleNamespace(
            expected_size=len(content),
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
        with self.assertRaisesRegex(ValueError, "unsafe_path"):
            _scan_zip(content, bundle)

    def test_rejects_integrity_mismatch(self):
        content = _zip_bytes()
        bundle = SimpleNamespace(expected_size=len(content), expected_sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "sha256_mismatch"):
            _scan_zip(content, bundle)


class DiagnosticDownloadTests(SimpleTestCase):
    def _request(self):
        return SimpleNamespace(auth=SimpleNamespace(id=uuid.uuid4()), headers={})

    @patch("apps.diagnostics.api.DiagnosticDownloadAudit.objects.create")
    @patch("apps.diagnostics.api.get_oss_service")
    @patch("apps.diagnostics.api._owned_bundle")
    def test_available_bundle_url_is_generated_per_authorized_request(self, owned, get_oss, audit):
        bundle = SimpleNamespace(
            id=uuid.uuid4(),
            status=DiagnosticBundle.Status.AVAILABLE,
            object_key="diagnostics/org/bundle.zip",
            expires_at=timezone.now() + timedelta(days=1),
        )
        owned.return_value = bundle
        service = Mock()
        service.generate_presigned_url.return_value = "https://oss.example/signed?secret=one-time"
        get_oss.return_value = service

        result = create_download(self._request(), str(bundle.id))

        self.assertEqual(result["download_url"], service.generate_presigned_url.return_value)
        audit.assert_called_once()
        self.assertFalse(any(field.name.endswith("url") for field in DiagnosticBundle._meta.fields))

    @patch("apps.diagnostics.api._owned_bundle")
    def test_quarantined_bundle_never_generates_download_url(self, owned):
        owned.return_value = SimpleNamespace(
            id=uuid.uuid4(),
            status=DiagnosticBundle.Status.QUARANTINED,
            object_key="diagnostics/org/bundle.zip",
            expires_at=timezone.now() + timedelta(days=1),
        )
        with self.assertRaises(HttpError) as raised:
            create_download(self._request(), "bundle")
        self.assertEqual(raised.exception.status_code, 409)

    @patch("apps.diagnostics.api._owned_bundle")
    def test_expired_bundle_never_generates_download_url(self, owned):
        owned.return_value = SimpleNamespace(
            id=uuid.uuid4(),
            status=DiagnosticBundle.Status.AVAILABLE,
            object_key="diagnostics/org/bundle.zip",
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        with self.assertRaises(HttpError) as raised:
            create_download(self._request(), "bundle")
        self.assertEqual(raised.exception.status_code, 410)


class DiagnosticCreateTests(SimpleTestCase):
    def _request(self):
        return SimpleNamespace(auth=SimpleNamespace(id=uuid.uuid4()), headers={})

    @patch("apps.diagnostics.api.DiagnosticBundle.objects.create")
    @patch("apps.diagnostics.api.get_oss_service")
    @patch("apps.diagnostics.api._member")
    def test_upload_policy_is_bound_to_the_declared_size(self, member, get_oss, create):
        bundle_id = uuid.uuid4()
        create.return_value = SimpleNamespace(
            id=bundle_id,
            status=DiagnosticBundle.Status.PENDING_UPLOAD,
        )
        service = Mock()
        service.generate_bounded_upload.return_value = {
            "method": "POST",
            "url": "https://bucket.oss.example/",
            "fields": {"policy": "signed-policy"},
        }
        get_oss.return_value = service
        request = CreateBundleRequest(
            organization_id=str(uuid.uuid4()),
            client_install_id="install-1",
            expected_size=1234,
            expected_sha256="a" * 64,
            content_type="application/zip",
        )

        result = create_bundle(self._request(), request)

        service.generate_bounded_upload.assert_called_once()
        self.assertEqual(
            service.generate_bounded_upload.call_args.kwargs["content_length"],
            1234,
        )
        self.assertEqual(result["upload_method"], "POST")
        self.assertEqual(result["upload_fields"], {"policy": "signed-policy"})
        member.assert_called_once()

    @patch("apps.diagnostics.api.DiagnosticBundle.objects.create")
    @patch("apps.diagnostics.api.get_oss_service")
    @patch("apps.diagnostics.api._member")
    def test_signing_failure_does_not_leave_an_unusable_bundle(self, member, get_oss, create):
        service = Mock()
        service.generate_bounded_upload.side_effect = RuntimeError("signing unavailable")
        get_oss.return_value = service
        request = CreateBundleRequest(
            organization_id=str(uuid.uuid4()),
            client_install_id="install-1",
            expected_size=1234,
            expected_sha256="a" * 64,
        )

        with self.assertRaisesRegex(RuntimeError, "signing unavailable"):
            create_bundle(self._request(), request)

        create.assert_not_called()


class DiagnosticOSSUploadPolicyTests(SimpleTestCase):
    def test_aliyun_policy_rejects_any_size_other_than_expected(self):
        from apps.services.oss.services.aliyun_oss import AliyunOSSService

        service = AliyunOSSService.__new__(AliyunOSSService)
        service.config = {
            "bucket_name": "diagnostics",
            "endpoint": "oss-cn-example.aliyuncs.com",
        }
        service._upload_credentials = {
            "access_key_id": "test-id",
            "access_key_secret": "test-secret",
            "security_token": "test-token",
        }

        upload = service.generate_bounded_upload(
            "diagnostics/org/incoming/bundle.zip",
            expiration=900,
            content_type="application/zip",
            content_length=4321,
        )

        policy = json.loads(base64.b64decode(upload["fields"]["policy"]))
        self.assertIn(["content-length-range", 4321, 4321], policy["conditions"])
        expected_signature = base64.b64encode(
            hmac.new(
                b"test-secret",
                upload["fields"]["policy"].encode("ascii"),
                hashlib.sha1,
            ).digest()
        ).decode("ascii")
        self.assertEqual(upload["fields"]["Signature"], expected_signature)
        self.assertEqual(upload["fields"]["x-oss-security-token"], "test-token")


class DiagnosticBundleAccessTests(SimpleTestCase):
    def _request(self, user_id):
        return SimpleNamespace(auth=SimpleNamespace(id=user_id), headers={})

    @patch("apps.diagnostics.api.OrganizationMember.objects.filter")
    @patch("apps.diagnostics.api.DiagnosticBundle.objects.get")
    def test_creator_can_access_own_bundle(self, get_bundle, filter_member):
        user_id = uuid.uuid4()
        bundle = SimpleNamespace(
            organization_id=uuid.uuid4(),
            created_by_id=user_id,
        )
        get_bundle.return_value = bundle
        filter_member.return_value.first.return_value = SimpleNamespace(role="viewer")

        self.assertIs(_owned_bundle(self._request(user_id), str(uuid.uuid4())), bundle)

    @patch("apps.diagnostics.api.OrganizationMember.objects.filter")
    @patch("apps.diagnostics.api.DiagnosticBundle.objects.get")
    def test_admin_can_access_another_members_bundle(self, get_bundle, filter_member):
        bundle = SimpleNamespace(
            organization_id=uuid.uuid4(),
            created_by_id=uuid.uuid4(),
        )
        get_bundle.return_value = bundle
        filter_member.return_value.first.return_value = SimpleNamespace(role="admin")

        self.assertIs(_owned_bundle(self._request(uuid.uuid4()), str(uuid.uuid4())), bundle)

    @patch("apps.diagnostics.api.OrganizationMember.objects.filter")
    @patch("apps.diagnostics.api.DiagnosticBundle.objects.get")
    def test_regular_member_cannot_access_another_members_bundle(self, get_bundle, filter_member):
        get_bundle.return_value = SimpleNamespace(
            organization_id=uuid.uuid4(),
            created_by_id=uuid.uuid4(),
        )
        filter_member.return_value.first.return_value = SimpleNamespace(role="editor")

        with self.assertRaises(HttpError) as raised:
            _owned_bundle(self._request(uuid.uuid4()), str(uuid.uuid4()))
        self.assertEqual(raised.exception.status_code, 403)


class DiagnosticAdminInboxTests(SimpleTestCase):
    @patch("apps.diagnostics.api.phone_lookup_aliases", return_value=["13800001234", "+8613800001234"])
    @patch("apps.diagnostics.api.DiagnosticBundle.objects")
    def test_phone_lookup_matches_phone_aliases(self, bundles, aliases):
        rows = MagicMock()
        rows.count.return_value = 0
        rows.__getitem__.return_value = []
        bundles.select_related.return_value.order_by.return_value.filter.return_value = rows
        request = SimpleNamespace(auth=SimpleNamespace(is_staff=True))

        result = list_admin_bundles(request, query="+8613800001234")

        aliases.assert_called_once_with("+8613800001234")
        self.assertEqual(result["pagination"]["total"], 0)


class DiagnosticCompleteTests(SimpleTestCase):
    def _request(self):
        return SimpleNamespace(auth=SimpleNamespace(id=uuid.uuid4()), headers={})

    @patch("apps.diagnostics.api.transaction.on_commit")
    @patch("apps.diagnostics.api._owned_bundle")
    def test_uploaded_bundle_completion_is_idempotent_and_reschedules_scan(
        self, owned, on_commit
    ):
        bundle = SimpleNamespace(
            id=uuid.uuid4(),
            status=DiagnosticBundle.Status.UPLOADED,
            expected_size=42,
            expected_sha256="a" * 64,
        )
        owned.return_value = bundle

        result = complete_bundle.__wrapped__(
            self._request(),
            str(bundle.id),
            CompleteBundleRequest(size=42, sha256="a" * 64),
        )

        self.assertEqual(
            result,
            {"bundle_id": str(bundle.id), "status": DiagnosticBundle.Status.UPLOADED},
        )
        on_commit.assert_called_once()

    @patch("apps.diagnostics.api.transaction.on_commit")
    @patch("apps.diagnostics.api._owned_bundle")
    def test_available_bundle_completion_is_idempotent_without_rescan(self, owned, on_commit):
        bundle = SimpleNamespace(
            id=uuid.uuid4(),
            status=DiagnosticBundle.Status.AVAILABLE,
            expected_size=42,
            expected_sha256="b" * 64,
        )
        owned.return_value = bundle

        result = complete_bundle.__wrapped__(
            self._request(),
            str(bundle.id),
            CompleteBundleRequest(size=42, sha256="b" * 64),
        )

        self.assertEqual(
            result,
            {"bundle_id": str(bundle.id), "status": DiagnosticBundle.Status.AVAILABLE},
        )
        on_commit.assert_not_called()

    @patch("apps.diagnostics.api.transaction.on_commit")
    @patch("apps.diagnostics.api._owned_bundle")
    def test_scanning_bundle_completion_is_idempotent_without_rescan(self, owned, on_commit):
        bundle = SimpleNamespace(
            id=uuid.uuid4(),
            status=DiagnosticBundle.Status.SCANNING,
            expected_size=42,
            expected_sha256="c" * 64,
        )
        owned.return_value = bundle

        result = complete_bundle.__wrapped__(
            self._request(),
            str(bundle.id),
            CompleteBundleRequest(size=42, sha256="c" * 64),
        )

        self.assertEqual(
            result,
            {"bundle_id": str(bundle.id), "status": DiagnosticBundle.Status.SCANNING},
        )
        on_commit.assert_not_called()

    @patch("apps.diagnostics.api.transaction.on_commit")
    @patch("apps.diagnostics.api.get_oss_service")
    @patch("apps.diagnostics.api._owned_bundle")
    def test_completion_checks_nested_oss_content_length(self, owned, get_oss, on_commit):
        bundle = SimpleNamespace(
            id=uuid.uuid4(),
            status=DiagnosticBundle.Status.PENDING_UPLOAD,
            upload_object_key="diagnostics/incoming/bundle.zip",
            expected_size=42,
            expected_sha256="d" * 64,
            save=Mock(),
        )
        owned.return_value = bundle
        service = Mock()
        service.file_exists.return_value = True
        service.get_file_info.return_value = {
            "success": True,
            "data": {"content_length": 43},
        }
        get_oss.return_value = service

        with self.assertRaises(HttpError) as raised:
            complete_bundle.__wrapped__(
                self._request(),
                str(bundle.id),
                CompleteBundleRequest(size=42, sha256="d" * 64),
            )

        self.assertEqual(raised.exception.status_code, 422)
        service.get_file_info.assert_called_once_with(bundle.upload_object_key)
        on_commit.assert_not_called()

    @patch("apps.diagnostics.api._owned_bundle")
    @patch("apps.diagnostics.api.get_oss_service")
    def test_completion_rejects_missing_oss_metadata(self, get_oss, owned):
        bundle = SimpleNamespace(
            id=uuid.uuid4(),
            status=DiagnosticBundle.Status.PENDING_UPLOAD,
            upload_object_key="diagnostics/incoming/bundle.zip",
            expected_size=42,
            expected_sha256="e" * 64,
        )
        owned.return_value = bundle
        service = Mock()
        service.file_exists.return_value = True
        service.get_file_info.return_value = {"success": True, "data": {}}
        get_oss.return_value = service

        with self.assertRaises(HttpError) as raised:
            complete_bundle.__wrapped__(
                self._request(),
                str(bundle.id),
                CompleteBundleRequest(size=42, sha256="e" * 64),
            )

        self.assertEqual(raised.exception.status_code, 409)


class DiagnosticTaskSafetyTests(SimpleTestCase):
    @patch("apps.diagnostics.tasks.DiagnosticBundle.objects.filter")
    @patch("apps.diagnostics.tasks.get_oss_service")
    def test_duplicate_scan_task_stops_when_bundle_is_already_claimed(self, get_oss, filter_bundle):
        filter_bundle.return_value.update.return_value = 0

        scan_diagnostic_bundle(str(uuid.uuid4()))

        get_oss.assert_not_called()

    @patch("apps.diagnostics.tasks.DiagnosticBundle.objects.get")
    @patch("apps.diagnostics.tasks.DiagnosticBundle.objects.filter")
    @patch("apps.diagnostics.tasks.get_oss_service")
    def test_reclaimed_scan_stops_before_mutating_oss(self, get_oss, filter_bundle, get_bundle):
        content = _zip_bytes()
        bundle = SimpleNamespace(
            upload_object_key="diagnostics/incoming/bundle.zip",
            object_key="diagnostics/available/bundle.zip",
            expected_size=len(content),
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
        get_bundle.return_value = bundle
        claim = Mock()
        claim.update.return_value = 1
        lost_lease = Mock()
        lost_lease.update.return_value = 0
        filter_bundle.side_effect = [claim, lost_lease]
        service = Mock()
        service.download_file.return_value = {"success": True, "data": {"content": content}}
        get_oss.return_value = service

        scan_diagnostic_bundle(str(uuid.uuid4()))

        service.copy_file.assert_not_called()
        service.delete_file.assert_not_called()

    @patch("apps.diagnostics.tasks.get_oss_service")
    @patch("apps.diagnostics.tasks.DiagnosticBundle.objects.filter")
    def test_expiry_keeps_record_when_any_object_delete_fails(self, filter_bundle, get_oss):
        bundle = Mock(
            object_key="diagnostics/org/available/bundle.zip",
            upload_object_key="diagnostics/org/incoming/bundle.zip",
        )
        filter_bundle.return_value.exclude.return_value.iterator.return_value = [bundle]
        service = Mock()
        service.delete_file.side_effect = [{"success": True}, {"success": False}]
        get_oss.return_value = service

        expire_diagnostic_bundles()

        bundle.save.assert_not_called()

    @patch("apps.diagnostics.tasks.scan_diagnostic_bundle.delay")
    @patch("apps.diagnostics.tasks.DiagnosticBundle.objects.filter")
    def test_stale_scan_is_requeued_with_guarded_state_transition(self, filter_bundle, delay):
        bundle_id = uuid.uuid4()
        stale_query = MagicMock()
        stale_query.values_list.return_value.__getitem__.return_value = [bundle_id]
        guarded_query = Mock()
        guarded_query.update.return_value = 1
        filter_bundle.side_effect = [stale_query, guarded_query]

        recover_stale_diagnostic_scans()

        guarded_query.update.assert_called_once()
        delay.assert_called_once_with(str(bundle_id))
