"""
Workteam 个人身份 / 团队 类型字段

1. 新增 type 字段（default='team'）
2. 数据回填：is_default=True → type='personal'
3. 清理个人身份 Workteam 中的历史非所有者成员
4. 新增唯一约束：每个 owner 最多一个 type='personal'
"""

from django.db import migrations, models


def backfill_workteam_type(apps, schema_editor):
    """将 is_default=True 的 Workteam 标记为 type='personal'，并清理历史多余成员"""
    Workteam = apps.get_model('tabtinspace', 'Workteam')
    WorkteamMember = apps.get_model('tabtinspace', 'WorkteamMember')

    updated = Workteam.objects.filter(is_default=True).update(type='personal')
    if updated:
        print(f"  ↳ 回填 {updated} 条 Workteam type='personal'")

    personal_workteams = Workteam.objects.filter(type='personal')
    stale_count = 0
    for wt in personal_workteams.iterator():
        removed, _ = WorkteamMember.objects.filter(
            workteam_id=wt.id,
        ).exclude(
            user_id=wt.owner_id,
        ).delete()
        stale_count += removed
    if stale_count:
        print(f"  ↳ 清理 {stale_count} 条个人身份 Workteam 中的历史成员")


def reverse_backfill(apps, schema_editor):
    Workteam = apps.get_model('tabtinspace', 'Workteam')
    Workteam.objects.filter(type='personal').update(type='team')


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0021_remove_tinapps_tables'),
    ]

    operations = [
        migrations.AddField(
            model_name='workteam',
            name='type',
            field=models.CharField(
                choices=[('personal', '个人身份'), ('team', '团队')],
                db_index=True,
                default='team',
                max_length=20,
                verbose_name='类型',
            ),
        ),
        migrations.RunPython(backfill_workteam_type, reverse_backfill),
        migrations.AddConstraint(
            model_name='workteam',
            constraint=models.UniqueConstraint(
                condition=models.Q(('type', 'personal')),
                fields=('owner',),
                name='ctx_ws_owner_personal_unique',
            ),
        ),
    ]
