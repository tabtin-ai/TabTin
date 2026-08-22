"""
桌面更新「预热 + 换短链」编排。

默认顺序：CDN 刷新/预热 →（可选）发布草稿 → 同步官网短链 → 探测 /dl/<slug>。
按平台独立执行，便于 Win 先上、Mac 后上。
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Optional
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from django.conf import settings
from django.db.models import Q

from apps.analytics.models import ShortLink
from apps.analytics.services import resolve_short_link_target
from apps.updater.models import AppRelease
from apps.updater.services.cdn_ops_service import DesktopCdnOpsService
from apps.updater.services.readiness_service import ReleaseReadinessService

logger = logging.getLogger(__name__)

DEFAULT_SHORT_LINK_SLUGS = {
    ("win", "x64"): "win-x64",
    ("mac", "x64"): "mac-x64",
    ("mac", "arm64"): "mac-arm64",
}


@dataclass
class GoLiveStepResult:
    id: str
    title: str
    ok: bool
    dry_run: bool
    detail: Any = None
    message: str = ""


@dataclass
class GoLiveResult:
    ok: bool
    dry_run: bool
    platform: str
    channel: str
    version: str
    release_ids: list[int] = field(default_factory=list)
    steps: list[GoLiveStepResult] = field(default_factory=list)
    message: str = ""

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "dry_run": self.dry_run,
            "platform": self.platform,
            "channel": self.channel,
            "version": self.version,
            "release_ids": self.release_ids,
            "message": self.message,
            "steps": [asdict(step) for step in self.steps],
        }


class DesktopGoLiveService:
    def __init__(self, *, cdn_service: Optional[DesktopCdnOpsService] = None):
        self.cdn_service = cdn_service or DesktopCdnOpsService()
        self.readiness = ReleaseReadinessService()

    def plan_or_execute(
        self,
        *,
        platform: str,
        channel: str,
        release_ids: Optional[list[int]] = None,
        dry_run: bool = True,
        do_cdn_refresh: bool = True,
        do_cdn_warmup: bool = True,
        do_publish: bool = True,
        do_short_link: bool = True,
        do_probe: bool = True,
        public_api_base: str = "",
    ) -> GoLiveResult:
        platform = str(platform or "").strip().lower()
        channel = str(channel or "").strip().lower()
        if platform not in {"win", "mac", "linux"}:
            raise ValueError("platform 无效")
        if channel not in {"stable", "beta", "alpha"}:
            raise ValueError("channel 无效")

        releases = self._resolve_releases(platform, channel, release_ids or [])
        if not releases:
            return GoLiveResult(
                ok=False,
                dry_run=dry_run,
                platform=platform,
                channel=channel,
                version="",
                message=f"未找到 {platform}/{channel} 可上线的版本（需有安装包）",
            )

        version = releases[0].version
        # 同版本多架构必须一致
        if any(item.version != version for item in releases):
            raise ValueError("所选 release 版本号不一致，请按同一版本上线")

        result = GoLiveResult(
            ok=True,
            dry_run=dry_run,
            platform=platform,
            channel=channel,
            version=version,
            release_ids=[item.id for item in releases],
        )

        # 1) readiness
        readiness_details = []
        blocking = 0
        for release in releases:
            report = self.readiness.check_release(release)
            readiness_details.append(
                {
                    "release_id": release.id,
                    "arch": release.arch,
                    "status": report.status,
                    "blocking_issue_count": report.blocking_issue_count,
                    "issues": [
                        {"code": i.code, "severity": i.severity, "message": i.message}
                        for i in (report.issues or [])
                    ],
                }
            )
            blocking += int(report.blocking_issue_count or 0)
        result.steps.append(
            GoLiveStepResult(
                id="readiness",
                title="就绪检查",
                ok=blocking == 0,
                dry_run=dry_run,
                detail=readiness_details,
                message="通过" if blocking == 0 else f"仍有 {blocking} 个阻塞项",
            )
        )
        if blocking > 0:
            result.ok = False
            result.message = "就绪检查未通过，已中止"
            return result

        # 2) CDN
        if do_cdn_refresh or do_cdn_warmup:
            if dry_run:
                urls = []
                seen = set()
                for release in releases:
                    from apps.updater.services.cdn_ops_service import collect_release_cdn_urls

                    for url in collect_release_cdn_urls(release):
                        if url not in seen:
                            seen.add(url)
                            urls.append(url)
                result.steps.append(
                    GoLiveStepResult(
                        id="cdn",
                        title="CDN 刷新/预热",
                        ok=True,
                        dry_run=True,
                        detail={
                            "mode": self.cdn_service.mode,
                            "refresh": do_cdn_refresh,
                            "warmup": do_cdn_warmup,
                            "urls": urls,
                        },
                        message=f"将处理 {len(urls)} 个 URL（mode={self.cdn_service.mode}）",
                    )
                )
            else:
                cdn_result = self.cdn_service.run(
                    releases,
                    refresh=do_cdn_refresh,
                    warmup=do_cdn_warmup,
                )
                result.steps.append(
                    GoLiveStepResult(
                        id="cdn",
                        title="CDN 刷新/预热",
                        ok=cdn_result.ok,
                        dry_run=False,
                        detail={
                            "mode": cdn_result.mode,
                            "urls": cdn_result.urls,
                            "items": [asdict(item) for item in cdn_result.items],
                        },
                        message=cdn_result.message,
                    )
                )
                if not cdn_result.ok:
                    result.ok = False
                    result.message = "CDN 操作失败，已中止后续步骤"
                    return result

        # 3) publish
        if do_publish:
            publish_detail = []
            if dry_run:
                for release in releases:
                    publish_detail.append(
                        {
                            "release_id": release.id,
                            "arch": release.arch,
                            "from_status": "draft" if release.is_draft else "published",
                            "action": "publish" if release.is_draft else "skip",
                        }
                    )
                result.steps.append(
                    GoLiveStepResult(
                        id="publish",
                        title="发布版本",
                        ok=True,
                        dry_run=True,
                        detail=publish_detail,
                        message="确认后将发布仍为草稿的版本（灰度保持原值，通常为 0%）",
                    )
                )
            else:
                for release in releases:
                    if release.is_draft:
                        release.publish()
                        release.refresh_from_db()
                        publish_detail.append(
                            {
                                "release_id": release.id,
                                "arch": release.arch,
                                "status": "published",
                                "published_at": release.published_at.isoformat()
                                if release.published_at
                                else None,
                            }
                        )
                    else:
                        publish_detail.append(
                            {
                                "release_id": release.id,
                                "arch": release.arch,
                                "status": "already_published",
                            }
                        )
                result.steps.append(
                    GoLiveStepResult(
                        id="publish",
                        title="发布版本",
                        ok=True,
                        dry_run=False,
                        detail=publish_detail,
                        message="发布完成",
                    )
                )

        # 4) short links
        if do_short_link:
            short_plan = self._build_short_link_plan(releases, channel)
            if dry_run:
                result.steps.append(
                    GoLiveStepResult(
                        id="short_link",
                        title="官网短链更换",
                        ok=True,
                        dry_run=True,
                        detail=short_plan,
                        message=f"将同步 {len(short_plan)} 条短链",
                    )
                )
            else:
                applied = self._apply_short_link_plan(short_plan)
                result.steps.append(
                    GoLiveStepResult(
                        id="short_link",
                        title="官网短链更换",
                        ok=all(item.get("ok") for item in applied),
                        dry_run=False,
                        detail=applied,
                        message="短链已更新",
                    )
                )
                if not all(item.get("ok") for item in applied):
                    result.ok = False
                    result.message = "短链更新存在失败项"
                    return result

        # 5) probe
        if do_probe and do_short_link:
            slugs = [item["slug"] for item in self._build_short_link_plan(releases, channel)]
            if dry_run:
                result.steps.append(
                    GoLiveStepResult(
                        id="probe",
                        title="短链探测",
                        ok=True,
                        dry_run=True,
                        detail={"slugs": slugs, "public_api_base": public_api_base or "(auto)"},
                        message="确认后将对 /dl/<slug> 做 302 探测",
                    )
                )
            else:
                probes = self._probe_short_links(slugs, public_api_base=public_api_base)
                result.steps.append(
                    GoLiveStepResult(
                        id="probe",
                        title="短链探测",
                        ok=all(item.get("ok") for item in probes),
                        dry_run=False,
                        detail=probes,
                        message="探测完成",
                    )
                )
                if not all(item.get("ok") for item in probes):
                    result.ok = False
                    result.message = "短链探测未全部通过"

        if result.ok and not result.message:
            result.message = "预览完成（未执行）" if dry_run else "上线步骤完成"
        return result

    def _resolve_releases(
        self,
        platform: str,
        channel: str,
        release_ids: list[int],
    ) -> list[AppRelease]:
        if release_ids:
            releases = list(
                AppRelease.objects.filter(
                    id__in=release_ids,
                    platform=platform,
                    channel=channel,
                ).order_by("arch")
            )
            missing = set(release_ids) - {item.id for item in releases}
            if missing:
                raise ValueError(f"release 不存在或不属于 {platform}/{channel}: {sorted(missing)}")
            return releases

        qs = AppRelease.objects.filter(
            platform=platform,
            channel=channel,
        ).filter(Q(file_url__gt="") | Q(website_file_url__gt=""))
        # 优先草稿；若无草稿则取最新已发布（短链仍可同步，但通常控制台只对草稿点预热）
        drafts = list(qs.filter(is_draft=True).order_by("-created_at")[:20])
        if drafts:
            version = drafts[0].version
            return list(qs.filter(is_draft=True, version=version).order_by("arch"))

        published = list(
            qs.filter(is_draft=False, deprecated_at__isnull=True).order_by("-published_at", "-created_at")[:20]
        )
        if not published:
            return []
        version = published[0].version
        return list(
            qs.filter(is_draft=False, deprecated_at__isnull=True, version=version).order_by("arch")
        )

    def _slug_for(self, platform: str, arch: str) -> str:
        override = getattr(settings, "UPDATER_SHORT_LINK_SLUG_MAP", None) or {}
        key = f"{platform}-{arch}"
        if isinstance(override, dict) and override.get(key):
            return str(override[key])
        return DEFAULT_SHORT_LINK_SLUGS.get((platform, arch), key)

    def _build_short_link_plan(self, releases: list[AppRelease], channel: str) -> list[dict]:
        plan = []
        for release in releases:
            slug = self._slug_for(release.platform, release.arch)
            # 官网获客短链：固定指向本次预热用的安装包 CDN 地址
            # （优先 website_file_url / 官网 dmg，否则 file_url / win exe）
            download_url = (release.get_download_file_url() or "").strip()
            if not download_url:
                continue
            existing = ShortLink.objects.filter(slug=slug).first()
            plan.append(
                {
                    "slug": slug,
                    "release_id": release.id,
                    "arch": release.arch,
                    "exists": bool(existing),
                    "link_id": str(existing.id) if existing else None,
                    "target_type": ShortLink.TargetType.STATIC,
                    "release_platform": release.platform,
                    "release_arch": release.arch,
                    "release_channel": channel,
                    "target_url": download_url,
                    "expected_resolved_url": download_url,
                    "name": existing.name if existing else f"Desktop {slug}",
                }
            )
        return plan

    def _apply_short_link_plan(self, plan: list[dict]) -> list[dict]:
        applied = []
        for item in plan:
            try:
                link = ShortLink.objects.filter(slug=item["slug"]).first()
                if link is None:
                    link = ShortLink(
                        slug=item["slug"],
                        name=item["name"],
                        is_active=True,
                    )
                link.name = item["name"] or link.name or item["slug"]
                link.target_type = item["target_type"]
                link.target_url = item.get("target_url") or ""
                link.release_platform = item["release_platform"]
                link.release_arch = item["release_arch"]
                link.release_channel = item["release_channel"]
                link.is_active = True
                link.save()
                resolved = resolve_short_link_target(link)
                applied.append(
                    {
                        **item,
                        "ok": True,
                        "link_id": str(link.id),
                        "resolved_url": resolved,
                    }
                )
            except Exception as exc:
                logger.exception("[GoLive] short link update failed slug=%s", item.get("slug"))
                applied.append({**item, "ok": False, "error": str(exc)})
        return applied

    def _probe_short_links(self, slugs: list[str], *, public_api_base: str = "") -> list[dict]:
        base = (public_api_base or getattr(settings, "PUBLIC_API_BASE_URL", "") or "").rstrip("/")
        if not base:
            # 相对探测：仅解析 DB 目标，不发 HTTP
            results = []
            for slug in slugs:
                link = ShortLink.objects.filter(slug=slug, is_active=True).first()
                resolved = resolve_short_link_target(link) if link else ""
                results.append(
                    {
                        "slug": slug,
                        "ok": bool(resolved),
                        "mode": "resolve_only",
                        "resolved_url": resolved,
                        "message": "未配置 PUBLIC_API_BASE_URL，仅做库内解析",
                    }
                )
            return results

        results = []
        for slug in slugs:
            url = urljoin(base + "/", f"dl/{slug}")
            try:
                request = Request(url, method="GET", headers={"User-Agent": "TabTin-GoLiveProbe/1.0"})
                with urlopen(request, timeout=20) as response:  # noqa: S310
                    # urlopen 默认跟随重定向；用最终 URL 校验
                    final_url = response.geturl()
                    status = response.status
                link = ShortLink.objects.filter(slug=slug).first()
                expected = resolve_short_link_target(link) if link else ""
                ok = status < 400 and bool(final_url)
                results.append(
                    {
                        "slug": slug,
                        "ok": ok,
                        "mode": "http",
                        "request_url": url,
                        "final_url": final_url,
                        "status": status,
                        "expected_resolved_url": expected,
                    }
                )
            except Exception as exc:
                results.append(
                    {
                        "slug": slug,
                        "ok": False,
                        "mode": "http",
                        "request_url": url,
                        "error": str(exc),
                    }
                )
        return results
