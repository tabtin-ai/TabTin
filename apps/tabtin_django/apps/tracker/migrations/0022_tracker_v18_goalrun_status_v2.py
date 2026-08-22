# Wave 2 (charter v1.8 §6.4): GoalRun.status choices 同步——
# waiting_checkpoint 标注为「已废弃」（保留 enum 值兼容历史 GoalRun，DB 中存量
# 记录可能仍是此状态；新写入路径不再使用）。
#
# 与 1.3c drop 5 旧字段 (execution_config / project_mode / token_budget /
# max_concurrent_runs / cycle_history) 的关系：
# - 1.3c drop 是**强不可逆操作**，charter v2.1 §1.3c 要求 deprecation_logger
#   跑 2 周观察期 telemetry 0 调用后才 drop。
# - Wave 1 (0020) 刚加 telemetry，Wave 2 启动时尚无 2 周数据。
# - 因此 1.3c drop 推迟到 Wave 3 启动时（届时已有 ≥2 周观察）。
# - 本 0022 仅同步 enum，不动 5 个旧字段；0023 + (Wave 3 内) drop 5 个字段，
#   每字段独立 PR。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tracker', '0021_drop_v1_step_models'),
    ]

    operations = [
        migrations.AlterField(
            model_name='goalrun',
            name='status',
            field=models.CharField(
                choices=[
                    ('pending', '等待执行'),
                    ('running', '执行中'),
                    ('waiting_checkpoint', '等待检查点（已废弃）'),
                    ('completed', '已完成'),
                    ('partial_failed', '部分失败'),
                    ('failed', '失败'),
                    ('cancelled', '已取消'),
                ],
                default='pending',
                max_length=24,
                verbose_name='执行状态',
            ),
        ),
    ]
