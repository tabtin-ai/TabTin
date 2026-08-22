"""清理存量 ``Agent.agent_config`` 里的 Hilt W4 退役字段（阶段1 数据治理）。

Hilt W4 把活跃 capability 收敛到只剩 ``cost``。以下字段产品侧已删、生产 reader
（sandbox_policy / approval_rules / dispatcher / forward_runner）已全部不再消费，
只作为老 DB 行的死数据残留：

  - ``capabilities.overrides.{shell,filesystem,network,sql,device,audit}``
  - ``capabilities.preset``
  - 顶层 ``authorization_preset``（清除前先把 yolo 信号推断进
    ``security.allow_yolo_mode``，避免丢语义）
  - 顶层 ``soul``（0053 已清过一轮；此处幂等再兜底）

为何需要本迁移：``0044_agent_config_v2`` 当年用「7 分组版」``migrate_v1_to_v2``
把老行写成 v2，此后 ``schema_version == 2`` 的行不会被任何迁移或读时归一
（运行时 migrate 只对 ``schema_version != 2`` 生效）重跑——所以这些退役子树
长期滞留 DB。这是后续「收紧 schema（删占位字段）」的前置：库里不清干净，
前端整包回写会把退役字段带回去触发 422。

清理逻辑收敛在纯函数 ``agent_config_v2.strip_retired_agent_config_fields``，
与 ``migrate_auth_to_v3`` command 共用，避免两处漂移。**只动退役字段**，活跃
字段（cost / security / conversation / agent_backend / memory / workspace_root /
git_status / approval_memo）一律保留——尤其 ``approval_memo`` 是用户数据，不碰。

写法对齐 0053 / 0054：``apps.get_model`` + PG 门闸 + ``iterator`` + 幂等 +
``bulk_update`` + reverse=noop（退役字段无源数据可恢复，也不应恢复）。
"""

from django.db import migrations


def strip_retired_fields(apps, schema_editor):
    """把存量 ``Agent.agent_config`` 里的退役字段一次性清净。

    幂等：已清净的行不进 update 集（``changed=False``）。非 dict 的 agent_config
    跳过（交给读时 ``migrate_v1_to_v2`` 兜底，本迁移不越界重建 default）。
    """
    db_alias = schema_editor.connection.alias
    # PG 门闸：tabtinspace 属 PostgreSQL；非 PG alias（migrate-all 跑 MySQL 时）
    # 路由层已不会执行本操作，这里再加显式短路防御（对齐 0047 / 0054）。
    if db_alias != "postgresql":
        return

    # lazy import：migration 运行期才取业务纯函数（对齐 0044 的 lazy import 约定）。
    from apps.tabtinspace.agent_config_v2 import strip_retired_agent_config_fields

    Agent = apps.get_model("tabtinspace", "Agent")
    to_update = []
    for agent in (
        Agent.objects.using(db_alias).only("id", "agent_config").iterator()
    ):
        new_cfg, changed = strip_retired_agent_config_fields(agent.agent_config)
        if changed:
            agent.agent_config = new_cfg
            to_update.append(agent)
    if to_update:
        Agent.objects.using(db_alias).bulk_update(
            to_update, ["agent_config"], batch_size=500
        )


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0054_clear_legacy_suggested_prompts"),
    ]

    operations = [
        migrations.RunPython(strip_retired_fields, migrations.RunPython.noop),
    ]
