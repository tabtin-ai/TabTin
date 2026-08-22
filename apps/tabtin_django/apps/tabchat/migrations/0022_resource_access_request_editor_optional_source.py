"""ResourceAccessRequest：允许 editor，并支持无 IM 来源的工具栏申请。

反向迁移前会清掉无法落回旧约束的数据：
- ``role=editor`` 行
- ``source_conversation_id IS NULL`` 行（工具栏申请）

这样恢复 viewer-only CheckConstraint 与 source_conversation NOT NULL 时不会失败。
"""

from django.db import migrations, models
import django.db.models.deletion


def _noop_forward(apps, schema_editor):
    pass


def _cleanup_incompatible_rows_on_reverse(apps, schema_editor):
    """反向到 0021 前删除无法满足旧约束的申请行。"""
    ResourceAccessRequest = apps.get_model("tabchat", "ResourceAccessRequest")
    ResourceAccessRequest.objects.filter(role="editor").delete()
    ResourceAccessRequest.objects.filter(source_conversation__isnull=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("tabchat", "0021_reconcile_orphaned_message_reaction_schema"),
    ]

    operations = [
        migrations.AlterField(
            model_name="resourceaccessrequest",
            name="role",
            field=models.CharField(
                choices=[("viewer", "查看者"), ("editor", "编辑者")],
                default="viewer",
                max_length=20,
            ),
        ),
        migrations.AlterField(
            model_name="resourceaccessrequest",
            name="source_conversation",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="resource_access_requests",
                to="tabchat.conversation",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="resourceaccessrequest",
            name="tabchat_rar_role_viewer_only",
        ),
        migrations.AddConstraint(
            model_name="resourceaccessrequest",
            constraint=models.CheckConstraint(
                check=models.Q(role__in=["viewer", "editor"]),
                name="tabchat_rar_role_viewer_editor",
            ),
        ),
        # 必须放在 schema ops 之后：反向时先跑 cleanup，再恢复旧约束/NOT NULL。
        migrations.RunPython(
            _noop_forward,
            _cleanup_incompatible_rows_on_reverse,
        ),
    ]
