"""技能库总闸改为默认开（opt-out），并清偿历史 enabled=False。

技能库页不再暴露总闸开关；无偏好行与显式关闭行都应视为可用，
避免用户无法从 UI 重开。
"""

from django.db import migrations, models


def clear_disabled_user_gates(apps, schema_editor):
    UserSkillPreference = apps.get_model("skills", "UserSkillPreference")
    UserSkillPreference.objects.filter(enabled=False).delete()


def noop_reverse(apps, schema_editor):
    # 无法可靠恢复已删除的 opt-out 关闭行。
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0017_backfill_user_skill_preference"),
    ]

    operations = [
        migrations.RunPython(clear_disabled_user_gates, noop_reverse),
        migrations.AlterField(
            model_name="userskillpreference",
            name="enabled",
            field=models.BooleanField(
                default=True,
                help_text="用户级总闸（opt-out）：True=打开；False=关闭。无行亦视为开。",
            ),
        ),
    ]
