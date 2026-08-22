import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="ClientErrorGroup",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("fingerprint", models.CharField(db_index=True, max_length=64, unique=True, verbose_name="错误指纹")),
                ("title", models.CharField(max_length=512, verbose_name="错误标题")),
                ("level", models.CharField(choices=[("error", "Error"), ("warning", "Warning"), ("fatal", "Fatal")], default="error", max_length=16, verbose_name="严重级别")),
                ("status", models.CharField(choices=[("open", "待处理"), ("confirmed", "已确认"), ("resolved", "已修复"), ("ignored", "已忽略")], default="open", max_length=16, verbose_name="处理状态")),
                ("first_seen", models.DateTimeField(default=django.utils.timezone.now, verbose_name="首次出现")),
                ("last_seen", models.DateTimeField(default=django.utils.timezone.now, verbose_name="最近出现")),
                ("event_count", models.PositiveIntegerField(default=1, verbose_name="出现次数")),
                ("user_count", models.PositiveIntegerField(default=1, verbose_name="影响用户数")),
                ("sample_stack_trace", models.TextField(blank=True, default="", verbose_name="示例堆栈")),
                ("sample_app_version", models.CharField(blank=True, default="", max_length=64, verbose_name="示例版本号")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "client_error_group",
                "ordering": ["-last_seen"],
            },
        ),
        migrations.CreateModel(
            name="ClientErrorEvent",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("error_type", models.CharField(max_length=128, verbose_name="错误类型")),
                ("message", models.TextField(verbose_name="错误消息")),
                ("stack_trace", models.TextField(blank=True, default="", verbose_name="堆栈信息")),
                ("level", models.CharField(default="error", max_length=16, verbose_name="级别")),
                ("source", models.CharField(default="renderer", max_length=32, verbose_name="来源进程")),
                ("file", models.CharField(blank=True, default="", max_length=512, verbose_name="文件路径")),
                ("line", models.PositiveIntegerField(blank=True, null=True, verbose_name="行号")),
                ("column", models.PositiveIntegerField(blank=True, null=True, verbose_name="列号")),
                ("breadcrumbs", models.JSONField(blank=True, default=list, verbose_name="操作轨迹")),
                ("user_id", models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="用户ID")),
                ("app_version", models.CharField(blank=True, default="", max_length=64, verbose_name="应用版本")),
                ("electron_version", models.CharField(blank=True, default="", max_length=32, verbose_name="Electron版本")),
                ("os_name", models.CharField(blank=True, default="", max_length=32, verbose_name="操作系统")),
                ("os_version", models.CharField(blank=True, default="", max_length=64, verbose_name="系统版本")),
                ("arch", models.CharField(blank=True, default="", max_length=16, verbose_name="CPU架构")),
                ("locale", models.CharField(blank=True, default="", max_length=16, verbose_name="语言")),
                ("extra", models.JSONField(blank=True, default=dict, verbose_name="附加信息")),
                ("fingerprint", models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="错误指纹")),
                ("occurred_at", models.DateTimeField(db_index=True, default=django.utils.timezone.now, verbose_name="发生时间")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="入库时间")),
                ("group", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="events", to="client_errors.clienterrorgroup")),
            ],
            options={
                "db_table": "client_error_event",
                "ordering": ["-occurred_at"],
            },
        ),
    ]
