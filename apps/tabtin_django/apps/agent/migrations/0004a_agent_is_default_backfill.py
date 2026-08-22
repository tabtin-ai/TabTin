"""#6184/#6353：默认 Agent 回填 + 历史名「小Tin」。

与 0004 AddField / 0004b AddConstraint 拆事务，避  pending trigger。
"""

from __future__ import annotations

from django.db import migrations


LEGACY_ONBOARDING_AGENT_NAMES = (
    "默认 Workspace 执行身份",
    "万能Tin",
)
DEFAULT_ONBOARDING_AGENT_NAME = "小Tin"


def backfill_default_agents(apps, schema_editor):
    Agent = apps.get_model("agent", "Agent")
    Agent.objects.filter(name__in=LEGACY_ONBOARDING_AGENT_NAMES).update(
        name=DEFAULT_ONBOARDING_AGENT_NAME,
    )

    pairs = (
        Agent.objects.filter(is_active=True, type="bot", owner_user__isnull=False)
        .values_list("organization_id", "owner_user_id")
        .distinct()
    )
    for organization_id, owner_user_id in pairs:
        first = (
            Agent.objects.filter(
                organization_id=organization_id,
                owner_user_id=owner_user_id,
                is_active=True,
                type="bot",
            )
            .order_by("created_at", "id")
            .first()
        )
        if first is None:
            continue
        Agent.objects.filter(
            organization_id=organization_id,
            owner_user_id=owner_user_id,
            is_default=True,
        ).exclude(pk=first.pk).update(is_default=False)
        if not first.is_default:
            Agent.objects.filter(pk=first.pk).update(is_default=True)


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("agent", "0004_agent_is_default"),
    ]

    operations = [
        migrations.RunPython(backfill_default_agents, noop_reverse),
    ]
