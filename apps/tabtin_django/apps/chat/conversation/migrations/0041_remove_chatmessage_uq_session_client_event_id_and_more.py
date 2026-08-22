"""W036 修复 —— 把 ChatMessage 的 partial unique constraint 改成无条件 unique。

背景（数据正确性 bug）
---------------------
``conversation`` app 走 default 库（MySQL）；MySQL 不支持
``UniqueConstraint(condition=...)`` 的 partial unique。Django 系统检查 W036
警告会打"约束不会被创建"，但代码层面 ``_upsert_chat_message``
（``apps/services/common/ws/handlers/relay_message_writer.py``）显式依赖
``IntegrityError`` 实现幂等：

    try:
        with transaction.atomic():
            msg = ChatMessage.objects.create(**create_kwargs)
        return msg.id
    except IntegrityError:
        existing = ChatMessage.objects.filter(...).first()
        if existing: return existing
        raise

MySQL 上约束不存在 → 重发同一条 ``client_event_id`` 不会抛 IntegrityError
→ 重复消息直接落库。dev 库已观察到 1 组 ``(session, client_event_id)`` 重复
（``session=bca50b21..., cid=411c889b...``）。

修复策略
--------
把 ``UniqueConstraint`` 的 ``condition=Q(client_event_id__isnull=False)``
去掉，改成无条件全字段 unique。两库默认行为已经满足"NULL 不参与唯一性比较"——

* MySQL: ``UNIQUE`` 索引对多个 NULL 视为不冲突（5 条原本 NULL 的存量行
  可以共存）；
* PostgreSQL: 默认 NULLS DISTINCT，行为相同。

所以新约束跨库语义等价于原来的 partial 条件，但这次 MySQL 也会真正创建
unique 索引，``_upsert_chat_message`` 的 IntegrityError 幂等路径在双库都
能触发。

为什么需要 RunPython 数据去重
-----------------------------
``RemoveConstraint`` → ``AddConstraint`` 之间，AddConstraint 会因 MySQL
上已有的重复行直接 DDL 失败。所以中间插入 RunPython：保留每组 ``(session,
client_event_id)`` 重复中 ``id`` 最小的真身，其余行的 ``client_event_id``
置 NULL（不删消息文本，只破唯一性）。受影响行变成"无 client_event_id"
状态，与原本就 NULL 的存量行一致。
"""

from django.db import migrations, models
from django.db.models import Count


def dedupe_client_event_id(apps, schema_editor):
    """保留每组重复中 id 最小的，其余 client_event_id 置 NULL。"""
    ChatMessage = apps.get_model("conversation", "ChatMessage")

    duplicates = (
        ChatMessage.objects.filter(client_event_id__isnull=False)
        .values("session_id", "client_event_id")
        .annotate(count=Count("id"))
        .filter(count__gt=1)
    )

    cleared = 0
    for dup in duplicates:
        ids = list(
            ChatMessage.objects.filter(
                session_id=dup["session_id"],
                client_event_id=dup["client_event_id"],
            )
            .order_by("id")
            .values_list("id", flat=True)
        )
        if len(ids) > 1:
            updated = ChatMessage.objects.filter(id__in=ids[1:]).update(
                client_event_id=None
            )
            cleared += updated

    if cleared:
        print(
            f"[conversation.0041] 去重置 NULL {cleared} 行 ChatMessage.client_event_id"
        )


def reverse_noop(apps, schema_editor):
    """RunPython 不可逆——置 NULL 后无法还原 cid 与原始消息的关联。

    不抛错（避免 ``migrate <app> zero`` 回滚卡住），仅声明此步无副作用回滚。
    """
    return


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0040_chatmessage_message_kind"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="chatmessage",
            name="uq_session_client_event_id",
        ),
        migrations.RunPython(dedupe_client_event_id, reverse_noop),
        migrations.AddConstraint(
            model_name="chatmessage",
            constraint=models.UniqueConstraint(
                fields=("session", "client_event_id"),
                name="uq_session_client_event_id",
            ),
        ),
    ]
