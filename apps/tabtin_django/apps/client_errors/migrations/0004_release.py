from django.db import migrations, models
import django.utils.timezone


class Migration(migrations.Migration):

    dependencies = [
        ("client_errors", "0003_sourcemapfile"),
    ]

    operations = [
        migrations.CreateModel(
            name="Release",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("app_version", models.CharField(db_index=True, max_length=64, unique=True, verbose_name="版本号")),
                ("first_seen", models.DateTimeField(default=django.utils.timezone.now, verbose_name="首次出现")),
                ("last_seen", models.DateTimeField(default=django.utils.timezone.now, verbose_name="最近出现")),
                ("event_count", models.PositiveIntegerField(default=0, verbose_name="错误事件数")),
                ("new_group_count", models.PositiveIntegerField(default=0, verbose_name="新增错误分组数")),
                ("user_count", models.PositiveIntegerField(default=0, verbose_name="影响用户数")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "db_table": "client_error_release",
                "ordering": ["-first_seen"],
            },
        ),
    ]
