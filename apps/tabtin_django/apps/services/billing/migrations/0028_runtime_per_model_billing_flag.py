# 子 Agent 计费治本 Phase 1（2026-05）：runtime 按 by_model 逐模型计费 feature flag。
# 默认 False = 走旧一口价逻辑（零回归），由 PM/运营在 shadow 对账确认后再开启。
#
# billing app 属 default（MySQL）库，本迁移为单库 AddField，不涉及 PG。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0027_l1_l23_convergence'),
    ]

    operations = [
        migrations.AddField(
            model_name='billingruntimeconfig',
            name='runtime_per_model_billing_enabled',
            field=models.BooleanField(
                default=False,
                help_text=(
                    '开启后 Daemon/外部 Agent 的 turn 结算按 usage.by_model 逐模型各按各价'
                    '扣费（默认 False = 旧一口价逻辑，零回归）。开启前请先查 shadow 对账日志。'
                ),
                verbose_name='启用 runtime 按模型逐桶计费',
            ),
        ),
    ]
