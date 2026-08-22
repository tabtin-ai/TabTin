"""Wave 6 backfill：把 ``fingerprint_algo_version=0/NULL`` 的极端老数据标成 1。

跑法：
    python manage.py backfill_fingerprint_algo_version

## 设计意图

migration 0010 给 ClientErrorEvent / ClientErrorGroup 加 ``fingerprint_algo_version``
字段时用 ``default=1``——PG 在 ``ADD COLUMN ... DEFAULT 1 NOT NULL`` 时会把所有
已有行标成 1，所以**一般不需要本 backfill**。

但保留这个命令的理由：

1. **幂等兜底**——某些极端 corner（手工 SQL 直接 INSERT 没指定字段、并发 migration
   被打断、未来 schema 变更引入 NULLABLE 临态）会让某些行的
   ``fingerprint_algo_version=0`` 或 ``NULL``。这个命令用 ``filter().update()``
   一次性扫平，跑完所有行 algo_version >= 1。
2. **未来算法升级时的契约入口**——如果未来要 backfill 一批已有事件标到新 algo_version
   （比如某次 patch 想让 v1 / v2 临时统一标 v2），可以扩展本命令加 ``--target-version``
   参数；保持"backfill 入口只有一个 management command"的纪律。

## 幂等保证

- 第一次跑：``filter(algo_version=0).update(algo_version=1)`` → 报告 updated N
- 第二次跑：filter 集为空 → updated 0
- 不会 mutate ``algo_version >= 1`` 的行，**绝不**回滚 v2/v3 → v1
- 只动 PostgreSQL 库（client_errors app 由 db_router 守在 PG）

## 性能

用 ``QuerySet.update()`` 一次性 SQL（不逐条 ``save``），即使表里有几百万行也是
单条 ``UPDATE WHERE`` 在 ``algo_version`` 索引上扫，秒级完成。
"""

from __future__ import annotations

import time

from django.core.management.base import BaseCommand
from django.db.models import Q

from apps.services.common.db_router import postgres_app_db_alias
from apps.client_errors.models import (
    FINGERPRINT_ALGO_VERSION,
    ClientErrorEvent,
    ClientErrorGroup,
)


# 标"未标版本号"的脏数据 → 修成 v1。这条命令**永远**只把 0/NULL 修成 1，
# 不会把已标的 v1/v2/v3 互相搬运——backfill 命令的语义是"补缺"，不是"覆盖"。
_BACKFILL_TARGET_VERSION = 1


class Command(BaseCommand):
    help = (
        "Wave 6 backfill：把 ClientErrorEvent / ClientErrorGroup 中"
        "fingerprint_algo_version=0/NULL 的极端脏数据标成 1（幂等可重跑）"
    )

    def handle(self, *args, **options) -> None:
        start = time.monotonic()
        db = postgres_app_db_alias()

        # PositiveSmallIntegerField default=1 + db migration 后理论上没有 NULL 行，
        # 但保留 isnull 过滤防御未来 schema 演进引入 NULLABLE 临态。
        # 0 是显式 sentinel：手写 SQL 时如果忘指定字段值会被默认 0 写入。
        dirty_filter = Q(fingerprint_algo_version=0) | Q(fingerprint_algo_version__isnull=True)

        events_total = ClientErrorEvent.objects.using(db).count()
        groups_total = ClientErrorGroup.objects.using(db).count()

        events_dirty = ClientErrorEvent.objects.using(db).filter(dirty_filter).count()
        groups_dirty = ClientErrorGroup.objects.using(db).filter(dirty_filter).count()

        self.stdout.write(
            f"[backfill] scan: events={events_total} (dirty={events_dirty}), "
            f"groups={groups_total} (dirty={groups_dirty})"
        )
        self.stdout.write(
            f"[backfill] FINGERPRINT_ALGO_VERSION (current write) = "
            f"{FINGERPRINT_ALGO_VERSION}, backfill target = {_BACKFILL_TARGET_VERSION}"
        )

        # 一次性 UPDATE，不逐条 save——后者会触发 .save signal + N 次 round-trip
        events_updated = (
            ClientErrorEvent.objects.using(db)
            .filter(dirty_filter)
            .update(fingerprint_algo_version=_BACKFILL_TARGET_VERSION)
        )
        groups_updated = (
            ClientErrorGroup.objects.using(db)
            .filter(dirty_filter)
            .update(fingerprint_algo_version=_BACKFILL_TARGET_VERSION)
        )

        elapsed = time.monotonic() - start
        self.stdout.write(self.style.SUCCESS(
            f"[backfill] done: events updated={events_updated}, "
            f"groups updated={groups_updated}, elapsed={elapsed:.2f}s"
        ))

        # 跑完二次 verify——updated 0 是预期幂等态，updated > 0 表示真有脏数据需要修
        residual_events = ClientErrorEvent.objects.using(db).filter(dirty_filter).count()
        residual_groups = ClientErrorGroup.objects.using(db).filter(dirty_filter).count()
        if residual_events or residual_groups:
            # 不抛错——可能是 update 与 count 之间有并发 INSERT 写了脏数据，
            # 下次跑会再修。但日志要醒目让运维知情。
            self.stdout.write(self.style.WARNING(
                f"[backfill] post-update residual: events={residual_events}, "
                f"groups={residual_groups} (并发写？再跑一次本命令即可)"
            ))
