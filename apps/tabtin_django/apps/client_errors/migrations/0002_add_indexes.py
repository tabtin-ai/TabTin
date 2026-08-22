"""
补充联合索引和高频查询字段索引。

- ClientErrorEvent: (fingerprint, user_id) 联合索引 — 加速 user_count 去重查询
- ClientErrorGroup: last_seen 索引 — 加速默认排序和清理任务
- ClientErrorGroup: status 索引 — 加速 AdminDash 按状态筛选
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("client_errors", "0001_initial"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="clienterrorevent",
            index=models.Index(
                fields=["fingerprint", "user_id"],
                name="idx_event_fp_user",
            ),
        ),
        migrations.AddIndex(
            model_name="clienterrorgroup",
            index=models.Index(
                fields=["-last_seen"],
                name="idx_group_last_seen",
            ),
        ),
        migrations.AddIndex(
            model_name="clienterrorgroup",
            index=models.Index(
                fields=["status"],
                name="idx_group_status",
            ),
        ),
    ]
