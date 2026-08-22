"""
只读数据库连接 Service

管理 PostgreSQL 只读角色的创建、授权、撤销和删除。

安全策略：
- 角色仅拥有 SELECT 权限
- 角色仅能访问对应 Space 的 schema
- search_path 限定在 Space schema 内
- 禁止 CREATE / ALTER / DROP / INSERT / UPDATE / DELETE
"""
import logging
import re
from uuid import UUID

from django.conf import settings
from django.db import connections, transaction
from django.db.models import Q

from apps.tabdata.constants import TABDATA_DB_ALIAS as DB_ALIAS
from apps.tabdata.models_db_connection import DbReadOnlyConnection
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.community_capabilities import CommunityReadonlyRoleOperations

logger = logging.getLogger('tabdata.db_connection')


class DbConnectionService:
    """只读数据库连接管理"""

    def __init__(self, user):
        self.user = user

    def get_connection(self, space_id: UUID) -> DbReadOnlyConnection | None:
        """获取 Space 的只读连接（如果存在）。
        连接是 Space 级唯一的，不按 user 过滤。"""
        try:
            return DbReadOnlyConnection.objects.using(DB_ALIAS).get(space_id=space_id)
        except DbReadOnlyConnection.DoesNotExist:
            return None

    def create_connection(self, space_id: UUID) -> DbReadOnlyConnection:
        """
        为 Space 创建只读 PostgreSQL 连接。

        步骤：
        1. 生成 PG 角色名和密码
        2. 在 PostgreSQL 中创建角色并授予只读权限
        3. 在 Django 中保存连接记录
        """
        existing = self.get_connection(space_id)
        if existing and existing.is_active:
            return existing

        schema_name = DDLManager.schema_name(space_id)
        role_name = DbReadOnlyConnection.role_name_for_space(space_id)
        password = DbReadOnlyConnection.generate_password()
        organization_id = self._resolve_organization_id(space_id)

        with transaction.atomic(using=DB_ALIAS):
            self._create_pg_role(
                role_name,
                password,
                schema_name,
                space_id=space_id,
                organization_id=organization_id,
            )

            if existing:
                existing.set_password(password)
                existing.is_active = True
                existing.save(using=DB_ALIAS)
                return existing

            conn = DbReadOnlyConnection(
                space_id=space_id,
                user=self.user,
                pg_role=role_name,
                pg_schema=schema_name,
            )
            conn.set_password(password)
            conn.save(using=DB_ALIAS)

        logger.info(
            '只读连接已创建: space=%s, role=%s, schema=%s',
            space_id, role_name, schema_name,
        )
        return conn

    def delete_connection(self, space_id: UUID) -> bool:
        """
        删除 Space 的只读连接。

        步骤：
        1. 在 PostgreSQL 中撤销权限并删除角色
        2. 删除 Django 记录
        """
        conn = self.get_connection(space_id)
        if conn is None:
            return False

        organization_id = self._resolve_organization_id(space_id)
        with transaction.atomic(using=DB_ALIAS):
            self._drop_pg_role(
                conn.pg_role,
                conn.pg_schema,
                space_id=space_id,
                organization_id=organization_id,
            )
            conn.delete(using=DB_ALIAS)

        logger.info(
            '只读连接已删除: space=%s, role=%s',
            space_id, conn.pg_role,
        )
        return True

    def reset_password(self, space_id: UUID) -> DbReadOnlyConnection | None:
        """重置只读连接的密码"""
        conn = self.get_connection(space_id)
        if conn is None or not conn.is_active:
            return None

        new_password = DbReadOnlyConnection.generate_password()

        organization_id = self._resolve_organization_id(space_id)
        with transaction.atomic(using=DB_ALIAS):
            self._alter_pg_role_password(
                conn.pg_role,
                new_password,
                space_id=space_id,
                organization_id=organization_id,
            )

            conn.set_password(new_password)
            conn.save(using=DB_ALIAS)

        logger.info('只读连接密码已重置: space=%s, role=%s', space_id, conn.pg_role)
        return conn

    # ── PostgreSQL DDL 操作 ──────────────────────────────

    @staticmethod
    def _resolve_organization_id(space_id: UUID) -> UUID:
        from apps.tabdata.models import Table

        organization_ids = list(
            Table.objects.using(DB_ALIAS)
            .filter(
                Q(space_id=space_id)
                | Q(space_id__isnull=True, organization_id=space_id)
            )
            .order_by()
            .values_list('organization_id', flat=True)
            .distinct()[:2]
        )
        if not organization_ids:
            return space_id
        if len(organization_ids) != 1:
            raise PermissionError('TabData scope spans multiple organizations')
        return organization_ids[0]

    @staticmethod
    def _validate_pg_identifier(name: str, label: str = "identifier") -> None:
        """确保 PG 标识符只含安全字符（字母、数字、下划线），防止 SQL 注入"""
        if not re.match(r'^[a-zA-Z0-9_]+$', name):
            raise ValueError(f"Invalid PostgreSQL {label}: {name!r}")

    @staticmethod
    def _create_pg_role(
        role_name: str,
        password: str,
        schema_name: str,
        *,
        space_id: UUID | None = None,
        organization_id: UUID | None = None,
    ) -> None:
        """在 PostgreSQL 中创建只读角色并授权"""
        DbConnectionService._validate_pg_identifier(role_name, "role_name")
        DbConnectionService._validate_pg_identifier(schema_name, "schema_name")
        if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
            if space_id is None or organization_id is None:
                raise ValueError('Community readonly scope is required')
            if role_name != DbReadOnlyConnection.role_name_for_space(space_id):
                raise PermissionError('Community readonly role mismatch')
            if schema_name != DDLManager.schema_name(space_id):
                raise PermissionError('Community readonly schema mismatch')
            CommunityReadonlyRoleOperations(
                connections[DB_ALIAS]
            ).create(space_id, organization_id, password)
            return
        with connections[DB_ALIAS].cursor() as cursor:
            # 1. 创建角色（如果不存在）
            # 先检查角色是否存在
            cursor.execute(
                "SELECT 1 FROM pg_roles WHERE rolname = %s",
                [role_name],
            )
            if cursor.fetchone():
                # 角色已存在，更新密码
                cursor.execute(
                    f'ALTER ROLE "{role_name}" WITH LOGIN PASSWORD %s',
                    [password],
                )
            else:
                # 创建新角色
                cursor.execute(
                    f'CREATE ROLE "{role_name}" WITH LOGIN PASSWORD %s '
                    f'NOSUPERUSER NOCREATEDB NOCREATEROLE',
                    [password],
                )

            # 2. 授予 schema 的 USAGE 权限
            cursor.execute(f'GRANT USAGE ON SCHEMA "{schema_name}" TO "{role_name}"')

            # 3. 授予 schema 内所有现有表的 SELECT 权限
            cursor.execute(
                f'GRANT SELECT ON ALL TABLES IN SCHEMA "{schema_name}" TO "{role_name}"'
            )

            # 4. 设置默认权限 — 未来在此 schema 下新建的表也自动授予 SELECT
            cursor.execute(
                f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema_name}" '
                f'GRANT SELECT ON TABLES TO "{role_name}"'
            )

            # 5. 限定 search_path
            cursor.execute(
                f'ALTER ROLE "{role_name}" SET search_path TO "{schema_name}"'
            )

        logger.info('PG 只读角色已创建: role=%s, schema=%s', role_name, schema_name)

    @staticmethod
    def _drop_pg_role(
        role_name: str,
        schema_name: str,
        *,
        space_id: UUID | None = None,
        organization_id: UUID | None = None,
    ) -> None:
        """在 PostgreSQL 中撤销权限并删除角色。

        schema 不存在时跳过 REVOKE 步骤，直接 DROP ROLE。
        """
        DbConnectionService._validate_pg_identifier(role_name, "role_name")
        DbConnectionService._validate_pg_identifier(schema_name, "schema_name")
        if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
            if space_id is None or organization_id is None:
                raise ValueError('Community readonly scope is required')
            if role_name != DbReadOnlyConnection.role_name_for_space(space_id):
                raise PermissionError('Community readonly role mismatch')
            if schema_name != DDLManager.schema_name(space_id):
                raise PermissionError('Community readonly schema mismatch')
            CommunityReadonlyRoleOperations(
                connections[DB_ALIAS]
            ).drop(space_id, organization_id)
            return
        with connections[DB_ALIAS].cursor() as cursor:
            cursor.execute(
                "SELECT pg_terminate_backend(pid) "
                "FROM pg_stat_activity "
                "WHERE usename = %s AND pid <> pg_backend_pid()",
                [role_name],
            )

            cursor.execute(
                "SELECT 1 FROM pg_namespace WHERE nspname = %s",
                [schema_name],
            )
            schema_exists = cursor.fetchone() is not None

            if schema_exists:
                cursor.execute(
                    f'REVOKE ALL ON ALL TABLES IN SCHEMA "{schema_name}" FROM "{role_name}"'
                )
                cursor.execute(
                    f'REVOKE USAGE ON SCHEMA "{schema_name}" FROM "{role_name}"'
                )
                cursor.execute(
                    f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema_name}" '
                    f'REVOKE SELECT ON TABLES FROM "{role_name}"'
                )
            else:
                logger.info('Schema %s 不存在，跳过 REVOKE 步骤', schema_name)

            cursor.execute(f'DROP ROLE IF EXISTS "{role_name}"')

        logger.info('PG 只读角色已删除: role=%s', role_name)

    @staticmethod
    def _alter_pg_role_password(
        role_name: str,
        new_password: str,
        *,
        space_id: UUID | None = None,
        organization_id: UUID | None = None,
    ) -> None:
        """更新 PG 角色密码"""
        DbConnectionService._validate_pg_identifier(role_name, "role_name")
        if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
            if space_id is None or organization_id is None:
                raise ValueError('Community readonly scope is required')
            if role_name != DbReadOnlyConnection.role_name_for_space(space_id):
                raise PermissionError('Community readonly role mismatch')
            CommunityReadonlyRoleOperations(
                connections[DB_ALIAS]
            ).rotate(space_id, organization_id, new_password)
            return
        with connections[DB_ALIAS].cursor() as cursor:
            cursor.execute(
                f'ALTER ROLE "{role_name}" WITH PASSWORD %s',
                [new_password],
            )
