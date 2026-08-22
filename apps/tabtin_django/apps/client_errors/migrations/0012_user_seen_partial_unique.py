# Generated for Wave 6 Round 2 P1-4：ClientErrorGroupUserSeen / ClientErrorReleaseUserSeen
# 的 partial unique 索引（PG 专属）。
#
# 与 Wave 2 migration 0009 (dedup_key partial unique) 同纪律：
# - ``CREATE UNIQUE INDEX CONCURRENTLY`` 不阻塞 INSERT/UPDATE，长期累积后也安全
#   （表新建时 size=0 瞬间完成，但保留 CONCURRENTLY 一致性纪律）
# - ``atomic = False``：CREATE INDEX CONCURRENTLY 不能跑在 transaction 内
# - ``SeparateDatabaseAndState`` 让 Django state graph 知道 constraint 存在
#   （后续 makemigrations diff 不会重复尝试 AddConstraint）
# - ``RunSQL IF NOT EXISTS`` 让"本地 dev 库已经在 0011 时建过 index"的场景安全
# - 配套 reverse_sql 用 ``DROP INDEX CONCURRENTLY IF EXISTS`` 保 rollback 也无锁
#
# partial 条件 ``WHERE user_id <> ''``：与 ingest 路径保持一致——user_id="" 是
# anonymous 上报，不参与 user_count 计算。

from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    atomic = False  # CREATE/DROP INDEX CONCURRENTLY 不能跑在 transaction 内

    dependencies = [
        ('client_errors', '0011_add_original_fingerprint_and_user_seen'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=(
                        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS '
                        '"cegus_group_user_uniq" ON "client_error_group_user_seen" '
                        '("group_id", "user_id") WHERE "user_id" <> \'\';'
                    ),
                    reverse_sql=(
                        'DROP INDEX CONCURRENTLY IF EXISTS "cegus_group_user_uniq";'
                    ),
                ),
                migrations.RunSQL(
                    sql=(
                        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS '
                        '"cerus_release_user_uniq" ON "client_error_release_user_seen" '
                        '("release_id", "user_id") WHERE "user_id" <> \'\';'
                    ),
                    reverse_sql=(
                        'DROP INDEX CONCURRENTLY IF EXISTS "cerus_release_user_uniq";'
                    ),
                ),
            ],
            state_operations=[
                migrations.AddConstraint(
                    model_name='clienterrorgroupuserseen',
                    constraint=models.UniqueConstraint(
                        fields=('group', 'user_id'),
                        condition=Q(user_id__gt=''),
                        name='cegus_group_user_uniq',
                    ),
                ),
                migrations.AddConstraint(
                    model_name='clienterrorreleaseuserseen',
                    constraint=models.UniqueConstraint(
                        fields=('release', 'user_id'),
                        condition=Q(user_id__gt=''),
                        name='cerus_release_user_uniq',
                    ),
                ),
            ],
        ),
    ]
