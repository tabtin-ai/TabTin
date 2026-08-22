# 回填历史会话的缓存累计字段。
#
# 0057 给 ChatSession 加了 cache_read_input_tokens / cache_creation_input_tokens，
# 但存量会话为 0——「缓存复用」在历史会话里显示不出来。本迁移从每条 assistant
# 消息 metadata 里已有的 per-turn cache（由 _attach_cost_metadata_from_done 写入，
# 等于当轮 DONE.usage.cache_*，与 RelayMessageWriter 实时累加口径一致）求和回填。
#
# 只回填「当前两个字段都为 0」的会话——避免覆盖已经由新累加路径写入真实值的会话，
# 因此可安全重跑（幂等）。

from django.db import migrations


def backfill_cache_tokens(apps, schema_editor):
    conn = schema_editor.connection
    if conn.vendor != "postgresql":
        return
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE chat_session cs SET
                cache_read_input_tokens = COALESCE(agg.cr, 0),
                cache_creation_input_tokens = COALESCE(agg.cc, 0)
            FROM (
                SELECT session_id,
                    SUM(CASE WHEN jsonb_typeof(metadata->'cache_read_input_tokens') = 'number'
                             THEN (metadata->>'cache_read_input_tokens')::bigint ELSE 0 END) AS cr,
                    SUM(CASE WHEN jsonb_typeof(metadata->'cache_creation_input_tokens') = 'number'
                             THEN (metadata->>'cache_creation_input_tokens')::bigint ELSE 0 END) AS cc
                FROM chat_message
                WHERE role = 'assistant' AND metadata IS NOT NULL
                GROUP BY session_id
            ) agg
            WHERE cs.id = agg.session_id
              AND (COALESCE(agg.cr, 0) > 0 OR COALESCE(agg.cc, 0) > 0)
              AND cs.cache_read_input_tokens = 0
              AND cs.cache_creation_input_tokens = 0
            """
        )


def noop_reverse(apps, schema_editor):
    # 回填不可逆：置 0 会误伤新累加路径写入的真实值，故 reverse 为 no-op。
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0057_chatsession_cache_creation_input_tokens_and_more'),
    ]

    operations = [
        migrations.RunPython(backfill_cache_tokens, noop_reverse),
    ]
