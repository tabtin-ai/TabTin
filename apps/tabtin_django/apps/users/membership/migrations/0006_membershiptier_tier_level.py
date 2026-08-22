from django.db import migrations, models


def populate_tier_level(apps, schema_editor):
    """根据 sort_order 初始化 tier_level（free=0, basic=10, pro=20, enterprise=30）。"""
    MembershipTier = apps.get_model("membership", "MembershipTier")
    tier_level_map = {
        "free": 0,
        "basic": 10,
        "pro": 20,
        "enterprise": 30,
    }
    for tier in MembershipTier.objects.all():
        level = tier_level_map.get(tier.tier_type, tier.sort_order * 10)
        MembershipTier.objects.filter(pk=tier.pk).update(tier_level=level)


class Migration(migrations.Migration):

    dependencies = [
        ("membership", "0005_remove_llm_token_quota_per_month"),
    ]

    operations = [
        migrations.AddField(
            model_name="membershiptier",
            name="tier_level",
            field=models.IntegerField(
                db_index=True,
                default=0,
                help_text="用于升降级判断的等级数值（越高=越高级），独立于展示排序 sort_order",
                verbose_name="等级层级",
            ),
        ),
        migrations.RunPython(populate_tier_level, migrations.RunPython.noop),
    ]
