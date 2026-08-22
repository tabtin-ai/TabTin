from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0127_collection_organization_host_exclusive_7140'),
    ]

    operations = [
        migrations.AddField(
            model_name='workspace',
            name='description',
            field=models.TextField(
                blank=True,
                default='',
                help_text='执行现场的简短用途说明，不参与目录身份或运行时策略判定。',
                verbose_name='简介',
            ),
        ),
    ]
