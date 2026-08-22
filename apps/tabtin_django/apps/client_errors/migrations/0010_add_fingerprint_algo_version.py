# Generated for Wave 6: 错误监控收敛 — fingerprint 算法版本号字段
#
# 一次 migration 同时给 ClientErrorEvent / ClientErrorGroup 加 ``fingerprint_algo_version``
# 字段：两侧并列字段同语义，合并成一个 migration 比拆 0010/0011 更紧凑——
# Wave 2 时的 0008/0009 拆分是因为后者要 CONCURRENTLY，本次两个 AddField 都是
# instant，不需要拆。
#
# 关键设计（Wave 6 Round 2 review C P1-1 修正）：
# - **不**加 ``db_index=True``。algo_version 是极低基数列（实际 1, 2, 3 几个值），
#   等值索引选择性极差 PG planner 大概率不选；同时 db_index=True 会让 Django
#   migration 跟着 CREATE INDEX 不走 CONCURRENTLY，未来表大时锁表。如果将来真要
#   按 algo_version 过滤（统计 v1/v2 占比之类），用单独 RunSQL CONCURRENTLY 建
#   partial index `WHERE algo_version != 1`——参照 0009 的纪律。
# - PG 11+ 对 ``ALTER TABLE ADD COLUMN ... DEFAULT 1 NOT NULL`` 的 SmallInt 字段
#   走 fast path（O(1) 元数据更新，不重写表）——长期累积的 client_error_event
#   表（数十万行）也能秒级完成，无需 CONCURRENTLY。
# - 仅 PostgreSQL 库执行（client_errors app 全部走 PG，db_router 已守卫）。
# - default=1 让 migration 跑完后**所有**已有行 fingerprint_algo_version 都是 1，
#   语义对应"现存数据按当前 v1 算法分组而成"——这是当前事实（compute_fingerprint
#   现在的实现就是 v1）。如果未来 bump 到 v2，新 ingest 的事件会自动写 2，
#   migration 创建的"全部 1"基线不会被错误覆盖。
# - ``backfill_fingerprint_algo_version`` 命令是幂等兜底，仅修复极端 corner
#   （比如手工 SQL 写过 0 / NULL 的脏数据），不会 mutate 已标版本号的行。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('client_errors', '0009_add_dedup_key_partial_unique'),
    ]

    operations = [
        migrations.AddField(
            model_name='clienterrorevent',
            name='fingerprint_algo_version',
            field=models.PositiveSmallIntegerField(
                default=1,
                verbose_name='fingerprint 算法版本',
            ),
        ),
        migrations.AddField(
            model_name='clienterrorgroup',
            name='fingerprint_algo_version',
            field=models.PositiveSmallIntegerField(
                default=1,
                verbose_name='fingerprint 算法版本',
            ),
        ),
    ]
