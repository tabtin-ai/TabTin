"""#6523：成员被移除后不得用同一组织邀请链接再次加入。"""
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone

from apps.tabtinspace.models import OrganizationInvitation, OrganizationMember
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.invitation_service import InvitationService
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.tabtinspace.tests.fixtures import (
    TABTINSPACE_DB_ALIAS,
    create_test_organization,
    create_test_user,
)


@pytest.mark.django_db(databases=['default', 'postgresql'])
class TestRemovedMemberCannotRejoinViaSameInviteLink:
    @patch(
        'apps.tabtinspace.services.invitation_service.InvitationService._check_seat_quota',
        return_value=None,
    )
    def test_removed_member_cannot_reuse_same_link_invitation(self, _mock_seat):
        owner = create_test_user(prefix='rejoin_owner_6523')
        member = create_test_user(prefix='rejoin_member_6523')
        organization = create_test_organization(owner=owner, prefix='rejoin_org_6523')

        invitation = InvitationService(user=owner).create_link_invitation(
            organization_id=organization.id,
            role='editor',
            max_uses=-1,
        )

        first = InvitationService(user=member).accept_invitation(invitation.token)
        assert first['organization_id'] == str(organization.id)
        assert OrganizationMember.objects.filter(
            organization=organization, user_id=str(member.id),
        ).exists()

        OrganizationService(user=owner).remove_member(
            organization_id=organization.id,
            user_id=str(member.id),
        )
        assert not OrganizationMember.objects.filter(
            organization=organization, user_id=str(member.id),
        ).exists()

        invitation.refresh_from_db()
        assert invitation.status == 'pending'
        assert InvitationService._invitation_already_accepted_by(invitation, str(member.id))

        with pytest.raises(ServiceError) as exc:
            InvitationService(user=member).accept_invitation(invitation.token)
        assert exc.value.code == 'INVITATION_ALREADY_USED'
        assert exc.value.status == 403
        assert not OrganizationMember.objects.filter(
            organization=organization, user_id=str(member.id),
        ).exists()

    @patch(
        'apps.tabtinspace.services.invitation_service.InvitationService._check_seat_quota',
        return_value=None,
    )
    def test_other_user_can_still_use_same_link_after_removal(self, _mock_seat):
        owner = create_test_user(prefix='rejoin_owner_6523b')
        member = create_test_user(prefix='rejoin_member_6523b')
        other = create_test_user(prefix='rejoin_other_6523b')
        organization = create_test_organization(owner=owner, prefix='rejoin_org_6523b')

        invitation = InvitationService(user=owner).create_link_invitation(
            organization_id=organization.id,
            role='editor',
            max_uses=-1,
        )
        InvitationService(user=member).accept_invitation(invitation.token)
        OrganizationService(user=owner).remove_member(
            organization_id=organization.id,
            user_id=str(member.id),
        )

        result = InvitationService(user=other).accept_invitation(invitation.token)
        assert result['organization_id'] == str(organization.id)
        assert OrganizationMember.objects.filter(
            organization=organization, user_id=str(other.id), role='editor',
        ).exists()

    @patch(
        'apps.tabtinspace.services.invitation_service.InvitationService._check_seat_quota',
        return_value=None,
    )
    def test_new_link_allows_explicit_reinvite_after_removal(self, _mock_seat):
        owner = create_test_user(prefix='rejoin_owner_6523c')
        member = create_test_user(prefix='rejoin_member_6523c')
        organization = create_test_organization(owner=owner, prefix='rejoin_org_6523c')

        old_invite = InvitationService(user=owner).create_link_invitation(
            organization_id=organization.id,
            role='editor',
            max_uses=-1,
        )
        InvitationService(user=member).accept_invitation(old_invite.token)
        OrganizationService(user=owner).remove_member(
            organization_id=organization.id,
            user_id=str(member.id),
        )

        new_invite = InvitationService(user=owner).create_link_invitation(
            organization_id=organization.id,
            role='editor',
            max_uses=-1,
        )
        result = InvitationService(user=member).accept_invitation(new_invite.token)
        assert result['organization_id'] == str(organization.id)
        assert OrganizationMember.objects.filter(
            organization=organization, user_id=str(member.id),
        ).exists()

    def test_preview_marks_already_used_for_logged_in_former_member(self):
        owner = create_test_user(prefix='rejoin_owner_6523d')
        member = create_test_user(prefix='rejoin_member_6523d')
        organization = create_test_organization(owner=owner, prefix='rejoin_org_6523d')
        invitation = OrganizationInvitation.objects.using(TABTINSPACE_DB_ALIAS).create(
            organization=organization,
            invited_by=str(owner.id),
            invite_type='link',
            role='editor',
            token='rejoin_preview_token_6523abcd',
            expires_at=timezone.now() + timedelta(days=1),
            max_uses=-1,
            use_count=1,
            accepted_users=[
                {'user_id': str(member.id), 'accepted_at': timezone.now().isoformat()},
            ],
        )

        anon_info = InvitationService(user=None).get_invitation_info(invitation.token)
        assert anon_info['valid'] is True

        member_info = InvitationService(user=member).get_invitation_info(invitation.token)
        assert member_info['valid'] is False
        assert member_info['status'] == 'already_used'

    @patch(
        'apps.tabtinspace.services.invitation_service.InvitationService._check_seat_quota',
        return_value=None,
    )
    @patch(
        'apps.services.billing.services.seat_billing_service.SeatBillingService.check_seat_quota',
        return_value=True,
    )
    def test_add_member_then_remove_blocks_existing_unused_link(self, _mock_seat_check, _mock_seat):
        """成员若经 add_member 加入（未写入 accepted_users），移除后仍不可用旧链。"""
        owner = create_test_user(prefix='rejoin_owner_6523e')
        member = create_test_user(prefix='rejoin_member_6523e')
        organization = create_test_organization(owner=owner, prefix='rejoin_org_6523e')

        invitation = InvitationService(user=owner).create_link_invitation(
            organization_id=organization.id,
            role='editor',
            max_uses=-1,
        )
        OrganizationService(user=owner).add_member(
            organization_id=organization.id,
            user_id=str(member.id),
            role='editor',
        )
        invitation.refresh_from_db()
        assert not InvitationService._invitation_already_accepted_by(invitation, str(member.id))

        OrganizationService(user=owner).remove_member(
            organization_id=organization.id,
            user_id=str(member.id),
        )
        invitation.refresh_from_db()
        assert InvitationService._invitation_already_accepted_by(invitation, str(member.id))

        with pytest.raises(ServiceError) as exc:
            InvitationService(user=member).accept_invitation(invitation.token)
        assert exc.value.code == 'INVITATION_ALREADY_USED'
        assert not OrganizationMember.objects.filter(
            organization=organization, user_id=str(member.id),
        ).exists()

    @patch(
        'apps.tabtinspace.services.invitation_service.InvitationService._check_seat_quota',
        return_value=None,
    )
    @patch(
        'apps.services.billing.services.seat_billing_service.SeatBillingService.check_seat_quota',
        return_value=True,
    )
    def test_leave_organization_blocks_existing_link(self, _mock_seat_check, _mock_seat):
        owner = create_test_user(prefix='rejoin_owner_6523f')
        member = create_test_user(prefix='rejoin_member_6523f')
        organization = create_test_organization(owner=owner, prefix='rejoin_org_6523f')

        invitation = InvitationService(user=owner).create_link_invitation(
            organization_id=organization.id,
            role='editor',
            max_uses=-1,
        )
        OrganizationService(user=owner).add_member(
            organization_id=organization.id,
            user_id=str(member.id),
            role='editor',
        )
        OrganizationService(user=member).leave_organization(organization.id)

        invitation.refresh_from_db()
        assert InvitationService._invitation_already_accepted_by(invitation, str(member.id))

        with pytest.raises(ServiceError) as exc:
            InvitationService(user=member).accept_invitation(invitation.token)
        assert exc.value.code == 'INVITATION_ALREADY_USED'
