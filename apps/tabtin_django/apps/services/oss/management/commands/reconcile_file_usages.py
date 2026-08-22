"""
FileUsage 对账命令 — 校验并修复 FileRecord.ref_count 与实际 active FileUsage 的一致性。

功能：
  1. ref_count 一致性修复：扫描 FileRecord，比对实际 active FileUsage 数量，不一致时修复
  2. 孤儿 FileUsage 检测：is_active=True 但关联资源已不存在的 FileUsage（仅报告）

用法:
    python manage.py reconcile_file_usages
    python manage.py reconcile_file_usages --dry-run
    python manage.py reconcile_file_usages --batch-size 1000
    python manage.py reconcile_file_usages --organization <organization_id>
"""
import logging
import time

from django.core.management.base import BaseCommand
from django.db import models, transaction

logger = logging.getLogger("oss.reconcile")

# 不一致详情最多保留条数，防止极端场景下内存溢出
_MAX_DETAIL_ENTRIES = 200


class Command(BaseCommand):
    help = "校验并修复 FileRecord.ref_count 与实际 active FileUsage 数量的一致性"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="仅报告不一致项，不执行修复",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=500,
            help="每批处理的 FileRecord 数量（默认 500）",
        )
        parser.add_argument(
            "--organization",
            type=str,
            default=None,
            help="只扫描指定 organization_id 的 FileRecord",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        batch_size = options["batch_size"]
        organization_id = options["organization"]

        mode_label = "DRY-RUN" if dry_run else "LIVE"
        self.stdout.write(f"\n{'='*60}")
        self.stdout.write(f"FileUsage 对账 [{mode_label}]  batch_size={batch_size}")
        if organization_id:
            self.stdout.write(f"  过滤 organization: {organization_id}")
        self.stdout.write(f"{'='*60}\n")

        t0 = time.monotonic()

        try:
            # ── 第一阶段：ref_count 一致性校验与修复 ──
            ref_stats = self._reconcile_ref_counts(
                dry_run=dry_run, batch_size=batch_size, organization_id=organization_id,
            )

            # ── 第二阶段：孤儿 FileUsage 检测 ──
            orphan_stats = self._detect_orphan_usages(batch_size=batch_size)
        except KeyboardInterrupt:
            self.stderr.write(self.style.ERROR("\n对账被手动中断 (Ctrl+C)"))
            return
        except Exception as exc:
            self.stderr.write(self.style.ERROR(f"\n对账异常终止: {exc}"))
            logger.error("FileUsage 对账异常: %s", exc, exc_info=True)
            return

        elapsed = time.monotonic() - t0

        # ── 汇总报告 ──
        self.stdout.write(f"\n{'='*60}")
        self.stdout.write("对账完成 — 汇总报告")
        self.stdout.write(f"{'='*60}")
        self.stdout.write(f"  模式:              {mode_label}")
        self.stdout.write(f"  扫描 FileRecord:   {ref_stats['scanned']}")
        self.stdout.write(f"  不一致数:          {ref_stats['mismatched']}")
        self.stdout.write(f"  已修复数:          {ref_stats['fixed']}")
        if ref_stats["repair_failed"] > 0:
            self.stdout.write(
                self.style.ERROR(f"  修复失败数:        {ref_stats['repair_failed']}")
            )
        self.stdout.write(f"  孤儿 FileUsage:    {orphan_stats['orphan_count']}")
        self.stdout.write(f"  耗时:              {elapsed:.2f}s")
        self.stdout.write(f"{'='*60}\n")

        logger.info(
            "FileUsage 对账完成: mode=%s, scanned=%d, mismatched=%d, fixed=%d, "
            "repair_failed=%d, orphans=%d, elapsed=%.2fs",
            mode_label,
            ref_stats["scanned"],
            ref_stats["mismatched"],
            ref_stats["fixed"],
            ref_stats["repair_failed"],
            orphan_stats["orphan_count"],
            elapsed,
        )

    def _reconcile_ref_counts(
        self, *, dry_run: bool, batch_size: int, organization_id: str | None,
    ) -> dict:
        """扫描所有非 deleted 的 FileRecord，比对 ref_count 与实际 active FileUsage 数量。

        使用 pk 游标分页（id__gt）避免 OFFSET 在大数据量下的性能退化。
        """
        from apps.services.oss.models import FileRecord, FileUsage

        self.stdout.write("\n── 阶段 1: ref_count 一致性校验 ──\n")

        stats = {"scanned": 0, "mismatched": 0, "fixed": 0, "repair_failed": 0}
        mismatch_details: list[str] = []

        base_qs = FileRecord.objects.exclude(status="deleted")
        if organization_id:
            base_qs = base_qs.filter(organization_id=organization_id)

        # pk 游标分页：每批取 id > last_id 的前 batch_size 条
        last_id = None
        last_progress_time = time.monotonic()

        while True:
            qs = (
                base_qs
                .annotate(actual_active=models.Count(
                    "usages",
                    filter=models.Q(usages__is_active=True),
                ))
                .only("id", "file_name", "ref_count")
                .order_by("id")
            )
            if last_id is not None:
                qs = qs.filter(id__gt=last_id)

            batch = list(qs[:batch_size])
            if not batch:
                break

            for record in batch:
                stats["scanned"] += 1
                expected = record.actual_active
                current = record.ref_count

                if current != expected:
                    stats["mismatched"] += 1

                    if len(mismatch_details) < _MAX_DETAIL_ENTRIES:
                        detail = (
                            f"file={record.id} name={record.file_name!r} "
                            f"ref_count={current} actual_active={expected}"
                        )
                        mismatch_details.append(detail)
                    logger.warning(
                        "ref_count 不一致: file=%s, ref_count=%d, actual_active=%d",
                        record.id, current, expected,
                    )

                    if not dry_run:
                        try:
                            with transaction.atomic():
                                locked = (
                                    FileRecord.objects
                                    .select_for_update()
                                    .filter(id=record.id)
                                    .first()
                                )
                                if locked is None:
                                    continue
                                # 在锁内重新计算，确保并发安全
                                real_count = FileUsage.objects.filter(
                                    file_record_id=record.id,
                                    is_active=True,
                                ).count()
                                if locked.ref_count != real_count:
                                    old_val = locked.ref_count
                                    locked.ref_count = real_count
                                    locked.save(update_fields=["ref_count"])
                                    stats["fixed"] += 1
                                    logger.info(
                                        "ref_count 已修复: file=%s, %d → %d",
                                        record.id, old_val, real_count,
                                    )
                        except Exception as exc:
                            stats["repair_failed"] += 1
                            logger.error(
                                "ref_count 修复失败: file=%s, err=%s",
                                record.id, exc, exc_info=True,
                            )
                            self.stderr.write(
                                self.style.ERROR(
                                    f"  ✗ 修复失败: file={record.id}, err={exc}"
                                )
                            )

            last_id = batch[-1].id

            # 每 30 秒或每 5000 条输出一次进度
            now = time.monotonic()
            if stats["scanned"] % 5000 == 0 or (now - last_progress_time) >= 30:
                self.stdout.write(f"  ... 已扫描 {stats['scanned']} 条")
                last_progress_time = now

        # 结束时输出一次进度
        self.stdout.write(f"  扫描完成: 共 {stats['scanned']} 条")

        if mismatch_details:
            self.stdout.write(
                self.style.WARNING(f"\n  发现 {stats['mismatched']} 条不一致:")
            )
            for detail in mismatch_details[:20]:
                self.stdout.write(f"    - {detail}")
            remaining = stats["mismatched"] - 20
            if remaining > 0:
                self.stdout.write(f"    ... 还有 {remaining} 条")

            if not dry_run:
                self.stdout.write(
                    self.style.SUCCESS(f"  已修复 {stats['fixed']} 条")
                )
                if stats["repair_failed"] > 0:
                    self.stderr.write(
                        self.style.ERROR(
                            f"  修复失败 {stats['repair_failed']} 条，请查看日志排查"
                        )
                    )
        else:
            self.stdout.write(self.style.SUCCESS("  所有 ref_count 一致 ✓"))

        return stats

    def _detect_orphan_usages(self, *, batch_size: int) -> dict:
        """检测 is_active=True 但关联 FileRecord 已被删除（或不存在）的孤儿 FileUsage。"""
        from apps.services.oss.models import FileUsage

        self.stdout.write("\n── 阶段 2: 孤儿 FileUsage 检测 ──\n")

        orphan_count = 0
        orphan_samples: list[dict] = []

        # 情况 1：FileRecord 已被软删除（status='deleted'）
        qs_deleted = (
            FileUsage.objects
            .filter(is_active=True, file_record__status="deleted")
            .select_related("file_record")
            .only("id", "module", "context_type", "context_id", "file_record__id")
            .order_by("id")
        )

        for usage in qs_deleted.iterator(chunk_size=batch_size):
            orphan_count += 1
            if len(orphan_samples) < _MAX_DETAIL_ENTRIES:
                orphan_samples.append({
                    "usage_id": str(usage.id),
                    "module": usage.module,
                    "context": f"{usage.context_type}:{usage.context_id}",
                    "file_record_id": str(usage.file_record_id),
                    "reason": "file_record_deleted",
                })

        deleted_count = orphan_count

        # 情况 2：FileRecord 物理不存在（on_delete=CASCADE 下极端防御性检测）
        qs_missing = (
            FileUsage.objects
            .filter(is_active=True, file_record__isnull=True)
            .only("id", "module", "context_type", "context_id", "file_record_id")
            .order_by("id")
        )
        for usage in qs_missing.iterator(chunk_size=batch_size):
            orphan_count += 1
            if len(orphan_samples) < _MAX_DETAIL_ENTRIES:
                orphan_samples.append({
                    "usage_id": str(usage.id),
                    "module": usage.module,
                    "context": f"{usage.context_type}:{usage.context_id}",
                    "file_record_id": str(usage.file_record_id),
                    "reason": "file_record_missing",
                })

        missing_count = orphan_count - deleted_count
        stats = {"orphan_count": orphan_count}

        if orphan_count:
            self.stdout.write(
                self.style.WARNING(
                    f"  发现 {orphan_count} 条孤儿 FileUsage"
                    f"（deleted={deleted_count}, missing={missing_count}）"
                    f"（仅报告，未自动处理）:"
                )
            )
            for item in orphan_samples[:20]:
                self.stdout.write(
                    f"    - usage={item['usage_id']} module={item['module']} "
                    f"context={item['context']} reason={item['reason']}"
                )
            if orphan_count > 20:
                self.stdout.write(f"    ... 还有 {orphan_count - 20} 条")

            logger.warning(
                "孤儿 FileUsage 检测: 共 %d 条 (deleted=%d, missing=%d)",
                orphan_count, deleted_count, missing_count,
            )
        else:
            self.stdout.write(self.style.SUCCESS("  无孤儿 FileUsage ✓"))

        return stats
