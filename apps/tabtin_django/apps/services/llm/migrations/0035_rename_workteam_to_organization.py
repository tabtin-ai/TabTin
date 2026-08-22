"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations, models


def _update_enum_values(apps, schema_editor, forward=True):
    """存量枚举值 'workteam' <-> 'organization'（prelaunch 一次到位，见 RENAME-SPEC §0.2）。"""
    old, new = ("workteam", "organization") if forward else ("organization", "workteam")
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "UPDATE services_llm_provider SET scope = %s WHERE scope = %s", [new, old]
        )
        cursor.execute(
            "UPDATE services_llm_usage_fact SET effective_provider_scope = %s WHERE effective_provider_scope = %s", [new, old]
        )


def _forward_enum_values(apps, schema_editor):
    _update_enum_values(apps, schema_editor, forward=True)


def _reverse_enum_values(apps, schema_editor):
    _update_enum_values(apps, schema_editor, forward=False)

class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0034_moonshot_kimi_k26_baseline'),
    ]

    operations = [
        migrations.RemoveConstraint(model_name='llmprovider', name='uniq_provider_global'),
        migrations.RemoveConstraint(model_name='llmprovider', name='uniq_provider_workteam'),
        migrations.RemoveConstraint(model_name='llmprovider', name='uniq_provider_user'),
        migrations.RenameField(model_name='llmprovider', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='llmusagefact', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='llmadminauditlog', old_name='workteam_id', new_name='organization_id'),
        migrations.AddConstraint(model_name='llmprovider', constraint=models.UniqueConstraint(fields=['scope', 'provider_key'], condition=models.Q(organization_id__isnull=True, user_id__isnull=True), name='uniq_provider_global')),
        migrations.AddConstraint(model_name='llmprovider', constraint=models.UniqueConstraint(fields=['scope', 'organization_id', 'provider_key'], condition=models.Q(organization_id__isnull=False, user_id__isnull=True), name='uniq_provider_organization')),
        migrations.AddConstraint(model_name='llmprovider', constraint=models.UniqueConstraint(fields=['scope', 'organization_id', 'user_id', 'provider_key'], condition=models.Q(user_id__isnull=False), name='uniq_provider_user')),
        migrations.RunPython(_forward_enum_values, _reverse_enum_values),
    ]
