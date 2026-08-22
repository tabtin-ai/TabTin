"""
drop EngineRuntimeConfig.guard_default_permission_policy

该字段从 0005 → 0030 一路沿袭下来，但 runtime 从未读取过它：
- `PermissionRuleEngine.__init__(default_policy="allow", ...)` 参数默认值固定为
  "allow"，生产代码无任何一处显式传入 default_policy
- 没有 service / view / serializer / consumer / wire 字段会从
  EngineRuntimeConfig 取该值并下发到 runtime / ContextVar
- 仅 admin_api / agent_config_router / GuardPage / chat-config.ts 在读写它做
  纯 UI 闭环——属于历史遗留的死字段

未上线阶段一次到位删，不做兼容层。column 一旦移除，DB 里旧值（多为默认 'allow'）
也随之清空，不需要单独 RunPython 删数据。

回滚提示：反向 = AddField 重建列，默认值 'allow'。回滚后 admin / 前端代码仍
被本 PR 同步删干净，所以即便回滚 DB 也不会再被任何代码引用——回滚仅留下
一个孤立列，无功能损失。
"""
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0041_remove_chatmessage_uq_session_client_event_id_and_more"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="engineruntimeconfig",
            name="guard_default_permission_policy",
        ),
    ]
