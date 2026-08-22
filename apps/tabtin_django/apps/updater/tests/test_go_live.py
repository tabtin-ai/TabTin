import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import Client, TestCase, override_settings

from apps.analytics.models import ShortLink
from apps.tabtinspace.signals import create_default_organization
from apps.updater.models import AppRelease
from apps.updater.services.cdn_ops_service import DesktopCdnOpsService, collect_release_cdn_urls
from apps.updater.services.go_live_service import DesktopGoLiveService
from apps.updater.services.readiness_service import ReleaseReadinessResult

User = get_user_model()
BASE = "/api/auth/admin/desktop-updates"


def _auth(token: str) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


class DesktopGoLiveTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)
        cls.addClassCleanup(post_save.connect, create_default_organization, sender=User)

    def setUp(self):
        self.client = Client()
        self.superuser = User.objects.create_superuser(
            username="golive_admin",
            email="golive-admin@test.com",
            password="pass123",
        )
        self.token = "golive-token"
        self.auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            side_effect=lambda request, token: self.superuser if token == self.token else None,
        )
        self.auth_patcher.start()
        self.addCleanup(self.auth_patcher.stop)
        self.invite_gate_patcher = patch(
            "apps.users.auth.invite_gate_middleware.is_invite_gate_enabled",
            return_value=False,
        )
        self.invite_gate_patcher.start()
        self.addCleanup(self.invite_gate_patcher.stop)

    def _ready(self, release: AppRelease) -> ReleaseReadinessResult:
        return ReleaseReadinessResult(
            manifest_url=release.get_manifest_url(),
            manifest_file=release.get_manifest_file(),
            status="ready",
        )

    def _create_win_draft(self, version: str = "0.7.127") -> AppRelease:
        return AppRelease.objects.create(
            version=version,
            platform="win",
            arch="x64",
            channel="beta",
            file_url=f"https://cdn.example.com/desktop-updates/beta/win/x64/{version}/TabTin-{version}-windows.exe",
            file_size=100,
            checksum_sha256="a" * 64,
            checksum_sha512="b" * 88,
            release_notes="go live test",
            is_draft=True,
            rollout_percentage=0,
            created_by=self.superuser,
        )

    def test_collect_release_cdn_urls_includes_manifest_package_blockmap(self):
        release = self._create_win_draft()
        urls = collect_release_cdn_urls(release)
        self.assertTrue(any(u.endswith("beta.yml") or u.endswith("/beta.yml") for u in urls) or any("yml" in u for u in urls))
        self.assertIn(release.file_url, urls)
        self.assertIn(f"{release.file_url}.blockmap", urls)

    @override_settings(UPDATER_CDN_OPS_MODE="mock")
    def test_mock_cdn_ops_marks_success(self):
        release = self._create_win_draft()
        result = DesktopCdnOpsService(mode="mock").run([release], refresh=True, warmup=True)
        self.assertTrue(result.ok)
        self.assertEqual(result.mode, "mock")
        self.assertGreaterEqual(len(result.items), 2)

    @override_settings(UPDATER_CDN_OPS_MODE="mock", PUBLIC_API_BASE_URL="")
    def test_go_live_dry_run_then_confirm_updates_short_link_and_publishes(self):
        release = self._create_win_draft()
        service = DesktopGoLiveService(cdn_service=DesktopCdnOpsService(mode="mock"))
        with patch.object(service.readiness, "check_release", side_effect=self._ready):
            preview = service.plan_or_execute(
                platform="win",
                channel="beta",
                release_ids=[release.id],
                dry_run=True,
            )
            self.assertTrue(preview.ok)
            self.assertTrue(preview.dry_run)
            self.assertEqual([s.id for s in preview.steps], ["readiness", "cdn", "publish", "short_link", "probe"])

            executed = service.plan_or_execute(
                platform="win",
                channel="beta",
                release_ids=[release.id],
                dry_run=False,
            )
        self.assertTrue(executed.ok)
        release.refresh_from_db()
        self.assertFalse(release.is_draft)
        link = ShortLink.objects.get(slug="win-x64")
        self.assertEqual(link.target_type, ShortLink.TargetType.STATIC)
        self.assertEqual(link.target_url, release.file_url)
        self.assertEqual(link.release_platform, "win")
        self.assertEqual(link.release_arch, "x64")
        self.assertEqual(link.release_channel, "beta")
        short_step = next(s for s in executed.steps if s.id == "short_link")
        self.assertTrue(short_step.ok)
        self.assertEqual(short_step.detail[0]["expected_resolved_url"], release.file_url)
