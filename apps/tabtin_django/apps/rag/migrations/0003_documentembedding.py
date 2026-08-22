"""
新增 DocumentEmbedding 模型 + HNSW 向量索引。
"""

import uuid
from django.db import migrations, models
import pgvector.django
from tabtin.migration_utils import PostgresOnlyOperation


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("rag", "0002_add_hnsw_indexes"),
    ]

    operations = [
        migrations.CreateModel(
            name="DocumentEmbedding",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("document_id", models.UUIDField(db_index=True, verbose_name="文档ID")),
                ("workspace_id", models.UUIDField(db_index=True, verbose_name="工作空间ID")),
                ("agent_space_id", models.UUIDField(db_index=True, verbose_name="智能体空间ID")),
                ("content", models.TextField(verbose_name="向量化的原文本")),
                ("content_hash", models.CharField(db_index=True, max_length=64, verbose_name="内容哈希")),
                ("embedding", pgvector.django.VectorField(dimensions=1536, verbose_name="向量")),
                ("metadata", models.JSONField(default=dict, verbose_name="元数据")),
                ("version", models.IntegerField(default=1, verbose_name="版本号")),
                ("status", models.CharField(
                    choices=[("pending", "待处理"), ("processing", "处理中"), ("success", "成功"), ("failed", "失败")],
                    default="success", max_length=20, verbose_name="状态",
                )),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
            ],
            options={
                "verbose_name": "文档向量索引",
                "verbose_name_plural": "文档向量索引",
                "db_table": "rag_document_embedding",
                "ordering": ["-created_at"],
                "unique_together": {("document_id", "version")},
            },
        ),
        migrations.AddIndex(
            model_name="documentembedding",
            index=models.Index(fields=["status"], name="rag_docemb_status_idx"),
        ),
        migrations.AddIndex(
            model_name="documentembedding",
            index=models.Index(fields=["workspace_id", "status"], name="rag_docemb_ws_status_idx"),
        ),
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_document_emb_hnsw_idx
                    ON rag_document_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
                """,
                reverse_sql="DROP INDEX IF EXISTS rag_document_emb_hnsw_idx;",
            ),
        ),
    ]
