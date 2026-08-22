# Generated manually for  — 用户级技能库总闸表（仅 DDL）

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0015_merge_20260713_0230"),
    ]

    operations = [
        migrations.CreateModel(
            name="UserSkillPreference",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "user_id",
                    models.UUIDField(
                        db_index=True,
                        help_text="用户 ID（跨库软引用 User）。",
                    ),
                ),
                (
                    "skill_canonical_key",
                    models.CharField(
                        db_index=True,
                        help_text="Canonical key，格式同 AgentSkillLink.skill_canonical_key。",
                        max_length=160,
                    ),
                ),
                (
                    "enabled",
                    models.BooleanField(
                        default=False,
                        help_text=(
                            "用户级总闸（opt-in）：True=打开；False=关闭。无行亦视为关。"
                        ),
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "User Skill Preference",
                "verbose_name_plural": "User Skill Preferences",
                "db_table": "skills_user_preference",
            },
        ),
        migrations.AddConstraint(
            model_name="userskillpreference",
            constraint=models.UniqueConstraint(
                fields=("user_id", "skill_canonical_key"),
                name="uq_user_skill_preference",
            ),
        ),
        migrations.AddIndex(
            model_name="userskillpreference",
            index=models.Index(
                fields=["user_id", "enabled"],
                name="skills_user_user_id_fe996b_idx",
            ),
        ),
    ]
