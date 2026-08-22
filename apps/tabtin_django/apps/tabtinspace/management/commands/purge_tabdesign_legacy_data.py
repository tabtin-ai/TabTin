"""
删除 TabDesign 遗留数据：ContextItem（PostgreSQL）与 module=tabdesign 的 FileUsage（MySQL）。

TabDesign 已下线，无对应业务表；TrashCleaner 对 tabdesign 仅删除 ContextItem 记录。
运维在部署后执行一次即可（支持 --dry-run）。
"""

from django.core.management.base import BaseCommand

from apps.tabtinspace.constants import REMOVED_CONTEXT_ITEM_TYPES
from apps.tabtinspace.models import ContextItem
from apps.services.oss.models import FileUsage
from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage


class Command(BaseCommand):
    help = "清理 TabDesign 遗留的 ContextItem 与 OSS FileUsage（模块已移除）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="仅打印将要删除的数量，不执行删除",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]

        ci_qs = ContextItem.objects.filter(item_type__in=REMOVED_CONTEXT_ITEM_TYPES)
        ci_count = ci_qs.count()

        fu_qs = FileUsage.objects.filter(module="tabdesign", is_active=True)
        fu_count = fu_qs.count()

        self.stdout.write(
            f"ContextItem (tabdesign/design): {ci_count} 条; "
            f"FileUsage (module=tabdesign, active): {fu_count} 条"
        )

        if dry_run:
            self.stdout.write(self.style.WARNING("dry-run：未执行删除"))
            return

        released = 0
        for usage in fu_qs.select_related("file_record"):
            wt = getattr(usage.file_record, "organization_id", None) if usage.file_record else None
            try:
                n = deactivate_file_usages_and_release_storage(
                    module="tabdesign",
                    context_filter={"id": usage.id},
                    organization_id=str(wt) if wt else "",
                    user_id=str(usage.user_id),
                    biz_type="tabdesign.purge",
                    biz_id=str(usage.id),
                    log_prefix="[purge_tabdesign]",
                )
                released += n
            except Exception as exc:
                self.stderr.write(
                    self.style.ERROR(f"FileUsage {usage.id} 去活失败: {exc}")
                )

        deleted_ci, _ = ci_qs.delete()

        self.stdout.write(
            self.style.SUCCESS(
                f"完成：去活 FileUsage {released} 条，删除 ContextItem {deleted_ci} 条（含关联）"
            )
        )
