#  终态 · 个人域资产真 FK · 回填（步骤 3b/N）
#
# 0107 已加字段并完成 FK 自动索引。本迁移只做数据回填：
# 0. 先把 0097 未覆盖的个人 Space 补建成同 id Workspace。
# 1. Space.agent → Workspace.agent（id-reuse）。
# 2. 个人 Collection / ContextItem：space_id → workspace_id，并清空 space_id。
#
# 复合索引见 0107b。

from django.db import migrations, models

from apps.tabtinspace.space_to_workspace import ensure_workspaces_from_all_personal_spaces


def forwards_backfill_personal_workspace_fk(apps, schema_editor):
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    Space = apps.get_model('tabtinspace', 'Space')
    Collection = apps.get_model('tabtinspace', 'Collection')
    ContextItem = apps.get_model('tabtinspace', 'ContextItem')

    ensure_workspaces_from_all_personal_spaces(apps)

    workspace_ids = set(Workspace.objects.values_list('id', flat=True))
    if not workspace_ids:
        return

    # Space.agent → Workspace.agent（同 id）
    for space in (
        Space.objects.filter(id__in=workspace_ids, agent_id__isnull=False)
        .only('id', 'agent_id')
        .iterator()
    ):
        Workspace.objects.filter(id=space.id, agent_id__isnull=True).update(
            agent_id=space.agent_id,
        )

    # 个人 Collection / ContextItem：space_id 命中 Workspace → 写 workspace，清 space
    Collection.objects.filter(
        space_id__in=workspace_ids,
        project_id__isnull=True,
        workspace_id__isnull=True,
    ).update(workspace_id=models.F('space_id'))
    Collection.objects.filter(
        workspace_id__isnull=False,
        space_id__isnull=False,
    ).update(space_id=None)

    ContextItem.objects.filter(
        space_id__in=workspace_ids,
        project_id__isnull=True,
        workspace_id__isnull=True,
    ).update(workspace_id=models.F('space_id'))
    ContextItem.objects.filter(
        workspace_id__isnull=False,
        space_id__isnull=False,
    ).update(space_id=None)


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0107_personal_workspace_fk_3266'),
    ]

    operations = [
        migrations.RunPython(
            forwards_backfill_personal_workspace_fk,
            backwards_noop,
        ),
    ]
