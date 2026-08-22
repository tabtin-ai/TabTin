# 子 Agent 计费收尾（2026-05）：清退 0028 加的「runtime 按 by_model 逐模型计费」
# feature flag 字段。
#
# 背景：该 flag 挂在 agent.runtime.done 结算路径上，而原生 runtime / 内置 Agent 的
# LLM 真扣费在网关 proxy 的 per-request 实时结算（settle_and_charge），该结算路径
# 线上不可达（唯一触发点是 Daemon 失败兜底，error=true 且无 usage，只记录不扣费）。
# 故「逐模型计费」实现是永不生效的死代码，连同本字段一并清退。
#
# billing app 属 default（MySQL）库，本迁移为单库 RemoveField，不涉及 PG。
# 字段 default=False、无数据依赖，删除安全幂等。

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0028_runtime_per_model_billing_flag'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='billingruntimeconfig',
            name='runtime_per_model_billing_enabled',
        ),
    ]
