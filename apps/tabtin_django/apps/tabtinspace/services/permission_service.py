"""
统一资源级权限服务

对 Table、Document、Slide 实现独立的访问控制。
查询优先级: 资源级权限 > organization 角色 fallback。
Organization owner/admin 默认拥有所有资源的 admin 权限。
"""
import logging
import operator as op
from functools import reduce
from typing import Optional, Dict, Any, List
from uuid import UUID

from django.db import transaction
from django.db.models import Q
from django.contrib.auth import get_user_model

from apps.services.common.db_router import postgres_app_db_alias

from .base import BaseService, ROLE_LEVELS

User = get_user_model()
logger = logging.getLogger(__name__)

RESOURCE_PERMISSION_MODELS = {}

GRANTABLE_PERMISSIONS = frozenset({'viewer', 'editor', 'admin'})
VALID_SUBJECT_TYPES = frozenset({'user', 'agent', 'role'})
SUPPORTED_RESOURCE_TYPES = frozenset({'table', 'document', 'slide'})


def _get_permission_model(resource_type: str):
    """延迟加载各资源类型的权限模型"""
    if resource_type not in SUPPORTED_RESOURCE_TYPES:
        return None
    if not RESOURCE_PERMISSION_MODELS:
        try:
            from apps.tabdata.models import TablePermission
            RESOURCE_PERMISSION_MODELS['table'] = TablePermission
        except ImportError:
            pass
        try:
            from apps.tabdoc.models import DocumentPermission
            RESOURCE_PERMISSION_MODELS['document'] = DocumentPermission
        except ImportError:
            pass
        try:
            from apps.tabslide.models import SlidePermission
            RESOURCE_PERMISSION_MODELS['slide'] = SlidePermission
        except ImportError:
            pass
    return RESOURCE_PERMISSION_MODELS.get(resource_type)


def _get_resource_fk_field(resource_type: str) -> str:
    """获取权限模型中的资源外键字段名"""
    mapping = {
        'table': 'table_id',
        'document': 'document_id',
        'slide': 'slide_id',
    }
    return mapping.get(resource_type, f'{resource_type}_id')


def _get_organization_id_for_resource(resource_type: str, resource_id) -> Optional[str]:
    """查找资源所属的 organization_id"""
    if resource_type == 'table':
        from apps.tabdata.models import Table
        obj = Table.objects.filter(id=resource_id).values_list('organization_id', flat=True).first()
        return str(obj) if obj else None
    elif resource_type == 'document':
        from apps.tabdoc.models import Document
        obj = Document.objects.filter(id=resource_id).values_list('organization_id', flat=True).first()
        return str(obj) if obj else None
    elif resource_type == 'slide':
        from apps.tabslide.models import SlideProject
        obj = SlideProject.objects.filter(id=resource_id).values_list('organization_id', flat=True).first()
        return str(obj) if obj else None
    return None


class ResourcePermissionService(BaseService):
    """统一资源级权限服务"""

    def __init__(self, user=None):
        super().__init__(user)
        self._subject_cache = {}

    def _get_subject_identities(self, organization_id: Optional[str]) -> list:
        """获取用户的所有 subject 身份（user + agent + role），按 organization_id 缓存。

        缓存结构为 {'subjects': [...], 'member_role': str|None}，
        member_role 可被 _get_operator_organization_level 复用以避免重复查询。
        """
        cache_key = organization_id or '__none__'
        if cache_key in self._subject_cache:
            return self._subject_cache[cache_key]['subjects']

        from apps.tabtinspace.models import OrganizationMember

        user_id = str(self.user.id)
        subjects = [Q(subject_type='user', subject_id=user_id)]
        member_role = None

        if organization_id:
            member = OrganizationMember.objects.filter(
                organization_id=organization_id,
                user_id=self.user.id,
            ).first()
            if member:
                member_role = member.role
                subjects.append(Q(subject_type='role', subject_id=member.role))

        self._subject_cache[cache_key] = {
            'subjects': subjects,
            'member_role': member_role,
        }
        return subjects

    def _get_operator_organization_level(self, organization_id: str) -> int:
        """获取操作者在 organization 中的权限级别（含 API Key 约束检查）。

        优先复用 _get_subject_identities 缓存的 member_role，避免重复查询。
        """
        from apps.tabtinspace.models import Organization

        if not self.user:
            return 0

        from apps.users.auth.api_key_context import get_api_key_organization_constraint
        constraint_wt = get_api_key_organization_constraint()
        if constraint_wt and str(organization_id) != str(constraint_wt):
            return 0

        try:
            organization = Organization.objects.get(id=organization_id)
            if organization.owner_id == self.user.id:
                return ROLE_LEVELS['owner']
        except Organization.DoesNotExist:
            return 0

        cache_key = organization_id or '__none__'
        cached = self._subject_cache.get(cache_key)
        if cached is not None:
            member_role = cached.get('member_role')
            return ROLE_LEVELS.get(member_role, 0) if member_role else 0

        from apps.tabtinspace.models import OrganizationMember
        try:
            member = OrganizationMember.objects.get(
                organization_id=organization_id,
                user_id=self.user.id,
            )
            return ROLE_LEVELS.get(member.role, 0)
        except OrganizationMember.DoesNotExist:
            return 0

    def check_resource_permission(
        self,
        resource_type: str,
        resource_id,
        required_level: str = 'viewer',
    ) -> bool:
        if not self.user:
            return False
        if resource_type not in SUPPORTED_RESOURCE_TYPES:
            return False

        required = ROLE_LEVELS.get(required_level, 0)
        organization_id = _get_organization_id_for_resource(resource_type, resource_id)

        PermModel = _get_permission_model(resource_type)
        if PermModel:
            fk_field = _get_resource_fk_field(resource_type)
            subjects = self._get_subject_identities(organization_id)

            perms = PermModel.objects.filter(
                **{fk_field: resource_id},
                is_active=True,
            ).filter(reduce(op.or_, subjects))

            for p in perms:
                if ROLE_LEVELS.get(p.permission, 0) >= required:
                    return True

        if organization_id:
            return self.check_organization_permission(organization_id, required_level)

        return False

    @transaction.atomic(using=postgres_app_db_alias())
    def grant_permission(
        self,
        resource_type: str,
        resource_id,
        subject_type: str,
        subject_id: str,
        permission: str = 'viewer',
        organization_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        if not self.user:
            return None
        if resource_type not in SUPPORTED_RESOURCE_TYPES:
            logger.warning("拒绝已退役或不支持的资源权限类型: %s", resource_type)
            return None

        if permission not in GRANTABLE_PERMISSIONS:
            logger.warning("拒绝授予不合法权限: %s", permission)
            return None

        if subject_type not in VALID_SUBJECT_TYPES:
            logger.warning("拒绝不合法的 subject_type: %s", subject_type)
            return None

        if subject_type == 'role' and subject_id not in ROLE_LEVELS:
            logger.warning("拒绝不合法的角色 subject_id: %s", subject_id)
            return None

        wt_id = organization_id or _get_organization_id_for_resource(resource_type, resource_id)
        if not wt_id:
            logger.warning("无法解析资源 %s:%s 的 organization 归属，拒绝操作", resource_type, resource_id)
            return None

        if organization_id:
            actual_wt_id = _get_organization_id_for_resource(resource_type, resource_id)
            if actual_wt_id and str(organization_id) != str(actual_wt_id):
                logger.warning(
                    "organization_id 参数 %s 与资源实际归属 %s 不一致，拒绝操作",
                    organization_id, actual_wt_id,
                )
                return None

        operator_level = self._get_operator_organization_level(wt_id)
        if operator_level < ROLE_LEVELS['admin']:
            return None
        if ROLE_LEVELS.get(permission, 0) > operator_level:
            logger.warning(
                "操作者权限级别 %d 低于待授予权限 %s(%d)，拒绝操作",
                operator_level, permission, ROLE_LEVELS.get(permission, 0),
            )
            return None

        PermModel = _get_permission_model(resource_type)
        if not PermModel:
            return None

        fk_field = _get_resource_fk_field(resource_type)
        perm, created = PermModel.objects.update_or_create(
            **{fk_field: resource_id},
            subject_type=subject_type,
            subject_id=subject_id,
            defaults={
                'permission': permission,
                'is_active': True,
                'granted_by': str(self.user.id),
            },
        )

        return {
            'id': str(perm.id),
            'resource_type': resource_type,
            'resource_id': str(resource_id),
            'subject_type': subject_type,
            'subject_id': subject_id,
            'permission': perm.permission,
            'created': created,
        }

    @transaction.atomic(using=postgres_app_db_alias())
    def revoke_permission(
        self,
        resource_type: str,
        resource_id,
        permission_id,
        organization_id: Optional[str] = None,
    ) -> bool:
        if not self.user:
            return False
        if resource_type not in SUPPORTED_RESOURCE_TYPES:
            logger.warning("拒绝已退役或不支持的资源权限类型: %s", resource_type)
            return False

        wt_id = organization_id or _get_organization_id_for_resource(resource_type, resource_id)
        if not wt_id:
            logger.warning("无法解析资源 %s:%s 的 organization 归属，拒绝操作", resource_type, resource_id)
            return False
        if not self.check_organization_permission(wt_id, 'admin'):
            return False

        PermModel = _get_permission_model(resource_type)
        if not PermModel:
            return False

        fk_field = _get_resource_fk_field(resource_type)
        try:
            perm = PermModel.objects.get(
                id=permission_id,
                **{fk_field: resource_id},
            )
            perm.is_active = False
            perm.save(update_fields=['is_active', 'updated_at'])
            return True
        except PermModel.DoesNotExist:
            return False

    def list_permissions(
        self,
        resource_type: str,
        resource_id,
        organization_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        if not self.user:
            return []
        if resource_type not in SUPPORTED_RESOURCE_TYPES:
            logger.warning("拒绝已退役或不支持的资源权限类型: %s", resource_type)
            return []

        wt_id = organization_id or _get_organization_id_for_resource(resource_type, resource_id)
        if not wt_id:
            logger.warning("无法解析资源 %s:%s 的 organization 归属，拒绝操作", resource_type, resource_id)
            return []
        if not self.check_organization_permission(wt_id, 'viewer'):
            return []

        PermModel = _get_permission_model(resource_type)
        if not PermModel:
            return []

        fk_field = _get_resource_fk_field(resource_type)
        perms = PermModel.objects.filter(
            **{fk_field: resource_id},
            is_active=True,
        )

        result = []
        for p in perms:
            result.append({
                'id': str(p.id),
                'subject_type': p.subject_type,
                'subject_id': p.subject_id,
                'permission': p.permission,
                'granted_by': p.granted_by,
                'created_at': p.created_at.isoformat(),
            })
        return result
