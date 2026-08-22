"""
Agent SQL Name Resolver

Maps display table/field names to PostgreSQL internal identifiers
(schema-qualified table name + column hex).

Usage:
    resolver = NameResolver(space_id)
    resolved_sql, mapping = resolver.resolve_sql(
        'SELECT "task", "status" FROM "task_list" WHERE "priority" > %s'
    )
    # resolved_sql -> 'SELECT "a1b2c3d4...", "e5f6..." FROM "as_xxx"."tbl_yyy" WHERE "f7g8..." = %s'
"""

import logging
import re
import threading
import time as _time
from dataclasses import dataclass, field as dc_field
from typing import Dict, List, Optional, Set, Tuple
from uuid import UUID

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.pg_type_map import SYSTEM_COLUMNS, SYSTEM_COLUMN_FIELD_TYPES

logger = logging.getLogger(__name__)


# ──────────────────────────────────
# Exceptions
# ──────────────────────────────────

class NameResolutionError(Exception):
    """Base exception for name resolution failures."""
    pass


class TableNotFoundError(NameResolutionError):
    """Table name not found in the Space."""
    pass


class FieldNotFoundError(NameResolutionError):
    """Field name not found in the table."""
    pass


class AmbiguousFieldError(NameResolutionError):
    """Field name exists in multiple tables; use "table"."field" to disambiguate."""
    pass


# ──────────────────────────────────
# System field aliases
# ──────────────────────────────────

SYSTEM_FIELD_ALIASES: Dict[str, str] = {
    # English aliases (primary)
    "created_at": "__created_at",
    "updated_at": "__updated_at",
    "created_by": "__created_by",
    "updated_by": "__updated_by",
    "ID": "__id",
    "id": "__id",
    "auto_number": "__auto_number",
    "order": "__order",
    "version": "__version",
    # Chinese aliases (backward-compatible)
    "创建时间": "__created_at",
    "更新时间": "__updated_at",
    "创建者": "__created_by",
    "更新者": "__updated_by",
    "序号": "__auto_number",
    "排序": "__order",
    "版本": "__version",
}

# Reverse mapping: system column → display alias (for catalog display)
_SYSTEM_FIELD_DISPLAY: Dict[str, str] = {
    "__created_at": "created_at",
    "__updated_at": "updated_at",
    "__created_by": "created_by",
    "__updated_by": "updated_by",
    "__id": "id",
    "__auto_number": "auto_number",
    "__order": "order",
    "__version": "version",
}


# ──────────────────────────────────
# Data structures
# ──────────────────────────────────

@dataclass
class FieldMeta:
    field_id: UUID
    name: str          # Display name
    field_type: str
    column_name: str   # UUID hex, actual PG column name


@dataclass
class TableMeta:
    table_id: UUID
    name: str              # Display name
    schema_name: str       # "as_{hex}"
    table_name: str        # "tbl_{hex}"
    qualified_name: str    # '"as_xxx"."tbl_yyy"'
    fields: Dict[str, FieldMeta] = dc_field(default_factory=dict)  # display_name → FieldMeta


# ──────────────────────────────────
# Regex: match identifiers inside double-quotes / backticks
# ──────────────────────────────────

# Match "table"."field" dot-qualified form
_RE_DOT_QUALIFIED = re.compile(
    r'"([^"]+)"\s*\.\s*"([^"]+)"'
    r'|'
    r'`([^`]+)`\s*\.\s*`([^`]+)`'
)

# Match single quoted identifiers
_RE_QUOTED_IDENT = re.compile(
    r'"([^"]+)"'
    r'|'
    r'`([^`]+)`'
)

# Match resolved tbl_{32hex} pattern (to extract table IDs from resolved SQL)
_RE_TBL_HEX = re.compile(r'tbl_([0-9a-f]{32})')

_SQL_RESERVED = frozenset({
    'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
    'true', 'false', 'as', 'on', 'join', 'left', 'right', 'inner', 'outer',
    'cross', 'full', 'natural', 'using',
    'group', 'order', 'by', 'having', 'limit', 'offset', 'union', 'except',
    'intersect', 'all', 'any', 'some',
    'insert', 'update', 'delete', 'set', 'values', 'into',
    'create', 'drop', 'alter', 'table', 'index', 'view', 'schema',
    'between', 'like', 'ilike', 'similar', 'exists',
    'case', 'when', 'then', 'else', 'end',
    'cast', 'coalesce', 'nullif', 'greatest', 'least',
    'count', 'sum', 'avg', 'min', 'max', 'distinct',
    'asc', 'desc', 'with', 'recursive', 'returning',
    'primary', 'key', 'foreign', 'references', 'constraint', 'default',
    'check', 'unique', 'cascade', 'restrict',
    'begin', 'commit', 'rollback', 'savepoint',
    'grant', 'revoke',
})


class NameResolver:
    """
    SQL Name Resolver — maps display table/field names to PostgreSQL internal identifiers.
    """

    def __init__(self, space_id: UUID):
        self.space_id = space_id
        self._table_cache: Dict[str, TableMeta] = {}      # display_name → TableMeta
        self._table_id_cache: Dict[UUID, TableMeta] = {}   # table_id → TableMeta
        self._referenced_tables: Dict[str, TableMeta] = {} # populated by resolve_sql
        self._load_metadata()

    # ──────────────────────────────────
    # Metadata loading
    # ──────────────────────────────────

    def _load_metadata(self) -> None:
        """Load all table and field metadata for the schema partition.

        ``self.space_id`` 实际是 schema 分区 ID（Space 或 Organization，见
        ``resolve_schema_partition_id``）。#6603 org-only 表 ``space_id`` 为空、
        分区为 ``organization_id``，因此除 ``space_id=partition`` 外还要加载
        ``space_id IS NULL AND organization_id=partition`` 的表。
        """
        from django.db.models import Q

        from apps.tabdata.models import Table, TableField

        schema = DDLManager.schema_name(self.space_id)

        tables = Table.objects.using(TABDATA_DB_ALIAS).filter(
            Q(space_id=self.space_id)
            | Q(space_id__isnull=True, organization_id=self.space_id),
            is_archived=False,
            trashed_at__isnull=True,
        ).values_list('id', 'name')

        for table_id, table_name in tables:
            tbl_name = DDLManager.table_name(table_id)
            qualified = f'"{schema}"."{tbl_name}"'
            meta = TableMeta(
                table_id=table_id,
                name=table_name,
                schema_name=schema,
                table_name=tbl_name,
                qualified_name=qualified,
            )
            self._table_cache[table_name] = meta
            self._table_id_cache[table_id] = meta

        # Batch-load all fields
        table_ids = list(self._table_id_cache.keys())
        if not table_ids:
            return

        fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id__in=table_ids,
            is_deleted=False,
        ).values_list('id', 'table_id', 'name', 'field_type')

        for field_id, table_id, field_name, field_type in fields:
            table_meta = self._table_id_cache.get(table_id)
            if not table_meta:
                continue
            # System fields (created_time etc.) map to system columns; skip as user fields
            sys_col = SYSTEM_COLUMN_FIELD_TYPES.get(field_type)
            if sys_col:
                continue
            col_name = DDLManager.column_name(field_id)
            table_meta.fields[field_name] = FieldMeta(
                field_id=field_id,
                name=field_name,
                field_type=field_type,
                column_name=col_name,
            )

    # ──────────────────────────────────
    # Single-item resolution
    # ──────────────────────────────────

    def resolve_table(self, display_name: str) -> str:
        """
        Display table name → schema-qualified PG name.

        Returns:
            '"as_xxx"."tbl_yyy"'

        Raises:
            TableNotFoundError
        """
        meta = self._table_cache.get(display_name)
        if not meta:
            available = ', '.join(sorted(self._table_cache.keys())[:10])
            raise TableNotFoundError(
                f"Table '{display_name}' not found in the Space. Available tables: {available}"
            )
        return meta.qualified_name

    def resolve_field(self, table_name: str, display_name: str) -> str:
        """
        Display field name → quoted PG column name.

        Supports system field aliases (created_at → "__created_at").

        Returns:
            '"column_hex"' or '"__system_col"'

        Raises:
            TableNotFoundError, FieldNotFoundError
        """
        # System field aliases
        sys_col = SYSTEM_FIELD_ALIASES.get(display_name)
        if sys_col:
            return f'"{sys_col}"'

        # Direct system column names
        if display_name.startswith('__') and display_name in SYSTEM_COLUMNS:
            return f'"{display_name}"'

        table_meta = self._table_cache.get(table_name)
        if not table_meta:
            raise TableNotFoundError(f"Table '{table_name}' not found in the Space")

        field_meta = table_meta.fields.get(display_name)
        if not field_meta:
            available = ', '.join(sorted(table_meta.fields.keys())[:10])
            raise FieldNotFoundError(
                f"Field '{display_name}' not found in table '{table_name}'. Available fields: {available}"
            )
        return f'"{field_meta.column_name}"'

    # ──────────────────────────────────
    # Full SQL resolution
    # ──────────────────────────────────

    def resolve_sql(self, sql: str) -> Tuple[str, Dict[str, str]]:
        """
        Resolve display table/field names in SQL to internal PG identifiers.

        Supports:
        - Double-quotes: "table", "field"
        - Backticks: `table`, `field`
        - Dot-qualified: "table"."field"

        Returns:
            (resolved_sql, name_mapping)
            name_mapping: {"task_list": '"as_xxx"."tbl_yyy"', "status": '"col_hex"', ...}

        Raises:
            NameResolutionError subclasses
        """
        name_mapping: Dict[str, str] = {}
        referenced_tables: Dict[str, TableMeta] = {}

        # Pass 1: Handle "table"."field" dot-qualified form
        def _replace_dot_qualified(m: re.Match) -> str:
            tbl_name = m.group(1) or m.group(3)
            fld_name = m.group(2) or m.group(4)

            table_meta = self._table_cache.get(tbl_name)
            if not table_meta:
                # Not a known table name, return as-is
                return m.group(0)

            referenced_tables[tbl_name] = table_meta
            name_mapping[tbl_name] = table_meta.qualified_name

            resolved_field = self.resolve_field(tbl_name, fld_name)
            name_mapping[fld_name] = resolved_field

            return f'{table_meta.qualified_name}.{resolved_field}'

        sql = _RE_DOT_QUALIFIED.sub(_replace_dot_qualified, sql)

        # Pass 2: Handle standalone quoted identifiers (tables first, then fields)
        # Two sub-passes needed: replace all table names first, then field names

        # Pass 2a: Replace table names
        def _replace_table_name(m: re.Match) -> str:
            ident = m.group(1) or m.group(2)
            if not ident:
                return m.group(0)

            table_meta = self._table_cache.get(ident)
            if table_meta:
                referenced_tables[ident] = table_meta
                name_mapping[ident] = table_meta.qualified_name
                return table_meta.qualified_name
            return m.group(0)

        sql = _RE_QUOTED_IDENT.sub(_replace_table_name, sql)

        # Pass 2b: Replace field names
        # Table names are now resolved to "as_xxx"."tbl_yyy" form;
        # remaining quoted identifiers are attempted as field names

        def _replace_field_name(m: re.Match) -> str:
            ident = m.group(1) or m.group(2)
            if not ident:
                return m.group(0)

            # Skip already-internal identifiers
            if ident.startswith('as_') or ident.startswith('tbl_') or ident.startswith('__'):
                return m.group(0)
            # Skip pure hex strings (already column names)
            if re.fullmatch(r'[0-9a-f]{32}', ident):
                return m.group(0)

            # System field aliases
            sys_col = SYSTEM_FIELD_ALIASES.get(ident)
            if sys_col:
                name_mapping[ident] = f'"{sys_col}"'
                return f'"{sys_col}"'

            # Search in referenced tables first
            found_in: List[Tuple[str, FieldMeta]] = []
            for tbl_name, tbl_meta in referenced_tables.items():
                field_meta = tbl_meta.fields.get(ident)
                if field_meta:
                    found_in.append((tbl_name, field_meta))

            # If not found in referenced tables, search all tables
            if not found_in:
                for tbl_name, tbl_meta in self._table_cache.items():
                    field_meta = tbl_meta.fields.get(ident)
                    if field_meta:
                        found_in.append((tbl_name, field_meta))
                        referenced_tables[tbl_name] = tbl_meta

            if len(found_in) == 0:
                # Not a known field name, return as-is (could be SQL keyword or other identifier)
                return m.group(0)
            if len(found_in) > 1:
                tables_str = ', '.join(t[0] for t in found_in)
                raise AmbiguousFieldError(
                    f"Field '{ident}' exists in multiple tables: {tables_str}. "
                    f"Please use \"table\".\"field\" to disambiguate."
                )

            _, field_meta = found_in[0]
            resolved = f'"{field_meta.column_name}"'
            name_mapping[ident] = resolved
            return resolved

        sql = _RE_QUOTED_IDENT.sub(_replace_field_name, sql)

        # Pass 3: Unquoted identifier resolution
        # Handles CJK and other Unicode identifiers written without quotes
        sql = self._resolve_unquoted_identifiers(sql, referenced_tables, name_mapping)

        self._referenced_tables = referenced_tables
        return sql, name_mapping

    def _resolve_unquoted_identifiers(
        self,
        sql: str,
        referenced_tables: Dict[str, "TableMeta"],
        name_mapping: Dict[str, str],
    ) -> str:
        """Resolve unquoted table and field identifiers in SQL.

        Splits SQL into quoted/unquoted segments to avoid modifying
        string literals or already-resolved identifiers.
        """
        segments = re.split(r"""('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")""", sql)

        # Step 1: Unquoted table names (only after FROM/JOIN/INTO/UPDATE)
        unresolved_tables = {
            name: meta for name, meta in self._table_cache.items()
            if name not in name_mapping
        }
        if unresolved_tables:
            sorted_names = sorted(unresolved_tables, key=len, reverse=True)
            for i in range(0, len(segments), 2):
                part = segments[i]
                for tname in sorted_names:
                    meta = unresolved_tables[tname]
                    pattern = re.compile(
                        r'(\bFROM\s+|\bJOIN\s+|\bINTO\s+|\bUPDATE\s+)'
                        + re.escape(tname)
                        + r'(?![\w])',
                        re.IGNORECASE,
                    )
                    new_part = pattern.sub(lambda m, qn=meta.qualified_name: m.group(1) + qn, part)
                    if new_part != part:
                        referenced_tables[tname] = meta
                        name_mapping[tname] = meta.qualified_name
                        part = new_part
                segments[i] = part
            sql = ''.join(segments)
            segments = re.split(r"""('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")""", sql)

        # Step 2: Unquoted field names
        field_lookup: Dict[str, str] = {}
        ambiguous: Set[str] = set()
        for tbl_meta in referenced_tables.values():
            for fname, fmeta in tbl_meta.fields.items():
                if fname in ambiguous:
                    continue
                if fname in field_lookup:
                    ambiguous.add(fname)
                    del field_lookup[fname]
                    continue
                field_lookup[fname] = f'"{fmeta.column_name}"'
        for alias, sys_col in SYSTEM_FIELD_ALIASES.items():
            if alias not in field_lookup and alias not in ambiguous:
                field_lookup[alias] = f'"{sys_col}"'

        if not field_lookup:
            return ''.join(segments)

        sorted_names = sorted(field_lookup, key=len, reverse=True)
        for i in range(0, len(segments), 2):
            part = segments[i]
            for fname in sorted_names:
                if fname.lower() in _SQL_RESERVED:
                    continue
                resolved = field_lookup[fname]
                pattern = re.compile(r'(?<![.\w])' + re.escape(fname) + r'(?![\w])')
                new_part = pattern.sub(resolved, part)
                if new_part != part:
                    name_mapping[fname] = resolved
                    part = new_part
            segments[i] = part

        return ''.join(segments)

    # ──────────────────────────────────
    # Catalog building
    # ──────────────────────────────────

    def build_catalog(
        self,
        space_id: UUID,
        *,
        table_name: Optional[str] = None,
        compact: bool = True,
        allowed_table_ids: Optional[set] = None,
    ) -> str | Dict:
        """Build Space table/field catalog for Agent.

        Args:
            space_id: Space UUID.
            table_name: If given, only return schema for this table (like
                Cursor searching a specific directory instead of the whole repo).
            compact: If True (default), return a compact Markdown string that
                is ~10-20x smaller than the full JSON. The LLM can read it
                directly; no parsing needed.
            allowed_table_ids: 历史 object_scope 白名单，
                None 表示不限制，非空 set 则只保留白名单内的表。

        Returns:
            compact=True  → Markdown string (token-efficient)
            compact=False → Legacy dict (backward compat)
        """
        if not compact:
            return self._build_catalog_dict(
                space_id, table_name=table_name, allowed_table_ids=allowed_table_ids,
            )
        return self._build_catalog_compact(
            space_id, table_name=table_name, allowed_table_ids=allowed_table_ids,
        )

    _CATALOG_SUMMARY_THRESHOLD = 30

    def _build_catalog_compact(
        self, space_id: UUID, *, table_name: Optional[str] = None,
        allowed_table_ids: Optional[set] = None,
    ) -> str:
        """Token-efficient Markdown catalog.

        - Return compact field listings, not verbose JSON with internal_name UUIDs.
        - internal_name is omitted — the SQL name resolver handles
          display→internal mapping transparently.
        - System fields listed once, not repeated per table.

        When table_name is omitted and the Space has more than
        ``_CATALOG_SUMMARY_THRESHOLD`` tables, automatically switches to
        a summary-only format (table name + field count) to avoid
        blowing up token budgets.
        """
        if table_name and table_name in self._table_cache:
            meta = self._table_cache[table_name]
            if allowed_table_ids is not None and meta.table_id not in allowed_table_ids:
                return f"Table '{table_name}' is not accessible in current sharing scope."
            target_metas = [meta]
        elif table_name and table_name not in self._table_cache:
            all_names = ", ".join(self._table_cache.keys())
            return f"Table '{table_name}' not found. Available: {all_names}"
        else:
            target_metas = list(self._table_cache.values())
            if allowed_table_ids is not None:
                target_metas = [m for m in target_metas if m.table_id in allowed_table_ids]

        if not table_name and len(target_metas) > self._CATALOG_SUMMARY_THRESHOLD:
            return self._build_catalog_summary(space_id, target_metas)

        lines: list[str] = [f"# Catalog (space: {space_id})"]

        sys_line = ", ".join(
            f"{_SYSTEM_FIELD_DISPLAY.get(c, c)}({t.split()[0]})"
            for c, t in SYSTEM_COLUMNS.items()
        )
        lines.append(f"\nSystem fields (every table): {sys_line}")

        for table_meta in target_metas:
            field_parts = [
                f"{fm.name}({fm.field_type})"
                for fm in table_meta.fields.values()
            ]
            lines.append(f"\n## {table_meta.name}")
            lines.append(f"Fields: {', '.join(field_parts) or '(none)'}")

        return "\n".join(lines)

    def _build_catalog_summary(
        self, space_id: UUID, metas: list,
    ) -> str:
        """Summary-only catalog for Spaces with many tables.

        Returns table names and field counts instead of full field
        listings, keeping output compact.
        """
        total = len(metas)
        lines: list[str] = [
            f"# Catalog Summary (space: {space_id}) — {total} tables",
            "",
            "| Table | Fields |",
            "|-------|--------|",
        ]
        for tm in metas:
            lines.append(f"| {tm.name} | {len(tm.fields)} |")

        lines.append("")
        lines.append(
            "Tip: Use sql_catalog(table_name=\"<name>\") to get "
            "full field details for a specific table."
        )
        return "\n".join(lines)

    def _build_catalog_dict(
        self, space_id: UUID, *, table_name: Optional[str] = None,
        allowed_table_ids: Optional[set] = None,
    ) -> Dict:
        """Legacy JSON catalog (backward compat)."""
        tables_out = []
        target_metas = (
            [self._table_cache[table_name]]
            if table_name and table_name in self._table_cache
            else self._table_cache.values()
        )
        if allowed_table_ids is not None:
            target_metas = [m for m in target_metas if m.table_id in allowed_table_ids]
        for table_meta in target_metas:
            fields_out = [
                {
                    "name": fm.name,
                    "type": fm.field_type,
                    "internal_name": fm.column_name,
                }
                for fm in table_meta.fields.values()
            ]
            system_fields = [
                {
                    "name": col_name,
                    "type": col_type.split()[0],
                    "alias": _SYSTEM_FIELD_DISPLAY.get(col_name, col_name),
                }
                for col_name, col_type in SYSTEM_COLUMNS.items()
            ]
            tables_out.append({
                "name": table_meta.name,
                "internal_name": f"{table_meta.schema_name}.{table_meta.table_name}",
                "fields": fields_out,
                "system_fields": system_fields,
            })
        return {"space_id": str(space_id), "tables": tables_out}

    # ──────────────────────────────────
    # Helpers
    # ──────────────────────────────────

    def get_table_ids_from_sql(self, resolved_sql: str) -> Set[UUID]:
        """
        Extract all referenced table UUIDs from resolved SQL.

        Matches the tbl_{32hex} pattern to recover table_id.
        """
        result: Set[UUID] = set()
        for match in _RE_TBL_HEX.finditer(resolved_sql):
            hex_str = match.group(1)
            try:
                result.add(UUID(hex_str))
            except ValueError:
                continue
        return result

    def get_referenced_tables(self) -> Dict[str, "TableMeta"]:
        """Return tables referenced by the last ``resolve_sql`` call.

        Useful for building a complete column→display_name reverse map
        (e.g. for ``SELECT *`` where no field names appear in the SQL).
        """
        return dict(self._referenced_tables)

    def get_table_meta(self, display_name: str) -> Optional[TableMeta]:
        """Get table metadata without raising exceptions."""
        return self._table_cache.get(display_name)

    def get_all_table_names(self) -> List[str]:
        """Get all display table names in the Space."""
        return sorted(self._table_cache.keys())


# ──────────────────────────────────
# Module-level resolver cache
# ──────────────────────────────────
# Avoids re-creating NameResolver (and its 2 DB queries) on every
# SQL tool call within the same conversation / request burst.

_RESOLVER_CACHE_TTL = 300  # 5 minutes
_resolver_cache: Dict[UUID, Tuple["NameResolver", float]] = {}
_resolver_cache_lock = threading.Lock()
_RESOLVER_CACHE_MAX = 20


def get_resolver(space_id: UUID) -> "NameResolver":
    """Get a cached NameResolver instance for the given space.

    Reuses the same resolver for up to 5 minutes, avoiding repeated
    DB queries for table/field metadata.  Thread-safe.
    """
    now = _time.time()
    with _resolver_cache_lock:
        cached = _resolver_cache.get(space_id)
        if cached:
            resolver, ts = cached
            if (now - ts) < _RESOLVER_CACHE_TTL:
                return resolver

    resolver = NameResolver(space_id)

    with _resolver_cache_lock:
        _resolver_cache[space_id] = (resolver, now)
        if len(_resolver_cache) > _RESOLVER_CACHE_MAX:
            oldest_key = min(_resolver_cache, key=lambda k: _resolver_cache[k][1])
            del _resolver_cache[oldest_key]

    return resolver


def invalidate_resolver(space_id: Optional[UUID] = None) -> None:
    """Invalidate cached resolver(s).

    Call this after schema changes (add/remove table or field) to
    ensure the next resolve picks up fresh metadata.

    Args:
        space_id: Specific space to invalidate, or None to clear all.
    """
    with _resolver_cache_lock:
        if space_id is None:
            _resolver_cache.clear()
        else:
            _resolver_cache.pop(space_id, None)
