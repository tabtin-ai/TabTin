from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("users_auth", "0031_provider_credit_admin_permissions")]

    operations = [
        migrations.AddField(
            model_name="user",
            name="nickname_pinyin",
            field=models.CharField(
                blank=True,
                default="",
                max_length=300,
                verbose_name="昵称全拼搜索键",
            ),
        ),
        migrations.AddField(
            model_name="user",
            name="nickname_pinyin_initials",
            field=models.CharField(
                blank=True,
                default="",
                max_length=50,
                verbose_name="昵称拼音首字母搜索键",
            ),
        ),
    ]
