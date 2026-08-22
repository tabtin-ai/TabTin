# 子 Agent 计费收尾（2026-05）：给汇总扣费表 BillingUsageEvent 加 scene_key 列，
# 让财务报表 / 导出能按「钱花在哪类活上」（主管对话 / 子 Agent / 压缩 / 摘要）下钻。
# scene_key 与 LLMUsageFact.scene_key 同源同值，纯分类维度、不改任何金额。
#
# billing app 属 default（MySQL）库，本迁移为单库 AddField + 两个二级索引，不涉及 PG。
# 新列 default=""、可空白，存量行回填为空字符串（归报表「未分类」桶），不影响任何金额。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0029_remove_runtime_per_model_billing_flag"),
    ]

    operations = [
        migrations.AddField(
            model_name="billingusageevent",
            name="scene_key",
            field=models.CharField(
                blank=True,
                default="",
                max_length=100,
                verbose_name="场景标识",
            ),
        ),
        migrations.AddIndex(
            model_name="billingusageevent",
            index=models.Index(
                fields=["scene_key", "occurred_at"],
                name="services_bi_scene_k_359949_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="billingusageevent",
            index=models.Index(
                fields=["workteam_id", "scene_key", "occurred_at"],
                name="services_bi_worktea_8cf61c_idx",
            ),
        ),
    ]
