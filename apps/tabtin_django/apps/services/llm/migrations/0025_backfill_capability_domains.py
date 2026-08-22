"""
Phase 2.1 step 2/3 — 把 ``LLMProvider.capability_domain`` (单值) 回填到
``capability_domains`` (ArrayField)。

幂等：已回填过（即 capability_domains 非空）的 Provider 跳过。
方向：单向（forward）；回滚由下一 migration 的 reverse 处理。

v0.1.x：改用批量 SQL UPDATE（一句 ARRAY[capability_domain] 全表完成），
缩短 0024 → 0025 之间的"中间态窗口"——逐行 save + signal 在大表上会拖到分钟级，
中间态期间 ``apply_chat_provider_filter`` 等读取链都会返回 0 行，业务可见瘫痪。
"""

from django.db import migrations


def forwards(apps, schema_editor):
    """批量 UPDATE 而不是 iterator + save。

    SQL 语义：``capability_domains = ARRAY[capability_domain]::varchar[]``，
    条件：``capability_domains`` 为空（NULL 或 cardinality=0）且 ``capability_domain``
    非空字符串。幂等：已回填过的 Provider 不会被再次更新。
    """
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE services_llm_provider
               SET capability_domains = ARRAY[capability_domain]::varchar[]
             WHERE (capability_domains IS NULL
                    OR cardinality(capability_domains) = 0)
               AND capability_domain IS NOT NULL
               AND capability_domain <> ''
            """
        )
        affected = cursor.rowcount
    if affected:
        print(f"[0025_backfill_capability_domains] backfilled {affected} providers via SQL UPDATE")


def backwards(apps, schema_editor):
    """回滚：把 capability_domains 全部清空。"""
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "UPDATE services_llm_provider SET capability_domains = ARRAY[]::varchar[]"
        )


class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0024_llmprovider_capability_domains'),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
