from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("tabdata", "0051_tablerecord_position_id"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="recordcomment",
            name="status",
            field=models.CharField(
                choices=[("open", "待处理"), ("resolved", "已解决")],
                default="open",
                max_length=16,
                verbose_name="线程状态",
            ),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="resolved_at",
            field=models.DateTimeField(blank=True, null=True, verbose_name="解决时间"),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="resolved_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="record_comment_threads_resolved",
                to=settings.AUTH_USER_MODEL,
                verbose_name="解决人",
            ),
        ),
        migrations.AddIndex(
            model_name="recordcomment",
            index=models.Index(
                fields=["record", "parent", "status", "created_at"],
                name="td_comment_thread_status_idx",
            ),
        ),
    ]
