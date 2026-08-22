"""
EB-002/EB-003 fix (capabilities): 将 ToolEmbedding.embedding 从 1536 维改为 1024 维，
并为 capabilities_tool_embedding 表创建 HNSW 向量索引。

背景：
- qwen text-embedding-v4 最大支持 1024 维，1536 维与运行时不一致导致 DataException
- capabilities 原始 0001_initial 未创建 HNSW 索引
- 本迁移同时修复维度并补充 HNSW 索引
- atomic=False 以支持 ALTER TYPE 和 CONCURRENTLY

注意：若生产环境存有 OpenAI(1536维) 旧向量，需先评估语义污染范围（见 EB-006）。
"""

from django.db import migrations
import pgvector.django
from tabtin.migration_utils import PostgresOnlyOperation


class Migration(migrations.Migration):
    atomic = False  # ALTER TYPE 和 CONCURRENTLY 均不支持事务

    dependencies = [
        ("capabilities", "0001_initial"),
    ]

    operations = [
        # Step 1: 修改字段 DDL（1536 → 1024）
        PostgresOnlyOperation(
            migrations.AlterField(
                model_name="toolembedding",
                name="embedding",
                field=pgvector.django.VectorField(dimensions=1024, verbose_name="向量"),
            ),
        ),

        # Step 2: 创建/重建 HNSW 向量索引
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    DROP INDEX IF EXISTS capabilities_tool_emb_hnsw_idx;
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS capabilities_tool_emb_hnsw_idx
                    ON capabilities_tool_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
                """,
                reverse_sql="DROP INDEX IF EXISTS capabilities_tool_emb_hnsw_idx;",
            ),
        ),
    ]
