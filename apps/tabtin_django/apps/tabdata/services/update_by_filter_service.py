"""A3 update-by-filter 服务

两段式执行:preflight(预检 + 签发 confirm_token) → commit(校验 + 原子更新 +
cascade + checkpoint anchor)。

W0-5 设计稿 + W2.perf 性能优化 + W2.perf 三视角 Review fix2 实施。

W2.perf-fix2(三视角 Review)修复要点:
- (产品 P0-1)Checkpoint anchor 改用 ``DaemonCheckpointService.maybe_checkpoint_commit``
  并兜底降级,不再调用不存在的 ``request_anchor``。
- (产品 P0-3 / 用户 P0-3)preflight 与 commit 入口均强制 ``check_table_permission(editor)``。
- (产品 P1-1)``table_version`` schema 防护改用 ``Table.record_version_seq``,
  避免依赖不存在的 ``Table.version`` 字段。
- (用户 P0-4)空 ``filter_clause`` 直接拒绝(对齐 PRD §A3 line 303 强制约束)。
- (用户 P0-6)空 ``patch`` 直接拒绝,避免后续 drift_too_large 误导文案。
- (用户 P0-7)归档 / 已 trash 的 table 直接拒绝。
- (技术 P0-1)commit 内补 link title 传播。
- (技术 P0-2)patch / filter key 全部归一化为 ``str(field.id)``;未知字段拒绝;
  link/attachment/file/computed/skill 等字段拒绝。
- (技术 P0-3 / L32)``_native_update_by_filter`` 改名为 ``_orm_jsonb_update_by_filter``,
  docstring 明示操作 ORM 表(JSONB),native 物理列存通过 ``_sync_native_table`` 兜底。
- (技术 P1-5)operation_group_id 用独立 ``uuid4()``,不再复用 nonce。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID, uuid4

from django.conf import settings
from django.db import connections, transaction

from apps.tabdata.constants import FILE_BASED_FIELD_TYPES, SYSTEM_MANAGED_FIELD_TYPES
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.exceptions import (
    ConfirmTokenDriftTooLarge,
    ConfirmTokenFilterChanged,
    ConfirmTokenMatchTooLarge,
    ConfirmTokenPatchChanged,
    ConfirmTokenPermissionChanged,  # noqa: F401 — re-exported for test patching
    ConfirmTokenPreviouslyFailed,
    ConfirmTokenReplayDetected,
    ConfirmTokenSpaceMismatch,
    ConfirmTokenTableChanged,
    ConfirmTokenTableMismatch,
    ConfirmTokenUserMismatch,
)
from apps.tabdata.services.base import BaseService
from apps.tabdata.services.confirm_token import (
    ConfirmTokenPayload,
    get_nonce_state,
    issue_confirm_token,
    mark_nonce_failed,
    mark_nonce_used,
    reserve_nonce,
    sha256_hex,
    verify_confirm_token_signature,
)

logger = logging.getLogger(__name__)

TABDATA_DB_ALIAS = "postgresql"

# A3 不允许的字段类型集合 — link/attachment/file/managed 字段必须走单条编辑
# 与 PRD §A3 "仅支持简单 cell 字段(text/number/select/date/checkbox/url/email/
# phone/longtext)" 对齐。
_A3_DISALLOWED_FIELD_TYPES = frozenset(
    {'link'}
    | FILE_BASED_FIELD_TYPES
    | SYSTEM_MANAGED_FIELD_TYPES
)


class A3PreflightError(Exception):
    """A3 preflight 阶段的业务错误,API 层捕获后映射为 4xx 响应。"""

    def __init__(self, code: str, **context: Any):
        self.code = code
        self.context = context
        super().__init__(code)


class UpdateByFilterService(BaseService):
    """A3 update-by-filter 两段式服务。"""

    def __init__(self, user, space_id: str = ""):
        super().__init__(user=user)
        self.space_id = space_id

    # ── preflight ─────────────────────────────────────────────────

    def preflight(
        self,
        table_id: str,
        filter_clause: Dict[str, Any],
        patch: Dict[str, Any],
    ) -> Dict[str, Any]:
        """预检:统计影响行数 + 采样 + 签发 confirm_token。

        校验顺序(快路径在前):
        1. patch / filter 非空(避免误改全表 + 后续 drift 误导)
        2. table 存在 + 未归档 + 未 trash
        3. 当前用户对该 table 有 ``editor`` 权限
        4. patch / filter 字段 key 归一化(name → field.id),未知字段 / 不支持类型拒绝
        5. native COUNT + sample
        """
        from apps.tabdata.models import Table

        if not filter_clause:
            raise A3PreflightError(ErrorCode.A3_PREFLIGHT_EMPTY_FILTER)
        if not patch:
            raise A3PreflightError(ErrorCode.A3_PREFLIGHT_EMPTY_PATCH)

        hard_limit = getattr(settings, 'TABDATA_A3_HARD_LIMIT', 10000)

        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
        if not table:
            raise A3PreflightError(ErrorCode.TABLE_NOT_FOUND)
        if table.is_archived or getattr(table, 'trashed_at', None) is not None:
            raise A3PreflightError(ErrorCode.A3_PREFLIGHT_TABLE_ARCHIVED)

        if not self.check_table_permission(str(table_id), 'editor'):
            raise PermissionError(ErrorCode.PERMISSION_DENIED)

        normalized_filter = self._normalize_field_keys(table_id, filter_clause)
        normalized_patch = self._normalize_patch_keys(table_id, patch)

        matched_total, sample_records = self._count_and_sample(
            table_id, normalized_filter, limit=20,
        )

        if matched_total > hard_limit:
            raise ConfirmTokenMatchTooLarge(
                matched_total=matched_total, hard_limit=hard_limit,
            )

        is_agent = self._is_agent_request()
        token_str, payload = issue_confirm_token(
            user_id=str(self.user.id),
            space_id=self.space_id,
            table_id=table_id,
            table_version=self._resolve_table_version(table),
            filter_clause=normalized_filter,
            patch=normalized_patch,
            matched_total=matched_total,
            is_agent=is_agent,
        )

        return {
            "matched_total": matched_total,
            "sample_records": sample_records,
            "confirm_token": token_str,
            "estimated_duration_ms": self._estimate_duration(matched_total),
            "requires_checkpoint": payload.requires_checkpoint_anchor,
            "normalized_filter": normalized_filter,
            "normalized_patch": normalized_patch,
        }

    # ── commit ────────────────────────────────────────────────────

    def commit(
        self,
        table_id: str,
        confirm_token: str,
        filter_clause: Dict[str, Any],
        patch: Dict[str, Any],
    ) -> Tuple[int, Dict[str, Any]]:
        """提交更新:校验 token → 占位 nonce → 原子更新 → cascade → 写 RH → anchor。

        Returns:
            (http_status, response_dict)
        """
        from apps.tabdata.models import Table

        start_time = time.monotonic()

        payload = verify_confirm_token_signature(confirm_token)

        # commit 路径同样必须做权限校验:token 由 preflight 在权限通过时签发,
        # 但用户角色可能在 5 分钟有效期内被撤销,这里要把 PermissionChanged
        # 显式抛出,语义比 401/403 更清晰。
        if not self.check_table_permission(str(table_id), 'editor'):
            raise ConfirmTokenPermissionChanged()

        normalized_filter = self._normalize_field_keys(table_id, filter_clause)
        normalized_patch = self._normalize_patch_keys(table_id, patch)

        self._verify_payload_against_request(
            payload, table_id, normalized_filter, normalized_patch,
        )

        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
        if table is None:
            raise ConfirmTokenTableChanged()
        if table.is_archived or getattr(table, 'trashed_at', None) is not None:
            raise ConfirmTokenTableChanged()

        if not reserve_nonce(payload.nonce):
            return self._handle_nonce_conflict(payload)

        try:
            result = self._execute_atomic_update(
                payload, table_id, normalized_filter, normalized_patch,
            )
        except Exception as exc:
            mark_nonce_failed(payload.nonce, error_code=type(exc).__name__)
            raise

        drift_ratio = abs(result['updated_count'] - payload.matched_total) / max(payload.matched_total, 1)
        drift_tolerance = getattr(settings, 'TABDATA_CONFIRM_TOKEN_DRIFT_TOLERANCE', 0.10)

        if payload.auto_anchor_checkpoint:
            self._trigger_checkpoint_anchor(payload, table_id, result['updated_count'])

        duration_ms = int((time.monotonic() - start_time) * 1000)
        response: Dict[str, Any] = {
            "committed_ids": result['committed_ids'],
            "matched_total": payload.matched_total,
            "updated_count": result['updated_count'],
            "truncated": False,
            "duration_ms": duration_ms,
            "drift_warning": drift_ratio > drift_tolerance,
            "auto_checkpoint_pending": payload.auto_anchor_checkpoint,
            "operation_group_id": result['operation_group_id'],
        }
        if drift_ratio > drift_tolerance:
            response["drift_actual"] = result['updated_count']
            response["drift_expected"] = payload.matched_total
            response["drift_ratio"] = round(drift_ratio, 4)
            response["drift_message_i18n_key"] = "tabdata.a3_drift_warning_actual_lt_expected"

        mark_nonce_used(payload.nonce, response)
        return 200, response

    # ── payload 业务校验 ──────────────────────────────────────────

    def _verify_payload_against_request(
        self,
        payload: ConfirmTokenPayload,
        table_id: str,
        filter_clause: Dict,
        patch: Dict,
    ) -> None:
        if payload.user_id != str(self.user.id):
            raise ConfirmTokenUserMismatch()
        # 防御性 short-circuit:任一边 space_id 为空字符串就视为可疑(W2.perf-fix2
        # 用户 P1-6 / 技术 P2-4)——避免被 trash 后 _resolve_space_id 返回空串
        # 时绕过校验。
        if payload.space_id != self.space_id:
            raise ConfirmTokenSpaceMismatch()
        if payload.table_id != table_id:
            raise ConfirmTokenTableMismatch()

        from apps.tabdata.models import Table
        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
        if table is not None and payload.table_version != self._resolve_table_version(table):
            raise ConfirmTokenTableChanged()

        if payload.filter_hash != sha256_hex(filter_clause):
            raise ConfirmTokenFilterChanged()
        if payload.patch_hash != sha256_hex(patch):
            raise ConfirmTokenPatchChanged()

    @staticmethod
    def _resolve_table_version(table: Any) -> int:
        """W2.perf-fix2 P1-1:用 ``record_version_seq`` 替代不存在的 ``table.version``。

        ``Table.record_version_seq`` 是单调递增的 record 版本计数器,虽然语义不是
        "schema 版本",但能在表内任何写入后递增,是当前可用的最强 TOCTOU 锚点。
        Wave 3 引入 schema_version 后再切换。
        """
        return int(getattr(table, 'record_version_seq', 0) or 0)

    def _handle_nonce_conflict(self, payload: ConfirmTokenPayload) -> Tuple[int, Dict]:
        existing_state = get_nonce_state(payload.nonce)
        if existing_state and existing_state.startswith("used:"):
            cached_response = json.loads(existing_state[len("used:"):])
            return 200, cached_response
        if existing_state and existing_state.startswith("failed:"):
            error_code = existing_state[len("failed:"):]
            raise ConfirmTokenPreviouslyFailed(previous_error=error_code)
        raise ConfirmTokenReplayDetected("nonce already reserved")

    # ── 原子更新 ──────────────────────────────────────────────────

    def _execute_atomic_update(
        self,
        payload: ConfirmTokenPayload,
        table_id: str,
        filter_clause: Dict,
        patch: Dict,
    ) -> Dict[str, Any]:
        drift_reject = getattr(settings, 'TABDATA_CONFIRM_TOKEN_DRIFT_REJECT_THRESHOLD', 0.50)
        hard_limit = getattr(settings, 'TABDATA_A3_HARD_LIMIT', 10000)
        # W2.perf-fix2 P1-5:operation_group_id 独立 uuid4,不复用 nonce
        operation_group_id = uuid4()

        with transaction.atomic(using=TABDATA_DB_ALIAS):
            committed_ids, updated_count, before_data_map = self._orm_jsonb_update_by_filter(
                table_id, filter_clause, patch, limit=hard_limit,
            )

            drift_ratio = abs(updated_count - payload.matched_total) / max(payload.matched_total, 1)
            if drift_ratio > drift_reject:
                raise ConfirmTokenDriftTooLarge(
                    expected=payload.matched_total,
                    actual=updated_count,
                    ratio=drift_ratio,
                )

            self._write_record_histories(
                table_id, committed_ids, patch, before_data_map,
                operation_group_id=operation_group_id,
            )

            # W2.perf-fix2 技术 P0-1:同事务内触发关联标题传播
            # 等下游字段在 commit 返回前已重算完毕,不再有 "看板字段不更新" 的窗口期。
            if committed_ids and patch:
                self._propagate_cascade(table_id, list(patch.keys()), committed_ids)

        return {
            "committed_ids": committed_ids,
            "updated_count": updated_count,
            "operation_group_id": str(operation_group_id),
        }

    _ORM_TABLE = "tabdata_record"

    def _orm_jsonb_update_by_filter(
        self,
        table_id: str,
        filter_clause: Dict,
        patch: Dict,
        limit: int,
    ) -> Tuple[List[str], int, Dict[str, Dict]]:
        """对 ORM 表 ``tabdata_record`` 的 JSONB ``data`` 列执行原生 PG UPDATE。

        ⚠️ 命名说明(W2.perf-fix2 P0-3 / L32 修复):本方法**不**操作 native schema
        的 per-table 物理表(``"as_<space_hex>"."tbl_<table_hex>"``),而是更新
        ORM 表的 JSONB ``data`` 列。native 物理列存的同步通过 ``_sync_native_table``
        在事务内兜底执行(逐行 UPDATE,通过 ``execute_batch`` 分页提交)。

        此设计权衡:
        - 优点:single-statement RETURNING 拿到 before_data,适合 RH 写入
        - 代价:native 物理表仍是 N 次 round-trip,SLA 实测以本路径为准
        - Wave 3 计划:在 native 物理表上重写,跳过 ORM JSONB 路径
        """
        where_clause, where_params = self._build_where_clause(table_id, filter_clause)
        set_clause, set_params = self._build_set_clause(table_id, patch)

        if not set_clause:
            return [], 0, {}

        tbl = self._ORM_TABLE
        sql = f"""
            WITH target_ids AS (
                SELECT id
                FROM {tbl}
                WHERE {where_clause}
                ORDER BY id
                FOR UPDATE SKIP LOCKED
                LIMIT %s
            ),
            before_data AS (
                SELECT t.id, t.data AS old_data
                FROM {tbl} t
                INNER JOIN target_ids ti ON t.id = ti.id
            )
            UPDATE {tbl} t
            SET {set_clause}, version = t.version + 1, updated_at = NOW()
            FROM before_data bd
            WHERE t.id = bd.id
            RETURNING t.id, t.version, bd.old_data AS before_data
        """
        params = where_params + [limit] + set_params

        conn = connections[TABDATA_DB_ALIAS]
        with conn.cursor() as cursor:
            cursor.execute(sql, params)
            rows = cursor.fetchall()

        committed_ids = []
        before_data_map: Dict[str, Dict] = {}
        for row in rows:
            record_id = str(row[0])
            committed_ids.append(record_id)
            before_data_map[record_id] = row[2] if row[2] else {}

        self._sync_native_table(table_id, committed_ids, patch)

        return committed_ids, len(rows), before_data_map

    # 向后兼容别名:外部测试可能曾通过 monkey-patch 引用旧名,保留至 W2 sign-off
    _native_update_by_filter = _orm_jsonb_update_by_filter

    _FIELD_KEY_RE = None
    _MAX_FIELD_KEY_LEN = 64

    @classmethod
    def _validate_field_key(cls, key: str) -> str:
        """校验字段 key 防止 SQL 注入。只允许字母、数字、下划线、连字符。

        W2.perf-fix2 技术 P1-2:增加长度上限校验对齐 ``RecordHistory.agent_run_id``
        的 64 字符上限。
        """
        import re
        if cls._FIELD_KEY_RE is None:
            cls._FIELD_KEY_RE = re.compile(r'^[a-zA-Z0-9_\-]+$')
        if not isinstance(key, str) or not key or len(key) > cls._MAX_FIELD_KEY_LEN:
            raise ValueError(f"Invalid field key length: {key!r}")
        if not cls._FIELD_KEY_RE.match(key):
            raise ValueError(f"Invalid field key: {key!r}")
        return key

    # ── 字段 key 归一化 + 类型校验 ────────────────────────────────

    def _load_field_index(self, table_id: str) -> Tuple[Dict[str, Any], Dict[str, str]]:
        """返回 (key → TableField, key → field_id) 映射。

        key 同时收录 ``str(field.id)`` / ``field.id.hex`` / ``field.name``
        三种形态,便于把客户端混用的 patch/filter key 统一到 ``str(field.id)``。
        """
        from apps.tabdata.models import TableField

        index: Dict[str, Any] = {}
        for f in TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id, is_deleted=False,
        ):
            sid = str(f.id)
            index[sid] = f
            index[f.id.hex] = f
            if f.name:
                index[f.name] = f
        canonical = {k: str(v.id) for k, v in index.items()}
        return index, canonical

    def _normalize_field_keys(
        self, table_id: str, payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        """把 filter_clause 的字段 key 归一化为 ``str(field.id)``。

        W2.perf-fix2 技术 P0-2:避免客户端用 dashed UUID / hex / name 时
        与 record.data JSONB 现存 key 形态不一致,产生幽灵字段。
        """
        if not payload:
            return {}
        index, canonical = self._load_field_index(table_id)
        normalized: Dict[str, Any] = {}
        for key, value in payload.items():
            if key not in canonical:
                raise A3PreflightError(
                    ErrorCode.A3_PREFLIGHT_UNKNOWN_FIELD, field_key=key,
                )
            normalized[canonical[key]] = value
        return normalized

    def _normalize_patch_keys(
        self, table_id: str, patch: Dict[str, Any],
    ) -> Dict[str, Any]:
        """归一化 patch key 同时拒绝不支持的字段类型。"""
        if not patch:
            return {}
        index, canonical = self._load_field_index(table_id)
        normalized: Dict[str, Any] = {}
        for key, value in patch.items():
            if key not in canonical:
                raise A3PreflightError(
                    ErrorCode.A3_PREFLIGHT_UNKNOWN_FIELD, field_key=key,
                )
            field = index[key]
            if field.field_type in _A3_DISALLOWED_FIELD_TYPES:
                raise A3PreflightError(
                    ErrorCode.A3_PREFLIGHT_UNSUPPORTED_FIELD,
                    field_name=field.name,
                    field_type=field.field_type,
                )
            normalized[canonical[key]] = value
        return normalized

    def _build_where_clause(
        self, table_id: str, filter_clause: Dict,
    ) -> Tuple[str, list]:
        """将 filter_clause 转换为 PG WHERE 子句(参数化,防注入)。

        始终附加 ``table_id`` + ``is_deleted = false`` 过滤,确保只操作目标表
        的活跃记录。filter_clause 已在 preflight/commit 入口被
        ``_normalize_field_keys`` 校验,这里假定 key 形态可信。
        """
        conditions = ["table_id = %s", "is_deleted = false"]
        params: list = [table_id]

        if not filter_clause:
            return " AND ".join(conditions), params

        for field_key, value in filter_clause.items():
            safe_key = self._validate_field_key(field_key)
            col_expr = "(data->>%s)"

            if isinstance(value, dict):
                for op, val in value.items():
                    if op == "$eq":
                        conditions.append(f"{col_expr} = %s")
                        params.extend([safe_key, str(val)])
                    elif op == "$ne":
                        conditions.append(f"{col_expr} != %s")
                        params.extend([safe_key, str(val)])
                    elif op == "$gt":
                        conditions.append(f"({col_expr})::numeric > %s")
                        params.extend([safe_key, val])
                    elif op == "$gte":
                        conditions.append(f"({col_expr})::numeric >= %s")
                        params.extend([safe_key, val])
                    elif op == "$lt":
                        conditions.append(f"({col_expr})::numeric < %s")
                        params.extend([safe_key, val])
                    elif op == "$lte":
                        conditions.append(f"({col_expr})::numeric <= %s")
                        params.extend([safe_key, val])
                    elif op == "$in":
                        if not val:
                            conditions.append("false")
                            continue
                        placeholders = ", ".join(["%s"] * len(val))
                        conditions.append(f"{col_expr} IN ({placeholders})")
                        params.append(safe_key)
                        params.extend([str(v) for v in val])
                    elif op == "$contains":
                        # LIKE 通配符防注入:转义 % / _ / \,避免用户传 "%admin%"
                        # 命中本不该匹配的行(W2.perf-fix2 技术 P0 SQL 安全 P1)。
                        escaped = (
                            str(val)
                            .replace('\\', '\\\\')
                            .replace('%', '\\%')
                            .replace('_', '\\_')
                        )
                        conditions.append(f"{col_expr} LIKE %s ESCAPE '\\'")
                        params.extend([safe_key, f"%{escaped}%"])
                    elif op == "$is_null":
                        if val:
                            conditions.append("(data->>%s) IS NULL")
                            params.append(safe_key)
                        else:
                            conditions.append("(data->>%s) IS NOT NULL")
                            params.append(safe_key)
                    else:
                        conditions.append(f"{col_expr} = %s")
                        params.extend([safe_key, str(val)])
            else:
                conditions.append(f"{col_expr} = %s")
                params.extend([safe_key, str(value)])

        return " AND ".join(conditions), params

    def _build_set_clause(
        self, table_id: str, patch: Dict,
    ) -> Tuple[str, list]:
        """将 patch 转换为 PG SET 子句(嵌套 jsonb_set 更新 JSONB data 字段)。

        patch key 已在入口归一化,这里只做字符集 + 长度校验后拼接。
        """
        if not patch:
            return "", []

        params = []
        expr = "COALESCE(t.data, '{}'::jsonb)"
        for field_key, value in patch.items():
            safe_key = self._validate_field_key(field_key)
            expr = f"jsonb_set({expr}, %s, %s::jsonb, true)"
            params.append('{' + safe_key + '}')
            params.append(json.dumps(value, ensure_ascii=False))

        return f"data = {expr}", params

    # ── cascade 传播 ───────────────────────────────────────────────

    @staticmethod
    def _propagate_cascade(
        table_id: str, changed_field_ids: List[str], record_ids: List[str],
    ) -> None:
        """同事务内触发关联字段标题刷新。

        cascade 失败仅记 warning 不抛(对齐 W0-4 D7 B+D 方案的"软警告"语义),
        避免关联标题刷新异常导致主写入回滚。

        ⚠️ **软警告语义守护**(L71 / W0-4 §3.3):
        ``propagate_cell_changes`` 装饰器移除后,需要显式 ``transaction.atomic(
        savepoint=True)`` 包裹,以隔离 cascade 内 DB 异常对外层 atomic 的污染
        (避免 ``InFailedSqlTransaction`` 让 update-by-filter 主事务整体 rollback)。
        与 ``handlers/_base.py:_handle_cascade_compute`` 的处理对齐。

        """
        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS, savepoint=True):
                from apps.tabdata.services.cascade_service import CascadeService
                CascadeService.propagate_cell_changes(
                    table_id, list(changed_field_ids), list(record_ids),
                )
        except Exception:
            logger.warning(
                "[A3] cascade propagate failed table=%s fields=%s records=%d",
                table_id, list(changed_field_ids), len(record_ids), exc_info=True,
            )

    # ── RecordHistory 写入 ────────────────────────────────────────

    def _write_record_histories(
        self,
        table_id: str,
        committed_ids: List[str],
        patch: Dict,
        before_data_map: Dict[str, Dict],
        operation_group_id: UUID,
    ) -> None:
        """同事务内批量写 RecordHistory(直接调 batch 函数,不走 EventBus)。

        ``operation_group_id`` 由 caller 传入(独立 ``uuid4()``,不复用 nonce)。
        """
        if not committed_ids:
            return

        from apps.tabdata.history_event_listeners import batch_write_record_histories
        from apps.tabdata.history_events import RecordHistoryEvent, _resolve_run_context
        from apps.tabdata.models import TableRecord

        agent_run_id, session_id = _resolve_run_context()
        is_agent = self._is_agent_request()
        editor_type = "agent" if is_agent else "user"

        records = {
            str(r.id): r
            for r in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=committed_ids[:5000]
            ).only('id', 'table_id', 'data')
        }

        events = []
        for rid in committed_ids:
            record = records.get(rid)
            if not record:
                continue
            before = before_data_map.get(rid, {})
            field_changes = {}
            for fk, new_val in patch.items():
                old_val = before.get(fk) if isinstance(before, dict) else None
                if old_val == new_val:
                    # W2.perf-fix2 P1-9:跳过 "无实际变化" 字段,避免污染 Undo 栈
                    continue
                field_changes[fk] = {"old": old_val, "new": new_val}
            if not field_changes:
                continue

            events.append(RecordHistoryEvent(
                record=record,
                action='update',
                field_changes=field_changes,
                user=self.user,
                operation_group_id=operation_group_id,
                push_to_stack=False,
                editor_type=editor_type,
                agent_run_id=agent_run_id,
                session_id=session_id,
            ))

        if events:
            batch_write_record_histories(events)

    # ── Checkpoint anchor ─────────────────────────────────────────

    def _trigger_checkpoint_anchor(
        self,
        payload: ConfirmTokenPayload,
        table_id: str,
        affected_count: int,
    ) -> None:
        """≥ 1000 行自动 anchor Checkpoint。

        W2.perf-fix2 产品 P0-1 修复:旧实现调 ``DaemonCheckpointService.request_anchor``
        而该方法不存在,等于 silent no-op。改为:
        1. 优先从当前 agent run_context 解析 ``thread_id``,调
           ``maybe_checkpoint_commit(thread_id)`` 走标准 Checkpoint 流程
        2. 非 agent 触发或 thread_id 不可解析时,降级 logger.warning 让运维感知,
           不再静默丢失承诺
        """
        try:
            thread_id = self._resolve_thread_id()
            if not thread_id:
                logger.warning(
                    "[A3] auto-anchor checkpoint skipped: no agent thread_id "
                    "(table=%s affected=%d nonce=%s) — Wave 3 D1 Outbox 接入后兜底",
                    table_id, affected_count, payload.nonce,
                )
                return
            from apps.services.agent_engine.services.daemon_checkpoint_service import DaemonCheckpointService
            DaemonCheckpointService.maybe_checkpoint_commit(
                thread_id,
                trigger="tabdata_auto_anchor",
                visible_in_history=False,
            )
            logger.info(
                "[A3] auto-anchor checkpoint dispatched: table=%s affected=%d "
                "thread=%s nonce=%s",
                table_id, affected_count, thread_id, payload.nonce,
            )
        except Exception:
            logger.warning(
                "[A3] Failed to trigger checkpoint anchor for table=%s",
                table_id, exc_info=True,
            )

    @staticmethod
    def _resolve_thread_id() -> Optional[str]:
        """从 run_context 解析 daemon checkpoint thread_id。"""
        try:
            from apps.chat.conversation.utils import CHAT_SESSION_PREFIX
            from apps.services.common.platform_context import get_current_session_id
            session_id = get_current_session_id()
            if not session_id:
                return None
            return f"{CHAT_SESSION_PREFIX}{session_id}"
        except Exception:
            return None

    # ── helpers ────────────────────────────────────────────────────

    def _count_and_sample(
        self,
        table_id: str,
        filter_clause: Dict,
        limit: int = 20,
    ) -> Tuple[int, List[Dict]]:
        tbl = self._ORM_TABLE
        where_clause, where_params = self._build_where_clause(table_id, filter_clause)

        conn = connections[TABDATA_DB_ALIAS]
        with conn.cursor() as cursor:
            cursor.execute(
                f'SELECT COUNT(*) FROM {tbl} WHERE {where_clause}',
                where_params,
            )
            matched_total = cursor.fetchone()[0]

            cursor.execute(
                f'SELECT id, data FROM {tbl} WHERE {where_clause} ORDER BY id LIMIT %s',
                where_params + [limit],
            )
            sample_rows = cursor.fetchall()

        sample_records = [
            {"__id": str(row[0]), **(row[1] if isinstance(row[1], dict) else {})}
            for row in sample_rows
        ]

        return matched_total, sample_records

    def _sync_native_table(
        self,
        table_id: str,
        committed_ids: List[str],
        patch: Dict,
    ) -> None:
        """ORM 更新后同步 native 列存储(双写一致性)。

        失败仅记 error(W2.perf-fix2 技术 P0-6 反馈:旧实现 warning 等于沉默,
        改为 error + 关键字段方便观测)。
        """
        if not committed_ids:
            return
        try:
            from apps.tabdata.models import Table, TableField
            from apps.tabdata.native.record_io import NativeRecordIO
            from apps.tabdata.native.value_converter import python_to_pg
            from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            nio = NativeRecordIO(resolve_schema_partition_id(table), table.id)

            field_map = {}
            for f in TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id, is_deleted=False,
            ):
                field_map[str(f.id)] = f

            native_rows = []
            for rid in committed_ids:
                row: Dict[str, Any] = {'__id': rid}
                for fk, val in patch.items():
                    field = field_map.get(fk)
                    if field is None:
                        continue
                    col_hex = str(field.id).replace('-', '')
                    pg_val = python_to_pg(val, field.field_type, field.config or {})
                    row[col_hex] = pg_val
                if len(row) > 1:
                    native_rows.append(row)

            if native_rows:
                nio.bulk_update_records(native_rows)
        except Exception as exc:
            logger.error(
                "[A3] native table sync failed table=%s count=%d err=%s — "
                "ORM 表已更新但 native 列存未同步,后续 native 读路径会拿到旧值",
                table_id, len(committed_ids), exc, exc_info=True,
            )

    def _estimate_duration(self, matched_total: int) -> int:
        """基于 W2.perf baseline 实测的 ~5.5ms/行 估算 commit 耗时。

        W2.perf-fix2 P1-1:旧公式 1000 行 × 3 = 3000ms 偏低 80%,改为按
        ~6ms/行(贴近 baseline 5.5s/1000)估算。
        """
        if matched_total < 100:
            return 800
        return matched_total * 6

    def _is_agent_request(self) -> bool:
        try:
            from apps.services.common.platform_context import get_current_run_id
            return bool(get_current_run_id())
        except Exception:
            return False
