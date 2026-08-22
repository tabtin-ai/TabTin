"""TC-36：Message.search_text 字段 + 数据回填 + search_tsvector 重算。

search_text 聚合 content + metadata.file_name + metadata.card.title/description，
让文件名和资源卡标题可被全文搜索。回填旧消息后重算 tsvector。
"""

from django.db import migrations, models


def _compute_search_text(content: str, metadata: dict) -> str:
    """与 message_service._compute_search_text 保持一致。"""
    parts = [content or ""]
    if not isinstance(metadata, dict):
        return parts[0]
    file_name = metadata.get("file_name") or ""
    if file_name:
        parts.append(file_name)
    card = metadata.get("card")
    if isinstance(card, dict):
        card_title = card.get("title") or ""
        card_desc = card.get("description") or ""
        if card_title:
            parts.append(card_title)
        if card_desc:
            parts.append(card_desc)
    return "\n".join(p for p in parts if p)


def backfill_search_text(apps, schema_editor):
    """遍历所有 Message，计算 search_text 并重算 search_tsvector。"""
    Message = apps.get_model("tabchat", "Message")
    batch_size = 5000
    qs = Message.objects.all().iterator(chunk_size=batch_size)
    to_update = []
    for msg in qs:
        new_text = _compute_search_text(msg.content or "", msg.metadata or {})
        if msg.search_text != new_text:
            msg.search_text = new_text
            to_update.append(msg)
        if len(to_update) >= batch_size:
            Message.objects.bulk_update(to_update, ["search_text"])
            to_update = []
    if to_update:
        Message.objects.bulk_update(to_update, ["search_text"])

    # 重算 search_tsvector（仅 PG；sqlite 跳过）
    if schema_editor.connection.vendor == "postgresql":
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(
                "UPDATE tabchat_message SET search_tsvector = "
                "to_tsvector('simple', coalesce(search_text, '')) "
                "WHERE search_tsvector IS NULL OR search_tsvector = ''::tsvector "
                "OR search_text <> ''"
            )


def noop_reverse(apps, schema_editor):
    """反向操作：不删除 search_text 数据（字段会被 RemoveField 删除）。"""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("tabchat", "0009_conversation_labels"),
    ]

    operations = [
        migrations.AddField(
            model_name="message",
            name="search_text",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.RunPython(backfill_search_text, noop_reverse),
    ]
