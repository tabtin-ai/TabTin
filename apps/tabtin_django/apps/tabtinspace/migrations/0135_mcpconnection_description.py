from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0134_workspace_default_full_access_8004'),
    ]

    operations = [
        migrations.AddField(
            model_name='mcpconnection',
            name='description',
            field=models.TextField(
                blank=True,
                default='',
                help_text='可选；卡片与组织精选优先展示',
                verbose_name='描述',
            ),
        ),
    ]
