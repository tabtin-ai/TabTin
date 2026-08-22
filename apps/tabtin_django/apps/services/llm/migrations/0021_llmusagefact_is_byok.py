from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0020_alter_llmmodel_wire_adapter_disabled'),
    ]

    operations = [
        migrations.AddField(
            model_name='llmusagefact',
            name='is_byok',
            field=models.BooleanField(default=False, db_index=True, verbose_name='是否BYOK调用'),
        ),
    ]
