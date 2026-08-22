"""
TabMemo 模块 Pydantic Schemas（Django Ninja 用）

包含请求/响应 Schema，涵盖：
  - Memo CRUD
  - Collection CRUD
  - 附件
  - URL 书签预览
"""

from __future__ import annotations

import re
import uuid as _uuid
from typing import Any, Dict, List, Literal, Optional

from ninja import Schema
from pydantic import Field, field_validator, model_validator, validator


def _validate_uuid(value: str) -> str:
    _uuid.UUID(value)
    return value


# ─── 常量 ────────────────────────────────────────────────

# BC-32: 与 Memo.Color 模型保持一致
COLOR_CHOICES = {"", "yellow", "blue", "green", "pink", "purple", "orange", "gray"}

# BC-33: 附件文件类型枚举
FILE_TYPE_CHOICES = {"", "image", "file", "video", "audio"}

# URL 格式预检正则（BC-34）
_URL_PATTERN = re.compile(r"^https?://", re.IGNORECASE)


# ─── 请求 Schemas ────────────────────────────────────────


MEMO_SOURCES = Literal["manual", "browser", "share", "api", "agent", "voice"]
MEMO_TYPES = Literal["note", "bookmark", "about_you", "insight", "task_summary", "diary"]


class MemoCreateRequest(Schema):
    organization_id: str
    space_id: Optional[str] = None  # 可选，None 表示个人碎片
    agent_id: Optional[str] = None
    content_json: Dict[str, Any] = Field(default_factory=dict)
    content_markdown: str = ""
    tags: List[str] = Field(default_factory=list, max_length=30)  # BI-35
    color: str = ""
    memo_type: MEMO_TYPES = "note"
    importance: Optional[int] = None
    source: MEMO_SOURCES = "manual"
    source_url: str = ""
    bookmark_url: str = ""
    collection_id: Optional[str] = None

    @validator("importance", pre=True)
    @classmethod
    def _v_importance(cls, v: Optional[int]) -> Optional[int]:
        if v is not None:
            v = int(v)
            if v < 1 or v > 5:
                raise ValueError("importance 必须在 1-5 之间")
        return v

    _v_organization = validator("organization_id", allow_reuse=True, pre=True)(_validate_uuid)

    @validator("space_id", pre=True)
    @classmethod
    def _v_space(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v != "":
            _uuid.UUID(v)
            return v
        return None

    @validator("collection_id", pre=True)
    @classmethod
    def _v_collection_id(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v != "":
            _uuid.UUID(v)
            return v
        return None

    @validator("agent_id", pre=True)
    @classmethod
    def _v_agent_id(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v != "":
            _uuid.UUID(v)
            return v
        return None

    # BC-32: color 枚举校验
    @field_validator("color")
    @classmethod
    def _v_color(cls, v: str) -> str:
        if v not in COLOR_CHOICES:
            raise ValueError(f"color 必须是 {sorted(COLOR_CHOICES)} 之一，收到: {v!r}")
        return v

    # BI-35: 单个 tag 长度校验
    @field_validator("tags")
    @classmethod
    def _v_tags(cls, v: List[str]) -> List[str]:
        for tag in v:
            if len(tag) > 100:
                raise ValueError(f"单个 tag 长度不能超过 100，收到长度: {len(tag)}")
        return v


class MemoUpdateRequest(Schema):
    content_json: Optional[Dict[str, Any]] = None
    content_markdown: Optional[str] = None
    tags: Optional[List[str]] = Field(default=None, max_length=30)  # BI-35
    color: Optional[str] = None
    is_pinned: Optional[bool] = None
    memo_type: Optional[MEMO_TYPES] = None
    importance: Optional[int] = None
    source_url: Optional[str] = None  # BC-39
    bookmark_url: Optional[str] = None
    bookmark_title: Optional[str] = Field(default=None, max_length=500)
    bookmark_description: Optional[str] = Field(default=None, max_length=5000)
    bookmark_image: Optional[str] = None

    @validator("importance", pre=True)
    @classmethod
    def _v_importance(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return None
        v = int(v)
        if v < 1 or v > 5:
            raise ValueError("importance 必须在 1-5 之间")
        return v

    # BC-32: color 枚举校验
    @field_validator("color")
    @classmethod
    def _v_color(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in COLOR_CHOICES:
            raise ValueError(f"color 必须是 {sorted(COLOR_CHOICES)} 之一，收到: {v!r}")
        return v

    # BI-35: 单个 tag 长度校验
    @field_validator("tags")
    @classmethod
    def _v_tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is not None:
            for tag in v:
                if len(tag) > 100:
                    raise ValueError(f"单个 tag 长度不能超过 100，收到长度: {len(tag)}")
        return v

    # P1: bookmark_image 必须是 http(s) URL，防存储型 XSS
    @field_validator("bookmark_image")
    @classmethod
    def _v_bookmark_image(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v != "" and not _URL_PATTERN.match(v):
            raise ValueError("bookmark_image 必须以 http:// 或 https:// 开头")
        return v


class MemoPinRequest(Schema):
    pinned: bool


class BookmarkPreviewRequest(Schema):
    url: str = Field(max_length=2048)  # BC-34

    # BC-34: URL 格式预检
    @field_validator("url")
    @classmethod
    def _v_url(cls, v: str) -> str:
        if not _URL_PATTERN.match(v):
            raise ValueError("url 必须以 http:// 或 https:// 开头")
        return v


_SMART_FILTER_ALLOWED_KEYS = {"match_mode", "tags", "keywords", "color", "source"}
_SMART_FILTER_MATCH_MODES = {"all", "any"}


def _validate_smart_filter(v: Dict[str, Any]) -> Dict[str, Any]:
    """校验 smart_filter 结构，拒绝非法 key 和 value 类型。"""
    if not v:
        return v
    extra = set(v.keys()) - _SMART_FILTER_ALLOWED_KEYS
    if extra:
        raise ValueError(f"smart_filter 含非法字段: {extra}")
    if "match_mode" in v and v["match_mode"] not in _SMART_FILTER_MATCH_MODES:
        raise ValueError(f"match_mode 必须是 all 或 any，收到: {v['match_mode']}")
    for list_key in ("tags", "keywords", "source"):
        if list_key in v:
            if not isinstance(v[list_key], list):
                raise ValueError(f"smart_filter.{list_key} 必须是数组")
            if not all(isinstance(item, str) for item in v[list_key]):
                raise ValueError(f"smart_filter.{list_key} 中的每个元素必须是字符串")
    if "color" in v and not isinstance(v["color"], str):
        raise ValueError("smart_filter.color 必须是字符串")
    return v


class CollectionCreateRequest(Schema):
    organization_id: str
    space_id: Optional[str] = None  # 可选，None 表示个人碎片集合
    title: str = Field(max_length=255)  # BC-35
    description: str = ""
    icon: str = ""
    color: str = ""
    is_smart: bool = False
    smart_filter: Dict[str, Any] = Field(default_factory=dict)

    _v_organization = validator("organization_id", allow_reuse=True, pre=True)(_validate_uuid)

    @validator("space_id", pre=True)
    @classmethod
    def _v_space(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v != "":
            _uuid.UUID(v)
            return v
        return None

    _v_smart_filter = validator("smart_filter", allow_reuse=True, pre=True)(_validate_smart_filter)

    # BI-22: title 非空校验
    @field_validator("title")
    @classmethod
    def _v_title(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("title 不能为空")
        return v


class CollectionUpdateRequest(Schema):
    title: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    is_smart: Optional[bool] = None
    smart_filter: Optional[Dict[str, Any]] = None

    @validator("smart_filter", pre=True)
    @classmethod
    def _v_smart_filter(cls, v: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if v is not None:
            return _validate_smart_filter(v)
        return v

    # BI-22: title 非空校验（更新时如果提供了 title 则不能为空）
    @field_validator("title")
    @classmethod
    def _v_title(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not v.strip():
            raise ValueError("title 不能为空")
        return v


class CollectionAddMemosRequest(Schema):
    memo_ids: List[str] = Field(min_length=1, max_length=100)  # BC-37, P1: 防 DoS

    @validator("memo_ids", each_item=True, pre=True)
    @classmethod
    def _v_memo_id(cls, v: str) -> str:
        return _validate_uuid(v)


class AttachmentAddRequest(Schema):
    file_record_id: str

    _v_file_record = validator("file_record_id", allow_reuse=True, pre=True)(_validate_uuid)

    file_type: str = ""
    sort_order: int = 0

    # BC-33: file_type 枚举校验
    @field_validator("file_type")
    @classmethod
    def _v_file_type(cls, v: str) -> str:
        if v not in FILE_TYPE_CHOICES:
            raise ValueError(f"file_type 必须是 {sorted(FILE_TYPE_CHOICES)} 之一，收到: {v!r}")
        return v


# BC-38: 添加 trash 操作
BATCH_ACTIONS = Literal["archive", "tag", "move_to_collection", "trash"]


class MemoBatchRequest(Schema):
    organization_id: str
    space_id: Optional[str] = None  # 可选
    memo_ids: List[str] = Field(min_length=1, max_length=100)  # BC-37, P1: 防 DoS
    action: BATCH_ACTIONS
    tags: Optional[List[str]] = None
    collection_id: Optional[str] = None

    _v_organization = validator("organization_id", allow_reuse=True, pre=True)(_validate_uuid)

    @validator("space_id", pre=True)
    @classmethod
    def _v_space(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v != "":
            _uuid.UUID(v)
            return v
        return None

    @validator("memo_ids", each_item=True, pre=True)
    @classmethod
    def _v_memo_id(cls, v: str) -> str:
        return _validate_uuid(v)

    @validator("collection_id", pre=True)
    @classmethod
    def _v_collection_id(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v != "":
            _uuid.UUID(v)
        return v


# ─── 响应 Schemas ────────────────────────────────────────


class AttachmentOut(Schema):
    id: str
    file_type: str
    file_url: str
    file_name: str
    file_size: int = 0
    mime_type: str = ""
    thumbnail_url: str = ""
    sort_order: int = 0
    created_at: str


class CollectionBriefOut(Schema):
    id: str
    title: str
    icon: str = ""
    color: str = ""


class CollectionOut(Schema):
    id: str
    title: str
    description: str = ""
    icon: str = ""
    color: str = ""
    is_smart: bool = False
    smart_filter: Dict[str, Any] = Field(default_factory=dict)
    memo_count: int = 0
    sort_order: int = 0
    created_at: str
    updated_at: str


# BC-40: 响应 Schema 使用 Literal 类型
class MemoSummary(Schema):
    id: str
    space_id: Optional[str] = None
    agent_id: Optional[str] = None
    memo_type: MEMO_TYPES = "note"
    importance: Optional[int] = None
    content_plaintext: str = ""
    content_markdown: str = ""
    tags: List[str] = Field(default_factory=list)
    ai_tags: List[str] = Field(default_factory=list)
    color: str = ""
    source: MEMO_SOURCES = "manual"
    status: Literal["active", "archived", "trashed"] = "active"
    is_pinned: bool = False
    bookmark_url: str = ""
    bookmark_title: str = ""
    bookmark_image: str = ""
    attachment_count: int = 0
    created_at: str
    updated_at: str


class MemoDetail(MemoSummary):
    content_json: Dict[str, Any] = Field(default_factory=dict)
    content_markdown: str = ""
    source_url: str = ""
    bookmark_description: str = ""
    attachments: List[AttachmentOut] = Field(default_factory=list)
    collections: List[CollectionBriefOut] = Field(default_factory=list)


class BookmarkPreviewOut(Schema):
    url: str
    title: str = ""
    description: str = ""
    image: str = ""


# ─── Grant Schemas ────────────────────────────────────────


GRANT_PERMISSIONS = Literal["read", "write"]


class MemoGrantCreateRequest(Schema):
    organization_id: str
    target_space_id: str
    memo_ids: Optional[List[str]] = None
    collection_ids: Optional[List[str]] = None
    permission: GRANT_PERMISSIONS = "read"

    _v_organization = validator("organization_id", allow_reuse=True, pre=True)(_validate_uuid)
    _v_target_space = validator("target_space_id", allow_reuse=True, pre=True)(_validate_uuid)

    @validator("memo_ids", pre=True)
    @classmethod
    def _v_memo_ids(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is not None:
            for item in v:
                _uuid.UUID(item)
        return v

    @validator("collection_ids", pre=True)
    @classmethod
    def _v_collection_ids(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is not None:
            for item in v:
                _uuid.UUID(item)
        return v

    @model_validator(mode="after")
    def _v_at_least_one_target(self) -> "MemoGrantCreateRequest":
        if not self.memo_ids and not self.collection_ids:
            raise ValueError("memo_ids 和 collection_ids 不能同时为空")
        return self


class MemoGrantOut(Schema):
    id: str
    memo_id: Optional[str] = None
    collection_id: Optional[str] = None
    target_space_id: str
    permission: str
    created_at: str


# ─── 记录风格 Schemas（per-(user, organization) Agent 笔记记录偏好）──────────

RECORD_STYLES = Literal["faithful", "minimal", "companion", "custom"]


class RecordStyleUpdateRequest(Schema):
    enabled: Optional[bool] = None
    style: Optional[RECORD_STYLES] = None
    custom_config: Optional[Dict[str, Any]] = None
    extra_preference: Optional[str] = Field(default=None, max_length=1000)

    # TM-12: custom_config 边界守卫——正常只有 density/depth/tone/focus 四个已知维度键，
    # 在 API 边界对明显异常的 payload 提前 422 拒绝（DoS 面），剩余非法键/值由 service
    # 层 _sanitize_custom_config 白名单静默丢弃。这里只挡「明显过大」，不做语义校验。
    @field_validator("custom_config")
    @classmethod
    def _v_custom_config(cls, v: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if v is None:
            return None
        if not isinstance(v, dict):
            raise ValueError("custom_config 必须是对象")
        if len(v) > 20:
            raise ValueError("custom_config 维度键过多")
        focus = v.get("focus")
        if isinstance(focus, (list, tuple)) and len(focus) > 50:
            raise ValueError("custom_config.focus 元素过多")
        return v

    @model_validator(mode="after")
    def _v_at_least_one(self) -> "RecordStyleUpdateRequest":
        if (
            self.enabled is None
            and self.style is None
            and self.custom_config is None
            and self.extra_preference is None
        ):
            raise ValueError("至少要提供一个待更新字段")
        return self
