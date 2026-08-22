from __future__ import annotations

import logging
from uuid import UUID

from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.users.auth.permissions import StaffAuth, SuperuserAuth
from apps.i18n.response import success_response, not_found_response
from apps.skills.models import Skill, SkillPublishedVersion

logger = logging.getLogger(__name__)

router = Router(tags=["Skills Admin"], auth=StaffAuth())


def _build_owner_name_map(owner_ids: list[str]) -> dict[str, str]:
    if not owner_ids:
        return {}
    from apps.services.billing.services import build_user_info_map
    info_map = build_user_info_map(owner_ids)
    return {uid: info["display_name"] for uid, info in info_map.items()}


def _serialize_pending_version(v: SkillPublishedVersion, *, owner_name_map: dict[str, str] | None = None) -> dict:
    skill = v.skill
    owner_id = str(skill.owner_user_id)
    return {
        "id": str(v.id),
        "skill_id": str(skill.skill_id),
        "skill_name": skill.name,
        "skill_slug": skill.slug,
        "skill_description": skill.description or "",
        "skill_emoji": skill.emoji or "",
        "owner_user_id": owner_id,
        "owner_name": (owner_name_map or {}).get(owner_id, owner_id),
        "version_seq": v.version_seq,
        "version_label": v.version_label,
        "change_note": v.change_note,
        "bundle_sha256": v.bundle_sha256,
        "bundle_oss_key": v.bundle_oss_key,
        "review_status": v.review_status,
        "reviewed_by": str(v.reviewed_by) if v.reviewed_by else None,
        "reviewed_at": v.reviewed_at.isoformat() if v.reviewed_at else None,
        "review_note": v.review_note,
        "published_by": str(v.published_by) if v.published_by else None,
        "published_at": v.published_at.isoformat() if v.published_at else None,
    }


@router.get(
    "/skills/pending-review",
    response={200: dict},
    auth=StaffAuth(),
    summary="待审核 Skill 版本队列",
)
def list_pending_review(request, page: int = 1, page_size: int = 20):
    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    qs = (
        SkillPublishedVersion.objects
        .filter(review_status=SkillPublishedVersion.REVIEW_PENDING)
        .select_related("skill")
        .order_by("published_at")
    )

    total = qs.count()
    offset = (page - 1) * page_size
    items = list(qs[offset:offset + page_size])

    owner_ids = list({str(v.skill.owner_user_id) for v in items})
    owner_name_map = _build_owner_name_map(owner_ids)

    return success_response({
        "items": [_serialize_pending_version(v, owner_name_map=owner_name_map) for v in items],
        "total": total,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total_pages": (total + page_size - 1) // page_size if total else 0,
        },
    })


@router.get(
    "/skills/{skill_id}/versions/{seq}",
    response={200: dict, 404: dict},
    auth=StaffAuth(),
    summary="单个待审版本详情",
)
def get_version_detail(request, skill_id: UUID, seq: int):
    v = (
        SkillPublishedVersion.objects
        .filter(skill_id=skill_id, version_seq=seq)
        .select_related("skill")
        .first()
    )
    if not v:
        return not_found_response("版本不存在")

    owner_name_map = _build_owner_name_map([str(v.skill.owner_user_id)])
    data = _serialize_pending_version(v, owner_name_map=owner_name_map)

    skill_md_content = None
    try:
        from apps.services.package_registry import services as pr_svc
        from apps.services.package_registry.models import PackageVersion, PackageFile
        if v.skill.package_id:
            pv = PackageVersion.objects.filter(
                package_id=v.skill.package_id, version_seq=v.version_seq,
            ).first()
            if pv:
                pf = PackageFile.objects.filter(
                    version=pv, file_path__endswith="SKILL.md",
                ).first()
                if pf and pf.oss_object_key:
                    from apps.services.oss.services.factory import get_oss_service
                    oss = get_oss_service()
                    raw = oss.download_bytes(pf.oss_object_key)
                    if raw:
                        skill_md_content = raw.decode("utf-8", errors="replace")
    except Exception:
        logger.debug("admin_api: failed to load SKILL.md for review", exc_info=True)

    data["skill_md_content"] = skill_md_content
    return success_response(data)


class ReviewActionRequest(Schema):
    review_note: str = ""


@router.post(
    "/skills/{skill_id}/versions/{seq}/approve",
    response={200: dict, 404: dict},
    auth=SuperuserAuth(),
    summary="审核通过",
)
def approve_version(request, skill_id: UUID, seq: int, payload: ReviewActionRequest | None = None):
    v = (
        SkillPublishedVersion.objects
        .filter(skill_id=skill_id, version_seq=seq)
        .select_related("skill")
        .first()
    )
    if not v:
        return not_found_response("版本不存在")
    if v.review_status != SkillPublishedVersion.REVIEW_PENDING:
        raise HttpError(400, f"当前状态为 {v.review_status}，无法审核通过")

    v.review_status = SkillPublishedVersion.REVIEW_APPROVED
    v.reviewed_by = request.auth.id
    v.reviewed_at = timezone.now()
    v.review_note = (payload.review_note if payload else "") or ""
    v.save(update_fields=["review_status", "reviewed_by", "reviewed_at", "review_note"])

    logger.info("admin_api.approved skill=%s seq=%s by=%s", skill_id, seq, request.auth.id)
    return success_response({"skill_id": str(skill_id), "version_seq": seq, "review_status": "approved"})


@router.post(
    "/skills/{skill_id}/versions/{seq}/reject",
    response={200: dict, 404: dict},
    auth=SuperuserAuth(),
    summary="审核驳回",
)
def reject_version(request, skill_id: UUID, seq: int, payload: ReviewActionRequest | None = None):
    v = (
        SkillPublishedVersion.objects
        .filter(skill_id=skill_id, version_seq=seq)
        .select_related("skill")
        .first()
    )
    if not v:
        return not_found_response("版本不存在")
    if v.review_status != SkillPublishedVersion.REVIEW_PENDING:
        raise HttpError(400, f"当前状态为 {v.review_status}，无法驳回")

    v.review_status = SkillPublishedVersion.REVIEW_REJECTED
    v.reviewed_by = request.auth.id
    v.reviewed_at = timezone.now()
    v.review_note = (payload.review_note if payload else "") or ""
    v.save(update_fields=["review_status", "reviewed_by", "reviewed_at", "review_note"])

    logger.info("admin_api.rejected skill=%s seq=%s by=%s", skill_id, seq, request.auth.id)
    return success_response({"skill_id": str(skill_id), "version_seq": seq, "review_status": "rejected"})
