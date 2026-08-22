"""#6903：Workspace 自有 custom_rules + execution_limits。

存量策略 A：
- custom_rules 置空（不把 Agent 出厂人设搬进现场）
- execution_limits：按 ChatSession 最近使用的 Agent，从
  agent_config.capabilities.overrides.cost.execution_limits 拷到对应 Workspace
"""

from django.db import migrations, models


def _extract_execution_limits(agent_config):
    if not isinstance(agent_config, dict):
        return {}
    caps = agent_config.get('capabilities')
    if not isinstance(caps, dict):
        # 兼容极旧扁平写法
        flat = agent_config.get('execution_limits')
        return flat if isinstance(flat, dict) else {}
    overrides = caps.get('overrides')
    if not isinstance(overrides, dict):
        return {}
    cost = overrides.get('cost')
    if not isinstance(cost, dict):
        return {}
    limits = cost.get('execution_limits')
    return limits if isinstance(limits, dict) else {}


def _has_explicit_limits(limits: dict) -> bool:
    if not limits:
        return False
    return (
        limits.get('max_iterations_per_run') is not None
        or limits.get('max_credits_per_run') is not None
    )


def forwards_copy_execution_limits(apps, schema_editor):
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    Agent = apps.get_model('agent', 'Agent')
    ChatSession = apps.get_model('conversation', 'ChatSession')

    agent_cache = {}
    for workspace in Workspace.objects.all().iterator(chunk_size=200):
        session = (
            ChatSession.objects
            .filter(workspace_id=workspace.id, agent_id__isnull=False)
            .order_by('-updated_at')
            .values_list('agent_id', flat=True)
            .first()
        )
        if not session:
            continue
        agent_id = session
        if agent_id not in agent_cache:
            agent = Agent.objects.filter(id=agent_id).values('agent_config').first()
            agent_cache[agent_id] = agent['agent_config'] if agent else None
        limits = _extract_execution_limits(agent_cache[agent_id])
        if not _has_explicit_limits(limits):
            continue
        Workspace.objects.filter(id=workspace.id).update(
            execution_limits={
                'max_iterations_per_run': limits.get('max_iterations_per_run'),
                'max_credits_per_run': limits.get('max_credits_per_run'),
            },
        )


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0121_project_task_result_visibility'),
    ]

    operations = [
        migrations.AddField(
            model_name='workspace',
            name='custom_rules',
            field=models.TextField(
                blank=True,
                default='',
                help_text='进入本 Workspace 干活时遵守的现场规则；不复用 Agent 人设。',
                verbose_name='现场自定义规则',
            ),
        ),
        migrations.AddField(
            model_name='workspace',
            name='execution_limits',
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text=(
                    '结构为 {max_iterations_per_run, max_credits_per_run}；'
                    '空 dict / 键为 null 表示跟随产品默认。'
                ),
                verbose_name='现场执行限制',
            ),
        ),
        migrations.RunPython(forwards_copy_execution_limits, backwards_noop),
    ]
