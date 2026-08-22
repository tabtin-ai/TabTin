#  第三波：EngineRuntimeConfig ctx_* 字段与本地 runtime 三档口径统一。
#
# 1. 删孤儿字段：ctx_pressure_medium（本地无对应档位）、
#    ctx_summary_keep_messages / ctx_emergency_keep_messages（本地保尾条数
#    已改为按压缩后目标压力动态反推，云端固定值无消费者）。
# 2. ctx_pressure_critical 默认 0.90 → 0.95 对齐本地紧急档；存量单例行
#    仍是旧默认 0.90 时一并抬到 0.95（管理员显式改过其他值则不动）。
# 3. 存量体检：旧 schema 对三档排序无校验，历史上可能写入过违反
#    「high <= trigger < critical 且落在 (0, 1]」的组合——这种行 prompt_forward
#    会拒绝下发（宿主静默落回 env / 默认值），管理员在 AdminDash 看到的数值
#    与实际生效值不一致。迁移时整组重置为新默认（0.75 / 0.85 / 0.95），
#    比保留一套永远不生效的脏值更诚实。
#
# 单例小表（pk=1 一行），无锁表风险。

from django.db import migrations, models

DEFAULT_PRESSURE_HIGH = 0.75
DEFAULT_SUMMARY_TRIGGER = 0.85
DEFAULT_PRESSURE_CRITICAL = 0.95


def _align_emergency_threshold(apps, schema_editor):
    EngineRuntimeConfig = apps.get_model("conversation", "EngineRuntimeConfig")
    EngineRuntimeConfig.objects.filter(pk=1, ctx_pressure_critical=0.90).update(
        ctx_pressure_critical=0.95,
    )

    config = EngineRuntimeConfig.objects.filter(pk=1).first()
    if config is None:
        return
    thresholds = (
        config.ctx_pressure_high,
        config.ctx_summary_trigger_fraction,
        config.ctx_pressure_critical,
    )
    ordering_ok = (
        all(0 < t <= 1 for t in thresholds)
        and config.ctx_pressure_high <= config.ctx_summary_trigger_fraction
        and config.ctx_summary_trigger_fraction < config.ctx_pressure_critical
    )
    if not ordering_ok:
        EngineRuntimeConfig.objects.filter(pk=1).update(
            ctx_pressure_high=DEFAULT_PRESSURE_HIGH,
            ctx_summary_trigger_fraction=DEFAULT_SUMMARY_TRIGGER,
            ctx_pressure_critical=DEFAULT_PRESSURE_CRITICAL,
        )


def _noop_reverse(apps, schema_editor):
    # 回滚只还原 schema，不把 0.95 改回 0.90——管理员语义值不可逆推。
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0053_chatsession_fork_copy_status"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="engineruntimeconfig",
            name="ctx_pressure_medium",
        ),
        migrations.RemoveField(
            model_name="engineruntimeconfig",
            name="ctx_summary_keep_messages",
        ),
        migrations.RemoveField(
            model_name="engineruntimeconfig",
            name="ctx_emergency_keep_messages",
        ),
        migrations.AlterField(
            model_name="engineruntimeconfig",
            name="ctx_pressure_critical",
            field=models.FloatField(default=0.95),
        ),
        migrations.RunPython(_align_emergency_threshold, _noop_reverse),
    ]
