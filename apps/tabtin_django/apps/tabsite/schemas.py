"""TabSite 模块 Pydantic Schemas"""

from __future__ import annotations

import os
import posixpath
import re
import uuid as _uuid
from typing import List, Literal, Optional

from ninja import Schema
from pydantic import Field, validator


def _validate_uuid(value: str) -> str:
    _uuid.UUID(value)
    return value


def _normalize_file_path(value: str) -> str:
    """规范化文件路径，拒绝路径遍历攻击。"""
    normalized = posixpath.normpath(value)
    if normalized.startswith('..') or '/../' in normalized or normalized.startswith('/'):
        raise ValueError("文件路径含非法组件")
    if not normalized or normalized == '.':
        raise ValueError("文件路径不能为空")
    return normalized


def _validate_safe_path(value: str) -> str:
    """校验 code_project_path，拒绝路径遍历。允许绝对路径（Electron 场景天然需要）。"""
    normalized = os.path.normpath(value)
    parts = normalized.replace('\\', '/').split('/')
    if '..' in parts:
        raise ValueError("路径不允许包含 '..' 组件")
    return normalized


def _validate_domain(value: str) -> str:
    """校验域名格式（不含协议和路径）。"""
    if '://' in value:
        raise ValueError("域名不应包含协议前缀")
    if '/' in value:
        raise ValueError("域名不应包含路径")
    domain_re = re.compile(
        r'^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
    )
    if not domain_re.match(value):
        raise ValueError("域名格式不合法")
    return value.lower()


# ─── 请求 Schemas ────────────────────────────────────────


class SiteCreateRequest(Schema):
    organization_id: str
    space_id: str
    name: str = Field(default="未命名站点", max_length=255)
    description: str = Field(default="", max_length=5000)
    framework: Literal["react", "vanilla"] = "react"
    template: Literal["blank", "dashboard"] = "blank"

    _v_organization = validator("organization_id", allow_reuse=True, pre=True)(_validate_uuid)
    _v_space = validator("space_id", allow_reuse=True, pre=True)(_validate_uuid)


class SiteUpdateRequest(Schema):
    name: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = Field(default=None, max_length=5000)
    icon: Optional[str] = Field(default=None, max_length=50)
    is_public: Optional[bool] = None
    password: Optional[str] = None
    custom_domain: Optional[str] = Field(default=None, max_length=255)
    code_project_path: Optional[str] = Field(default=None, max_length=1024)
    tabdata_table_ids: Optional[List[str]] = None
    tabdata_token_id: Optional[str] = None

    @validator("code_project_path", pre=True)
    def validate_code_project_path(cls, v):
        if v is None:
            return v
        return _validate_safe_path(v)

    @validator("custom_domain", pre=True)
    def validate_custom_domain(cls, v):
        if v is None or v == "":
            return v
        return _validate_domain(v)

    @validator("tabdata_table_ids", pre=True)
    def validate_table_ids(cls, v):
        if v is None:
            return v
        for item in v:
            _validate_uuid(item)
        return v


class SitePublishRequest(Schema):
    message: str = ""
    dist_url: str
    file_count: int = Field(default=0, ge=0)
    total_size: int = Field(default=0, ge=0)


MAX_FILE_CONTENT_SIZE = 2 * 1024 * 1024  # 2 MB


class SiteFileWriteRequest(Schema):
    path: str = Field(max_length=500)
    content: str = Field(max_length=MAX_FILE_CONTENT_SIZE)
    content_type: str = "text/html"

    @validator("path")
    def normalize_path(cls, v):
        return _normalize_file_path(v)


# ─── 响应 Schemas ────────────────────────────────────────


class SiteSummary(Schema):
    id: str
    organization_id: str = ""
    name: str
    slug: str
    description: str = ""
    icon: str = ""
    framework: str = "react"
    status: str = "draft"
    published_url: str = ""
    current_version: int = 0
    total_views: int = 0
    is_public: bool = True
    template: str = ""
    version_count: int = 0
    created_at: str
    updated_at: str


class SiteVersionOut(Schema):
    id: str
    version: int
    message: str = ""
    dist_url: str
    file_count: int = 0
    total_size: int = 0
    is_current: bool = False
    created_at: str


class SiteFileOut(Schema):
    id: str
    path: str
    content_type: str = "text/html"
    file_size: int = 0
    updated_at: str


class SiteDetail(SiteSummary):
    dist_oss_url: str = ""
    password_protected: bool = False
    custom_domain: str = ""
    code_project_path: str = ""
    tabdata_table_ids: List[str] = Field(default_factory=list)
    tabdata_token_id: str = ""
    versions: List[SiteVersionOut] = Field(default_factory=list)
    files: List[SiteFileOut] = Field(default_factory=list)
