from django.db import migrations


DEFAULT_CHANNEL_NAMES = ("#general", "#agent-updates")
CONVERSATION_TYPE_GROUP = 2
MEMBER_ROLE_OWNER = 3
MEMBER_ROLE_MEMBER = 1


def _space_execution_agent_id(Space, db_alias, team_space):
    if not getattr(team_space, "execution_space_id", None):
        return ""
    execution_space = (
        Space.objects.using(db_alias)
        .filter(id=team_space.execution_space_id, type="workspace")
        .values("agent_id")
        .first()
    )
    if not execution_space or not execution_space.get("agent_id"):
        return ""
    return str(execution_space["agent_id"])


def _team_space_creator_id(SpaceMembership, Workteam, db_alias, team_space):
    owner_id = (
        SpaceMembership.objects.using(db_alias)
        .filter(
            space_id=team_space.id,
            is_active=True,
            role="owner",
            user_id__isnull=False,
        )
        .values_list("user_id", flat=True)
        .first()
    )
    if owner_id:
        return str(owner_id)

    workteam_owner_id = (
        Workteam.objects.using(db_alias)
        .filter(id=team_space.workteam_id)
        .values_list("owner_id", flat=True)
        .first()
    )
    return str(workteam_owner_id or "")


def _member_rows(ConversationMember, SpaceMembership, db_alias, conversation, team_space, execution_agent_id):
    memberships = list(
        SpaceMembership.objects.using(db_alias)
        .filter(
            space_id=team_space.id,
            is_active=True,
            user_id__isnull=False,
        )
        .values("user_id", "role")
    )
    rows = [
        ConversationMember(
            conversation_id=conversation.id,
            user_id=str(membership["user_id"]),
            role=MEMBER_ROLE_OWNER if membership["role"] == "owner" else MEMBER_ROLE_MEMBER,
        )
        for membership in memberships
        if membership.get("user_id")
    ]
    if execution_agent_id:
        rows.append(
            ConversationMember(
                conversation_id=conversation.id,
                agent_id=execution_agent_id,
                role=MEMBER_ROLE_MEMBER,
            )
        )
    return rows


def backfill_team_space_default_channels(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    Space = apps.get_model("tabtinspace", "Space")
    Workteam = apps.get_model("tabtinspace", "Workteam")
    SpaceMembership = apps.get_model("tabtinspace", "SpaceMembership")
    Conversation = apps.get_model("tabchat", "Conversation")
    ConversationMember = apps.get_model("tabchat", "ConversationMember")

    team_spaces = (
        Space.objects.using(db_alias)
        .filter(
            type="team_space",
            status="active",
            is_archived=False,
            trashed_at__isnull=True,
        )
        .only("id", "workteam_id", "execution_space_id")
        .iterator()
    )
    for team_space in team_spaces:
        creator_id = _team_space_creator_id(SpaceMembership, Workteam, db_alias, team_space)
        execution_agent_id = _space_execution_agent_id(Space, db_alias, team_space)
        for channel_name in DEFAULT_CHANNEL_NAMES:
            existing = (
                Conversation.objects.using(db_alias)
                .filter(
                    workteam_id=str(team_space.workteam_id),
                    space_id=team_space.id,
                    name=channel_name,
                    is_archived=False,
                )
                .first()
            )
            if existing:
                continue

            conversation = Conversation.objects.using(db_alias).create(
                workteam_id=str(team_space.workteam_id),
                space_id=team_space.id,
                type=CONVERSATION_TYPE_GROUP,
                name=channel_name,
                created_by=creator_id,
                member_count=0,
            )
            rows = _member_rows(
                ConversationMember,
                SpaceMembership,
                db_alias,
                conversation,
                team_space,
                execution_agent_id,
            )
            if rows:
                ConversationMember.objects.using(db_alias).bulk_create(rows)
                Conversation.objects.using(db_alias).filter(id=conversation.id).update(
                    member_count=len(rows),
                )


class Migration(migrations.Migration):

    dependencies = [
        ("tabchat", "0012_space_channels_archive"),
        ("tabtinspace", "0079_owner_only_team_space_visibility"),
    ]

    operations = [
        migrations.RunPython(
            backfill_team_space_default_channels,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
