# Generated for Wave 2: 错误监控质量提升 — dedup_key partial unique 索引
#
# CREATE UNIQUE INDEX CONCURRENTLY 在 admindash 长期累积的 client_error_event
# 表（数十万到数百万行）上不阻塞 INSERT/UPDATE——传统 AddConstraint 会拿
# ShareLock 全表扫，对线上"上线高峰"窗口不友好。CONCURRENTLY 用 lighter
# weight ShareUpdateExclusiveLock，与 DML 并行。
#
# 几条硬约束（PostgreSQL CREATE INDEX CONCURRENTLY 文档）：
# 1. 不能跑在 transaction 内 → migration 必须 `atomic = False`
# 2. SeparateDatabaseAndState 让 Django 的 state graph 知道 constraint 存在
#    （后续 makemigrations diff 不会重复尝试 AddConstraint）
# 3. RunSQL 用 IF NOT EXISTS 让"本地 dev 库已经在 0008 时建过 index"的场景安全
#    （已存在则跳过，不重建；prod 第一次跑会真创建）
# 4. reverse_sql 用 DROP INDEX CONCURRENTLY 配套 IF EXISTS，确保 rollback
#    场景下也无锁

from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    atomic = False  # CREATE/DROP INDEX CONCURRENTLY 不能跑在 transaction 内

    dependencies = [
        ('client_errors', '0008_add_dedup_key'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=(
                        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS '
                        '"cee_dedup_key_uniq" ON "client_error_event" ("dedup_key") '
                        'WHERE "dedup_key" IS NOT NULL;'
                    ),
                    reverse_sql=(
                        'DROP INDEX CONCURRENTLY IF EXISTS "cee_dedup_key_uniq";'
                    ),
                ),
            ],
            state_operations=[
                migrations.AddConstraint(
                    model_name='clienterrorevent',
                    constraint=models.UniqueConstraint(
                        condition=Q(dedup_key__isnull=False),
                        fields=('dedup_key',),
                        name='cee_dedup_key_uniq',
                    ),
                ),
            ],
        ),
    ]
