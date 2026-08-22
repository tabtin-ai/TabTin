"""邀请接受通知应展示实际加入成员。"""
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model

from apps.tabtinspace.models import Organization
from apps.tabtinspace.routers.invitation import _notify_members_invite_accepted

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
def test_notify_members_invite_accepted_includes_member_name():
    owner = User.objects.create_user(phone='+8613800000101', password='x', nickname='owner-notif')
    member = User.objects.create_user(phone='+8613800000102', password='x', nickname='member-notif')
    organization = Organization.objects.create(name='通知测试团队', owner=owner, type='team')

    with patch('apps.tabtinspace.routers.invitation.NotificationService.notify_organization_members') as mock_notify:
        _notify_members_invite_accepted(
            actor=member,
            organization_id=str(organization.id),
            organization_name=organization.name,
            role='editor',
        )

    mock_notify.assert_called_once()
    kwargs = mock_notify.call_args.kwargs
    assert kwargs['type'] == 'invite_accepted'
    assert kwargs['title'] == 'member-notif已加入「通知测试团队」'
    assert kwargs['body'] == '该成员通过邀请加入，角色为“编辑者”。'
    assert kwargs['metadata']['member_name'] == 'member-notif'
    assert kwargs['exclude_user_id'] == str(member.id)
