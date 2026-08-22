from django.test import SimpleTestCase

from apps.tabtinspace.services.organization_member_im_sync import (
    revoke_organization_member_dm_access,
    restore_organization_member_im_access,
)


class OrganizationMemberImSyncTests(SimpleTestCase):
    def test_revoke_is_local_noop(self):
        result = revoke_organization_member_dm_access(
            organization_id="11111111-1111-4111-8111-111111111111",
            user_id="user-1",
            successor_admin_user_ids=["admin-1"],
            successor_member_user_ids=["member-1"],
        )
        self.assertEqual(result, 0)

    def test_restore_is_local_noop(self):
        result = restore_organization_member_im_access(
            organization_id="11111111-1111-4111-8111-111111111111",
            user_id="user-1",
        )
        self.assertEqual(
            result,
            {
                "restored_dm_membership_count": 0,
                "restored_group_membership_count": 0,
                "restored_external_contact_count": 0,
            },
        )
