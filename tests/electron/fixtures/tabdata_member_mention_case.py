import json
import os
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db.models import F
from django.test import RequestFactory
from django.utils import timezone

from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.services.table_service import TableService
from apps.tabdata.utils.record_data_access import read_data
from apps.tabtinspace.models import Space, SpaceMembership, Organization, OrganizationMember
from apps.users.auth.api._shared import _build_user_info, _create_auth_session
from apps.users.auth.models import RegistrationInviteCode, RegistrationInviteRedemption
from apps.users.auth.services.invite_code_service import is_invite_gate_enabled
from apps.users.auth.utils import hash_string


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def emit(payload: dict) -> None:
    print("@@E2E@@" + json.dumps(payload, ensure_ascii=False, default=str))


def model_to_dict(obj, fields):
    data = {}
    for field in fields:
        value = getattr(obj, field)
        if hasattr(value, "isoformat"):
            value = value.isoformat().replace("+00:00", "Z")
        elif isinstance(value, UUID):
            value = str(value)
        data[field] = value
    return data


def table_summary(table: Table) -> dict:
    fields = list(
        TableField.objects.filter(table_id=table.id, is_deleted=False)
        .order_by("order")
        .values("id", "name", "field_type", "is_primary", "config")
    )
    return {
        "id": str(table.id),
        "name": table.name,
        "field_count": table.field_count,
        "row_count": table.row_count,
        "record_count": TableRecord.objects.filter(table_id=table.id, is_deleted=False).count(),
        "fields": fields,
        "created_at": table.created_at.isoformat(),
    }


def reset_e2e_table(table: Table) -> None:
    TableRecord.objects.filter(table_id=table.id, is_deleted=False).update(is_deleted=True)
    TableField.objects.filter(table_id=table.id, is_deleted=False).update(is_deleted=True)
    table.field_count = 0
    table.row_count = 0
    table.schema_version = (table.schema_version or 0) + 1
    table.save(update_fields=["field_count", "row_count", "schema_version", "updated_at"])


def get_or_create_member_user(run_id: str):
    User = get_user_model()
    suffix = run_id[-12:].replace("-", "").replace("_", "")
    email = f"tabdata-member-{suffix}@example.com"
    user, created = User.objects.get_or_create(
        email=email,
        defaults={
            "username": f"tabdata_member_{suffix}",
            "nickname": f"E2E 成员 Alpha {suffix}",
            "is_active": True,
            "is_verified_email": True,
        },
    )
    changed = False
    if not user.nickname:
        user.nickname = f"E2E 成员 Alpha {suffix}"
        changed = True
    if not user.is_active:
        user.is_active = True
        changed = True
    if not getattr(user, "is_verified_email", True):
        user.is_verified_email = True
        changed = True
    if created or not user.has_usable_password():
        user.set_password("TabDataMemberE2E!12345")
        changed = True
    if changed:
        user.save()
    return user, created


def ensure_owner_user():
    User = get_user_model()
    email = "tabdata-member-mention-e2e@example.com"
    user, created = User.objects.get_or_create(
        email=email,
        defaults={
            "username": "tabdata_member_mention_e2e",
            "nickname": "TabData Member Mention E2E",
            "is_active": True,
            "is_verified_email": True,
        },
    )
    changed = False
    if created or not user.has_usable_password():
        user.set_password("TabDataMemberMentionE2E!12345")
        changed = True
    if not user.is_active:
        user.is_active = True
        changed = True
    if not getattr(user, "is_verified_email", True):
        user.is_verified_email = True
        changed = True
    if changed:
        user.save()
    return user, created


def ensure_invite_redemption(user) -> bool:
    if not is_invite_gate_enabled():
        return False
    email = user.email
    invite_code, _ = RegistrationInviteCode.objects.get_or_create(
        code="TABDATAMEMBER",
        defaults={
            "description": "TabData member mention Electron E2E",
            "channel": "electron-e2e",
            "campaign": "tabdata-member-mention",
            "is_active": True,
        },
    )
    redemption, invite_redeemed = RegistrationInviteRedemption.objects.get_or_create(
        invite_code=invite_code,
        user=user,
        defaults={
            "identifier_hash": hash_string(email),
            "entrypoint": "electron-e2e",
            "ip_address": "127.0.0.1",
            "user_agent": "TabTin-Electron-E2E/1.0",
        },
    )
    if invite_redeemed:
        RegistrationInviteCode.objects.filter(id=redemption.invite_code_id).update(
            used_count=F("used_count") + 1
        )
    return invite_redeemed


def ensure_team_context(user, run_id: str):
    marker = f"[{run_id}]"
    organization, organization_created = Organization.objects.get_or_create(
        name=f"{marker} TabData 成员选择团队",
        owner=user,
        defaults={
            "description": "Run-scoped team Organization for TabData member mention E2E.",
            "icon": "👥",
            "type": Organization.OrganizationType.TEAM,
            "is_default": False,
            "settings": {"e2e": True, "scenario": "tabdata.member-mention"},
        },
    )
    if organization.type != Organization.OrganizationType.TEAM:
        organization.type = Organization.OrganizationType.TEAM
        organization.save(update_fields=["type", "updated_at"])
    OrganizationMember.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"role": "owner"},
    )

    archived_count = (
        Space.objects.filter(
            organization=organization,
            type=Space.SpaceType.TEAM_SPACE,
            status="active",
            is_archived=False,
            trashed_at__isnull=True,
            name__startswith="[e2e-tabdata-member] ",
        )
        .exclude(name=f"[e2e-tabdata-member] {run_id}")
        .update(is_archived=True, status="archived")
    )

    space, space_created = Space.objects.get_or_create(
        organization=organization,
        name=f"[e2e-tabdata-member] {run_id}",
        defaults={
            "type": Space.SpaceType.TEAM_SPACE,
            "description": "Run-scoped team Space for TabData member mention E2E.",
            "status": "active",
            "is_default": False,
            "visibility": "private",
        },
    )
    if space.type != Space.SpaceType.TEAM_SPACE:
        space.type = Space.SpaceType.TEAM_SPACE
        space.save(update_fields=["type", "updated_at"])
    SpaceMembership.objects.get_or_create(
        space=space,
        user=user,
        defaults={"role": "owner", "is_active": True},
    )
    return organization, space, organization_created, space_created, archived_count


def build_auth_payload(
    user,
    organization,
    space,
    created_user: bool,
    space_created: bool,
    archived_count: int,
    invite_redeemed: bool,
) -> dict:
    request = RequestFactory().post("/api/auth/login")
    request.META["REMOTE_ADDR"] = "127.0.0.1"
    request.META["HTTP_USER_AGENT"] = "TabTin-Electron-E2E/1.0"
    access_token, refresh_token, access_expire_hours = _create_auth_session(
        user,
        request,
        remember_me=False,
    )
    user_info = _build_user_info(user).model_dump(mode="json")

    organization_payload = model_to_dict(
        organization,
        [
            "id",
            "name",
            "description",
            "icon",
            "type",
            "owner_id",
            "is_default",
            "created_at",
            "updated_at",
        ],
    )
    organization_payload["settings"] = organization.settings or {}

    space_payload = model_to_dict(
        space,
        [
            "id",
            "organization_id",
            "name",
            "description",
            "icon",
            "type",
            "status",
            "is_default",
            "created_at",
            "updated_at",
        ],
    )

    return {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": int((timezone.now().timestamp() + access_expire_hours * 3600) * 1000),
        "userInfo": user_info,
        "organization": organization_payload,
        "space": space_payload,
        "createdUser": created_user,
        "e2eSpaceCreated": space_created,
        "archivedE2eSpaceCount": archived_count,
        "inviteRedeemed": invite_redeemed,
    }


def get_or_create_e2e_table(service: TableService, space_id: UUID, table_name: str) -> tuple[Table, bool]:
    table = (
        Table.objects.filter(
            space_id=space_id,
            name__contains="成员 @ 选择验收",
            is_archived=False,
            trashed_at__isnull=True,
        )
        .order_by("-created_at")
        .first()
    )
    if table is not None:
        reset_e2e_table(table)
        updated = service.update_table(table.id, name=table_name)
        return updated or table, False
    return service.create_table(space_id=space_id, name=table_name, use_default_fields=False), True


def create_record(service: RecordService, table_id: UUID, data: dict) -> TableRecord:
    record, error = service.create_record(table_id, data)
    if error:
        raise RuntimeError(error)
    return record


def prepare_case() -> None:
    run_id = require_env("TABTIN_E2E_RUN_ID")
    marker = f"[{run_id}]"

    user, user_created = ensure_owner_user()
    invite_redeemed = ensure_invite_redemption(user)
    organization, space, _organization_created, space_created, archived_count = ensure_team_context(user, run_id)
    space_id = space.id
    member_user, member_created = get_or_create_member_user(run_id)
    OrganizationMember.objects.get_or_create(
        organization=organization,
        user=member_user,
        defaults={"role": "editor"},
    )
    SpaceMembership.objects.get_or_create(
        space_id=space_id,
        user=member_user,
        defaults={"role": "editor", "is_active": True},
    )

    table_service = TableService(user=user)
    record_service = RecordService(user=user)
    table_name = f"{marker} 成员 @ 选择验收"
    table, table_created = get_or_create_e2e_table(table_service, space_id, table_name)
    fields, errors = table_service.bulk_create_fields(
        table.id,
        [
            {"name": "任务", "field_type": "text", "is_primary": True},
            {"name": "负责人", "field_type": "user", "options": {"multiple": False}},
        ],
    )
    if errors:
        raise RuntimeError(f"{table_name} field creation failed: {errors}")
    fields_by_name = {field.name: field for field in fields}
    title_field = fields_by_name["任务"]
    assignee_field = fields_by_name["负责人"]
    record = create_record(
        record_service,
        table.id,
        {str(title_field.id): f"{marker} 等待 @ 选择成员"},
    )
    table.refresh_from_db()
    assignee_field.refresh_from_db()

    emit(
        {
            "runId": run_id,
            "marker": marker,
            "auth": build_auth_payload(
                user,
                organization,
                space,
                user_created,
                space_created,
                archived_count,
                invite_redeemed,
            ),
            "userId": str(user.id),
            "organizationId": str(organization.id),
            "spaceId": str(space_id),
            "spaceType": space.type,
            "table": table_summary(table),
            "tableCreated": table_created,
            "record": {
                "id": str(record.id),
                "title": read_data(record).get(str(title_field.id)),
            },
            "fields": {
                "title": {"id": str(title_field.id), "name": title_field.name},
                "assignee": {
                    "id": str(assignee_field.id),
                    "name": assignee_field.name,
                    "field_type": assignee_field.field_type,
                },
            },
            "candidateMember": {
                "userId": str(member_user.id),
                "displayName": member_user.nickname or member_user.username or member_user.email,
                "email": member_user.email,
                "created": member_created,
            },
        }
    )


def verify_case() -> None:
    record_id = UUID(require_env("TABTIN_E2E_RECORD_ID"))
    field_id = require_env("TABTIN_E2E_FIELD_ID")
    expected_user_id = require_env("TABTIN_E2E_EXPECTED_USER_ID")
    record = TableRecord.objects.get(id=record_id, is_deleted=False)
    data = read_data(record)
    actual = data.get(field_id)
    emit(
        {
            "recordId": str(record.id),
            "fieldId": field_id,
            "expectedUserId": expected_user_id,
            "actualValue": actual,
            "matched": actual == expected_user_id,
        }
    )


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    if mode == "prepare":
        prepare_case()
        return
    if mode == "verify":
        verify_case()
        return
    raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()
