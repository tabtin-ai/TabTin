"""
原生列存储数据一致性校验管理命令

用法：
    # 校验单张表
    python manage.py native_verify --table <uuid>

    # 校验整个 Space
    python manage.py native_verify --space <uuid>

    # 全量校验（不采样）
    python manage.py native_verify --table <uuid> --full

    # 自定义采样量
    python manage.py native_verify --space <uuid> --sample 2000

    # 详细输出（显示每条不一致记录）
    python manage.py native_verify --table <uuid> --verbose
"""

from uuid import UUID

from django.core.management.base import BaseCommand, CommandError

from apps.tabdata.native.consistency_checker import ConsistencyChecker


class Command(BaseCommand):
    help = '校验原生列存储与 JSONField 数据一致性'

    def add_arguments(self, parser):
        # 目标
        parser.add_argument(
            '--table',
            type=str,
            help='要校验的表 UUID',
        )
        parser.add_argument(
            '--space',
            type=str,
            help='要校验的 Space UUID',
        )

        # 选项
        parser.add_argument(
            '--sample',
            type=int,
            default=1000,
            help='采样数量（默认 1000，0 表示全量）',
        )
        parser.add_argument(
            '--full',
            action='store_true',
            help='全量校验（等同 --sample 0）',
        )
        parser.add_argument(
            '--verbose',
            action='store_true',
            help='详细输出每条不一致记录',
        )

    def handle(self, *args, **options):
        table_id_str = options.get('table')
        space_id_str = options.get('space')
        sample_size = options.get('sample', 1000)
        full_check = options.get('full', False)
        verbose = options.get('verbose', False)

        if full_check:
            sample_size = 0

        if not table_id_str and not space_id_str:
            raise CommandError(
                '请指定校验目标：--table <uuid> 或 --space <uuid>'
            )

        checker = ConsistencyChecker()

        if table_id_str:
            try:
                table_id = UUID(table_id_str)
            except ValueError:
                raise CommandError(f'无效的表 UUID: {table_id_str}')

            self.stdout.write(f'开始校验表: {table_id}')
            if sample_size > 0:
                self.stdout.write(f'  采样数量: {sample_size}（使用 --full 全量校验）')

            result = checker.check_table(
                table_id,
                sample_size=sample_size,
                verbose=verbose,
            )
            self._print_table_result(result, verbose)

        elif space_id_str:
            try:
                space_id = UUID(space_id_str)
            except ValueError:
                raise CommandError(f'无效的 Space UUID: {space_id_str}')

            self.stdout.write(f'开始校验 Space: {space_id}')
            if sample_size > 0:
                self.stdout.write(f'  每表采样: {sample_size}')

            result = checker.check_space(
                space_id,
                sample_size=sample_size,
            )
            self._print_space_result(result)

    def _print_table_result(self, result, verbose=False):
        """打印单表校验结果"""
        error = result.get('error')
        if error:
            self.stdout.write(self.style.ERROR(f'✗ 校验失败: {error}'))
            return

        mismatches = result.get('mismatches', 0)
        checked = result.get('checked', 0)

        if mismatches == 0:
            self.stdout.write(self.style.SUCCESS(
                f'✓ 数据一致: {result["table_name"]} ({checked} 条记录已检查)'
            ))
        else:
            self.stdout.write(self.style.WARNING(
                f'⚠ 发现不一致: {result["table_name"]}'
            ))

        self.stdout.write(f'  表 ID:        {result["table_id"]}')
        self.stdout.write(f'  检查记录数:   {checked}')
        self.stdout.write(f'  不一致记录:   {mismatches}')
        self.stdout.write(f'  Native 缺失:  {result.get("missing_native", 0)}')
        self.stdout.write(f'  Native 多余:  {result.get("extra_native", 0)}')
        self.stdout.write(f'  字段值差异:   {result.get("field_mismatches", 0)}')

        if verbose and result.get('details'):
            self.stdout.write('\n  详细信息：')
            for detail in result['details'][:50]:  # 最多显示 50 条
                dtype = detail.get('type', '')
                rid = detail.get('record_id', '')

                if dtype == 'missing_native':
                    self.stdout.write(
                        f'    [缺失] record={rid}: {detail.get("message", "")}'
                    )
                elif dtype == 'field_mismatch':
                    self.stdout.write(f'    [差异] record={rid}:')
                    for fm in detail.get('fields', []):
                        self.stdout.write(
                            f'      {fm["field_name"]}: '
                            f'JSON={fm["json_value"]} vs Native={fm["native_value"]}'
                        )

    def _print_space_result(self, result):
        """打印 Space 校验结果"""
        total_mismatches = result.get('total_mismatches', 0)

        if total_mismatches == 0:
            self.stdout.write(self.style.SUCCESS(
                f'\n✓ Space 数据全部一致: {result["space_id"]}'
            ))
        else:
            self.stdout.write(self.style.WARNING(
                f'\n⚠ Space 存在不一致: {result["space_id"]}'
            ))

        self.stdout.write(f'  校验表数:     {result.get("tables", 0)}')
        self.stdout.write(f'  总检查记录:   {result.get("total_checked", 0)}')
        self.stdout.write(f'  总不一致:     {total_mismatches}')

        if result.get('details'):
            self.stdout.write('\n  各表详情：')
            for detail in result['details']:
                status_icon = '✓' if detail.get('mismatches', 0) == 0 else '⚠'
                self.stdout.write(
                    f'    {status_icon} {detail.get("table_name", "?")} '
                    f'({detail["table_id"]}): '
                    f'{detail.get("checked", 0)} 条检查, '
                    f'{detail.get("mismatches", 0)} 不一致'
                )
