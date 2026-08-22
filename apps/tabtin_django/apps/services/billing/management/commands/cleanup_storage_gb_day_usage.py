from django.core.management.base import BaseCommand

from apps.services.billing.models import BillingUsageDaily


class Command(BaseCommand):
    help = "清理已停用的 storage.gb_day 历史日聚合行"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="只统计不删除")

    def handle(self, *args, **options):
        qs = BillingUsageDaily.objects.filter(meter_key="storage.gb_day")
        count = qs.count()
        if options["dry_run"]:
            self.stdout.write(self.style.WARNING(f"[DRY RUN] 将删除 {count} 条 storage.gb_day 记录"))
            return
        qs.delete()
        self.stdout.write(self.style.SUCCESS(f"已删除 {count} 条 storage.gb_day 记录"))
