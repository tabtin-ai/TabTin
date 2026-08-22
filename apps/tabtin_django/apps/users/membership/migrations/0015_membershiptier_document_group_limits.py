from django.db import migrations, models


TIER_LIMITS = {
    "free": {"max_documents": 10, "max_groups": 3},
    "basic": {"max_documents": 100, "max_groups": 30},
    "pro": {"max_documents": 1000, "max_groups": 100},
    "enterprise": {"max_documents": -1, "max_groups": -1},
}


def seed_document_group_limits(apps, schema_editor):
    MembershipTier = apps.get_model("membership", "MembershipTier")
    for tier_type, values in TIER_LIMITS.items():
        MembershipTier.objects.filter(tier_type=tier_type).update(**values)


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("membership", "0014_alter_usermembership_user"),
    ]

    operations = [
        migrations.AddField(
            model_name="membershiptier",
            name="max_documents",
            field=models.IntegerField(
                default=-1,
                help_text="-1表示无限制。seed data 中会按 free/basic/pro/enterprise 覆盖默认值。",
                verbose_name="最大文档数",
            ),
        ),
        migrations.AddField(
            model_name="membershiptier",
            name="max_groups",
            field=models.IntegerField(
                default=-1,
                help_text="-1表示无限制。用于 TabChat 群聊数量套餐权益检查。",
                verbose_name="最大群组数",
            ),
        ),
        migrations.RunPython(seed_document_group_limits, noop_reverse),
    ]
