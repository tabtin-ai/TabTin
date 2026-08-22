"""
Tabtin Space 基础服务类

提供通用方法和 Organization/Space 权限检查
"""
import logging
from typing import Optional, Union

from apps.i18n import _
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import models
from django.db.models import QuerySet

logger = logging.getLogger(__name__)

User = get_user_model()

from apps.services.common.constants import (  # noqa: F401 — re-export
    ROLE_LEVELS,
    ASSIGNABLE_ROLES,
    ORGANIZATION_ASSIGNABLE_ROLES,
)


def check_space_access(user, space_id: str, required_role: str = 'viewer') -> bool:
    """统一 Space 权限检查便捷入口（无需实例化 BaseService）。

    接受 User 对象或 user_id（str/UUID），内部委托给
    BaseService.check_space_permission，语义完全一致：
    SpaceMembership + Agent Membership + Organization Owner 隐式权限
    + API Key organization 约束。

    用于替换散落在各模块中的独立实现，确保全平台 Space 权限语义统一。
    """
    if not user:
        return False
    if isinstance(user, (str, UUID)):
        resolved = User.objects.filter(id=user).first()
        if not resolved:
            return False
        user = resolved
    return BaseService(user=user).check_space_permission(str(space_id), required_role)


class ServiceError(Exception):
    """Service 层结构化错误，携带 error_code 供 API 层映射为 HTTP 响应"""

    def __init__(self, code: str, message: str = '', status: int = 400, data: dict = None):
        self.code = code
        self.message = message
        self.status = status
        self.data = data
        super().__init__(message or code)


def _normalize_uuid(value: Union[str, UUID], field_name: str = "id") -> UUID:
    """将 str 或 UUID 统一转为 UUID，格式非法时抛 ValueError。"""
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} 不是合法 UUID") from exc


def ensure_space_in_organization(
    organization_id: Union[str, UUID],
    space_id: Union[str, UUID],
) -> "Workspace":  # noqa: F821
    """
    校验 workspace / project 属于指定 organization。
    不匹配或不存在时抛出 ValueError，供 API 层转换为 404。
    """
    from apps.tabtinspace.models import Project, Workspace

    wt_uuid = _normalize_uuid(organization_id, "organization_id")
    as_uuid = _normalize_uuid(space_id, "space_id")

    host = Workspace.objects.filter(id=as_uuid).first()
    if host is None:
        host = Project.objects.filter(id=as_uuid).first()
    if not host:
        raise ValueError("Agent 空间不存在")
    if host.organization_id != wt_uuid:
        raise ValueError("organization_id 与 space_id 不匹配")
    return host


def validate_space_ownership_response(
    organization_id: Optional[str],
    space_id: Optional[str],
):
    """
    Django view 层的归属校验 helper。
    校验通过返回 None；校验失败返回 JsonResponse(404)。
    任一 ID 为空时直接放行（可选参数不存在则不校验）。
    """
    if not space_id or not organization_id:
        return None
    try:
        ensure_space_in_organization(organization_id, space_id)
        return None
    except ValueError:
        from django.http import JsonResponse
        return JsonResponse(
            {"ok": False, "error": _("resource.space_not_found")}, status=404
        )


class BaseService:
    """
    Tabtin Space 基础服务类
    """

    def __init__(self, user: Optional[User] = None):
        self.user = user
        self._permission_cache: dict = {}

    def assert_team_organization(self, organization) -> None:
        """个人身份不支持团队操作"""
        if getattr(organization, 'is_personal', False):
            raise ServiceError('PERSONAL_ORGANIZATION_NOT_ALLOWED', '个人身份不支持此操作，请创建组织', 403)

    def get_user_organizations(self) -> QuerySet:
        """
        获取用户有权限访问的组织
        """
        from apps.tabtinspace.models import Organization

        if not self.user:
            return Organization.objects.none()

        return Organization.objects.filter(
            models.Q(owner_id=self.user.id) |
            models.Q(members__user_id=self.user.id)
        ).exclude(status=Organization.Status.DELETING).distinct()

    def _get_operator_role(self, organization) -> Optional[str]:
        """获取当前用户在 organization 中的角色"""
        from apps.tabtinspace.models import OrganizationMember

        if not self.user:
            return None
        if organization.owner_id == self.user.id:
            return 'owner'
        try:
            member = OrganizationMember.objects.get(
                organization=organization, user_id=self.user.id
            )
            return member.role
        except OrganizationMember.DoesNotExist:
            return None

    @staticmethod
    def revoke_agent_grants(agent_id) -> dict:
        """Space-level grants were removed by SF-1; retained as cleanup no-op."""
        return {'shares_revoked': 0, 'grants_revoked': 0}

    @staticmethod
    def broadcast_permission_changed(
        user_id: str,
        organization_id: str,
        space_id: str = '',
    ) -> None:
        """用户级广播：角色 / Space 权限变更（``agent.user.permission.changed``）。

        前端收到后**re-fetch 权限缓存**——业务上是用户级状态，不绑会话/线程。
        投递走 :func:`apps.services.common.ws.bus.publish_to_user` 进入
        channel layer group ``user.{user_id}``（前端 auth.ok 时已自动 join），
        ``buffer_offline=True`` 兜底离线设备 24h 内重连补送（``USER_INBOX_TTL``
        见 ``ws/bus.py``），规避旧 ``notifications.{user_id}`` topic 的"伪用户级"
        误用（依赖客户端订阅，离线设备永久丢权限变更通知）。

        与 ``agent.permission.*``（``PromptForwardEvent.PERMISSION_RESPONSE``
        等）的区别详见 :class:`AgentUserEvent` docstring：本事件是**前端缓存
        刷新信号**，不是 Daemon 侧权限决策应答。
        """
        try:
            from apps.services.common.agent_protocol.constants import AgentUserEvent
            from apps.services.common.agent_protocol.namespace import user_event_type
            from apps.services.common.ws.bus import publish_to_user
            from apps.services.common.ws.protocol import build_envelope

            envelope = build_envelope(
                user_event_type(AgentUserEvent.PERMISSION_CHANGED),
                f'perm_{organization_id[:8]}',
                {
                    'organization_id': organization_id,
                    'space_id': space_id,
                },
            )
            publish_to_user(user_id, envelope)
        except Exception:
            logger.warning(
                "permission.changed broadcast failed: user=%s organization=%s",
                user_id, organization_id, exc_info=True,
            )

    @staticmethod
    def _can_manage_target(operator_role: str, target_role: str) -> bool:
        """检查操作者是否有权管理目标角色的成员（只能管理低于自己级别的成员）"""
        return ROLE_LEVELS.get(operator_role, 0) > ROLE_LEVELS.get(target_role, 0)

    def owned_agent_filter(self):
        """返回当前用户私有 Agent 的查询条件。

        Agent 不再充当用户影子身份，私有归属只认 ``owner_user``。
        """
        from django.db.models import Q

        if not self.user:
            return Q(pk__in=[])
        return Q(owner_user_id=self.user.id)

    def check_agent_owner(self, agent) -> bool:
        """检查当前用户是否拥有该 Agent；Organization 角色不授予 Agent 访问权。"""
        if not self.user or not agent:
            return False
        user_id = str(self.user.id)
        return str(getattr(agent, "owner_user_id", "") or "") == user_id

    def check_organization_permission(
        self,
        organization_id: str,
        required_role: str = 'viewer'
    ) -> bool:
        """
        检查用户对组织的权限
        """
        from apps.tabtinspace.models import Organization, OrganizationMember

        if not self.user:
            return False

        user_id = str(self.user.id)

        from apps.users.auth.api_key_context import get_api_key_organization_constraint
        constraint_wt = get_api_key_organization_constraint()
        if constraint_wt and str(organization_id) != str(constraint_wt):
            logger.warning(
                "[PermissionDenied] %s",
                {"check": "organization", "user_id": user_id,
                 "organization_id": str(organization_id), "required_role": required_role,
                 "reason": "api_key_organization_mismatch",
                 "api_key_organization": str(constraint_wt)},
            )
            return False

        try:
            organization = Organization.objects.get(id=organization_id)
            #  墓碑管线：deleting 组织对所有面向用户的访问隐身（视同不存在），
            # 与 get_user_organizations 的列表排除口径一致。
            if organization.status == Organization.Status.DELETING:
                logger.warning(
                    "[PermissionDenied] %s",
                    {"check": "organization", "user_id": user_id,
                     "organization_id": str(organization_id), "required_role": required_role,
                     "reason": "organization_deleting"},
                )
                return False
            if organization.owner_id == self.user.id:
                return True
        except Organization.DoesNotExist:
            logger.warning(
                "[PermissionDenied] %s",
                {"check": "organization", "user_id": user_id,
                 "organization_id": str(organization_id), "required_role": required_role,
                 "reason": "organization_not_found"},
            )
            return False

        try:
            member = OrganizationMember.objects.get(
                organization_id=organization_id,
                user_id=self.user.id
            )
            if ROLE_LEVELS.get(member.role, 0) >= ROLE_LEVELS.get(required_role, 0):
                return True
            logger.warning(
                "[PermissionDenied] %s",
                {"check": "organization", "user_id": user_id,
                 "organization_id": str(organization_id), "required_role": required_role,
                 "actual_role": member.role, "reason": "insufficient_role"},
            )
            return False
        except OrganizationMember.DoesNotExist:
            logger.warning(
                "[PermissionDenied] %s",
                {"check": "organization", "user_id": user_id,
                 "organization_id": str(organization_id), "required_role": required_role,
                 "reason": "not_member"},
            )
            return False

    def check_space_permission(
        self,
        space_id: str,
        required_role: str = 'viewer'
    ) -> bool:
        """
        检查用户对 Space 的权限

        合并以下来源的权限级别并取最高值，再与所需角色比较：
        用户直接 SpaceMembership、关联 Agent 的 SpaceMembership、
        Organization Owner 的隐式 viewer 级别。

        结果按 (space_id, required_role) 在实例生命周期内缓存，
        BaseService 随请求创建销毁，无需 TTL。
        """
        cache_key = f"{space_id}:{required_role}"
        if cache_key in self._permission_cache:
            return self._permission_cache[cache_key]

        result = self._check_space_permission_uncached(space_id, required_role)
        self._permission_cache[cache_key] = result
        return result

    def _check_space_permission_uncached(
        self,
        space_id: str,
        required_role: str = 'viewer'
    ) -> bool:
        from apps.tabtinspace.models import Project, Workspace
        from apps.tabtinspace.services.space_visibility import user_can_access_space

        host = Workspace.objects.filter(id=space_id).first()
        if host is None:
            host = Project.objects.filter(id=space_id).first()
        if host is None:
            if self.user:
                logger.warning(
                    "[PermissionDenied] %s",
                    {"check": "space", "user_id": str(self.user.id),
                     "space_id": str(space_id),
                     "required_role": required_role,
                     "reason": "space_not_found"},
                )
            return False

        if not self.user:
            return False

        user_id = str(self.user.id)

        from apps.users.auth.api_key_context import get_api_key_organization_constraint
        constraint_wt = get_api_key_organization_constraint()
        if constraint_wt and str(host.organization_id) != str(constraint_wt):
            logger.warning(
                "[PermissionDenied] %s",
                {"check": "space", "user_id": user_id,
                 "space_id": str(space_id),
                 "organization_id": str(host.organization_id),
                 "required_role": required_role,
                 "reason": "api_key_organization_mismatch",
                 "api_key_organization": str(constraint_wt)},
            )
            return False

        if user_can_access_space(self.user, host, required_role):
            return True

        logger.warning(
            "[PermissionDenied] %s",
            {"check": "space", "user_id": user_id,
             "space_id": str(space_id),
             "organization_id": str(host.organization_id),
             "required_role": required_role,
             "reason": "no_access"},
        )
        return False
