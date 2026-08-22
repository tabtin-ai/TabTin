"""#5149：接受/拒绝邀请时原地升级 organization.invitation，不叠 sync 双卡。"""
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model

from apps.tabtinspace.services.invitation_service import InvitationService

User = get_user_model()

_DB_MARK = pytest.mark.django_db(databases=['default', 'postgresql'])


@pytest.fixture(autouse=True)
def _mute_default_organization_signal():
    from django.db.models.signals import post_save
    from apps.tabtinspace.signals import create_default_organization

    post_save.disconnect(create_default_organization, sender=User)
    try:
        yield
    finally:
        post_save.connect(create_default_organization, sender=User)


@_DB_MARK
def test_push_response_notifications_resolves_invitee_card():
    with patch(
        'apps.services.notification.services.notification_service.NotificationService.notify'
    ) as mock_notify, patch(
        'apps.services.notification.services.notification_service.NotificationService.resolve_invitation_notification'
    ) as mock_resolve:
        InvitationService._push_invitation_response_notifications(
            inviter_id='inviter-1',
            responder_id='responder-1',
            responder_name='alice',
            wt_name='摹范科技',
            wt_id='org-1',
            accepted=True,
            role='editor',
            invitation_id='inv-99',
        )

    mock_notify.assert_called_once()
    assert mock_notify.call_args.kwargs['type'] == 'organization.invitation.responded'
    assert mock_notify.call_args.kwargs['title'] == 'alice已接受组织邀请'
    assert mock_notify.call_args.kwargs['body'] == '对方已加入「摹范科技」，角色为“编辑者”。'
    assert mock_notify.call_args.kwargs['metadata']['role'] == 'editor'
    mock_resolve.assert_called_once()
    resolve_kwargs = mock_resolve.call_args.kwargs
    assert resolve_kwargs['user_id'] == 'responder-1'
    assert resolve_kwargs['invitation_id'] == 'inv-99'
    assert resolve_kwargs['type'] == 'organization.invitation.sync'
    assert resolve_kwargs['title'] == '加入「摹范科技」的邀请已处理'
    assert resolve_kwargs['body'] == '该邀请已在其他入口完成处理，无需重复操作。'
