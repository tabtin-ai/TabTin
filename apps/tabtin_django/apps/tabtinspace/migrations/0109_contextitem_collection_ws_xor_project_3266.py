#  终态 · Collection / ContextItem workspace XOR project 收口
#
# 0107 / 0108 完成个人 Workspace 回填与 Space FK Drop 之后，Collection 与
# ContextItem 只剩两类合法宿主：
# - 个人资产 → workspace 非空、project 为空
# - 团队资产 → project 非空、workspace 为空
#
# 本迁移（生产可无人值守）：
#   1. RunPython 自动归位双空孤儿（不依赖运维 env）：
#      - ProjectTaskDeliverable → task.project_id
#      - ContextItem.resource_id + item_type → 资源表仍保留的 space_id
#        （Workspace/Project id-reuse；必要时 ensure_workspace_for_orphan_host）
#      - collection_id → Collection 已落位的 workspace/project
#      - Collection 沿 parent 链找已落位祖先
#      - 仍无法归位的真脏数据：删除（无恢复线索；禁止用 env 门禁卡 migrate）
#   2. AddConstraint：XOR CheckConstraint
#
# 反向不做数据恢复：只 RemoveConstraint。

import logging
import uuid

from django.db import migrations, models

from apps.tabtinspace.space_to_workspace import ensure_workspace_for_orphan_host

logger = logging.getLogger(__name__)

# item_type → (app_label, model_name)；资源表仍持有 space_id 软引用（id-reuse）。
_ITEM_TYPE_APP_MODEL = {
    'tabdoc': ('tabdoc', 'Document'),
    'tabslide': ('tabslide', 'SlideProject'),
    'tabvideo': ('tabvideo', 'VideoProject'),
    'tabdata': ('tabdata', 'Table'),
    'tabwhiteboard': ('tabwhiteboard', 'Canvas'),
    'tabmemo': ('tabmemo', 'Memo'),
    'tabsite': ('tabsite', 'Site'),
}


def _as_uuid(value):
    if value is None or value == '':
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _rehome_context_via_deliverable(apps):
    ContextItem = apps.get_model('tabtinspace', 'ContextItem')
    ProjectTaskDeliverable = apps.get_model('tabtinspace', 'ProjectTaskDeliverable')
    fixed = 0
    for deliverable in (
        ProjectTaskDeliverable.objects
        .filter(context_item__isnull=False)
        .filter(context_item__workspace_id__isnull=True)
        .filter(context_item__project_id__isnull=True)
        .select_related('task')
        .iterator()
    ):
        task = deliverable.task
        if task is None or task.project_id is None:
            continue
        updated = ContextItem.objects.filter(
            id=deliverable.context_item_id,
            workspace_id__isnull=True,
            project_id__isnull=True,
        ).update(project_id=task.project_id)
        fixed += updated
    return fixed


def _rehome_context_via_resource(apps):
    ContextItem = apps.get_model('tabtinspace', 'ContextItem')
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    Project = apps.get_model('tabtinspace', 'Project')

    workspace_ids = set(Workspace.objects.values_list('id', flat=True))
    project_ids = set(Project.objects.values_list('id', flat=True))
    fixed = 0

    for item_type, (app_label, model_name) in _ITEM_TYPE_APP_MODEL.items():
        try:
            Resource = apps.get_model(app_label, model_name)
        except LookupError:
            continue
        if not hasattr(Resource, 'space_id'):
            continue

        orphans = list(
            ContextItem.objects.filter(
                item_type=item_type,
                workspace_id__isnull=True,
                project_id__isnull=True,
            )
            .exclude(resource_id__isnull=True)
            .exclude(resource_id='')
            .only('id', 'resource_id', 'title')
            .iterator()
        )
        for item in orphans:
            resource_id = _as_uuid(item.resource_id)
            if resource_id is None:
                continue
            resource = Resource.objects.filter(id=resource_id).first()
            if resource is None:
                continue
            host_id = getattr(resource, 'space_id', None)
            if host_id is None:
                continue

            if host_id in workspace_ids:
                ContextItem.objects.filter(id=item.id).update(workspace_id=host_id)
                fixed += 1
                continue
            if host_id in project_ids:
                ContextItem.objects.filter(id=item.id).update(project_id=host_id)
                fixed += 1
                continue

            org_id = getattr(resource, 'organization_id', None)
            sample_name = (
                getattr(resource, 'name', None)
                or getattr(resource, 'title', None)
                or getattr(item, 'title', None)
                or ''
            )
            if org_id is not None and ensure_workspace_for_orphan_host(
                apps,
                host_id=host_id,
                organization_id=org_id,
                name=str(sample_name or ''),
            ):
                workspace_ids.add(host_id)
                ContextItem.objects.filter(id=item.id).update(workspace_id=host_id)
                fixed += 1
                continue

            # ensure 失败但 Workspace 可能已存在（并发/幂等）
            if Workspace.objects.filter(id=host_id).exists():
                workspace_ids.add(host_id)
                ContextItem.objects.filter(id=item.id).update(workspace_id=host_id)
                fixed += 1
            elif Project.objects.filter(id=host_id).exists():
                project_ids.add(host_id)
                ContextItem.objects.filter(id=item.id).update(project_id=host_id)
                fixed += 1

    return fixed


def _rehome_context_via_collection(apps):
    ContextItem = apps.get_model('tabtinspace', 'ContextItem')
    Collection = apps.get_model('tabtinspace', 'Collection')
    fixed = 0
    for item in (
        ContextItem.objects.filter(
            workspace_id__isnull=True,
            project_id__isnull=True,
            collection_id__isnull=False,
        )
        .only('id', 'collection_id')
        .iterator()
    ):
        coll = (
            Collection.objects.filter(id=item.collection_id)
            .only('id', 'workspace_id', 'project_id')
            .first()
        )
        if coll is None:
            continue
        if coll.workspace_id is not None:
            ContextItem.objects.filter(id=item.id).update(workspace_id=coll.workspace_id)
            fixed += 1
        elif coll.project_id is not None:
            ContextItem.objects.filter(id=item.id).update(project_id=coll.project_id)
            fixed += 1
    return fixed


def _rehome_collection_via_parent(apps):
    Collection = apps.get_model('tabtinspace', 'Collection')
    fixed = 0
    # 多轮：子依赖父，最多抬升树高
    for _ in range(8):
        progressed = 0
        for coll in (
            Collection.objects.filter(
                workspace_id__isnull=True,
                project_id__isnull=True,
                parent_id__isnull=False,
            )
            .only('id', 'parent_id')
            .iterator()
        ):
            parent = (
                Collection.objects.filter(id=coll.parent_id)
                .only('id', 'workspace_id', 'project_id')
                .first()
            )
            if parent is None:
                continue
            if parent.workspace_id is not None:
                Collection.objects.filter(id=coll.id).update(
                    workspace_id=parent.workspace_id,
                )
                progressed += 1
            elif parent.project_id is not None:
                Collection.objects.filter(id=coll.id).update(
                    project_id=parent.project_id,
                )
                progressed += 1
        fixed += progressed
        if not progressed:
            break
    return fixed


def forwards_rehome_then_purge_orphans(apps, schema_editor):
    ContextItem = apps.get_model('tabtinspace', 'ContextItem')
    Collection = apps.get_model('tabtinspace', 'Collection')

    n_deliverable = _rehome_context_via_deliverable(apps)
    n_resource = _rehome_context_via_resource(apps)
    n_collection_host = _rehome_context_via_collection(apps)
    n_coll_parent = _rehome_collection_via_parent(apps)
    # Collection 归位后再给挂在其上的 ContextItem 一次机会
    n_collection_host += _rehome_context_via_collection(apps)

    orphan_items = ContextItem.objects.filter(
        workspace_id__isnull=True, project_id__isnull=True,
    )
    orphan_collections = Collection.objects.filter(
        workspace_id__isnull=True, project_id__isnull=True,
    )
    item_count = orphan_items.count()
    coll_count = orphan_collections.count()

    logger.warning(
        '#3266/0109 rehome: deliverable=%s resource=%s ctx_via_coll=%s '
        'coll_via_parent=%s remaining_orphans context_item=%s collection=%s',
        n_deliverable,
        n_resource,
        n_collection_host,
        n_coll_parent,
        item_count,
        coll_count,
    )

    # 无任何宿主线索的残余脏数据：直接删除以装上 XOR。
    # 生产 migrate 必须无人值守推进，禁止再要求 TABTIN_ALLOW_3266_ORPHAN_PURGE。
    if item_count or coll_count:
        logger.warning(
            '#3266/0109: purging unrehomeable orphans '
            'ContextItem=%s Collection=%s',
            item_count,
            coll_count,
        )
    orphan_items.delete()
    orphan_collections.delete()


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    # DELETE 与 ADD CONSTRAINT 不可同事务：PG 会报
    # "cannot ALTER TABLE ... because it has pending trigger events"。
    atomic = False

    dependencies = [
        ('tabtinspace', '0108b_personal_shell_schema_cutover_3266'),
    ]

    operations = [
        migrations.RunPython(
            forwards_rehome_then_purge_orphans,
            backwards_noop,
        ),
        migrations.AddConstraint(
            model_name='contextitem',
            constraint=models.CheckConstraint(
                check=(
                    (models.Q(workspace__isnull=False) & models.Q(project__isnull=True))
                    | (models.Q(workspace__isnull=True) & models.Q(project__isnull=False))
                ),
                name='ctx_item_ws_xor_project',
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.CheckConstraint(
                check=(
                    (models.Q(workspace__isnull=False) & models.Q(project__isnull=True))
                    | (models.Q(workspace__isnull=True) & models.Q(project__isnull=False))
                ),
                name='ctx_coll_ws_xor_project',
            ),
        ),
    ]
