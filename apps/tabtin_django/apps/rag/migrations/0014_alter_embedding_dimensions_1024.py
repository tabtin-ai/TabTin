"""
EB-001/EB-002/EB-003 fix: 将所有 VectorField 从 1536 维降到 1024 维。

背景：
- 默认 provider=qwen, model=text-embedding-v4 最大只支持 1024 维
- EmbeddingService.__init__ 会静默将 self.dimensions 修正为 1024
- 但 DDL 仍是 vector(1536)，导致每次 INSERT 触发 DataException
- 本次迁移将 DDL 与运行时维度统一

影响的表：
- rag_table_embedding.embedding            vector(1536) → vector(1024)
- rag_record_embedding.embedding           vector(1536) → vector(1024)
- rag_search_log.query_embedding           vector(1536) → vector(1024)
- rag_skill_embedding.embedding            vector(1536) → vector(1024)
- rag_document_embedding.embedding         vector(1536) → vector(1024)
- rag_code_chunk_embedding.embedding       vector(1536) → vector(1024)

注意：
- ALTER COLUMN TYPE 会自动 DROP 依赖该列的 HNSW/IVFFlat 索引
- 因此迁移末尾需重建所有向量索引
- atomic=False 以支持 CREATE INDEX CONCURRENTLY
- 若生产环境存有 OpenAI(1536维) 旧向量，需在执行前评估语义污染影响（见 EB-006）
"""

from django.db import migrations
import pgvector.django
from tabtin.migration_utils import PostgresOnlyOperation


class Migration(migrations.Migration):
    atomic = False  # ALTER TYPE 和 CONCURRENTLY 均不支持事务

    dependencies = [
        ("rag", "0013_tableembedding_space_id_recordembedding_space_id"),
    ]

    operations = [
        # ─── Step 1: 修改字段 DDL（同时 DROP 旧的 HNSW 索引） ───────────────
        PostgresOnlyOperation(
            migrations.AlterField(
                model_name="tableembedding",
                name="embedding",
                field=pgvector.django.VectorField(dimensions=1024, verbose_name="向量"),
            ),
        ),
        PostgresOnlyOperation(
            migrations.AlterField(
                model_name="recordembedding",
                name="embedding",
                field=pgvector.django.VectorField(dimensions=1024, verbose_name="向量"),
            ),
        ),
        PostgresOnlyOperation(
            migrations.AlterField(
                model_name="searchlog",
                name="query_embedding",
                field=pgvector.django.VectorField(
                    dimensions=1024, null=True, blank=True, verbose_name="查询向量"
                ),
            ),
        ),
        PostgresOnlyOperation(
            migrations.AlterField(
                model_name="skillembedding",
                name="embedding",
                field=pgvector.django.VectorField(dimensions=1024, verbose_name="向量"),
            ),
        ),
        PostgresOnlyOperation(
            migrations.AlterField(
                model_name="documentembedding",
                name="embedding",
                field=pgvector.django.VectorField(dimensions=1024, verbose_name="向量"),
            ),
        ),
        PostgresOnlyOperation(
            migrations.AlterField(
                model_name="codechunkembedding",
                name="embedding",
                field=pgvector.django.VectorField(
                    dimensions=1024, null=True, blank=True, verbose_name="向量"
                ),
            ),
        ),

        # ─── Step 2: 重建 HNSW 向量索引 ──────────────────────────────────────
        # 维度变更导致旧索引失效，必须重建才能保证 ANN 查询命中

        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    DROP INDEX IF EXISTS rag_table_emb_hnsw_idx;
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
                    DROP INDEX IF EXISTS rag_record_emb_hnsw_idx;
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
                    DROP INDEX IF EXISTS rag_skill_emb_hnsw_idx;
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_skill_emb_hnsw_idx
                    ON rag_skill_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_skill_emb_hnsw_idx;",
            ),
        ),
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    DROP INDEX IF EXISTS rag_document_emb_hnsw_idx;
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_document_emb_hnsw_idx
                    ON rag_document_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_document_emb_hnsw_idx;",
            ),
        ),
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    DROP INDEX IF EXISTS rag_code_chunk_emb_hnsw_idx;
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_code_chunk_emb_hnsw_idx
                    ON rag_code_chunk_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64)
                    WHERE embedding IS NOT NULL;
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_code_chunk_emb_hnsw_idx;",
            ),
        ),
    ]
