from __future__ import annotations

import hashlib
import hmac
import logging
from dataclasses import dataclass
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.tabtinspace.models import Organization, OrganizationMember

from .client import FeishuAPIError, FeishuClient
from .constants import (
    IMPORT_INTERRUPTED_BY_PROVIDER_REAUTHENTICATION,
    IMPORT_INTERRUPTED_REASON_PROVIDER_REAUTHENTICATED,
)
from .models import FeishuImportJob, FeishuOAuthConnection, FeishuOAuthProvider

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FeishuProviderError(Exception):
    code: str
    message: str
    status_code: int


def _membership(user, organization_id: UUID) -> OrganizationMember:
    member = OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=user.id,
    ).first()
    if member is None:
        raise FeishuProviderError("forbidden", "无权访问该 Organization", 403)
    return member


def _can_manage(member: OrganizationMember) -> bool:
    return member.role in {"owner", "admin"}


def _serialize_provider(
    provider: FeishuOAuthProvider | None,
    *,
    can_manage: bool,
) -> dict:
    return {
        "configured": provider is not None,
        "can_manage": can_manage,
        "app_id": provider.app_id if provider is not None and can_manage else None,
        "status": provider.status if provider is not None else None,
        "verified_at": (
            provider.verified_at.isoformat()
            if provider is not None and provider.verified_at is not None
            else None
        ),
    }


def get_provider(user, organization_id: UUID) -> dict:
    member = _membership(user, organization_id)
    provider = FeishuOAuthProvider.objects.filter(organization_id=organization_id).first()
    return _serialize_provider(provider, can_manage=_can_manage(member))


def get_active_provider(organization_id: UUID) -> FeishuOAuthProvider:
    provider = FeishuOAuthProvider.objects.filter(
        organization_id=organization_id,
        status=FeishuOAuthProvider.Status.ACTIVE,
    ).first()
    if provider is None:
        raise FeishuProviderError(
            "provider_not_configured",
            "组织尚未配置飞书企业自建应用",
            409,
        )
    return provider


def client_for_provider(provider: FeishuOAuthProvider) -> FeishuClient:
    return FeishuClient(app_id=provider.app_id, app_secret=provider.app_secret)


def lock_provider_guard(organization_id: UUID) -> None:
    """锁定组织级 Provider 操作序列，覆盖 Provider 尚未创建/已删除的窗口。"""
    Organization.objects.select_for_update().only("id").get(id=organization_id)


def _secret_fingerprint(app_secret: str) -> str:
    return hashlib.sha256(app_secret.encode("utf-8")).hexdigest()


def _revoke_import_tasks(task_ids: tuple[str, ...]) -> None:
    from celery import current_app

    for task_id in task_ids:
        try:
            current_app.control.revoke(task_id, terminate=True)
        except Exception:
            logger.exception(
                "[FeishuProvider] failed to revoke interrupted import task_id=%s",
                task_id,
            )


def _interrupt_active_imports(organization_id: UUID) -> int:
    jobs = list(
        FeishuImportJob.objects.select_for_update().filter(
            organization_id=organization_id,
            status__in=[
                FeishuImportJob.Status.PENDING,
                FeishuImportJob.Status.RUNNING,
            ],
        ),
    )
    if not jobs:
        return 0

    now = timezone.now()
    task_ids = []
    for job in jobs:
        result = dict(job.result or {})
        result["phase"] = "interrupted"
        result["interrupted_reason"] = (
            IMPORT_INTERRUPTED_REASON_PROVIDER_REAUTHENTICATED
        )
        job.status = FeishuImportJob.Status.FAILED
        job.error = IMPORT_INTERRUPTED_BY_PROVIDER_REAUTHENTICATION
        job.result = result
        job.updated_at = now
        if job.celery_task_id:
            task_ids.append(job.celery_task_id)

    FeishuImportJob.objects.bulk_update(
        jobs,
        ["status", "error", "result", "updated_at"],
    )
    if task_ids:
        transaction.on_commit(
            lambda ids=tuple(task_ids): _revoke_import_tasks(ids),
        )
    logger.info(
        "[FeishuProvider] interrupted active imports for provider reauthentication "
        "organization_id=%s jobs=%d revocable_tasks=%d",
        organization_id,
        len(jobs),
        len(task_ids),
    )
    return len(jobs)


def resolve_oauth_provider(
    *,
    organization_id: UUID,
    provider_id: UUID,
    expected_app_id: str,
    expected_credential_version: int,
    for_update: bool = False,
) -> FeishuOAuthProvider:
    providers = FeishuOAuthProvider.objects
    if for_update:
        providers = providers.select_for_update()
    provider = providers.filter(
        id=provider_id,
        organization_id=organization_id,
        status=FeishuOAuthProvider.Status.ACTIVE,
    ).first()
    if (
        provider is None
        or provider.app_id != expected_app_id
        or provider.credential_version != expected_credential_version
    ):
        raise FeishuProviderError(
            "provider_invalid",
            "飞书应用配置已变更，请重新发起授权",
            409,
        )
    return provider


def bind_provider_tenant(provider: FeishuOAuthProvider, tenant_key: str) -> None:
    normalized_tenant_key = tenant_key.strip()
    if not normalized_tenant_key:
        raise FeishuProviderError("provider_invalid", "飞书未返回企业标识", 400)
    with transaction.atomic():
        locked = FeishuOAuthProvider.objects.select_for_update().get(id=provider.id)
        if locked.tenant_key and locked.tenant_key != normalized_tenant_key:
            raise FeishuProviderError(
                "provider_invalid",
                "该飞书应用不属于当前已绑定企业",
                409,
            )
        if not locked.tenant_key:
            locked.tenant_key = normalized_tenant_key
            locked.save(update_fields=["tenant_key", "updated_at"])
            provider.tenant_key = normalized_tenant_key


def configure_provider(
    user,
    *,
    organization_id: UUID,
    app_id: str,
    app_secret: str,
) -> dict:
    member = _membership(user, organization_id)
    if not _can_manage(member):
        raise FeishuProviderError("forbidden", "仅组织 Owner 或 Admin 可配置飞书应用", 403)

    normalized_app_id = app_id.strip()
    normalized_secret = app_secret.strip()
    if not normalized_app_id or not normalized_secret:
        raise FeishuProviderError("provider_invalid", "App ID 和 App Secret 不能为空", 400)

    try:
        validation = FeishuClient().validate_tenant_credentials(
            normalized_app_id,
            normalized_secret,
        )
    except FeishuAPIError as exc:
        raise FeishuProviderError("provider_invalid", "飞书应用凭证校验失败", 400) from exc
    if not validation.get("tenant_access_token"):
        raise FeishuProviderError("provider_invalid", "飞书应用凭证校验失败", 400)

    new_fingerprint = _secret_fingerprint(normalized_secret)

    with transaction.atomic():
        lock_provider_guard(organization_id)
        provider = (
            FeishuOAuthProvider.objects.select_for_update()
            .filter(organization_id=organization_id)
            .first()
        )
        app_id_changed = provider is not None and provider.app_id != normalized_app_id
        old_fingerprint = ""
        if provider is not None:
            old_fingerprint = provider.secret_fingerprint or _secret_fingerprint(
                provider.app_secret,
            )
        credentials_changed = provider is not None and (
            app_id_changed
            or not hmac.compare_digest(old_fingerprint, new_fingerprint)
        )
        _interrupt_active_imports(organization_id)

        if provider is None:
            provider = FeishuOAuthProvider(
                organization_id=organization_id,
                created_by=user,
            )
        elif app_id_changed:
            # 更换应用后，原用户令牌全部由旧 App 签发，不能再继续使用。
            FeishuOAuthConnection.objects.filter(organization_id=organization_id).delete()
            provider.tenant_key = ""
        elif credentials_changed:
            FeishuOAuthConnection.objects.filter(
                organization_id=organization_id,
            ).update(
                status=FeishuOAuthConnection.Status.REAUTHORIZATION_REQUIRED,
                tokens={},
                expires_at=None,
                refresh_token_expires_at=None,
                granted_scopes=[],
                updated_at=timezone.now(),
            )

        if credentials_changed:
            provider.credential_version += 1

        provider.app_id = normalized_app_id
        provider.credentials = {"app_secret": normalized_secret}
        provider.secret_fingerprint = new_fingerprint
        provider.status = FeishuOAuthProvider.Status.ACTIVE
        provider.verified_at = timezone.now()
        provider.updated_by = user
        provider.save()

    return _serialize_provider(provider, can_manage=True)


def delete_provider(user, organization_id: UUID) -> dict:
    member = _membership(user, organization_id)
    if not _can_manage(member):
        raise FeishuProviderError("forbidden", "仅组织 Owner 或 Admin 可移除飞书应用", 403)
    with transaction.atomic():
        lock_provider_guard(organization_id)
        provider = (
            FeishuOAuthProvider.objects.select_for_update()
            .filter(organization_id=organization_id)
            .first()
        )
        if _has_active_imports(organization_id):
            raise FeishuProviderError("provider_busy", "有飞书导入任务正在运行，请稍后重试", 409)
        # 显式按组织清理，覆盖尚未绑定 provider_id 的早期连接数据。
        FeishuOAuthConnection.objects.filter(organization_id=organization_id).delete()
        deleted = 0
        if provider is not None:
            deleted, _ = provider.delete()
    return {"deleted": bool(deleted)}


def _has_active_imports(organization_id: UUID) -> bool:
    return FeishuImportJob.objects.filter(
        organization_id=organization_id,
        status__in=[FeishuImportJob.Status.PENDING, FeishuImportJob.Status.RUNNING],
    ).exists()
