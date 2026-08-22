from django.db import migrations


MEMBER_ROLE_MEMBER = 1


def _default_agent_config():
    from apps.tabtinspace.agent_config_v2 import build_default_agent_config_v2

    return build_default_agent_config_v2()


def _space_owner_user_id(SpaceMembership, db_alias, space_id):
    return (
        SpaceMembership.objects.using(db_alias)
        .filter(space_id=space_id, role="owner", is_active=True, user_id__isnull=False)
        .values_list("user_id", flat=True)
        .first()
    )


def _valid_existing_agent_id(Agent, db_alias, execution_space):
    agent_id = getattr(execution_space, "agent_id", None)
    if not agent_id:
        return None
    agent = (
        Agent.objects.using(db_alias)
        .filter(
            id=agent_id,
            workteam_id=execution_space.workteam_id,
            type="bot",
            is_active=True,
        )
        .values("id")
        .first()
    )
    return str(agent["id"]) if agent else None


def _backfill_channel_members(Conversation, ConversationMember, db_alias, team_space_id, agent_id):
    conversations = Conversation.objects.using(db_alias).filter(
        space_id=team_space_id,
        is_archived=False,
    )
    for conversation in conversations.iterator():
        ConversationMember.objects.using(db_alias).get_or_create(
            conversation_id=conversation.id,
            agent_id=str(agent_id),
            defaults={"role": MEMBER_ROLE_MEMBER},
        )
        member_count = ConversationMember.objects.using(db_alias).filter(
            conversation_id=conversation.id,
        ).count()
        Conversation.objects.using(db_alias).filter(id=conversation.id).update(
            member_count=member_count,
        )


def backfill_team_space_execution_agents(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    Space = apps.get_model("tabtinspace", "Space")
    SpaceMembership = apps.get_model("tabtinspace", "SpaceMembership")
    Agent = apps.get_model("tabtinspace", "Agent")
    Conversation = apps.get_model("tabchat", "Conversation")
    ConversationMember = apps.get_model("tabchat", "ConversationMember")
    Device = apps.get_model("tabtinspace", "Device")
    agent_id_by_execution_space_id = {}

    team_spaces = (
        Space.objects.using(db_alias)
        .filter(
            type="team_space",
            execution_space_id__isnull=False,
            is_archived=False,
            trashed_at__isnull=True,
        )
        .select_related("workteam", "execution_space")
    )

    for team_space in team_spaces.iterator():
        execution_space = getattr(team_space, "execution_space", None)
        if execution_space is None:
            continue
        if str(execution_space.workteam_id) != str(team_space.workteam_id):
            continue

        cached_agent_id = agent_id_by_execution_space_id.get(str(execution_space.id))
        if cached_agent_id:
            _backfill_channel_members(
                Conversation,
                ConversationMember,
                db_alias,
                team_space.id,
                cached_agent_id,
            )
            continue

        existing_agent_id = _valid_existing_agent_id(Agent, db_alias, execution_space)
        if existing_agent_id:
            agent_id_by_execution_space_id[str(execution_space.id)] = existing_agent_id
            _backfill_channel_members(
                Conversation,
                ConversationMember,
                db_alias,
                team_space.id,
                existing_agent_id,
            )
            continue

        owner_user_id = _space_owner_user_id(
            SpaceMembership,
            db_alias,
            execution_space.id,
        )
        if not owner_user_id:
            continue

        control_device_id = (
            getattr(execution_space, "control_device_id", None)
            or getattr(execution_space, "bound_device_id", None)
        )
        runtime_type = ""
        if control_device_id:
            runtime_type = (
                Device.objects.using(db_alias)
                .filter(id=control_device_id)
                .values_list("device_type", flat=True)
                .first()
                or ""
            )

        agent = Agent.objects.using(db_alias).create(
            workteam_id=team_space.workteam_id,
            owner_user_id=owner_user_id,
            name=execution_space.name or team_space.name or "AI",
            type="bot",
            custom_rules="",
            working_dir=getattr(execution_space, "working_dir", "") or "",
            working_dir_type=getattr(execution_space, "working_dir_type", "") or "",
            bound_device_id=control_device_id,
            control_device_id=control_device_id,
            runtime_type=runtime_type,
            agent_config=_default_agent_config(),
            is_active=True,
        )
        Space.objects.using(db_alias).filter(id=execution_space.id).update(agent_id=agent.id)
        agent_id_by_execution_space_id[str(execution_space.id)] = str(agent.id)
        _backfill_channel_members(
            Conversation,
            ConversationMember,
            db_alias,
            team_space.id,
            agent.id,
        )


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0079_owner_only_team_space_visibility"),
        ("tabchat", "0013_backfill_team_space_default_channels"),
    ]

    operations = [
        migrations.RunPython(
            backfill_team_space_execution_agents,
            migrations.RunPython.noop,
        ),
    ]
