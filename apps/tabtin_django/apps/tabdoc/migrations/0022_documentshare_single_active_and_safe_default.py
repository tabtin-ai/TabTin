# Generated manually for  — TabDoc share safe default + dual-active cleanup.
#
# 数据清理与条件唯一约束拆分（ / data_op_then_schema_ddl）：
# 本文件只做 RunPython + AlterField(default)；约束见 0023。

from django.db import migrations, models


def cleanup_dual_active_shares(apps, schema_editor):
    """每个文档若有多条 active share，优先保留 organization，其余停用。

    单独存在的既有 public 分享不改动。
    回滚语义：noop — 停用的历史行保留，仅 is_active=False，不删数据。
    """
    DocumentShare = apps.get_model("tabdoc", "DocumentShare")
    db_alias = schema_editor.connection.alias

    active = (
        DocumentShare.objects.using(db_alias)
        .filter(is_active=True)
        .order_by("document_id", "created_at")
        .values_list("id", "document_id", "share_type")
    )
    by_doc: dict = {}
    for share_id, document_id, share_type in active:
        by_doc.setdefault(document_id, []).append((share_id, share_type))

    to_disable = []
    for _doc_id, rows in by_doc.items():
        if len(rows) <= 1:
            continue
        keep_id = None
        for share_id, share_type in rows:
            if share_type == "organization":
                keep_id = share_id
                break
        if keep_id is None:
            keep_id = rows[0][0]
        for share_id, _share_type in rows:
            if share_id != keep_id:
                to_disable.append(share_id)

    if to_disable:
        DocumentShare.objects.using(db_alias).filter(id__in=to_disable).update(
            is_active=False,
        )


def noop_reverse(apps, schema_editor):
    """数据清理不可逆（历史行仍在，仅 is_active 已改）。"""


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0021_alter_dochistory_organization_id_and_more"),
    ]

    operations = [
        migrations.RunPython(cleanup_dual_active_shares, noop_reverse),
        migrations.AlterField(
            model_name="documentshare",
            name="share_type",
            field=models.CharField(
                choices=[("public", "公开链接"), ("organization", "组织限定")],
                default="organization",
                max_length=20,
                verbose_name="分享类型",
            ),
        ),
    ]
