from django.test import RequestFactory, TestCase

from apps.services.oss.models import FileRecord
from apps.users.auth.api.profile_routes import update_user_profile
from apps.users.auth.models import User
from apps.users.auth.schemas import UserProfileUpdateSchema


class UserAvatarFileRefTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.rf = RequestFactory()
        self.user = User.objects.create_user(
            username="avatar_ref_user",
            email="avatar_ref_user@test.com",
            password="pass123",
        )

    def test_update_profile_avatar_stores_object_key_not_oss_url(self):
        record = FileRecord.objects.create(
            file_name="avatar.png",
            file_key="user-avatars/155b6b12c3184973bd80bbb64b057b46.png",
            file_path="user-avatars",
            file_size=1024,
            file_type="image",
            mime_type="image/png",
            file_extension="png",
            file_hash="avatarhash155b6b12c3184973bd80bbb64b057b46",
            bucket_name="example-assets",
            access_url=(
                "https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/"
                "user-avatars/155b6b12c3184973bd80bbb64b057b46.png"
            ),
            status="completed",
            upload_user=str(self.user.id),
        )

        req = self.rf.put("/api/auth/profile")
        req.auth = self.user
        resp = update_user_profile(
            req,
            UserProfileUpdateSchema(avatar_file_id=str(record.id)),
        )

        self.assertTrue(resp.success)
        self.user.refresh_from_db()
        self.assertEqual(
            self.user.avatar,
            "user-avatars/155b6b12c3184973bd80bbb64b057b46.png",
        )
        self.assertNotIn("aliyuncs.com", self.user.avatar)
