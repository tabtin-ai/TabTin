from django.conf import settings
"""
一次性补刷 VersionHistory 的 TTL（expired_at）。

修复历史 bug：修复前所有 VH 都使用 free tier 的 7 天 TTL，
pro/team 用户的版本被提前清理。此命令根据实际会员等级重新计算 expired_at。

用法:
    python manage.py backfill_vh_ttl
    python manage.py backfill_vh_ttl --dry-run
    python manage.py backfill_vh_ttl --batch-size 500
"""
import logging
from collections import defaultdict

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Case, DateTimeField, Q, Value, When
from django.utils import timezone

from apps.collab.constants import TTL_TIERS
from apps.collab.models import VersionHistory
from apps.collab.service import VersionHistoryService

logger = logging.getLogger("collab.backfill_vh_ttl")

DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
class Command(BaseCommand):
    help = "补刷 VersionHistory 的 TTL（根据实际会员等级重新计算 expired_at）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只统计不修改",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=1000,
            help="每批处理数量（默认 1000）",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        batch_size = options["batch_size"]

        if dry_run:
            self.stdout.write(self.style.WARNING("[DRY RUN] 只统计不修改\n"))

        base_qs = (
            VersionHistory.objects.using(DB)
            .filter(expired_at__isnull=False, is_named=False, pinned=False)
            .order_by("created_at")
        )
        total = base_qs.count()
        self.stdout.write(f"待检查 VH 记录总数: {total}")

        if total == 0:
            self.stdout.write(self.style.SUCCESS("无需处理的记录"))
            return

        # 按 (resource_type, resource_id) 分组缓存 organization_id → tier 映射，
        # 避免同一资源的多条 VH 重复查询
        organization_cache: dict[str, str | None] = {}  # organization_id → tier
        resource_organization: dict[str, str | None] = {}  # "type:rid" → organization_id

        stats = defaultdict(int)  # extended / skipped_same / skipped_no_organization / error
        processed = 0

        last_created_at = None
        last_id = None
        while True:
            qs = base_qs
            if last_created_at is not None:
                qs = qs.filter(
                    Q(created_at__gt=last_created_at)
                    | Q(created_at=last_created_at, id__gt=last_id)
                )

            batch = list(
                qs.order_by("created_at", "id").values_list(
                    "id", "resource_type", "resource_id",
                    "organization_id", "created_at", "expired_at",
                )[:batch_size]
            )
            if not batch:
                break

            updates = []  # (vh_id, new_expired_at)

            for vh_id, res_type, res_id, wt_id, created_at, expired_at in batch:
                resource_key = f"{res_type}:{res_id}"

                # 1. 确定 organization_id
                if wt_id:
                    wt_str = str(wt_id)
                elif resource_key in resource_organization:
                    wt_str = resource_organization[resource_key]
                else:
                    from apps.services.billing.organization_resolver import (
                        resolve_organization_id_from_context_item_resource,
                    )
                    wt_str = resolve_organization_id_from_context_item_resource(str(res_id), database=DB)
                    resource_organization[resource_key] = wt_str

                if not wt_str:
                    stats["skipped_no_organization"] += 1
                    continue

                # 2. 获取正确 tier（带缓存）
                if wt_str in organization_cache:
                    tier = organization_cache[wt_str]
                else:
                    tier = VersionHistoryService._resolve_tier_from_organization(wt_str)
                    organization_cache[wt_str] = tier

                # 3. 计算正确的 expired_at
                ttl_delta = TTL_TIERS.get(tier, TTL_TIERS["free"])
                correct_expired_at = created_at + ttl_delta

                # 4. 仅当新值 > 旧值时才更新（延长 TTL，不缩短）
                if correct_expired_at > expired_at:
                    updates.append((vh_id, correct_expired_at))
                    stats["extended"] += 1
                else:
                    stats["skipped_same"] += 1

            if updates and not dry_run:
                cases = [When(id=vh_id, then=Value(exp)) for vh_id, exp in updates]
                with transaction.atomic(using=DB):
                    VersionHistory.objects.using(DB).filter(
                        id__in=[vh_id for vh_id, _ in updates]
                    ).update(
                        expired_at=Case(*cases, output_field=DateTimeField())
                    )

            processed += len(batch)
            last_created_at = batch[-1][4]
            last_id = batch[-1][0]

            if len(batch) < batch_size:
                break

            self.stdout.write(
                f"  进度: {processed}/{total} "
                f"(延长: {stats['extended']}, "
                f"无需: {stats['skipped_same']}, "
                f"无 organization: {stats['skipped_no_organization']})"
            )

        action = "将延长" if dry_run else "已延长"
        self.stdout.write(
            self.style.SUCCESS(
                f"\n完成。共处理 {processed} 条记录:\n"
                f"  {action} TTL: {stats['extended']}\n"
                f"  无需修改: {stats['skipped_same']}\n"
                f"  无 organization（跳过）: {stats['skipped_no_organization']}"
            )
        )
