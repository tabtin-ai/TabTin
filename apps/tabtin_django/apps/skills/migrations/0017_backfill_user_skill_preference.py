# Generated manually for  — 从已启用 AgentSkillLink 回填用户总闸（仅数据）

from django.db import migrations


def backfill_user_skill_preferences(apps, schema_editor):
    AgentSkillLink = apps.get_model("skills", "AgentSkillLink")
    UserSkillPreference = apps.get_model("skills", "UserSkillPreference")
    Agent = apps.get_model("agent", "Agent")

    enabled_links = (
        AgentSkillLink.objects.filter(enabled=True)
        .values_list("agent_id", "skill_canonical_key")
        .iterator(chunk_size=500)
    )
    agent_owner: dict = {}
    rows_by_key: dict[tuple, None] = {}

    for agent_id, skill_key in enabled_links:
        if agent_id not in agent_owner:
            owner_id = (
                Agent.objects.filter(id=agent_id)
                .values_list("owner_user_id", flat=True)
                .first()
            )
            agent_owner[agent_id] = owner_id
        owner_id = agent_owner[agent_id]
        if not owner_id or not skill_key:
            continue
        rows_by_key[(owner_id, skill_key)] = None

    existing = set(
        UserSkillPreference.objects.filter(
            user_id__in={uid for uid, _ in rows_by_key},
        ).values_list("user_id", "skill_canonical_key")
    )
    to_create = [
        UserSkillPreference(
            user_id=user_id,
            skill_canonical_key=skill_key,
            enabled=True,
        )
        for (user_id, skill_key) in rows_by_key
        if (user_id, skill_key) not in existing
    ]
    if to_create:
        UserSkillPreference.objects.bulk_create(to_create, batch_size=500)


def noop_reverse(apps, schema_editor):
    # 回填不可安全反推删除（用户可能已手工改总闸），保留行。
    return


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0016_user_skill_preference"),
        ("agent", "0005_rename_default_agent_to_xiaotin"),
    ]

    operations = [
        migrations.RunPython(backfill_user_skill_preferences, noop_reverse),
    ]
