"""
Phase 2.5 step 2/4 — 把 ``LLMProvider.base_url`` 复制到下属每个
``LLMModel.base_url``。

幂等：已有 base_url 的 Model 跳过。
v0.1.x：改用批量 SQL UPDATE（一句 PG correlated update 全表完成），跟 0025 一致。
原 iterator + save 每行触发 post_save 信号 + Fernet 初始化，大表分钟级，
0027→0029 之间业务可见瘫痪窗口；批量 SQL 毫秒级完成。
"""

from django.db import migrations


def forwards(apps, schema_editor):
    """批量 SQL UPDATE：把 provider.base_url 复制到下属每个 model.base_url。"""
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE services_llm_model m
               SET base_url = p.base_url
              FROM services_llm_provider p
             WHERE m.provider_id = p.id
               AND (m.base_url IS NULL OR m.base_url = '')
               AND p.base_url IS NOT NULL
               AND p.base_url <> ''
            """
        )
        affected = cursor.rowcount
    if affected:
        print(f"[0028_backfill_model_base_url] backfilled {affected} models via SQL UPDATE")


def backwards(apps, schema_editor):
    """回滚：把 LLMModel.base_url 全部清空。"""
    with schema_editor.connection.cursor() as cursor:
        cursor.execute("UPDATE services_llm_model SET base_url = ''")


class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0027_llmmodel_base_url'),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
