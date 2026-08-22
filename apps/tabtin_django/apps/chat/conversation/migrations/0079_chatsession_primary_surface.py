from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0078_merge_model_param_overrides_and_runtime_shares'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatsession',
            name='primary_surface',
            field=models.CharField(
                default='chat',
                help_text='任务列表锚点：chat/doc/browser/code；由执行事实更新，非 UI 焦点。',
                max_length=16,
                verbose_name='主工作面',
            ),
        ),
    ]
