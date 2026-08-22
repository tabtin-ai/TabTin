# ：回填 Workspace.provisioning_source
#
# 保守策略：无法确认来源的保持 user（继续展示），只把高置信系统伴生标为
# system_project：
# 1) 展示名符合 ensure_project_workspace 的历史命名；
# 2) 当前仍挂在 ProjectMemberWorkspace 上，且与关联创建时间接近（同次供给）。

from datetime import timedelta

from django.db import migrations
from django.db.models import Q
from django.utils import timezone


_SYSTEM_NAME_SUFFIXES = (
    '项目的默认 Workspace',
    '的伴生 Workspace',
)
_LINK_CREATED_TOGETHER_WINDOW = timedelta(seconds=30)


def _as_aware(value):
    if value is None:
        return None
    if timezone.is_naive(value):
        return timezone.make_aware(value, timezone.get_current_timezone())
    return value


def forwards_backfill_provisioning_source(apps, schema_editor):
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    ProjectMemberWorkspace = apps.get_model('tabtinspace', 'ProjectMemberWorkspace')

    name_q = Q()
    for suffix in _SYSTEM_NAME_SUFFIXES:
        name_q |= Q(name__endswith=suffix)
    if name_q:
        Workspace.objects.filter(name_q).exclude(
            provisioning_source='system_project',
        ).update(provisioning_source='system_project')

    # 同次供给：PMW.created_at ≈ Workspace.created_at（用户后改绑的不会命中）
    for link in (
        ProjectMemberWorkspace.objects
        .select_related('workspace')
        .iterator(chunk_size=500)
    ):
        workspace = link.workspace
        if workspace is None:
            continue
        if getattr(workspace, 'provisioning_source', 'user') == 'system_project':
            continue
        created_at = _as_aware(getattr(workspace, 'created_at', None))
        link_created_at = _as_aware(getattr(link, 'created_at', None))
        if created_at is None or link_created_at is None:
            continue
        if abs(link_created_at - created_at) <= _LINK_CREATED_TOGETHER_WINDOW:
            Workspace.objects.filter(id=workspace.id).update(
                provisioning_source='system_project',
            )


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0123_workspace_provisioning_source_6846'),
    ]

    operations = [
        migrations.RunPython(
            forwards_backfill_provisioning_source,
            backwards_noop,
        ),
    ]
