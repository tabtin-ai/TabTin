from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0076_space_visibility"),
    ]

    operations = [
        migrations.AddField(
            model_name="space",
            name="execution_space",
            field=models.ForeignKey(
                blank=True,
                help_text="team_space 用于记录 Owner 选定的个人执行 Space；workspace 类型留空。",
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="team_spaces",
                to="tabtinspace.space",
                verbose_name="团队 Space 固定执行个人 Space",
            ),
        ),
        migrations.AlterField(
            model_name="space",
            name="type",
            field=models.CharField(
                choices=[
                    ("workspace", "Workspace"),
                    ("team_space", "Team Space"),
                ],
                default="workspace",
                max_length=20,
                verbose_name="Space 类型",
            ),
        ),
    ]
