from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0017_alter_document_space_id"),
    ]

    operations = [
        migrations.AddField(
            model_name="documentsharecomment",
            name="mention_user_ids",
            field=models.JSONField(blank=True, default=list, verbose_name="提及用户 ID 列表"),
        ),
    ]
