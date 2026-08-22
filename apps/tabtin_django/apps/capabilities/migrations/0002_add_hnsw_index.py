# Generated migration for PVEC-008: Add HNSW vector index to capabilities_tool_embedding
#
# ToolEmbedding 表之前只有 B-tree 索引，全量工具语义检索退化为全表 Seq Scan。
# 添加 HNSW 向量索引（cosine 距离，ef_construction=64，m=16），
# 使用 CREATE INDEX CONCURRENTLY + atomic=False 避免锁表。
#
# 参数选型：
# - m=16: 默认值，平衡构建速度与召回质量
# - ef_construction=64: 与其他 Embedding 表保持一致（PVEC-013 若升级会统一处理）
# - vector_cosine_ops: 与 UnifiedSearchService 中使用的 CosineDistance 对齐

from django.db import migrations
from tabtin.migration_utils import PostgresOnlyOperation


class Migration(migrations.Migration):

    atomic = False

    dependencies = [
        ("capabilities", "0001_initial"),
    ]

    operations = [
        PostgresOnlyOperation(migrations.RunSQL(
            sql="""
                CREATE INDEX CONCURRENTLY IF NOT EXISTS
                    capabilities_tool_embedding_embedding_hnsw_idx
                ON capabilities_tool_embedding
                USING hnsw (embedding vector_cosine_ops)
                WITH (m = 16, ef_construction = 64);
            """,
            reverse_sql="""
                DROP INDEX CONCURRENTLY IF EXISTS
                    capabilities_tool_embedding_embedding_hnsw_idx;
            """,
        )),
    ]
