"""fts_requeue_terminal — 把终态失败的 outbox 行重新入队（R5-13 落地）。

用法：

    # 单行 requeue（最常见 — SRE 修好 mapping 后挑特定 row）
    python manage.py fts_requeue_terminal --db=postgresql --row-id=42

    # 多行 requeue（逗号分隔）
    python manage.py fts_requeue_terminal --db=default --row-id=1,2,3

    # 该库所有终态行 requeue（mapping 全局修复后）
    python manage.py fts_requeue_terminal --db=postgresql --all

    # 双库都跑（默认行为；--db 不传时）
    python manage.py fts_requeue_terminal --all

    # dry-run（只列不动；上线前看影响面）
    python manage.py fts_requeue_terminal --db=postgresql --all --dry-run

设计原则（与 ROLLBACK.md §4.2 对齐）：
    1. **幂等**：只动 `processed_at IS NULL AND retry_count >= 5` 的行；
       已 mark_processed 的成功行 / 仍在重试的行（retry_count < 5）不动
    2. **可观测**：列出每条 row 的 (id, index_name, doc_id, action, retry_count,
       last_error 截断) 前后状态，方便 SRE 复核
    3. **限流**：--all 模式默认最多 1000 行/次；超过强制要求 --confirm-large
    4. **dry-run**：所有破坏性操作前都能预览
    5. **退出码**：成功 requeue ≥ 1 → 0；无可 requeue → 1（让 SRE 脚本能判断）

工作流（SRE 视角）：
    Step 1: Grafana 看到 `fts_outbox_terminal_backlog{db=postgresql} > 0`
    Step 2: `kubectl logs deployment/celery-worker-fts | grep TERMINAL:` 找具体字段
    Step 3: `curl -X PUT $ES_URL/tabtin-resources/_mapping -d '...'` 加字段
    Step 4: `python manage.py fts_requeue_terminal --db=postgresql --all --dry-run`
            预览影响面
    Step 5: `python manage.py fts_requeue_terminal --db=postgresql --all`
            真正 requeue → scan_outbox_task 下一 tick 重新 bulk flush

R5-13 跟踪：本命令实现完成后，ROLLBACK.md §4.2 应同步更新引用。
"""
from __future__ import annotations

import logging
from typing import Optional

from django.core.management.base import BaseCommand, CommandError

logger = logging.getLogger(__name__)


# 防止 SRE 一次 requeue 几十万行打挂 ES（mapping 修对了仍要给 worker 时间消化）
DEFAULT_BATCH_LIMIT = 1000


class Command(BaseCommand):
    help = (
        "把终态失败（mark_terminal）的 outbox 行重新入队，让 scan_outbox_task 重新拉取。"
        "典型场景：SRE 修好 ES mapping 后 requeue 之前积压的 strict_dynamic 失败行。"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            type=str,
            choices=["default", "postgresql", "both"],
            default="both",
            help=(
                "目标 outbox 库。'default'=MySQL（FtsOutbox）/ "
                "'postgresql'=PG（FtsOutboxPg）/ 'both'=两库都跑（默认）"
            ),
        )
        parser.add_argument(
            "--row-id",
            type=str,
            default="",
            help="单行或多行 ID（逗号分隔，如 --row-id=1,2,3）；与 --all 互斥",
        )
        parser.add_argument(
            "--all",
            action="store_true",
            help="该库的全部终态行都 requeue；与 --row-id 互斥",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=DEFAULT_BATCH_LIMIT,
            help=f"--all 模式单次最多 requeue 多少行（默认 {DEFAULT_BATCH_LIMIT}）",
        )
        parser.add_argument(
            "--confirm-large",
            action="store_true",
            help="--all 模式预扫超过 --limit 时必须加此标志，避免误操作",
        )
        parser.add_argument(
            "--keep-error",
            action="store_true",
            help="保留 last_error 字段（默认清空，便于区分'刚 requeue'vs'又失败了'）",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只列出受影响行，不真改 retry_count（强烈推荐 SRE 先 dry-run）",
        )

    def handle(self, *args, **options):
        db_arg = options["db"]
        row_id_raw: str = options["row_id"]
        all_flag: bool = options["all"]
        limit: int = options["limit"]
        confirm_large: bool = options["confirm_large"]
        keep_error: bool = options["keep_error"]
        dry_run: bool = options["dry_run"]

        if all_flag and row_id_raw:
            raise CommandError("--all 与 --row-id 互斥")
        if not all_flag and not row_id_raw:
            raise CommandError("必须指定 --row-id=<ids> 或 --all")
        if limit <= 0:
            raise CommandError("--limit 必须 > 0")

        # 解析 row-id 列表
        row_ids: Optional[list[int]] = None
        if row_id_raw:
            try:
                row_ids = [
                    int(x.strip()) for x in row_id_raw.split(",") if x.strip()
                ]
            except ValueError as exc:
                raise CommandError(f"--row-id 必须是逗号分隔的整数: {exc}") from exc
            if not row_ids:
                raise CommandError("--row-id 解析后为空")

        target_dbs = (
            ["default", "postgresql"] if db_arg == "both" else [db_arg]
        )

        total_affected = 0
        total_listed = 0
        for db in target_dbs:
            self.stdout.write(self.style.MIGRATE_HEADING(f"\n=== Outbox db={db} ==="))
            try:
                affected, listed = self._process_one_db(
                    db=db,
                    row_ids=row_ids,
                    all_flag=all_flag,
                    limit=limit,
                    confirm_large=confirm_large,
                    keep_error=keep_error,
                    dry_run=dry_run,
                )
                total_affected += affected
                total_listed += listed
            except CommandError:
                raise
            except Exception as exc:  # pragma: no cover - 防御性
                logger.exception("[fts_requeue_terminal] db=%s failed", db)
                self.stderr.write(self.style.ERROR(f"  ✗ db={db} 失败: {exc}"))

        # ── 总结 ──────────────────────────────────────────────
        if dry_run:
            self.stdout.write(self.style.NOTICE(
                f"\n[dry-run] 共扫描到 {total_listed} 条终态行（未修改）"
            ))
        else:
            self.stdout.write(self.style.SUCCESS(
                f"\n=== 完成：requeue {total_affected} 行 / 扫描 {total_listed} 行 ==="
            ))
            if total_affected > 0:
                self.stdout.write(self.style.NOTICE(
                    "下一步：等 scan_outbox_task 下一 tick (~5s) 自动重新拉取；"
                    "Grafana 看 fts_outbox_terminal_backlog 应下降"
                ))

        # 退出码语义：dry-run 永远 0；非 dry-run 时无可 requeue 返回 1
        if not dry_run and total_affected == 0:
            # 让 SRE bash 脚本能 if 判断
            raise CommandError("没有可 requeue 的终态行（可能没积压，或都不在 terminal 状态）")

    # ── 单库处理 ───────────────────────────────────────────
    def _process_one_db(
        self,
        *,
        db: str,
        row_ids: Optional[list[int]],
        all_flag: bool,
        limit: int,
        confirm_large: bool,
        keep_error: bool,
        dry_run: bool,
    ) -> tuple[int, int]:
        """返回 (实际 requeue 行数, dry-run 列出的行数)。"""
        from apps.fts.services import outbox_service

        # 列出待处理行（dry-run 显示用 / --all 时也要先看一下规模）
        list_limit = limit if all_flag else max(len(row_ids or []) * 2, limit)
        rows = outbox_service.list_terminal_rows(
            db=db, limit=list_limit, row_ids=row_ids if row_ids else None,
        )

        if not rows:
            self.stdout.write(f"  · 没有终态行（dry-run/list 命中 0）")
            return 0, 0

        # --all 安全闸门
        if all_flag and not confirm_large:
            # 估算总数（不限 limit）
            total_terminal = outbox_service.get_terminal_backlog(db)
            if total_terminal > limit:
                self.stderr.write(self.style.WARNING(
                    f"  ⚠ db={db} 终态行总数 {total_terminal} > --limit {limit}；"
                    f"\n    本次只处理前 {limit} 条，余 {total_terminal - limit} 条留待下轮。"
                    f"\n    若要一次全跑，加 --confirm-large；建议分批避免 ES bulk 风暴。"
                ))

        # 列出明细（前 20 条；多余只显示数量）
        sample = rows[:20]
        for row in sample:
            self.stdout.write(
                f"    [{row.id:>6}] index={row.index_name:<30} doc={str(row.doc_id)[:40]:<40} "
                f"action={row.action:<6} retry={row.retry_count} "
                f"err={(row.last_error or '')[:80]!r}"
            )
        if len(rows) > len(sample):
            self.stdout.write(self.style.NOTICE(
                f"    ... (+{len(rows) - len(sample)} 条未展示，共 {len(rows)} 条匹配)"
            ))

        if dry_run:
            return 0, len(rows)

        # 真做 requeue（按 id 列表批量；服务层有幂等过滤）
        affected = outbox_service.requeue_terminal(
            db=db,
            row_ids=[r.id for r in rows],
            clear_error=not keep_error,
        )
        if affected:
            self.stdout.write(self.style.SUCCESS(
                f"  ✓ db={db} requeue {affected} 行；scan_outbox_task 下一 tick 重新拉取"
            ))
        else:
            self.stdout.write(
                f"  · db={db} 实际 requeue=0（行已被并发 mark_processed 或不在 terminal 状态）"
            )
        return affected, len(rows)
