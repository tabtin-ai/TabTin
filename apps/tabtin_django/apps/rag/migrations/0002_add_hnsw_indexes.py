"""
为 RAG embedding 列创建 HNSW 向量索引。

HNSW (Hierarchical Navigable Small World) 索引将余弦相似度查询从全表扫描
优化为近似最近邻查询，大幅提升检索性能。

m=16, ef_construction=64 是 pgvector 推荐的默认参数，
适合中等规模数据集 (10K-1M 级别)。
"""

from django.db import migrations
from tabtin.migration_utils import PostgresOnlyOperation


class Migration(migrations.Migration):
    atomic = False  # CREATE INDEX CONCURRENTLY 不能在事务中运行

    dependencies = [
        ("rag", "0001_initial"),
    ]

    operations = [
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_table_emb_hnsw_idx
                    ON rag_table_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_table_emb_hnsw_idx;",
            ),
        ),
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_record_emb_hnsw_idx
                    ON rag_record_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_record_emb_hnsw_idx;",
            ),
        ),
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_skill_emb_hnsw_idx
                    ON rag_skill_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_skill_emb_hnsw_idx;",
            ),
        ),
    ]
