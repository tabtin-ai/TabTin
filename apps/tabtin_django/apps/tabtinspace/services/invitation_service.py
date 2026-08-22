"""
组织邀请服务
"""
import os
import re
import secrets
import logging
from typing import List, Dict, Any
from urllib.parse import quote, urlparse
from uuid import UUID

from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.db import transaction
from django.utils import timezone
from datetime import timedelta

from apps.services.common.db_router import postgres_app_db_alias

from apps.tabtinspace.models import Organization, OrganizationMember, OrganizationInvitation
from .base import BaseService, ORGANIZATION_ASSIGNABLE_ROLES, ServiceError

logger = logging.getLogger(__name__)

DEFAULT_EXPIRY_HOURS = 72
DEFAULT_LINK_EXPIRY_HOURS = 168  # 7 days
INVITE_TOKEN_PATTERN = re.compile(r'^[A-Za-z0-9_-]{16,64}$')
PUBLIC_WEB_BASE_ENV_KEYS = ('TABTIN_PUBLIC_WEB_BASE_URL', 'VITE_PUBLIC_WEB_BASE_URL', 'PUBLIC_WEB_BASE_URL')

INVITE_RATE_LIMITS = {
    'email': {'per_hour': 20, 'per_day': 50},
    'link': {'per_hour': 10, 'per_day': 30},
    'direct': {'per_hour': 20, 'per_day': 50},
    'phone': {'per_hour': 20, 'per_day': 50},
}

TARGETED_INVITE_TYPES = OrganizationInvitation.TARGETED_INVITE_TYPES


def resolve_invitee_nicknames(invitations: List[OrganizationInvitation]) -> Dict[str, str]:
    """批量解析定向邀请的被邀请人展示名（nickname → username），供列表/创建响应附带。"""
    user_ids = list({
        (inv.invited_user_id or '').strip()
        for inv in invitations
        if (inv.invited_user_id or '').strip()
    })
    if not user_ids:
        return {}

    from django.contrib.auth import get_user_model
    User = get_user_model()
    nickname_map: Dict[str, str] = {}
    for u in User.objects.filter(id__in=user_ids).only('id', 'nickname', 'username'):
        nickname_map[str(u.id)] = (u.nickname or u.username or '').strip()
    return nickname_map


def _check_invite_rate_limit(organization_id: UUID, invite_type: str) -> None:
    """按 organization_id + invite_type 限流，超限抛出 ServiceError(429)。"""
    limits = INVITE_RATE_LIMITS.get(invite_type)
    if not limits:
        logger.warning("未知 invite_type '%s' 无限流配置，跳过限流", invite_type)
        return
    ws_key = str(organization_id)

    for period_name, period_seconds in [('per_hour', 3600), ('per_day', 86400)]:
        limit = limits.get(period_name)
        if not limit:
            continue
        cache_key = f"invite_rl:{invite_type}:{period_name}:{ws_key}"
        count = cache.get(cache_key, 0)
        if count >= limit:
            raise ServiceError(
                'RATE_LIMITED',
                f'邀请创建过于频繁，请稍后再试（限制: {limit}/{period_name.replace("per_", "")}）',
                429,
            )
        if cache.add(cache_key, 0, period_seconds):
            pass
        try:
            cache.incr(cache_key)
        except ValueError:
            cache.set(cache_key, 1, period_seconds)


def _is_local_http_host(hostname: str | None) -> bool:
    if not hostname:
        return False
    normalized = hostname.lower()
    return (
        normalized == 'localhost'
        or normalized.endswith('.localhost')
        or normalized == '127.0.0.1'
        or normalized == '::1'
    )


def _resolve_public_web_base_url() -> str:
    for key in PUBLIC_WEB_BASE_ENV_KEYS:
        value = os.getenv(key, '').strip()
        if not value:
            continue
        parsed = urlparse(value)
        if not parsed.netloc:
            raise ImproperlyConfigured(f'{key} must be an absolute HTTP(S) URL')
        if parsed.scheme == 'https':
            return value.rstrip('/')
        if parsed.scheme == 'http' and _is_local_http_host(parsed.hostname):
            return value.rstrip('/')
        raise ImproperlyConfigured(f'{key} must use HTTPS outside localhost')
    raise ImproperlyConfigured(
        'TABTIN_PUBLIC_WEB_BASE_URL or VITE_PUBLIC_WEB_BASE_URL is required for invitation links'
    )


def build_invitation_bridge_url(token: str) -> str:
    if not INVITE_TOKEN_PATTERN.fullmatch(token):
        raise ValueError('Invalid invitation token')

    encoded_token = quote(token, safe='')
    public_web_base_url = _resolve_public_web_base_url()
    return f'{public_web_base_url}/invite/{encoded_token}'


class InvitationService(BaseService):
    """组织邀请服务"""

    def _check_manage_permission(self, organization_id: str) -> bool:
        """两级模型（2026-06-10）：邀请管理收口为 owner-only。"""
        return self.check_organization_permission(organization_id, 'owner')

    def _assert_invite_allowed(self, organization_id: str) -> None:
        from apps.tabtinspace.services.organization_control_guard import (
            OrganizationControlBlockedError,
            assert_organization_invite_allowed,
        )

        try:
            assert_organization_invite_allowed(organization_id)
        except OrganizationControlBlockedError as exc:
            raise ServiceError(exc.code, exc.message, exc.http_status) from exc

    def _assert_member_join_allowed(self, organization_id: str) -> None:
        from apps.tabtinspace.services.organization_control_guard import (
            OrganizationControlBlockedError,
            assert_organization_member_join_allowed,
        )

        try:
            assert_organization_member_join_allowed(organization_id)
        except OrganizationControlBlockedError as exc:
            raise ServiceError(exc.code, exc.message, exc.http_status) from exc

    @staticmethod
    def _invitation_already_accepted_by(invitation: OrganizationInvitation, user_id: str) -> bool:
        """同一邀请令牌是否已被该用户使用过（含随后被移除/主动离开的情形）。"""
        target = str(user_id)
        for record in invitation.accepted_users or []:
            if not isinstance(record, dict):
                continue
            if str(record.get('user_id') or '') == target:
                return True
        return False

    @staticmethod
    def stamp_user_on_pending_link_invitations(
        organization_id,
        user_id: str,
        *,
        source: str = 'member_removed',
    ) -> int:
        """将被移除/离开的用户记入组织内所有 pending 通用链接。

        覆盖「未走过 accept_invitation（如 add_member）导致 accepted_users 为空、
        移除后仍可用旧通用链接重入」的缺口（ 审查）。
        新建链接不会带上该记录，管理员仍可显式重邀。
        """
        uid = str(user_id)
        now = timezone.now().isoformat()
        pending_links = OrganizationInvitation.objects.select_for_update().filter(
            organization_id=organization_id,
            invite_type='link',
            status='pending',
        )
        stamped = 0
        for invitation in pending_links:
            if InvitationService._invitation_already_accepted_by(invitation, uid):
                continue
            invitation.accepted_users = list(invitation.accepted_users or []) + [
                {'user_id': uid, 'accepted_at': now, 'source': source},
            ]
            invitation.save(update_fields=['accepted_users', 'updated_at'])
            stamped += 1
        return stamped

    def _assert_not_rejoining_via_same_invitation(
        self,
        invitation: OrganizationInvitation,
        user_id: str,
    ) -> None:
        """通用链接等可多次使用的邀请：禁止已用过该令牌的用户再次加入。

        覆盖「管理员移除成员后仍用旧链接重入」的权限漏洞。
        管理员可通过新建链接 / 定向邀请显式重新拉人。
        """
        if self._invitation_already_accepted_by(invitation, user_id):
            raise ServiceError(
                'INVITATION_ALREADY_USED',
                '你此前已通过此邀请加入过组织；被移除或离开后需管理员重新邀请',
                403,
            )

    def _check_seat_quota(self, organization_id: str, *, fail_open: bool = False) -> None:
        """
        席位配额预检（SeatBillingService.get_seat_info）；满员时抛出带人数提示的 ServiceError。
        ServiceError 一律原样上抛（含 SeatBillingService 未来可能抛出的业务异常）。
        fail_open=True：非 ServiceError 异常时仅警告并放行（邀请创建路径）。
        fail_open=False：非 ServiceError 异常时拒绝（邀请接受路径）。
        """
        try:
            from apps.services.billing.services.seat_billing_service import SeatBillingService

            info = SeatBillingService.get_seat_info(organization_id)
        except ServiceError:
            raise
        except Exception as e:
            if fail_open:
                logger.warning(
                    "邀请席位预检异常，放行: organization=%s",
                    organization_id,
                    exc_info=True,
                )
                return
            is_timeout = 'timeout' in str(e).lower() or 'timed out' in str(e).lower()
            status_code = 503 if is_timeout else 400
            logger.warning("席位检查失败，拒绝添加成员: %s (timeout=%s)", e, is_timeout)
            raise ServiceError(
                'SEAT_CHECK_FAILED',
                '席位检查服务暂时不可用，请稍后重试' if is_timeout else '席位检查异常，请稍后重试',
                status_code,
            )
        max_seats = info.get('max', -1)
        if max_seats == -1:
            return
        used = int(info.get('used') or 0)
        if used >= max_seats:
            raise ServiceError(
                'SEAT_QUOTA_EXCEEDED',
                f'当前组织已满员 ({used}/{max_seats} 人)，请先升级会员或移除现有成员',
            )

    @transaction.atomic(using=postgres_app_db_alias())
    def create_email_invitation(
        self,
        organization_id: UUID,
        email: str,
        role: str = 'editor',
        expires_hours: int = DEFAULT_EXPIRY_HOURS,
    ) -> OrganizationInvitation:
        if role not in ORGANIZATION_ASSIGNABLE_ROLES:
            raise ServiceError('INVALID_ROLE', f'角色 {role} 不合法')

        if not self._check_manage_permission(str(organization_id)):
            raise ServiceError('PERMISSION_DENIED', '仅组织所有者可管理邀请', 403)

        self._assert_invite_allowed(str(organization_id))
        _check_invite_rate_limit(organization_id, 'email')

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)
        self.assert_team_organization(organization)

        self._check_seat_quota(str(organization_id), fail_open=True)

        operator_role = self._get_operator_role(organization)
        if not operator_role or not self._can_manage_target(operator_role, role):
            raise ServiceError('ROLE_ESCALATION', '不能邀请高于或等于自己级别的角色', 403)

        existing = OrganizationInvitation.objects.filter(
            organization=organization,
            email=email,
            invite_type='email',
            status='pending',
        ).first()
        if existing:
            existing.role = role
            existing.expires_at = timezone.now() + timedelta(hours=expires_hours)
            existing.save(update_fields=['role', 'expires_at'])
            return existing

        token = secrets.token_urlsafe(32)
        invitation = OrganizationInvitation.objects.create(
            organization=organization,
            invited_by=str(self.user.id),
            invite_type='email',
            email=email,
            role=role,
            token=token,
            expires_at=timezone.now() + timedelta(hours=expires_hours),
            max_uses=1,
        )

        self._send_invitation_email(invitation)
        return invitation

    @transaction.atomic(using=postgres_app_db_alias())
    def create_link_invitation(
        self,
        organization_id: UUID,
        role: str = 'editor',
        max_uses: int = -1,
        expires_hours: int = DEFAULT_LINK_EXPIRY_HOURS,
    ) -> OrganizationInvitation:
        if role not in ORGANIZATION_ASSIGNABLE_ROLES:
            raise ServiceError('INVALID_ROLE', f'角色 {role} 不合法')

        if not self._check_manage_permission(str(organization_id)):
            raise ServiceError('PERMISSION_DENIED', '仅组织所有者可管理邀请', 403)

        self._assert_invite_allowed(str(organization_id))
        _check_invite_rate_limit(organization_id, 'link')

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)
        self.assert_team_organization(organization)

        self._check_seat_quota(str(organization_id), fail_open=True)

        operator_role = self._get_operator_role(organization)
        if not operator_role or not self._can_manage_target(operator_role, role):
            raise ServiceError('ROLE_ESCALATION', '不能邀请高于或等于自己级别的角色', 403)

        token = secrets.token_urlsafe(32)
        invitation = OrganizationInvitation.objects.create(
            organization=organization,
            invited_by=str(self.user.id),
            invite_type='link',
            role=role,
            token=token,
            expires_at=timezone.now() + timedelta(hours=expires_hours),
            max_uses=max_uses,
        )
        return invitation

    @transaction.atomic(using=postgres_app_db_alias())
    def create_direct_invitation(
        self,
        organization_id: UUID,
        target_user_id: str,
        role: str = 'editor',
        expires_hours: int = DEFAULT_EXPIRY_HOURS,
        *,
        invite_type: str = 'direct',
        invite_phone: str = '',
    ) -> OrganizationInvitation:
        """通过用户 ID（或手机号解析后的用户）创建定向邀请，目标用户需要手动接受。"""
        if role not in ORGANIZATION_ASSIGNABLE_ROLES:
            raise ServiceError('INVALID_ROLE', f'角色 {role} 不合法')
        if invite_type not in TARGETED_INVITE_TYPES:
            raise ServiceError('INVALID_INVITE_TYPE', f'邀请类型 {invite_type} 不合法')

        if not self._check_manage_permission(str(organization_id)):
            raise ServiceError('PERMISSION_DENIED', '仅组织所有者可管理邀请', 403)

        self._assert_invite_allowed(str(organization_id))
        _check_invite_rate_limit(organization_id, invite_type)

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)
        self.assert_team_organization(organization)

        self._check_seat_quota(str(organization_id), fail_open=True)

        operator_role = self._get_operator_role(organization)
        if not operator_role or not self._can_manage_target(operator_role, role):
            raise ServiceError('ROLE_ESCALATION', '不能邀请高于或等于自己级别的角色', 403)

        from django.contrib.auth import get_user_model
        User = get_user_model()
        try:
            User.objects.using('default').get(id=target_user_id)
        except User.DoesNotExist:
            raise ServiceError('USER_NOT_FOUND', '用户不存在', 404)

        if str(organization.owner_id) == target_user_id:
            raise ServiceError('ALREADY_OWNER', '该用户已是组织所有者')

        if OrganizationMember.objects.filter(organization=organization, user_id=target_user_id).exists():
            raise ServiceError('ALREADY_MEMBER', '该用户已是组织成员')

        normalized_phone = (invite_phone or '').strip() if invite_type == 'phone' else ''

        existing = OrganizationInvitation.objects.filter(
            organization=organization,
            invited_user_id=target_user_id,
            invite_type__in=TARGETED_INVITE_TYPES,
            status='pending',
        ).first()
        if existing:
            existing.role = role
            existing.expires_at = timezone.now() + timedelta(hours=expires_hours)
            update_fields = ['role', 'expires_at']
            # 再次用手机号邀请时补齐展示字段与类型，避免列表仍显示 UUID
            if invite_type == 'phone' and normalized_phone:
                existing.invite_type = 'phone'
                existing.invite_phone = normalized_phone
                update_fields.extend(['invite_type', 'invite_phone'])
            existing.save(update_fields=update_fields)
            return existing

        token = secrets.token_urlsafe(32)
        invitation = OrganizationInvitation.objects.create(
            organization=organization,
            invited_by=str(self.user.id),
            invite_type=invite_type,
            invited_user_id=target_user_id,
            invite_phone=normalized_phone,
            role=role,
            token=token,
            expires_at=timezone.now() + timedelta(hours=expires_hours),
            max_uses=1,
        )

        wt_name = organization.name
        wt_id = str(organization.id)
        inv_id = str(invitation.id)
        inviter_id = str(self.user.id)
        inviter_name = getattr(self.user, 'nickname', '') or getattr(self.user, 'username', '') or ''

        def _push_invitation_notification():
            try:
                from apps.services.notification.services.notification_service import NotificationService
                from apps.services.notification.services.organization_notification_formatter import (
                    format_organization_notification,
                )

                display = format_organization_notification(
                    'invitation_received',
                    organization_name=wt_name,
                    inviter_name=inviter_name,
                    role=role,
                )
                NotificationService.notify(
                    user_id=target_user_id,
                    type='organization.invitation',
                    title=display.title,
                    body=display.body,
                    metadata={
                        'canonical_display': True,
                        'invitation_id': inv_id,
                        'organization_name': wt_name,
                        'inviter_id': inviter_id,
                        'inviter_name': inviter_name,
                        'role': role,
                        'category': 'organization',
                        'behavior': 'action_required',
                        'dedupe_key': f'organization:invitation:{inv_id}',
                        'source_event_id': f'organization:invitation:{inv_id}',
                    },
                    organization_id=wt_id,
                )
            except Exception as e:
                logger.warning("邀请通知推送失败（非阻断）: %s", e)

        from django.db import connections
        connections[postgres_app_db_alias()].on_commit(_push_invitation_notification)

        return invitation

    def create_phone_invitation(
        self,
        organization_id: UUID,
        phone: str,
        role: str = 'editor',
        expires_hours: int = DEFAULT_EXPIRY_HOURS,
    ) -> OrganizationInvitation:
        """通过手机号邀请已注册用户；落库为 phone 类型，接受链路与 direct 相同。"""
        from apps.users.auth.validators import is_phone_number

        phone = (phone or '').strip()
        if not is_phone_number(phone):
            raise ServiceError('INVALID_PHONE', '手机号格式不正确')

        from apps.users.auth.phone import resolve_user_by_phone

        # 与登录口径一致：+86 / 11 位互认
        target = resolve_user_by_phone(phone, active_only=True)
        if target is None:
            raise ServiceError('USER_NOT_FOUND_BY_PHONE', '该手机号未注册 TabTin，请先让对方注册', 404)

        return self.create_direct_invitation(
            organization_id=organization_id,
            target_user_id=str(target.id),
            role=role,
            expires_hours=expires_hours,
            invite_type='phone',
            invite_phone=phone,
        )

    def list_my_pending_invitations(self) -> List[Dict[str, Any]]:
        """获取当前用户收到的所有待处理直接邀请，附带邀请人展示名。"""
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)
        invitations = list(
            OrganizationInvitation.objects.filter(
                invited_user_id=str(self.user.id),
                invite_type__in=TARGETED_INVITE_TYPES,
                status='pending',
                expires_at__gte=timezone.now(),
            ).select_related('organization').order_by('-created_at')
        )
        if not invitations:
            return []

        from django.contrib.auth import get_user_model
        User = get_user_model()
        inviter_ids = list({inv.invited_by for inv in invitations})
        inviter_map: Dict[str, str] = {}
        for u in User.objects.using('default').filter(id__in=inviter_ids).only('id', 'nickname', 'username'):
            inviter_map[str(u.id)] = u.nickname or u.username or str(u.id)[:8]

        return [
            {'invitation': inv, 'inviter_name': inviter_map.get(inv.invited_by, (inv.invited_by or '')[:8])}
            for inv in invitations
        ]

    @transaction.atomic(using=postgres_app_db_alias())
    def respond_to_invitation(self, invitation_id: UUID, accept: bool) -> Dict[str, Any]:
        """接受或拒绝直接邀请。"""
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)

        try:
            inv = OrganizationInvitation.objects.select_for_update().get(
                id=invitation_id,
                invited_user_id=str(self.user.id),
                invite_type__in=TARGETED_INVITE_TYPES,
            )
        except OrganizationInvitation.DoesNotExist:
            raise ServiceError('INVITATION_NOT_FOUND', '邀请不存在', 404)

        if inv.status != 'pending':
            raise ServiceError('INVITATION_INVALID', f'邀请状态: {inv.status}')

        if inv.expires_at < timezone.now():
            inv.status = 'expired'
            inv.save(update_fields=['status'])
            raise ServiceError('INVITATION_EXPIRED', '邀请已过期')

        organization = inv.organization
        wt_name = organization.name
        wt_id = str(organization.id)
        responder_id = str(self.user.id)
        responder_name = getattr(self.user, 'nickname', '') or getattr(self.user, 'username', '') or ''
        inviter_id = inv.invited_by or ''

        if not accept:
            inv.status = 'rejected'
            inv.save(update_fields=['status', 'updated_at'])

            def _push_respond_notifications_reject():
                self._push_invitation_response_notifications(
                    inviter_id=inviter_id, responder_id=responder_id,
                    responder_name=responder_name, wt_name=wt_name,
                    wt_id=wt_id, accepted=False,
                    role=inv.role,
                    invitation_id=str(invitation_id),
                )

            from django.db import connections
            connections[postgres_app_db_alias()].on_commit(_push_respond_notifications_reject)

            return {
                'organization_id': wt_id,
                'organization_name': wt_name,
                'status': 'rejected',
            }

        self.assert_team_organization(organization)

        if OrganizationMember.objects.filter(organization=organization, user_id=responder_id).exists():
            raise ServiceError('ALREADY_MEMBER', '你已是组织成员')

        self._assert_member_join_allowed(wt_id)
        self._check_seat_quota(wt_id, fail_open=False)

        from django.db import IntegrityError as DBIntegrityError
        try:
            OrganizationMember.objects.create(
                organization=organization,
                user_id=responder_id,
                role=inv.role,
            )
        except DBIntegrityError:
            raise ServiceError('ALREADY_MEMBER', '你已是组织成员')

        now = timezone.now()
        inv.status = 'accepted'
        inv.accepted_by = responder_id
        inv.accepted_at = now
        inv.accepted_users = (inv.accepted_users or []) + [
            {'user_id': responder_id, 'accepted_at': now.isoformat()}
        ]
        inv.use_count = 1
        inv.save(update_fields=[
            'status', 'accepted_by', 'accepted_at',
            'accepted_users', 'use_count', 'updated_at',
        ])

        def _push_respond_notifications_accept():
            self._push_invitation_response_notifications(
                inviter_id=inviter_id, responder_id=responder_id,
                responder_name=responder_name, wt_name=wt_name,
                wt_id=wt_id, accepted=True,
                role=inv.role,
                invitation_id=str(invitation_id),
            )

        from django.db import connections
        connections[postgres_app_db_alias()].on_commit(_push_respond_notifications_accept)

        return {
            'organization_id': wt_id,
            'organization_name': wt_name,
            'role': inv.role,
            'status': 'accepted',
        }

    def list_invitations(self, organization_id: UUID) -> List[OrganizationInvitation]:
        if not self._check_manage_permission(str(organization_id)):
            raise ServiceError('PERMISSION_DENIED', '仅组织所有者可管理邀请', 403)
        return list(
            OrganizationInvitation.objects.filter(
                organization_id=organization_id,
                status='pending',
                expires_at__gte=timezone.now(),
            ).order_by('-created_at')
        )

    @transaction.atomic(using=postgres_app_db_alias())
    def get_invitation_info(self, token: str) -> Dict[str, Any]:
        """公开接口：获取邀请预览信息（不需要成员身份）"""
        try:
            inv = OrganizationInvitation.objects.select_related('organization').get(token=token)
        except OrganizationInvitation.DoesNotExist:
            raise ServiceError('INVITATION_NOT_FOUND', '邀请不存在或已失效', 404)

        if inv.status != 'pending':
            return {'status': inv.status, 'valid': False}

        if inv.expires_at < timezone.now():
            inv.status = 'expired'
            inv.save(update_fields=['status'])
            return {'status': 'expired', 'valid': False}

        if inv.max_uses != -1 and inv.use_count >= inv.max_uses:
            return {'status': 'exhausted', 'valid': False}

        if self.user and self._invitation_already_accepted_by(inv, str(self.user.id)):
            return {'status': 'already_used', 'valid': False}

        return {
            'valid': True,
            'status': inv.status,
            'organization_id': str(inv.organization_id),
            'organization_name': inv.organization.name,
            'organization_icon': inv.organization.icon,
            'role': inv.role,
            'invite_type': inv.invite_type,
            'expires_at': inv.expires_at.isoformat(),
        }

    @transaction.atomic(using=postgres_app_db_alias())
    def accept_invitation(self, token: str) -> Dict[str, Any]:
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)

        try:
            inv = OrganizationInvitation.objects.select_for_update().get(token=token)
        except OrganizationInvitation.DoesNotExist:
            raise ServiceError('INVITATION_NOT_FOUND', '邀请不存在或已失效', 404)

        if inv.status != 'pending':
            raise ServiceError('INVITATION_INVALID', f'邀请状态: {inv.status}')

        if inv.expires_at < timezone.now():
            inv.status = 'expired'
            inv.save(update_fields=['status'])
            raise ServiceError('INVITATION_EXPIRED', '邀请已过期')

        if inv.max_uses != -1 and inv.use_count >= inv.max_uses:
            raise ServiceError('INVITATION_EXHAUSTED', '邀请使用次数已耗尽')

        if inv.invite_type == 'email' and inv.email:
            user_email = (self.user.email or '').strip().lower()
            inv_email = (inv.email or '').strip().lower()
            if not user_email or user_email != inv_email:
                raise ServiceError(
                    'EMAIL_MISMATCH',
                    f'此邀请发送到了 {inv.email}，请用该邮箱对应的账号登录',
                    403,
                )

        organization = Organization.objects.select_for_update().get(id=inv.organization_id)
        self.assert_team_organization(organization)
        user_id = str(self.user.id)

        if organization.owner_id == self.user.id:
            raise ServiceError('ALREADY_OWNER', '你已是组织所有者')

        if OrganizationMember.objects.filter(organization=organization, user_id=user_id).exists():
            raise ServiceError('ALREADY_MEMBER', '你已是组织成员')

        # 同令牌不可二次加入：成员被移除后旧通用链接仍 pending 时，靠 accepted_users 拦截
        self._assert_not_rejoining_via_same_invitation(inv, user_id)

        self._assert_member_join_allowed(str(organization.id))
        self._check_seat_quota(str(organization.id), fail_open=False)

        from django.db import IntegrityError as DBIntegrityError
        try:
            OrganizationMember.objects.create(
                organization=organization,
                user_id=user_id,
                role=inv.role,
            )
        except DBIntegrityError:
            raise ServiceError('ALREADY_MEMBER', '你已是组织成员')
        # Agent 与 SpaceMembership 由 post_save(OrganizationMember) signal 统一创建

        now = timezone.now()
        accept_record = {'user_id': user_id, 'accepted_at': now.isoformat()}

        inv.accepted_users = (inv.accepted_users or []) + [accept_record]
        inv.accepted_by = user_id
        inv.accepted_at = now
        inv.use_count = (inv.use_count or 0) + 1

        if inv.invite_type == 'email' or (inv.max_uses != -1 and inv.use_count >= inv.max_uses):
            inv.status = 'accepted'

        inv.save(update_fields=['accepted_users', 'accepted_by', 'accepted_at',
                                'use_count', 'status', 'updated_at'])

        return {
            'organization_id': str(organization.id),
            'organization_name': organization.name,
            'role': inv.role,
        }

    @transaction.atomic(using=postgres_app_db_alias())
    def cancel_invitation(self, organization_id: UUID, invitation_id: UUID) -> bool:
        if not self._check_manage_permission(str(organization_id)):
            raise ServiceError('PERMISSION_DENIED', '仅组织所有者可管理邀请', 403)
        try:
            inv = OrganizationInvitation.objects.select_related('organization').get(
                id=invitation_id,
                organization_id=organization_id,
                status='pending',
            )
        except OrganizationInvitation.DoesNotExist:
            raise ServiceError('INVITATION_NOT_FOUND', '邀请不存在或已处理', 404)
        inv.status = 'cancelled'
        inv.save(update_fields=['status'])

        target_user_id = inv.invited_user_id
        wt_name = inv.organization.name if inv.organization else ''
        wt_id = str(organization_id)
        actor_name = (
            getattr(self.user, 'nickname', '')
            or getattr(self.user, 'username', '')
            or ''
        )

        if target_user_id:
            inv_id = str(invitation_id)

            def _push_cancel_notification():
                try:
                    from apps.services.notification.services.notification_service import NotificationService
                    from apps.services.notification.services.organization_notification_formatter import (
                        format_organization_notification,
                    )

                    display = format_organization_notification(
                        'invitation_cancelled',
                        organization_name=wt_name,
                        actor_name=actor_name,
                    )
                    NotificationService.resolve_invitation_notification(
                        user_id=target_user_id,
                        invitation_id=inv_id,
                        type='organization.invitation.cancelled',
                        title=display.title,
                        body=display.body,
                        metadata={
                            'canonical_display': True,
                            'organization_name': wt_name,
                            'actor_name': actor_name,
                            'invitation_id': inv_id,
                            'category': 'organization',
                            'behavior': 'notification_only',
                            'desktop_delivery': 'never',
                            'dedupe_key': f'organization:invitation:cancelled:{inv_id}',
                        },
                        organization_id=wt_id,
                    )
                except Exception as e:
                    logger.warning("取消邀请通知推送失败（非阻断）: %s", e)

            from django.db import connections
            connections[postgres_app_db_alias()].on_commit(_push_cancel_notification)

        return True

    @staticmethod
    def _push_invitation_response_notifications(
        *, inviter_id: str, responder_id: str, responder_name: str,
        wt_name: str, wt_id: str, accepted: bool,
        role: str = '',
        invitation_id: str = '',
    ):
        """推送邀请响应通知：通知邀请人结果 + 触发响应者其他设备同步。"""
        try:
            from apps.services.notification.services.notification_service import NotificationService
            from apps.services.notification.services.organization_notification_formatter import (
                format_organization_notification,
            )

            if inviter_id:
                response_event = 'invitation_accepted' if accepted else 'invitation_rejected'
                response_display = format_organization_notification(
                    response_event,
                    organization_name=wt_name,
                    invitee_name=responder_name,
                    role=role,
                )
                response_metadata = {
                    'canonical_display': True,
                    'responder_id': responder_id,
                    'responder_name': responder_name,
                    'organization_name': wt_name,
                    'accepted': accepted,
                    'invitation_id': invitation_id,
                    'category': 'organization',
                    'behavior': 'notification_only',
                    'dedupe_key': (
                        f'organization:invitation:responded:{invitation_id}:{accepted}'
                    ),
                    'source_event_id': (
                        f'organization:invitation:responded:{invitation_id}:{accepted}'
                    ),
                }
                if accepted:
                    response_metadata['role'] = role
                NotificationService.notify(
                    user_id=inviter_id,
                    type='organization.invitation.responded',
                    title=response_display.title,
                    body=response_display.body,
                    metadata=response_metadata,
                    organization_id=wt_id,
                )

            # 响应者：原地升级原「组织邀请」卡，避免与 sync 双卡并存
            sync_display = format_organization_notification(
                'invitation_sync',
                organization_name=wt_name,
            )
            NotificationService.resolve_invitation_notification(
                user_id=responder_id,
                invitation_id=invitation_id,
                type='organization.invitation.sync',
                title=sync_display.title,
                body=sync_display.body,
                metadata={
                    'canonical_display': True,
                    'organization_name': wt_name,
                    'accepted': accepted,
                    'invitation_id': invitation_id,
                    'category': 'organization',
                    'behavior': 'notification_only',
                    'desktop_delivery': 'never',
                    'dedupe_key': f'organization:invitation:sync:{invitation_id}:{accepted}',
                },
                organization_id=wt_id,
            )
        except Exception as e:
            logger.warning("邀请响应通知推送失败（非阻断）: %s", e)

    _EMAIL_STRINGS = {
        'zh': {
            'subject': '邀请你加入组织「{organization}」',
            'heading': '你收到了一个组织邀请',
            'body': '你被邀请以 <strong>{role}</strong> 身份加入组织「<strong>{organization}</strong>」。',
            'cta': '接受邀请',
            'expires': '此邀请将于 {expires} 过期。',
        },
        'en': {
            'subject': 'You are invited to join organization "{organization}"',
            'heading': 'You have a organization invitation',
            'body': 'You are invited to join organization "<strong>{organization}</strong>" as <strong>{role}</strong>.',
            'cta': 'Accept Invitation',
            'expires': 'This invitation expires on {expires}.',
        },
    }

    ROLE_DISPLAY_EN = {'admin': 'Admin', 'editor': 'Editor', 'viewer': 'Viewer'}

    def _send_invitation_email(self, invitation: OrganizationInvitation):
        """发送邀请邮件（异步，失败不阻断）。根据组织 settings.language 选择语言。"""
        try:
            from apps.services.email.services import get_email_service
            email_service = get_email_service()
            if not email_service or not invitation.email:
                return

            wt_settings = invitation.organization.settings or {}
            lang = 'en' if str(wt_settings.get('language', '')).startswith('en') else 'zh'
            s = self._EMAIL_STRINGS[lang]

            from django.utils.html import escape

            ws_name = invitation.organization.name
            role_display = (
                self.ROLE_DISPLAY_EN.get(invitation.role, invitation.role)
                if lang == 'en' else invitation.get_role_display()
            )
            ws_name_safe = escape(ws_name)
            role_display_safe = escape(role_display)
            expires = invitation.expires_at.strftime('%Y-%m-%d %H:%M')
            invite_url = build_invitation_bridge_url(invitation.token)

            subject = s['subject'].format(organization=ws_name)
            body_html = f"""
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2>{s['heading']}</h2>
                    <p>{s['body'].format(organization=ws_name_safe, role=role_display_safe)}</p>
                    <p><a href="{invite_url}"
                       style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;
                              text-decoration:none;border-radius:8px;font-weight:600;">
                       {s['cta']}
                    </a></p>
                    <p style="color:;font-size:12px;">
                        {s['expires'].format(expires=expires)}
                    </p>
                </div>
            """
            email_service.send_email(
                to_email=invitation.email,
                subject=subject,
                content=body_html,
                content_type='html',
            )
        except Exception as e:
            logger.warning("发送邀请邮件失败: %s", e)

    @staticmethod
    def cleanup_expired_invitations():
        """定时清理过期邀请"""
        count = OrganizationInvitation.objects.filter(
            status='pending',
            expires_at__lt=timezone.now(),
        ).update(status='expired')
        if count:
            logger.info("清理了 %d 条过期邀请", count)
        return count
