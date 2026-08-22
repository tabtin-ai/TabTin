import json
import os
from unittest.mock import patch

import requests
from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import Client, TestCase

from apps.services.oss.models import FileRecord
from apps.tabtinspace.signals import create_default_organization
from apps.updater.models import AppRelease, UpdateLog
from apps.updater.services.readiness_service import ReleaseReadinessResult

# Django TestCase 会把 DEBUG 置 False；Admin 路由仅在 DEBUG 或该开关下注册。
os.environ.setdefault("TABTIN_ENABLE_ADMIN_API", "1")

User = get_user_model()

BASE = "/api/auth/admin/desktop-updates"


def _error_text(response) -> str:
    payload = response.json()
    if isinstance(payload, dict):
        for key in ("detail", "message", "error"):
            value = payload.get(key)
            if value:
                return str(value)
    return json.dumps(payload, ensure_ascii=False)


def _auth(token: str) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


class _FakeOSSService:
    def __init__(self):
        self.config = {
            "bucket_name": "tabtin-updater",
            "endpoint": "oss.example.com",
            "access_mode": "public-read",
            "cdn_domain": "cdn.example.com",
        }
        self.file_sizes: dict[str, int] = {}
        self.uploaded_bytes: dict[str, bytes] = {}

    def generate_presigned_url(self, object_key: str, expiration: int = 900, method: str = "PUT", content_type: str | None = None) -> str:
        return f"https://presign.example.com/{object_key}?method={method}&exp={expiration}"

    def build_access_url(self, object_key: str) -> str:
        return f"https://tabtin-updater.oss.example.com/{object_key}"

    def build_cdn_url(self, object_key: str) -> str:
        return f"https://cdn.example.com/{object_key}"

    def file_exists(self, object_key: str) -> bool:
        return object_key in self.file_sizes or object_key in self.uploaded_bytes

    def get_file_info(self, object_key: str) -> dict:
        if object_key in self.file_sizes:
            return {
                "success": True,
                "data": {"content_length": self.file_sizes[object_key]},
            }
        return {"success": False, "data": None}

    def upload_bytes(self, data: bytes, object_key: str, *, content_type: str = "application/octet-stream") -> str:
        self.uploaded_bytes[object_key] = data
        self.file_sizes[object_key] = len(data)
        return self.build_cdn_url(object_key)


class DesktopUpdateAdminApiTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)
        cls.addClassCleanup(post_save.connect, create_default_organization, sender=User)

    def setUp(self):
        self.client = Client()
        self.staff = User.objects.create_user(
            username="ops_staff",
            email="ops-staff@test.com",
            password="pass123",
            is_staff=True,
        )
        self.superuser = User.objects.create_superuser(
            username="root_admin",
            email="root-admin@test.com",
            password="pass123",
        )
        self.normal_user = User.objects.create_user(
            username="normal_user",
            email="normal-user@test.com",
            password="pass123",
        )
        self.staff_token = "staff-token"
        self.superuser_token = "superuser-token"
        self.normal_token = "normal-token"
        self.auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            side_effect=self._mock_jwt_auth,
        )
        self.auth_patcher.start()
        self.addCleanup(self.auth_patcher.stop)
        # InviteGate 在测试环境可能开启；staff/superuser 也需视为已兑邀请码。
        self.invite_gate_patcher = patch(
            "apps.users.auth.invite_gate_middleware.is_invite_gate_enabled",
            return_value=False,
        )
        self.invite_gate_patcher.start()
        self.addCleanup(self.invite_gate_patcher.stop)

    def _mock_jwt_auth(self, request, token):
        return {
            self.staff_token: self.staff,
            self.superuser_token: self.superuser,
            self.normal_token: self.normal_user,
        }.get(token)

    def _create_release(
        self,
        *,
        version: str,
        platform: str = "mac",
        arch: str = "x64",
        channel: str = "stable",
        published: bool = True,
        deprecated: bool = False,
        rollout_percentage: int = 20,
        feed_url: str = "",
        website_file_url: str | None = None,
    ) -> AppRelease:
        if website_file_url is None and platform == "mac" and channel == "stable":
            website_file_url = f"https://cdn.example.com/releases/{version}/{platform}-{arch}.dmg"
        release = AppRelease.objects.create(
            version=version,
            platform=platform,
            arch=arch,
            channel=channel,
            file_url=f"https://cdn.example.com/releases/{version}/{platform}-{arch}.zip",
            website_file_url=website_file_url or "",
            feed_url=feed_url,
            file_size=1024 * 1024 * 20,
            checksum_sha256="a" * 64,
            release_notes=f"{version} 发布说明",
            release_notes_en=f"{version} notes",
            rollout_percentage=rollout_percentage,
            created_by=self.superuser,
        )
        if published:
            release.publish()
        if deprecated:
            release.deprecate()
        return release

    def _ready_readiness(self, release: AppRelease) -> ReleaseReadinessResult:
        return ReleaseReadinessResult(
            manifest_url=release.get_manifest_url(),
            manifest_file=release.get_manifest_file(),
        ).finalize()

    def test_staff_can_view_overview_list_and_filtered_detail_distribution(self):
        published_release = self._create_release(version="1.2.0", platform="mac", arch="x64")
        self._create_release(version="1.1.0", platform="win", arch="x64", published=False)
        self._create_release(
            version="0.9.0",
            platform="mac",
            arch="arm64",
            channel="beta",
            deprecated=True,
        )

        UpdateLog.objects.create(
            user_id=self.staff.id,
            device_id="mac-x64-device",
            organization_id="ws-mac",
            from_version="1.1.0",
            to_version=published_release.version,
            platform=published_release.platform,
            arch=published_release.arch,
            channel=published_release.channel,
            trigger_source="manual",
            status="installed",
            progress=100,
            success=True,
        )
        UpdateLog.objects.create(
            user_id=self.staff.id,
            device_id="mac-arm64-device",
            organization_id="ws-mac-arm64",
            from_version="9.9.9",
            to_version="2.0.0",
            platform="mac",
            arch="arm64",
            channel=published_release.channel,
            trigger_source="ws_push",
            status="failed",
            progress=10,
            success=False,
            error_code="checksum_error",
            error_message="checksum mismatch",
        )

        overview_response = self.client.get(f"{BASE}/overview", **_auth(self.staff_token))
        self.assertEqual(overview_response.status_code, 200)
        overview = overview_response.json()
        self.assertEqual(overview["total_releases"], 3)
        self.assertEqual(overview["draft_releases"], 1)
        self.assertEqual(overview["published_releases"], 1)
        self.assertEqual(overview["deprecated_releases"], 1)
        self.assertEqual(overview["latest_matrix"]["stable"]["mac_x64"]["version"], "1.2.0")

        list_response = self.client.get(
            f"{BASE}/releases?channel=stable&platform=mac&status=published",
            **_auth(self.staff_token),
        )
        self.assertEqual(list_response.status_code, 200)
        list_payload = list_response.json()
        self.assertEqual(list_payload["pagination"]["total"], 1)
        self.assertEqual(list_payload["items"][0]["id"], published_release.id)
        self.assertEqual(list_payload["items"][0]["manifest_file"], "latest-mac.yml")
        self.assertTrue(list_payload["items"][0]["feed_url_derived"])

        detail_response = self.client.get(
            f"{BASE}/releases/{published_release.id}",
            **_auth(self.staff_token),
        )
        self.assertEqual(detail_response.status_code, 200)
        detail_payload = detail_response.json()
        self.assertEqual(detail_payload["metrics"]["installed_count"], 1)
        self.assertEqual(
            detail_payload["active_version_distribution"],
            [{"from_version": "1.1.0", "count": 1}],
        )
        self.assertEqual(
            detail_payload["release"]["effective_feed_url"],
            "https://cdn.example.com/releases/1.2.0/",
        )
        self.assertEqual(
            detail_payload["release"]["manifest_url"],
            "https://cdn.example.com/releases/1.2.0/latest-mac.yml",
        )

    def test_non_staff_cannot_view_desktop_update_admin_endpoints(self):
        response = self.client.get(f"{BASE}/overview", **_auth(self.normal_token))
        self.assertEqual(response.status_code, 403)

        release = self._create_release(version="1.0.1")
        readiness_response = self.client.post(
            f"{BASE}/releases/{release.id}/readiness-check",
            **_auth(self.normal_token),
        )
        self.assertEqual(readiness_response.status_code, 403)

        asset_intent_response = self.client.post(
            f"{BASE}/releases/{release.id}/asset-upload-intent",
            data=json.dumps(
                {
                    "asset_type": "package",
                    "file_name": "TabTin Setup.exe",
                    "file_size": 1024,
                    "content_type": "application/octet-stream",
                }
            ),
            content_type="application/json",
            **_auth(self.normal_token),
        )
        self.assertEqual(asset_intent_response.status_code, 403)

    @patch("apps.updater.services.readiness_service.requests.head")
    @patch("apps.updater.services.readiness_service.requests.get")
    def test_staff_can_run_release_readiness_check(self, mock_get, mock_head):
        release = self._create_release(
            version="3.0.0",
            platform="mac",
            arch="x64",
            feed_url="https://cdn.example.com/releases/3.0.0/",
        )
        manifest_text = """
version: 3.0.0
files:
  - url: mac-x64.zip
    sha512: fake-sha512==
    size: 20971520
releaseDate: 2026-03-07T10:00:00.000Z
""".strip()

        mock_get.return_value = self._mock_response(text=manifest_text)
        mock_head.return_value = self._mock_response(
            headers={"content-length": str(release.file_size)},
        )

        response = self.client.post(
            f"{BASE}/releases/{release.id}/readiness-check",
            **_auth(self.staff_token),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["blocking_issue_count"], 0)
        self.assertEqual(payload["warning_issue_count"], 0)
        self.assertEqual(payload["manifest_version"], "3.0.0")
        self.assertEqual(payload["asset"]["resolved_url"], release.file_url)
        self.assertEqual(payload["asset"]["http_status"], 200)

    @patch("apps.updater.services.readiness_service.requests.head")
    @patch("apps.updater.services.readiness_service.requests.get")
    def test_readiness_check_blocks_publish_when_manifest_mismatch(self, mock_get, mock_head):
        release = self._create_release(
            version="4.0.0",
            platform="mac",
            arch="x64",
            published=False,
            feed_url="https://cdn.example.com/releases/4.0.0/",
        )
        manifest_text = """
version: 9.9.9
files:
  - url: unexpected.zip
    sha512: fake-sha512==
    size: 20971520
""".strip()

        mock_get.return_value = self._mock_response(text=manifest_text)
        mock_head.return_value = self._mock_response(
            headers={"content-length": str(release.file_size)},
        )

        readiness_response = self.client.post(
            f"{BASE}/releases/{release.id}/readiness-check",
            **_auth(self.staff_token),
        )
        self.assertEqual(readiness_response.status_code, 200)
        readiness_payload = readiness_response.json()
        self.assertEqual(readiness_payload["status"], "blocked")
        self.assertGreaterEqual(readiness_payload["blocking_issue_count"], 2)
        issue_codes = {item["code"] for item in readiness_payload["issues"]}
        self.assertIn("manifest_version_mismatch", issue_codes)
        self.assertIn("manifest_asset_url_mismatch", issue_codes)

        publish_response = self.client.post(
            f"{BASE}/releases/{release.id}/publish",
            **_auth(self.superuser_token),
        )
        self.assertEqual(publish_response.status_code, 400)
        self.assertIn("发布前发布就绪检查未通过", _error_text(publish_response))

    def test_staff_can_preview_manifest_template(self):
        release = self._create_release(version="4.1.0", published=False)
        release.file_url = "https://cdn.example.com/desktop-updates/stable/mac/x64/4.1.0/TabTin-Setup-4.1.0.dmg"
        release.file_size = 20971520
        release.checksum_sha256 = "a" * 64
        release.checksum_sha512 = "b" * 88
        release.save(
            update_fields=[
                "file_url",
                "file_size",
                "checksum_sha256",
                "checksum_sha512",
                "updated_at",
            ]
        )

        response = self.client.get(
            f"{BASE}/releases/{release.id}/manifest-preview",
            **_auth(self.staff_token),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["can_generate"])
        self.assertEqual(payload["manifest_file"], "latest-mac.yml")
        self.assertIn("version: 4.1.0", payload["content"])
        self.assertIn("sha512:", payload["content"])

    def test_manifest_preview_reports_missing_prerequisites(self):
        release = self._create_release(version="4.1.1", published=False)
        release.file_url = ""
        release.file_size = 0
        release.checksum_sha256 = ""
        release.checksum_sha512 = ""
        release.save(
            update_fields=[
                "file_url",
                "file_size",
                "checksum_sha256",
                "checksum_sha512",
                "updated_at",
            ]
        )

        response = self.client.get(
            f"{BASE}/releases/{release.id}/manifest-preview",
            **_auth(self.staff_token),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["can_generate"])
        self.assertIn("请先上传安装包，再生成 Manifest。", payload["issues"])
        self.assertEqual(payload["content"], "")

    def test_superuser_can_create_draft_without_assets(self):
        create_response = self.client.post(
            f"{BASE}/releases",
            data=json.dumps(
                {
                    "version": "2.1.0",
                    "platform": "win",
                    "arch": "x64",
                    "channel": "stable",
                    "release_notes": "支持先建版本后传安装包",
                    "release_notes_en": "Create draft before uploading assets",
                }
            ),
            content_type="application/json",
            **_auth(self.superuser_token),
        )
        self.assertEqual(create_response.status_code, 200)
        payload = create_response.json()
        release = AppRelease.objects.get(id=payload["release"]["id"])
        self.assertEqual(release.file_url, "")
        self.assertEqual(release.file_size, 0)
        self.assertEqual(release.checksum_sha256, "")
        self.assertIn("尚未配置安装包地址", payload["release"]["source_warnings"][0])

    def test_superuser_can_upload_package_and_auto_generate_manifest(self):
        release = self._create_release(version="5.0.0", platform="win", arch="x64", published=False)
        fake_oss = _FakeOSSService()

        with patch("apps.updater.services.asset_service.get_updater_oss_service", return_value=fake_oss):
            intent_response = self.client.post(
                f"{BASE}/releases/{release.id}/asset-upload-intent",
                data=json.dumps(
                    {
                        "asset_type": "package",
                        "file_name": "TabTin Setup 5.0.0.exe",
                        "file_size": 31457280,
                        "content_type": "application/octet-stream",
                    }
                ),
                content_type="application/json",
                **_auth(self.superuser_token),
            )
            self.assertEqual(intent_response.status_code, 200)
            intent_payload = intent_response.json()
            self.assertTrue(intent_payload["object_key"].endswith("TabTin-5.0.0-windows.exe"))
            self.assertEqual(intent_payload["expected_file_name"], "TabTin-5.0.0-windows.exe")

            fake_oss.file_sizes[intent_payload["object_key"]] = 31457280

            complete_response = self.client.post(
                f"{BASE}/releases/{release.id}/asset-upload-complete",
                data=json.dumps(
                    {
                        "asset_type": "package",
                        "object_key": intent_payload["object_key"],
                        "file_name": intent_payload["file_name"],
                        "file_size": 31457280,
                        "content_type": intent_payload["content_type"],
                        "checksum_sha256": "d" * 64,
                        "checksum_sha512": "e" * 88,
                        "auto_generate_manifest": True,
                    }
                ),
                content_type="application/json",
                **_auth(self.superuser_token),
            )

        self.assertEqual(complete_response.status_code, 200)
        payload = complete_response.json()
        release.refresh_from_db()
        self.assertEqual(release.file_url, payload["asset"]["public_url"])
        self.assertEqual(release.file_size, 31457280)
        self.assertEqual(release.checksum_sha256, "d" * 64)
        self.assertEqual(release.checksum_sha512, "e" * 88)
        self.assertTrue(payload["asset"]["manifest_generated"])
        self.assertEqual(
            release.feed_url,
            "https://cdn.example.com/desktop-updates/stable/win/x64/5.0.0/",
        )

        manifest_key = "desktop-updates/stable/win/x64/5.0.0/latest.yml"
        self.assertIn(manifest_key, fake_oss.uploaded_bytes)
        manifest_text = fake_oss.uploaded_bytes[manifest_key].decode("utf-8")
        self.assertIn("version: 5.0.0", manifest_text)
        self.assertIn("TabTin-5.0.0-windows.exe", manifest_text)

        self.assertEqual(FileRecord.objects.filter(file_key=intent_payload["object_key"]).count(), 1)
        self.assertEqual(FileRecord.objects.filter(file_key=manifest_key).count(), 1)

    def test_package_upload_rejects_platform_mismatched_installer(self):
        release = self._create_release(version="5.0.2", platform="mac", arch="arm64", published=False)

        response = self.client.post(
            f"{BASE}/releases/{release.id}/asset-upload-intent",
            data=json.dumps(
                {
                    "asset_type": "package",
                    "file_name": "TabTin-Preprod-5.0.2-arm64.dmg",
                    "file_size": 31457280,
                    "content_type": "application/x-apple-diskimage",
                }
            ),
            content_type="application/json",
            **_auth(self.superuser_token),
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("macOS 自动更新安装包请上传 .zip 文件", _error_text(response))

    def test_superuser_can_upload_website_installer_without_touching_file_url(self):
        release = self._create_release(version="5.0.3", platform="mac", arch="arm64", published=False)
        release.file_url = "https://cdn.example.com/desktop-updates/stable/mac/arm64/5.0.3/TabTin-5.0.3-arm64-mac.zip"
        release.save(update_fields=["file_url", "updated_at"])
        fake_oss = _FakeOSSService()

        with patch("apps.updater.services.asset_service.get_updater_oss_service", return_value=fake_oss):
            intent_response = self.client.post(
                f"{BASE}/releases/{release.id}/asset-upload-intent",
                data=json.dumps(
                    {
                        "asset_type": "website_installer",
                        "file_name": "TabTin-5.0.3-arm64.dmg",
                        "file_size": 41943040,
                        "content_type": "application/x-apple-diskimage",
                    }
                ),
                content_type="application/json",
                **_auth(self.superuser_token),
            )
            self.assertEqual(intent_response.status_code, 200)
            intent_payload = intent_response.json()
            self.assertTrue(intent_payload["object_key"].endswith("TabTin-5.0.3-arm64.dmg"))

            fake_oss.file_sizes[intent_payload["object_key"]] = 41943040
            complete_response = self.client.post(
                f"{BASE}/releases/{release.id}/asset-upload-complete",
                data=json.dumps(
                    {
                        "asset_type": "website_installer",
                        "object_key": intent_payload["object_key"],
                        "file_name": intent_payload["file_name"],
                        "file_size": 41943040,
                        "content_type": intent_payload["content_type"],
                        "auto_generate_manifest": False,
                    }
                ),
                content_type="application/json",
                **_auth(self.superuser_token),
            )

        self.assertEqual(complete_response.status_code, 200)
        payload = complete_response.json()
        release.refresh_from_db()
        self.assertEqual(release.website_file_url, payload["asset"]["public_url"])
        self.assertEqual(
            release.file_url,
            "https://cdn.example.com/desktop-updates/stable/mac/arm64/5.0.3/TabTin-5.0.3-arm64-mac.zip",
        )
        self.assertFalse(payload["asset"]["manifest_generated"])
        self.assertEqual(payload["release"]["website_asset_name"], "TabTin-5.0.3-arm64.dmg")
        self.assertEqual(payload["release"]["download_file_url"], release.website_file_url)

    def test_superuser_can_overwrite_same_object_key_without_duplicate_file_records(self):
        release = self._create_release(version="5.1.0", published=False)
        fake_oss = _FakeOSSService()
        # 托管上传会规范化为短文件名 TabTin-{ver}-{arch}-mac.zip
        object_key = "desktop-updates/stable/mac/x64/5.1.0/TabTin-5.1.0-x64-mac.zip"
        fake_oss.file_sizes[object_key] = 2048

        payload = {
            "asset_type": "package",
            "object_key": object_key,
            "file_name": "TabTin-5.1.0-x64-mac.zip",
            "file_size": 2048,
            "content_type": "application/octet-stream",
            "checksum_sha256": "f" * 64,
            "checksum_sha512": "g" * 88,
            "auto_generate_manifest": False,
        }

        with patch("apps.updater.services.asset_service.get_updater_oss_service", return_value=fake_oss):
            first_response = self.client.post(
                f"{BASE}/releases/{release.id}/asset-upload-complete",
                data=json.dumps(payload),
                content_type="application/json",
                **_auth(self.superuser_token),
            )
            self.assertEqual(first_response.status_code, 200)

            second_response = self.client.post(
                f"{BASE}/releases/{release.id}/asset-upload-complete",
                data=json.dumps(payload),
                content_type="application/json",
                **_auth(self.superuser_token),
            )
            self.assertEqual(second_response.status_code, 200)

        self.assertEqual(FileRecord.objects.filter(file_key=object_key).count(), 1)

    def test_superuser_can_complete_release_lifecycle(self):
        create_payload = {
            "version": "2.0.0",
            "platform": "mac",
            "arch": "x64",
            "channel": "stable",
            "file_url": "https://cdn.example.com/releases/2.0.0/mac-x64.zip",
            "feed_url": "https://cdn.example.com/releases/stable/mac/",
            "file_size": 10485760,
            "checksum_sha256": "b" * 64,
            "is_mandatory": False,
            "min_compatible_version": "1.5.0",
            "priority": "high",
            "rollout_percentage": 25,
            "rollout_target_users": ["user-a", "user-b"],
            "release_notes": "支持一键更新",
            "release_notes_en": "Support one click update",
        }

        create_response = self.client.post(
            f"{BASE}/releases",
            data=json.dumps(create_payload),
            content_type="application/json",
            **_auth(self.superuser_token),
        )
        self.assertEqual(create_response.status_code, 200)
        release_id = create_response.json()["release"]["id"]
        release = AppRelease.objects.get(id=release_id)
        self.assertTrue(release.is_draft)
        self.assertEqual(release.feed_url, "https://cdn.example.com/releases/stable/mac/")

        update_response = self.client.put(
            f"{BASE}/releases/{release_id}",
            data=json.dumps(
                {
                    "file_url": "https://cdn.example.com/releases/2.0.0/mac-x64-v2.zip",
                    "feed_url": "https://cdn.example.com/releases/stable/mac/v2/",
                    "file_size": 20971520,
                    "checksum_sha256": "c" * 64,
                    "rollout_percentage": 40,
                    "release_notes": "支持一键更新，并优化提醒文案",
                }
            ),
            content_type="application/json",
            **_auth(self.superuser_token),
        )
        self.assertEqual(update_response.status_code, 200)
        release.refresh_from_db()
        self.assertEqual(release.feed_url, "https://cdn.example.com/releases/stable/mac/v2/")
        self.assertEqual(release.file_size, 20971520)
        self.assertEqual(release.rollout_percentage, 40)

        with patch(
            "apps.updater.admin_api.ReleaseReadinessService.check_release",
            return_value=self._ready_readiness(release),
        ):
            publish_response = self.client.post(
                f"{BASE}/releases/{release_id}/publish",
                **_auth(self.superuser_token),
            )
            self.assertEqual(publish_response.status_code, 200)
        release.refresh_from_db()
        self.assertFalse(release.is_draft)
        self.assertIsNotNone(release.published_at)

        with patch(
            "apps.updater.admin_api.ReleaseReadinessService.check_release",
            return_value=self._ready_readiness(release),
        ), patch("apps.updater.admin_api.UpdatePushService") as mock_service_cls:
            push_response = self.client.post(
                f"{BASE}/releases/{release_id}/push",
                data=json.dumps({"silent": True, "rollout_percentage": 40}),
                content_type="application/json",
                **_auth(self.superuser_token),
            )
            self.assertEqual(push_response.status_code, 200)
            mock_service_cls.return_value.push_update.assert_called_once()

        with patch(
            "apps.updater.admin_api.ReleaseReadinessService.check_release",
            return_value=self._ready_readiness(release),
        ), patch("apps.updater.admin_api.UpdatePushService") as mock_service_cls:
            rollout_response = self.client.post(
                f"{BASE}/releases/{release_id}/rollout",
                data=json.dumps({"rollout_percentage": 100}),
                content_type="application/json",
                **_auth(self.superuser_token),
            )
            self.assertEqual(rollout_response.status_code, 200)
            self.assertEqual(rollout_response.json()["release"]["rollout_percentage"], 100)
            mock_service_cls.return_value.push_update.assert_called_once()

        with patch("apps.updater.admin_api.ReleaseReadinessService.check_release") as readiness_mock, \
             patch("apps.updater.admin_api.UpdatePushService") as mock_service_cls:
            stop_rollout_response = self.client.post(
                f"{BASE}/releases/{release_id}/rollout",
                data=json.dumps({"rollout_percentage": 0}),
                content_type="application/json",
                **_auth(self.superuser_token),
            )
            self.assertEqual(stop_rollout_response.status_code, 200)
            self.assertEqual(stop_rollout_response.json()["release"]["rollout_percentage"], 0)
            readiness_mock.assert_not_called()
            mock_service_cls.assert_not_called()

        deprecate_response = self.client.post(
            f"{BASE}/releases/{release_id}/deprecate",
            **_auth(self.superuser_token),
        )
        self.assertEqual(deprecate_response.status_code, 200)
        release.refresh_from_db()
        self.assertTrue(release.is_deprecated)

    @staticmethod
    def _mock_response(
        *,
        status_code: int = 200,
        text: str = "",
        headers: dict | None = None,
    ):
        class _Response:
            def __init__(self):
                self.status_code = status_code
                self.text = text
                self.headers = headers or {}

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise requests.HTTPError(f"HTTP {self.status_code}")

            def close(self):
                return None

        return _Response()
