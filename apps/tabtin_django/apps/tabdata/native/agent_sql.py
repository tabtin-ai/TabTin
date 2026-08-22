"""
Agent SQL 安全执行器

在原生列存储之上提供安全的 SQL 查询和写入接口，
Agent 可以使用中文表名/字段名操作多维表格数据。

安全层：
1. SQL 类型检查（sqlparse）— 仅允许 SELECT/INSERT/UPDATE/DELETE
2. Schema 限制 — 所有表引用必须在 as_{space_uuid} schema 内
3. 表名白名单 — 交叉验证解析出的表名与 Space 实际表名
4. 写入安全 — UPDATE/DELETE 必须含 WHERE；DELETE 需显式授权
5. 行数限制 — SELECT 自动 LIMIT；防止全表扫描
6. 参数化查询 — params 通过 %s 传入 cursor.execute()
7. 写入元数据注入 — 自动管理 __version / __updated_at / __updated_by
8. WebSocket 通知 — 写操作完成后触发实时更新
9. params 预处理 — dict/list 自动 json.dumps（Agent 传对象，Django 负责序列化）
"""

import json
import logging
import re
import uuid as _uuid
from typing import Any, Dict, List, Optional, Set, Tuple
from uuid import UUID

import sqlparse
from django.db import connections, transaction

from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
from apps.tabdata.constants import TABDATA_DB_ALIAS as DB_ALIAS
from apps.tabdata.native.name_resolver import (
    NameResolutionError,
    _SYSTEM_FIELD_DISPLAY,
    get_resolver,
)
from apps.tabdata.services.view_constants import VERSION_TOKEN_BASE_DEFAULT as VERSION_TOKEN_BASE

logger = logging.getLogger(__name__)


# ──────────────────────────────────
# 异常
# ──────────────────────────────────

class AgentSQLError(Exception):
    """Agent SQL 基础异常"""
    pass


class ForbiddenSQLError(AgentSQLError):
    """SQL 语句类型不被允许"""
    pass


class SchemaViolationError(AgentSQLError):
    """SQL 引用了 Space schema 外的表"""
    pass


class WriteUnsafeError(AgentSQLError):
    """写入操作缺少安全防护（如无 WHERE）"""
    pass


# ──────────────────────────────────
# 允许的语句类型
# ──────────────────────────────────

_ALLOWED_DML = frozenset({'SELECT', 'INSERT', 'UPDATE', 'DELETE'})


_FORBIDDEN_KEYWORDS = frozenset({
    'CREATE', 'ALTER', 'DROP', 'TRUNCATE',   # DDL
    'GRANT', 'REVOKE',                        # DCL
    'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',  # TCL
})

# 匹配 as_xxx schema 引用（DDLManager.schema_name 生成 as_{hex} 格式）
_RE_SCHEMA_REF = re.compile(r'"(as_[0-9a-f]{32})"')

# 匹配 WHERE 子句（用于写安全验证）
_RE_HAS_WHERE = re.compile(r'\bWHERE\b', re.IGNORECASE)

# 匹配 WHERE 1=1 / WHERE TRUE / WHERE "__id" IS NOT NULL（无意义 WHERE），
# 覆盖多层括号、括号内空格及 trailing SQL 子句。
# FAR-014: 扩展覆盖 "__id" IS NOT NULL 等恒真条件，防止 Agent 误用全表覆盖路径。
_RE_TRIVIAL_WHERE = re.compile(
    r'\bWHERE\s+\(*\s*(?:1\s*=\s*1|TRUE|"__id"\s+IS\s+NOT\s+NULL)\s*\)*'
    r'\s*(?:$|;|\bORDER\b|\bLIMIT\b|\bRETURNING\b|\bGROUP\b|\bHAVING\b|\bOFFSET\b)',
    re.IGNORECASE,
)

# 匹配 LIMIT 子句
_RE_HAS_LIMIT = re.compile(r'\bLIMIT\b', re.IGNORECASE)

# ──────────────────────────────────
# 禁止直接访问的内部表前缀（DV-004 安全修复）
# ──────────────────────────────────
# Agent SQL 只允许访问 Space 原生表（as_xxx.tbl_yyy），
# 以下 Django ORM 表和系统表禁止在 Agent SQL 中引用。
_FORBIDDEN_TABLE_PREFIXES = (
    # Django framework
    'django_',
    'auth_',
    # PostgreSQL-hosted Django apps
    'tabdata_',
    'collab_',
    'tabtinspace_',
    'orchestration_',
    'scheduler_',
    'tabdoc_',
    'tabslide_',
    'tabcode_',
    'tabvideo_',
    'tabsite_',
    'rag_',
    'schema_',
    # MySQL-hosted apps (defense in depth)
    'users_',
    'membership_',
    'wallet_',
    'payment_',
    'billing_',
    'channel_',
    'conversation_',
    'skills_',
    'updater_',
    'sms_',
    'email_',
    'oss_',
    # PostgreSQL system catalogs (unqualified access)
    'pg_',
    'sql_',
)

_RE_FORBIDDEN_TABLE_REF = re.compile(
    r'(?<!\w)"?(?:' + '|'.join(re.escape(p) for p in _FORBIDDEN_TABLE_PREFIXES) + r')\w+"?',
    re.IGNORECASE,
)

# 匹配 INSERT 的列列表部分
_RE_INSERT_COLS = re.compile(
    r'INSERT\s+INTO\s+[^\(]+\(([^\)]+)\)',
    re.IGNORECASE,
)

# 匹配 INSERT 的 VALUES 部分
_RE_INSERT_VALUES = re.compile(
    r'VALUES\s*\(([^\)]+)\)',
    re.IGNORECASE,
)

# 匹配 UPDATE SET 子句结尾位置
_RE_UPDATE_SET_END = re.compile(
    r'(\bSET\b\s+.+?)(\s+WHERE\b)',
    re.IGNORECASE | re.DOTALL,
)

_CLAUSE_END_KEYWORDS = ('ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET', 'RETURNING')


def _find_main_keyword(sql: str, keyword: str) -> Optional[int]:
    """在主查询层级（括号深度 0）查找 SQL 关键字位置。

    通过括号深度计数器跳过子查询，同时跳过单引号字符串字面量。
    支持多词关键字（如 'ORDER BY'），中间空白灵活匹配。
    """
    depth = 0
    in_string = False
    i = 0
    sql_upper = sql.upper()
    kw_parts = keyword.strip().upper().split()
    kw_first = kw_parts[0]
    kw_first_len = len(kw_first)

    while i < len(sql):
        ch = sql[i]
        if ch == "'" and not in_string:
            in_string = True
            i += 1
            continue
        if ch == "'" and in_string:
            if i + 1 < len(sql) and sql[i + 1] == "'":
                i += 2
                continue
            in_string = False
            i += 1
            continue
        if in_string:
            i += 1
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif depth == 0 and sql_upper[i:i + kw_first_len] == kw_first:
            if (i == 0 or not sql_upper[i - 1].isalnum()) and \
               (i + kw_first_len >= len(sql) or not sql_upper[i + kw_first_len].isalnum()):
                if len(kw_parts) == 1:
                    return i
                pos = i + kw_first_len
                matched = True
                for part in kw_parts[1:]:
                    if pos >= len(sql) or not sql[pos].isspace():
                        matched = False
                        break
                    while pos < len(sql) and sql[pos].isspace():
                        pos += 1
                    part_len = len(part)
                    if sql_upper[pos:pos + part_len] != part:
                        matched = False
                        break
                    end = pos + part_len
                    if end < len(sql) and sql_upper[end].isalnum():
                        matched = False
                        break
                    pos = end
                if matched:
                    return i
        i += 1
    return None


class AgentSQLExecutor:
    """
    Agent SQL 安全执行器。

    使用方式：
        executor = AgentSQLExecutor(space_id, user)
        result = executor.execute_read('SELECT "标题" FROM "任务规划"')
        result = executor.execute_write(
            'UPDATE "任务规划" SET "状态" = %s WHERE "标题" = %s',
            params=["已完成", "旧任务"]
        )
    """

    MAX_SELECT_ROWS = 1000
    MAX_WRITE_ROWS = 500

    def __init__(self, space_id: UUID, user, *, allow_cross_space: bool = False,
                 rls_context=None, sql_mode: str = "read_write",
                 allowed_table_ids: Optional[Set[UUID]] = None):
        self.space_id = space_id
        self.user = user
        self.resolver = get_resolver(space_id)
        self.db_alias = DB_ALIAS
        self._expected_schema = DDLManager.schema_name(space_id)
        self._allow_cross_space = allow_cross_space
        self._rls_context = rls_context
        self._sql_mode = sql_mode
        self._allowed_table_ids = allowed_table_ids
        # 延迟加载：同 organization 内允许访问的 schema 集合
        self._allowed_schemas: Optional[Set[str]] = None

    # ──────────────────────────────────
    # params 预处理
    # ──────────────────────────────────

    @staticmethod
    def prepare_params(params: Optional[List[Any]]) -> Optional[List[Any]]:
        """
        将 params 中的 dict/list 自动 json.dumps。

        Agent（LLM）天然擅长输出 JSON 对象，但不擅长在 SQL 字符串里
        嵌套 JSON 字符串（三层引号嵌套容易出错）。
        因此 Agent 只需传结构化对象，序列化由 Django 端完成。

        示例:
            params = ["extract_data", {"url": "example.com", "fields": ["name"]}]
            → ["extract_data", '{"url": "example.com", "fields": ["name"]}']
        """
        if not params:
            return params
        result = []
        for p in params:
            if isinstance(p, (dict, list)):
                result.append(json.dumps(p, ensure_ascii=False))
            else:
                result.append(p)
        return result

    # ──────────────────────────────────
    # 跨 Space 查询支持
    # ──────────────────────────────────

    def _get_allowed_schemas(self) -> Set[str]:
        """
        获取当前用户在同 organization 内可访问的所有 Space schema。

        返回 set(["as_xxx", "as_yyy", ...])。
        结果会被缓存到实例上。
        """
        if self._allowed_schemas is not None:
            return self._allowed_schemas

        allowed = {self._expected_schema}

        if not self._allow_cross_space or not self.user:
            self._allowed_schemas = allowed
            return allowed

        try:
            from apps.tabtinspace.services.host_resolver import host_organization_id

            # 1. 获取当前 host 的 organization
            current_organization_id = host_organization_id(self.space_id)

            if not current_organization_id:
                self._allowed_schemas = allowed
                return allowed

            organization_id = current_organization_id

            # 2. 确认 organization 成员身份（基础门槛）
            from apps.tabtinspace.models import OrganizationMember
            is_member = OrganizationMember.objects.filter(
                organization_id=organization_id,
                user=self.user,
            ).exists()

            if not is_member:
                self._allowed_schemas = allowed
                return allowed

            # 3. 按 SpaceMembership 过滤：只允许访问用户有成员身份的 Space
            from apps.tabtinspace.models import SpaceMembership
            member_space_ids = set(
                SpaceMembership.objects.using(DB_ALIAS).filter(
                    workspace__organization_id=organization_id,
                    user=self.user,
                    is_active=True,
                ).values_list('workspace_id', flat=True)
            )

            for pid in member_space_ids:
                allowed.add(DDLManager.schema_name(pid))

            logger.debug(
                "[AgentSQL] 跨 Space 查询已启用: organization=%s, 允许 %d 个 schema",
                organization_id, len(allowed),
            )

        except Exception as exc:
            logger.warning("[AgentSQL] 解析 organization schema 失败: %s", exc)

        self._allowed_schemas = allowed
        return allowed

    # ──────────────────────────────────
    # SQL 分类
    # ──────────────────────────────────

    def classify_sql(self, sql: str) -> str:
        """
        使用 sqlparse 确定 SQL 语句类型。

        Returns:
            'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

        Raises:
            ForbiddenSQLError: DDL/DCL/TCL/多语句
        """
        # 剥离注释（防止注释中隐藏 DDL）
        cleaned = sqlparse.format(sql.strip(), strip_comments=True).strip()
        if not cleaned:
            raise ForbiddenSQLError("SQL statement is empty")

        parsed = sqlparse.parse(cleaned)
        if len(parsed) == 0:
            raise ForbiddenSQLError("Failed to parse SQL statement")
        if len(parsed) > 1:
            raise ForbiddenSQLError("Only single SQL statements are allowed; semicolon-separated multi-statements are not supported")

        stmt = parsed[0]
        stmt_type = stmt.get_type()

        # sqlparse 返回的类型可能是 None（对于某些语句）
        if stmt_type is None:
            # 尝试从第一个非空白 token 判断
            first_token = None
            for token in stmt.tokens:
                if not token.is_whitespace:
                    first_token = token.ttype
                    first_value = token.value.upper()
                    break
            if first_value in _FORBIDDEN_KEYWORDS:
                raise ForbiddenSQLError(f"Unsupported SQL type: {first_value}")
            raise ForbiddenSQLError("Unrecognized SQL statement type")

        stmt_type_upper = stmt_type.upper() if stmt_type else ''

        if stmt_type_upper in _ALLOWED_DML:
            return stmt_type_upper

        if stmt_type_upper in _FORBIDDEN_KEYWORDS:
            raise ForbiddenSQLError(f"Unsupported SQL type: {stmt_type_upper}")

        raise ForbiddenSQLError(f"Unsupported SQL type: {stmt_type_upper or 'unknown'}")

    # ──────────────────────────────────
    # 安全验证
    # ──────────────────────────────────

    def _validate_schema_restriction(self, resolved_sql: str) -> None:
        """
        验证所有表引用都在允许的 schema 范围内。

        安全层：
        1. 默认：只允许当前 Space 的 schema
        2. 跨 Space 模式：允许同 organization 内所有 Space 的 as_* schema
        3. 禁止 public / pg_catalog / information_schema 等系统 schema

        Raises:
            SchemaViolationError
        """
        allowed = self._get_allowed_schemas()

        # 1. 检查所有 as_* schema 引用是否在允许范围内
        schemas_found = set(_RE_SCHEMA_REF.findall(resolved_sql))
        for schema in schemas_found:
            if schema not in allowed:
                if self._allow_cross_space:
                    raise SchemaViolationError(
                        f"SQL references a schema not in the current organization: {schema}"
                    )
                else:
                    raise SchemaViolationError(
                        f"SQL references a schema outside the current Space: {schema}, "
                        f"expected: {self._expected_schema}"
                    )

        # 2. 禁止系统 schema（public / pg_catalog / information_schema 等）
        _FORBIDDEN_SCHEMA_PATTERNS = [
            (r'"?public"?\s*\.', "public"),
            (r'"?pg_\w+"?\s*\.', "pg_catalog"),
            (r'"?information_schema"?\s*\.', "information_schema"),
        ]
        for pattern, name in _FORBIDDEN_SCHEMA_PATTERNS:
            if re.search(pattern, resolved_sql, re.IGNORECASE):
                raise SchemaViolationError(
                    f"SQL cannot reference {name} schema; only Space tables are allowed"
                )

    def _validate_table_whitelist(self, resolved_sql: str) -> None:
        """
        交叉验证解析出的表 ID 与实际存在的表。

        支持跨 Space 模式：允许引用同 organization 内其他 Space 的表。

        Raises:
            SchemaViolationError
        """
        from apps.tabdata.models import Table

        table_ids = self.resolver.get_table_ids_from_sql(resolved_sql)
        if not table_ids:
            return

        if self._allow_cross_space:
            # 跨 Space 模式：检查表是否存在于任何允许的 schema 对应的 Space 中
            existing_ids = set(
                Table.objects.using(DB_ALIAS).filter(
                    is_archived=False,
                    trashed_at__isnull=True,
                    id__in=list(table_ids),
                ).values_list('id', flat=True)
            )
        else:
            # 默认模式：仅检查当前 Space
            existing_ids = set(
                Table.objects.using(DB_ALIAS).filter(
                    space_id=self.space_id,
                    is_archived=False,
                    trashed_at__isnull=True,
                    id__in=list(table_ids),
                ).values_list('id', flat=True)
            )

        missing = table_ids - existing_ids
        if missing:
            raise SchemaViolationError(
                f"SQL references non-existent or archived tables: {[str(t) for t in missing]}"
            )

        if self._allowed_table_ids is not None:
            denied = table_ids - self._allowed_table_ids
            if denied:
                raise SchemaViolationError(
                    f"SQL references tables outside the sharing scope: {[str(t) for t in denied]}"
                )

    def _validate_write_safety(
        self,
        sql_type: str,
        resolved_sql: str,
        *,
        allow_delete: bool = False,
    ) -> None:
        """
        验证写入操作的安全性。

        Rules:
        - DELETE 需要 allow_delete=True 显式授权
        - UPDATE/DELETE 必须含 WHERE 子句
        - 拒绝 WHERE 1=1 / WHERE TRUE / WHERE "__id" IS NOT NULL 等恒真条件

        Raises:
            WriteUnsafeError, ForbiddenSQLError
        """
        if sql_type == 'DELETE' and not allow_delete:
            raise ForbiddenSQLError(
                "DELETE is not supported. Use UPDATE ... SET \"status\" = 'cancelled' for soft-delete instead."
            )

        if sql_type in ('UPDATE', 'DELETE'):
            if not _RE_HAS_WHERE.search(resolved_sql):
                raise WriteUnsafeError(
                    f"{sql_type} must include a WHERE clause; unconditional modifications are not allowed"
                )
            if _RE_TRIVIAL_WHERE.search(resolved_sql):
                raise WriteUnsafeError(
                    f"{sql_type} WHERE clause cannot be a trivial/tautological condition "
                    f"(1=1, TRUE, or \"__id\" IS NOT NULL)"
                )

    def _estimate_affected_rows(
        self,
        resolved_sql: str,
        exec_params: List[Any],
        sql_type: str,
        affected_table_ids: Set[UUID],
    ) -> int:
        """
        FAR-013: 在写操作执行前估算影响行数，超出 MAX_WRITE_ROWS 时拒绝执行。

        对 UPDATE/DELETE 通过解析 WHERE 子句执行 COUNT(*) 预检；
        INSERT 无法预检，直接返回 0（INSERT 本身不会超限）。

        Raises:
            WriteUnsafeError: 预估影响行数超出 MAX_WRITE_ROWS
        """
        if sql_type == 'INSERT':
            return 0
        if sql_type == 'DELETE':
            # DELETE 在事务内通过 alias/USING-aware before-state 查询精确读取
            # MAX_WRITE_ROWS + 1 行并 fail-closed；这里的通用 COUNT 重写无法
            # 正确保留 DELETE target alias，避免重复执行一个必然失败的预检。
            return 0

        total = 0
        try:
            where_pos = _find_main_keyword(resolved_sql, 'WHERE')
            if where_pos is None:
                return 0

            where_clause = resolved_sql[where_pos:]
            trailing_match = re.search(
                r'\b(RETURNING|ORDER|LIMIT|GROUP|HAVING|OFFSET)\b',
                where_clause, re.IGNORECASE,
            )
            if trailing_match:
                where_clause = where_clause[:trailing_match.start()].rstrip()

            set_end = resolved_sql[:where_pos]
            params_before_where = set_end.count('%s')
            where_params_count = where_clause.count('%s')
            where_params = exec_params[params_before_where:params_before_where + where_params_count]

            for table_id in affected_table_ids:
                fqn = DDLManager.qualified_table_name(self.space_id, table_id)
                count_sql = f'SELECT COUNT(*) FROM {fqn} {where_clause}'
                try:
                    with connections[self.db_alias].cursor() as cur:
                        cur.execute(count_sql, where_params)
                        row = cur.fetchone()
                        if row:
                            total += row[0]
                except Exception as exc:
                    logger.warning(
                        "[AgentSQL] affected-rows estimate failed for table %s: %s",
                        table_id, exc,
                    )
        except Exception as exc:
            logger.warning("[AgentSQL] affected-rows estimate failed: %s", exc)

        if total > self.MAX_WRITE_ROWS:
            raise WriteUnsafeError(
                f"{sql_type} would affect {total} rows, exceeding the safety limit of "
                f"{self.MAX_WRITE_ROWS}. Add a more specific WHERE clause to reduce the scope."
            )
        return total

    def _validate_no_forbidden_tables(self, resolved_sql: str) -> None:
        """
        拒绝引用 Django ORM 内部表或系统表的 SQL。

        名称解析后，合法的 Space 表引用全部为 "as_{hex}"."tbl_{hex}" 格式。
        如果 resolved SQL 中仍包含 Django 模型表名（tabdata_record、
        collab_version_history 等）或 PostgreSQL 系统目录表名，
        说明 SQL 试图绕过安全层直接访问内部数据。

        Raises:
            SchemaViolationError
        """
        cleaned = re.sub(r"'(?:[^'\\]|\\.)*'", "''", resolved_sql)
        match = _RE_FORBIDDEN_TABLE_REF.search(cleaned)
        if match:
            table_name = match.group().strip('"')
            raise SchemaViolationError(
                f"SQL references a system/internal table: {table_name}; "
                f"only Space-managed tables are allowed"
            )

    # ──────────────────────────────────
    # 写入元数据注入
    # ──────────────────────────────────

    @staticmethod
    def _append_insert_columns(
        resolved_sql: str,
        params: List[Any],
        columns: List[str],
        values: List[Any],
    ) -> Tuple[str, List[Any]]:
        """向每个 INSERT VALUES 行追加同一组参数，并保持多行参数顺序。"""
        if not columns:
            return resolved_sql, params
        cols_match = _RE_INSERT_COLS.search(resolved_sql)
        values_kw_match = re.search(r'VALUES\s*', resolved_sql, re.IGNORECASE)
        if not cols_match or not values_kw_match:
            return resolved_sql, params

        resolved_sql = (
            resolved_sql[:cols_match.end(1)]
            + ''.join(f', "{column}"' for column in columns)
            + resolved_sql[cols_match.end(1):]
        )
        values_kw_match = re.search(r'VALUES\s*', resolved_sql, re.IGNORECASE)
        if not values_kw_match:
            return resolved_sql, params
        row_re = re.compile(r'\(([^)]+)\)')
        after_values = resolved_sql[values_kw_match.end():]
        row_matches = list(row_re.finditer(after_values))
        if not row_matches:
            return resolved_sql, params

        original_params = list(params)
        rebuilt_params: List[Any] = []
        cursor = 0
        offset = values_kw_match.end()
        for row_match in reversed(row_matches):
            absolute_end = offset + row_match.end(1)
            resolved_sql = (
                resolved_sql[:absolute_end]
                + ''.join(', %s' for _ in values)
                + resolved_sql[absolute_end:]
            )
        for row_match in row_matches:
            count = row_match.group(1).count('%s')
            rebuilt_params.extend(original_params[cursor:cursor + count])
            rebuilt_params.extend(values)
            cursor += count
        rebuilt_params.extend(original_params[cursor:])
        return resolved_sql, rebuilt_params

    def _inject_insert_field_defaults(
        self,
        resolved_sql: str,
        params: List[Any],
        affected_table_ids: Set[UUID],
    ) -> Tuple[str, List[Any]]:
        """为 Agent SQL 省略列注入字段默认值，使 RLS 预检读取最终记录。"""
        if len(affected_table_ids) != 1:
            return resolved_sql, params
        cols_match = _RE_INSERT_COLS.search(resolved_sql)
        if not cols_match:
            return resolved_sql, params
        existing_columns = {
            item.strip().strip('"').lower()
            for item in cols_match.group(1).split(',')
        }

        from django.utils import timezone
        from apps.tabdata.models import TableField
        from apps.tabdata.native.value_converter import python_to_pg

        actor_id = str(self.user.id) if self.user else None
        now = timezone.now()
        columns: List[str] = []
        values: List[Any] = []
        fields = TableField.objects.using(DB_ALIAS).filter(
            table_id=next(iter(affected_table_ids)), is_deleted=False,
        )
        for field in fields:
            if field.id.hex.lower() in existing_columns:
                continue
            spec = field.default_value if isinstance(field.default_value, dict) else None
            if not spec:
                continue
            mode = spec.get('mode')
            if mode == 'literal':
                value = spec.get('value')
            elif mode in {'created_time', 'last_modified_time'}:
                value = now.isoformat()
            elif mode == 'creator' and actor_id:
                value = [actor_id] if (field.is_multiple_cell_value or (field.config or {}).get('multiple')) else actor_id
            else:
                continue
            columns.append(field.id.hex)
            values.append(python_to_pg(value, field.field_type, field.config))
        return self._append_insert_columns(resolved_sql, params, columns, values)

    def _inject_write_metadata(
        self,
        sql_type: str,
        resolved_sql: str,
        version: int,
        params: Optional[List[Any]] = None,
        affected_table_ids: Optional[Set[UUID]] = None,
    ) -> Tuple[str, List[Any]]:
        """
        为 INSERT/UPDATE 自动注入版本和时间戳元数据（参数化）。

        INSERT: 在列列表和 VALUES 中追加系统列
        UPDATE: 在 SET 子句末尾追加 __version / __updated_at / __updated_by

        Args:
            version: 从表级序列预分配的绝对版本号，确保增量同步可查到变更
            params: 调用方的原始参数列表

        Returns:
            (modified_sql, modified_params) — params 已按正确位置插入元数据参数
        """
        out_params = list(params) if params else []
        user_id_str = ''
        if self.user:
            uid = UUID(str(self.user.id))
            user_id_str = str(uid)

        if sql_type == 'UPDATE':
            maintained_set = ''
            maintained_vals: List[Any] = []
            if affected_table_ids:
                from django.utils import timezone
                from apps.tabdata.models import TableField
                from apps.tabdata.native.value_converter import python_to_pg
                now = timezone.now()
                for field in TableField.objects.using(DB_ALIAS).filter(
                    table_id__in=affected_table_ids,
                    is_deleted=False,
                    default_value__mode='last_modified_time',
                ):
                    value = now.isoformat()
                    pg_value = python_to_pg(value, field.field_type, field.config)
                    assignment = re.search(
                        rf'"{re.escape(field.id.hex)}"\s*=\s*%s',
                        resolved_sql,
                        re.IGNORECASE,
                    )
                    if assignment:
                        param_index = resolved_sql[:assignment.start()].count('%s')
                        if param_index < len(out_params):
                            out_params[param_index] = pg_value
                    else:
                        maintained_set += f', "{field.id.hex}" = %s'
                        maintained_vals.append(pg_value)
            meta_set = maintained_set + ', "__version" = %s, "__updated_at" = NOW(), "__updated_by" = %s'
            meta_vals = [*maintained_vals, version, user_id_str]
            match = _RE_UPDATE_SET_END.search(resolved_sql)
            if match:
                # 计算注入点之前的 %s 个数，确定 meta_vals 插入位置
                set_portion = resolved_sql[:match.end(1)]
                insert_idx = set_portion.count('%s')
                for i, v in enumerate(meta_vals):
                    out_params.insert(insert_idx + i, v)
                resolved_sql = (
                    resolved_sql[:match.end(1)]
                    + meta_set
                    + resolved_sql[match.start(2):]
                )
            else:
                resolved_sql = resolved_sql.rstrip().rstrip(';') + meta_set
                out_params.extend(meta_vals)

        elif sql_type == 'INSERT':
            resolved_sql, out_params = self._inject_insert_field_defaults(
                resolved_sql, out_params, affected_table_ids or set(),
            )
            upper_sql = resolved_sql.upper()
            if '"__VERSION"' not in upper_sql and '__VERSION' not in upper_sql:
                cols_match = _RE_INSERT_COLS.search(resolved_sql)
                vals_match = _RE_INSERT_VALUES.search(resolved_sql)
                if cols_match and vals_match:
                    resolved_sql, out_params = self._append_insert_columns(
                        resolved_sql,
                        out_params,
                        ["__version", "__created_at", "__updated_at", "__created_by", "__updated_by"],
                        [version, timezone_marker := object(), timezone_marker, user_id_str, user_id_str],
                    )
                    # NOW() 不能作为参数；把占位符替换回 SQL 表达式并移除哨兵参数。
                    while timezone_marker in out_params:
                        marker_index = out_params.index(timezone_marker)
                        placeholder_index = -1
                        search_from = 0
                        for _ in range(marker_index + 1):
                            placeholder_index = resolved_sql.find('%s', search_from)
                            search_from = placeholder_index + 2
                        resolved_sql = resolved_sql[:placeholder_index] + 'NOW()' + resolved_sql[placeholder_index + 2:]
                        out_params.pop(marker_index)

        return resolved_sql, out_params

    # ──────────────────────────────────
    # Django 模型同步
    # ──────────────────────────────────

    def _sync_django_model_version(
        self,
        affected_table_ids: Set[UUID],
        allocated_version: int,
        sql_type: str = "UPDATE",
        expected_count: Optional[int] = None,
    ) -> None:
        """
        将原生表 __version 的变更同步到 Django 模型 tabdata_record.version。

        Agent SQL 直接写入原生表（as_xxx.tbl_yyy）的 __version 列，
        但增量同步 API 依赖 Django 模型 tabdata_record.version 来判断
        是否有变更（_has_changes_since_version / _get_latest_version_state），
        如果不同步会导致增量查询始终返回 0 条。

        Args:
            sql_type: 'INSERT' 或 'UPDATE'，用于 synced=0 时的告警分级
            expected_count: INSERT 时对应 inserted_ids 的预期数量；synced 不匹配
                            说明 ORM 行未提前创建，应当 critical 告警
        """
        for table_id in affected_table_ids:
            try:
                native_fqn = DDLManager.qualified_table_name(
                    self.space_id, table_id
                )
                with connections[self.db_alias].cursor() as cursor:
                    cursor.execute(
                        f'UPDATE tabdata_record '
                        f'SET version = %s, updated_at = NOW() '
                        f'WHERE table_id = %s '
                        f'AND id IN ('
                        f'  SELECT "__id" FROM {native_fqn} WHERE "__version" = %s'
                        f')',
                        [allocated_version, str(table_id), allocated_version],
                    )
                    synced = cursor.rowcount

                    # ORM 镜像同步完整 cell 数据，保证默认值、历史与协作读取一致。
                    from apps.tabdata.models import TableRecord
                    table_after = self._capture_after_states({table_id}, allocated_version).get(table_id, {})
                    orm_records = {
                        str(record.id): record
                        for record in TableRecord.objects.using(DB_ALIAS).filter(
                            table_id=table_id,
                            id__in=[UUID(record_id) for record_id in table_after],
                        )
                    }
                    records_to_update = []
                    for record_id, row_data in table_after.items():
                        record = orm_records.get(record_id)
                        if record is None:
                            continue
                        record.__dict__['data'] = {
                            key: value
                            for key, value in row_data.items()
                            if not str(key).startswith('__')
                        }
                        records_to_update.append(record)
                    if records_to_update:
                        TableRecord.objects.using(DB_ALIAS).bulk_update(records_to_update, ['data'])

                    # FAR-016: synced=0 在 INSERT 路径下是数据完整性事故信号——
                    # 意味着原生表已写入但 ORM 行未对应建立，下游 collab/RecordHistory/
                    # Undo-Redo/ChangeLog 行级追踪全部对这批 record 静默失效。
                    if sql_type == 'INSERT' and synced == 0:
                        logger.error(
                            "[AgentSQL] DATA INTEGRITY: tabdata_record ORM 行缺失 "
                            "(native 已写但 ORM 不存在): table=%s version=%d "
                            "expected=%s synced=0. 后续 collab persist/历史/撤销将对这批 "
                            "record 静默失效，必须排查 _create_django_records_for_insert.",
                            table_id, allocated_version, expected_count,
                        )
                    elif sql_type == 'INSERT' and expected_count is not None and synced < expected_count:
                        logger.error(
                            "[AgentSQL] DATA INTEGRITY: tabdata_record ORM 行部分缺失: "
                            "table=%s version=%d expected=%d synced=%d (差 %d 行)",
                            table_id, allocated_version, expected_count, synced,
                            expected_count - synced,
                        )
                    else:
                        logger.info(
                            "[AgentSQL] Django model version 已同步: table=%s, version=%d, synced=%d",
                            table_id, allocated_version, synced,
                        )
            except Exception as exc:
                logger.warning(
                    "[AgentSQL] Django model version 同步失败: table=%s, err=%s",
                    table_id, exc, exc_info=True,
                )

    def _create_django_records_for_insert(
        self,
        affected_table_ids: Set[UUID],
        allocated_version: int,
        inserted_ids: List[str],
    ) -> int:
        """
        FAR-016 修复：Agent SQL INSERT 后同步创建 TableRecord ORM 行。

        【根因】Agent SQL 直接执行 ``INSERT INTO "as_xxx"."tbl_yyy" ...`` 写入
        原生列存储，但下游所有依赖 TableRecord ORM 行存在的功能都会失效：
          - collab-live persist 调用 CollabService.persist_changes 时，
            ``existing_records[record_id]`` 拿不到 record → 用户编辑被静默 skip
          - RecordHistory 写入需要 ``TableRecord.objects.filter(id=rid).first()`` →
            None → 历史/撤销/重做对这批 record 全部失效
          - ChangeLog 行级追踪、增量同步过滤同样依赖 ORM 行
          - 表面症状：Agent 采集的 record 用户编辑后刷新就丢，"变更记录"始终为空

        【修复】INSERT 主 SQL 成功后立即 bulk_create ORM 行，使所有下游
        lookup 能命中。data 字段留空（以 native 表为权威 cell 存储），下游
        需要 cell 值时按需走 NativeRecordIO 读取——这与 W3.0 之后的
        "native-first" 演进方向一致。

        Args:
            affected_table_ids: 本次 INSERT 影响的表 ID 集合
            allocated_version: 本次写入分配的版本号（与 native ``__version`` 一致）
            inserted_ids: 主 SQL ``RETURNING "__id"`` 取回的新行 ID 列表

        Returns:
            实际创建的 ORM 行数量
        """
        if not inserted_ids:
            return 0

        from apps.tabdata.models import TableRecord
        from django.db import IntegrityError

        # 通过 __version 反查每张表本次新插入的行（按 table 分组）
        after_states = self._capture_after_states(affected_table_ids, allocated_version)

        user_id: Optional[str] = None
        if self.user is not None:
            try:
                user_id = str(self.user.id)
            except Exception:
                user_id = None

        orm_rows: List[TableRecord] = []
        for table_id, table_after in after_states.items():
            for rid_str, row_data in table_after.items():
                try:
                    rid_uuid = UUID(rid_str)
                except (ValueError, TypeError):
                    continue
                order_val_raw = row_data.get('__order', 0)
                try:
                    order_val = float(order_val_raw)
                except (TypeError, ValueError):
                    order_val = 0.0

                rec = TableRecord(
                    id=rid_uuid,
                    table_id=table_id,
                    order=order_val,
                    version=allocated_version,
                    data={
                        key: value
                        for key, value in row_data.items()
                        if not str(key).startswith('__')
                    },
                    created_by_id=user_id,
                    updated_by_id=user_id,
                    is_deleted=False,
                )
                # RecordHistory 由 _emit_record_history_for_write 统一处理，
                # 避免 model save signal 重复 emit
                rec._skip_record_history = True
                orm_rows.append(rec)

        if not orm_rows:
            return 0

        try:
            # ignore_conflicts: Agent 若用 INSERT ... ON CONFLICT 重复插同一 ID，跳过
            TableRecord.objects.using(self.db_alias).bulk_create(
                orm_rows,
                batch_size=500,
                ignore_conflicts=True,
            )
            logger.info(
                "[AgentSQL] TableRecord ORM 行已同步: %d rows for tables=%s version=%d",
                len(orm_rows), [str(t) for t in after_states.keys()], allocated_version,
            )
            return len(orm_rows)
        except IntegrityError as exc:
            # 不向上抛——主 SQL 已写入 native，回滚事务会让 native 数据也丢失，
            # 反而更糟。降级为 logger.error，由 _sync_django_model_version 的
            # synced=0 告警再次提示运维介入。
            logger.error(
                "[AgentSQL] DATA INTEGRITY: TableRecord ORM bulk_create 失败 "
                "(native 数据已写入但 ORM 缺失，下游链路将静默失效): "
                "version=%d row_count=%d err=%s",
                allocated_version, len(orm_rows), exc, exc_info=True,
            )
            return 0

    def _sync_django_model_delete(
        self,
        affected_table_ids: Set[UUID],
        before_states: Dict[UUID, Dict[str, Dict[str, Any]]],
    ) -> None:
        """
        FAR-015: DELETE 后将 tabdata_record.is_deleted 置为 True。

        Agent SQL DELETE 直接物理删除原生表行，但 Django ORM 层的
        tabdata_record.is_deleted 不会自动更新，导致增量同步 API 返回
        幽灵记录（ORM 认为存在，原生表已删除）。

        通过 before_states 获取被删除行的 __id 列表，批量更新 Django 模型。
        """
        for table_id in affected_table_ids:
            table_before = before_states.get(table_id, {})
            if not table_before:
                continue
            deleted_ids = list(table_before.keys())
            if not deleted_ids:
                continue
            try:
                with connections[self.db_alias].cursor() as cursor:
                    placeholders = ','.join(['%s'] * len(deleted_ids))
                    cursor.execute(
                        f'UPDATE tabdata_record '
                        f'SET is_deleted = TRUE, updated_at = NOW() '
                        f'WHERE table_id = %s AND id IN ({placeholders})',
                        [str(table_id)] + deleted_ids,
                    )
                    synced = cursor.rowcount
                    logger.info(
                        "[AgentSQL] Django model is_deleted 已同步: table=%s, deleted=%d",
                        table_id, synced,
                    )
            except Exception as exc:
                logger.warning(
                    "[AgentSQL] Django model is_deleted 同步失败: table=%s, err=%s",
                    table_id, exc, exc_info=True,
                )

    # ──────────────────────────────────
    # WS 直推辅助
    # ──────────────────────────────────

    def _fetch_affected_records(
        self,
        table_id: UUID,
        version: int,
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[List[str]]]:
        """
        回查受 Agent SQL 影响的记录并序列化，供 WS 直推。

        先通过原生表 __version 查出 __id 列表，再用 Django ORM
        加载并序列化。_sync_django_model_version 已在此之前将
        tabdata_record.version 同步，所以 ORM filter 可直接使用。

        Returns:
            (serialized_records, record_ids) 或 (None, None) 失败时降级
        """
        try:
            from apps.tabdata.models import TableRecord
            from apps.tabdata.utils.record_serializers import serialize_records

            records = list(
                TableRecord.objects.using(DB_ALIAS)
                .filter(table_id=table_id, version=version, is_deleted=False)
                .order_by('order')[:500]
            )
            if not records:
                return None, None

            serialized = serialize_records(
                records,
                field_key_type='id',
            )
            record_ids = [str(r.id) for r in records]
            return serialized, record_ids
        except Exception as exc:
            logger.warning("[AgentSQL] 回查受影响记录失败，降级为纯通知: %s", exc)
            return None, None

    # ──────────────────────────────────
    # Y.Doc 同步
    # ──────────────────────────────────

    def _sync_affected_to_ydoc(
        self,
        affected_table_ids: List[UUID],
        version: int,
    ) -> None:
        """
        将 Agent SQL 影响的行同步到 Y.Doc（通过 /collab/apply-ops）。

        从原生 PostgreSQL 列读取数据（record.data 已废弃），使用 pg_to_python
        转换为 API 兼容值，key 使用 field_id_hex 格式（与 Y.Doc 一致）。

        分批推送，每批不超过 500 条变更。fire-and-forget，失败不阻断。
        """
        try:
            from apps.tabdata.models import Table, TableField
            from apps.tabdata.native.record_io import NativeRecordIO
            from apps.tabdata.native.query_builder import NativeQueryBuilder
            from apps.tabdata.native.value_converter import pg_to_python
            from apps.tabdata.services.collab_service import CollabService

            for table_id in affected_table_ids:
                table = Table.objects.using(DB_ALIAS).filter(id=table_id).first()
                if not table:
                    continue

                fields = list(
                    TableField.objects.using(DB_ALIAS)
                    .filter(table_id=table_id, is_deleted=False)
                )
                if not fields:
                    continue

                partition_id = resolve_schema_partition_id(table)
                native_io = NativeRecordIO(
                    space_id=partition_id,
                    table_id=table.id,
                )
                qb = NativeQueryBuilder(
                    space_id=partition_id,
                    table_id=table.id,
                    fields=fields,
                )

                rows, _ = native_io.read_records(
                    qb,
                    where=('"__version" = %s', [version]),
                    order_by=('"__order" ASC', []),
                    limit=500,
                    offset=0,
                )

                if not rows:
                    continue

                changes: List[Dict[str, Any]] = []
                for row in rows:
                    record_id = str(row.get("__id", ""))
                    if not record_id:
                        continue
                    for f in fields:
                        hex_key = f.id.hex
                        raw_value = row.get(hex_key)
                        if raw_value is not None:
                            api_value = pg_to_python(raw_value, f.field_type, f.config)
                            changes.append({
                                "record_id": record_id,
                                "field_id_hex": hex_key,
                                "value": api_value,
                            })

                batch_size = 450
                for i in range(0, len(changes), batch_size):
                    batch = changes[i:i + batch_size]
                    try:
                        CollabService.push_cells(
                            table_id=table_id,
                            changes=batch,
                            agent_id=str(getattr(self.user, 'id', '')),
                            editor_type="agent",
                        )
                    except Exception as batch_err:
                        logger.warning(
                            "[AgentSQL] Y.Doc sync batch failed: table=%s batch=%d/%d error=%s",
                            table_id, i // batch_size + 1,
                            (len(changes) + batch_size - 1) // batch_size,
                            batch_err,
                        )

                logger.info(
                    "[AgentSQL] Y.Doc sync: table=%s rows=%d changes=%d",
                    table_id, len(rows), len(changes),
                )
        except Exception as exc:
            logger.warning("[AgentSQL] Y.Doc sync failed (non-fatal): %s", exc, exc_info=True)

    # ──────────────────────────────────
    # RLS 行级安全注入
    # ──────────────────────────────────

    def _build_rls_where_for_tables(
        self,
        table_ids: Set[UUID],
        operation: str,
    ) -> Optional[Tuple[str, List[Any]]]:
        """
        为引用的表构建 RLS WHERE 子句。

        遍历所有被引用的表，如果表启用了 RLS，则构建 WHERE 条件。
        多表的 RLS 条件使用 AND 合并。

        Args:
            table_ids: 被引用的表 ID 集合
            operation: SQL 操作类型 (SELECT/UPDATE/DELETE)

        Returns:
            (combined_where_sql, params) 或 None
        """
        if not self._rls_context:
            return None

        from apps.tabdata.models import Table, TableField
        from apps.tabdata.native.query_builder import NativeQueryBuilder
        from apps.tabdata.services.rls_service import rls_service

        all_clauses: List[str] = []
        all_params: List[Any] = []

        for table_id in table_ids:
            try:
                table = Table.objects.using(DB_ALIAS).get(id=table_id)
            except Table.DoesNotExist:
                continue

            if not table.rls_enabled:
                continue

            # 非 Token 认证（JWT/Session）时，仅在 rls_force=True 时应用
            if not self._rls_context.is_token_auth and not table.rls_force:
                continue

            fields = list(
                TableField.objects.using(DB_ALIAS)
                .filter(table_id=table_id, is_deleted=False)
            )
            qb = NativeQueryBuilder(
                space_id=resolve_schema_partition_id(table),
                table_id=table.id,
                fields=fields,
            )

            rls_where = rls_service.build_rls_where(
                table_id=table_id,
                operation=operation,
                context=self._rls_context,
                query_builder=qb,
            )
            if rls_where:
                sql, params = rls_where
                all_clauses.append(f'({sql})')
                all_params.extend(params)

        if not all_clauses:
            return None

        combined = ' AND '.join(all_clauses)
        return (combined, all_params)

    @staticmethod
    def _inject_rls_into_sql(
        sql: str,
        rls_where: str,
        rls_params: List[Any],
        existing_params: List[Any],
    ) -> Tuple[str, List[Any]]:
        """
        将 RLS WHERE 子句注入已解析的 SQL 语句。

        处理两种情况：
        1. 已有 WHERE → 追加 AND (rls_condition)
        2. 无 WHERE → 在 ORDER BY/GROUP BY/LIMIT 前插入 WHERE (rls_condition)

        通过括号深度计数器定位主查询层级的 WHERE，跳过子查询内的关键字。

        Args:
            sql: 已解析的 SQL 语句（内部标识符）
            rls_where: RLS WHERE SQL 片段
            rls_params: RLS 参数列表
            existing_params: 现有参数列表

        Returns:
            (modified_sql, modified_params)
        """
        out_params = list(existing_params)

        def _clause_end(fragment: str) -> Optional[int]:
            positions = [_find_main_keyword(fragment, kw) for kw in _CLAUSE_END_KEYWORDS]
            valid = [p for p in positions if p is not None]
            return min(valid) if valid else None

        where_pos = _find_main_keyword(sql, 'WHERE')

        if where_pos is not None:
            after_start = where_pos + 5  # len('WHERE')
            end_pos = _clause_end(sql[after_start:])
            if end_pos is not None:
                insert_pos = after_start + end_pos
            else:
                insert_pos = len(sql.rstrip().rstrip(';'))

            param_idx = sql[:insert_pos].count('%s')
            rls_clause = f' AND ({rls_where})'
            sql = sql[:insert_pos] + rls_clause + sql[insert_pos:]
        else:
            end_pos = _clause_end(sql)
            if end_pos is not None:
                insert_pos = end_pos
            else:
                insert_pos = len(sql.rstrip().rstrip(';'))

            param_idx = sql[:insert_pos].count('%s')
            rls_clause = f' WHERE ({rls_where}) '
            sql = sql[:insert_pos] + rls_clause + sql[insert_pos:]

        for i, p in enumerate(rls_params):
            out_params.insert(param_idx + i, p)

        return sql, out_params

    def _check_rls_for_insert(
        self,
        resolved_sql: str,
        exec_params: List[Any],
        affected_table_ids: Set[UUID],
    ) -> None:
        """
        RLS INSERT WITH CHECK — 校验 INSERT 数据是否满足 RLS 策略。

        对于 INSERT 语句，WHERE 注入没有意义（语法不支持），
        改为解析 INSERT 列名和 VALUES，构建 field->value 映射，
        然后调用 rls_service.check_rls_for_write 做 Python 侧检查。

        支持多行 INSERT (多个 VALUES 组) 并逐行校验。
        拒绝 INSERT...SELECT（无法静态检查行数据）。

        Raises:
            ForbiddenSQLError: 如果记录不满足 RLS 策略
        """
        from apps.tabdata.models import Table, TableField
        from apps.tabdata.native.query_builder import NativeQueryBuilder
        from apps.tabdata.services.rls_service import rls_service

        # 解析 INSERT 列名 — fail-closed：解析失败时拒绝执行
        col_match = _RE_INSERT_COLS.search(resolved_sql)
        if not col_match:
            raise ForbiddenSQLError(
                "Cannot parse INSERT column list for RLS validation; "
                "refusing to execute. Use explicit column list syntax: "
                "INSERT INTO table (col1, col2) VALUES (%s, %s)"
            )

        col_names = [c.strip().strip('"') for c in col_match.group(1).split(',')]

        # R2: 使用 finditer 匹配所有 VALUES 行（支持多行 INSERT）
        val_matches = list(_RE_INSERT_VALUES.finditer(resolved_sql))

        # R3: fail-closed — VALUES 解析失败时拒绝执行
        if not val_matches:
            if re.search(r'\bSELECT\b', resolved_sql, re.IGNORECASE):
                raise ForbiddenSQLError(
                    "INSERT...SELECT is not supported when RLS is enabled. "
                    "Use INSERT...VALUES instead."
                )
            raise ForbiddenSQLError(
                "Cannot parse INSERT VALUES for RLS validation; "
                "refusing to execute. Use explicit VALUES syntax: "
                "INSERT INTO table (col1, col2) VALUES (%s, %s)"
            )

        # R4 + R5: 为每个受影响的表预加载字段映射
        # 构建 column_hex → field_id 的多格式映射，以便 record_data 的 key
        # 能匹配 RLS 条件中使用的各种 field_id 格式
        table_field_maps: Dict[UUID, Dict[str, List[str]]] = {}
        table_qb_map: Dict[UUID, NativeQueryBuilder] = {}
        for table_id in affected_table_ids:
            fields = list(
                TableField.objects.using(DB_ALIAS).filter(
                    table_id=table_id, is_deleted=False
                )
            )
            col_to_field_refs: Dict[str, List[str]] = {}
            for f in fields:
                db_col = f.id.hex  # DDLManager.column_name returns field_id.hex
                # RLS conditions may reference fields by UUID string, hex, name, or api_name
                refs = [
                    str(f.id),     # UUID with dashes (e.g. "a1b2c3d4-...")
                    f.id.hex,      # UUID hex (e.g. "a1b2c3d4...")
                    f.name,        # display name
                ]
                if hasattr(f, 'api_name') and f.api_name:
                    refs.append(f.api_name)
                col_to_field_refs[db_col] = refs

            table_field_maps[table_id] = col_to_field_refs
            table_qb_map[table_id] = NativeQueryBuilder(
                space_id=self.space_id,
                table_id=table_id,
                fields=fields,
            )

        # R2: 逐行解析 VALUES 并校验 RLS
        for val_match in val_matches:
            val_tokens = [v.strip() for v in val_match.group(1).split(',')]

            # 构建 field→value 映射（仅处理 %s 参数化的值）
            param_cursor = 0
            # 计算此 VALUES 组之前有多少 %s（其他子句/之前行的参数）
            before_values = resolved_sql[:val_match.start()]
            param_offset = before_values.count('%s')

            record_data_raw: Dict[str, Any] = {}
            for i, token in enumerate(val_tokens):
                if i >= len(col_names):
                    break
                col_name = col_names[i]
                if '%s' in token:
                    param_idx = param_offset + param_cursor
                    if param_idx < len(exec_params):
                        record_data_raw[col_name] = exec_params[param_idx]
                    param_cursor += token.count('%s')
                else:
                    # 字面值（如数字/字符串常量）
                    cleaned = token.strip("'").strip()
                    record_data_raw[col_name] = cleaned

            if not record_data_raw:
                continue

            # R4 + R5: 对每个表，将 column hex key 转换为 RLS 条件可识别的 field_id
            for table_id in affected_table_ids:
                try:
                    table = Table.objects.using(DB_ALIAS).get(id=table_id)
                except Table.DoesNotExist:
                    continue

                if not table.rls_enabled:
                    continue

                if not self._rls_context.is_token_auth and not table.rls_force:
                    continue

                # 构建以所有可能的 field ref 为 key 的 record_data
                col_to_field_refs = table_field_maps.get(table_id, {})
                record_data_by_field_id: Dict[str, Any] = {}
                for col_name, value in record_data_raw.items():
                    stripped = col_name.strip('"')
                    refs = col_to_field_refs.get(stripped)
                    if refs:
                        # 添加所有可能的 field ref 格式，确保 RLS 条件可以匹配
                        for ref in refs:
                            record_data_by_field_id[ref] = value
                    else:
                        # 系统列或未匹配的列，保留原 key
                        record_data_by_field_id[stripped] = value

                qb = table_qb_map.get(table_id)
                if not rls_service.check_rls_for_write(
                    table_id=table_id,
                    operation='INSERT',
                    context=self._rls_context,
                    record_data=record_data_by_field_id,
                    query_builder=qb,
                ):
                    raise ForbiddenSQLError(
                        "INSERT data violates row-level security policy"
                    )

    # ──────────────────────────────────
    # ChangeLog 写入（AP-002）
    # ──────────────────────────────────

    def _write_change_log_for_write(
        self,
        sql_type: str,
        affected_table_ids: Set[UUID],
        affected_rows: int,
        inserted_ids: List[str],
        agent_run_id: str = "",
    ) -> None:
        """SQL 写操作后写入 VersionHistory + ChangeLog。

        AP-002 fix: execute_write 直接操作 tabdata DB，完全绕过 collab 体系，
        无任何版本记录。rollback_agent_run 无法感知 Agent SQL 修改。
        DV-003 + DV-016 fix: 支持显式 agent_run_id 传入，fallback 到 get_current_run_id。
        """
        if affected_rows <= 0:
            return

        try:
            from apps.services.common.platform_context import get_current_run_id, get_current_session_id
            from apps.collab.registry import get_adapter
            from apps.collab.service import VersionHistoryService
            from apps.collab.models import ChangeLog
            from django.db import transaction as db_tx

            effective_run_id = agent_run_id or get_current_run_id() or ""
            effective_session_id = get_current_session_id() or ""  # QC-05
            user_id = str(self.user.id) if self.user else ""

            adapter = get_adapter("table")
            if not adapter:
                return

            for table_id in affected_table_ids:
                try:
                    resource = adapter.get_resource(str(table_id))
                    if not resource:
                        continue

                    version_data = adapter.get_version_data(resource)
                    if version_data is None:
                        continue

                    editor_info = {
                        "editor_type": "agent",
                        "editor_id": user_id,
                        "editor_name": "",
                    }

                    # 截断快照 fallback：大表快照被截断时增量 diff 不可靠
                    is_truncated = (
                        isinstance(version_data, dict)
                        and version_data.get("is_truncated", False)
                    )

                    svc = VersionHistoryService(adapter)
                    organization_id = getattr(resource, "organization_id", None)

                    with db_tx.atomic(using="postgresql"):
                        vh = svc.create_history(
                            resource.id,
                            version_data,
                            editor_info,
                            force_snapshot=is_truncated,
                            skip_throttle=True,
                            organization_id=organization_id,
                        )

                        ChangeLog.objects.using("postgresql").create(
                            resource_type="table",
                            resource_id=resource.id,
                            change_type=f"sql_{sql_type.lower()}",
                            summary=f"Agent SQL {sql_type}: {affected_rows} rows",
                            changes={
                                "sql_type": sql_type,
                                "affected_rows": affected_rows,
                                "inserted_ids": inserted_ids[:50],
                            },
                            editor_type="agent",
                            editor_id=user_id,
                            version_history=vh,
                            agent_run_id=effective_run_id,
                            session_id=effective_session_id,
                        )
                except Exception as table_exc:
                    logger.warning(
                        "[AgentSQL] ChangeLog write failed for table=%s: %s",
                        table_id, table_exc,
                    )
        except Exception as exc:
            logger.warning("[AgentSQL] ChangeLog write failed: %s", exc)

    # ──────────────────────────────────
    # 执行入口
    # ──────────────────────────────────

    def execute_read(
        self,
        sql: str,
        params: Optional[List[Any]] = None,
    ) -> Dict[str, Any]:
        """
        执行只读 SQL 查询。

        Args:
            sql: SQL 查询语句（支持中文表名/字段名）
            params: 参数列表（用于 %s 占位符）

        Returns:
            {
                "columns": ["标题", "状态", ...],
                "rows": [["值1", "值2", ...], ...],
                "row_count": int,
                "name_mapping": {"中文名": "内部名", ...}
            }

        Raises:
            ForbiddenSQLError, SchemaViolationError, NameResolutionError, AgentSQLError
        """
        # 0. params 预处理（dict/list → json 字符串）
        params = self.prepare_params(params)

        # 0.5 sql_mode 策略校验（SQ-001/002/003 fix）
        from apps.services.common.sandbox_policy import validate_sql
        rejection = validate_sql(sql, self._sql_mode)
        if rejection:
            raise ForbiddenSQLError(rejection)

        # 1. 分类
        sql_type = self.classify_sql(sql)
        if sql_type != 'SELECT':
            raise ForbiddenSQLError("execute_read only supports SELECT queries")

        # 2. 名称解析
        resolved_sql, name_mapping = self.resolver.resolve_sql(sql)

        # 3. Schema + 白名单 + 禁止表验证
        self._validate_schema_restriction(resolved_sql)
        self._validate_table_whitelist(resolved_sql)
        self._validate_no_forbidden_tables(resolved_sql)

        # 3.5 RLS 行级安全策略注入
        if self._rls_context:
            table_ids = self.resolver.get_table_ids_from_sql(resolved_sql)
            rls_result = self._build_rls_where_for_tables(table_ids, 'SELECT')
            if rls_result:
                rls_sql, rls_params = rls_result
                resolved_sql, params = self._inject_rls_into_sql(
                    resolved_sql, rls_sql, rls_params, params or [],
                )
                logger.info("[AgentSQL] RLS WHERE injected for SELECT: %s", rls_sql[:200])

        # 4. 自动添加 LIMIT
        if not _RE_HAS_LIMIT.search(resolved_sql):
            resolved_sql = resolved_sql.rstrip().rstrip(';')
            resolved_sql += f' LIMIT {self.MAX_SELECT_ROWS}'

        # 5. 执行（纵深防御：在只读事务中执行，防止 sqlparse 分类漏洞）
        logger.info("[AgentSQL] READ: %s | params=%s", resolved_sql[:200], params)
        from django.db import transaction
        with transaction.atomic(using=self.db_alias):
            with connections[self.db_alias].cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")
                if params:
                    cursor.execute(resolved_sql, params)
                else:
                    cursor.execute(resolved_sql)
                columns = [desc[0] for desc in cursor.description] if cursor.description else []
                rows = cursor.fetchall()

        # 6. 列名反向映射（内部名 → 中文显示名）
        reverse_map: Dict[str, str] = {}
        for display, internal in name_mapping.items():
            clean = internal.strip('"')
            reverse_map[clean] = display

        # For SELECT * (or any unmapped columns): build a complete
        # column→display_name mapping from all tables referenced in the query.
        unmapped = [c for c in columns if c not in reverse_map and not c.startswith('__')]
        if unmapped:
            for tbl_meta in self.resolver.get_referenced_tables().values():
                for field_display, field_meta in tbl_meta.fields.items():
                    if field_meta.column_name not in reverse_map:
                        reverse_map[field_meta.column_name] = field_display

        # Map system columns (__created_at → created_at, etc.)
        for col in columns:
            if col.startswith('__') and col not in reverse_map:
                alias = _SYSTEM_FIELD_DISPLAY.get(col)
                if alias:
                    reverse_map[col] = alias

        display_columns = [reverse_map.get(c, c) for c in columns]

        return {
            "columns": display_columns,
            "rows": [list(row) for row in rows],
            "row_count": len(rows),
        }

    # ──────────────────────────────────
    # DV-002: RecordHistory 写入辅助
    # ──────────────────────────────────

    def _lock_table_fences(self, table_ids: Set[UUID]) -> None:
        """Lock every referenced table in stable order before a multi-table DELETE."""
        from apps.tabdata.models import Table

        list(
            Table.objects.using(self.db_alias)
            .select_for_update()
            .filter(id__in=sorted(table_ids, key=str))
            .order_by('id')
            .values_list('id', flat=True)
        )

    def _build_delete_before_state_query(
        self,
        resolved_sql: str,
        affected_table_ids: Set[UUID],
    ) -> Tuple[UUID, str]:
        """Rewrite DELETE into a SELECT that preserves its target alias and USING joins."""
        delete_match = re.match(r'^\s*DELETE\s+FROM\s+', resolved_sql, re.IGNORECASE)
        where_pos = _find_main_keyword(resolved_sql, 'WHERE')
        if delete_match is None or where_pos is None:
            raise AgentSQLError('Unable to capture DELETE target safely')

        using_pos = _find_main_keyword(resolved_sql, 'USING')
        if using_pos is not None and using_pos > where_pos:
            using_pos = None
        target_end = using_pos if using_pos is not None else where_pos
        target_clause = resolved_sql[delete_match.end():target_end].strip()
        target_match = re.fullmatch(
            r'(?P<relation>"[^"]+"\."[^"]+")'
            r'(?:\s+(?:AS\s+)?(?P<alias>"[^"]+"|[A-Za-z_][\w$]*))?',
            target_clause,
            re.IGNORECASE,
        )
        if target_match is None:
            raise AgentSQLError('Unsupported DELETE target syntax')

        target_relation = target_match.group('relation')
        target_ids = [
            table_id
            for table_id in affected_table_ids
            if DDLManager.qualified_table_name(self.space_id, table_id)
            == target_relation.replace('"', '')
        ]
        if len(target_ids) != 1:
            raise AgentSQLError('Unable to resolve the DELETE target table uniquely')

        projection = target_match.group('alias') or target_relation.rsplit('.', 1)[-1]
        from_clause = target_clause
        if using_pos is not None:
            using_clause = resolved_sql[using_pos + len('USING'):where_pos].strip()
            if not using_clause:
                raise AgentSQLError('DELETE USING clause is empty')
            from_clause = f'{from_clause}, {using_clause}'

        returning_pos = _find_main_keyword(resolved_sql, 'RETURNING')
        where_end = returning_pos if returning_pos is not None else len(resolved_sql)
        where_clause = resolved_sql[where_pos:where_end].strip().rstrip(';')
        select_sql = (
            f'SELECT DISTINCT ON ({projection}."__id") {projection}.* FROM {from_clause} '
            f'{where_clause} LIMIT {self.MAX_WRITE_ROWS + 1}'
        )
        return target_ids[0], select_sql

    def _capture_before_states(
        self,
        resolved_sql: str,
        exec_params: List[Any],
        sql_type: str,
        affected_table_ids: Set[UUID],
    ) -> Dict[UUID, Dict[str, Dict[str, Any]]]:
        """
        在 UPDATE/DELETE 执行前，通过解析 WHERE 子句回查即将受影响的行的当前状态。

        返回 {table_id: {record_id: {field_hex: value, ...}}} 映射。
        仅用于后续 RecordHistory 的 before/after diff。
        """
        before: Dict[UUID, Dict[str, Dict[str, Any]]] = {}

        try:
            where_pos = _find_main_keyword(resolved_sql, 'WHERE')
            if where_pos is None:
                return before

            where_clause = resolved_sql[where_pos:]
            trailing_match = re.search(
                r'\b(RETURNING|$)', where_clause, re.IGNORECASE,
            )
            if trailing_match:
                where_clause = where_clause[:trailing_match.start()].rstrip()

            set_end = resolved_sql[:where_pos]
            params_before_where = set_end.count('%s')
            where_params_count = where_clause.count('%s')
            where_params = exec_params[params_before_where:params_before_where + where_params_count]

            if sql_type == 'DELETE':
                table_id, select_sql = self._build_delete_before_state_query(
                    resolved_sql,
                    affected_table_ids,
                )
                capture_specs = [
                    (table_id, select_sql, exec_params[:select_sql.count('%s')]),
                ]
            else:
                capture_specs = [
                    (
                        table_id,
                        f'SELECT * FROM {DDLManager.qualified_table_name(self.space_id, table_id)} '
                        f'{where_clause} LIMIT {self.MAX_WRITE_ROWS}',
                        where_params,
                    )
                    for table_id in affected_table_ids
                ]

            for table_id, select_sql, capture_params in capture_specs:
                try:
                    with connections[self.db_alias].cursor() as cur:
                        cur.execute(select_sql, capture_params)
                        cols = [d[0] for d in cur.description] if cur.description else []
                        rows = cur.fetchall()
                    if sql_type == 'DELETE' and len(rows) > self.MAX_WRITE_ROWS:
                        raise WriteUnsafeError(
                            f'DELETE would affect more than {self.MAX_WRITE_ROWS} rows'
                        )
                    table_before: Dict[str, Dict[str, Any]] = {}
                    for row in rows:
                        row_dict = dict(zip(cols, row))
                        rid = str(row_dict.get('__id', ''))
                        if rid:
                            table_before[rid] = row_dict
                    if table_before:
                        before[table_id] = table_before
                except Exception as exc:
                    if sql_type == 'DELETE':
                        if isinstance(exc, AgentSQLError):
                            raise
                        raise AgentSQLError(
                            f'Unable to capture DELETE rows safely for table {table_id}'
                        ) from exc
                    logger.warning(
                        "[AgentSQL] before-state capture failed for table %s: %s",
                        table_id, exc,
                    )
        except Exception as exc:
            if sql_type == 'DELETE':
                if isinstance(exc, AgentSQLError):
                    raise
                raise AgentSQLError('Unable to capture DELETE rows safely') from exc
            logger.warning("[AgentSQL] before-state capture failed: %s", exc)

        return before

    def _capture_after_states(
        self,
        affected_table_ids: Set[UUID],
        allocated_version: int,
    ) -> Dict[UUID, Dict[str, Dict[str, Any]]]:
        """
        在 INSERT/UPDATE 执行后，从原生表回查受影响行的当前状态。

        通过 __version 匹配本次写入的行。
        返回 {table_id: {record_id: {column: value, ...}}}。
        """
        after: Dict[UUID, Dict[str, Dict[str, Any]]] = {}
        try:
            for table_id in affected_table_ids:
                fqn = DDLManager.qualified_table_name(self.space_id, table_id)
                select_sql = f'SELECT * FROM {fqn} WHERE "__version" = %s LIMIT {self.MAX_WRITE_ROWS}'
                try:
                    with connections[self.db_alias].cursor() as cur:
                        cur.execute(select_sql, [allocated_version])
                        cols = [d[0] for d in cur.description] if cur.description else []
                        rows = cur.fetchall()
                    table_after: Dict[str, Dict[str, Any]] = {}
                    for row in rows:
                        row_dict = dict(zip(cols, row))
                        rid = str(row_dict.get('__id', ''))
                        if rid:
                            table_after[rid] = row_dict
                    if table_after:
                        after[table_id] = table_after
                except Exception as exc:
                    logger.warning(
                        "[AgentSQL] after-state capture failed for table %s: %s",
                        table_id, exc,
                    )
        except Exception as exc:
            logger.warning("[AgentSQL] after-state capture failed: %s", exc)
        return after

    def _emit_record_history_for_write(
        self,
        sql_type: str,
        affected_table_ids: Set[UUID],
        allocated_version: int,
        before_states: Dict[UUID, Dict[str, Dict[str, Any]]],
        inserted_ids: List[str],
        affected_rows: int,
        operation_group_id: Optional[UUID] = None,
        agent_run_id: str = "",
    ) -> None:
        """
        DV-002 修复：为 Agent SQL 写入产生 RecordHistory 记录，使其对撤销/重做/历史审计可见。

        通过直接调用 emit_record_history_event，复用现有的 signal-listener 链路
        （RecordHistory 创建 + RecordHistoryItem 展开 + Undo 栈推送）。

        INSERT/UPDATE 路径从原生表回查数据（而非依赖 record.data），
        确保 field_changes 使用标准 {field: {old, new}} 格式。

        E2E-027: 当 agent_run_id 非空时，将其编码到 window_id（格式：agent_sql:{agent_run_id}），
        使 rollback_agent_run 能精确定位并标记这些 RecordHistory 为 is_undone=True。
        """
        from apps.tabdata.history_events import emit_record_history_event
        from apps.tabdata.models import TableRecord

        if affected_rows <= 0:
            return

        # E2E-027: window_id 编码 agent_run_id，供 rollback 精确过滤
        window_id = f"agent_sql:{agent_run_id}" if agent_run_id else "agent_sql"

        try:
            after_states: Dict[UUID, Dict[str, Dict[str, Any]]] = {}
            if sql_type in ('INSERT', 'UPDATE'):
                after_states = self._capture_after_states(
                    affected_table_ids, allocated_version,
                )

            for table_id in affected_table_ids:
                if sql_type == 'INSERT':
                    table_after = after_states.get(table_id, {})
                    for rid, row_data in table_after.items():
                        record = TableRecord.objects.using(DB_ALIAS).filter(id=rid).first()
                        if not record:
                            continue
                        field_changes = {
                            str(k): {'old': None, 'new': v}
                            for k, v in row_data.items()
                            if not str(k).startswith('__')
                        }
                        if not field_changes:
                            field_changes = {'_agent_sql': {'old': None, 'new': 'insert'}}
                        emit_record_history_event(
                            record=record,
                            action='create',
                            field_changes=field_changes,
                            user=self.user,
                            window_id=window_id,
                            operation_group_id=operation_group_id,
                            push_to_stack=False,
                            editor_type="agent",
                            sender=self.__class__,
                        )

                elif sql_type == 'UPDATE':
                    table_before = before_states.get(table_id, {})
                    table_after = after_states.get(table_id, {})
                    all_rids = set(table_before.keys()) | set(table_after.keys())
                    for rid in all_rids:
                        record = TableRecord.objects.using(DB_ALIAS).filter(id=rid).first()
                        if not record:
                            continue
                        old_row = table_before.get(rid, {})
                        new_row = table_after.get(rid, {})
                        field_changes = {}
                        all_keys = set(list(old_row.keys()) + list(new_row.keys()))
                        for k in all_keys:
                            if str(k).startswith('__'):
                                continue
                            old_val = old_row.get(k)
                            new_val = new_row.get(k)
                            if old_val != new_val:
                                field_changes[str(k)] = {'old': old_val, 'new': new_val}
                        if not field_changes:
                            field_changes = {'_agent_sql': {'old': None, 'new': 'update'}}
                        emit_record_history_event(
                            record=record,
                            action='update',
                            field_changes=field_changes,
                            user=self.user,
                            window_id=window_id,
                            operation_group_id=operation_group_id,
                            push_to_stack=False,
                            editor_type="agent",
                            sender=self.__class__,
                        )

                elif sql_type == 'DELETE':
                    table_before = before_states.get(table_id, {})
                    for rid, old_row in table_before.items():
                        record = TableRecord.objects.using(DB_ALIAS).filter(id=rid).first()
                        if record:
                            emit_record_history_event(
                                record=record,
                                action='delete',
                                field_changes={'_deleted': {'old': False, 'new': True}},
                                user=self.user,
                                window_id=window_id,
                                operation_group_id=operation_group_id,
                                push_to_stack=False,
                                editor_type="agent",
                                sender=self.__class__,
                            )

        except Exception as exc:
            logger.warning("[AgentSQL] RecordHistory emit failed (non-fatal): %s", exc, exc_info=True)

    # ──────────────────────────────────
    # 执行入口：写入
    # ──────────────────────────────────

    def execute_write(
        self,
        sql: str,
        params: Optional[List[Any]] = None,
        *,
        allow_delete: bool = False,
        agent_run_id: str = "",
    ) -> Dict[str, Any]:
        """
        执行写入 SQL 操作（INSERT/UPDATE/DELETE）。

        Args:
            sql: SQL 写入语句（支持中文表名/字段名）
            params: 参数列表
            allow_delete: 是否允许 DELETE（默认 False）
            agent_run_id: Agent Run ID（用于 ChangeLog 审计追踪）

        Returns:
            {
                "affected_rows": int,
                "sql_type": "INSERT" | "UPDATE" | "DELETE",
                "versions": {"table_id": version, ...}
            }

        Raises:
            ForbiddenSQLError, SchemaViolationError, WriteUnsafeError,
            NameResolutionError, AgentSQLError
        """
        # 0. params 预处理（dict/list → json 字符串）
        params = self.prepare_params(params)

        # 0.5 sql_mode 策略校验（SQ-001/002/003 fix）
        if self._sql_mode == "blocked":
            raise ForbiddenSQLError("SQL execution is blocked by security policy.")
        if self._sql_mode == "read_only":
            raise ForbiddenSQLError(
                "SQL mode is read_only; write operations are not allowed."
            )

        # 1. 分类
        sql_type = self.classify_sql(sql)
        if sql_type not in ('INSERT', 'UPDATE', 'DELETE'):
            raise ForbiddenSQLError("execute_write only supports INSERT/UPDATE/DELETE")

        # 2. 名称解析
        resolved_sql, name_mapping = self.resolver.resolve_sql(sql)

        # 3. Schema + 白名单 + 禁止表 + 写安全验证
        self._validate_schema_restriction(resolved_sql)
        self._validate_table_whitelist(resolved_sql)
        self._validate_no_forbidden_tables(resolved_sql)
        self._validate_write_safety(
            sql_type, resolved_sql, allow_delete=allow_delete
        )

        # 4. 提取受影响的表（白名单正向验证：写操作必须引用至少一个合法 Space 表）
        affected_table_ids = self.resolver.get_table_ids_from_sql(resolved_sql)
        if not affected_table_ids:
            raise SchemaViolationError(
                "No valid Space tables found in the SQL statement. "
                "Only Space-managed tables (created through TabData) can be modified."
            )

        # 4.5 FAR-013: 执行前预估影响行数，超出 MAX_WRITE_ROWS 时拒绝执行
        exec_params_for_estimate = list(params) if params else []
        self._estimate_affected_rows(
            resolved_sql, exec_params_for_estimate, sql_type, affected_table_ids
        )

        # 5. 预分配版本号，确保记录的 __version 与表级序列一致。
        # DELETE 必须延后到主事务内分配并持有 Table 行锁；否则它可能拿到 V，
        # 并发 UPDATE 提交 V+1 后才删除，导致删除水位落后于客户端 token。
        from apps.tabdata.services.record_service import next_record_version
        versions: Dict[str, int] = {}
        if sql_type != 'DELETE':
            for table_id in affected_table_ids:
                versions[str(table_id)] = next_record_version(table_id)

        # 取最大版本号注入 SQL（多表场景取最大值，保证所有记录版本可被增量查询命中）
        allocated_version = max(versions.values()) if versions else 1

        # 6. 注入写入元数据（使用预分配的绝对版本号，参数化）
        exec_params = list(params) if params else []
        if sql_type in ('INSERT', 'UPDATE'):
            resolved_sql, exec_params = self._inject_write_metadata(
                sql_type, resolved_sql, allocated_version, exec_params, affected_table_ids
            )

        # 6.5 RLS 行级安全策略注入（UPDATE/DELETE 追加 WHERE 限制）
        if self._rls_context and sql_type in ('UPDATE', 'DELETE'):
            rls_result = self._build_rls_where_for_tables(affected_table_ids, sql_type)
            if rls_result:
                rls_sql, rls_params = rls_result
                resolved_sql, exec_params = self._inject_rls_into_sql(
                    resolved_sql, rls_sql, rls_params, exec_params,
                )
                logger.info("[AgentSQL] RLS WHERE injected for %s: %s", sql_type, rls_sql[:200])

        # 6.6 RLS INSERT WITH CHECK（INSERT 无法用 WHERE，改为数据预检查）
        if self._rls_context and sql_type == 'INSERT':
            self._check_rls_for_insert(resolved_sql, exec_params, affected_table_ids)

        # USING/FROM 中的表只参与条件计算，不是写目标。DELETE 的版本、
        # ChangeLog 和通知必须只作用于被删目标表。
        write_table_ids = affected_table_ids
        if sql_type == 'DELETE':
            delete_target_id, _ = self._build_delete_before_state_query(
                resolved_sql,
                affected_table_ids,
            )
            write_table_ids = {delete_target_id}

        # DV-002: 在 UPDATE/DELETE 前捕获 before-state（用于 RecordHistory diff）
        before_states: Dict[UUID, Dict[str, Dict[str, Any]]] = {}
        if sql_type == 'UPDATE':
            before_states = self._capture_before_states(
                resolved_sql, exec_params, sql_type, affected_table_ids,
            )

        # 7. 执行（INSERT 时使用 RETURNING "__id" 获取新行 ID）
        logger.info(
            "[AgentSQL] WRITE(%s): %s | params=%s",
            sql_type, resolved_sql[:200], exec_params,
        )

        # DV-032 + DV-012: 主 SQL 和 Django model 同步在同一事务中
        operation_group_id = _uuid.uuid4()
        inserted_ids: List[str] = []
        with transaction.atomic(using=self.db_alias):
            if sql_type == 'DELETE':
                # Capture 和 DELETE 是两条 SQL；先冻结 target + USING 引用表，
                # 防止条件表在两者之间变化而让实际删除集合越过 before-state。
                self._lock_table_fences(affected_table_ids)
                for table_id in sorted(write_table_ids, key=str):
                    versions[str(table_id)] = next_record_version(table_id)
                allocated_version = max(versions.values()) if versions else 1
                before_states = self._capture_before_states(
                    resolved_sql, exec_params, sql_type, affected_table_ids,
                )

            with connections[self.db_alias].cursor() as cursor:
                exec_sql = resolved_sql
                if sql_type == 'INSERT' and 'RETURNING' not in resolved_sql.upper():
                    exec_sql = resolved_sql.rstrip().rstrip(';') + ' RETURNING "__id"'
                if exec_params:
                    cursor.execute(exec_sql, exec_params)
                else:
                    cursor.execute(exec_sql)
                affected_rows = cursor.rowcount
                if sql_type == 'INSERT' and cursor.description:
                    inserted_ids = [str(row[0]) for row in cursor.fetchall()]

            # FAR-016: INSERT 时必须先把 ORM 行 bulk_create 出来，否则后续
            # _sync_django_model_version 的 UPDATE 会找不到行（synced=0）、
            # _emit_record_history_for_write 的 ORM lookup 拿不到 record、
            # collab persist 的 existing_records 也匹配不上 → 数据丢失链。
            if sql_type == 'INSERT' and affected_rows > 0 and inserted_ids:
                self._create_django_records_for_insert(
                    affected_table_ids, allocated_version, inserted_ids,
                )

            # DV-012: 同步 Django model version 在同一事务内
            if sql_type in ('INSERT', 'UPDATE') and affected_rows > 0:
                self._sync_django_model_version(
                    affected_table_ids,
                    allocated_version,
                    sql_type=sql_type,
                    expected_count=len(inserted_ids) if sql_type == 'INSERT' else None,
                )

            # FAR-015: DELETE 后同步 is_deleted，消除幽灵记录
            if sql_type == 'DELETE' and affected_rows > 0:
                self._sync_django_model_delete(write_table_ids, before_states)
                from apps.tabdata.services.view_version_sync import mark_table_record_delete_version

                for table_id, deleted_rows in before_states.items():
                    table_version = versions.get(str(table_id))
                    if deleted_rows and table_version is not None:
                        mark_table_record_delete_version(
                            table_id=table_id,
                            version=table_version,
                            db_alias=self.db_alias,
                        )

            # E2E-004 fix: ChangeLog + VH 写入必须与主 SQL 在同一事务内，
            # 确保"主 SQL 成功 ↔ ChangeLog 存在"的原子性。
            # _write_change_log_for_write 内部使用 savepoint（db_tx.atomic），
            # 单个 table 写入失败只回滚该 savepoint，不影响主事务。
            if affected_rows > 0:
                self._write_change_log_for_write(
                    sql_type=sql_type,
                    affected_table_ids=write_table_ids,
                    affected_rows=affected_rows,
                    inserted_ids=inserted_ids,
                    agent_run_id=agent_run_id,
                )

        # DV-002: 为 Agent SQL 写入产生 RecordHistory（事务提交后）
        if affected_rows > 0:
            self._emit_record_history_for_write(
                sql_type=sql_type,
                affected_table_ids=write_table_ids,
                allocated_version=allocated_version,
                before_states=before_states,
                inserted_ids=inserted_ids,
                affected_rows=affected_rows,
                operation_group_id=operation_group_id,
                agent_run_id=agent_run_id,
            )

        # 9. 回查受影响记录 + WS 直推（避免前端额外 HTTP 增量拉取）
        logger.info(
            "[AgentSQL] 准备 WS 通知: tables=%s, versions=%s, allocated=%s",
            [str(t) for t in write_table_ids], versions, allocated_version,
        )
        try:
            from apps.tabdata.services.table_event_service import table_event_service

            for table_id in write_table_ids:
                version = versions.get(str(table_id), allocated_version)
                encoded_version = VERSION_TOKEN_BASE + version

                inline_records = None
                record_ids: Optional[List[str]] = None
                if sql_type in ('INSERT', 'UPDATE'):
                    inline_records, record_ids = self._fetch_affected_records(
                        table_id, allocated_version
                    )
                    logger.info(
                        "[AgentSQL] 回查结果: table=%s, records=%d, ids=%s",
                        table_id,
                        len(inline_records) if inline_records else 0,
                        len(record_ids) if record_ids else 0,
                    )

                published = table_event_service.publish_table_update(
                    str(table_id),
                    action=f"agent_sql_{sql_type.lower()}",
                    record_ids=record_ids,
                    metadata={
                        "source": "agent_sql",
                        "user_id": str(self.user.id) if self.user else None,
                        "affected_rows": affected_rows,
                    },
                    records=inline_records,
                    latest_version=encoded_version,
                )
                logger.info("[AgentSQL] WS 通知发送: table=%s, published=%s", table_id, published)
        except Exception as exc:
            logger.warning("[AgentSQL] WS 通知失败: %s", exc, exc_info=True)

        # 10. Y.Doc 同步：将受影响的行推送到 Y.Doc，供在线客户端实时看到
        # TBD-004: 移除 is_yjs_first_enabled feature flag 条件，
        # 无论 flag 状态都同步到 Y.Doc，否则新行不进入 rowOrder 导致前端丢行
        if sql_type in ('INSERT', 'UPDATE') and affected_rows > 0:
            try:
                self._sync_affected_to_ydoc(write_table_ids, allocated_version)
            except Exception as sync_err:
                logger.warning("[AgentSQL] Y.Doc sync failed (non-blocking): %s", sync_err)

        # 11. TBD-005: 通知 collab-live 更新 Y.Doc meta.version，
        # 防止后续 onStore 因 base_version 过期触发永久 conflict 循环
        if affected_rows > 0:
            try:
                from apps.collab.api import _invalidate_collab_version
                for table_id in write_table_ids:
                    version = versions.get(str(table_id), allocated_version)
                    encoded_version = VERSION_TOKEN_BASE + version
                    iv_result = _invalidate_collab_version(
                        "table", str(table_id), encoded_version,
                    )
                    if not iv_result.get("success"):
                        logger.warning(
                            "[AgentSQL] invalidate-version failed: table=%s version=%s",
                            table_id, encoded_version,
                        )
            except Exception as iv_err:
                logger.warning(
                    "[AgentSQL] invalidate-version error (non-blocking): %s", iv_err,
                )

        result = {
            "affected_rows": affected_rows,
            "sql_type": sql_type,
            "versions": versions,
        }

        return result
