"""0003 在 PG 上 category / local_content_hash 为 NOT NULL 但未设库级 DEFAULT。

旧版 Django 进程或未传字段的 INSERT 会写入 NULL → 500。
补库级 DEFAULT ''，与模型 default="" 对齐。"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0003_skill_category_and_version_local_hash"),
    ]

    operations = [
        migrations.RunSQL(
            sql="""
                UPDATE skills_skill SET category = '' WHERE category IS NULL;
                ALTER TABLE skills_skill
                    ALTER COLUMN category SET DEFAULT '';
            """,
            reverse_sql="""
                ALTER TABLE skills_skill
                    ALTER COLUMN category DROP DEFAULT;
            """,
        ),
        migrations.RunSQL(
            sql="""
                UPDATE skills_published_version
                    SET local_content_hash = '' WHERE local_content_hash IS NULL;
                ALTER TABLE skills_published_version
                    ALTER COLUMN local_content_hash SET DEFAULT '';
            """,
            reverse_sql="""
                ALTER TABLE skills_published_version
                    ALTER COLUMN local_content_hash DROP DEFAULT;
            """,
        ),
    ]
