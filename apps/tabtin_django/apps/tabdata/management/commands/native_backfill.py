"""
原生列存储历史数据回填管理命令

用法：
    # 回填单张表
    python manage.py native_backfill --table <uuid>

    # 回填整个 Space
    python manage.py native_backfill --space <uuid>

    # 回填所有 Space（谨慎使用）
    python manage.py native_backfill --all

    # 查看回填状态
    python manage.py native_backfill --status
    python manage.py native_backfill --status --table <uuid>
    python manage.py native_backfill --status --space <uuid>

    # 强制重新回填（即使已完成）
    python manage.py native_backfill --table <uuid> --force

    # 自定义 chunk 大小
    python manage.py native_backfill --table <uuid> --chunk-size 200
"""

import json
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError

from apps.tabdata.native.backfill_service import BackfillService


class Command(BaseCommand):
    help = '回填历史数据到原生 PostgreSQL 列表'

    def add_arguments(self, parser):
        # 目标
        parser.add_argument(
            '--table',
            type=str,
            help='要回填的表 UUID',
        )
        parser.add_argument(
            '--space',
            type=str,
            help='要回填的 Space UUID',
        )
        parser.add_argument(
            '--all',
            action='store_true',
            help='回填所有 Space 的所有表',
        )

        # 查询
        parser.add_argument(
            '--status',
            action='store_true',
            help='查看回填状态（不执行回填）',
        )

        # 选项
        parser.add_argument(
            '--force',
            action='store_true',
            help='强制重新回填（即使已标记完成）',
        )
        parser.add_argument(
            '--chunk-size',
            type=int,
            default=500,
            help='每批处理的记录数（默认 500）',
        )

    def handle(self, *args, **options):
        table_id_str = options.get('table')
        space_id_str = options.get('space')
        backfill_all = options.get('all')
        show_status = options.get('status')
        force = options.get('force', False)
        chunk_size = options.get('chunk_size', 500)

        service = BackfillService(chunk_size=chunk_size)

        # 状态查询模式
        if show_status:
            return self._show_status(service, table_id_str, space_id_str)

        # 回填模式
        if not any([table_id_str, space_id_str, backfill_all]):
            raise CommandError(
                '请指定回填目标：--table <uuid>、--space <uuid> 或 --all\n'
                '查看状态：--status'
            )

        if table_id_str:
            try:
                table_id = UUID(table_id_str)
            except ValueError:
                raise CommandError(f'无效的表 UUID: {table_id_str}')

            self.stdout.write(f'开始回填表: {table_id}')
            result = service.backfill_table(table_id, force=force)
            self._print_table_result(result)

        elif space_id_str:
            try:
                space_id = UUID(space_id_str)
            except ValueError:
                raise CommandError(f'无效的 Space UUID: {space_id_str}')

            self.stdout.write(f'开始回填 Space: {space_id}')
            result = service.backfill_space(space_id, force=force)
            self._print_space_result(result)

        elif backfill_all:
            self.stdout.write(self.style.WARNING('即将回填所有 Space 的所有表...'))
            confirm = input('确认继续？(yes/no): ')
            if confirm.lower() != 'yes':
                self.stdout.write('已取消')
                return
            result = service.backfill_all(force=force)
            self._print_all_result(result)

    def _show_status(self, service: BackfillService, table_id_str, space_id_str):
        """显示回填状态"""
        table_id = UUID(table_id_str) if table_id_str else None
        space_id = UUID(space_id_str) if space_id_str else None

        statuses = service.get_status(table_id=table_id, space_id=space_id)

        if not statuses:
            self.stdout.write('没有找到任何回填状态记录')
            return

        self.stdout.write(f'\n共 {len(statuses)} 条状态记录：\n')
        self.stdout.write(
            f'{"表 ID":<40} {"表名":<20} {"DDL":<5} {"列同步":<6} '
            f'{"回填":<5} {"记录数":<8} {"最后回填":<22} {"错误":<5}'
        )
        self.stdout.write('-' * 120)

        for s in statuses:
            self.stdout.write(
                f'{s["table_id"]:<40} '
                f'{s["table_name"][:18]:<20} '
                f'{"✓" if s["native_table_created"] else "✗":<5} '
                f'{"✓" if s["columns_synced"] else "✗":<6} '
                f'{"✓" if s["backfill_completed"] else "✗":<5} '
                f'{s["backfill_record_count"]:<8} '
                f'{(s["last_backfill_at"] or "-")[:20]:<22} '
                f'{s["consistency_errors"]:<5}'
            )

    def _print_table_result(self, result):
        """打印单表回填结果"""
        status = result.get('status', 'unknown')
        if status == 'completed':
            self.stdout.write(self.style.SUCCESS(
                f'✓ 回填完成: {result["message"]}'
            ))
        else:
            self.stdout.write(self.style.ERROR(
                f'✗ 回填失败: {result["message"]}'
            ))

        self.stdout.write(f'  表: {result["table_id"]}')
        self.stdout.write(f'  处理: {result["processed"]} 条')
        self.stdout.write(f'  错误: {result["errors"]} 条')

    def _print_space_result(self, result):
        """打印 Space 回填结果"""
        self.stdout.write(self.style.SUCCESS(f'\nSpace 回填完成: {result["space_id"]}'))
        self.stdout.write(f'  表数: {result["tables"]}')
        self.stdout.write(f'  总处理: {result["total_processed"]} 条')
        self.stdout.write(f'  总错误: {result["total_errors"]} 条')

        if result.get('details'):
            self.stdout.write('\n  各表详情：')
            for detail in result['details']:
                status_icon = '✓' if detail['status'] == 'completed' else '✗'
                self.stdout.write(
                    f'    {status_icon} {detail["table_id"]}: '
                    f'{detail["processed"]} 条 / {detail["errors"]} 错误'
                )

    def _print_all_result(self, result):
        """打印全量回填结果"""
        self.stdout.write(self.style.SUCCESS('\n全量回填完成'))
        self.stdout.write(f'  Space 数: {result["spaces"]}')
        self.stdout.write(f'  表数: {result["tables"]}')
        self.stdout.write(f'  总处理: {result["total_processed"]} 条')
        self.stdout.write(f'  总错误: {result["total_errors"]} 条')
