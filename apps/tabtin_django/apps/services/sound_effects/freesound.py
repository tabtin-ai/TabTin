"""
Freesound API 代理客户端

代理前端对 Freesound 音效库的搜索请求，避免在客户端暴露 API Key。
使用 Django cache（Redis）缓存热门查询，降低对 Freesound 的请求频率。

Freesound API 文档: https://freesound.org/docs/api/
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

import requests
from django.conf import settings
from django.core.cache import cache

from .base import BaseSoundEffectService, SoundEffectResult

logger = logging.getLogger(__name__)

FREESOUND_API_BASE = "https://freesound.org/apiv2"
CACHE_TTL_SECONDS = 3600  # 1 hour
CACHE_KEY_PREFIX = "freesound:"


def _get_api_key() -> str | None:
    return getattr(settings, "FREESOUND_API_KEY", None)


def _build_cache_key(params: dict[str, Any]) -> str:
    sorted_items = sorted(params.items())
    raw = "&".join(f"{k}={v}" for k, v in sorted_items if v)
    digest = hashlib.md5(raw.encode()).hexdigest()  # noqa: S324
    return f"{CACHE_KEY_PREFIX}{digest}"


def _raw_to_result(raw: dict[str, Any]) -> SoundEffectResult:
    """将 Freesound API 单条 JSON 转为 SoundEffectResult。"""
    previews = raw.get("previews", {}) or {}
    preview_url = (
        previews.get("preview-hq-mp3") or previews.get("preview-lq-mp3") or ""
    )
    sound_id = raw.get("id")
    sid = "" if sound_id is None else str(sound_id)
    tags = raw.get("tags")
    if tags is None:
        tags_list: list[str] | None = None
    elif isinstance(tags, list):
        tags_list = [str(t) for t in tags]
    else:
        tags_list = [str(tags)]

    duration_val = raw.get("duration")
    duration: float | None
    if duration_val is None:
        duration = None
    else:
        try:
            duration = float(duration_val)
        except (TypeError, ValueError):
            duration = None

    return SoundEffectResult(
        id=sid,
        name=str(raw.get("name", "") or ""),
        description=str(raw.get("description", "") or ""),
        preview_url=str(preview_url or ""),
        download_url=str(raw.get("download", "") or "") or None,
        duration=duration,
        tags=tags_list,
        url=str(raw.get("url", "") or ""),
        filesize=int(raw.get("filesize", 0) or 0),
        file_type=str(raw.get("type", "") or ""),
        channels=int(raw.get("channels", 0) or 0),
        bitrate=int(raw.get("bitrate", 0) or 0),
        bitdepth=int(raw.get("bitdepth", 0) or 0),
        samplerate=int(raw.get("samplerate", 0) or 0),
        username=str(raw.get("username", "") or ""),
        license=str(raw.get("license", "") or ""),
        created=str(raw.get("created", "") or ""),
        downloads=int(raw.get("num_downloads", 0) or 0),
        rating=float(raw.get("avg_rating", 0) or 0),
        rating_count=int(raw.get("num_ratings", 0) or 0),
        raw=dict(raw),
    )


def _map_sound(raw: dict[str, Any]) -> dict[str, Any]:
    """将 Freesound API 返回的单条结果映射为前端 SoundEffect 结构（向后兼容）。"""
    return _raw_to_result(raw).to_dict()


class FreesoundService(BaseSoundEffectService):
    """Freesound 音效搜索实现"""

    def search(
        self,
        query: str = "",
        page: int = 1,
        page_size: int = 15,
        *,
        sort: str = "score",
        filter_str: str = "",
        commercial_only: bool = False,
    ) -> dict[str, Any]:
        api_key = _get_api_key()
        if not api_key:
            logger.warning("FREESOUND_API_KEY 未配置，返回空结果")
            return {"count": 0, "next": None, "previous": None, "results": []}

        params: dict[str, Any] = {
            "token": api_key,
            "page": page,
            "page_size": min(page_size, 50),
            "sort": sort,
            "fields": (
                "id,name,description,url,previews,download,duration,filesize,"
                "type,channels,bitrate,bitdepth,samplerate,username,tags,"
                "license,created,num_downloads,avg_rating,num_ratings"
            ),
        }

        if query:
            params["query"] = query

        fs_filter_parts = []
        if commercial_only:
            fs_filter_parts.append(
                'license:"Attribution" OR license:"Creative Commons 0"'
            )
        if filter_str:
            fs_filter_parts.append(filter_str)
        if fs_filter_parts:
            params["filter"] = " ".join(fs_filter_parts)

        cache_key = _build_cache_key(params)
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        try:
            resp = requests.get(
                f"{FREESOUND_API_BASE}/search/text/",
                params=params,
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as exc:
            logger.error("Freesound API 请求失败: %s", exc)
            return {"count": 0, "next": None, "previous": None, "results": []}

        result = {
            "count": data.get("count", 0),
            "next": data.get("next"),
            "previous": data.get("previous"),
            "results": [_map_sound(s) for s in data.get("results", [])],
        }

        cache.set(cache_key, result, CACHE_TTL_SECONDS)
        return result


def search_sounds(
    *,
    query: str = "",
    page: int = 1,
    page_size: int = 15,
    sort: str = "score",
    filter_str: str = "",
    commercial_only: bool = False,
) -> dict[str, Any]:
    """
    搜索 Freesound 音效（模块级便捷函数，与历史调用方式兼容）。

    等价于 ``get_sound_effect_service("freesound").search(...)``。
    """
    from .factory import get_sound_effect_service

    return get_sound_effect_service(provider="freesound").search(
        query=query,
        page=page,
        page_size=page_size,
        sort=sort,
        filter_str=filter_str,
        commercial_only=commercial_only,
    )
