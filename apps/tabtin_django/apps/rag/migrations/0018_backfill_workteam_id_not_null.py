"""
Backfill workteam_id for TableEmbedding / RecordEmbedding / SkillEmbedding / EmbeddingTask,
then set the column to NOT NULL.

Strategy per model:
  1. JOIN 关联表获取 workteam_id（主路径）
  2. metadata->>'workteam_id' / metadata->>'workspace_id' 兜底
  3. 无法推断的行直接删除（数据孤儿，已无法被检索到）

所有相关表均在 PostgreSQL 库，可直接 JOIN。
"""

from django.db import migrations, models


BATCH_SIZE = 5000


# ────────────────────────── helpers ──────────────────────────


def _count_null(cursor, table):
    cursor.execute(f"SELECT COUNT(*) FROM {table} WHERE workteam_id IS NULL")
    return cursor.fetchone()[0]


def _batch_update(cursor, table, select_sql, label):
    """
    分批 UPDATE：用 CTE 每次取 BATCH_SIZE 条待填充行进行 UPDATE，
    避免单次锁定过多行 / 写入过大 WAL。
    """
    total = 0
    while True:
        cursor.execute(f"""
            WITH batch AS (
                {select_sql}
                LIMIT {BATCH_SIZE}
            )
            UPDATE {table}
            SET workteam_id = batch.new_wid
            FROM batch
            WHERE {table}.id = batch.id
        """)
        affected = cursor.rowcount
        if affected == 0:
            break
        total += affected
        print(f"    [{label}] backfilled {total} rows ...")
    return total


def _backfill_from_metadata(cursor, table, label):
    """从 metadata JSON 中提取 workteam_id / workspace_id（旧名）作为兜底。"""
    total = 0
    for key in ('workteam_id', 'workspace_id'):
        while True:
            cursor.execute(f"""
                WITH batch AS (
                    SELECT id, (metadata->>'{key}')::uuid AS new_wid
                    FROM {table}
                    WHERE workteam_id IS NULL
                      AND metadata->>'{key}' IS NOT NULL
                      AND metadata->>'{key}' != ''
                    LIMIT {BATCH_SIZE}
                )
                UPDATE {table}
                SET workteam_id = batch.new_wid
                FROM batch
                WHERE {table}.id = batch.id
            """)
            affected = cursor.rowcount
            if affected == 0:
                break
            total += affected
            print(f"    [{label}] backfilled {total} rows from metadata.{key} ...")
    return total


def _delete_orphans(cursor, table, label):
    cursor.execute(f"DELETE FROM {table} WHERE workteam_id IS NULL")
    deleted = cursor.rowcount
    if deleted:
        print(f"    [{label}] deleted {deleted} orphan rows")
    return deleted


# ────────────────────────── main ──────────────────────────


def backfill_workteam_id(apps, schema_editor):
    cursor = schema_editor.connection.cursor()

    # ── 1. TableEmbedding: table_id → tabdata_table.workteam_id ──
    print("\n  === TableEmbedding ===")
    null_count = _count_null(cursor, 'rag_table_embedding')
    print(f"    {null_count} rows with NULL workteam_id")
    if null_count:
        n = _batch_update(cursor, 'rag_table_embedding', """
            SELECT te.id, t.workteam_id AS new_wid
            FROM rag_table_embedding te
            JOIN tabdata_table t ON te.table_id = t.id
            WHERE te.workteam_id IS NULL
        """, 'TableEmbedding')
        print(f"    backfilled {n} rows from tabdata_table")
        _backfill_from_metadata(cursor, 'rag_table_embedding', 'TableEmbedding')
        _delete_orphans(cursor, 'rag_table_embedding', 'TableEmbedding')

    # ── 2. RecordEmbedding: table_id → tabdata_table.workteam_id ──
    print("\n  === RecordEmbedding ===")
    null_count = _count_null(cursor, 'rag_record_embedding')
    print(f"    {null_count} rows with NULL workteam_id")
    if null_count:
        n = _batch_update(cursor, 'rag_record_embedding', """
            SELECT re.id, t.workteam_id AS new_wid
            FROM rag_record_embedding re
            JOIN tabdata_table t ON re.table_id = t.id
            WHERE re.workteam_id IS NULL
        """, 'RecordEmbedding')
        print(f"    backfilled {n} rows from tabdata_table")
        _backfill_from_metadata(cursor, 'rag_record_embedding', 'RecordEmbedding')
        _delete_orphans(cursor, 'rag_record_embedding', 'RecordEmbedding')

    # ── 3. SkillEmbedding: space_id → tabtinspace_space.workteam_id ──
    print("\n  === SkillEmbedding ===")
    null_count = _count_null(cursor, 'rag_skill_embedding')
    print(f"    {null_count} rows with NULL workteam_id")
    if null_count:
        n = _batch_update(cursor, 'rag_skill_embedding', """
            SELECT se.id, s.workteam_id AS new_wid
            FROM rag_skill_embedding se
            JOIN tabtinspace_space s ON se.space_id = s.id
            WHERE se.workteam_id IS NULL
        """, 'SkillEmbedding')
        print(f"    backfilled {n} rows from tabtinspace_space")
        _backfill_from_metadata(cursor, 'rag_skill_embedding', 'SkillEmbedding')
        _delete_orphans(cursor, 'rag_skill_embedding', 'SkillEmbedding')

    # ── 4. EmbeddingTask: 按 task_type 分别关联推断 ──
    print("\n  === EmbeddingTask ===")
    null_count = _count_null(cursor, 'rag_embedding_task')
    print(f"    {null_count} rows with NULL workteam_id")
    if null_count:
        # 4a. table → tabdata_table
        n = _batch_update(cursor, 'rag_embedding_task', """
            SELECT et.id, t.workteam_id AS new_wid
            FROM rag_embedding_task et
            JOIN tabdata_table t ON et.target_id = t.id
            WHERE et.task_type = 'table' AND et.workteam_id IS NULL
        """, 'EmbeddingTask:table')
        print(f"    [table] backfilled {n}")

        # 4b. record → rag_record_embedding（已回填）
        n = _batch_update(cursor, 'rag_embedding_task', """
            SELECT DISTINCT ON (et.id) et.id, re.workteam_id AS new_wid
            FROM rag_embedding_task et
            JOIN rag_record_embedding re ON et.target_id = re.record_id
            WHERE et.task_type = 'record' AND et.workteam_id IS NULL
              AND re.workteam_id IS NOT NULL
        """, 'EmbeddingTask:record')
        print(f"    [record] backfilled {n}")

        # 4c. batch → tabdata_table（batch 的 target_id 通常也是 table_id）
        n = _batch_update(cursor, 'rag_embedding_task', """
            SELECT et.id, t.workteam_id AS new_wid
            FROM rag_embedding_task et
            JOIN tabdata_table t ON et.target_id = t.id
            WHERE et.task_type = 'batch' AND et.workteam_id IS NULL
        """, 'EmbeddingTask:batch')
        print(f"    [batch] backfilled {n}")

        # 4d. document → rag_document_embedding（已 NOT NULL）
        n = _batch_update(cursor, 'rag_embedding_task', """
            SELECT DISTINCT ON (et.id) et.id, de.workteam_id AS new_wid
            FROM rag_embedding_task et
            JOIN rag_document_embedding de ON et.target_id = de.document_id
            WHERE et.task_type = 'document' AND et.workteam_id IS NULL
        """, 'EmbeddingTask:document')
        print(f"    [document] backfilled {n}")

        # 4e. skill → rag_skill_embedding（已回填）
        n = _batch_update(cursor, 'rag_embedding_task', """
            SELECT et.id, se.workteam_id AS new_wid
            FROM rag_embedding_task et
            JOIN rag_skill_embedding se ON et.target_id = se.id
            WHERE et.task_type = 'skill' AND et.workteam_id IS NULL
              AND se.workteam_id IS NOT NULL
        """, 'EmbeddingTask:skill')
        print(f"    [skill] backfilled {n}")

        # 4f. code → rag_code_chunk_embedding（已 NOT NULL）
        n = _batch_update(cursor, 'rag_embedding_task', """
            SELECT et.id, ce.workteam_id AS new_wid
            FROM rag_embedding_task et
            JOIN rag_code_chunk_embedding ce ON et.target_id = ce.id
            WHERE et.task_type = 'code' AND et.workteam_id IS NULL
        """, 'EmbeddingTask:code')
        print(f"    [code] backfilled {n}")

        # rag_embedding_task 无 metadata 列，直接删除无法推断的孤儿
        _delete_orphans(cursor, 'rag_embedding_task', 'EmbeddingTask')

    print("\n  === Backfill complete ===\n")


class Migration(migrations.Migration):

    dependencies = [
        ('rag', '0017_remove_codechunkembedding_rag_code_ch_workspa_d11b86_idx_and_more'),
    ]

    operations = [
        # Step 1: backfill
        migrations.RunPython(
            backfill_workteam_id,
            reverse_code=migrations.RunPython.noop,
        ),

        # Step 2: ALTER COLUMN SET NOT NULL
        migrations.AlterField(
            model_name='tableembedding',
            name='workteam_id',
            field=models.UUIDField(
                db_index=True,
                verbose_name='工作团队ID',
                help_text='冗余顶层字段，用于高效按 workteam 过滤；与 metadata.workteam_id 保持同步',
            ),
        ),
        migrations.AlterField(
            model_name='recordembedding',
            name='workteam_id',
            field=models.UUIDField(
                db_index=True,
                verbose_name='工作团队ID',
                help_text='冗余顶层字段，用于高效按 workteam 过滤；与 metadata.workteam_id 保持同步',
            ),
        ),
        migrations.AlterField(
            model_name='skillembedding',
            name='workteam_id',
            field=models.UUIDField(
                db_index=True,
                verbose_name='工作团队ID',
                help_text='冗余顶层字段，用于高效按 workteam 过滤；与 metadata.workteam_id 保持同步',
            ),
        ),
        migrations.AlterField(
            model_name='embeddingtask',
            name='workteam_id',
            field=models.UUIDField(
                db_index=True,
                verbose_name='工作团队ID',
                help_text='冗余字段，用于快速按 workteam 过滤任务',
            ),
        ),
    ]
