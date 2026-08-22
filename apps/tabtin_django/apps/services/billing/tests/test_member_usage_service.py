from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from apps.services.billing.services.member_usage_service import build_user_info_map


User = get_user_model()


class MemberUsageServiceTests(TestCase):
    databases = {"default"}

    @override_settings(ASSET_PUBLIC_DOMAIN="assets.example.com")
    def test_build_user_info_map_builds_public_url_from_legacy_oss_avatar(self):
        user = User.objects.create_user(
            username="avatar_user",
            email="avatar_user@test.com",
            password="pass123",
        )
        user.avatar = (
            "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/"
            "user-avatars/155b6b12c3184973bd80bbb64b057b46.png"
        )
        user.save(update_fields=["avatar"])

        info = build_user_info_map([str(user.id)])

        self.assertEqual(
            info[str(user.id)]["avatar"],
            "https://assets.example.com/user-avatars/155b6b12c3184973bd80bbb64b057b46.png",
        )

    @override_settings(ASSET_PUBLIC_DOMAIN="assets.example.com")
    def test_build_user_info_map_builds_public_url_from_avatar_object_key(self):
        user = User.objects.create_user(
            username="avatar_key_user",
            email="avatar_key_user@test.com",
            password="pass123",
        )
        user.avatar = "user-avatars/155b6b12c3184973bd80bbb64b057b46.png"
        user.save(update_fields=["avatar"])

        info = build_user_info_map([str(user.id)])

        self.assertEqual(
            info[str(user.id)]["avatar"],
            "https://assets.example.com/user-avatars/155b6b12c3184973bd80bbb64b057b46.png",
        )
