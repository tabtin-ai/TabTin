"""回填 AgentSkillLink（技能携带集， B1.2，audit 底稿 §12.2）。

从 ``SkillEnablement``（(user, space) 锚）回填 Agent 携带集（agent 锚）。

口径（同 conversation/0055 与 tabmemo/0022 的三分流先例）：
- 只处理 space 为 **workspace 型**（个人 Space，「一 agent 一 space」成立）且
  ``space.agent_id`` 非空的 SkillEnablement 行，取 ``space.agent_id`` 一跳拍平；
- **team_space 型不回填**：无 1:1 agent，多用户 enablement 混杂，盲回填会
  错归主；留待二期随 Project 迁移处理；
- **owner 校验（防错归主）**：``SkillEnablement.user_id`` 必须等于
  ``agent.owner_user_id``，不一致（含 owner_user_id 为空）→ 跳过并 log 计数。
  比 tabmemo/0022 的双键校验更严（空 owner 也跳过）：config_json 可能含
  credential_id 等私有配置，错归到无主 agent 等于泄露引用。

幂等：只创建携带集里尚不存在的 (agent, skill_canonical_key) 行（unique
冲突跳过），重跑不报错、不覆盖已有行。

按 Space 逐个处理：单个 space 的 enablement 行天然小批量、无长事务。
"""

from django.db import migrations


def backfill_agent_skill_links(apps, schema_editor):
    import logging

    logger = logging.getLogger(__name__)

    alias = schema_editor.connection.alias
    Space = apps.get_model("tabtinspace", "Space")
    SkillEnablement = apps.get_model("skills", "SkillEnablement")
    AgentSkillLink = apps.get_model("skills", "AgentSkillLink")

    spaces = (
        Space.objects.using(alias)
        .filter(type="workspace", agent__isnull=False)
        .values_list("id", "agent_id", "agent__owner_user_id")
    )

    total_created = 0
    total_skipped_owner = 0
    total_skipped_existing = 0
    for space_id, agent_id, agent_owner_user_id in spaces.iterator(chunk_size=500):
        rows = SkillEnablement.objects.using(alias).filter(space_id=space_id)

        if agent_owner_user_id is None:
            skipped = rows.count()
            if skipped:
                total_skipped_owner += skipped
                logger.warning(
                    "[AgentSkillLinkBackfill] skipped %d enablements in space=%s: "
                    "agent(%s).owner_user_id 为空 — 防错归主不回填",
                    skipped, space_id, agent_id,
                )
            continue

        mismatched = rows.exclude(user_id=agent_owner_user_id).count()
        if mismatched:
            total_skipped_owner += mismatched
            logger.warning(
                "[AgentSkillLinkBackfill] skipped %d enablements in space=%s: "
                "user_id != agent.owner_user_id(%s) — 防错归主不回填",
                mismatched, space_id, agent_owner_user_id,
            )

        existing_keys = set(
            AgentSkillLink.objects.using(alias)
            .filter(agent_id=agent_id)
            .values_list("skill_canonical_key", flat=True)
        )

        batch = []
        for row in rows.filter(user_id=agent_owner_user_id).iterator(chunk_size=500):
            if row.skill_canonical_key in existing_keys:
                total_skipped_existing += 1
                continue
            existing_keys.add(row.skill_canonical_key)
            batch.append(
                AgentSkillLink(
                    agent_id=agent_id,
                    skill_canonical_key=row.skill_canonical_key,
                    source=row.source,
                    skill_id=row.skill_id,
                    enabled=row.enabled,
                    config_json=row.config_json or {},
                )
            )
        if batch:
            AgentSkillLink.objects.using(alias).bulk_create(
                batch, batch_size=500, ignore_conflicts=True,
            )
            total_created += len(batch)

    logger.info(
        "[AgentSkillLinkBackfill] done: created=%d skipped_owner_mismatch=%d "
        "skipped_existing=%d",
        total_created, total_skipped_owner, total_skipped_existing,
    )


def noop_reverse(apps, schema_editor):
    """回滚由 0010 逆向撤表承担，回填数据无需单独清理。"""


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0012_agent_skill_link"),
    ]

    operations = [
        migrations.RunPython(backfill_agent_skill_links, noop_reverse),
    ]
