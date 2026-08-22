"""
PRD-04 Wave 5：回滚 0021，把 show_per_message_cost 默认值改回 True。

产品决策：用户在消息气泡上默认能看到每条消息费用——TabTin"透明"承诺的底线。
管理员仍可在 AdminDash 手动关闭。0021 保留在历史里（默认值演进记录），不删除。

本迁移同时做 data migration：正向 update(pk=1, show_per_message_cost=True) 覆盖
0021 执行后落到数据库的 False 值，包括对老部署里被显式改过的值——产品决策要求
默认展示，新值由管理员后续自行覆盖即可。

reverse_code 用 noop（二次收尾任务 4）：回滚 schema 不应粗暴覆盖管理员手动配置。
单例 default 由 AlterField 的 reverse 自动恢复到 0021 的 False，已经够用。
"""

from django.db import migrations, models


def set_show_per_message_cost_true(apps, schema_editor):
    """Data migration：把现有单例的 show_per_message_cost 强制置为 True。

    BillingRuntimeConfig 是 pk=1 单例，由 BillingConfigService.get_instance()
    在首次访问时通过 get_or_create(pk=1) 惰性创建（见 models.py:972）。
    0016 只创建了模型，没有 data migration 创建初始记录。
    因此 update(pk=1) 在"全新部署 + 从未访问过 billing config"的场景下
    可能匹配 0 行，靠 AlterField default=True 兜底（新创建的记录会有正确默认值）。
    """
    BillingRuntimeConfig = apps.get_model("billing", "BillingRuntimeConfig")
    BillingRuntimeConfig.objects.filter(pk=1).update(show_per_message_cost=True)


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0021_show_per_message_cost_default_false"),
    ]

    operations = [
        migrations.AlterField(
            model_name="billingruntimeconfig",
            name="show_per_message_cost",
            field=models.BooleanField(
                default=True,
                help_text=(
                    "是否在前端 assistant 消息气泡上展示本条消息消耗的点券数。"
                    "PRD-04 Wave 5：默认 True（透明承诺），管理员可按需关闭。"
                ),
                verbose_name="展示每条消息费用",
            ),
        ),
        # PRD-04 Wave 5 二次收尾任务 4：reverse_code 用 noop，不动用户配置。
        # 之前用 set_show_per_message_cost_false 强制写 False，回滚时会覆盖
        # 管理员手动改成 True 的配置——回滚 schema 不应破坏运行时数据。
        # 单例的 default 由上面 AlterField 的 reverse 自动恢复到 0021 的 False。
        migrations.RunPython(
            set_show_per_message_cost_true,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
