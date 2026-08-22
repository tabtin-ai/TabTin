from __future__ import annotations

from typing import Literal, Optional
from uuid import UUID

from ninja import Schema
from pydantic import Field, field_validator, model_validator


MemoryType = Literal["about_you", "insight", "task_summary", "diary"]


class WorkspaceMemorySettingsUpdateRequest(Schema):
    organization_id: str
    auto_memory_enabled: Optional[bool] = None
    memory_model_mode: Optional[Literal["official_default", "explicit_model"]] = None
    memory_model_id: Optional[str] = None

    @field_validator("organization_id", "memory_model_id")
    @classmethod
    def validate_workspace_memory_uuid(cls, value: Optional[str]) -> Optional[str]:
        if value:
            UUID(value)
        return value

    @model_validator(mode="after")
    def validate_explicit_model_id(self):
        if (
            self.memory_model_mode == "explicit_model"
            and not self.memory_model_id
        ):
            raise ValueError("explicit_model 必须提交 memory_model_id")
        return self


class MemoryScopeRequest(Schema):
    organization_id: str
    agent_id: Optional[str] = None
    space_id: Optional[str] = None

    @field_validator("organization_id", "agent_id", "space_id")
    @classmethod
    def validate_uuid(cls, value: Optional[str]) -> Optional[str]:
        if value:
            UUID(value)
        return value

    @model_validator(mode="after")
    def validate_exactly_one_target(self):
        if bool(self.agent_id) == bool(self.space_id):
            raise ValueError("agent_id 与 space_id 必须且只能提供一个")
        return self


class MemoryRecordRequest(MemoryScopeRequest):
    memory_type: MemoryType
    content: str = Field(min_length=1, max_length=50_000)
    title: str = Field(default="", max_length=255)
    importance: Optional[int] = Field(default=None, ge=1, le=5)
    tags: list[str] = Field(default_factory=list, max_length=30)
    source_ref: str = Field(default="", max_length=2048)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content 不能为空")
        return value

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, tags: list[str]) -> list[str]:
        if any(len(tag) > 100 for tag in tags):
            raise ValueError("单个 tag 不能超过 100 个字符")
        return tags


class MemoryCorrectRequest(MemoryScopeRequest):
    content: str = Field(min_length=1, max_length=50_000)
    memory_type: Optional[MemoryType] = None

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content 不能为空")
        return value


class MemoryLifecycleRequest(MemoryScopeRequest):
    pass


class MemoryFeedbackRequest(MemoryScopeRequest):
    """重要度 / 「有用」反馈请求（ 前端记忆治理）。

    - ``importance``：直接设定绝对重要度（1-5）。
    - ``useful``：轻量反馈——``True`` 上调一档、``False`` 下调一档（在 1-5 内夹取）。
    两者至少提供一个；同时给定时以 ``importance`` 绝对值为准。
    """

    importance: Optional[int] = Field(default=None, ge=1, le=5)
    useful: Optional[bool] = None

    @model_validator(mode="after")
    def validate_at_least_one(self):
        if self.importance is None and self.useful is None:
            raise ValueError("importance 与 useful 至少提供一个")
        return self


class MemoryOut(Schema):
    id: str
    organization_id: str
    agent_id: str
    subject_user_id: str
    memory_type: MemoryType
    title: str
    content: str
    importance: Optional[int]
    tags: list[str]
    state: Literal["active", "archived"]
    source_ref: str
    supersedes_memory_id: Optional[str]
    created_at: str
    updated_at: str
    # ：统一检索层打分（命中的不同关键词个数）。仅 search 非空时有值；
    # 纯浏览 / 无 search 时为 null。调用方可据此做更严格的注入阈值过滤。
    score: Optional[int] = None
    # ：统一检索层打分（命中的不同关键词个数）。仅当请求带 search
    # 且分词非空时有值；纯浏览 / 无 search 时为 null。
    score: Optional[int] = None
    # ：统一检索层打分（命中的不同关键词个数）。仅在带 search 的列表
    # 请求下非空；纯浏览 / 单条 get 时为 None。
    score: Optional[int] = None


class MemoryPageOut(Schema):
    items: list[MemoryOut]
    next_cursor: str
    has_more: bool
    limit: int
