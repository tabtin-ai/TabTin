"""P1-56: 为 content_plaintext 添加 pg_trgm GIN 索引，加速 icontains 查询。"""

from django.db import migrations
from tabtin.migration_utils import PostgresOnlyOperation


class Migration(migrations.Migration):

    atomic = False

    dependencies = [
        ("tabmemo", "0013_memo_access_count"),
    ]

    operations = [
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql="CREATE EXTENSION IF NOT EXISTS pg_trgm;",
                reverse_sql=migrations.RunSQL.noop,
            ),
        ),
        PostgresOnlyOperation(
            migrations.RunSQL(
                sql=(
                    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "tm_content_trgm_gin" '
                    "ON tabmemo_memo USING gin (content_plaintext gin_trgm_ops);"
                ),
                reverse_sql='DROP INDEX CONCURRENTLY IF EXISTS "tm_content_trgm_gin";',
            ),
        ),
    ]
