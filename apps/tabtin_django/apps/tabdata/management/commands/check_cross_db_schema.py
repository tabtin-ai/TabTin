"""
跨数据库 schema 一致性检查

检测 PostgreSQL 模型通过 ForeignKey 引用的 MySQL 表在 PG 侧是否存在且列齐全。
典型场景：55+ 个 PG 模型 FK 到 users_auth_user，select_related 生成的 JOIN
会在 PG 上执行，PG 侧的影子表必须与 Django 模型定义一致。

用法：
    python manage.py check_cross_db_schema          # 只报告
    python manage.py check_cross_db_schema --fix     # 自动 ALTER 补齐缺失列
"""

from django.core.management.base import BaseCommand
from django.apps import apps
from django.db import connections, router

from apps.tabdata.constants import TABDATA_DB_ALIAS


# Django ORM 字段 → PG DDL 映射
_FIELD_TYPE_MAP = {
    'AutoField': 'INTEGER',
    'BigAutoField': 'BIGINT',
    'SmallAutoField': 'SMALLINT',
    'CharField': 'VARCHAR({max_length})',
    'TextField': 'TEXT',
    'BooleanField': 'BOOLEAN',
    'IntegerField': 'INTEGER',
    'BigIntegerField': 'BIGINT',
    'SmallIntegerField': 'SMALLINT',
    'PositiveIntegerField': 'INTEGER',
    'PositiveSmallIntegerField': 'SMALLINT',
    'PositiveBigIntegerField': 'BIGINT',
    'FloatField': 'DOUBLE PRECISION',
    'DecimalField': 'NUMERIC({max_digits},{decimal_places})',
    'DateTimeField': 'TIMESTAMP WITH TIME ZONE',
    'DateField': 'DATE',
    'TimeField': 'TIME',
    'EmailField': 'VARCHAR({max_length})',
    'URLField': 'VARCHAR({max_length})',
    'SlugField': 'VARCHAR({max_length})',
    'UUIDField': 'UUID',
    'JSONField': 'JSONB',
    'BinaryField': 'BYTEA',
    'FileField': 'VARCHAR({max_length})',
    'ImageField': 'VARCHAR({max_length})',
    'IPAddressField': 'INET',
    'GenericIPAddressField': 'INET',
    'DurationField': 'INTERVAL',
}


def _pg_type_for_field(field):
    """根据 Django 字段对象返回 PG 列类型字符串"""
    internal = type(field).__name__
    template = _FIELD_TYPE_MAP.get(internal)
    if not template:
        return None
    return template.format(
        max_length=getattr(field, 'max_length', 0) or 255,
        max_digits=getattr(field, 'max_digits', 10),
        decimal_places=getattr(field, 'decimal_places', 2),
    )


def _default_clause(field):
    """生成 DEFAULT 子句"""
    default = field.default
    if default is None or callable(default):
        return ''
    if isinstance(default, bool):
        return f' DEFAULT {str(default).upper()}'
    if isinstance(default, (int, float)):
        return f' DEFAULT {default}'
    if isinstance(default, str):
        escaped = default.replace("'", "''")
        return f" DEFAULT '{escaped}'"
    return ''


def _null_clause(field):
    if field.null:
        return ' NULL'
    return ' NOT NULL'


class Command(BaseCommand):
    help = '检查 PostgreSQL 中被跨库 FK 引用的影子表 schema 是否与 Django 模型一致'

    def add_arguments(self, parser):
        parser.add_argument(
            '--fix',
            action='store_true',
            help='自动执行 ALTER TABLE 补齐缺失列',
        )

    def handle(self, *args, **options):
        do_fix = options['fix']

        pg_apps = set()
        for app_config in apps.get_app_configs():
            for model in app_config.get_models():
                if router.db_for_read(model) == TABDATA_DB_ALIAS:
                    pg_apps.add(app_config.label)
                    break

        # 收集 PG 模型 FK 引用的非 PG 模型
        shadow_models = {}
        for app_config in apps.get_app_configs():
            if app_config.label not in pg_apps:
                continue
            for model in app_config.get_models():
                for field in model._meta.get_fields():
                    rm = getattr(field, 'related_model', None)
                    if not rm:
                        continue
                    if rm._meta.app_label in pg_apps:
                        continue
                    target_db = router.db_for_read(rm)
                    if target_db == TABDATA_DB_ALIAS:
                        continue
                    key = rm._meta.db_table
                    if key not in shadow_models:
                        shadow_models[key] = rm

        if not shadow_models:
            self.stdout.write(self.style.SUCCESS('无跨库 FK 影子表需要检查'))
            return

        cursor = connections[TABDATA_DB_ALIAS].cursor()

        total_missing = 0
        total_extra = 0
        total_fixed = 0

        for table_name, model in sorted(shadow_models.items()):
            cursor.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = %s",
                [table_name],
            )
            pg_cols = {r[0] for r in cursor.fetchall()}

            if not pg_cols:
                self.stdout.write(self.style.WARNING(
                    f'  ⚠ {table_name} — PG 中不存在（被 {len(self._count_refs(model, pg_apps))} 个 FK 引用）'
                ))
                continue

            model_cols = {}
            for f in model._meta.local_fields:
                col = f.column or f.attname
                model_cols[col] = f

            missing = set(model_cols.keys()) - pg_cols
            extra = pg_cols - set(model_cols.keys())

            if not missing and not extra:
                self.stdout.write(self.style.SUCCESS(f'  ✓ {table_name} — schema 一致'))
                continue

            if missing:
                total_missing += len(missing)
                self.stdout.write(self.style.ERROR(
                    f'  ✗ {table_name} 缺失 {len(missing)} 列: {sorted(missing)}'
                ))
                if do_fix:
                    for col_name in sorted(missing):
                        field = model_cols[col_name]
                        pg_type = _pg_type_for_field(field)
                        if not pg_type:
                            self.stdout.write(self.style.WARNING(
                                f'    跳过 {col_name}：无法映射字段类型 {type(field).__name__}'
                            ))
                            continue
                        null = _null_clause(field)
                        default = _default_clause(field)
                        ddl = (
                            f'ALTER TABLE {table_name} '
                            f'ADD COLUMN IF NOT EXISTS {col_name} {pg_type}{null}{default}'
                        )
                        try:
                            cursor.execute(ddl)
                            total_fixed += 1
                            self.stdout.write(self.style.SUCCESS(f'    + {col_name} {pg_type}'))
                        except Exception as e:
                            self.stdout.write(self.style.ERROR(f'    ✗ {col_name} 失败: {e}'))

            if extra:
                total_extra += len(extra)
                self.stdout.write(self.style.WARNING(
                    f'  ⚠ {table_name} 多余 {len(extra)} 列: {sorted(extra)}（需手动清理）'
                ))

        self.stdout.write('')
        self.stdout.write(f'检查完成：缺失 {total_missing} 列，多余 {total_extra} 列')
        if do_fix:
            self.stdout.write(f'已修复 {total_fixed} 列')
        elif total_missing > 0:
            self.stdout.write(self.style.NOTICE(
                '运行 --fix 自动补齐缺失列'
            ))

    @staticmethod
    def _count_refs(model, pg_apps):
        """统计有多少 PG 模型 FK 引用此模型"""
        refs = []
        for app_config in apps.get_app_configs():
            if app_config.label not in pg_apps:
                continue
            for m in app_config.get_models():
                for f in m._meta.get_fields():
                    rm = getattr(f, 'related_model', None)
                    if rm and rm._meta.db_table == model._meta.db_table:
                        refs.append(f'{m._meta.label}.{f.name}')
        return refs
