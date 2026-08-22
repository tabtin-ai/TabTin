# ：为 0114 重建的 Workspace 补 agent_id（逻辑同 0111，可幂等重跑）。

from django.db import migrations
from django.db.models import Count, OuterRef, Subquery


def forwards_backfill_workspace_agent(apps, schema_editor):
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    SpaceMembership = apps.get_model('tabtinspace', 'SpaceMembership')
    ChatSession = apps.get_model('conversation', 'ChatSession')
    Agent = apps.get_model('agent', 'Agent')

    primary_agent = (
        SpaceMembership.objects.filter(
            workspace_id=OuterRef('pk'),
            agent_id__isnull=False,
            is_active=True,
            is_primary=True,
        )
        .order_by('joined_at')
        .values('agent_id')[:1]
    )
    Workspace.objects.filter(agent_id__isnull=True).update(
        agent_id=Subquery(primary_agent),
    )

    remaining = list(
        Workspace.objects.filter(agent_id__isnull=True).values_list('id', flat=True)
    )
    if not remaining:
        return

    best: dict = {}
    counts: dict = {}
    for row in (
        ChatSession.objects.filter(
            workspace_id__in=remaining,
            agent_id__isnull=False,
        )
        .values('workspace_id', 'agent_id')
        .annotate(cnt=Count('id'))
    ):
        ws_id = row['workspace_id']
        if counts.get(ws_id, -1) < row['cnt']:
            counts[ws_id] = row['cnt']
            best[ws_id] = row['agent_id']

    for ws_id, agent_id in best.items():
        Workspace.objects.filter(id=ws_id, agent_id__isnull=True).update(agent_id=agent_id)

    still_missing = list(
        Workspace.objects.filter(agent_id__isnull=True).values_list('id', flat=True)
    )
    if not still_missing:
        return

    agent_ids = set(
        Agent.objects.filter(id__in=still_missing).values_list('id', flat=True)
    )
    for ws_id in still_missing:
        if ws_id in agent_ids:
            Workspace.objects.filter(id=ws_id, agent_id__isnull=True).update(
                agent_id=ws_id,
            )


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0114_rebuild_workspace_for_orphan_hosts_3266'),
        ('conversation', '0066_drop_chatsession_space_fk_3266'),
        ('agent', '0001_move_agent_from_tabtinspace'),
    ]

    operations = [
        migrations.RunPython(
            forwards_backfill_workspace_agent,
            migrations.RunPython.noop,
        ),
    ]
