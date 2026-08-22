"""
权限检查器 - 用于 Agent Tools

提供无需 User 对象的权限检查功能
"""

from typing import Optional, Tuple
import logging

logger = logging.getLogger(__name__)


class TablePermissionChecker:
    """
    表格权限检查器

    专为 Agent Tools 设计，只需要 user_id 即可进行权限检查
    """

    @staticmethod
    def check_table_access(
        user_id: str,
        table_id: str,
        organization_id: Optional[str] = None,
        space_id: Optional[str] = None,
    ) -> Tuple[bool, Optional[str]]:
        """
        检查用户是否有权限访问表格

        Args:
            user_id: 用户 ID（字符串格式）
            table_id: 表格 ID（字符串格式）
            organization_id: 组织 ID（可选，用于一致性校验）
            space_id: Space ID（可选，用于一致性校验）

        Returns:
            (has_permission, error_message)
            - has_permission: True 表示有权限，False 表示无权限
            - error_message: 如果无权限，返回错误信息；有权限则返回 None

        Examples:
            >>> has_permission, error = TablePermissionChecker.check_table_access(user_id, table_id)
            >>> if not has_permission:
            >>>     return {'success': False, 'error': error}
        """
        if not user_id:
            logger.warning("[PermissionChecker] Missing user info, cannot check table permissions")
            return False, "Missing user info"

        from apps.tabdata.models import Table
        from apps.tabtinspace.models import Organization

        try:
            table = Table.objects.get(id=table_id)
        except Table.DoesNotExist:
            logger.warning(f"[PermissionChecker] Table {table_id} not found")
            return False, f'Table {table_id} not found'

        if space_id and str(table.project_id) != str(space_id):
            logger.warning(
                "[PermissionChecker] Table %s does not belong to Space %s",
                table_id,
                space_id,
            )
            return False, "Table does not belong to Space"

        if organization_id and str(table.organization_id) != str(organization_id):
            logger.warning(
                "[PermissionChecker] Table %s does not belong to organization %s",
                table_id,
                organization_id,
            )
            return False, "Table does not belong to organization"

        try:
            organization = Organization.objects.get(id=table.organization_id)
        except Organization.DoesNotExist:
            logger.warning(f"[PermissionChecker] Organization linked to table {table_id} not found")
            return False, "Organization linked to table not found"

        is_owner = str(organization.owner_id) == str(user_id)
        is_member = organization.members.filter(user_id=user_id).exists()

        if not (is_owner or is_member):
            logger.warning(f"[PermissionChecker] User {user_id} has no access to table {table_id}")
            return False, 'No access to this table'

        logger.debug(f"[PermissionChecker] User {user_id} has access to table {table_id}")
        return True, None

    @staticmethod
    def get_table_with_permission(
        user_id: str,
        table_id: str,
        organization_id: Optional[str] = None,
        space_id: Optional[str] = None,
    ) -> Tuple[Optional['Table'], Optional[str]]:
        """
        获取表格（带权限检查）

        这是最常用的方法，一次性完成权限检查和表格获取

        Args:
            user_id: 用户 ID（字符串格式）
            table_id: 表格 ID（字符串格式）
            organization_id: 组织 ID（可选，用于一致性校验）
            space_id: Space ID（可选，用于一致性校验）

        Returns:
            (table, error_message)
            - table: 如果有权限，返回 Table 对象；否则返回 None
            - error_message: 如果无权限，返回错误信息；有权限则返回 None

        Examples:
            >>> table, error = TablePermissionChecker.get_table_with_permission(user_id, table_id)
            >>> if error:
            >>>     return {'success': False, 'error': error}
            >>>
            >>> # 继续使用 table 对象
            >>> fields = table.fields.all()
        """
        if not user_id:
            logger.warning("[PermissionChecker] Missing user info, cannot check table permissions")
            return None, "Missing user info"

        from apps.tabdata.models import Table
        from apps.tabtinspace.models import Organization

        try:
            table = Table.objects.get(id=table_id)
        except Table.DoesNotExist:
            logger.warning(f"[PermissionChecker] Table {table_id} not found")
            return None, f'Table {table_id} not found'

        if space_id and str(table.project_id) != str(space_id):
            logger.warning(
                "[PermissionChecker] Table %s does not belong to Space %s",
                table_id,
                space_id,
            )
            return None, "Table does not belong to Space"

        if organization_id and str(table.organization_id) != str(organization_id):
            logger.warning(
                "[PermissionChecker] Table %s does not belong to organization %s",
                table_id,
                organization_id,
            )
            return None, "Table does not belong to organization"

        try:
            organization = Organization.objects.get(id=table.organization_id)
        except Organization.DoesNotExist:
            logger.warning(f"[PermissionChecker] Organization linked to table {table_id} not found")
            return None, "Organization linked to table not found"

        is_owner = str(organization.owner_id) == str(user_id)
        is_member = organization.members.filter(user_id=user_id).exists()

        if not (is_owner or is_member):
            logger.warning(f"[PermissionChecker] User {user_id} has no access to table {table_id}")
            return None, 'No access to this table'

        logger.debug(f"[PermissionChecker] User {user_id} has access to table {table_id}")
        return table, None

    @staticmethod
    def check_organization_access(user_id: str, organization_id: str) -> Tuple[bool, Optional[str]]:
        """
        检查用户是否有权限访问组织

        Args:
            user_id: 用户 ID（字符串格式）
            organization_id: 组织 ID（字符串格式）

        Returns:
            (has_permission, error_message)

        Examples:
            >>> has_permission, error = TablePermissionChecker.check_organization_access(user_id, organization_id)
            >>> if not has_permission:
            >>>     return {'success': False, 'error': error}
        """
        from apps.tabtinspace.models import Organization

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            logger.warning(f"[PermissionChecker] Organization {organization_id} not found")
            return False, f'Organization {organization_id} not found'

        is_owner = str(organization.owner_id) == str(user_id)
        is_member = organization.members.filter(user_id=user_id).exists()

        if not (is_owner or is_member):
            logger.warning(f"[PermissionChecker] User {user_id} has no access to organization {organization_id}")
            return False, 'No access to this organization'

        logger.debug(f"[PermissionChecker] User {user_id} has access to organization {organization_id}")
        return True, None

    @staticmethod
    def check_space_access(
        user_id: str,
        space_id: str,
        organization_id: Optional[str] = None,
    ) -> Tuple[bool, Optional[str]]:
        """
        检查用户是否有权限访问 Space（基于组织成员关系）

        Args:
            user_id: 用户 ID（字符串格式）
            space_id: Space ID（字符串格式）
            organization_id: 组织 ID（可选，用于一致性校验）
        """
        if not user_id:
            logger.warning("[PermissionChecker] Missing user info, cannot check Space permissions")
            return False, "Missing user info"

        from apps.tabtinspace.services.host_resolver import resolve_host

        space = resolve_host(space_id)
        if space is None:
            logger.warning(f"[PermissionChecker] Space {space_id} not found")
            return False, f"Space {space_id} not found"

        if organization_id and str(space.organization_id) != str(organization_id):
            logger.warning(
                "[PermissionChecker] Space %s does not belong to organization %s",
                space_id,
                organization_id,
            )
            return False, "Space does not belong to organization"

        organization = space.organization
        is_owner = str(organization.owner_id) == str(user_id)
        is_member = organization.members.filter(user_id=user_id).exists()
        if not (is_owner or is_member):
            logger.warning(f"[PermissionChecker] User {user_id} has no access to Space {space_id}")
            return False, "No access to this Space"

        logger.debug(f"[PermissionChecker] User {user_id} has access to Space {space_id}")
        return True, None

    @staticmethod
    def get_space_with_permission(
        user_id: str,
        space_id: str,
        organization_id: Optional[str] = None,
    ) -> Tuple[Optional['Space'], Optional[str]]:
        """获取 Space（带权限检查）"""
        has_permission, error = TablePermissionChecker.check_space_access(
            user_id=user_id,
            space_id=space_id,
            organization_id=organization_id,
        )
        if not has_permission:
            return None, error

        from apps.tabtinspace.services.host_resolver import resolve_host
        return resolve_host(space_id), None


__all__ = ['TablePermissionChecker']


