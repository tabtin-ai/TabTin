# Generated for Wave 2: 错误监控质量提升 — 客户端去重键 (dedup_key)
#
# 仅添加 dedup_key 字段；partial unique 索引在 0009 用 CREATE INDEX CONCURRENTLY
# 单独建立，避免 admindash 表上拿写锁阻塞 INSERT。
#
# - null=True 是 partial unique 的前提：老 event / 非 fatal 事件 dedup_key 为
#   NULL，partial unique 索引把 NULL 行排除在唯一约束外，从而保留向前兼容。
# - 仅 PostgreSQL 库执行（client_errors app 全部走 PG，db_router 已守卫）。
# - AddField 在 PG 11+ 对 NULLABLE 列默认是 O(1) ADD COLUMN，不重写表，安全。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('client_errors', '0007_add_component_stack'),
    ]

    operations = [
        migrations.AddField(
            model_name='clienterrorevent',
            name='dedup_key',
            field=models.CharField(
                blank=True,
                default=None,
                max_length=64,
                null=True,
                verbose_name='客户端去重键',
            ),
        ),
    ]
