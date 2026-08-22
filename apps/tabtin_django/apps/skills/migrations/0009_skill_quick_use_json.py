# Generated for SK quickUse metadata (WB)

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0008_alter_skill_version_seq_nullable"),
    ]

    operations = [
        migrations.AddField(
            model_name="skill",
            name="quick_use_json",
            field=models.JSONField(
                blank=True,
                default=list,
                help_text=(
                    "「快速使用」preset 列表的草稿工作副本（元数据驱动，不落 skill 目录文件）。"
                    "形态 [{id?, label, promptTemplate, variables[], canSubmitKeys?}, ...]——"
                    "一个 skill 可有多个预填示例，详情页列出供用户直观感知能力。"
                    "发布时快照进 SkillPublishedVersion.quick_use_json，随版本不可变。"
                ),
            ),
        ),
        migrations.AddField(
            model_name="skillpublishedversion",
            name="quick_use_json",
            field=models.JSONField(
                blank=True,
                default=list,
                help_text=(
                    "「快速使用」preset 列表的发布快照（随版本不可变）。"
                    "形态与 Skill.quick_use_json 一致：[{id?, label, promptTemplate, variables[], canSubmitKeys?}, ...]。"
                ),
            ),
        ),
    ]
