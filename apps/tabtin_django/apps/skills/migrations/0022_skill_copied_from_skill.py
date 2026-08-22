from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0021_personal_import_source_url_unique"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(
                    model_name="agentskilllink",
                    name="skill_canonical_key",
                    field=models.CharField(
                        db_index=True,
                        help_text=(
                            "Canonical key（用于 LocalSkillRegistry 检索）。"
                            "格式：user:<slug> / platform:<id> / "
                            "app:<app_id>/<id> / device:<id> / "
                            "workspace:<rel-path>。"
                        ),
                        max_length=160,
                    ),
                ),
                migrations.AlterField(
                    model_name="agentskilllink",
                    name="skill_id",
                    field=models.UUIDField(
                        blank=True,
                        db_index=True,
                        help_text=(
                            "user 来源时指向 Skill 表行；"
                            "platform/app/device/workspace 来源为 NULL"
                            "（同 SkillEnablement 约定）。"
                        ),
                        null=True,
                    ),
                ),
                migrations.AlterField(
                    model_name="agentskilllink",
                    name="source",
                    field=models.CharField(
                        help_text=(
                            "冗余 source 标记"
                            "（platform/app/device/user/workspace），"
                            "语义同 SkillEnablement.source。"
                        ),
                        max_length=16,
                    ),
                ),
            ],
        ),
        migrations.AddField(
            model_name="skill",
            name="copied_from_skill",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "个人接入副本的组织精选来源。仅用于来源追踪和幂等；"
                    "来源下架删除后置空，不影响个人副本。"
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="acquired_copies",
                to="skills.skill",
            ),
        ),
        migrations.AddConstraint(
            model_name="skill",
            constraint=models.UniqueConstraint(
                condition=models.Q(copied_from_skill__isnull=False),
                fields=("owner_user_id", "copied_from_skill"),
                name="uq_skill_owner_copied_from",
            ),
        ),
    ]
