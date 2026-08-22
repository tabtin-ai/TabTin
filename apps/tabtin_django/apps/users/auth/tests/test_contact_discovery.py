from django.test import RequestFactory, TestCase

from apps.users.auth.api.profile_routes import ContactDiscoverySchema, discover_contact_by_phone
from apps.users.auth.models import User


class ContactDiscoveryTests(TestCase):
    databases = {"default"}

    def test_exact_phone_returns_only_public_profile(self):
        requester = User.objects.create_user(email="requester@example.com", password="pass123")
        target = User.objects.create_user(email="target@example.com", phone="+8613800138000", nickname="目标用户", password="pass123")
        request = RequestFactory().post("/api/auth/contact-discovery")
        request.auth = requester

        status, response = discover_contact_by_phone(request, ContactDiscoverySchema(phone="13800138000"))

        self.assertEqual(status, 200)
        self.assertEqual(response.data["user_id"], target.id)
        self.assertNotIn("phone", response.data)
