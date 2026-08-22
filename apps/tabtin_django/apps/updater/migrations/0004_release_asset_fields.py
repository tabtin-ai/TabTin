from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("updater", "0003_apprelease_feed_url"),
    ]

    operations = [
        migrations.AlterField(
            model_name="apprelease",
            name="file_url",
            field=models.URLField(blank=True, default="", help_text="安装包下载地址 (CDN)"),
        ),
        migrations.AlterField(
            model_name="apprelease",
            name="file_size",
            field=models.BigIntegerField(default=0, help_text="文件大小（字节）"),
        ),
        migrations.AlterField(
            model_name="apprelease",
            name="checksum_sha256",
            field=models.CharField(
                blank=True,
                default="",
                help_text="SHA256 校验和",
                max_length=64,
            ),
        ),
        migrations.AddField(
            model_name="apprelease",
            name="checksum_sha512",
            field=models.CharField(
                blank=True,
                default="",
                help_text="SHA512 校验和（base64，用于生成 electron manifest）",
                max_length=128,
            ),
        ),
    ]
