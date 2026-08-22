from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0063_merge_20260620_1540"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="workteammember",
            index=models.Index(
                fields=["workteam", "-joined_at"],
                name="ctx_wm_wt_joined_desc_idx",
            ),
        ),
    ]
