from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def backfill_agent_owner_user(apps, schema_editor):
    if schema_editor is not None and schema_editor.connection.vendor == "postgresql":
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(
                'ALTER TABLE "tabtinspace_agent" '
                'ADD COLUMN IF NOT EXISTS "owner_user_id" varchar(36) NULL;'
            )
            cursor.execute(
                'CREATE INDEX IF NOT EXISTS "ctx_agent_ws_owner_idx" '
                'ON "tabtinspace_agent" ("workteam_id", "owner_user_id");'
            )

    Agent = apps.get_model("tabtinspace", "Agent")
    Space = apps.get_model("tabtinspace", "Space")
    SpaceMembership = apps.get_model("tabtinspace", "SpaceMembership")
    SpaceShare = apps.get_model("tabtinspace", "SpaceShare")
    DelegationGrant = apps.get_model("tabtinspace", "DelegationGrant")

    Agent.objects.filter(
        user_id__isnull=False,
        owner_user_id__isnull=True,
    ).update(owner_user_id=models.F("user_id"))

    # 历史 bot Space 的 membership 可能被团队全员同步污染，不能把 viewer/editor
    # 当成创建者。先回填明确的 workteam 默认 Space 绑定 Agent 给 workteam owner，再从
    # 唯一 active owner membership 推断非默认 bot Agent；仍无法唯一确认的保持
    # owner_user=NULL，查询层会将其视为不可见，避免错归属。
    Workteam = apps.get_model("tabtinspace", "Workteam")
    default_spaces = (
        Space.objects
        .filter(type="bot", is_default=True, agent_id__isnull=False)
        .values_list("agent_id", "workteam_id")
        .iterator()
    )
    for agent_id, workteam_id in default_spaces:
        owner_user_id = (
            Workteam.objects
            .filter(id=workteam_id)
            .values_list("owner_id", flat=True)
            .first()
        )
        if owner_user_id is not None:
            Agent.objects.filter(
                id=agent_id,
                owner_user_id__isnull=True,
            ).update(owner_user_id=owner_user_id)

    inferred_spaces = (
        Space.objects
        .filter(type="bot", is_default=False, agent_id__isnull=False, agent__owner_user_id__isnull=True)
        .values_list("id", "agent_id")
        .iterator()
    )
    for space_id, agent_id in inferred_spaces:
        owner_user_ids = set()
        owner_memberships = (
            SpaceMembership.objects
            .filter(space_id=space_id, is_active=True, role="owner")
            .values_list("user_id", "agent__user_id")
            .iterator()
        )
        for membership_user_id, agent_user_id in owner_memberships:
            if membership_user_id is not None:
                owner_user_ids.add(membership_user_id)
            if agent_user_id is not None:
                owner_user_ids.add(agent_user_id)
        if len(owner_user_ids) == 1:
            Agent.objects.filter(
                id=agent_id,
                owner_user_id__isnull=True,
            ).update(owner_user_id=next(iter(owner_user_ids)))

    bot_spaces = (
        Space.objects
        .filter(type="bot", agent__owner_user_id__isnull=False)
        .values_list("id", "agent__owner_user_id")
        .iterator()
    )
    for space_id, owner_user_id in bot_spaces:
        SpaceMembership.objects.filter(
            space_id=space_id,
            is_active=True,
        ).exclude(
            agent__user_id=owner_user_id,
        ).exclude(
            user_id=owner_user_id,
        ).update(is_active=False)

    SpaceMembership.objects.filter(
        is_active=True,
        space__type="bot",
        space__agent__owner_user_id__isnull=True,
    ).update(is_active=False)

    SpaceMembership.objects.filter(
        is_active=True,
        space__type="bot",
        agent__type="bot",
    ).exclude(
        agent__owner_user_id=models.F("space__agent__owner_user_id"),
    ).update(is_active=False)

    SpaceShare.objects.filter(
        status__in=("active", "pending"),
        space__type="bot",
    ).update(status="revoked")

    DelegationGrant.objects.filter(
        status="active",
        space__type="bot",
    ).update(status="revoked")


def noop_reverse(apps, schema_editor):
    # 保留回填结果；字段删除时由 schema migration 负责丢弃列。
    pass


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("tabtinspace", "0061_workteam_status"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AddField(
                    model_name="agent",
                    name="owner_user",
                    field=models.ForeignKey(
                        blank=True,
                        help_text="所有 Agent 都是用户私有资源；bot Agent 用该字段记录创建者/归属用户。",
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="owned_agents",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Agent 归属用户",
                    ),
                ),
                migrations.AddIndex(
                    model_name="agent",
                    index=models.Index(
                        fields=["workteam", "owner_user"],
                        name="ctx_agent_ws_owner_idx",
                    ),
                ),
            ],
        ),
        migrations.RunPython(backfill_agent_owner_user, noop_reverse),
    ]
