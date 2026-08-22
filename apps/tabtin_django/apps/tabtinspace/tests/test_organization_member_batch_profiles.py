from __future__ import annotations

import json

from django.test import RequestFactory, TestCase, override_settings

from apps.tabtinspace.models import OrganizationMember
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class OrganizationMemberBatchProfileTests(TestCase):
    databases = {"default", "postgresql"}

    def test_only_active_members_are_returned(self) -> None:
        owner = create_test_user(prefix="member-profile-owner")
        member = create_test_user(prefix="member-profile-member")
        outsider = create_test_user(prefix="member-profile-outsider")
        organization = create_test_organization(owner=owner, prefix="member-profile")
        OrganizationMember.objects.create(
            organization=organization,
            user=member,
            role="editor",
        )
        session = SessionManager.create_session(owner, RequestFactory().get("/"))
        token = generate_jwt_token(owner, session_key=session.session_key)
        response = self.client.post(
            f"/api/context/organizations/{organization.id}/members/batch-profiles",
            data=json.dumps({"user_ids": [str(member.id), str(outsider.id)]}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            [profile["id"] for profile in response.json()["data"]],
            [str(member.id)],
        )
