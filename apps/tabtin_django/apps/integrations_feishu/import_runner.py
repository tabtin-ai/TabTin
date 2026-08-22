"""飞书多维表 → TabData 导入执行器（分期 A/B/C/D，供 Celery task 调用）。"""

from __future__ import annotations

import logging
import uuid as uuid_mod
from typing import Any, Callable, Dict, List, Optional, Set, Tuple
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from apps.tabdata.constants import MAX_BULK_RECORDS, TABDATA_DB_ALIAS
from apps.tabdata.models import TableField
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.services.table_service import TableService

from .client import FeishuAuthError, FeishuAPIError, FeishuClient
from .constants import (
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS_PER_CELL,
    MAX_ROWS_PER_TABLE,
)
from .field_mapping import (
    extract_attachment_items,
    extract_link_record_ids,
    feishu_type_int,
    is_attachment_type,
    is_link_type,
    link_target_table_ids,
    map_feishu_field_to_tabdata,
    serialize_feishu_cell_value,
)
from .feature import (
    FEISHU_IMPORT_DISABLED_MESSAGE,
    feishu_import_enabled_for_organization,
)
from .import_actions import action_key_set, mark_table_started, table_key
from .import_errors import (
    ImportInterrupted,
    is_auth_api_error,
    is_expired_access_token_error,
    raise_if_provider_reauthenticated,
    user_facing_import_error,
)
from .models import FeishuImportJob, FeishuOAuthConnection

logger = logging.getLogger(__name__)
User = get_user_model()

TableKey = Tuple[str, str]  # (app_token, table_id)


class ImportTableSkipped(Exception):
    """用户在建表前请求跳过当前表。"""


def _claim_import_job(job_id: str) -> FeishuImportJob | None:
    with transaction.atomic():
        job = (
            FeishuImportJob.objects.select_for_update()
            .select_related("user")
            .get(id=job_id)
        )
        if job.status not in {
            FeishuImportJob.Status.PENDING,
            FeishuImportJob.Status.RUNNING,
        }:
            logger.info(
                "[FeishuImport] skip terminal job job_id=%s status=%s",
                job.id,
                job.status,
            )
            return None
        job.status = FeishuImportJob.Status.RUNNING
        job.save(update_fields=["status", "updated_at"])
        return job


def _copy_result_rows(prior: Dict[str, Any], field: str) -> List[Dict[str, Any]]:
    rows = prior.get(field) or []
    if not isinstance(rows, list):
        return []
    return [dict(row) for row in rows if isinstance(row, dict)]


def _copy_issue_list(prior: Dict[str, Any]) -> List[str]:
    raw = prior.get("issues") or []
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if item]


def _record_failed_table(
    failed_tables: List[Dict[str, Any]],
    *,
    app_token: str,
    table_id: str,
    name: str,
    error: str,
) -> None:
    key = table_key(app_token, table_id)
    failed_tables[:] = [
        row
        for row in failed_tables
        if table_key(
            str(row.get("app_token") or ""),
            str(row.get("table_id") or ""),
        ) != key
    ]
    failed_tables.append(
        {
            "app_token": app_token,
            "table_id": table_id,
            "name": name or table_id,
            "error": error or "导入失败",
        }
    )


def run_feishu_import(job_id: str) -> None:
    job = _claim_import_job(job_id)
    if job is None:
        return

    if not feishu_import_enabled_for_organization(
        user_id=str(job.user_id),
        organization_id=str(job.organization_id),
        client=None,
    ):
        _fail(job, FEISHU_IMPORT_DISABLED_MESSAGE)
        logger.info(
            "[FeishuImport] blocked by feature rollout job_id=%s org_id=%s",
            job.id,
            job.organization_id,
        )
        return

    tables = job.tables or []
    documents = job.documents or []
    prior = dict(job.result or {})
    include_attachments = bool(prior.get("include_attachments"))

    if not tables and not documents:
        _fail(job, "导入列表为空")
        return

    # 重投递时保留已创建/已跳过结果，避免重复建表建文档
    created = _copy_result_rows(prior, "created_tables")
    failed_tables = _copy_result_rows(prior, "failed_tables")
    skipped = _copy_result_rows(prior, "skipped_tables")
    cancelled = _copy_result_rows(prior, "cancelled_tables")
    created_documents = _copy_result_rows(prior, "created_documents")
    failed_documents = _copy_result_rows(prior, "failed_documents")
    issues = _copy_issue_list(prior)
    prior_done = (
        len(created)
        + len(failed_tables)
        + len(skipped)
        + len(cancelled)
        + len(created_documents)
        + len(failed_documents)
    )

    job.status = FeishuImportJob.Status.RUNNING
    job.error = ""
    initial_phase = "phase_a" if tables else "docs"
    job.result = {
        "include_attachments": include_attachments,
        "phase": initial_phase,
        "created_tables": list(created),
        "failed_tables": list(failed_tables),
        "created_documents": list(created_documents),
        "failed_documents": list(failed_documents),
        "skipped_tables": list(skipped),
        "cancelled_tables": list(cancelled),
        "cancelled_keys": list(action_key_set(prior, "cancelled_keys")),
        "skipped_keys": list(action_key_set(prior, "skipped_keys")),
        "started_keys": list(action_key_set(prior, "started_keys")),
        "issues": list(issues),
        "progress": {
            "done": prior_done,
            "total": len(tables) + len(documents),
        },
    }
    with transaction.atomic():
        locked = FeishuImportJob.objects.select_for_update().get(id=job.id)
        if locked.status != FeishuImportJob.Status.RUNNING:
            logger.info(
                "[FeishuImport] stop before execution job_id=%s status=%s",
                job.id,
                locked.status,
            )
            return
        locked.error = job.error
        locked.result = job.result
        locked.save(update_fields=["error", "result", "updated_at"])
        job = locked

    try:
        connection = FeishuOAuthConnection.objects.get(
            user_id=job.user_id,
            organization_id=job.organization_id,
            status=FeishuOAuthConnection.Status.CONNECTED,
        )
    except FeishuOAuthConnection.DoesNotExist as exc:
        _fail(job, "未连接飞书账号，请先完成 OAuth 授权")
        raise FeishuAuthError("not connected") from exc

    client = FeishuClient()
    user = job.user

    # Phase A 产出
    imported: Dict[TableKey, Dict[str, Any]] = {}
    # feishu_record_id → tabdata record UUID str，按表
    record_id_maps: Dict[TableKey, Dict[str, str]] = {}
    # spill: table_key → feishu_rec_id → field_name → payload
    link_spills: Dict[TableKey, Dict[str, Dict[str, List[str]]]] = {}
    attachment_spills: Dict[TableKey, Dict[str, Dict[str, List[Dict[str, Any]]]]] = {}
    # feishu fields meta per table
    fields_cache: Dict[TableKey, List[Dict[str, Any]]] = {}

    try:
        access_token = client.get_valid_access_token(connection)

        if tables:
            access_token = _run_table_phases(
                job=job,
                client=client,
                connection=connection,
                access_token=access_token,
                user=user,
                tables=tables,
                include_attachments=include_attachments,
                created=created,
                failed_tables=failed_tables,
                skipped=skipped,
                cancelled=cancelled,
                issues=issues,
                imported=imported,
                record_id_maps=record_id_maps,
                link_spills=link_spills,
                attachment_spills=attachment_spills,
                fields_cache=fields_cache,
            )

        if documents:
            from .import_documents import import_feishu_documents

            try:
                created_documents = import_feishu_documents(
                    job,
                    client=client,
                    access_token=access_token,
                    documents=documents,
                    issues=issues,
                )
            except FeishuAuthError as exc:
                cause = exc.__cause__
                if not (
                    isinstance(cause, FeishuAPIError)
                    and is_expired_access_token_error(cause)
                ):
                    raise
                logger.info(
                    "[FeishuImport] refresh expired token and retry documents job_id=%s",
                    job.id,
                )
                access_token = client.get_valid_access_token(
                    connection,
                    force_refresh=True,
                )
                created_documents = import_feishu_documents(
                    job,
                    client=client,
                    access_token=access_token,
                    documents=documents,
                    issues=issues,
                )

        job.status = FeishuImportJob.Status.SUCCESS
        _set_phase(
            job,
            "done",
            created,
            skipped,
            cancelled,
            issues,
            len(tables),
            len(tables),
            persist_status=True,
            created_documents=created_documents,
        )
        logger.info(
            "[FeishuImport] success job_id=%s created=%d docs=%d skipped=%d cancelled=%d issues=%d",
            job.id,
            len(created),
            len(created_documents),
            len(skipped),
            len(cancelled),
            len(issues),
        )
    except ImportInterrupted:
        logger.info(
            "[FeishuImport] interrupted by provider reauthentication job_id=%s",
            job.id,
        )
        return
    except FeishuAuthError as exc:
        _fail(job, "飞书授权已失效，请重新授权")
        raise
    except Exception as exc:
        logger.exception("[FeishuImport] failed job_id=%s", job.id)
        _fail(job, user_facing_import_error(exc))
        raise


def _run_table_phases(
    *,
    job: FeishuImportJob,
    client: FeishuClient,
    connection: FeishuOAuthConnection,
    access_token: str,
    user,
    tables: List[Dict[str, Any]],
    include_attachments: bool,
    created: List[Dict[str, Any]],
    failed_tables: List[Dict[str, Any]],
    skipped: List[Dict[str, Any]],
    cancelled: List[Dict[str, Any]],
    issues: List[str],
    imported: Dict[TableKey, Dict[str, Any]],
    record_id_maps: Dict[TableKey, Dict[str, str]],
    link_spills: Dict[TableKey, Dict[str, Dict[str, List[str]]]],
    attachment_spills: Dict[TableKey, Dict[str, Dict[str, List[Dict[str, Any]]]]],
    fields_cache: Dict[TableKey, List[Dict[str, Any]]],
) -> str:
    # ── Phase A: 建表 + 普通字段 + 写行 ─────────────────
    _set_phase(job, "phase_a", created, skipped, cancelled, issues, 0, len(tables))
    for idx, spec in enumerate(tables):
        app_token = spec["app_token"]
        table_id = spec["table_id"]
        preferred_name = (spec.get("name") or "").strip()
        # 前端树浏览偶发用 table_id 充 name；视为未知，走 list_tables 回填
        if preferred_name == table_id:
            preferred_name = ""
        key = table_key(app_token, table_id)
        tkey: TableKey = (app_token, table_id)

        job.refresh_from_db(fields=["result"])
        result = dict(job.result or {})
        cancelled_keys = action_key_set(result, "cancelled_keys")
        skipped_keys = action_key_set(result, "skipped_keys")
        started_keys = action_key_set(result, "started_keys")
        already_created_keys = {
            table_key(str(row.get("app_token") or ""), str(row.get("table_id") or ""))
            for row in created
        }
        already_failed_keys = {
            table_key(str(row.get("app_token") or ""), str(row.get("table_id") or ""))
            for row in failed_tables
        }
        already_skipped_keys = {
            table_key(str(row.get("app_token") or ""), str(row.get("table_id") or ""))
            for row in skipped
        }
        already_cancelled_keys = {
            table_key(str(row.get("app_token") or ""), str(row.get("table_id") or ""))
            for row in cancelled
        }

        if key in already_created_keys:
            # Celery 重投递：该表已在上次执行中成功落库
            prior_row = next(
                (
                    row for row in created
                    if table_key(str(row.get("app_token") or ""), str(row.get("table_id") or "")) == key
                ),
                None,
            )
            if prior_row and prior_row.get("tabdata_table_id"):
                imported[tkey] = {
                    "tabdata_table_id": prior_row["tabdata_table_id"],
                    "name": prior_row.get("name") or preferred_name or table_id,
                    "app_token": app_token,
                    "table_id": table_id,
                    "row_write_errors": prior_row.get("row_write_errors") or 0,
                }
            _set_phase(
                job, "phase_a", created, skipped, cancelled, issues, idx + 1, len(tables),
            )
            continue

        if key in already_failed_keys:
            # Celery 重投递：该表已留下明确失败结果，继续处理后续项。
            _set_phase(
                job, "phase_a", created, skipped, cancelled, issues, idx + 1, len(tables),
            )
            continue

        if key in already_cancelled_keys or key in cancelled_keys:
            if key not in already_cancelled_keys:
                cancelled.append(
                    {
                        "app_token": app_token,
                        "table_id": table_id,
                        "name": preferred_name or table_id,
                    }
                )
            _set_phase(
                job, "phase_a", created, skipped, cancelled, issues, idx + 1, len(tables),
            )
            continue

        def should_abort(current_key: str = key) -> bool:
            job.refresh_from_db(fields=["result"])
            return current_key in action_key_set(job.result, "skipped_keys")

        if key in already_skipped_keys or key in skipped_keys:
            if key not in already_skipped_keys:
                skipped.append(
                    {
                        "app_token": app_token,
                        "table_id": table_id,
                        "name": preferred_name or table_id,
                    }
                )
            _set_phase(
                job, "phase_a", created, skipped, cancelled, issues, idx + 1, len(tables),
            )
            continue

        # 上次已开始但未写入 created：避免半成品表再造一份
        if key in started_keys:
            msg = (
                f"表格「{preferred_name or table_id}」上次导入中断，已跳过以免重复创建；"
                "请单独重新导入该表"
            )
            if msg not in issues:
                issues.append(msg)
            if key not in already_skipped_keys:
                skipped.append(
                    {
                        "app_token": app_token,
                        "table_id": table_id,
                        "name": preferred_name or table_id,
                        "reason": "interrupted_retry_skipped",
                    }
                )
            _set_phase(
                job, "phase_a", created, skipped, cancelled, issues, idx + 1, len(tables),
            )
            continue

        mark_table_started(job, app_token, table_id)

        try:
            try:
                outcome = _phase_a_import_table(
                    client=client,
                    access_token=access_token,
                    user=user,
                    organization_id=job.organization_id,
                    collection_id=job.collection_id,
                    space_id=job.space_id,
                    app_token=app_token,
                    table_id=table_id,
                    preferred_name=preferred_name,
                    should_abort=should_abort,
                )
            except FeishuAPIError as exc:
                if not is_expired_access_token_error(exc):
                    raise
                logger.info(
                    "[FeishuImport] refresh expired token and retry table "
                    "job_id=%s app_token=%s table_id=%s",
                    job.id,
                    app_token,
                    table_id,
                )
                access_token = client.get_valid_access_token(
                    connection,
                    force_refresh=True,
                )
                outcome = _phase_a_import_table(
                    client=client,
                    access_token=access_token,
                    user=user,
                    organization_id=job.organization_id,
                    collection_id=job.collection_id,
                    space_id=job.space_id,
                    app_token=app_token,
                    table_id=table_id,
                    preferred_name=preferred_name,
                    should_abort=should_abort,
                )
        except ImportTableSkipped:
            skipped.append(
                {
                    "app_token": app_token,
                    "table_id": table_id,
                    "name": preferred_name or table_id,
                }
            )
            _set_phase(
                job, "phase_a", created, skipped, cancelled, issues, idx + 1, len(tables),
            )
            continue
        except FeishuAuthError:
            # 授权失效影响整单，继续请求只会产生相同失败。
            raise
        except FeishuAPIError as exc:
            if is_auth_api_error(exc):
                raise FeishuAuthError("飞书连接已失效，请重新授权") from exc
            error = user_facing_import_error(exc)
            message = f"导入表格「{preferred_name or table_id}」失败：{error}"
            logger.warning(
                "[FeishuImport] table API failed; continue batch "
                "job_id=%s app_token=%s table_id=%s error=%s",
                job.id,
                app_token,
                table_id,
                error,
            )
            if message not in issues:
                issues.append(message)
            _record_failed_table(
                failed_tables,
                app_token=app_token,
                table_id=table_id,
                name=preferred_name,
                error=error,
            )
            _set_phase(
                job,
                "phase_a",
                created,
                skipped,
                cancelled,
                issues,
                idx + 1,
                len(tables),
                failed_tables=failed_tables,
            )
            continue
        except Exception as exc:
            error = user_facing_import_error(exc)
            message = f"导入表格「{preferred_name or table_id}」失败：{error}"
            logger.exception(
                "[FeishuImport] table failed; continue batch "
                "job_id=%s app_token=%s table_id=%s",
                job.id,
                app_token,
                table_id,
            )
            if message not in issues:
                issues.append(message)
            _record_failed_table(
                failed_tables,
                app_token=app_token,
                table_id=table_id,
                name=preferred_name,
                error=error,
            )
            _set_phase(
                job,
                "phase_a",
                created,
                skipped,
                cancelled,
                issues,
                idx + 1,
                len(tables),
                failed_tables=failed_tables,
            )
            continue

        fields_cache[tkey] = outcome["feishu_fields"]
        record_id_maps[tkey] = outcome["record_id_map"]
        link_spills[tkey] = outcome["link_spills"]
        attachment_spills[tkey] = outcome["attachment_spills"]
        imported[tkey] = {
            "tabdata_table_id": outcome["tabdata_table_id"],
            "name": outcome["table_name"],
            "app_token": app_token,
            "table_id": table_id,
            "row_write_errors": outcome["row_write_errors"],
        }

        row = {
            "app_token": app_token,
            "table_id": table_id,
            "tabdata_table_id": str(outcome["tabdata_table_id"]),
            "name": outcome["table_name"],
            "row_write_errors": outcome["row_write_errors"],
        }
        if outcome["was_skipped"]:
            skipped.append(row)
        else:
            created.append(row)
        _set_phase(
            job, "phase_a", created, skipped, cancelled, issues, idx + 1, len(tables),
        )

    # ── Phase B: 建 link 字段 ───────────────────────────
    _set_phase(job, "phase_b", created, skipped, cancelled, issues, len(tables), len(tables))
    link_field_map, degraded_text_fields = _phase_b_create_links(
        user=user,
        imported=imported,
        fields_cache=fields_cache,
        issues=issues,
    )

    # ── Phase C: 回填 LinkRecord ────────────────────────
    _set_phase(job, "phase_c", created, skipped, cancelled, issues, len(tables), len(tables))
    _phase_c_fill_links(
        user=user,
        imported=imported,
        record_id_maps=record_id_maps,
        link_spills=link_spills,
        link_field_map=link_field_map,
        issues=issues,
    )
    _phase_c_fill_degraded_text(
        user=user,
        imported=imported,
        record_id_maps=record_id_maps,
        link_spills=link_spills,
        degraded_text_fields=degraded_text_fields,
        issues=issues,
    )

    # ── Phase D: 附件（可选）────────────────────────────
    if include_attachments:
        _set_phase(
            job, "phase_d", created, skipped, cancelled, issues, len(tables), len(tables),
        )
        _phase_d_attachments(
            client=client,
            access_token=access_token,
            user=user,
            organization_id=job.organization_id,
            imported=imported,
            record_id_maps=record_id_maps,
            attachment_spills=attachment_spills,
            issues=issues,
        )

    return access_token


def _set_phase(
    job: FeishuImportJob,
    phase: str,
    created: List[Dict[str, Any]],
    skipped: List[Dict[str, Any]],
    cancelled: List[Dict[str, Any]],
    issues: List[str],
    done: int,
    total: int,
    *,
    persist_status: bool = False,
    created_documents: Optional[List[Dict[str, Any]]] = None,
    failed_tables: Optional[List[Dict[str, Any]]] = None,
) -> None:
    with transaction.atomic():
        locked = FeishuImportJob.objects.select_for_update().get(id=job.id)
        result = dict(locked.result or {})
        raise_if_provider_reauthenticated(result)
        # 合并并发 cancel/skip，避免整体覆盖丢失用户操作
        cancelled_keys = action_key_set(result, "cancelled_keys")
        skipped_keys = action_key_set(result, "skipped_keys")
        started_keys = action_key_set(result, "started_keys")
        result["phase"] = phase
        result["created_tables"] = created
        if failed_tables is not None:
            result["failed_tables"] = failed_tables
        result["skipped_tables"] = skipped
        result["cancelled_tables"] = cancelled
        result["issues"] = issues[-50:]
        docs_total = len(locked.documents or [])
        created_docs_done = len(created_documents) if created_documents is not None else len(
            result.get("created_documents") or [],
        )
        failed_docs_done = len(result.get("failed_documents") or [])
        docs_done = created_docs_done + failed_docs_done
        if created_documents is not None:
            result["created_documents"] = created_documents
        result["progress"] = {
            "done": done + (docs_done if phase == "done" else 0),
            "total": total + docs_total,
        }
        if phase == "done":
            result["progress"]["done"] = done + docs_done
            result["docs_progress"] = {"done": docs_done, "total": docs_total}
        result["cancelled_keys"] = list(cancelled_keys)
        result["skipped_keys"] = list(skipped_keys)
        result["started_keys"] = list(started_keys)
        if "include_attachments" not in result:
            result["include_attachments"] = bool(
                (locked.result or {}).get("include_attachments")
            )
        locked.result = result
        fields = ["result", "updated_at"]
        if persist_status:
            locked.status = job.status
            fields.append("status")
        locked.save(update_fields=fields)
        job.result = locked.result
        if persist_status:
            job.status = locked.status


def _fail(job: FeishuImportJob, message: str) -> None:
    with transaction.atomic():
        locked = FeishuImportJob.objects.select_for_update().get(id=job.id)
        result = dict(locked.result or {})
        try:
            raise_if_provider_reauthenticated(result)
        except ImportInterrupted:
            job.status = locked.status
            job.error = locked.error
            job.result = result
            return
        locked.status = FeishuImportJob.Status.FAILED
        locked.error = message[:4000]
        locked.result = result
        locked.save(update_fields=["status", "error", "result", "updated_at"])
        job.status = locked.status
        job.error = locked.error
        job.result = locked.result


def _dedupe_field_name(base_name: str, seen: Set[str]) -> str:
    name = base_name
    n = 2
    while name in seen:
        name = f"{base_name}_{n}"
        n += 1
    seen.add(name)
    return name


def _phase_a_import_table(
    *,
    client: FeishuClient,
    access_token: str,
    user,
    organization_id: UUID,
    collection_id: Optional[UUID],
    space_id: Optional[UUID],
    app_token: str,
    table_id: str,
    preferred_name: str,
    should_abort: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    if should_abort and should_abort():
        raise ImportTableSkipped()

    feishu_fields = client.list_fields(access_token, app_token, table_id)
    if not feishu_fields:
        raise ValueError(f"飞书表 {table_id} 无字段，无法导入")

    mapped_fields: List[Dict[str, Any]] = []
    field_meta: List[Dict[str, Any]] = []
    seen_names: Set[str] = set()
    for f in feishu_fields:
        ftype = feishu_type_int(f)
        raw_name = (f.get("field_name") or f.get("name") or "未命名字段").strip() or "未命名字段"
        name = _dedupe_field_name(raw_name, seen_names)
        field_meta.append(
            {
                "name": name,
                "feishu_field_name": f.get("field_name") or f.get("name") or name,
                "type": ftype,
            }
        )
        if is_link_type(ftype):
            continue  # Phase B
        mapped = map_feishu_field_to_tabdata(f, defer_link=True)
        if mapped is None:
            continue
        mapped["name"] = name
        mapped_fields.append(mapped)

    table_name = preferred_name
    if not table_name:
        for t in client.list_tables(access_token, app_token):
            if t["table_id"] == table_id:
                table_name = t["name"]
                break
    table_name = table_name or f"feishu_{table_id}"

    if should_abort and should_abort():
        raise ImportTableSkipped()

    records_data: List[Dict[str, Any]] = []
    feishu_record_ids: List[str] = []
    link_spills: Dict[str, Dict[str, List[str]]] = {}
    attachment_spills: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    for item in client.iter_records(
        access_token, app_token, table_id, max_rows=MAX_ROWS_PER_TABLE,
    ):
        if should_abort and should_abort():
            raise ImportTableSkipped()
        feishu_rid = str(item.get("record_id") or item.get("id") or "")
        fields = item.get("fields") or {}
        row: Dict[str, Any] = {}
        for meta in field_meta:
            raw = fields.get(meta["feishu_field_name"])
            ftype = meta["type"]
            if is_link_type(ftype):
                ids = extract_link_record_ids(raw)
                if ids and feishu_rid:
                    link_spills.setdefault(feishu_rid, {})[meta["name"]] = ids
                continue
            if is_attachment_type(ftype):
                atts = extract_attachment_items(raw)
                if atts and feishu_rid:
                    attachment_spills.setdefault(feishu_rid, {})[meta["name"]] = atts
                # Phase A 不写附件 cell
                continue
            row[meta["name"]] = serialize_feishu_cell_value(raw, ftype)
        records_data.append(row)
        feishu_record_ids.append(feishu_rid)

    # 单表写入是一个原子单元：建表、建字段或写行任一步抛错，都回滚该表，
    # 外层才能安全记录失败并继续下一项，而不会在 Space 中留下半成品。
    with transaction.atomic(using=TABDATA_DB_ALIAS):
        table_service = TableService(user=user)
        table = table_service.create_table(
            organization_id=organization_id,
            space_id=space_id,
            name=table_name,
            use_default_fields=False,
            collection_id=collection_id,
        )
        if table is None:
            raise PermissionError("无权限创建表格，或 Organization 不存在")

        created_fields, errors, _skipped = table_service.bulk_create_fields(
            table.id,
            mapped_fields,
            push_to_undo_stack=False,
        )
        if errors and not created_fields:
            raise ValueError(f"创建字段失败: {'; '.join(errors[:5])}")

        write_error_count = 0
        record_id_map: Dict[str, str] = {}
        if records_data:
            record_service = RecordService(user=user)
            for offset in range(0, len(records_data), MAX_BULK_RECORDS):
                if should_abort and should_abort():
                    raise ImportTableSkipped()
                chunk = records_data[offset : offset + MAX_BULK_RECORDS]
                chunk_ids = feishu_record_ids[offset : offset + MAX_BULK_RECORDS]
                # 预分配 UUID：bulk 会跳过校验失败行，不能用 enumerate(created) 对齐原序
                preassigned_ids = [str(uuid_mod.uuid4()) for _ in chunk]
                created_recs, write_errors = record_service.bulk_create_records(
                    table.id,
                    chunk,
                    record_ids=preassigned_ids,
                    field_key_type="name",
                )
                if write_errors:
                    write_error_count += len(write_errors)
                    logger.warning(
                        "[FeishuImport] bulk_create errors table=%s count=%d sample=%s",
                        table.id,
                        len(write_errors),
                        write_errors[:3],
                    )
                created_id_set = {str(r.id) for r in created_recs}
                for frid, pid in zip(chunk_ids, preassigned_ids):
                    if frid and pid in created_id_set:
                        record_id_map[frid] = pid

        if write_error_count and write_error_count >= len(records_data):
            raise ValueError(
                f"表格「{table_name}」记录全部写入失败（{write_error_count} 条）"
            )

    return {
        "tabdata_table_id": table.id,
        "table_name": table_name,
        "feishu_fields": feishu_fields,
        "field_meta": field_meta,
        "record_id_map": record_id_map,
        "link_spills": link_spills,
        "attachment_spills": attachment_spills,
        "row_write_errors": write_error_count,
        "was_skipped": False,
    }


def _phase_b_create_links(
    *,
    user,
    imported: Dict[TableKey, Dict[str, Any]],
    fields_cache: Dict[TableKey, List[Dict[str, Any]]],
    issues: List[str],
) -> Tuple[Dict[TableKey, Dict[str, TableField]], Dict[TableKey, Set[str]]]:
    """建 link 字段。

    返回:
      - link_field_map: (app,table) → {tabdata_field_name → TableField}
      - degraded_text_fields: (app,table) → {降级为 text 的字段名}
    """
    table_service = TableService(user=user)
    link_field_map: Dict[TableKey, Dict[str, TableField]] = {}
    degraded_text_fields: Dict[TableKey, Set[str]] = {}
    duplex_done: Set[frozenset] = set()

    # 稳定顺序：按 app/table/field name
    for tkey in sorted(imported.keys()):
        app_token, table_id = tkey
        info = imported[tkey]
        tabdata_table_id = info["tabdata_table_id"]
        feishu_fields = fields_cache.get(tkey) or []
        # 已有字段名（避免与普通字段撞名）
        existing_names = set(
            TableField.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=tabdata_table_id, is_deleted=False)
            .values_list("name", flat=True)
        )

        for field in feishu_fields:
            ftype = feishu_type_int(field)
            if not is_link_type(ftype):
                continue
            targets, duplex = link_target_table_ids(field)
            if not targets:
                issues.append(
                    f"表「{info['name']}」关联字段缺少目标表，已跳过"
                )
                continue
            target_tid = targets[0]
            target_key: TableKey = (app_token, target_tid)
            if target_key not in imported:
                # 跨 Base / 未选入 → 降级：建 text 字段，稍后回填 record_id 文本
                raw_name = (field.get("field_name") or field.get("name") or "关联").strip()
                name = _dedupe_field_name(raw_name, existing_names)
                try:
                    table_service.bulk_create_fields(
                        tabdata_table_id,
                        [{"name": name, "field_type": "text"}],
                        push_to_undo_stack=False,
                    )
                    degraded_text_fields.setdefault(tkey, set()).add(name)
                except Exception as exc:
                    issues.append(f"降级关联字段失败 {name}: {exc}")
                issues.append(
                    f"表「{info['name']}」→ {target_tid} 不在导入集合，关联「{name}」已降级为文本"
                )
                continue

            foreign_table_id = str(imported[target_key]["tabdata_table_id"])
            raw_name = (field.get("field_name") or field.get("name") or "关联").strip() or "关联"

            if duplex:
                pair = frozenset({table_id, target_tid})
                if pair in duplex_done:
                    # 对侧已建双向；对称字段在首次创建时已登记
                    continue
                is_one_way = False
            else:
                is_one_way = True

            name = _dedupe_field_name(raw_name, existing_names)
            try:
                created_fields, errors, _ = table_service.bulk_create_fields(
                    tabdata_table_id,
                    [
                        {
                            "name": name,
                            "field_type": "link",
                            "options": {
                                "foreignTableId": foreign_table_id,
                                "relationship": "ManyMany",
                                "isOneWay": is_one_way,
                            },
                        }
                    ],
                    push_to_undo_stack=False,
                )
                if errors and not created_fields:
                    issues.append(f"创建关联字段失败 {name}: {'; '.join(errors[:3])}")
                    continue
                link_field = created_fields[0] if created_fields else None
                if link_field is None:
                    link_field = (
                        TableField.objects.using(TABDATA_DB_ALIAS)
                        .filter(table_id=tabdata_table_id, name=name, is_deleted=False)
                        .first()
                    )
                if link_field:
                    link_field_map.setdefault(tkey, {})[name] = link_field
                    if duplex:
                        duplex_done.add(frozenset({table_id, target_tid}))
                        # 对侧对称字段也登记，便于 Phase C 用对侧 Feishu 字段名写入
                        sym_id = (link_field.config or {}).get("symmetricFieldId")
                        if sym_id:
                            try:
                                sym = TableField.objects.using(TABDATA_DB_ALIAS).get(
                                    id=sym_id, is_deleted=False,
                                )
                                # 找对侧同名 Feishu duplex 字段名
                                for tf in fields_cache.get(target_key) or []:
                                    if not is_link_type(feishu_type_int(tf)):
                                        continue
                                    t_targets, t_duplex = link_target_table_ids(tf)
                                    if t_duplex and table_id in t_targets:
                                        other_name = (
                                            tf.get("field_name") or tf.get("name") or sym.name
                                        ).strip()
                                        link_field_map.setdefault(target_key, {})[other_name] = sym
                                        break
                            except TableField.DoesNotExist:
                                pass
            except Exception as exc:
                logger.warning("[FeishuImport] create link field failed: %s", exc)
                issues.append(f"创建关联字段失败 {raw_name}: {exc}")

    return link_field_map, degraded_text_fields


def _phase_c_fill_degraded_text(
    *,
    user,
    imported: Dict[TableKey, Dict[str, Any]],
    record_id_maps: Dict[TableKey, Dict[str, str]],
    link_spills: Dict[TableKey, Dict[str, Dict[str, List[str]]]],
    degraded_text_fields: Dict[TableKey, Set[str]],
    issues: List[str],
) -> None:
    """把未建 link 的 spill 写成文本（飞书 record_id 逗号拼接）。"""
    if not degraded_text_fields:
        return
    record_service = RecordService(user=user)
    for tkey, field_names in degraded_text_fields.items():
        if tkey not in imported or not field_names:
            continue
        id_map = record_id_maps.get(tkey) or {}
        spills = link_spills.get(tkey) or {}
        for feishu_rid, field_links in spills.items():
            self_uuid = id_map.get(feishu_rid)
            if not self_uuid:
                continue
            payload: Dict[str, Any] = {}
            for field_name, target_ids in field_links.items():
                if field_name not in field_names or not target_ids:
                    continue
                payload[field_name] = ", ".join(target_ids)
            if not payload:
                continue
            try:
                _updated, err = record_service.update_record(UUID(self_uuid), payload)
                if err:
                    issues.append(f"降级关联文本写入失败: {err}")
            except Exception as exc:
                issues.append(f"降级关联文本写入失败: {exc}")


def _phase_c_fill_links(
    *,
    user,
    imported: Dict[TableKey, Dict[str, Any]],
    record_id_maps: Dict[TableKey, Dict[str, str]],
    link_spills: Dict[TableKey, Dict[str, Dict[str, List[str]]]],
    link_field_map: Dict[TableKey, Dict[str, TableField]],
    issues: List[str],
) -> None:
    record_service = RecordService(user=user)
    record_maps_by_table_id = {
        str(info["tabdata_table_id"]): record_id_maps.get(tkey) or {}
        for tkey, info in imported.items()
    }

    for tkey, spills in link_spills.items():
        if tkey not in imported:
            continue
        fields_by_name = link_field_map.get(tkey) or {}
        id_map = record_id_maps.get(tkey) or {}
        for feishu_rid, field_links in spills.items():
            self_uuid = id_map.get(feishu_rid)
            if not self_uuid:
                continue

            payload: Dict[str, List[str]] = {}
            field_names: List[str] = []
            for field_name, target_feishu_ids in field_links.items():
                field = fields_by_name.get(field_name)
                if field is None:
                    continue
                foreign_table_id = (field.config or {}).get("foreignTableId")
                target_map = record_maps_by_table_id.get(str(foreign_table_id), {})
                linked_ids = [
                    target_map[fid]
                    for fid in target_feishu_ids
                    if fid in target_map
                ]
                if not linked_ids:
                    continue
                payload[str(field.id)] = linked_ids
                field_names.append(field_name)

            if not payload:
                continue

            location = (
                f"{imported[tkey]['name']}.{', '.join(field_names)}"
                f"（飞书记录 {feishu_rid}）"
            )
            try:
                _updated, err = record_service.update_record(UUID(self_uuid), payload)
                if err or _updated is None:
                    failure = err or "记录更新未返回结果"
                    logger.warning(
                        "[FeishuImport] link record update failed record=%s "
                        "feishu_record=%s fields=%s: %s",
                        self_uuid,
                        feishu_rid,
                        field_names,
                        failure,
                    )
                    issues.append(f"关联回填失败 {location}: {failure}")
            except Exception as exc:
                logger.warning(
                    "[FeishuImport] link record update failed record=%s "
                    "feishu_record=%s fields=%s: %s",
                    self_uuid,
                    feishu_rid,
                    field_names,
                    exc,
                )
                issues.append(f"关联回填失败 {location}: {exc}")


def _phase_d_attachments(
    *,
    client: FeishuClient,
    access_token: str,
    user,
    organization_id: UUID,
    imported: Dict[TableKey, Dict[str, Any]],
    record_id_maps: Dict[TableKey, Dict[str, str]],
    attachment_spills: Dict[TableKey, Dict[str, Dict[str, List[Dict[str, Any]]]]],
    issues: List[str],
) -> None:
    from apps.services.oss.services.factory import get_oss_service
    from apps.services.oss.services.file_registry import FileRegistryService
    from apps.tabdata.services.attachment_service import AttachmentService

    oss = get_oss_service()
    user_id = str(getattr(user, "id", "") or "")
    record_service = RecordService(user=user)
    attachment_service = AttachmentService(user=user)

    for tkey, spills in attachment_spills.items():
        if tkey not in imported:
            continue
        tabdata_table_id = imported[tkey]["tabdata_table_id"]
        attach_fields = {
            f.name: f
            for f in TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=tabdata_table_id,
                field_type="attachment",
                is_deleted=False,
            )
        }
        id_map = record_id_maps.get(tkey) or {}

        for feishu_rid, field_atts in spills.items():
            self_uuid = id_map.get(feishu_rid)
            if not self_uuid:
                continue

            update_payload: Dict[str, Any] = {}
            for field_name, items in field_atts.items():
                if field_name not in attach_fields:
                    continue
                cell: List[Dict[str, Any]] = []
                for att in items[:MAX_ATTACHMENTS_PER_CELL]:
                    try:
                        declared_size = int(att.get("size") or 0)
                        if declared_size > MAX_ATTACHMENT_BYTES:
                            raise FeishuAPIError(
                                f"附件超过上限 {MAX_ATTACHMENT_BYTES} 字节"
                            )
                        content = client.download_media(
                            access_token,
                            att.get("file_token") or "",
                            tmp_url=att.get("tmp_url") or "",
                        )
                        if not content:
                            raise FeishuAPIError("空附件内容")
                        if len(content) > MAX_ATTACHMENT_BYTES:
                            raise FeishuAPIError(
                                f"附件超过上限 {MAX_ATTACHMENT_BYTES} 字节"
                            )
                        raw_name = att.get("name") or "attachment"
                        # 净化文件名，避免 OSS key 注入路径分隔符
                        file_name = (
                            str(raw_name).replace("\\", "_").replace("/", "_").strip()
                            or "attachment"
                        )[:180]
                        mime = att.get("type") or "application/octet-stream"
                        stamp = timezone.now().strftime("%Y%m%d%H%M%S")
                        object_key = (
                            f"feishu_import/{organization_id}/{tabdata_table_id}/"
                            f"{stamp}_{uuid_mod.uuid4().hex[:8]}_{file_name}"
                        )
                        oss.upload_bytes(content, object_key, content_type=mime)
                        if not oss.set_object_private(object_key):
                            try:
                                oss.delete_file(object_key)
                            except Exception:
                                logger.error(
                                    "[FeishuImport] private ACL cleanup failed key=%s",
                                    object_key,
                                )
                            raise FeishuAPIError("私有附件访问权限设置失败")
                        # 飞书附件属于组织内表格数据，不能通过 public-read ACL
                        # 绕过 TabData 权限。持久层只保存私有 FileRecord + file_id；
                        # 单元格只保存稳定 file_id；记录更新后的引用同步会建立
                        # table/record/field/file 绑定，读取时再按表格权限换签。
                        file_record = FileRegistryService.register_uploaded_file(
                            object_key=object_key,
                            file_name=file_name,
                            file_size=len(content),
                            content_type=mime,
                            module="tabdata",
                            user_id=user_id,
                            organization_id=str(organization_id),
                            context_type="feishu_import",
                            context_id=str(tabdata_table_id),
                            upload_source="feishu_import",
                            is_public=False,
                        )
                        cell.append(
                            {
                                "file_id": str(file_record.id),
                                "name": file_name,
                                "size": len(content),
                                "mime_type": mime,
                                "url": "",
                            }
                        )
                    except Exception as exc:
                        logger.warning(
                            "[FeishuImport] attachment failed table=%s file=%s: %s",
                            tabdata_table_id, att.get("name"), exc,
                        )
                        issues.append(
                            f"附件「{att.get('name') or '?'}」导入失败: {exc}"
                        )
                if len(items) > MAX_ATTACHMENTS_PER_CELL:
                    issues.append(
                        f"字段「{field_name}」附件超过单格上限 "
                        f"{MAX_ATTACHMENTS_PER_CELL}，已截断"
                    )
                if cell:
                    update_payload[field_name] = cell

            if not update_payload:
                continue
            try:
                updated, err = record_service.update_record(
                    UUID(self_uuid),
                    update_payload,
                )
                if err:
                    issues.append(f"附件单元格写入失败: {err}")
                    continue
                if updated is not None:
                    try:
                        attachment_service.sync_record_attachments(record=updated)
                    except Exception as sync_exc:
                        logger.warning(
                            "[FeishuImport] sync_record_attachments failed: %s", sync_exc,
                        )
            except Exception as exc:
                issues.append(f"附件单元格写入失败: {exc}")
