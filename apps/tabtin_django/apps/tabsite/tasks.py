"""
TabSite Celery 异步任务

任务清单:
  1. compensate_file_usage_sync — DVC-003/DVC-004: on_commit 失败后的 FileUsage 补偿
  2. reconcile_site_file_usages — DVC-003: 周期性扫描已发布站点，修复遗漏的 FileUsage
"""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)

TABSITE_BEAT_SCHEDULE = {
    "tabsite-reconcile-file-usages": {
        "task": "tabsite.reconcile_site_file_usages",
        "schedule": 3600,
        "options": {"queue": "default"},
    },
}


@shared_task(
    name="tabsite.compensate_file_usage_sync",
    bind=True,
    max_retries=5,
    default_retry_delay=60,
    acks_late=True,
)
def compensate_file_usage_sync(
    self,
    *,
    site_id: str,
    old_version_num: int | None,
    new_dist_url: str,
    total_size: int,
    version_num: int,
    user_id: str,
) -> dict:
    """DVC-003/DVC-004: FileUsage 同步补偿任务。

    on_commit 回调内 deactivate/register 失败时调度。
    幂等设计：register_uploaded_file → add_usage 使用 get_or_create。
    """
    from apps.tabsite.models import Site

    try:
        site = Site.objects.get(id=site_id)
    except Site.DoesNotExist:
        logger.warning("[TabSite][compensate] site %s 已删除，跳过补偿", site_id)
        return {"status": "skipped", "reason": "site_not_found"}

    from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
    from apps.services.oss.services.file_registry import FileRegistryService
    from apps.tabsite.services.site_service import SiteService
    from urllib.parse import urlparse

    organization_id = str(getattr(site, 'organization_id', '') or '')

    try:
        if old_version_num is not None:
            versioned_old = SiteService._versioned_context_id(site_id, old_version_num)
            deactivate_file_usages_and_release_storage(
                module='tabsite',
                context_filter={'context_type': 'site_dist', 'context_id': versioned_old},
                organization_id=organization_id,
                user_id=user_id,
                biz_type='site_dist_deactivate_compensate',
                biz_id=versioned_old,
                log_prefix='[TabSite][compensate]',
            )
            deactivate_file_usages_and_release_storage(
                module='tabsite',
                context_filter={'context_type': 'site_dist', 'context_id': site_id},
                organization_id=organization_id,
                user_id=user_id,
                biz_type='site_dist_deactivate_compensate',
                biz_id=site_id,
                log_prefix='[TabSite][compensate][compat]',
            )

        parsed = urlparse(new_dist_url)
        object_key = parsed.path.lstrip("/") if parsed.path else ""
        if object_key:
            versioned_new = SiteService._versioned_context_id(site_id, version_num)
            FileRegistryService.register_uploaded_file(
                object_key=object_key,
                file_name=f"site-{site.slug}-v{version_num}-dist",
                file_size=total_size,
                content_type="application/x-site-dist",
                module='tabsite',
                user_id=user_id,
                organization_id=organization_id,
                context_type='site_dist',
                context_id=versioned_new,
                upload_source='site_publish_compensate',
                is_public=True,
            )

        logger.info("[TabSite][compensate] 补偿成功: site=%s, v%d", site_id, version_num)
        return {"status": "ok", "site_id": site_id, "version": version_num}

    except Exception as exc:
        logger.error(
            "[TabSite][compensate] 补偿失败 (retry=%d/%d): site=%s, v%d, error=%s",
            self.request.retries, self.max_retries, site_id, version_num, exc,
            exc_info=True,
        )
        raise self.retry(exc=exc)


@shared_task(name="tabsite.reconcile_site_file_usages")
def reconcile_site_file_usages() -> dict:
    """DVC-003: 周期性安全网 — 扫描所有已发布站点，为缺失 FileUsage 的当前版本补注册。

    覆盖 on_commit 未执行的边界场景（进程 OOM/部署重启）。
    """
    from apps.tabsite.models import Site
    from apps.services.oss.models import FileUsage
    from apps.tabsite.services.site_service import SiteService

    fixed = 0
    errors = 0
    sites = Site.objects.filter(status='published').exclude(dist_oss_url='')

    for site in sites.iterator():
        site_id_str = str(site.id)
        versioned_ctx = SiteService._versioned_context_id(site_id_str, site.current_version)

        has_new_format = FileUsage.objects.filter(
            module='tabsite',
            context_type='site_dist',
            context_id=versioned_ctx,
            is_active=True,
        ).exists()

        has_old_format = FileUsage.objects.filter(
            module='tabsite',
            context_type='site_dist',
            context_id=site_id_str,
            is_active=True,
        ).exists()

        if has_new_format or has_old_format:
            continue

        try:
            compensate_file_usage_sync.apply_async(
                kwargs={
                    'site_id': site_id_str,
                    'old_version_num': None,
                    'new_dist_url': site.dist_oss_url,
                    'total_size': 0,
                    'version_num': site.current_version,
                    'user_id': str(getattr(site, 'owner_id', '') or ''),
                },
            )
            fixed += 1
            logger.info("[TabSite][reconcile] 发现缺失 FileUsage: site=%s, v%d", site.id, site.current_version)
        except Exception as e:
            errors += 1
            logger.error("[TabSite][reconcile] 补偿调度失败: site=%s, error=%s", site.id, e)

    result = {"checked": sites.count(), "fixed": fixed, "errors": errors}
    if fixed or errors:
        logger.info("[TabSite][reconcile] 完成: %s", result)
    return result
