from datetime import timedelta

import pytest
from django.utils import timezone

from apps.tabtinspace.models import OrganizationInvitation
from apps.tabtinspace.services.invitation_service import InvitationService
from apps.tabtinspace.tests.fixtures import (
    TABTINSPACE_DB_ALIAS,
    cleanup_test_organization,
    create_test_organization,
    create_test_user,
)


@pytest.mark.django_db(databases=['default', 'postgresql'])
def test_invitation_preview_includes_organization_id():
    owner = create_test_user(prefix='invite_preview_owner')
    organization = create_test_organization(owner=owner, prefix='invite_preview')
    invitation = OrganizationInvitation.objects.using(TABTINSPACE_DB_ALIAS).create(
        organization=organization,
        invited_by=str(owner.id),
        invite_type='link',
        role='editor',
        token='preview_token_1234567890',
        expires_at=timezone.now() + timedelta(days=1),
        max_uses=-1,
    )

    try:
        info = InvitationService(user=None).get_invitation_info(invitation.token)

        assert info['valid'] is True
        assert info['organization_id'] == str(organization.id)
        assert info['organization_name'] == organization.name
    finally:
        cleanup_test_organization(organization, delete_user=True)
