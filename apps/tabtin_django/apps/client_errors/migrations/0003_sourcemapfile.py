from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("client_errors", "0002_add_indexes"),
    ]

    operations = [
        migrations.CreateModel(
            name="SourceMapFile",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("app_version", models.CharField(db_index=True, max_length=64, verbose_name="应用版本")),
                ("file_path", models.CharField(max_length=512, verbose_name="JS文件路径")),
                ("map_data", models.TextField(verbose_name="SourceMap JSON")),
                ("uploaded_at", models.DateTimeField(auto_now_add=True, verbose_name="上传时间")),
            ],
            options={
                "db_table": "client_error_sourcemap",
                "unique_together": {("app_version", "file_path")},
            },
        ),
    ]
