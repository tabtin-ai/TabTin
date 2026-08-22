from django.db import migrations, models
import django.db.models.deletion


def backfill_space_execution_fields(apps, schema_editor):
    Space = apps.get_model('tabtinspace', 'Space')

    for space in Space.objects.select_related('agent').iterator():
        agent = getattr(space, 'agent', None)
        if agent is None:
            continue

        updates = []
        bound_device_id = getattr(agent, 'bound_device_id', None)
        control_device_id = getattr(agent, 'control_device_id', None)
        working_dir = getattr(agent, 'working_dir', '') or ''
        working_dir_type = getattr(agent, 'working_dir_type', '') or ''

        if bound_device_id and getattr(space, 'bound_device_id', None) != bound_device_id:
            space.bound_device_id = bound_device_id
            updates.append('bound_device')
        if control_device_id and getattr(space, 'control_device_id', None) != control_device_id:
            space.control_device_id = control_device_id
            updates.append('control_device')
        if working_dir and getattr(space, 'working_dir', '') != working_dir:
            space.working_dir = working_dir
            space.normalized_working_dir = working_dir
            updates.extend(['working_dir', 'normalized_working_dir'])
        if working_dir_type and getattr(space, 'working_dir_type', '') != working_dir_type:
            space.working_dir_type = working_dir_type
            updates.append('working_dir_type')

        if updates:
            space.save(update_fields=sorted(set(updates)))


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0071_resourceaccess_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='space',
            name='bound_device',
            field=models.ForeignKey(blank=True, help_text='Space 的执行设备绑定。迁移期同步写 Agent.bound_device 以兼容旧调用。', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='bound_spaces', to='tabtinspace.device', verbose_name='绑定设备'),
        ),
        migrations.AddField(
            model_name='space',
            name='control_device',
            field=models.ForeignKey(blank=True, help_text='Space 的控制/执行设备。迁移期同步写 Agent.control_device 以兼容旧调用。', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='control_spaces', to='tabtinspace.device', verbose_name='执行设备'),
        ),
        migrations.AddField(
            model_name='space',
            name='normalized_working_dir',
            field=models.TextField(blank=True, db_index=True, default='', help_text='用于同设备目录唯一校验的标准化路径。', verbose_name='标准化工作目录'),
        ),
        migrations.AddField(
            model_name='space',
            name='working_dir',
            field=models.TextField(blank=True, default='', help_text='Space 在执行设备上的工作目录绝对路径。', verbose_name='工作目录'),
        ),
        migrations.AddField(
            model_name='space',
            name='working_dir_type',
            field=models.CharField(blank=True, default='', help_text='code/mixed/doc；空值表示未设置。', max_length=20, verbose_name='工作目录类型'),
        ),
        migrations.RunPython(backfill_space_execution_fields, migrations.RunPython.noop),
    ]
