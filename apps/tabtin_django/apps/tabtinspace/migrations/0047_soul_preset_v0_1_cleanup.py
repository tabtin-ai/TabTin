"""Soul 预设 v0.1 字段清理

按宪法 v0.1 §3.6.1：

- ``SoulPreset.agent_config_overrides`` —— 删除（产品差异化通过 SCENE binding
  实现，不再通过 SoulPreset override 引擎参数）。
- ``SoulPreset.personality.identity`` —— 删除（JSON 内部 key，
  重复 system_identity_prompt 且无消费方）；同时刷新 ``personality.help_text``。

JSON 子键清理通过 RunPython 完成。已 applied 的 0044_agent_config_v2.py 在 RunPython
中读取 ``preset.agent_config_overrides``，但这是 historical model 上的字段访问，
0044 当时模型仍含该字段，回放历史链路无影响——本 migration 跑完后字段才消失。
"""

from django.db import migrations, models


def _strip_personality_identity(apps, schema_editor):
    SoulPreset = apps.get_model('tabtinspace', 'SoulPreset')
    db_alias = schema_editor.connection.alias
    if db_alias != 'postgresql':
        return
    qs = SoulPreset.objects.using(db_alias).only('id', 'personality').iterator()
    to_update: list = []
    for preset in qs:
        personality = preset.personality
        if not isinstance(personality, dict):
            continue
        if 'identity' not in personality:
            continue
        new_personality = {k: v for k, v in personality.items() if k != 'identity'}
        preset.personality = new_personality
        to_update.append(preset)
    if to_update:
        SoulPreset.objects.using(db_alias).bulk_update(to_update, ['personality'])


def _noop_reverse(apps, schema_editor):
    """反向：identity 字段无源数据可恢复，保持当前状态即可。"""
    return


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0046_remove_billing_mode_from_spaceshare'),
    ]

    operations = [
        migrations.RunPython(_strip_personality_identity, _noop_reverse),
        migrations.RemoveField(
            model_name='soulpreset',
            name='agent_config_overrides',
        ),
        migrations.AlterField(
            model_name='soulpreset',
            name='personality',
            field=models.JSONField(
                default=dict,
                help_text='{"behavior_rules": ["规则1", ...]} —— 用户可见的行为规则清单',
                verbose_name='人格配置',
            ),
        ),
    ]
