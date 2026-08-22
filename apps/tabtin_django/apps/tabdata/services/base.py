"""
TabData 基础服务类

提供表格级权限检查
"""
import logging
from typing import Optional

from django.contrib.auth import get_user_model
from django.db.models import Exists, OuterRef, Q

from apps.tabtinspace.services.base import BaseService as ContextBaseService
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.request_context import (
    get_current_table_share_grant,
    get_current_table_share_password,
)

logger = logging.getLogger(__name__)

User = get_user_model()


class BaseService(ContextBaseService):
    """
    TabData 基础服务类
    """

    def build_table_permission_filter_q(self, required_role: str = "viewer") -> Q:
        """构建与 check_table_permission 等价的 SQL 过滤条件。

        仅覆盖持久 ACL：owner ∪ 有效 TablePermission。
        运行时 share_grant 是单表上下文，不进入列表过滤。
        """
        from apps.tabdata.models import TablePermission
        from apps.services.common.constants import ROLE_LEVELS

        if not self.user or not hasattr(self.user, "id"):
            return Q(pk__in=[])

        required_level = ROLE_LEVELS.get(required_role, ROLE_LEVELS.get("viewer", 0))
        qualifying_roles = [
            role
            for role, level in ROLE_LEVELS.items()
            if level >= required_level
        ]
        user_id_text = str(self.user.id)
        owner_match = Q(owner_id=self.user.id)
        user_perm_match = Exists(
            TablePermission.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=OuterRef("pk"),
                subject_type="user",
                subject_id=user_id_text,
                is_active=True,
                permission__in=qualifying_roles,
            )
        )
        return owner_match | user_perm_match

    def check_table_permission(
        self,
        table_id: str,
        required_role: str = 'viewer'
    ) -> bool:
        """
        检查用户对表格的权限

        有效权限取以下来源的最高级别：表格 owner、显式 TablePermission、
        父 TabDoc 继承角色；可编辑分享链接是独立运行时通道。
        不回退 Space / Organization 角色——云产物挂 Organization ≠ 组织成员默认可访问。
        """
        from apps.tabdata.models import Table, TablePermission
        from apps.services.common.constants import ROLE_LEVELS

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        except Table.DoesNotExist:
            if self.user:
                logger.warning(
                    "[PermissionDenied] %s",
                    {"check": "table", "user_id": str(self.user.id),
                     "table_id": str(table_id), "required_role": required_role,
                     "reason": "table_not_found"},
                )
            return False

        if not self.user or not hasattr(self.user, 'id'):
            return False

        share_grant = get_current_table_share_grant()
        if self._share_grant_allows_table_access(
            share_grant,
            table_id=str(table.id),
            required_role=required_role,
        ):
            return True

        # 1. 表格 owner 直接通过
        owner_id = getattr(table, 'owner_id', None)
        if owner_id and str(owner_id) == str(self.user.id):
            return True

        # 2. 资源级权限（TablePermission）
        required_level = ROLE_LEVELS.get(required_role, ROLE_LEVELS.get('viewer', 0))
        user_perm = (
            TablePermission.objects.using(TABDATA_DB_ALIAS)
            .filter(
                table_id=table.id,
                subject_type='user',
                subject_id=str(self.user.id),
                is_active=True,
            )
            .values_list('permission', flat=True)
            .first()
        )
        if user_perm and ROLE_LEVELS.get(user_perm, 0) >= required_level:
            return True

        from apps.tabdoc.services.embedded_access import (
            get_current_parent_document_resource_role,
        )

        inherited_role = get_current_parent_document_resource_role(
            user=self.user,
            resource_type="table",
            resource=table,
        )
        if inherited_role and ROLE_LEVELS.get(inherited_role, 0) >= required_level:
            return True

        # ：没有资源自身权限或父文档继承权限时不可访问。
        return False

    def _share_grant_allows_table_access(
        self,
        share_grant,
        *,
        table_id: str,
        required_role: str,
    ) -> bool:
        """可编辑分享链接授予当前表的 viewer/editor 运行时权限。"""
        if share_grant is None:
            return False
        if str(getattr(share_grant, "table_id", "")) != str(table_id):
            return False
        if getattr(share_grant, "permission", None) != "edit":
            return False
        if not getattr(share_grant, "is_active", True):
            return False
        if getattr(share_grant, "share_type", None) == "form":
            return False

        from apps.services.common.constants import ROLE_LEVELS
        required_level = ROLE_LEVELS.get(required_role, ROLE_LEVELS.get('viewer', 0))
        if required_level > ROLE_LEVELS.get('editor', 0):
            return False

        try:
            from apps.tabdata.services.share_service import TableShareService

            TableShareService.verify_share_access(
                share_grant,
                password=get_current_table_share_password(),
                user=self.user,
            )
        except Exception:
            return False
        return True

    def get_table_role(self, table_id: str) -> Optional[str]:
        """
        获取当前用户对表格的有效角色。

        顺序与 check_table_permission 一致：owner → 显式 TablePermission。
        不回退 Space / Organization。
        """
        if not self.user:
            return None

        from apps.tabdata.models import Table, TablePermission

        try:
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        except Table.DoesNotExist:
            return None

        if table.owner_id == self.user.id:
            return 'owner'

        explicit_role = (
            TablePermission.objects.using(TABDATA_DB_ALIAS)
            .filter(
                table_id=table.id,
                subject_type='user',
                subject_id=str(self.user.id),
                is_active=True,
            )
            .values_list('permission', flat=True)
            .first()
        )
        from apps.tabdoc.services.embedded_access import (
            get_current_parent_document_resource_role,
        )

        inherited_role = get_current_parent_document_resource_role(
            user=self.user,
            resource_type="table",
            resource=table,
        )
        roles = [role for role in (explicit_role, inherited_role) if role]
        if not roles:
            return None

        from apps.services.common.constants import ROLE_LEVELS

        return max(roles, key=lambda role: ROLE_LEVELS.get(role, 0))
