#!/usr/bin/env python3
"""
Stage 4.1 Batch2 资源治理敏感动作 smoke。
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import Any

from django.test import Client, RequestFactory
from django.utils import timezone

from apps.services.oss.models import FileRecord
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table
from apps.tabdoc.models import Document, DocumentVersion
from apps.tabslide.models import SlideProject
from apps.tabtinspace.models import Space
from apps.users.auth.models import (
    AdminAccount,
    AdminAccountRole,
    AdminPermission,
    AdminRole,
    AdminSensitiveActionLog,
    User,
)
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token


SMOKE_PERMISSIONS = [
    "table:delete",
    "table:restore",
    "table:repair",
    "doc:delete",
    "doc:restore",
    "slide:delete",
    "slide:restore",
    "asset:delete",
    "asset:repair",
]


@dataclass
class SmokeCase:
    key: str
    method: str
    url: str
    permission: str
    body_forbidden: dict[str, Any]
    body_empty_reason: dict[str, Any]
    body_success: dict[str, Any]
    expected_action: str
    expected_target_type: str


def _json(resp) -> dict[str, Any]:
    try:
        return json.loads(resp.content.decode("utf-8")) if resp.content else {}
    except Exception:
        return {}


def _extract_missing_permission(payload: Any) -> str:
    if isinstance(payload, dict):
        value = payload.get("missing_permission")
        if isinstance(value, str):
            return value
        message = payload.get("message")
        if isinstance(message, str):
            match = re.search(r"missing_permission['\"]?:\s*['\"]([^'\"]+)['\"]", message)
            if match:
                return match.group(1)
        for nested in payload.values():
            found = _extract_missing_permission(nested)
            if found:
                return found
    if isinstance(payload, list):
        for nested in payload:
            found = _extract_missing_permission(nested)
            if found:
                return found
    return ""


def _request(client: Client, method: str, url: str, body: dict[str, Any]):
    if method.upper() != "POST":
        raise ValueError(f"unsupported method: {method}")
    return client.post(url, data=json.dumps(body), content_type="application/json")


def _ensure_smoke_actor(username: str, email: str) -> tuple[User, AdminAccount]:
    user, _ = User.objects.get_or_create(
        username=username,
        defaults={
            "email": email,
            "is_active": True,
            "is_staff": True,
            "is_superuser": False,
        },
    )
    if not user.is_active or not user.is_staff:
        user.is_active = True
        user.is_staff = True
        user.save(update_fields=["is_active", "is_staff"])

    account, _ = AdminAccount.objects.get_or_create(
        user=user,
        defaults={
            "display_name": username,
            "status": AdminAccount.STATUS_ACTIVE,
            "admin_login_enabled": True,
            "created_by": user,
        },
    )
    update_fields: list[str] = []
    if account.status != AdminAccount.STATUS_ACTIVE:
        account.status = AdminAccount.STATUS_ACTIVE
        update_fields.append("status")
    if not account.admin_login_enabled:
        account.admin_login_enabled = True
        update_fields.append("admin_login_enabled")
    if update_fields:
        update_fields.append("updated_at")
        account.save(update_fields=update_fields)
    return user, account


def _make_client(user: User) -> Client:
    factory = RequestFactory()
    req = factory.get("/api/auth/admin/stage41-batch2-smoke")
    req.META["REMOTE_ADDR"] = "127.0.0.1"
    req.META["HTTP_USER_AGENT"] = "stage41-batch2-smoke"
    session = SessionManager.create_session(user, req)
    token = generate_jwt_token(user, session_key=session.session_key)
    return Client(
        HTTP_AUTHORIZATION=f"Bearer {token}",
        REMOTE_ADDR="127.0.0.1",
        HTTP_USER_AGENT="stage41-batch2-smoke",
    )


def _bool_json_serializable(data: Any) -> bool:
    try:
        json.dumps(data, ensure_ascii=False)
        return True
    except Exception:
        return False


def _prepare_resources(smoke_user: User, suffix: str) -> dict[str, Any]:
    from apps.tabtinspace.models import Workspace
    space = Workspace.objects.using(TABDATA_DB_ALIAS).order_by("-created_at").first()
    if space is None:
        raise RuntimeError("缺少可用 Space 数据，无法执行 batch2 smoke")
    valid_space_id = space.id
    valid_organization_id = space.organization_id

    table = (
        Table.objects.using(TABDATA_DB_ALIAS)
        .filter(trashed_at__isnull=True, space_id=valid_space_id)
        .first()
    )
    if table is None:
        table = Table.objects.using(TABDATA_DB_ALIAS).create(
            name=f"stage41_batch2_table_{suffix}",
            description="stage41 batch2 smoke table",
            owner=smoke_user,
            organization_id=valid_organization_id,
            space_id=valid_space_id,
        )
    table.is_archived = False
    table.save(update_fields=["is_archived", "updated_at"])

    doc = Document.objects.filter(trashed_at__isnull=True, space_id=valid_space_id).first()
    if doc is None:
        doc = Document.objects.create(
            title=f"stage41_batch2_doc_{suffix}",
            organization_id=valid_organization_id,
            space_id=valid_space_id,
            status="active",
            latest_version=1,
            updated_by=smoke_user,
        )
    doc.status = "active"
    doc.updated_by = smoke_user
    doc.save(update_fields=["status", "updated_by", "updated_at"])

    doc_version = DocumentVersion.objects.filter(document=doc).order_by("-created_at").first()
    if doc_version is None:
        doc_version = DocumentVersion.objects.create(
            document=doc,
            organization_id=doc.organization_id,
            description_markdown=doc.description_markdown or "<p></p>",
            description_json=doc.description_json or {},
            description_plaintext=doc.description_plaintext or "",
            version=max(int(doc.latest_version or 0), 1),
            last_saved_at=timezone.now(),
            created_by=smoke_user,
        )

    slide = SlideProject.objects.filter(trashed_at__isnull=True, space_id=valid_space_id).first()
    if slide is None:
        slide = SlideProject.objects.create(
            name=f"stage41_batch2_slide_{suffix}",
            organization_id=valid_organization_id,
            space_id=valid_space_id,
            status="active",
        )
    slide.status = "active"
    slide.save(update_fields=["status", "updated_at"])

    shared_hash = uuid.uuid4().hex
    file_for_delete = FileRecord.objects.create(
        file_name=f"stage41-batch2-delete-{suffix}.txt",
        file_key=f"private/stage41/{suffix}/delete.txt",
        file_key_hash=uuid.uuid4().hex,
        file_path=f"/tmp/stage41/{suffix}/delete.txt",
        file_size=16,
        file_type="other",
        mime_type="text/plain",
        file_extension="txt",
        file_hash=shared_hash,
        bucket_name="stage41-smoke",
        organization_id=str(valid_organization_id),
        status="completed",
        metadata={"download_url": "https://example.com/path?token=abc123"},
    )
    file_for_repair = FileRecord.objects.create(
        file_name=f"stage41-batch2-repair-{suffix}.txt",
        file_key=f"private/stage41/{suffix}/repair.txt",
        file_key_hash=uuid.uuid4().hex,
        file_path=f"/tmp/stage41/{suffix}/repair.txt",
        file_size=16,
        file_type="other",
        mime_type="text/plain",
        file_extension="txt",
        file_hash=uuid.uuid4().hex,
        bucket_name="stage41-smoke",
        organization_id=str(valid_organization_id),
        status="completed",
    )

    return {
        "table_id": str(table.id),
        "doc_id": str(doc.id),
        "doc_version_id": str(doc_version.id),
        "doc_version": doc_version.version,
        "slide_id": str(slide.id),
        "file_delete_id": str(file_for_delete.id),
        "file_repair_id": str(file_for_repair.id),
    }


def run() -> None:
    stamp = timezone.now().strftime("%Y%m%d%H%M%S")
    noise = uuid.uuid4().hex[:8]
    suffix = f"{stamp}-{noise}"

    user_no_perm, account_no_perm = _ensure_smoke_actor(
        username=f"stage41b2_no_perm_{noise}",
        email=f"stage41b2_no_perm_{noise}@example.com",
    )
    user_with_perm, account_with_perm = _ensure_smoke_actor(
        username=f"stage41b2_with_perm_{noise}",
        email=f"stage41b2_with_perm_{noise}@example.com",
    )

    AdminAccountRole.objects.filter(admin_account=account_no_perm).delete()
    AdminAccountRole.objects.filter(admin_account=account_with_perm).delete()

    smoke_role, _ = AdminRole.objects.get_or_create(
        code=f"stage41_batch2_smoke_role_{noise}",
        defaults={
            "name": "Stage41 Batch2 Smoke Role",
            "description": "Stage41 batch2 permission set",
            "is_system": False,
            "is_active": True,
        },
    )
    if not smoke_role.is_active:
        smoke_role.is_active = True
        smoke_role.save(update_fields=["is_active", "updated_at"])

    for code in SMOKE_PERMISSIONS:
        smoke_role.permissions.add(AdminPermission.objects.get(code=code))

    AdminAccountRole.objects.get_or_create(
        admin_account=account_with_perm,
        role=smoke_role,
        defaults={"reason": "stage41 batch2 smoke bind"},
    )

    resources = _prepare_resources(user_with_perm, suffix)
    no_perm_client = _make_client(user_no_perm)
    with_perm_client = _make_client(user_with_perm)

    cases = [
        SmokeCase(
            key="table_batch_archive",
            method="POST",
            url="/api/auth/admin/tables/batch/archive",
            permission="table:delete",
            body_forbidden={"table_ids": [resources["table_id"]], "dry_run": False, "reason": "x", "ticket_id": "T-1"},
            body_empty_reason={"table_ids": [resources["table_id"]], "dry_run": False, "reason": "", "ticket_id": "T-1"},
            body_success={"table_ids": [resources["table_id"]], "dry_run": False, "reason": "归档巡检", "ticket_id": "T-1"},
            expected_action="table.archive",
            expected_target_type="table",
        ),
        SmokeCase(
            key="table_batch_restore",
            method="POST",
            url="/api/auth/admin/tables/batch/restore",
            permission="table:restore",
            body_forbidden={"table_ids": [resources["table_id"]], "dry_run": False, "reason": "x", "ticket_id": "T-2"},
            body_empty_reason={"table_ids": [resources["table_id"]], "dry_run": False, "reason": "", "ticket_id": "T-2"},
            body_success={"table_ids": [resources["table_id"]], "dry_run": False, "reason": "恢复巡检", "ticket_id": "T-2"},
            expected_action="table.restore",
            expected_target_type="table",
        ),
        SmokeCase(
            key="table_batch_repair",
            method="POST",
            url="/api/auth/admin/tables/batch/search-index/repair",
            permission="table:repair",
            body_forbidden={"table_ids": [resources["table_id"]], "dry_run": False, "reason": "x", "ticket_id": "T-3"},
            body_empty_reason={"table_ids": [resources["table_id"]], "dry_run": False, "reason": "", "ticket_id": "T-3"},
            body_success={"table_ids": [resources["table_id"]], "dry_run": False, "reason": "修复索引", "ticket_id": "T-3"},
            expected_action="table.search_index.repair",
            expected_target_type="table",
        ),
        SmokeCase(
            key="doc_batch_archive",
            method="POST",
            url="/api/auth/admin/docs/batch/archive",
            permission="doc:delete",
            body_forbidden={"document_ids": [resources["doc_id"]], "dry_run": False, "reason": "x", "ticket_id": "D-1"},
            body_empty_reason={"document_ids": [resources["doc_id"]], "dry_run": False, "reason": "", "ticket_id": "D-1"},
            body_success={"document_ids": [resources["doc_id"]], "dry_run": False, "reason": "文档归档", "ticket_id": "D-1"},
            expected_action="doc.archive",
            expected_target_type="doc",
        ),
        SmokeCase(
            key="doc_batch_restore",
            method="POST",
            url="/api/auth/admin/docs/batch/restore",
            permission="doc:restore",
            body_forbidden={"document_ids": [resources["doc_id"]], "dry_run": False, "reason": "x", "ticket_id": "D-2"},
            body_empty_reason={"document_ids": [resources["doc_id"]], "dry_run": False, "reason": "", "ticket_id": "D-2"},
            body_success={"document_ids": [resources["doc_id"]], "dry_run": False, "reason": "文档恢复", "ticket_id": "D-2"},
            expected_action="doc.restore",
            expected_target_type="doc",
        ),
        SmokeCase(
            key="doc_single_archive",
            method="POST",
            url=f"/api/auth/admin/docs/{resources['doc_id']}/status/archive",
            permission="doc:delete",
            body_forbidden={"reason": "x", "ticket_id": "D-3"},
            body_empty_reason={"reason": "", "ticket_id": "D-3"},
            body_success={"reason": "单文档归档", "ticket_id": "D-3"},
            expected_action="doc.archive",
            expected_target_type="doc",
        ),
        SmokeCase(
            key="doc_single_restore",
            method="POST",
            url=f"/api/auth/admin/docs/{resources['doc_id']}/status/restore",
            permission="doc:restore",
            body_forbidden={"reason": "x", "ticket_id": "D-4"},
            body_empty_reason={"reason": "", "ticket_id": "D-4"},
            body_success={"reason": "单文档恢复", "ticket_id": "D-4"},
            expected_action="doc.restore",
            expected_target_type="doc",
        ),
        SmokeCase(
            key="doc_restore_version",
            method="POST",
            url=f"/api/auth/admin/docs/{resources['doc_id']}/restore",
            permission="doc:restore",
            body_forbidden={"version_id": resources["doc_version_id"], "reason": "x", "ticket_id": "D-5"},
            body_empty_reason={"version_id": resources["doc_version_id"], "reason": "", "ticket_id": "D-5"},
            body_success={"version_id": resources["doc_version_id"], "reason": "恢复历史版本", "ticket_id": "D-5"},
            expected_action="doc.restore_version",
            expected_target_type="doc",
        ),
        SmokeCase(
            key="slide_single_archive",
            method="POST",
            url=f"/api/auth/admin/slides/{resources['slide_id']}/status/archive",
            permission="slide:delete",
            body_forbidden={"reason": "x", "ticket_id": "S-1"},
            body_empty_reason={"reason": "", "ticket_id": "S-1"},
            body_success={"reason": "归档演示文稿", "ticket_id": "S-1"},
            expected_action="slide.archive",
            expected_target_type="slide",
        ),
        SmokeCase(
            key="slide_single_restore",
            method="POST",
            url=f"/api/auth/admin/slides/{resources['slide_id']}/status/restore",
            permission="slide:restore",
            body_forbidden={"reason": "x", "ticket_id": "S-2"},
            body_empty_reason={"reason": "", "ticket_id": "S-2"},
            body_success={"reason": "恢复演示文稿", "ticket_id": "S-2"},
            expected_action="slide.restore",
            expected_target_type="slide",
        ),
        SmokeCase(
            key="slide_batch_archive",
            method="POST",
            url="/api/auth/admin/slides/batch/archive",
            permission="slide:delete",
            body_forbidden={"slide_ids": [resources["slide_id"]], "reason": "x", "ticket_id": "S-3"},
            body_empty_reason={"slide_ids": [resources["slide_id"]], "reason": "", "ticket_id": "S-3"},
            body_success={"slide_ids": [resources["slide_id"]], "reason": "批量归档演示文稿", "ticket_id": "S-3"},
            expected_action="slide.archive",
            expected_target_type="slide",
        ),
        SmokeCase(
            key="slide_batch_restore",
            method="POST",
            url="/api/auth/admin/slides/batch/restore",
            permission="slide:restore",
            body_forbidden={"slide_ids": [resources["slide_id"]], "reason": "x", "ticket_id": "S-4"},
            body_empty_reason={"slide_ids": [resources["slide_id"]], "reason": "", "ticket_id": "S-4"},
            body_success={"slide_ids": [resources["slide_id"]], "reason": "批量恢复演示文稿", "ticket_id": "S-4"},
            expected_action="slide.restore",
            expected_target_type="slide",
        ),
        SmokeCase(
            key="asset_batch_delete",
            method="POST",
            url="/api/auth/admin/oss/files/batch/delete",
            permission="asset:delete",
            body_forbidden={"file_ids": [resources["file_delete_id"]], "dry_run": False, "reason": "x", "ticket_id": "A-1"},
            body_empty_reason={"file_ids": [resources["file_delete_id"]], "dry_run": False, "reason": "", "ticket_id": "A-1"},
            body_success={"file_ids": [resources["file_delete_id"]], "dry_run": False, "reason": "删除测试文件", "ticket_id": "A-1"},
            expected_action="asset.delete",
            expected_target_type="asset",
        ),
        SmokeCase(
            key="asset_batch_repair_organization",
            method="POST",
            url="/api/auth/admin/oss/files/batch/repair-organization",
            permission="asset:repair",
            body_forbidden={"file_ids": [resources["file_repair_id"]], "dry_run": False, "reason": "x", "ticket_id": "A-2"},
            body_empty_reason={"file_ids": [resources["file_repair_id"]], "dry_run": False, "reason": "", "ticket_id": "A-2"},
            body_success={"file_ids": [resources["file_repair_id"]], "dry_run": False, "reason": "修复归属巡检", "ticket_id": "A-2"},
            expected_action="asset.repair_organization",
            expected_target_type="asset",
        ),
    ]

    results: list[dict[str, Any]] = []

    for case in cases:
        denied_resp = _request(no_perm_client, case.method, case.url, case.body_forbidden)
        denied_payload = _json(denied_resp)
        denied_missing = _extract_missing_permission(denied_payload)

        empty_resp = _request(with_perm_client, case.method, case.url, case.body_empty_reason)
        empty_payload = _json(empty_resp)

        success_resp = _request(with_perm_client, case.method, case.url, case.body_success)
        success_payload = _json(success_resp)

        audit = (
            AdminSensitiveActionLog.objects.filter(
                action=case.expected_action,
                permission_code=case.permission,
                reason=case.body_success["reason"],
            )
            .order_by("-created_at")
            .first()
        )

        results.append(
            {
                "key": case.key,
                "url": case.url,
                "permission": case.permission,
                "denied_status": denied_resp.status_code,
                "denied_missing_permission": denied_missing,
                "empty_reason_status": empty_resp.status_code,
                "empty_reason_message": empty_payload.get("message"),
                "success_status": success_resp.status_code,
                "success_message": success_payload.get("message"),
                "audit_found": bool(audit),
                "audit_action": audit.action if audit else "",
                "audit_target_type": audit.target_type if audit else "",
                "audit_reason": audit.reason if audit else "",
                "audit_actor_admin_account": bool(audit and audit.actor_admin_account_id),
                "before_json_serializable": _bool_json_serializable(audit.before_json if audit else {}),
                "after_json_serializable": _bool_json_serializable(audit.after_json if audit else {}),
            }
        )

    asset_delete_audit = (
        AdminSensitiveActionLog.objects.filter(action="asset.delete", reason="删除测试文件")
        .order_by("-created_at")
        .first()
    )
    asset_masking_ok = False
    asset_masking_sample = {}
    if asset_delete_audit and isinstance(asset_delete_audit.before_json, dict):
        preview = ((asset_delete_audit.before_json.get("assets_preview") or [])[:1] or [{}])[0]
        masked_key = str(preview.get("masked_file_key", ""))
        masked_path = str(preview.get("masked_file_path", ""))
        masked_url = str(preview.get("masked_file_url", ""))
        asset_masking_ok = masked_key.startswith("***/") and masked_path.startswith("***/") and masked_url.endswith("/***")
        asset_masking_sample = {
            "masked_file_key": masked_key,
            "masked_file_path": masked_path,
            "masked_file_url": masked_url,
        }

    report = {
        "generated_at": timezone.now().isoformat(),
        "resource_ids": resources,
        "case_count": len(results),
        "results": results,
        "asset_masking_ok": asset_masking_ok,
        "asset_masking_sample": asset_masking_sample,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
