#  终态 · DeleteModel Space + DROP tabtinspace_space
#
# 前置（模型状态已清）：
# - 0108/0109：壳表与 Collection/ContextItem 改挂 Workspace/Project，XOR 收口
# - conversation 0066 / tracker 0042 / tabdata 0045：跨 app space FK RemoveField
#
# 本迁移：
# - state：DeleteModel('Space')
# - database：
#   1. 幂等清理 SF-1 已退役但仍可能残留的 grant 表（ 半账：
#      django_migrations 已有 0066，物理表 tabtinspace_space_share 仍在）
#   2. 断言无残留真 FK，再 DROP TABLE（不用 CASCADE，避免误删子表数据）

import logging

from django.db import migrations

logger = logging.getLogger(__name__)

# 与 0066_retire_space_share_delegation.LEGACY_GRANT_TABLES 对齐。
# 0066 已 DeleteModel；此处不能再用 apps.get_model，只做物理 DROP。
RETIRED_SPACE_GRANT_TABLES = (
    'tabtinspace_delegation_grant',
    'tabtinspace_space_share',
)


def forwards_drop_retired_grant_zombies(apps, schema_editor):
    """#6443：清掉 0066 记账后仍残留的退役 grant 表，避免挡住 0110 DROP Space。"""
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        existing_tables = set(connection.introspection.table_names(cursor))
        for table_name in RETIRED_SPACE_GRANT_TABLES:
            if table_name not in existing_tables:
                continue
            quoted = connection.ops.quote_name(table_name)
            cursor.execute(f'SELECT COUNT(*) FROM {quoted}')
            row_count = int(cursor.fetchone()[0])
            if connection.vendor == 'postgresql':
                cursor.execute(f'DROP TABLE IF EXISTS {quoted} CASCADE')
            else:
                cursor.execute(f'DROP TABLE IF EXISTS {quoted}')
            # 行数仅用于日志诊断；SF-1 口径下退役表数据本就可丢弃。
            logger.warning(
                '#6443/0110: dropped retired zombie table %s (rows=%s)',
                table_name,
                row_count,
            )


def forwards_assert_no_space_fks(apps, schema_editor):
    connection = schema_editor.connection
    if connection.vendor != 'postgresql':
        return
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT c.conrelid::regclass::text, c.conname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.confrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE c.contype = 'f'
              AND n.nspname = current_schema()
              AND t.relname = 'tabtinspace_space'
              -- 表内自引用（execution_space / 旧 project 壳）会随 DROP TABLE 一起消失，
              -- 不是「外部表仍挂着 Space」；计入会永久挡住 0110。
              AND c.conrelid <> c.confrelid
            ORDER BY 1, 2
            """
        )
        rows = cursor.fetchall()
    if rows:
        detail = ', '.join(f'{table}.{name}' for table, name in rows[:20])
        raise RuntimeError(
            f'#3266/0110: 仍有 {len(rows)} 条真 FK 指向 tabtinspace_space，'
            f'拒绝 DROP（避免 CASCADE 误删）。sample={detail}。'
            '请先卸掉这些 FK，再继续 migrate。'
        )


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0109_contextitem_collection_ws_xor_project_3266'),
        ('conversation', '0066_drop_chatsession_space_fk_3266'),
        ('tracker', '0042_drop_tracker_space_fk_3266'),
        ('tabdata', '0045_tableapitoken_drop_space_fk_3266'),
        ('skills', '0014_3266_enablement_device_anchor'),
        ('tabmemo', '0024_backfill_memo_agent_id'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.DeleteModel(name='Space'),
            ],
            database_operations=[
                migrations.RunPython(
                    forwards_drop_retired_grant_zombies,
                    migrations.RunPython.noop,
                ),
                migrations.RunPython(
                    forwards_assert_no_space_fks,
                    migrations.RunPython.noop,
                ),
                migrations.RunSQL(
                    sql='DROP TABLE IF EXISTS tabtinspace_space;',
                    reverse_sql=migrations.RunSQL.noop,
                ),
            ],
        ),
    ]
