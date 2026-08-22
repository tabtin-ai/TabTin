from django.db import migrations, models


def backfill_runtime_type(apps, schema_editor):
    """根据存量 Agent 绑定设备的类型回填 runtime_type"""
    Agent = apps.get_model('tabtinspace', 'Agent')
    agents = Agent.objects.select_related(
        'control_device', 'bound_device',
    ).all()

    for agent in agents.iterator(chunk_size=500):
        if agent.control_device_id:
            agent.runtime_type = agent.control_device.device_type
        elif agent.bound_device_id:
            agent.runtime_type = agent.bound_device.device_type
        else:
            agent.runtime_type = 'electron'
        agent.save(update_fields=['runtime_type'])


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0023_agent_space_separation'),
    ]

    operations = [
        migrations.AddField(
            model_name='agent',
            name='runtime_type',
            field=models.CharField(
                blank=True,
                choices=[('electron', '桌面 Agent'), ('daemon', '服务器 Agent'), ('cloud', '云实例 Agent')],
                default='',
                help_text='首次绑定设备时由系统自动设置，之后锁定。空值表示尚未绑定过设备。',
                max_length=20,
                verbose_name='运行时类型',
            ),
        ),
        migrations.RunPython(
            backfill_runtime_type,
            migrations.RunPython.noop,
        ),
    ]
