"""R1-15 partial index 真实规模验证脚本。

用法：
    python manage.py fts_bench_partial_index --rows=500000 [--keep]

行为：
    1. 批量 INSERT 指定数量的 FtsOutboxPg 行（一半 processed_at=NULL，
       一半已处理），所有 doc_id 以 `bench-` 前缀便于清理
    2. 跑 EXPLAIN (ANALYZE, BUFFERS) 模拟 scan_outbox_task 的真实查询，
       观察 PG 是否选 partial index `fts_outbox_pg_pending_idx` 或
       `fts_outbox_pg_wt_pending_idx`
    3. 输出贴到总控 R1-15
    4. 默认运行结束后清理（DELETE WHERE doc_id LIKE 'bench-%'）；
       --keep 保留数据供二次验证

不影响生产：
    - 所有 doc_id 'bench-' 前缀；organization_id='bench-wt-{i%5}'
    - 跑完立即清理，避免污染真实 outbox
"""

from __future__ import annotations

import time
from django.core.management.base import BaseCommand
from django.db import connections
from apps.services.common.db_router import postgres_app_db_alias


class Command(BaseCommand):
    help = "Benchmark FtsOutboxPg partial index on simulated 50w rows."

    def add_arguments(self, parser):
        parser.add_argument(
            "--rows", type=int, default=500_000,
            help="Total rows to insert (half pending, half processed)",
        )
        parser.add_argument(
            "--keep", action="store_true",
            help="Skip cleanup (keep bench rows for further inspection)",
        )
        parser.add_argument(
            "--batch", type=int, default=10_000,
            help="Insert batch size",
        )

    def handle(self, *args, rows: int, keep: bool, batch: int, **opts):
        self.stdout.write(self.style.NOTICE(
            f"[fts_bench] inserting {rows} rows (batch={batch})..."
        ))
        with connections[postgres_app_db_alias()].cursor() as cur:
            t0 = time.time()
            inserted = 0
            for offset in range(0, rows, batch):
                # 50% pending（processed_at=NULL）, 50% processed
                chunk = min(batch, rows - offset)
                values = []
                for i in range(chunk):
                    idx = offset + i
                    is_pending = (idx % 2 == 0)
                    proc_at = "NULL" if is_pending else "NOW() - INTERVAL '1 hour'"
                    organization_id = f"bench-wt-{idx % 5}"
                    values.append(
                        f"('tabtin-resources','bench-{idx}','upsert','{organization_id}',"
                        f"NOW() - (random()*INTERVAL '24 hours'),{proc_at},0,'')"
                    )
                # batch insert
                sql = (
                    "INSERT INTO fts_outbox_pg "
                    "(index_name, doc_id, action, organization_id, created_at, processed_at, "
                    "retry_count, last_error) "
                    "VALUES " + ",".join(values)
                )
                cur.execute(sql)
                inserted += chunk
                if (offset // batch) % 5 == 0:
                    self.stdout.write(f"  inserted {inserted}/{rows}")
            self.stdout.write(self.style.SUCCESS(
                f"[fts_bench] inserted {inserted} in {time.time()-t0:.1f}s"
            ))

            # 关键查询：模拟 scan_outbox_task
            self.stdout.write(self.style.NOTICE("\n[fts_bench] EXPLAIN ANALYZE scan query:"))
            cur.execute(
                "EXPLAIN (ANALYZE, BUFFERS) "
                "SELECT id, index_name, doc_id, action, organization_id, created_at, retry_count "
                "FROM fts_outbox_pg "
                "WHERE processed_at IS NULL AND retry_count < 5 "
                "ORDER BY created_at LIMIT 500"
            )
            for line in cur.fetchall():
                self.stdout.write(line[0])

            self.stdout.write(self.style.NOTICE("\n[fts_bench] EXPLAIN ANALYZE organization-scoped scan:"))
            cur.execute(
                "EXPLAIN (ANALYZE, BUFFERS) "
                "SELECT id FROM fts_outbox_pg "
                "WHERE organization_id='bench-wt-1' AND processed_at IS NULL AND retry_count < 5 "
                "ORDER BY created_at LIMIT 500"
            )
            for line in cur.fetchall():
                self.stdout.write(line[0])

            if not keep:
                self.stdout.write(self.style.NOTICE("\n[fts_bench] cleaning up..."))
                cur.execute("DELETE FROM fts_outbox_pg WHERE doc_id LIKE 'bench-%'")
                self.stdout.write(self.style.SUCCESS("[fts_bench] cleanup done"))
            else:
                self.stdout.write(self.style.WARNING(
                    "[fts_bench] --keep set; bench rows retained "
                    "(run `DELETE FROM fts_outbox_pg WHERE doc_id LIKE 'bench-%';` to clean)"
                ))
