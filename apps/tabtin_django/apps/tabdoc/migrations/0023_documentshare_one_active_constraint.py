# Generated manually for  — 每文档一条 active share 的条件唯一约束。
#
# 与 0022 拆分：先清理双活数据，再加 DDL（避免 PG pending trigger events / ）。
#
# database_operations 幂等：若本机曾应用「旧版 0022（含 AddConstraint）」导致
# 约束已存在，则跳过 CREATE，只推进 Django state。

from django.db import migrations, models


CONSTRAINT = models.UniqueConstraint(
    condition=models.Q(is_active=True),
    fields=("document",),
    name="docshare_one_active_per_document",
)


def _constraint_exists(schema_editor) -> bool:
    """Django 条件 UniqueConstraint 在 PG 上常体现为 unique index。"""
    connection = schema_editor.connection
    if connection.vendor != "postgresql":
        return False
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM pg_constraint WHERE conname = %s",
            [CONSTRAINT.name],
        )
        if cursor.fetchone():
            return True
        cursor.execute(
            "SELECT 1 FROM pg_indexes WHERE indexname = %s",
            [CONSTRAINT.name],
        )
        return cursor.fetchone() is not None


def add_constraint_if_missing(apps, schema_editor):
    # 仅 PG 做存在性短路（旧版 0022 已建约束）；其它 backend 直接 Add。
    if (
        schema_editor.connection.vendor == "postgresql"
        and _constraint_exists(schema_editor)
    ):
        return
    DocumentShare = apps.get_model("tabdoc", "DocumentShare")
    schema_editor.add_constraint(DocumentShare, CONSTRAINT)


def remove_constraint_if_present(apps, schema_editor):
    if (
        schema_editor.connection.vendor == "postgresql"
        and not _constraint_exists(schema_editor)
    ):
        return
    DocumentShare = apps.get_model("tabdoc", "DocumentShare")
    schema_editor.remove_constraint(DocumentShare, CONSTRAINT)


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0022_documentshare_single_active_and_safe_default"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddConstraint(
                    model_name="documentshare",
                    constraint=CONSTRAINT,
                ),
            ],
            database_operations=[
                migrations.RunPython(
                    add_constraint_if_missing,
                    remove_constraint_if_present,
                ),
            ],
        ),
    ]
