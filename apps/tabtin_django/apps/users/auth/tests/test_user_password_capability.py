from django.test import TestCase

from apps.users.auth.api._shared import _build_user_info
from apps.users.auth.models import User


class UserPasswordCapabilityTests(TestCase):
    def test_user_created_without_password_requires_verification_setup(self):
        user = User.objects.create_user(phone="13800000135")

        self.assertFalse(user.has_usable_password())
        self.assertFalse(_build_user_info(user).has_usable_password)

    def test_user_created_with_password_keeps_current_password_flow(self):
        user = User.objects.create_user(
            phone="13800000136",
            password="StrongPass1!",
        )

        self.assertTrue(user.has_usable_password())
        self.assertTrue(_build_user_info(user).has_usable_password)
