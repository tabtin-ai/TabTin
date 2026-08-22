# 会话协作归属从 ChatContext.current_space_id 收口到显式 Project FK。
#
# ``current_space_id`` 仍是泛化 UI 资源宿主，不能删除；这里只在其值确实命中
# Project 主键时复制一次。另处理  过渡期间曾把 Project.id 错写进
# workspace_id 的历史行。
#
# 与 0067 AddField 分文件（ / db-single-pg）。

from uuid import UUID

from django.db import migrations, models


def backfill_session_projects(apps, schema_editor):
    ChatSession = apps.get_model('conversation', 'ChatSession')
    ChatContext = apps.get_model('conversation', 'ChatContext')
    Project = apps.get_model('tabtinspace', 'Project')

    project_ids = set(Project.objects.values_list('id', flat=True))
    if not project_ids:
        return

    # 历史 bug：Project id 被当作 Workspace id 写入。该值在 Project 表实际存在时，
    # 可无歧义地回填协作归属。
    ChatSession.objects.filter(
        project_id__isnull=True,
        workspace_id__in=project_ids,
    ).update(project_id=models.F('workspace_id'))

    # UI 当前宿主可能是 Workspace / Project / 其他资源壳；只接受真实 Project id，
    # 并且不覆写上一步或任何已经有明确 project 的会话。
    updates = []
    for context in (
        ChatContext.objects.exclude(current_space_id='')
        .select_related('session')
        .iterator(chunk_size=500)
    ):
        session = context.session
        if session.project_id is not None:
            continue
        try:
            project_id = UUID(str(context.current_space_id))
        except (ValueError, TypeError):
            continue
        if project_id not in project_ids:
            continue
        session.project_id = project_id
        updates.append(session)
        if len(updates) >= 500:
            ChatSession.objects.bulk_update(updates, ['project'])
            updates = []
    if updates:
        ChatSession.objects.bulk_update(updates, ['project'])


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0067_chatsession_project'),
    ]

    operations = [
        migrations.RunPython(backfill_session_projects, migrations.RunPython.noop),
    ]
