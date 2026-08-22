"""
为 CodeChunkEmbedding 创建性能索引：
1. HNSW 向量索引 — 将余弦相似度查询从全表扫描优化为近似最近邻
2. Partial 组合索引 — 加速 Phase 1 去重查询 (embedding IS NOT NULL)
3. 排序索引 — 加速 sync_code_index 的 distinct('file_path') 查询
"""

from django.db import migrations
from tabtin.migration_utils import PostgresOnlyOperation


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("rag", "0006_add_code_task_type"),
    ]

    operations = [
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_code_chunk_emb_hnsw_idx
                    ON rag_code_chunk_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64)
                    WHERE embedding IS NOT NULL;
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_code_chunk_emb_hnsw_idx;",
            ),
        ),
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_code_chunk_dedup_partial_idx
                    ON rag_code_chunk_embedding (project_id, file_path, start_line, end_line, content_hash)
                    WHERE embedding IS NOT NULL;
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_code_chunk_dedup_partial_idx;",
            ),
        ),
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_code_chunk_sync_idx
                    ON rag_code_chunk_embedding (project_id, file_path, updated_at DESC);
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_code_chunk_sync_idx;",
            ),
        ),
    ]
