from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('users_auth', '0033_backfill_user_nickname_pinyin_search_keys'),
    ]

    operations = [
        migrations.AlterField(
            model_name='userprofile',
            name='language',
            field=models.CharField(
                choices=[
                    ('system', '跟随系统'),
                    ('zh-CN', '简体中文'),
                    ('zh-TW', '繁體中文'),
                    ('en-US', 'English'),
                    ('ja-JP', '日本語'),
                    ('ko-KR', '한국어'),
                    ('de-DE', 'Deutsch'),
                    ('fr-FR', 'Français'),
                    ('es-ES', 'Español'),
                ],
                default='system',
                max_length=10,
                verbose_name='语言',
            ),
        ),
    ]
