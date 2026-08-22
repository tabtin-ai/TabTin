import django.db.models.deletion
from django.db import migrations, models


def backfill_bindings(apps, schema_editor):
    ChatSession = apps.get_model('conversation', 'ChatSession')
    ChatMessage = apps.get_model('conversation', 'ChatMessage')
    Space = apps.get_model('tabtinspace', 'Space')
    Workspace = apps.get_model('tabtinspace', 'Workspace')

    workspace_rows = list(
        Workspace.objects.values(
            'id',
            'device_id',
            'normalized_working_dir',
        )
    )
    workspace_ids = {row['id'] for row in workspace_rows}
    workspace_by_execution_key = {
        (row['device_id'], row['normalized_working_dir']): row['id']
        for row in workspace_rows
    }
    spaces = {
        row['id']: row
        for row in Space.objects.values(
            'id',
            'type',
            'agent_id',
            'execution_space_id',
            'control_device_id',
            'normalized_working_dir',
        )
    }

    def resolve_workspace_and_agent(space_id):
        space = spaces.get(space_id)
        if not space:
            return None, None
        execution_space_id = (
            space['execution_space_id']
            if space['type'] == 'team_space' and space['execution_space_id']
            else space_id
        )
        execution_space = spaces.get(execution_space_id) or space
        workspace_id = (
            execution_space_id
            if execution_space_id in workspace_ids
            else workspace_by_execution_key.get((
                execution_space['control_device_id'],
                execution_space['normalized_working_dir'],
            ))
        )
        return workspace_id, execution_space['agent_id']

    sessions = []
    for session in ChatSession.objects.only('id', 'space_id').iterator(chunk_size=500):
        workspace_id, agent_id = resolve_workspace_and_agent(session.space_id)
        session.workspace_id = workspace_id
        session.agent_id = agent_id
        sessions.append(session)
        if len(sessions) >= 500:
            ChatSession.objects.bulk_update(sessions, ['workspace', 'agent'])
            sessions = []
    if sessions:
        ChatSession.objects.bulk_update(sessions, ['workspace', 'agent'])

    for session_id, agent_id in ChatSession.objects.exclude(agent_id=None).values_list('id', 'agent_id'):
        ChatMessage.objects.filter(
            session_id=session_id,
        ).filter(
            models.Q(role='assistant') | models.Q(message_kind='tool_artifact'),
        ).update(agent_id=agent_id)


class Migration(migrations.Migration):
    dependencies = [
        ('conversation', '0061_engineruntimeconfig_cleanup_llm_snapshot_retention_days_and_more'),
        ('tabtinspace', '0098_strip_agent_approval_config'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatsession',
            name='workspace',
            field=models.ForeignKey(
                blank=True,
                db_column='workspace_id',
                help_text='会话的执行现场；在哪台设备哪个目录干活的直挂锚点。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='+',
                to='tabtinspace.workspace',
                verbose_name='执行现场',
            ),
        ),
        migrations.AddField(
            model_name='chatsession',
            name='agent',
            field=models.ForeignKey(
                blank=True,
                db_column='agent_id',
                db_index=False,
                help_text='下一轮默认执行 Agent 的可变指针。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='+',
                to='tabtinspace.agent',
                verbose_name='当前 Agent',
            ),
        ),
        migrations.AddField(
            model_name='chatsession',
            name='agent_mode',
            field=models.CharField(blank=True, default='', max_length=16, verbose_name='会话交互模式'),
        ),
        migrations.AddField(
            model_name='chatsession',
            name='approval_mode',
            field=models.CharField(
                choices=[
                    ('always_ask', '每次询问'),
                    ('auto', '自动批准低风险操作'),
                    ('full_access', '完全访问'),
                ],
                default='always_ask',
                help_text='会话请求档位，不能突破 Workspace 与 Organization 上限。',
                max_length=16,
                verbose_name='会话审批请求档位',
            ),
        ),
        migrations.AddField(
            model_name='chatmessage',
            name='agent',
            field=models.ForeignKey(
                blank=True,
                help_text='assistant/tool_artifact 消息的实际执行者。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='+',
                to='tabtinspace.agent',
                verbose_name='本轮执行 Agent',
            ),
        ),
        migrations.RunPython(backfill_bindings, migrations.RunPython.noop),
    ]
