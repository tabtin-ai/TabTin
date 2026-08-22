"""下架 TabData AI 字段联动 Goal（skill_params.execution_type='skill_field'）

产品决策（2026-05-01）：
TabData AI 字段彻底下架。原本通过 ``Goal.skill_params.execution_type='skill_field'``
驱动的"字段定时批量执行"也随之失去意义——本 migration 删除所有这类 Goal。

不可逆：spec 早已声明"产品未上线，不考虑向后兼容"——见
``support/app/specs/skill-spec.md``。

依赖：上一个迁移 ``0024_rename_goal_verbose_name_to_tracker``。
"""

from django.db import migrations


def _drop_skill_field_goals(apps, schema_editor):
    """删除所有 skill_params.execution_type='skill_field' 的 Goal。"""
    if schema_editor.connection.alias != 'postgresql':
        return
    Goal = apps.get_model('tracker', 'Goal')
    deleted_count, _ = Goal.objects.using('postgresql').filter(
        skill_params__execution_type='skill_field',
    ).delete()
    if deleted_count:
        print(f"  [scheduler 0025] 删除 {deleted_count} 条 skill_field Goal")


def _noop_reverse(apps, schema_editor):
    """无回滚。"""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tracker', '0024_rename_goal_verbose_name_to_tracker'),
    ]

    operations = [
        migrations.RunPython(_drop_skill_field_goals, _noop_reverse),
    ]
