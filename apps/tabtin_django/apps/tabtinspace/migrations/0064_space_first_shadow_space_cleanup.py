from __future__ import annotations

import json
import logging

from django.db import migrations, transaction
from django.db.migrations.exceptions import IrreversibleError


logger = logging.getLogger(__name__)

MIGRATION_NAME = "0064_space_first_shadow_space_cleanup"
AUDIT_TABLE = "tabtinspace_shadow_space_cleanup_audit"
SHADOW_SPACE_TYPES = ("dm", "group")

# Dogfood databases showed that some real resources were accidentally created
# under legacy dm/group shadow Spaces. Because the product has not launched, the
# clean migration is to relocate those real references to a same-workteam bot
# Space, then delete the retired shadow Space. Audit/log-only soft references
# are intentionally omitted: stale historical IDs are useful for incident
# forensics, while they must not keep a retired shadow Space alive.
RELOCATABLE_DIRECT_REFS = (
    ("ContextItem", "tabtinspace_context_item", "space_id"),
    ("SpaceCheckpoint", "collab_space_checkpoint", "space_id"),
    ("Tracker", "tracker", "space_id"),
    ("TableWebhook", "tabdata_webhook", "space_id"),
    ("TableApiToken.space_id", "tabdata_api_token", "space_id"),
    ("Table", "tabdata_table", "space_id"),
    ("TableAttachmentUpload", "tabdata_attachment_upload", "space_id"),
    ("TableAttachmentReference", "tabdata_attachment_reference", "space_id"),
    ("CheckpointRollbackSaga", "tabdata_checkpoint_rollback_saga", "space_id"),
    ("ComputedOutbox.space_id", "tabdata_computed_outbox", "space_id"),
    ("ComputedOutbox.base_id", "tabdata_computed_outbox", "base_id"),
    ("ComputedOutboxDLQ.space_id", "tabdata_computed_outbox_dlq", "space_id"),
    ("ComputedOutboxDLQ.base_id", "tabdata_computed_outbox_dlq", "base_id"),
    ("Document", "tabdoc_document", "space_id"),
    ("SlideProject", "tabslide_project", "space_id"),
    ("VideoProject", "tabvideo_project", "space_id"),
    ("Canvas", "tabwhiteboard_canvas", "space_id"),
    ("Memo", "tabmemo_memo", "space_id"),
    ("MemoCollection", "tabmemo_collection", "space_id"),
    ("MemoAgentGrant", "tabmemo_agent_grant", "target_space_id"),
    ("Site", "tabsite_site", "space_id"),
    ("CodeProject", "tabcode_code_project", "space_id"),
    ("Tin", "tins_tin", "space_id"),
    ("TinInstance", "tins_instance", "space_id"),
    ("ChatSession", "chat_session", "space_id"),
    ("ChatContext.current_space_id", "chat_context", "current_space_id"),
    ("AgentEngineSubtaskRun.current_space_id", "agent_engine_subtask_runs", "current_space_id"),
    ("AgentEngineSubAgentTemplate", "agent_engine_subagent_templates", "space_id"),
    ("AgentEngineResourceOpenEvent", "agent_engine_resource_open_event", "space_id"),
    ("TabDataDbConnection", "tabdata_db_readonly_connection", "space_id"),
    ("TabDataConnector", "tabdata_connector", "space_id"),
    ("SkillEnablement", "skills_enablement", "space_id"),
    ("RagTableEmbedding", "rag_table_embedding", "space_id"),
    ("RagRecordEmbedding", "rag_record_embedding", "space_id"),
    ("RagEmbeddingTask", "rag_embedding_task", "space_id"),
    ("RagSearchLog", "rag_search_log", "space_id"),
    ("RagDocumentEmbedding", "rag_document_embedding", "space_id"),
    ("RagCodeChunkEmbedding", "rag_code_chunk_embedding", "space_id"),
    ("ExtensionConnection", "ext_connection", "space_id"),
    ("ExtensionEventLog", "ext_event_log", "space_id"),
    ("ExtensionNotificationRule", "ext_notification_rule", "space_id"),
    ("ExtensionWebhookSubscription", "ext_webhook_subscription", "space_id"),
    ("TabMailThread.handling_space_id", "tabmail_thread", "handling_space_id"),
    ("TabMailMessage.handling_space_id", "tabmail_message", "handling_space_id"),
    ("TabMailDraft.handling_space_id", "tabmail_draft", "handling_space_id"),
    ("TabMailDraft.space_id", "tabmail_draft", "space_id"),
    ("ChannelGatewayBinding.handling_space_id", "channel_gateway_binding", "handling_space_id"),
    ("ChannelGatewayBinding.space_id", "channel_gateway_binding", "space_id"),
)

RELOCATABLE_JSON_REFS = (
    ("TableApiToken.space_ids", "tabdata_api_token", "space_ids"),
    ("ChatContext.recent_spaces", "chat_context", "recent_spaces"),
)


def _quote(connection, name: str) -> str:
    return connection.ops.quote_name(name)


def _table_columns(connection, table_name: str) -> set[str]:
    with connection.cursor() as cursor:
        description = connection.introspection.get_table_description(cursor, table_name)
    return {getattr(column, "name", column[0]) for column in description}


def _existing_tables(connection) -> set[str]:
    with connection.cursor() as cursor:
        return set(connection.introspection.table_names(cursor))


def _count_direct_refs(connection, table_name: str, column_name: str, target_ids: list[str]) -> dict | None:
    if not target_ids:
        return None

    tables = _existing_tables(connection)
    if table_name not in tables:
        return None
    columns = _table_columns(connection, table_name)
    if column_name not in columns:
        return None

    placeholders = ", ".join(["%s"] * len(target_ids))
    table_sql = _quote(connection, table_name)
    column_sql = _quote(connection, column_name)
    id_sql = _quote(connection, "id") if "id" in columns else None

    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT COUNT(*) FROM {table_sql} WHERE {column_sql} IN ({placeholders})",
            target_ids,
        )
        count = int(cursor.fetchone()[0] or 0)
        samples: list[str] = []
        if count and id_sql:
            cursor.execute(
                f"SELECT {id_sql} FROM {table_sql} WHERE {column_sql} IN ({placeholders}) LIMIT 5",
                target_ids,
            )
            samples = [str(row[0]) for row in cursor.fetchall()]

    return {"count": count, "samples": samples}


def _count_json_refs(connection, table_name: str, column_name: str, target_ids: list[str]) -> dict | None:
    if not target_ids:
        return None
    if connection.vendor != "postgresql":
        raise RuntimeError(
            f"{MIGRATION_NAME} requires PostgreSQL JSONB checks for {table_name}.{column_name}"
        )

    tables = _existing_tables(connection)
    if table_name not in tables:
        return None
    columns = _table_columns(connection, table_name)
    if column_name not in columns:
        return None

    placeholders = ", ".join(["%s"] * len(target_ids))
    table_sql = _quote(connection, table_name)
    column_sql = _quote(connection, column_name)
    id_sql = _quote(connection, "id") if "id" in columns else None

    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT COUNT(*) FROM {table_sql} WHERE {column_sql} ?| ARRAY[{placeholders}]",
            target_ids,
        )
        count = int(cursor.fetchone()[0] or 0)
        samples: list[str] = []
        if count and id_sql:
            cursor.execute(
                f"SELECT {id_sql} FROM {table_sql} "
                f"WHERE {column_sql} ?| ARRAY[{placeholders}] LIMIT 5",
                target_ids,
            )
            samples = [str(row[0]) for row in cursor.fetchall()]

    return {"count": count, "samples": samples}


def _update_direct_refs(connection, table_name: str, column_name: str, old_id: str, new_id: str) -> int:
    tables = _existing_tables(connection)
    if table_name not in tables:
        return 0
    columns = _table_columns(connection, table_name)
    if column_name not in columns:
        return 0

    table_sql = _quote(connection, table_name)
    column_sql = _quote(connection, column_name)
    with connection.cursor() as cursor:
        cursor.execute(
            f"UPDATE {table_sql} SET {column_sql} = %s WHERE {column_sql} = %s",
            [new_id, old_id],
        )
        return int(cursor.rowcount or 0)


def _update_json_refs(connection, table_name: str, column_name: str, old_id: str, new_id: str) -> int:
    if connection.vendor != "postgresql":
        raise RuntimeError(
            f"{MIGRATION_NAME} requires PostgreSQL JSON checks for {table_name}.{column_name}"
        )

    tables = _existing_tables(connection)
    if table_name not in tables:
        return 0
    columns = _table_columns(connection, table_name)
    if column_name not in columns or "id" not in columns:
        return 0

    table_sql = _quote(connection, table_name)
    column_sql = _quote(connection, column_name)
    id_sql = _quote(connection, "id")
    changed = 0

    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT {id_sql}, {column_sql} FROM {table_sql} WHERE {column_sql} ?| ARRAY[%s]",
            [old_id],
        )
        for row_id, refs in cursor.fetchall():
            if isinstance(refs, str):
                try:
                    refs = json.loads(refs)
                except (TypeError, ValueError):
                    continue
            if not isinstance(refs, list):
                continue
            next_refs: list[str] = []
            for ref in refs:
                next_ref = new_id if str(ref) == old_id else str(ref)
                if next_ref not in next_refs:
                    next_refs.append(next_ref)
            if next_refs == refs:
                continue
            cursor.execute(
                f"UPDATE {table_sql} SET {column_sql} = %s WHERE {id_sql} = %s",
                [json.dumps(next_refs), row_id],
            )
            changed += 1
    return changed


def _ensure_audit_table(connection) -> None:
    if connection.vendor != "postgresql":
        raise RuntimeError(f"{MIGRATION_NAME} requires PostgreSQL; got {connection.vendor}")

    audit_table = _quote(connection, AUDIT_TABLE)
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {audit_table} (
                id bigserial PRIMARY KEY,
                migration_name varchar(128) NOT NULL,
                action varchar(64) NOT NULL,
                conversation_id uuid NULL,
                old_space_id uuid NULL,
                space_type varchar(20) NOT NULL DEFAULT '',
                details jsonb NOT NULL DEFAULT '{{}}'::jsonb,
                created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute(
            f"""
            CREATE INDEX IF NOT EXISTS {AUDIT_TABLE}_old_space_idx
            ON {audit_table} (old_space_id, action)
            """
        )


def _insert_audit_rows(connection, rows: list[dict]) -> None:
    if not rows:
        return

    audit_table = _quote(connection, AUDIT_TABLE)
    params = [
        (
            MIGRATION_NAME,
            row["action"],
            row.get("conversation_id"),
            row.get("old_space_id"),
            row.get("space_type", ""),
            json.dumps(row.get("details", {}), sort_keys=True),
        )
        for row in rows
    ]
    with connection.cursor() as cursor:
        cursor.executemany(
            f"""
            INSERT INTO {audit_table}
                (migration_name, action, conversation_id, old_space_id, space_type, details)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb)
            """,
            params,
        )


def _find_blocking_refs(connection, target_ids: list[str]) -> list[dict]:
    blockers: list[dict] = []

    for label, table_name, column_name in RELOCATABLE_DIRECT_REFS:
        result = _count_direct_refs(connection, table_name, column_name, target_ids)
        if result and result["count"]:
            blockers.append(
                {
                    "label": label,
                    "table": table_name,
                    "column": column_name,
                    "count": result["count"],
                    "samples": result["samples"],
                }
            )

    for label, table_name, column_name in RELOCATABLE_JSON_REFS:
        result = _count_json_refs(connection, table_name, column_name, target_ids)
        if result and result["count"]:
            blockers.append(
                {
                    "label": label,
                    "table": table_name,
                    "column": column_name,
                    "count": result["count"],
                    "samples": result["samples"],
                }
            )

    return blockers


def _select_target_bot_spaces(shadow_spaces: list[dict], Space, db_alias: str) -> dict[str, str]:
    workteam_ids = {item["workteam_id"] for item in shadow_spaces}
    bot_spaces = list(
        Space.objects.using(db_alias)
        .filter(
            workteam_id__in=workteam_ids,
            type="bot",
            status="active",
            is_archived=False,
            trashed_at__isnull=True,
        )
        .values("id", "workteam_id", "is_default", "created_at")
        .order_by("workteam_id", "-is_default", "created_at", "id")
    )

    target_by_workteam: dict[str, str] = {}
    for item in bot_spaces:
        target_by_workteam.setdefault(str(item["workteam_id"]), str(item["id"]))

    missing = [
        str(item["id"])
        for item in shadow_spaces
        if str(item["workteam_id"]) not in target_by_workteam
    ]
    if missing:
        raise RuntimeError(
            f"{MIGRATION_NAME} aborted: cannot relocate shadow Spaces without active bot Space. "
            f"shadow_space_ids={missing[:20]}"
        )

    return {
        str(item["id"]): target_by_workteam[str(item["workteam_id"])]
        for item in shadow_spaces
    }


def _relocate_shadow_space_refs(connection, target_by_shadow_space: dict[str, str]) -> list[dict]:
    audit_rows: list[dict] = []
    for old_id, new_id in target_by_shadow_space.items():
        for label, table_name, column_name in RELOCATABLE_DIRECT_REFS:
            count = _update_direct_refs(connection, table_name, column_name, old_id, new_id)
            if count:
                audit_rows.append(
                    {
                        "action": "shadow_space_ref_relocate",
                        "old_space_id": old_id,
                        "details": {
                            "target_space_id": new_id,
                            "label": label,
                            "table": table_name,
                            "column": column_name,
                            "count": count,
                        },
                    }
                )

        for label, table_name, column_name in RELOCATABLE_JSON_REFS:
            count = _update_json_refs(connection, table_name, column_name, old_id, new_id)
            if count:
                audit_rows.append(
                    {
                        "action": "shadow_space_json_ref_relocate",
                        "old_space_id": old_id,
                        "details": {
                            "target_space_id": new_id,
                            "label": label,
                            "table": table_name,
                            "column": column_name,
                            "count": count,
                        },
                    }
                )
    return audit_rows


def _raise_if_blocked(connection, target_ids: list[str]) -> None:
    blockers = _find_blocking_refs(connection, target_ids)
    if not blockers:
        return

    details = "; ".join(
        (
            f"{item['label']}({item['table']}.{item['column']}) "
            f"count={item['count']} samples={item['samples']}"
        )
        for item in blockers
    )
    raise RuntimeError(
        f"{MIGRATION_NAME} aborted: dm/group shadow Spaces still have real references. "
        f"space_ids={target_ids[:20]} blockers={details}"
    )


def cleanup_shadow_spaces(apps, schema_editor):
    """Detach and delete legacy dm/group shadow Spaces.

    Rollback boundary: before mutating references this migration writes audit
    rows for ``(conversation_id, old_space_id)`` and every
    ``old_space_id -> target_bot_space_id`` relocation. Deleted shadow Spaces
    and SpaceMembership rows are not reconstructed by reverse migration;
    restoring them requires using that audit table plus a database backup for
    deleted rows.
    """
    connection = schema_editor.connection
    db_alias = connection.alias

    if connection.vendor != "postgresql":
        raise RuntimeError(f"{MIGRATION_NAME} requires PostgreSQL; got {connection.vendor}")

    Space = apps.get_model("tabtinspace", "Space")
    SpaceMembership = apps.get_model("tabtinspace", "SpaceMembership")
    Conversation = apps.get_model("tabchat", "Conversation")

    with transaction.atomic(using=db_alias):
        _ensure_audit_table(connection)

        shadow_spaces = list(
            Space.objects.using(db_alias)
            .filter(type__in=SHADOW_SPACE_TYPES)
            .values("id", "type", "workteam_id")
            .order_by("id")
        )
        shadow_space_ids = [item["id"] for item in shadow_spaces]
        shadow_space_id_strings = [str(space_id) for space_id in shadow_space_ids]
        shadow_type_by_id = {
            str(item["id"]): item["type"]
            for item in shadow_spaces
        }

        team_space_count = Space.objects.using(db_alias).filter(type="team").count()
        audit_rows: list[dict] = [
            {
                "action": "team_space_audit",
                "details": {"team_space_count": team_space_count, "physical_delete": False},
            }
        ]

        if not shadow_space_ids:
            _insert_audit_rows(connection, audit_rows)
            logger.info("[%s] no dm/group shadow Spaces found; team_space_count=%d", MIGRATION_NAME, team_space_count)
            return

        conversation_pairs = list(
            Conversation.objects.using(db_alias)
            .filter(space_id__in=shadow_space_ids)
            .values_list("id", "space_id")
            .order_by("id")
        )
        audit_rows.extend(
            {
                "action": "conversation_space_detach",
                "conversation_id": str(conversation_id),
                "old_space_id": str(old_space_id),
                "space_type": shadow_type_by_id.get(str(old_space_id), ""),
            }
            for conversation_id, old_space_id in conversation_pairs
        )
        audit_rows.extend(
            {
                "action": "shadow_space_delete",
                "old_space_id": str(item["id"]),
                "space_type": item["type"],
            }
            for item in shadow_spaces
        )
        _insert_audit_rows(connection, audit_rows)

        target_by_shadow_space = _select_target_bot_spaces(
            shadow_spaces,
            Space,
            db_alias,
        )
        relocation_audit_rows = [
            {
                "action": "shadow_space_relocation_target",
                "old_space_id": old_id,
                "space_type": shadow_type_by_id.get(old_id, ""),
                "details": {"target_space_id": target_id},
            }
            for old_id, target_id in target_by_shadow_space.items()
        ]
        relocation_audit_rows.extend(
            _relocate_shadow_space_refs(connection, target_by_shadow_space)
        )
        _insert_audit_rows(connection, relocation_audit_rows)

        detached_count = (
            Conversation.objects.using(db_alias)
            .filter(space_id__in=shadow_space_ids)
            .update(space_id=None)
        )

        _raise_if_blocked(connection, shadow_space_id_strings)

        membership_deleted, _ = (
            SpaceMembership.objects.using(db_alias)
            .filter(space_id__in=shadow_space_ids)
            .delete()
        )
        space_deleted, _ = (
            Space.objects.using(db_alias)
            .filter(id__in=shadow_space_ids, type__in=SHADOW_SPACE_TYPES)
            .delete()
        )

        logger.info(
            "[%s] detached_conversations=%d deleted_memberships=%d deleted_shadow_spaces=%d team_space_count=%d",
            MIGRATION_NAME,
            detached_count,
            membership_deleted,
            space_deleted,
            team_space_count,
        )


def reverse_cleanup_shadow_spaces(apps, schema_editor):
    raise IrreversibleError(
        f"{MIGRATION_NAME} cannot reconstruct deleted dm/group shadow Spaces. "
        f"Use {AUDIT_TABLE} for (conversation_id, old_space_id) detach records "
        "and restore deleted Space rows from backup if a rollback is required."
    )


class Migration(migrations.Migration):
    dependencies = [
        ("tabchat", "0005_remove_conversationmember_tabchat_member_conv_user_uniq_and_more"),
        ("tabtinspace", "0063_merge_20260620_1540"),
    ]

    operations = [
        migrations.RunPython(cleanup_shadow_spaces, reverse_cleanup_shadow_spaces),
    ]
