"""
CC-001/CC-002/CC-008 修复：幂等重建四个 RAG Embedding 表。

根因：PostgreSQL 数据库重建后，MySQL 中的 django_migrations 迁移记录仍标记为
"已应用"，Django 跳过了在 PostgreSQL 中实际创建表的 DDL，导致四个 Embedding 表
（rag_table_embedding、rag_record_embedding、rag_document_embedding、
rag_code_chunk_embedding）在 PostgreSQL 中完全不存在，所有向量化写入操作均抛出
ProgrammingError: relation does not exist。

修复策略：使用 CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS 语句进行
幂等重建。表已存在时 SQL 静默跳过；表不存在时（如 PG 被重建后）完整创建所有
表和索引，包含 0011/0012/0013 迁移中追加的 workspace_id、space_id、
CodeChunkEmbedding.status 等字段，确保 CC-008 的三条未应用迁移在同一操作中一并就位。

此迁移标记为 atomic=False，因为 CREATE INDEX CONCURRENTLY 不能在事务中运行。
"""

from django.db import migrations


def _pg_only(ops):
    """Wrap each operation so it only runs on PostgreSQL (skip on SQLite test DB)."""
    from tabtin.migration_utils import PostgresOnlyOperation
    return [PostgresOnlyOperation(op) for op in ops]


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("rag", "0013_tableembedding_space_id_recordembedding_space_id"),
    ]

    operations = _pg_only([
        migrations.RunSQL(
            sql="""
                -- rag_table_embedding
                -- 包含 0001_initial 字段 + 0011 workspace_id + 0013 space_id
                CREATE TABLE IF NOT EXISTS rag_table_embedding (
                    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
                    table_id        UUID            NOT NULL,
                    content         TEXT            NOT NULL,
                    content_hash    VARCHAR(64)     NOT NULL,
                    embedding       vector(1536)    NOT NULL,
                    metadata        JSONB           NOT NULL DEFAULT '{}',
                    version         INTEGER         NOT NULL DEFAULT 1,
                    status          VARCHAR(20)     NOT NULL DEFAULT 'pending',
                    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
                    workspace_id    UUID,
                    space_id        UUID,
                    UNIQUE (table_id, version)
                );

                CREATE INDEX IF NOT EXISTS rag_table_e_table_i_d16973_idx
                    ON rag_table_embedding (table_id, version);
                CREATE INDEX IF NOT EXISTS rag_table_e_content_a27d0e_idx
                    ON rag_table_embedding (content_hash);
                CREATE INDEX IF NOT EXISTS rag_table_e_status_493959_idx
                    ON rag_table_embedding (status);
                CREATE INDEX IF NOT EXISTS rag_table_e_workspa_idx
                    ON rag_table_embedding (workspace_id);
                CREATE INDEX IF NOT EXISTS rag_table_e_space_id_idx
                    ON rag_table_embedding (space_id);
            """,
            reverse_sql="DROP TABLE IF EXISTS rag_table_embedding;",
        ),

        migrations.RunSQL(
            sql="""
                -- rag_record_embedding
                -- 包含 0001_initial 字段 + 0011 workspace_id + 0013 space_id
                CREATE TABLE IF NOT EXISTS rag_record_embedding (
                    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
                    record_id       UUID            NOT NULL,
                    table_id        UUID            NOT NULL,
                    content         TEXT            NOT NULL,
                    content_hash    VARCHAR(64)     NOT NULL,
                    embedding       vector(1536)    NOT NULL,
                    metadata        JSONB           NOT NULL DEFAULT '{}',
                    priority        INTEGER         NOT NULL DEFAULT 0,
                    version         INTEGER         NOT NULL DEFAULT 1,
                    status          VARCHAR(20)     NOT NULL DEFAULT 'pending',
                    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
                    workspace_id    UUID,
                    space_id        UUID,
                    UNIQUE (record_id, version)
                );

                CREATE INDEX IF NOT EXISTS rag_record__record__b6998c_idx
                    ON rag_record_embedding (record_id, version);
                CREATE INDEX IF NOT EXISTS rag_record__table_i_1837b8_idx
                    ON rag_record_embedding (table_id, priority);
                CREATE INDEX IF NOT EXISTS rag_record__content_15b0ca_idx
                    ON rag_record_embedding (content_hash);
                CREATE INDEX IF NOT EXISTS rag_record__status_548380_idx
                    ON rag_record_embedding (status);
                CREATE INDEX IF NOT EXISTS rag_record__created_600b20_idx
                    ON rag_record_embedding (created_at);
                CREATE INDEX IF NOT EXISTS rag_record_e_workspace_id_idx
                    ON rag_record_embedding (workspace_id);
                CREATE INDEX IF NOT EXISTS rag_record_e_space_id_idx
                    ON rag_record_embedding (space_id);
            """,
            reverse_sql="DROP TABLE IF EXISTS rag_record_embedding;",
        ),

        migrations.RunSQL(
            sql="""
                -- rag_document_embedding
                -- 包含 0003_documentembedding 字段 + 0008 字段重命名 (agent_space_id -> space_id)
                -- + 0009 space_id NOT NULL 约束调整
                CREATE TABLE IF NOT EXISTS rag_document_embedding (
                    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
                    document_id     UUID            NOT NULL,
                    workspace_id    UUID            NOT NULL,
                    space_id        UUID            NOT NULL,
                    content         TEXT            NOT NULL,
                    content_hash    VARCHAR(64)     NOT NULL,
                    embedding       vector(1536)    NOT NULL,
                    metadata        JSONB           NOT NULL DEFAULT '{}',
                    version         INTEGER         NOT NULL DEFAULT 1,
                    status          VARCHAR(20)     NOT NULL DEFAULT 'pending',
                    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
                    UNIQUE (document_id, version)
                );

                CREATE INDEX IF NOT EXISTS rag_documen_status_96166d_idx
                    ON rag_document_embedding (status);
                CREATE INDEX IF NOT EXISTS rag_documen_workspa_a7382b_idx
                    ON rag_document_embedding (workspace_id, status);
                CREATE INDEX IF NOT EXISTS rag_document_e_doc_id_idx
                    ON rag_document_embedding (document_id);
                CREATE INDEX IF NOT EXISTS rag_document_e_space_id_idx
                    ON rag_document_embedding (space_id);
            """,
            reverse_sql="DROP TABLE IF EXISTS rag_document_embedding;",
        ),

        migrations.RunSQL(
            sql="""
                -- rag_code_chunk_embedding
                -- 包含 0005_code_chunk_embedding 字段 + 0012 status/error_message 字段
                CREATE TABLE IF NOT EXISTS rag_code_chunk_embedding (
                    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
                    project_id      VARCHAR(255)    NOT NULL,
                    workspace_id    UUID            NOT NULL,
                    file_path       VARCHAR(1024)   NOT NULL,
                    start_line      INTEGER         NOT NULL,
                    end_line        INTEGER         NOT NULL,
                    signature       VARCHAR(255)    NOT NULL DEFAULT '',
                    kind            VARCHAR(20)     NOT NULL DEFAULT 'block',
                    language        VARCHAR(30)     NOT NULL,
                    content         TEXT            NOT NULL,
                    content_hash    VARCHAR(64)     NOT NULL,
                    embedding       vector(1536),
                    metadata        JSONB           NOT NULL DEFAULT '{}',
                    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
                    status          VARCHAR(20)     NOT NULL DEFAULT 'pending',
                    error_message   TEXT            NOT NULL DEFAULT '',
                    UNIQUE (project_id, file_path, start_line, end_line)
                );

                CREATE INDEX IF NOT EXISTS rag_code_ch_project_6ec634_idx
                    ON rag_code_chunk_embedding (project_id, file_path);
                CREATE INDEX IF NOT EXISTS rag_code_ch_workspa_d11b86_idx
                    ON rag_code_chunk_embedding (workspace_id);
                CREATE INDEX IF NOT EXISTS rag_code_ch_content_418017_idx
                    ON rag_code_chunk_embedding (content_hash);
                CREATE INDEX IF NOT EXISTS rag_code_ch_languag_1c1baa_idx
                    ON rag_code_chunk_embedding (language);
                CREATE INDEX IF NOT EXISTS rag_code_ch_status_a60ff6_idx
                    ON rag_code_chunk_embedding (status);
                CREATE INDEX IF NOT EXISTS rag_code_ch_project_3d8135_idx
                    ON rag_code_chunk_embedding (project_id, status);
            """,
            reverse_sql="DROP TABLE IF EXISTS rag_code_chunk_embedding;",
        ),

        migrations.RunSQL(
            sql="""
                CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_table_emb_hnsw_idx
                    ON rag_table_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
            """,
            reverse_sql="DROP INDEX IF EXISTS rag_table_emb_hnsw_idx;",
        ),

        migrations.RunSQL(
            sql="""
                CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_record_emb_hnsw_idx
                    ON rag_record_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
            """,
            reverse_sql="DROP INDEX IF EXISTS rag_record_emb_hnsw_idx;",
        ),

        migrations.RunSQL(
            sql="""
                CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_document_emb_hnsw_idx
                    ON rag_document_embedding
                    USING hnsw (embedding vector_cosine_ops)
                    WITH (m = 16, ef_construction = 64);
            """,
            reverse_sql="DROP INDEX IF EXISTS rag_document_emb_hnsw_idx;",
        ),

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

        migrations.RunSQL(
            sql="""
                CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_code_chunk_dedup_partial_idx
                    ON rag_code_chunk_embedding (project_id, file_path, start_line, end_line, content_hash)
                    WHERE embedding IS NOT NULL;
            """,
            reverse_sql="DROP INDEX IF EXISTS rag_code_chunk_dedup_partial_idx;",
        ),

        migrations.RunSQL(
            sql="""
                CREATE INDEX CONCURRENTLY IF NOT EXISTS rag_code_chunk_sync_idx
                    ON rag_code_chunk_embedding (project_id, file_path, updated_at DESC);
            """,
            reverse_sql="DROP INDEX IF EXISTS rag_code_chunk_sync_idx;",
        ),
    ])
