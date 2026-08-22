from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('media_generation', '0007_alter_mediaprovider_organization_id_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='mediatask',
            name='storage_status',
            field=models.CharField(
                choices=[
                    ('not_started', '未开始'),
                    ('storing', '转存中'),
                    ('succeeded', '已永久保存'),
                    ('partial', '部分永久保存'),
                    ('failed', '转存失败'),
                ],
                default='not_started',
                max_length=20,
                verbose_name='永久存储状态',
            ),
        ),
        migrations.AddField(
            model_name='mediatask',
            name='stored_files',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text='带 file_id、文件名、MIME、大小和永久访问地址的稳定产物身份',
                verbose_name='永久存储文件',
            ),
        ),
    ]
