"""Organization membership no longer syncs to a standalone IM control plane."""

from __future__ import annotations

from collections.abc import Sequence


class IMOrganizationMemberRevocationUnavailable(RuntimeError):
    """Kept for callers that still catch the historical control-plane error."""


class IMOrganizationMemberRestoreUnavailable(RuntimeError):
    """Kept for callers that still catch the historical control-plane error."""


def revoke_organization_member_dm_access(
    *,
    organization_id: str,
    user_id: str,
    successor_admin_user_ids: Sequence[str] = (),
    successor_member_user_ids: Sequence[str] = (),
) -> int:
    """Django IM membership is stored locally; leaving an org needs no remote revoke."""
    del organization_id, user_id, successor_admin_user_ids, successor_member_user_ids
    return 0


def restore_organization_member_im_access(*, organization_id: str, user_id: str) -> dict[str, int]:
    """Django IM membership is stored locally; joining an org needs no remote restore."""
    del organization_id, user_id
    return {
        "restored_dm_membership_count": 0,
        "restored_group_membership_count": 0,
        "restored_external_contact_count": 0,
    }
