# Skill URL 导入来源追踪 + 同 owner 防重复

from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0011_rename_skills_skil_worktea_e5b8c1_idx_skills_skil_organiz_5dd095_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="skill",
            name="import_source_url",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "从 URL 导入时的规范化来源地址（空 = 非 URL 导入）。"
                    "同 owner 下非空值唯一，用于重复导入幂等复用。"
                ),
                max_length=2048,
            ),
        ),
        migrations.AddConstraint(
            model_name="skill",
            constraint=models.UniqueConstraint(
                condition=Q(import_source_url__gt=""),
                fields=("owner_user_id", "import_source_url"),
                name="uq_skill_owner_import_source_url",
            ),
        ),
    ]
