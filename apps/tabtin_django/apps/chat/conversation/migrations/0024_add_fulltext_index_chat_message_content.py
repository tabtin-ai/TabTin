"""
为 chat_message.content 添加 MySQL FULLTEXT 索引（ngram 分词器）。

ngram parser 支持 CJK（中日韩）文本的分词搜索，避免 LIKE '%keyword%' 全表扫描。
MySQL 5.7.6+ / 8.0+ InnoDB 均支持 FULLTEXT + ngram。

注意：
- FULLTEXT 索引创建是 online DDL，不会阻塞读写（MySQL 8.0+）
- ngram_token_size 默认为 2，即按 bigram 分词，适合中文搜索
- 反向迁移会 DROP INDEX，不会丢失数据

跨库可移植性：FULLTEXT + WITH PARSER ngram 是 MySQL 专属语法，PostgreSQL/SQLite
不支持（PG 侧全文检索走 GIN/pg_trgm，由 FTS app 独立维护）。故按 vendor 守卫，
single_pg / SQLite 下整体 no-op，避免 `migrate` 在此处直接报错。
"""

from django.db import migrations


def _add_fulltext_index(apps, schema_editor):
    if schema_editor.connection.vendor != "mysql":
        return
    schema_editor.execute(
        "ALTER TABLE chat_message ADD FULLTEXT INDEX ft_msg_content (content) WITH PARSER ngram"
    )


def _drop_fulltext_index(apps, schema_editor):
    if schema_editor.connection.vendor != "mysql":
        return
    schema_editor.execute("ALTER TABLE chat_message DROP INDEX ft_msg_content")


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0023_add_subagent_model_tiers'),
    ]

    operations = [
        migrations.RunPython(_add_fulltext_index, _drop_fulltext_index),
    ]
