"""
WebSocket 更新推送协议定义
"""
from typing import Literal, Optional
from pydantic import BaseModel, Field


class UpdateAvailablePayload(BaseModel):
    """服务端 → 客户端: 新版本可用通知"""
    version: str = Field(..., description="新版本号")
    platform: Literal["mac", "win", "linux"]
    arch: Literal["x64", "arm64"] = "x64"
    channel: Literal["stable", "beta", "alpha"] = "stable"

    file_url: str = Field(..., description="下载地址")
    feed_url: Optional[str] = Field(default=None, description="更新源目录地址")
    manifest_url: Optional[str] = Field(default=None, description="更新源 manifest 地址")
    manifest_file: Optional[str] = Field(default=None, description="更新源 manifest 文件名")
    file_size: int = Field(..., description="文件大小(字节)")
    checksum: str = Field(..., description="SHA256 校验和")

    release_notes: str = Field(default="", description="更新日志")
    release_notes_en: str = Field(default="", description="English release notes")
    release_date: str = Field(..., description="发布时间 ISO8601")

    mandatory: bool = Field(default=False, description="是否强制更新")
    silent: bool = Field(default=False, description="是否静默下载")
    priority: Literal["low", "normal", "high", "critical"] = "normal"

    # 灰度控制
    rollout_percentage: int = Field(100, ge=0, le=100, description="灰度比例")


class UpdateProgressPayload(BaseModel):
    """客户端 → 服务端: 更新进度上报"""
    version: str
    status: Literal[
        "checking",
        "available",
        "downloading",
        "downloaded",
        "installing",
        "installed",
        "failed",
        "skipped"
    ]
    progress: float = Field(0, ge=0, le=100, description="进度百分比")
    error_code: Optional[str] = None
    error_message: Optional[str] = None

    # 客户端元数据
    from_version: Optional[str] = None
    trigger_source: Optional[Literal["ws_push", "http_poll", "manual"]] = None
