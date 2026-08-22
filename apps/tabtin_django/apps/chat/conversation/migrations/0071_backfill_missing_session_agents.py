"""Repair legacy executable sessions that lost their direct Agent binding.

A single active Agent membership on the session Workspace is the most specific
safe source. Project companion Workspaces intentionally do not always have an
Agent membership, so an active default Agent for the same user and Organization
is the conservative fallback. Ambiguous rows are left untouched.
"""

from django.db import migrations


def backfill_missing_session_agents(apps, schema_editor):
    ChatSession = apps.get_model('conversation', 'ChatSession')
    SpaceMembership = apps.get_model('tabtinspace', 'SpaceMembership')
    Agent = apps.get_model('agent', 'Agent')
    db_alias = getattr(getattr(schema_editor, 'connection', None), 'alias', None)

    sessions = ChatSession.objects
    memberships = SpaceMembership.objects
    agents = Agent.objects
    if db_alias:
        sessions = sessions.using(db_alias)
        memberships = memberships.using(db_alias)
        agents = agents.using(db_alias)

    for session in (
        sessions
        .filter(agent_id__isnull=True, workspace_id__isnull=False)
        .only('id', 'user_id', 'organization_id', 'workspace_id')
        .iterator(chunk_size=500)
    ):
        member_agent_ids = memberships.filter(
            workspace_id=session.workspace_id,
            agent_id__isnull=False,
            is_active=True,
        ).values_list('agent_id', flat=True)
        candidate_ids = list(
            agents.filter(
                id__in=member_agent_ids,
                organization_id=session.organization_id,
                owner_user_id=session.user_id,
                is_active=True,
            ).values_list('id', flat=True)
        )
        if len(candidate_ids) != 1 and not candidate_ids:
            # Project companion Workspace 只挂用户 membership，不挂 Agent membership。
            # default Agent 是用户显式的稳定选择，且数据库约束保证至多一个活跃默认项。
            candidate_ids = list(
                agents.filter(
                    organization_id=session.organization_id,
                    owner_user_id=session.user_id,
                    is_active=True,
                    is_default=True,
                ).values_list('id', flat=True)
            )
        if len(candidate_ids) == 1:
            sessions.filter(id=session.id, agent_id__isnull=True).update(
                agent_id=candidate_ids[0],
            )


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0070_chatcontext_current_project_backfill'),
        ('tabtinspace', '0116_remove_workspace_agent_6198'),
        ('agent', '0005_rename_default_agent_to_xiaotin'),
    ]

    operations = [
        migrations.RunPython(backfill_missing_session_agents, migrations.RunPython.noop),
    ]
