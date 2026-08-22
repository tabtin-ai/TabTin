"""
DU-001 回归测试 — presign-upload siteId 归属校验

验证：当 object_key 匹配 tabsite/sites/{siteId}/ 格式时，
_validate_tabsite_key_ownership 必须校验 siteId 归属当前用户。
恶意用户传入他人 siteId 时应被拒绝。
"""
import uuid
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase

from apps.services.common.exceptions import ValidationException


class ValidateTabsiteKeyOwnershipTest(SimpleTestCase):
    """_validate_tabsite_key_ownership 单元测试"""

    def _call(self, object_key: str, user_id: str):
        from apps.services.oss.api import _validate_tabsite_key_ownership
        return _validate_tabsite_key_ownership(object_key, user_id)

    def test_non_tabsite_key_passes_without_check(self):
        """非 tabsite/sites/ 前缀的 key 直接放行"""
        self._call("_staging/abc/file.js", "user-123")
        self._call("tabsite/other/file.js", "user-123")

    def test_empty_user_id_rejected_for_tabsite_key(self):
        """tabsite/sites/ 路径 + 空 user_id → 拒绝"""
        with self.assertRaises(ValidationException) as ctx:
            self._call(f"tabsite/sites/{uuid.uuid4()}/upload1/index.html", "")
        self.assertIn("用户未认证", str(ctx.exception))

    @patch("apps.tabsite.models.Site.objects")
    def test_nonexistent_site_rejected(self, mock_objects):
        """siteId 不存在 → 拒绝"""
        mock_objects.filter.return_value.first.return_value = None
        fake_site_id = uuid.uuid4()
        with self.assertRaises(ValidationException) as ctx:
            self._call(
                f"tabsite/sites/{fake_site_id}/upload1/index.html",
                str(uuid.uuid4()),
            )
        self.assertIn("站点不存在", str(ctx.exception))

    @patch("apps.tabsite.models.Site.objects")
    def test_owner_passes(self, mock_objects):
        """owner_id 匹配 → 放行"""
        user_id = str(uuid.uuid4())
        site_id = str(uuid.uuid4())

        mock_site = MagicMock()
        mock_site.created_by_id = str(uuid.uuid4())
        mock_site.owner_id = uuid.UUID(user_id)
        mock_objects.filter.return_value.first.return_value = mock_site

        self._call(f"tabsite/sites/{site_id}/upload1/index.html", user_id)

    @patch("apps.tabsite.models.Site.objects")
    def test_creator_passes(self, mock_objects):
        """created_by_id 匹配 → 放行"""
        user_id = str(uuid.uuid4())
        site_id = str(uuid.uuid4())

        mock_site = MagicMock()
        mock_site.created_by_id = user_id
        mock_site.owner_id = None
        mock_objects.filter.return_value.first.return_value = mock_site

        self._call(f"tabsite/sites/{site_id}/upload1/index.html", user_id)

    @patch("apps.tabsite.models.Site.objects")
    def test_other_user_rejected(self, mock_objects):
        """siteId 属于别人 → 拒绝"""
        attacker_id = str(uuid.uuid4())
        real_owner_id = str(uuid.uuid4())
        real_creator_id = str(uuid.uuid4())
        site_id = str(uuid.uuid4())

        mock_site = MagicMock()
        mock_site.created_by_id = real_creator_id
        mock_site.owner_id = uuid.UUID(real_owner_id)
        mock_objects.filter.return_value.first.return_value = mock_site

        with self.assertRaises(ValidationException) as ctx:
            self._call(
                f"tabsite/sites/{site_id}/upload1/index.html",
                attacker_id,
            )
        self.assertIn("无权操作", str(ctx.exception))


class GeneratePresignItemOwnershipTest(SimpleTestCase):
    """_generate_presign_item 集成归属校验的测试"""

    @patch("apps.services.oss.api._validate_tabsite_key_ownership")
    @patch("apps.services.oss.api._validate_object_key")
    @patch("apps.services.oss.api._validate_upload_params", return_value="js")
    def test_object_key_override_triggers_ownership_check(
        self, mock_params, mock_obj_key, mock_ownership,
    ):
        """传入 object_key_override 时必须调用归属校验"""
        from apps.services.oss.api import _generate_presign_item

        mock_oss = MagicMock()
        mock_oss.generate_presigned_url.return_value = "https://oss.example.com/presign"
        mock_oss.build_access_url.return_value = "https://oss.example.com/access"
        mock_oss.build_cdn_url.return_value = "https://cdn.example.com/cdn"

        site_id = str(uuid.uuid4())
        obj_key = f"tabsite/sites/{site_id}/upload1/index.js"
        user_id = str(uuid.uuid4())

        _generate_presign_item(
            mock_oss,
            filename="index.js",
            folder="",
            content_type="application/javascript",
            file_size=1024,
            object_key_override=obj_key,
            user_id=user_id,
        )

        mock_ownership.assert_called_once_with(obj_key, user_id)

    @patch("apps.services.oss.api._validate_tabsite_key_ownership")
    @patch("apps.services.oss.api._validate_folder")
    @patch("apps.services.oss.api._validate_upload_params", return_value="js")
    def test_no_override_skips_ownership_check(
        self, mock_params, mock_folder, mock_ownership,
    ):
        """不传 object_key_override 时不调用归属校验"""
        from apps.services.oss.api import _generate_presign_item

        mock_oss = MagicMock()
        mock_oss.generate_presigned_url.return_value = "https://oss.example.com/presign"
        mock_oss.build_access_url.return_value = "https://oss.example.com/access"
        mock_oss.build_cdn_url.return_value = "https://cdn.example.com/cdn"

        _generate_presign_item(
            mock_oss,
            filename="index.js",
            folder="uploads",
            content_type="application/javascript",
            file_size=1024,
            user_id=str(uuid.uuid4()),
        )

        mock_ownership.assert_not_called()


class RegexPatternTest(SimpleTestCase):
    """_TABSITE_SITE_KEY_RE 正则模式验证"""

    def test_matches_standard_tabsite_path(self):
        from apps.services.oss.api import _TABSITE_SITE_KEY_RE
        m = _TABSITE_SITE_KEY_RE.match("tabsite/sites/abc-123/upload1/index.html")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "abc-123")

    def test_matches_uuid_site_id(self):
        from apps.services.oss.api import _TABSITE_SITE_KEY_RE
        site_id = str(uuid.uuid4())
        m = _TABSITE_SITE_KEY_RE.match(f"tabsite/sites/{site_id}/u1/app.js")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), site_id)

    def test_no_match_for_tabsite_other_path(self):
        from apps.services.oss.api import _TABSITE_SITE_KEY_RE
        m = _TABSITE_SITE_KEY_RE.match("tabsite/other/file.js")
        self.assertIsNone(m)

    def test_no_match_for_staging(self):
        from apps.services.oss.api import _TABSITE_SITE_KEY_RE
        m = _TABSITE_SITE_KEY_RE.match("_staging/abc/file.js")
        self.assertIsNone(m)
