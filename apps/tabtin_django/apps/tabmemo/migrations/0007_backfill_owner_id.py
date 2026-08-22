# 数据迁移：回填存量 Memo / MemoCollection 的 owner_id
#
# 旧数据中 owner_id 可能为 NULL（在引入 SpaceResourceModel.owner_id 之前创建的记录），
# 此迁移将 created_by_id 同步到 owner_id，确保权限过滤和资源归属逻辑正确。

from django.db import migrations

TABMEMO_DB = "postgresql"


def backfill_owner_id(apps, schema_editor):
    """将 created_by_id 回填到 owner_id（仅处理 owner_id 为 NULL 的记录）"""
    connection = schema_editor.connection
    is_pg = connection.vendor == "postgresql"

    # PostgreSQL 需要 CAST(created_by_id AS uuid) 因为 created_by_id 是 varchar
    # SQLite 不区分类型，直接赋值即可
    cast = "::uuid" if is_pg else ""

    with connection.cursor() as cursor:
        # Memo 表
        cursor.execute(
            f"UPDATE tabmemo_memo "
            f"SET owner_id = created_by_id{cast} "
            f"WHERE owner_id IS NULL AND created_by_id IS NOT NULL"
        )
        memo_count = cursor.rowcount

        # MemoCollection 表
        cursor.execute(
            f"UPDATE tabmemo_collection "
            f"SET owner_id = created_by_id{cast} "
            f"WHERE owner_id IS NULL AND created_by_id IS NOT NULL"
        )
        coll_count = cursor.rowcount

    if memo_count or coll_count:
        print(
            f"\n  [backfill_owner_id] 已回填 {memo_count} 条 Memo, "
            f"{coll_count} 条 MemoCollection"
        )


class Migration(migrations.Migration):

    dependencies = [
        ("tabmemo", "0006_space_id_nullable_agent_grant"),
    ]

    operations = [
        migrations.RunPython(
            backfill_owner_id,
            reverse_code=migrations.RunPython.noop,
            hints={"db_alias": TABMEMO_DB},
        ),
    ]
