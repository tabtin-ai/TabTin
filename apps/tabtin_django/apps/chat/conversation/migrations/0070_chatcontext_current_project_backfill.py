# 将 ChatContext 中原本混放在 current_space_id 的协作 Project 投影到专用 FK。
# 不清空 current_space_id：它仍是泛化资源宿主，历史记录缺少足够信息判断某个
# Project ID 是「协作场」还是「当前资源宿主」，保守保留避免丢失资源上下文。
#
# 与 0069 AddField 分文件（ / db-single-pg）。

from uuid import UUID

from django.db import migrations


def backfill_current_project(apps, schema_editor):
    ChatContext = apps.get_model('conversation', 'ChatContext')
    Project = apps.get_model('tabtinspace', 'Project')

    project_ids = set(Project.objects.values_list('id', flat=True))
    if not project_ids:
        return

    contexts = []
    for context in ChatContext.objects.select_related('session').iterator(chunk_size=500):
        project_id = context.session.project_id
        if project_id is None and context.current_space_id:
            try:
                candidate_id = UUID(str(context.current_space_id))
            except (ValueError, TypeError):
                candidate_id = None
            if candidate_id in project_ids:
                project_id = candidate_id
        if project_id is None:
            continue
        context.current_project_id = project_id
        contexts.append(context)
        if len(contexts) >= 500:
            ChatContext.objects.bulk_update(contexts, ['current_project'])
            contexts = []
    if contexts:
        ChatContext.objects.bulk_update(contexts, ['current_project'])


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0069_chatcontext_current_project'),
    ]

    operations = [
        migrations.RunPython(backfill_current_project, migrations.RunPython.noop),
    ]
