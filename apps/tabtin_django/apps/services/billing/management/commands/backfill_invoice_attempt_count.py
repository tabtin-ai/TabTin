"""
一次性回填 BillingInvoice.collection_attempt_count 字段。

从 metadata.collection.attempt_count (JSON) 回填到 DB 字段。
仅更新 DB 字段为 0 但 metadata 中有非零值的记录。

用法:
    python manage.py backfill_invoice_attempt_count
    python manage.py backfill_invoice_attempt_count --dry-run
"""

from django.core.management.base import BaseCommand

from apps.services.billing.models import BillingInvoice


class Command(BaseCommand):
    help = "回填 BillingInvoice.collection_attempt_count（从 metadata.collection.attempt_count）"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="仅统计，不执行更新")
        parser.add_argument("--batch-size", type=int, default=500, help="每批处理数量")

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        batch_size = options["batch_size"]

        qs = BillingInvoice.objects.filter(collection_attempt_count=0)
        total = qs.count()
        self.stdout.write(f"collection_attempt_count=0 的账单总数: {total}")

        updated = 0
        skipped = 0
        offset = 0

        while offset < total:
            batch = list(qs.order_by("created_at")[offset:offset + batch_size])
            if not batch:
                break

            to_update = []
            for inv in batch:
                meta_count = int(
                    (dict(inv.metadata or {}).get("collection") or {}).get("attempt_count") or 0
                )
                if meta_count > 0:
                    inv.collection_attempt_count = meta_count
                    to_update.append(inv)
                else:
                    skipped += 1

            if to_update and not dry_run:
                BillingInvoice.objects.bulk_update(to_update, ["collection_attempt_count"], batch_size=batch_size)

            updated += len(to_update)
            offset += batch_size
            self.stdout.write(f"  已处理 {min(offset, total)}/{total}，待回填: {updated}，跳过: {skipped}")

        action = "将回填" if dry_run else "已回填"
        self.stdout.write(self.style.SUCCESS(f"\n{action} {updated} 条记录，跳过 {skipped} 条（metadata 中无值）"))
