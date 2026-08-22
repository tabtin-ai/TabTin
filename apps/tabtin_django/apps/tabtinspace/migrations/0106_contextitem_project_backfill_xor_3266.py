#  P0 修复：0105 曾只把团队 ContextItem.space 置空、未写 project_id，
# 导致孤儿行。本迁移：
# 1) 修复仍挂在「已是 Project.id」上的 space_id（若 0105 源码已修但未跑完）
# 2) 经 ProjectTaskDeliverable 找回已双空的团队交付物
# 3) 加 XOR CheckConstraint（恰有 space 或 project 之一；允许过渡期双空由运维清）

from django.db import migrations, models
import django.db.models.deletion


def forwards_repair_context_item_project(apps, schema_editor):
    ContextItem = apps.get_model('tabtinspace', 'ContextItem')
    Project = apps.get_model('tabtinspace', 'Project')
    ProjectTaskDeliverable = apps.get_model('tabtinspace', 'ProjectTaskDeliverable')

    project_ids = set(Project.objects.values_list('id', flat=True))
    if project_ids:
        # space_id 仍等于 Project.id（0105 未清干净 / 新代码路径）→ 归位 project
        ContextItem.objects.filter(
            space_id__in=project_ids,
            project_id__isnull=True,
        ).update(project_id=models.F('space_id'))
        ContextItem.objects.filter(
            space_id__in=project_ids,
            project_id=models.F('space_id'),
        ).update(space_id=None)

    # 经交付物反查：task.project_id → context_item.project_id
    for deliverable in (
        ProjectTaskDeliverable.objects
        .filter(context_item__isnull=False)
        .filter(context_item__project_id__isnull=True)
        .select_related('task')
        .iterator()
    ):
        task = deliverable.task
        if task is None or task.project_id is None:
            continue
        ContextItem.objects.filter(id=deliverable.context_item_id).update(
            project_id=task.project_id,
            space_id=None,
        )


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    # 本迁移已在部分环境 apply，不宜再拆出索引迁移（会重复 AddIndex）。
    # 保留 atomic=False：未 apply 且有孤儿行可写时，避免同事务 pending trigger。
    atomic = False

    dependencies = [
        ('tabtinspace', '0105a_project_fk_cutover_backfill_3266'),
    ]

    operations = [
        migrations.RunPython(
            forwards_repair_context_item_project,
            backwards_noop,
        ),
        # XOR CheckConstraint 等孤儿清零后再加（见个人域 FK 终态迁移），
        # 避免仍双空的历史行挡住 migrate。
        migrations.AddIndex(
            model_name='contextitem',
            index=models.Index(
                fields=['project', 'item_type'],
                name='ctx_item_project_type_idx',
            ),
        ),
    ]
