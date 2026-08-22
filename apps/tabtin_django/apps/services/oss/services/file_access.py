"""Authorization and current accessible URL resolution for FileRecord."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Callable

from django.utils import timezone

from .factory import get_oss_service
from .public_assets import build_public_asset_url

if TYPE_CHECKING:
    from apps.services.oss.models import FileRecord


DEFAULT_FILE_ACCESS_TTL_SECONDS = 6 * 60 * 60


class FileAccessNotFound(Exception):
    """The caller must observe the file as nonexistent."""


@dataclass(frozen=True)
class AccessibleFile:
    url: str
    access_mode: str
    expires_at: datetime | None
    expires_in: int | None


def is_organization_member(user: Any, organization_id: str) -> bool:
    """Fail closed when a FileRecord has an organization boundary."""
    if not user or not organization_id:
        return False
    try:
        from apps.tabtinspace.models import OrganizationMember

        return OrganizationMember.objects.filter(
            organization_id=organization_id,
            user_id=user.id,
        ).exists()
    except Exception:
        return False


def authorize_file_access(
    file_record: FileRecord,
    user: Any,
    *,
    membership_checker: Callable[[Any, str], bool] | None = None,
    business_access_checker: Callable[[FileRecord, Any], bool] | None = None,
) -> None:
    """Preserve the OSS API's existing read policy without existence leaks."""
    checker = membership_checker or is_organization_member
    if file_record.organization_id and not checker(user, file_record.organization_id):
        raise FileAccessNotFound

    user_id = str(getattr(user, "id", ""))
    if not file_record.is_public and file_record.upload_user != user_id:
        if business_access_checker is None or not business_access_checker(file_record, user):
            raise FileAccessNotFound


def resolve_file_access(
    file_record: FileRecord,
    user: Any,
    *,
    expiration: int = DEFAULT_FILE_ACCESS_TTL_SECONDS,
    oss_service=None,
    membership_checker: Callable[[Any, str], bool] | None = None,
    business_access_checker: Callable[[FileRecord, Any], bool] | None = None,
) -> AccessibleFile:
    """Authorize and resolve the URL that is usable at response time.

    Persistent ``access_url`` and ``cdn_url`` remain storage metadata. Private
    responses always use a fresh signed GET URL and never expose those values.
    """
    authorize_file_access(
        file_record,
        user,
        membership_checker=membership_checker,
        business_access_checker=business_access_checker,
    )

    return resolve_authorized_file(
        file_record,
        expiration=expiration,
        oss_service=oss_service,
    )


def resolve_authorized_file(
    file_record: FileRecord,
    *,
    expiration: int = DEFAULT_FILE_ACCESS_TTL_SECONDS,
    oss_service=None,
) -> AccessibleFile:
    """Deliver a FileRecord after its owning business domain authorized access.

    TabData and TabDoc bind files to records/documents and own their respective
    member/share policies.  This lower layer deliberately performs no business
    authorization; it only preserves legacy public URLs and signs private GETs.
    """

    if file_record.is_public:
        stable_url = (
            file_record.access_url
            or build_public_asset_url(file_record.file_key)
            or file_record.cdn_url
        )
        return AccessibleFile(
            url=stable_url,
            access_mode="public",
            expires_at=None,
            expires_in=None,
        )

    ttl = max(1, min(int(expiration), 86400))
    service = oss_service or get_oss_service()
    signed_url = service.generate_presigned_url(
        file_record.file_key,
        expiration=ttl,
        method="GET",
    )
    return AccessibleFile(
        url=signed_url,
        access_mode="signed",
        expires_at=timezone.now() + timedelta(seconds=ttl),
        expires_in=ttl,
    )
