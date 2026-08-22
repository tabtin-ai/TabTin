"""
应用更新 HTTP API
提供兜底的更新检查机制
"""
import logging
from typing import Literal, Optional
from ninja import Router, Schema
from django.http import HttpRequest
from pydantic import Field

from apps.i18n.response import success_response, error_response_with_status
from apps.users.auth.permissions import JWTAuth
from .models import AppRelease, UpdateLog
from .services.query_service import UpdateQueryService
from .services.push_service import UpdatePushService

logger = logging.getLogger(__name__)
router = Router(tags=["更新管理"])

jwt_auth = JWTAuth()


# ==================== Schemas ====================

class CheckUpdateRequest(Schema):
    """检查更新请求"""
    current_version: str = Field(..., description="当前版本号")
    platform: str = Field(..., description="平台: mac/win/linux")
    arch: str = Field(default="x64", description="架构: x64/arm64")
    channel: str = Field(default="stable", description="渠道: stable/beta/alpha")
    device_id: Optional[str] = Field(None, description="设备 ID（用于灰度）")
    user_id: Optional[str] = Field(None, description="用户 ID（用于白名单）")
    trigger_source: Literal["ws_push", "http_poll", "manual"] = Field(
        default="http_poll",
        description="触发来源"
    )


class UpdateInfoResponse(Schema):
    """更新信息响应"""
    has_update: bool
    version: Optional[str] = None
    release_notes: Optional[str] = None
    release_date: Optional[str] = None
    file_url: Optional[str] = None
    feed_url: Optional[str] = None
    manifest_url: Optional[str] = None
    manifest_file: Optional[str] = None
    file_size: Optional[int] = None
    checksum: Optional[str] = None
    mandatory: bool = False
    priority: str = "normal"


class ReleaseHistoryItemResponse(Schema):
    """客户端版本历史条目。只返回客户页需要的展示字段。"""
    version: str
    platform: str
    arch: str
    channel: str
    release_notes: str
    release_notes_en: str = ""
    published_at: Optional[str] = None
    is_mandatory: bool = False
    priority: str = "normal"


class ReleaseHistoryResponse(Schema):
    """客户端版本历史响应。"""
    items: list[ReleaseHistoryItemResponse]


class ReportProgressRequest(Schema):
    """上报更新进度"""
    version: str
    status: str
    progress: float = Field(0, ge=0, le=100)
    from_version: Optional[str] = None
    device_id: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


# ==================== API Endpoints ====================

@router.post("/check", auth=None, summary="检查更新（HTTP 兜底）")
def check_update(request: HttpRequest, payload: CheckUpdateRequest):
    """
    检查是否有新版本可用

    用于 HTTP 轮询兜底机制，当 WebSocket 不可用时使用
    """
    try:
        query_service = UpdateQueryService()

        latest_release = query_service.get_latest_release(
            platform=payload.platform,
            arch=payload.arch,
            channel=payload.channel,
            current_version=payload.current_version
        )

        if not latest_release:
            logger.debug(
                f"[UpdateAPI] No update available for {payload.platform}/{payload.arch} "
                f"v{payload.current_version}"
            )
            return success_response(data=UpdateInfoResponse(has_update=False).model_dump())

        effective_user_id = str(request.auth.id) if getattr(request, "auth", None) else (payload.user_id or "")
        eligible = query_service.get_rollout_eligibility(
            release=latest_release,
            user_id=effective_user_id,
            device_id=payload.device_id
        )

        if not eligible:
            logger.debug(
                f"[UpdateAPI] Update available but not eligible (rollout): "
                f"device={payload.device_id}"
            )
            return success_response(data=UpdateInfoResponse(has_update=False).model_dump())

        mandatory = query_service.should_force_update(
            current_version=payload.current_version,
            latest_release=latest_release
        )

        UpdateLog.objects.create(
            user_id=effective_user_id or '',
            device_id=payload.device_id or '',
            from_version=payload.current_version,
            to_version=latest_release.version,
            platform=payload.platform,
            arch=payload.arch,
            channel=payload.channel,
            trigger_source=payload.trigger_source,
            status='available',
            progress=0
        )

        logger.info(
            f"[UpdateAPI] Update available: v{latest_release.version} for "
            f"{payload.platform}/{payload.arch} (current: {payload.current_version})"
        )

        return success_response(data=UpdateInfoResponse(
            has_update=True,
            version=latest_release.version,
            release_notes=latest_release.release_notes,
            release_date=latest_release.published_at.isoformat() if latest_release.published_at else None,
            file_url=latest_release.file_url,
            feed_url=latest_release.get_effective_feed_url(),
            manifest_url=latest_release.get_manifest_url(),
            manifest_file=latest_release.get_manifest_file(),
            file_size=latest_release.file_size,
            checksum=latest_release.checksum_sha256,
            mandatory=mandatory,
            priority=latest_release.priority,
        ).model_dump())
    except Exception as e:
        logger.error(f"[Updater] check_update failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/releases", auth=None, summary="获取客户端版本历史")
def list_release_history(
    request: HttpRequest,
    platform: str,
    arch: str = "x64",
    channel: str = "stable",
    limit: int = 10,
):
    """
    获取当前平台 / 架构 / 渠道的已发布版本历史。

    用于桌面端「关于与更新」页展示客户可读更新日志。该接口不返回下载源、
    manifest、checksum 等工程字段，避免把更新源细节暴露给普通客户。
    """
    try:
        normalized_limit = min(max(int(limit or 10), 1), 50)
        releases = (
            AppRelease.objects.filter(
                platform=platform,
                arch=arch,
                channel=channel,
                is_draft=False,
                published_at__isnull=False,
                deprecated_at__isnull=True,
            )
            .order_by("-published_at", "-created_at")[:normalized_limit]
        )

        items = [
            ReleaseHistoryItemResponse(
                version=release.version,
                platform=release.platform,
                arch=release.arch,
                channel=release.channel,
                release_notes=release.release_notes,
                release_notes_en=release.release_notes_en or "",
                published_at=release.published_at.isoformat() if release.published_at else None,
                is_mandatory=release.is_mandatory,
                priority=release.priority,
            ).model_dump()
            for release in releases
        ]

        return success_response(data=ReleaseHistoryResponse(items=items).model_dump())
    except Exception as e:
        logger.error(f"[Updater] list_release_history failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.post("/progress", auth=jwt_auth, summary="上报更新进度")
def report_progress(request: HttpRequest, payload: ReportProgressRequest):
    """
    客户端上报更新进度

    用于统计分析和故障排查
    """
    try:
        # 查找或创建日志记录。
        # 不能用 get_or_create：同一设备同一目标版本可能存在多条进行中记录
        # （如多次 check 各落一条 'available'），get() 会 MultipleObjectsReturned。
        in_flight_statuses = ['checking', 'available', 'downloading', 'downloaded', 'installing']
        log = (
            UpdateLog.objects.filter(
                device_id=payload.device_id or 'unknown',
                to_version=payload.version,
                status__in=in_flight_statuses,
            )
            .order_by('-started_at')
            .first()
        )

        if log is None:
            UpdateLog.objects.create(
                device_id=payload.device_id or 'unknown',
                to_version=payload.version,
                from_version=payload.from_version or '0.0.0',
                platform='unknown',
                arch='unknown',
                channel='stable',
                trigger_source='http_poll',
                status=payload.status,
                progress=payload.progress,
            )
        else:
            # 更新现有记录
            log.status = payload.status
            log.progress = payload.progress

            if payload.status == 'installed':
                log.mark_success()
            elif payload.status == 'failed':
                log.mark_failed(
                    error_code=payload.error_code or 'UNKNOWN',
                    error_message=payload.error_message or ''
                )
            else:
                log.save()

        logger.debug(
            f"[UpdateAPI] Progress reported: {payload.device_id} -> "
            f"v{payload.version} {payload.status} {payload.progress}%"
        )

        return success_response()

    except Exception as e:
        logger.error(f"[UpdateAPI] Failed to report progress: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/stats/{version}", auth=jwt_auth, summary="获取版本统计信息")
def get_version_stats(request: HttpRequest, version: str, channel: str = "stable"):
    """
    获取指定版本的统计信息

    用于 Admin 监控面板
    """
    try:
        from django.db.models import Count, Q, Avg
        from django.utils import timezone
        from datetime import timedelta

        try:
            release = AppRelease.objects.get(
                version=version,
                channel=channel
            )
        except AppRelease.DoesNotExist:
            return error_response_with_status("NOT_FOUND", message="Version not found", status_code=404)

        push_records = release.push_records.all()
        total_pushes = push_records.count()
        successful_pushes = push_records.filter(status='sent').count()

        update_logs = UpdateLog.objects.filter(to_version=version, channel=channel)
        total_updates = update_logs.count()
        successful_updates = update_logs.filter(success=True).count()
        failed_updates = update_logs.filter(success=False).count()

        downloading = update_logs.filter(status='downloading').count()
        downloaded = update_logs.filter(status='downloaded').count()
        installed = update_logs.filter(status='installed').count()

        avg_duration = update_logs.filter(
            download_duration_ms__isnull=False
        ).aggregate(Avg('download_duration_ms'))['download_duration_ms__avg']

        platform_dist = update_logs.values('platform').annotate(
            count=Count('id')
        ).order_by('-count')

        day_ago = timezone.now() - timedelta(days=1)
        recent_updates = update_logs.filter(started_at__gte=day_ago).count()

        return success_response(data={
            "version": version,
            "channel": channel,
            "release_info": {
                "published_at": release.published_at.isoformat() if release.published_at else None,
                "is_mandatory": release.is_mandatory,
                "priority": release.priority,
                "rollout_percentage": release.rollout_percentage,
            },
            "push_stats": {
                "total_pushes": total_pushes,
                "successful_pushes": successful_pushes,
            },
            "update_stats": {
                "total_attempts": total_updates,
                "successful": successful_updates,
                "failed": failed_updates,
                "success_rate": round(successful_updates / total_updates * 100, 2) if total_updates > 0 else 0,
            },
            "progress_breakdown": {
                "downloading": downloading,
                "downloaded": downloaded,
                "installed": installed,
            },
            "performance": {
                "avg_download_duration_ms": int(avg_duration) if avg_duration else None,
            },
            "platform_distribution": list(platform_dist),
            "recent_24h_updates": recent_updates,
        })
    except Exception as e:
        logger.error(f"[Updater] get_version_stats failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/latest-versions", auth=None, summary="获取所有平台的最新版本")
def get_latest_versions(request: HttpRequest, channel: str = "stable"):
    """
    获取所有平台的最新版本信息

    用于客户端快速检查或监控面板
    """
    try:
        query_service = UpdateQueryService()
        results = {}

        for platform in ['mac', 'win', 'linux']:
            for arch in ['x64', 'arm64']:
                release = query_service.get_latest_release(
                    platform=platform,
                    arch=arch,
                    channel=channel
                )
                if release:
                    key = f"{platform}_{arch}"
                    results[key] = {
                        "version": release.version,
                        "published_at": release.published_at.isoformat() if release.published_at else None,
                        "file_url": release.file_url,
                        "file_size": release.file_size,
                        "is_mandatory": release.is_mandatory,
                        "priority": release.priority,
                    }

        return success_response(data=results)
    except Exception as e:
        logger.error(f"[Updater] get_latest_versions failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)
