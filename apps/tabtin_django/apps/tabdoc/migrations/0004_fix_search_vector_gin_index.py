"""
将 Document.search_vector 索引从 B-tree 改为 GIN。

B-tree 索引对 tsvector 类型几乎无用；PostgreSQL 全文检索
需要 GIN 索引才能高效执行 @@ 操作符查询。
"""

from django.contrib.postgres.indexes import GinIndex
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0003_add_trash_fields"),
    ]

    operations = [
        migrations.RemoveIndex(
            model_name="document",
            name="doc_search_vector_idx",
        ),
        migrations.AddIndex(
            model_name="document",
            index=GinIndex(
                fields=["search_vector"],
                name="doc_search_vector_gin_idx",
            ),
        ),
    ]
