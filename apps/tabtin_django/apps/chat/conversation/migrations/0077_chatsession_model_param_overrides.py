from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('conversation', '0076_chatsession_default_full_access_8004'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatsession',
            name='model_param_overrides',
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text='当前模型的会话级运行参数覆盖；切换模型时清空。',
                verbose_name='模型运行参数',
            ),
        ),
    ]
