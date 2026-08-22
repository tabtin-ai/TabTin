from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.tabtinspace.signals import create_default_organization


class OrganizationMemberSearchTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=get_user_model())

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=get_user_model())
        super().tearDownClass()

    def setUp(self):
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            email="member-search-owner@example.com",
            password="test-password",
            nickname="Owner",
            username="member_search_owner",
        )
        self.nickname_match = user_model.objects.create_user(
            email="nickname-match@example.com",
            password="test-password",
            nickname="Needle Name",
            username="nickname_match",
        )
        self.username_match = user_model.objects.create_user(
            email="username-match@example.com",
            password="test-password",
            nickname="Username Match",
            username="needle_handle",
        )
        self.email_match = user_model.objects.create_user(
            email="needle@example.com",
            password="test-password",
            nickname="Email Match",
            username="email_match",
        )
        self.phone_match = user_model.objects.create_user(
            phone="+8613800514000",
            password="test-password",
            nickname="Phone Match",
            username="phone_match",
        )
        self.pinyin_match = user_model.objects.create_user(
            email="pinyin-match@example.com",
            password="test-password",
            nickname="周八",
            username="sunrise_member",
        )
        self.organization = Organization.objects.create(
            name="Member Search Team",
            owner=self.owner,
            type="team",
        )
        for user in (
            self.owner,
            self.nickname_match,
            self.username_match,
            self.email_match,
            self.phone_match,
            self.pinyin_match,
        ):
            OrganizationMember.objects.create(
                organization=self.organization,
                user=user,
                role="owner" if user == self.owner else "editor",
            )
        self.service = OrganizationService(user=self.owner)

    def test_nickname_mode_matches_chinese_nickname_by_pinyin_prefix_and_initials(self):
        full_pinyin_members, full_pinyin_total = self.service.list_members(
            self.organization.id,
            search="hu",
            search_mode="nickname",
            limit=20,
        )
        initials_members, initials_total = self.service.list_members(
            self.organization.id,
            search="hcx",
            search_mode="nickname",
            limit=20,
        )

        self.assertEqual(
            [str(member.user_id) for member in full_pinyin_members],
            [self.pinyin_match.id],
        )
        self.assertEqual(full_pinyin_total, 1)
        self.assertEqual(
            [str(member.user_id) for member in initials_members],
            [self.pinyin_match.id],
        )
        self.assertEqual(initials_total, 1)

    def test_nickname_mode_matches_nickname_and_username_but_not_email(self):
        members, total = self.service.list_members(
            self.organization.id,
            search="needle",
            search_mode="nickname",
            limit=20,
        )

        self.assertEqual(
            {str(member.user_id) for member in members},
            {self.nickname_match.id, self.username_match.id},
        )
        self.assertEqual(total, 2)

    def test_nickname_mode_excludes_phone_while_default_search_remains_compatible(self):
        nickname_members, nickname_total = self.service.list_members(
            self.organization.id,
            search="514000",
            search_mode="nickname",
            limit=20,
        )
        default_members, default_total = self.service.list_members(
            self.organization.id,
            search="514000",
            limit=20,
        )
        email_members, email_total = self.service.list_members(
            self.organization.id,
            search="needle@example.com",
            limit=20,
        )

        self.assertEqual(list(nickname_members), [])
        self.assertEqual(nickname_total, 0)
        self.assertEqual([str(member.user_id) for member in default_members], [self.phone_match.id])
        self.assertEqual(default_total, 1)
        self.assertEqual([str(member.user_id) for member in email_members], [self.email_match.id])
        self.assertEqual(email_total, 1)

    def test_default_search_preserves_user_id_lookup(self):
        members, total = self.service.list_members(
            self.organization.id,
            search=str(self.email_match.id)[:8],
            limit=20,
        )

        self.assertEqual([str(member.user_id) for member in members], [self.email_match.id])
        self.assertEqual(total, 1)
