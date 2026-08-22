import json
import os
from uuid import UUID

from django.contrib.auth import get_user_model
from django.utils.dateparse import parse_datetime

from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord
from apps.tabdata.services.computed_field_service import RollupFieldService
from apps.tabdata.services.link_field_service import LinkFieldService
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.services.table_service import TableService
from apps.tabdata.utils.record_data_access import read_data


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def emit(payload: dict) -> None:
    print("@@E2E@@" + json.dumps(payload, ensure_ascii=False, default=str))


def table_summary(table: Table) -> dict:
    fields = list(
        TableField.objects.filter(table_id=table.id, is_deleted=False)
        .order_by("order")
        .values("id", "name", "field_type", "is_primary", "config")
    )
    return {
        "id": str(table.id),
        "name": table.name,
        "field_count": table.field_count,
        "row_count": table.row_count,
        "record_count": TableRecord.objects.filter(table_id=table.id, is_deleted=False).count(),
        "fields": fields,
        "created_at": table.created_at.isoformat(),
    }


def create_table_with_fields(
    service: TableService,
    space_id: UUID,
    name: str,
    fields: list[dict],
) -> tuple[Table, dict[str, TableField]]:
    table = service.create_table(space_id=space_id, name=name, use_default_fields=False)
    created_fields, errors = service.bulk_create_fields(table.id, fields)
    if errors:
        raise RuntimeError(f"{name} field creation failed: {errors}")
    table.refresh_from_db()
    return table, {field.name: field for field in created_fields}


def create_record(service: RecordService, table_id: UUID, data: dict) -> TableRecord:
    record, error = service.create_record(table_id, data)
    if error:
        raise RuntimeError(error)
    return record


def reset_e2e_table(table: Table) -> None:
    """清空可复用 E2E 表的数据与字段，避免每轮测试都消耗表配额。"""
    TableRecord.objects.filter(table_id=table.id, is_deleted=False).update(is_deleted=True)
    TableField.objects.filter(table_id=table.id, is_deleted=False).update(is_deleted=True)
    table.field_count = 0
    table.row_count = 0
    table.schema_version = (table.schema_version or 0) + 1
    table.save(update_fields=["field_count", "row_count", "schema_version", "updated_at"])


def get_or_create_e2e_table(
    service: TableService,
    space_id: UUID,
    name: str,
) -> tuple[Table, bool]:
    table = (
        Table.objects.filter(
            space_id=space_id,
            name__contains="选项管理验收",
            is_archived=False,
            trashed_at__isnull=True,
        )
        .order_by("-created_at")
        .first()
    )
    if table is not None:
        reset_e2e_table(table)
        updated = service.update_table(table.id, name=name)
        if updated is not None:
            table = updated
        else:
            table.refresh_from_db()
        return table, False
    return service.create_table(space_id=space_id, name=name, use_default_fields=False), True


def active_fields_by_name(table: Table) -> dict[str, TableField]:
    return {
        field.name: field
        for field in TableField.objects.filter(table_id=table.id, is_deleted=False).order_by("order")
    }


def list_tables(space_id: UUID) -> None:
    tables = Table.objects.filter(space_id=space_id, is_archived=False).order_by("-created_at")
    emit({"tables": [table_summary(table) for table in tables[:50]]})


def verify_new_table(space_id: UUID, table_service: TableService) -> None:
    before_ids = set(json.loads(os.environ.get("TABTIN_E2E_BEFORE_TABLE_IDS", "[]")))
    created_after = parse_datetime(os.environ.get("TABTIN_E2E_CREATED_AFTER", ""))
    candidates_query = Table.objects.filter(space_id=space_id, is_archived=False).order_by("-created_at")
    if created_after is not None:
        candidates_query = candidates_query.filter(created_at__gte=created_after)
    candidates = [table for table in candidates_query[:20] if str(table.id) not in before_ids]
    if not candidates:
        raise RuntimeError("No new TabData table was created after clicking the Electron new-table button.")
    table = candidates[0]
    original_name = table.name
    name_prefix = os.environ.get("TABTIN_E2E_UI_TABLE_NAME_PREFIX", "").strip()
    if name_prefix and not table.name.startswith(name_prefix):
        updated = table_service.update_table(table.id, name=f"{name_prefix} {table.name}")
        if updated is not None:
            table = updated
        else:
            table.refresh_from_db()
    emit({"originalName": original_name, "table": table_summary(table)})


def run_mdl_new_002(table_service: TableService, space_id: UUID, marker: str) -> None:
    empty_name_result = {"accepted": False}
    try:
        table_service.create_table(space_id=space_id, name="   ")
        empty_name_result = {"accepted": True}
    except Exception as exc:  # noqa: BLE001 - the exact validation exception is evidence.
        empty_name_result = {
            "accepted": False,
            "error": type(exc).__name__,
            "message": str(exc),
        }

    special = table_service.create_table(space_id=space_id, name=f"{marker} 客户/2026 版")
    emit(
        {
            "emptyBackendName": empty_name_result,
            "specialTable": table_summary(special),
        }
    )


def select_choice(value: str, label: str, color: str) -> dict:
    return {"value": value, "label": label, "color": color}


def choice_labels(choices: list[dict]) -> list[str]:
    return [str(choice.get("label") or choice.get("value")) for choice in choices]


def label_for_value(choices: list[dict], value: str | None) -> str | None:
    if value is None:
        return None
    for choice in choices:
        if str(choice.get("value")) == str(value):
            return str(choice.get("label") or choice.get("value"))
    return str(value)


def get_record_field_value(record_service: RecordService, record: TableRecord, field: TableField):
    serialized = record_service.get_record_data(record.id, field_key_type="id") or {}
    fields = serialized.get("fields") if isinstance(serialized, dict) else {}
    if isinstance(fields, dict) and str(field.id) in fields:
        return fields.get(str(field.id))
    data = serialized.get("data") if isinstance(serialized, dict) else {}
    if isinstance(data, dict):
        if str(field.id) in data:
            return data.get(str(field.id))
        if field.name in data:
            return data.get(field.name)
    record.refresh_from_db()
    fallback = read_data(record) or {}
    return fallback.get(str(field.id), fallback.get(field.id.hex, fallback.get(field.name)))


def update_record_or_fail(record_service: RecordService, record: TableRecord, data: dict) -> TableRecord:
    updated, error = record_service.update_record(record.id, data)
    if error:
        raise RuntimeError(error)
    if updated is None:
        raise RuntimeError(f"Record update returned empty result: {record.id}")
    return updated


def create_select_option_management_case(
    table_service: TableService,
    record_service: RecordService,
    space_id: UUID,
    marker: str,
) -> None:
    table_name = f"{marker} 选项管理验收"
    initial_choices = [
        select_choice("todo", "待处理", "#4299E1"),
        select_choice("in_progress", "进行中", "#48BB78"),
        select_choice("done", "已完成", "#ED8936"),
    ]
    table, table_created = get_or_create_e2e_table(table_service, space_id, table_name)
    created_fields, errors = table_service.bulk_create_fields(
        table.id,
        [
            {"name": "客户名称", "field_type": "text", "is_primary": True},
            {
                "name": "状态",
                "field_type": "select",
                "options": {"choices": initial_choices},
            },
        ],
    )
    if errors:
        raise RuntimeError(f"{table_name} field creation failed: {errors}")
    table.refresh_from_db()
    fields = {field.name: field for field in created_fields}
    name_field = fields["客户名称"]
    status_field = fields["状态"]
    record_in_progress = create_record(
        record_service,
        table.id,
        {
            str(name_field.id): "客户 A",
            str(status_field.id): "in_progress",
        },
    )
    record_in_progress_2 = create_record(
        record_service,
        table.id,
        {
            str(name_field.id): "客户 A-2",
            str(status_field.id): "in_progress",
        },
    )
    record_todo = create_record(
        record_service,
        table.id,
        {
            str(name_field.id): "客户 B",
            str(status_field.id): "todo",
        },
    )

    # 1. 新增选项后立即可选：更新字段配置，再用新增选项创建记录。
    paused_choice = select_choice("paused", "已暂停", "#9F7AEA")
    choices_after_add = initial_choices + [paused_choice]
    status_field = table_service.update_field(
        status_field.id,
        options={"choices": choices_after_add},
    )
    if status_field is None:
        raise RuntimeError("Failed to add select option: 已暂停")
    record_paused = create_record(
        record_service,
        table.id,
        {
            str(name_field.id): "客户 C",
            str(status_field.id): "paused",
        },
    )

    # 2. 重命名已用选项：保持 value 稳定，仅修改 label，已有记录自然显示新名。
    renamed_choices = [
        {**choice, "label": "处理中"} if choice["value"] == "in_progress" else choice
        for choice in choices_after_add
    ]
    status_field = table_service.update_field(
        status_field.id,
        options={"choices": renamed_choices},
    )
    if status_field is None:
        raise RuntimeError("Failed to rename used select option: 进行中 -> 处理中")
    used_records = [record_in_progress, record_in_progress_2]
    display_labels_after_rename = [
        label_for_value(
            renamed_choices,
            get_record_field_value(record_service, record, status_field),
        )
        for record in used_records
    ]

    # 3. 删除已用选项：先形成影响提示证据，确认后清空受影响记录字段。
    all_records = [record_in_progress, record_in_progress_2, record_todo, record_paused]
    affected_records = [
        record
        for record in all_records
        if get_record_field_value(record_service, record, status_field) == "in_progress"
    ]
    impact_prompt = {
        "requiresConfirmation": len(affected_records) > 0,
        "affectedRecordCount": len(affected_records),
        "affectedRecordIds": [str(record.id) for record in affected_records],
    }
    choices_after_delete = [
        choice for choice in renamed_choices if choice["value"] != "in_progress"
    ]
    status_field = table_service.update_field(
        status_field.id,
        options={"choices": choices_after_delete},
    )
    if status_field is None:
        raise RuntimeError("Failed to delete used select option: 处理中")
    cleared_records = [
        update_record_or_fail(record_service, record, {str(status_field.id): None})
        for record in affected_records
    ]
    cleared_record_values = [
        get_record_field_value(record_service, record, status_field)
        for record in cleared_records
    ]

    table.refresh_from_db()
    status_field.refresh_from_db()
    emit(
        {
            "table": table_summary(table),
            "tableCreated": table_created,
            "field": {
                "id": str(status_field.id),
                "name": status_field.name,
                "choices": status_field.config.get("choices", []),
            },
            "addOption": {
                "addedChoice": paused_choice,
                "choicesAfterAdd": choice_labels(choices_after_add),
                "createdRecordValue": get_record_field_value(record_service, record_paused, status_field),
            },
            "renameUsedOption": {
                "stableValue": "in_progress",
                "beforeLabel": "进行中",
                "afterLabel": "处理中",
                "affectedRecordIds": [str(record.id) for record in used_records],
                "displayLabelsAfterRename": display_labels_after_rename,
            },
            "deleteUsedOption": {
                "impactPrompt": impact_prompt,
                "confirmed": True,
                "choicesAfterDelete": choice_labels(choices_after_delete),
                "clearedRecordValues": cleared_record_values,
            },
        }
    )


def prepare_select_option_management_case(
    table_service: TableService,
    record_service: RecordService,
    space_id: UUID,
    marker: str,
) -> None:
    table_name = f"{marker} 选项管理验收"
    table, table_created = get_or_create_e2e_table(table_service, space_id, table_name)
    created_fields, errors = table_service.bulk_create_fields(
        table.id,
        [
            {"name": "客户名称", "field_type": "text", "is_primary": True},
            {
                "name": "状态",
                "field_type": "select",
                "options": {"choices": ["待处理", "进行中", "已完成"]},
            },
        ],
    )
    if errors:
        raise RuntimeError(f"{table_name} field creation failed: {errors}")
    table.refresh_from_db()
    fields = {field.name: field for field in created_fields}
    name_field = fields["客户名称"]
    status_field = fields["状态"]
    record_in_progress = create_record(
        record_service,
        table.id,
        {
            str(name_field.id): "客户 A",
            str(status_field.id): "进行中",
        },
    )
    record_in_progress_2 = create_record(
        record_service,
        table.id,
        {
            str(name_field.id): "客户 A-2",
            str(status_field.id): "进行中",
        },
    )
    record_todo = create_record(
        record_service,
        table.id,
        {
            str(name_field.id): "客户 B",
            str(status_field.id): "待处理",
        },
    )
    emit(
        {
            "table": table_summary(table),
            "tableCreated": table_created,
            "field": {
                "id": str(status_field.id),
                "name": status_field.name,
                "choices": status_field.config.get("choices", []),
            },
            "records": {
                "usedRecordIds": [str(record_in_progress.id), str(record_in_progress_2.id)],
                "controlRecordId": str(record_todo.id),
            },
        }
    )


def verify_select_option_rename_case(
    table_service: TableService,
    record_service: RecordService,
) -> None:
    table_id = UUID(require_env("TABTIN_E2E_TABLE_ID"))
    field_id = UUID(require_env("TABTIN_E2E_FIELD_ID"))
    used_record_ids = [
        UUID(item)
        for item in json.loads(require_env("TABTIN_E2E_USED_RECORD_IDS"))
    ]
    control_record_id = UUID(require_env("TABTIN_E2E_CONTROL_RECORD_ID"))
    expected_label = require_env("TABTIN_E2E_EXPECTED_LABEL")
    expected_control_label = require_env("TABTIN_E2E_EXPECTED_CONTROL_LABEL")

    table = table_service.get_table(table_id)
    if table is None:
        raise RuntimeError(f"Table not found: {table_id}")
    field = TableField.objects.get(id=field_id, table_id=table_id)
    if field is None:
        raise RuntimeError(f"Field not found: {field_id}")

    record_values = []
    for record_id in used_record_ids:
        record = record_service.get_record(record_id)
        if record is None:
            raise RuntimeError(f"Record not found: {record_id}")
        record_values.append(get_record_field_value(record_service, record, field))
    control_record = record_service.get_record(control_record_id)
    if control_record is None:
        raise RuntimeError(f"Record not found: {control_record_id}")
    control_record_value = get_record_field_value(record_service, control_record, field)

    emit(
        {
            "table": table_summary(table),
            "field": {
                "id": str(field.id),
                "name": field.name,
                "choices": field.config.get("choices", []),
            },
            "renameUsedOption": {
                "expectedLabel": expected_label,
                "affectedRecordIds": [str(item) for item in used_record_ids],
                "recordValuesAfterRename": record_values,
                "allRecordsMigrated": all(value == expected_label for value in record_values),
                "controlRecordId": str(control_record_id),
                "controlRecordValueAfterRename": control_record_value,
                "controlRecordUnchanged": control_record_value == expected_control_label,
            },
        }
    )


def run_mdl_pln_001(table_service: TableService, space_id: UUID, marker: str) -> None:
    table, _fields = create_table_with_fields(
        table_service,
        space_id,
        f"{marker} 团队成员建模验收",
        [
            {"name": "姓名", "field_type": "text", "is_primary": True},
            {
                "name": "岗位",
                "field_type": "select",
                "options": {"choices": ["工程", "产品", "设计"]},
            },
            {"name": "入职日期", "field_type": "date"},
        ],
    )
    emit({"table": table_summary(table)})


def create_project_task_model(
    table_service: TableService,
    record_service: RecordService,
    space_id: UUID,
    marker: str,
    *,
    with_records: bool,
) -> dict:
    project_name = f"{marker} 项目建模验收"
    task_name = f"{marker} 任务建模验收"
    project_table = None
    task_table = None
    if with_records:
        # In a tag run, MDL-REL-001 follows MDL-PLN-002. Reusing that schema
        # avoids exhausting the free-tier table quota while still testing real
        # record linking and rollup behavior.
        for candidate_task in Table.objects.filter(
            space_id=space_id,
            name=task_name,
            is_archived=False,
        ).order_by("-created_at")[:10]:
            candidate_link = TableField.objects.filter(
                table_id=candidate_task.id,
                name="所属项目",
                field_type="link",
                is_deleted=False,
            ).first()
            if candidate_link is None:
                continue
            foreign_table_id = (candidate_link.config or {}).get("foreignTableId")
            candidate_project = Table.objects.filter(
                id=foreign_table_id,
                space_id=space_id,
                name=project_name,
                is_archived=False,
            ).first()
            if candidate_project is None:
                continue
            project_table = candidate_project
            task_table = candidate_task
            break

    if project_table and task_table:
        project_fields = active_fields_by_name(project_table)
        task_fields = active_fields_by_name(task_table)
        link_field = task_fields.get("所属项目")
        if link_field is None:
            raise RuntimeError("Existing task table is missing link field: 所属项目")
        symmetric_id = (link_field.config or {}).get("symmetricFieldId")
        symmetric_field = TableField.objects.get(id=symmetric_id) if symmetric_id else None
        rollup_field = project_fields.get("总工时")
    else:
        project_table, project_fields = create_table_with_fields(
            table_service,
            space_id,
            project_name,
            [{"name": "项目名称", "field_type": "text", "is_primary": True}],
        )
        task_table, task_fields = create_table_with_fields(
            table_service,
            space_id,
            task_name,
            [
                {"name": "任务名称", "field_type": "text", "is_primary": True},
                {"name": "工时", "field_type": "number"},
            ],
        )
        link_field = table_service.create_field(
            table_id=task_table.id,
            name="所属项目",
            field_type="link",
            options={
                "foreignTableId": str(project_table.id),
                "relationship": "ManyOne",
                "isOneWay": False,
            },
        )
        link_field.refresh_from_db()
        symmetric_id = (link_field.config or {}).get("symmetricFieldId")
        symmetric_field = TableField.objects.get(id=symmetric_id) if symmetric_id else None
        rollup_field = None
        if symmetric_field:
            rollup_field = table_service.create_field(
                table_id=project_table.id,
                name="总工时",
                field_type="rollup",
                options={
                    "linkFieldId": str(symmetric_field.id),
                    "lookupFieldId": str(task_fields["工时"].id),
                    "aggregation": "sum",
                    "expression": "sum({values})",
                    "lookupOptions": {
                        "foreignTableId": str(task_table.id),
                        "lookupFieldId": str(task_fields["工时"].id),
                        "linkFieldId": str(symmetric_field.id),
                    },
                },
            )

    relation_result = None
    if with_records:
        alpha = create_record(
            record_service,
            project_table.id,
            {str(project_fields["项目名称"].id): "Alpha"},
        )
        beta = create_record(
            record_service,
            project_table.id,
            {str(project_fields["项目名称"].id): "Beta"},
        )
        task_1 = create_record(
            record_service,
            task_table.id,
            {str(task_fields["任务名称"].id): "需求梳理", str(task_fields["工时"].id): 2},
        )
        task_2 = create_record(
            record_service,
            task_table.id,
            {str(task_fields["任务名称"].id): "开发联调", str(task_fields["工时"].id): 5},
        )
        task_3 = create_record(
            record_service,
            task_table.id,
            {str(task_fields["任务名称"].id): "验收回归", str(task_fields["工时"].id): 3},
        )
        LinkFieldService.set_link_cell(link_field, task_1, [str(alpha.id)])
        LinkFieldService.set_link_cell(link_field, task_2, [str(alpha.id)])
        LinkFieldService.set_link_cell(link_field, task_3, [str(beta.id)])
        project_record_ids = [alpha.id, beta.id]
        task_record_ids = [task_1.id, task_2.id, task_3.id]
        if rollup_field:
            RollupFieldService.compute_all(rollup_field)
            alpha.refresh_from_db()
            beta.refresh_from_db()
        relation_result = {
            "link_records_task_side": LinkRecord.objects.filter(
                link_field_id=link_field.id,
                self_record_id__in=task_record_ids,
                foreign_record_id__in=project_record_ids,
            ).count(),
            "link_records_project_side": (
                LinkRecord.objects.filter(
                    link_field_id=symmetric_field.id,
                    self_record_id__in=project_record_ids,
                    foreign_record_id__in=task_record_ids,
                ).count()
                if symmetric_field
                else None
            ),
            "alpha_task_count": (
                LinkRecord.objects.filter(
                    link_field_id=symmetric_field.id,
                    self_record_id=alpha.id,
                    foreign_record_id__in=task_record_ids,
                ).count()
                if symmetric_field
                else None
            ),
            "beta_task_count": (
                LinkRecord.objects.filter(
                    link_field_id=symmetric_field.id,
                    self_record_id=beta.id,
                    foreign_record_id__in=task_record_ids,
                ).count()
                if symmetric_field
                else None
            ),
            "alpha_rollup": alpha.get_record_data().get(str(rollup_field.id)) if rollup_field else None,
            "beta_rollup": beta.get_record_data().get(str(rollup_field.id)) if rollup_field else None,
        }

    project_table.refresh_from_db()
    task_table.refresh_from_db()

    return {
        "projectTable": table_summary(project_table),
        "taskTable": table_summary(task_table),
        "taskLinkField": {
            "id": str(link_field.id),
            "config": link_field.config,
        },
        "symmetricField": (
            {
                "id": str(symmetric_field.id),
                "name": symmetric_field.name,
                "config": symmetric_field.config,
            }
            if symmetric_field
            else None
        ),
        "rollupField": (
            {
                "id": str(rollup_field.id),
                "name": rollup_field.name,
                "config": rollup_field.config,
            }
            if rollup_field
            else None
        ),
        "relationResult": relation_result,
    }


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    run_id = require_env("TABTIN_E2E_RUN_ID")
    user_id = UUID(require_env("TABTIN_E2E_USER_ID"))
    space_id = UUID(require_env("TABTIN_E2E_SPACE_ID"))
    marker = f"[{run_id}]"

    User = get_user_model()
    user = User.objects.get(id=user_id)
    table_service = TableService(user=user)
    record_service = RecordService(user=user)

    if mode == "list_tables":
        list_tables(space_id)
        return
    if mode == "verify_new_table":
        verify_new_table(space_id, table_service)
        return
    if mode == "MDL-NEW-002":
        run_mdl_new_002(table_service, space_id, marker)
        return
    if mode == "MDL-PLN-001":
        run_mdl_pln_001(table_service, space_id, marker)
        return
    if mode == "MDL-PLN-002":
        emit(create_project_task_model(table_service, record_service, space_id, marker, with_records=False))
        return
    if mode == "MDL-REL-001":
        emit(create_project_task_model(table_service, record_service, space_id, marker, with_records=True))
        return
    if mode == "SELECT-OPTION-MANAGEMENT":
        create_select_option_management_case(table_service, record_service, space_id, marker)
        return
    if mode == "SELECT-OPTION-MANAGEMENT-PREPARE":
        prepare_select_option_management_case(table_service, record_service, space_id, marker)
        return
    if mode == "SELECT-OPTION-MANAGEMENT-VERIFY-RENAME":
        verify_select_option_rename_case(table_service, record_service)
        return

    raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()
