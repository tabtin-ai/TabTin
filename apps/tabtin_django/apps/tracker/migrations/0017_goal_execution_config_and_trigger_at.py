"""
Goal 统一方案 Phase 1：
- Goal 新增 execution_config JSON 字段
- trigger_type choices 新增 'at'（一次性执行）
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0016_tabagenda_constraints"),
    ]

    operations = [
        migrations.AddField(
            model_name="goal",
            name="execution_config",
            field=models.JSONField(
                default=dict,
                verbose_name="执行配置",
                help_text=(
                    "扩展执行策略。execution_type='skill_field' 时包含 "
                    "table_id, field_id, record_ids 等字段级批量执行参数。"
                ),
            ),
        ),
        migrations.AlterField(
            model_name="goal",
            name="trigger_type",
            field=models.CharField(
                choices=[
                    ("manual", "手动触发"),
                    ("cron", "Cron 表达式"),
                    ("interval", "固定间隔"),
                    ("at", "一次性执行"),
                    ("extension_event", "Extension 事件触发"),
                    ("table_event", "表格事件触发"),
                    ("webhook", "Webhook 入站触发"),
                    ("goal_completed", "目标完成后触发"),
                ],
                default="manual",
                max_length=32,
                verbose_name="触发类型",
            ),
        ),
    ]
