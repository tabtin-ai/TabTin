from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0020_merge_skills_0019_leaves"),
    ]

    operations = [
        migrations.AlterField(
            model_name="skill",
            name="import_source_url",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "从 URL 导入时的规范化来源地址（空 = 非 URL 导入）。"
                    "同 owner 的个人原件中非空值唯一，用于重复导入幂等复用；"
                    "组织共享快照不参与个人导入去重。"
                ),
                max_length=2048,
            ),
        ),
        migrations.RemoveConstraint(
            model_name="skill",
            name="uq_skill_owner_import_source_url",
        ),
        migrations.AddConstraint(
            model_name="skill",
            constraint=models.UniqueConstraint(
                condition=(
                    models.Q(import_source_url__gt="")
                    & ~models.Q(visibility="organization")
                ),
                fields=("owner_user_id", "import_source_url"),
                name="uq_skill_owner_import_source_url",
            ),
        ),
    ]
