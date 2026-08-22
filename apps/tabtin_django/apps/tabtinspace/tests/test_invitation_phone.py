"""手机号邀请：phone → user 解析，落库 phone 类型并保留展示号。"""
import pytest
from django.contrib.auth import get_user_model
from django.db import connections
from django.http import HttpRequest

from apps.tabtinspace.models import Organization, OrganizationInvitation, OrganizationMember
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.invitation_service import InvitationService
from apps.tabtinspace.routers.invitation import list_invitations

User = get_user_model()

OWNER_PHONE = '+8613800000001'
MEMBER_A_PHONE = '+8613800000002'
MEMBER_B_PHONE = '+8613800000003'
UNREGISTERED_PHONE = '+8613899999999'


_DB_MARK = pytest.mark.django_db(databases=['default', 'postgresql'])


@pytest.fixture(autouse=True)
def _mute_default_organization_signal():
    """同 test_cascade_service：断开注册即建个人 organization 的信号，避免隔离 settings 下 provisioning 副作用。"""
    from django.db.models.signals import post_save
    from apps.tabtinspace.signals import create_default_organization

    post_save.disconnect(create_default_organization, sender=User)
    try:
        yield
    finally:
        post_save.connect(create_default_organization, sender=User)


@pytest.fixture
def invite_ctx():
    owner = User.objects.create_user(phone=OWNER_PHONE, password='x', nickname='owner633')
    member_a = User.objects.create_user(phone=MEMBER_A_PHONE, password='x', nickname='memberA633')
    member_b = User.objects.create_user(phone=MEMBER_B_PHONE, password='x', nickname='memberB633')
    # 双库隔离 settings 下 tabtinspace 表路由到 'postgresql' alias，镜像用户行
    # 以满足 teardown 的 FK 完整性检查；单 PG 测试时该 alias mirror 到 default，
    # 不能重复写入同一批用户。
    if connections['postgresql'].settings_dict.get('TEST', {}).get('MIRROR') != 'default':
        User.objects.using('postgresql').bulk_create([owner, member_a, member_b])
    organization = Organization.objects.create(name='issue633 团队', owner=owner, type='team')
    return owner, member_a, member_b, organization


@_DB_MARK
class TestPhoneInvitation:
    def test_phone_invite_accept_full_flow(self, invite_ctx):
        owner, member_a, _, organization = invite_ctx

        inv = InvitationService(user=owner).create_phone_invitation(
            organization_id=organization.id, phone=MEMBER_A_PHONE, role='editor',
        )
        assert inv.invite_type == 'phone'
        assert inv.invite_phone == MEMBER_A_PHONE
        assert inv.invited_user_id == str(member_a.id)
        assert inv.role == 'editor'
        assert inv.status == 'pending'

        result = InvitationService(user=member_a).respond_to_invitation(inv.id, accept=True)
        assert result['organization_id'] == str(organization.id)
        member = OrganizationMember.objects.get(organization=organization, user_id=str(member_a.id))
        assert member.role == 'editor'

    def test_phone_invite_supports_editor_role(self, invite_ctx):
        owner, _, member_b, organization = invite_ctx
        inv = InvitationService(user=owner).create_phone_invitation(
            organization_id=organization.id, phone=MEMBER_B_PHONE, role='editor',
        )
        assert inv.role == 'editor'

    def test_list_direct_invitation_includes_invitee_identity(self, invite_ctx):
        owner, member_a, _, organization = invite_ctx
        InvitationService(user=owner).create_phone_invitation(
            organization_id=organization.id, phone=MEMBER_A_PHONE, role='editor',
        )

        request = HttpRequest()
        request.auth = owner
        response = list_invitations(request, organization.id)

        assert response['data']['total'] == 1
        listed = response['data']['invitations'][0]
        assert listed['invited_user_id'] == str(member_a.id)
        assert listed['invited_user_nickname'] == 'memberA633'
        assert listed['invited_user_phone'] == member_a.phone

    def test_unregistered_phone_rejected(self, invite_ctx):
        owner, _, _, organization = invite_ctx
        with pytest.raises(ServiceError) as exc:
            InvitationService(user=owner).create_phone_invitation(
                organization_id=organization.id, phone=UNREGISTERED_PHONE, role='editor',
            )
        assert exc.value.code == 'USER_NOT_FOUND_BY_PHONE'

    def test_invalid_phone_format_rejected(self, invite_ctx):
        owner, _, _, organization = invite_ctx
        with pytest.raises(ServiceError) as exc:
            InvitationService(user=owner).create_phone_invitation(
                organization_id=organization.id, phone='abc123', role='editor',
            )
        assert exc.value.code == 'INVALID_PHONE'

    def test_phone_invite_existing_member_rejected(self, invite_ctx):
        owner, member_a, _, organization = invite_ctx
        OrganizationMember.objects.create(organization=organization, user_id=str(member_a.id), role='viewer')
        with pytest.raises(ServiceError) as exc:
            InvitationService(user=owner).create_phone_invitation(
                organization_id=organization.id, phone=MEMBER_A_PHONE, role='editor',
            )
        assert exc.value.code == 'ALREADY_MEMBER'

    def test_repeat_phone_invite_reuses_pending_invitation(self, invite_ctx):
        owner, member_a, _, organization = invite_ctx
        svc = InvitationService(user=owner)
        first = svc.create_phone_invitation(organization_id=organization.id, phone=MEMBER_A_PHONE, role='editor')
        second = svc.create_phone_invitation(organization_id=organization.id, phone=MEMBER_A_PHONE, role='editor')
        assert second.id == first.id
        assert second.role == 'editor'
        assert OrganizationInvitation.objects.filter(
            organization=organization, invited_user_id=str(member_a.id), status='pending',
        ).count() == 1

    def test_personal_organization_rejected(self, invite_ctx):
        owner, _, _, _ = invite_ctx
        personal = Organization.objects.create(name='个人', owner=owner, type='personal')
        with pytest.raises(ServiceError) as exc:
            InvitationService(user=owner).create_phone_invitation(
                organization_id=personal.id, phone=MEMBER_A_PHONE, role='editor',
            )
        assert exc.value.code == 'PERSONAL_ORGANIZATION_NOT_ALLOWED'

    def test_resolve_invitee_nicknames_for_phone_and_direct(self, invite_ctx):
        """#8704：列表富集被邀请人昵称，供前端待处理邀请展示。"""
        from apps.tabtinspace.services.invitation_service import resolve_invitee_nicknames

        owner, member_a, member_b, organization = invite_ctx
        svc = InvitationService(user=owner)
        phone_inv = svc.create_phone_invitation(
            organization_id=organization.id, phone=MEMBER_A_PHONE, role='editor',
        )
        direct_inv = svc.create_direct_invitation(
            organization_id=organization.id, target_user_id=str(member_b.id), role='editor',
        )
        nickname_map = resolve_invitee_nicknames([phone_inv, direct_inv])
        assert nickname_map[str(member_a.id)] == 'memberA633'
        assert nickname_map[str(member_b.id)] == 'memberB633'
