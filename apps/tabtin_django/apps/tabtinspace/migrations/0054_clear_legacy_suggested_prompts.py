"""清空存量 ``Agent.suggested_prompts``（D4 去引导收尾）。

Soul 时代会把"推荐问题"快照进 ``Agent.suggested_prompts`` 列，空对话据此渲染
引导 chips。Soul 移除后前端不再 fallback，但**存量老 Agent 的该列仍留着旧快照**，
老 Agent 空对话依然会冒出旧 chips。这里一次性把所有非空 ``suggested_prompts``
清成 ``[]``，去掉残留引导。

注意：**只清数据，保留列本身**（``suggested_prompts`` 仍是用户可覆写字段，见
总控 §3.3 保留清单），因此无任何 schema 变更，仅 ``RunPython``。

写法对齐 0053（``apps.get_model`` + ``schema_editor.connection.alias`` + 幂等 +
reverse=noop），并补上 0047 式的 PG 门闸（tabtinspace 走 PostgreSQL，非 PG alias
直接返回）与 ``bulk_update``（替代逐行 save）。
"""

from django.db import migrations


def clear_legacy_suggested_prompts(apps, schema_editor):
    """把所有非空 ``Agent.suggested_prompts`` 清成 ``[]``。

    幂等：已为空（``[]`` / 空值）的行不进 update 集；reverse 为 noop——旧快照已无
    源数据可恢复，也不应恢复。
    """
    db_alias = schema_editor.connection.alias
    # PG 门闸：tabtinspace 属 PostgreSQL，非 PG alias（migrate-all 跑 MySQL 时）
    # 路由层已不会执行本操作，这里再加显式短路防御（对齐 0047）。
    if db_alias != "postgresql":
        return

    Agent = apps.get_model("tabtinspace", "Agent")
    to_update = []
    for agent in (
        Agent.objects.using(db_alias).only("id", "suggested_prompts").iterator()
    ):
        # 非空（含非 list 脏值）才清；空列表 / None 跳过保证幂等。
        if agent.suggested_prompts:
            agent.suggested_prompts = []
            to_update.append(agent)
    if to_update:
        Agent.objects.using(db_alias).bulk_update(
            to_update, ["suggested_prompts"], batch_size=500
        )


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0053_remove_soul_preset"),
    ]

    operations = [
        migrations.RunPython(
            clear_legacy_suggested_prompts, migrations.RunPython.noop
        ),
    ]
