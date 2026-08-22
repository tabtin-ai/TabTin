from __future__ import annotations

import uuid

from django.db import migrations, models


def _normalize_values(raw_values) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        value = str(raw or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized


def _extract_workspace_from_record(record) -> str:
    workspace_id = str(getattr(record, "workspace_id", "") or "").strip()
    if workspace_id:
        return workspace_id
    metadata = getattr(record, "metadata", None)
    if isinstance(metadata, dict):
        return str(metadata.get("workspace_id", "") or "").strip()
    return ""


def forwards(apps, schema_editor):
    UploadTask = apps.get_model("oss", "UploadTask")
    FileRecord = apps.get_model("oss", "FileRecord")
    OSSAdminActionLog = apps.get_model("oss", "OSSAdminActionLog")

    for task in UploadTask.objects.filter(workspace_id="").iterator():
        workspace_id = ""
        result_data = task.result_data if isinstance(task.result_data, dict) else {}
        if isinstance(result_data, dict):
            workspace_id = str(result_data.get("workspace_id", "") or "").strip()

        if not workspace_id:
            workspace_ids = _normalize_values(
                _extract_workspace_from_record(record)
                for record in task.files.all().only("workspace_id", "metadata")
            )
            if len(workspace_ids) == 1:
                workspace_id = workspace_ids[0]

        if workspace_id:
            UploadTask.objects.filter(id=task.id).update(workspace_id=workspace_id)

    for log in OSSAdminActionLog.objects.all().iterator():
        current_workspace_ids = (
            log.workspace_ids if isinstance(getattr(log, "workspace_ids", None), list) else []
        )
        workspace_ids = _normalize_values(current_workspace_ids)

        if not workspace_ids:
            target_file_ids = getattr(log, "target_file_ids", None)
            parsed_file_ids: list[uuid.UUID] = []
            if isinstance(target_file_ids, list):
                for raw_file_id in target_file_ids:
                    value = str(raw_file_id or "").strip()
                    if not value:
                        continue
                    try:
                        parsed_file_ids.append(uuid.UUID(value))
                    except (TypeError, ValueError):
                        continue

            if parsed_file_ids:
                workspace_ids = _normalize_values(
                    _extract_workspace_from_record(record)
                    for record in FileRecord.objects.filter(id__in=parsed_file_ids).only(
                        "workspace_id",
                        "metadata",
                    )
                )

        workspace_ids_text = f"|{'|'.join(workspace_ids)}|" if workspace_ids else ""
        workspace_id = (
            str(getattr(log, "workspace_id", "") or "").strip()
            or (workspace_ids[0] if len(workspace_ids) == 1 else "")
        )

        update_fields: dict[str, object] = {}
        if workspace_ids != current_workspace_ids:
            update_fields["workspace_ids"] = workspace_ids
        if workspace_ids_text != str(getattr(log, "workspace_ids_text", "") or ""):
            update_fields["workspace_ids_text"] = workspace_ids_text
        if workspace_id != str(getattr(log, "workspace_id", "") or "").strip():
            update_fields["workspace_id"] = workspace_id

        if update_fields:
            OSSAdminActionLog.objects.filter(id=log.id).update(**update_fields)


def backwards(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("oss", "0003_alter_fileusage_module"),
    ]

    operations = [
        migrations.AddField(
            model_name="uploadtask",
            name="workspace_id",
            field=models.CharField(
                blank=True,
                db_index=True,
                default="",
                help_text="上传任务归属的工作空间，用于清理和后台筛选",
                max_length=100,
                verbose_name="工作空间ID",
            ),
        ),
        migrations.AddField(
            model_name="ossadminactionlog",
            name="workspace_id",
            field=models.CharField(
                blank=True,
                db_index=True,
                default="",
                help_text="当治理动作只涉及单个工作空间时写入；跨工作空间动作留空",
                max_length=100,
                verbose_name="主工作空间ID",
            ),
        ),
        migrations.AddField(
            model_name="ossadminactionlog",
            name="workspace_ids",
            field=models.JSONField(
                default=list,
                help_text="治理动作影响的工作空间 ID 列表",
                verbose_name="影响的工作空间列表",
            ),
        ),
        migrations.AddField(
            model_name="ossadminactionlog",
            name="workspace_ids_text",
            field=models.TextField(
                blank=True,
                default="",
                help_text="格式: |workspace_id_1|workspace_id_2|，用于高性能模糊检索",
                verbose_name="影响工作空间检索文本",
            ),
        ),
        migrations.RunPython(forwards, backwards),
    ]
