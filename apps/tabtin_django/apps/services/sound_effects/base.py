"""
音效搜索服务抽象基类

设计原则：
  1. 统一 SoundEffectResult 结构，各 Provider 映射后通过 to_dict 输出前端约定字段（camelCase）
  2. search 返回分页 envelope：count / next / previous / results
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class SoundEffectResult:
    """单条音效搜索结果（领域模型）"""

    id: str
    name: str
    description: str
    preview_url: str
    download_url: Optional[str] = None
    duration: Optional[float] = None
    tags: Optional[list[str]] = None
    # Freesound 等源常见扩展字段（可选）
    url: str = ""
    filesize: int = 0
    file_type: str = ""
    channels: int = 0
    bitrate: int = 0
    bitdepth: int = 0
    samplerate: int = 0
    username: str = ""
    license: str = ""
    created: str = ""
    downloads: int = 0
    rating: float = 0.0
    rating_count: int = 0
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """转为 API / 前端 SoundEffect 结构（与历史 Freesound 映射一致）"""
        try:
            api_id: int | str = int(self.id)
        except (TypeError, ValueError):
            api_id = self.id
        tags = self.tags if self.tags is not None else []
        dur = self.duration if self.duration is not None else 0
        return {
            "id": api_id,
            "name": self.name,
            "description": self.description,
            "url": self.url,
            "previewUrl": self.preview_url,
            "downloadUrl": self.download_url or "",
            "duration": dur,
            "filesize": self.filesize,
            "type": self.file_type,
            "channels": self.channels,
            "bitrate": self.bitrate,
            "bitdepth": self.bitdepth,
            "samplerate": self.samplerate,
            "username": self.username,
            "tags": tags,
            "license": self.license,
            "created": self.created,
            "downloads": self.downloads,
            "rating": self.rating,
            "ratingCount": self.rating_count,
        }


class BaseSoundEffectService(ABC):
    """音效搜索服务抽象基类"""

    def __init__(self, config: dict[str, Any] | None = None):
        self.config = config or {}
        self.provider_name: str = self.config.get("provider_name", "unknown")

    @abstractmethod
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
        """
        搜索音效库。

        Returns:
            {
                "count": int,
                "next": str | None,
                "previous": str | None,
                "results": list[dict],  # 各条为 SoundEffectResult.to_dict()
            }
        """
        ...
