#  终态 · 个人壳表 workspace FK 回填（步骤 4b/N）
#
# 0108 已加字段。本迁移只回填 / 清孤儿；schema cutover 见 0108b。

from django.db import migrations, models

from apps.tabtinspace.space_to_workspace import ensure_workspaces_from_all_personal_spaces


def forwards_backfill_shell_workspace(apps, schema_editor):
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    SpaceAppSettings = apps.get_model('tabtinspace', 'SpaceAppSettings')
    SpacePermission = apps.get_model('tabtinspace', 'SpacePermission')
    SpaceMembership = apps.get_model('tabtinspace', 'SpaceMembership')
    Collection = apps.get_model('tabtinspace', 'Collection')
    ContextItem = apps.get_model('tabtinspace', 'ContextItem')

    # 再兜一层：0107 之后若仍有个人 Space 无 Workspace，先迁再建壳 FK。
    ensure_workspaces_from_all_personal_spaces(apps)
    workspace_ids = set(Workspace.objects.values_list('id', flat=True))

    if workspace_ids:
        SpaceAppSettings.objects.filter(
            space_id__in=workspace_ids, workspace_id__isnull=True,
        ).update(workspace_id=models.F('space_id'))
        SpacePermission.objects.filter(
            space_id__in=workspace_ids, workspace_id__isnull=True,
        ).update(workspace_id=models.F('space_id'))
        SpaceMembership.objects.filter(
            space_id__in=workspace_ids, workspace_id__isnull=True,
        ).update(workspace_id=models.F('space_id'))

    # 无 Workspace 承接的壳行：团队壳已在 0105 删除；剩余真孤儿直接清掉
    SpaceAppSettings.objects.filter(workspace_id__isnull=True).delete()
    SpacePermission.objects.filter(workspace_id__isnull=True).delete()
    SpaceMembership.objects.filter(workspace_id__isnull=True).delete()

    # 0107 后仍挂 space、且无 workspace/project 的个人资产：尝试再回填一次
    if workspace_ids:
        Collection.objects.filter(
            space_id__in=workspace_ids,
            workspace_id__isnull=True,
            project_id__isnull=True,
        ).update(workspace_id=models.F('space_id'))
        ContextItem.objects.filter(
            space_id__in=workspace_ids,
            workspace_id__isnull=True,
            project_id__isnull=True,
        ).update(workspace_id=models.F('space_id'))


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0108_personal_shell_fk_workspace_3266'),
    ]

    operations = [
        migrations.RunPython(forwards_backfill_shell_workspace, backwards_noop),
    ]
