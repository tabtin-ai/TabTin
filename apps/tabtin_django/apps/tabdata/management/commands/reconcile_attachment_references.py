"""
对账附件引用与 FileUsage 状态一致性

扫描已标记 is_deleted=True 的 AttachmentReference，检查对应的 FileUsage
是否已正确 deactivate、存储配额是否已释放，对未完成的补偿处理。

适用场景：
- on_commit 回调因 MySQL 连接异常静默失败后的数据修复
- 定期健康检查

用法：
    # 预演模式（推荐先执行）
    python manage.py reconcile_attachment_references --dry-run

    # 执行修复
    python manage.py reconcile_attachment_references

    # 仅扫描最近 7 天删除的引用
    python manage.py reconcile_attachment_references --days 7

    # 调整批次大小
    python manage.py reconcile_attachment_references --batch-size 200
"""

import logging
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import AttachmentReference
from apps.services.oss.models import FileRecord, FileUsage

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = '对账 AttachmentReference(PG) 与 FileUsage(MySQL) 的一致性，补偿 on_commit 失败'

    def add_arguments(self, parser):
        parser.add_argument(
            '--days',
            type=int,
            default=None,
            help='仅扫描最近 N 天内删除的引用（默认扫描全部）',
        )
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='预演模式：仅报告不一致数量，不执行修复',
        )
        parser.add_argument(
            '--batch-size',
            type=int,
            default=500,
            help='每批处理的引用数量（默认 500）',
        )

    def handle(self, *args, **options):
        days = options['days']
        dry_run = options['dry_run']
        batch_size = options['batch_size']

        qs = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            is_deleted=True,
        )
        if days:
            cutoff = timezone.now() - timedelta(days=days)
            qs = qs.filter(deleted_at__gte=cutoff)

        total = qs.count()
        if total == 0:
            self.stdout.write(self.style.SUCCESS('没有需要对账的已删除引用。'))
            return

        self.stdout.write(f'找到 {total} 条已删除的 AttachmentReference，开始对账...')

        deactivated_count = 0
        skipped_count = 0
        error_count = 0
        processed = 0

        while processed < total:
            batch = list(
                qs.order_by('deleted_at')
                .values('id', 'table_id', 'file_id', 'organization_id')[processed:processed + batch_size]
            )
            if not batch:
                break

            for ref_data in batch:
                table_id = ref_data['table_id']
                file_id = ref_data['file_id']

                still_active_in_table = AttachmentReference.objects.using(
                    TABDATA_DB_ALIAS
                ).filter(
                    table_id=table_id,
                    file_id=file_id,
                    is_deleted=False,
                ).exists()

                if still_active_in_table:
                    skipped_count += 1
                    continue

                stale_usages = FileUsage.objects.filter(
                    file_record_id=file_id,
                    module='tabdata',
                    context_type='table_attachment',
                    context_id=str(table_id),
                    is_active=True,
                )

                for usage in stale_usages:
                    if dry_run:
                        self.stdout.write(
                            f'  [预演] 将 deactivate FileUsage: '
                            f'usage={usage.id}, file={file_id}, table={table_id}'
                        )
                        deactivated_count += 1
                    else:
                        try:
                            usage.deactivate()
                            deactivated_count += 1
                            logger.info(
                                'reconcile: deactivated FileUsage %s '
                                '(file=%s, table=%s)',
                                usage.id, file_id, table_id,
                            )
                        except Exception as exc:
                            error_count += 1
                            logger.error(
                                'reconcile: deactivate 失败 usage=%s, '
                                'file=%s, table=%s, err=%s',
                                usage.id, file_id, table_id, exc,
                            )

            processed += len(batch)
            if not dry_run and processed % (batch_size * 5) == 0:
                self.stdout.write(f'  已处理 {processed}/{total} ...')

        mode_label = '[预演] ' if dry_run else ''
        self.stdout.write(
            self.style.SUCCESS(
                f'{mode_label}对账完成: 扫描 {total} 条引用, '
                f'deactivated {deactivated_count}, '
                f'跳过(仍有活跃引用) {skipped_count}, '
                f'错误 {error_count}'
            )
        )
