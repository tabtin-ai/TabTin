from __future__ import annotations

from django.db import migrations
from django.utils import timezone


BATCH_SIZE = 500


def _batched(iterator, size=BATCH_SIZE):
    batch = []
    for item in iterator:
        batch.append(item)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def backfill_existing_workspace_memory_settings(apps, schema_editor):
    """为迁移发生时已经存在的身份保留自动记忆开启语义。

    migration 使用历史模型、目标连接别名和小批量 ``bulk_create``；
    ``ignore_conflicts`` 使中断后重新执行同一函数时仍然安全。新增身份不走这里，
    由模型默认值 / lazy-create 保持关闭。
    """
    User = apps.get_model("users_auth", "User")
    Organization = apps.get_model("tabtinspace", "Organization")
    WorkspaceMemorySettings = apps.get_model(
        "agent_memory", "WorkspaceMemorySettings"
    )
    database = schema_editor.connection.alias
    now = timezone.now()

    personal_identities = (
        User.objects.using(database)
        .order_by("pk")
        .values_list("pk", flat=True)
        .iterator(chunk_size=BATCH_SIZE)
    )
    for user_ids in _batched(personal_identities):
        WorkspaceMemorySettings.objects.using(database).bulk_create(
            [
                WorkspaceMemorySettings(
                    scope="personal",
                    user_id=user_id,
                    auto_memory_enabled=True,
                    memory_model_mode="official_default",
                    memory_model_id=None,
                    created_by_id=user_id,
                    updated_by_id=user_id,
                    created_at=now,
                    updated_at=now,
                )
                for user_id in user_ids
            ],
            batch_size=BATCH_SIZE,
            ignore_conflicts=True,
        )

    organization_identities = (
        Organization.objects.using(database)
        .filter(type="team")
        .order_by("pk")
        .values_list("pk", "owner_id")
        .iterator(chunk_size=BATCH_SIZE)
    )
    for organizations in _batched(organization_identities):
        WorkspaceMemorySettings.objects.using(database).bulk_create(
            [
                WorkspaceMemorySettings(
                    scope="organization",
                    organization_id=organization_id,
                    auto_memory_enabled=True,
                    memory_model_mode="official_default",
                    memory_model_id=None,
                    created_by_id=owner_id,
                    updated_by_id=owner_id,
                    created_at=now,
                    updated_at=now,
                )
                for organization_id, owner_id in organizations
            ],
            batch_size=BATCH_SIZE,
            ignore_conflicts=True,
        )


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("agent_memory", "0002_workspacememorysettings_and_more"),
    ]

    operations = [
        migrations.RunPython(
            backfill_existing_workspace_memory_settings,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
