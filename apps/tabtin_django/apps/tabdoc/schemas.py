from datetime import datetime as dt
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from ninja import Schema
from pydantic import Field, field_validator, model_validator


# ── Request Schemas ──


class CommentAttachmentUploadRequest(Schema):
    password: str = ""
    file_name: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=100)
    file_size: int = Field(gt=0)


class CommentAttachmentConfirmRequest(Schema):
    password: str = ""
    upload_token: str = Field(min_length=1, max_length=4096)


class CommentAttachmentPreviewRequest(Schema):
    password: str = ""


class CommentMessageDeleteRequest(Schema):
    """分享页删除评论：密码只走 body，避免进 query / Referer。"""

    password: str = ""


class CommentThreadCreateRequest(Schema):
    password: str = ""
    client_request_id: Optional[str] = Field(default=None, max_length=100)
    body: str = ""
    attachment_ids: List[str] = Field(default_factory=list, max_length=9)
    scope: Literal["document", "text_range", "block"] = "document"
    anchor: Dict[str, Any] = Field(default_factory=dict)
    selected_text: str = ""
    author_name: str = ""
    mention_user_ids: List[str] = Field(default_factory=list)


class CommentMessageCreateRequest(Schema):
    password: str = ""
    client_request_id: Optional[str] = Field(default=None, max_length=100)
    body: str = ""
    attachment_ids: List[str] = Field(default_factory=list, max_length=9)
    author_name: str = ""
    mention_user_ids: List[str] = Field(default_factory=list)


class CommentThreadStatusRequest(Schema):
    password: str = ""
    status: Literal["open", "resolved"]


class CommentThreadAnchorRequest(Schema):
    password: str = ""
    scope: Literal["text_range", "block"]
    anchor: Dict[str, Any]


class DocumentCreateRequest(Schema):
    """#6603：文档只挂 Organization；不再接受 space_id。"""

    organization_id: str
    parent_id: Optional[str] = None
    collection_id: Optional[str] = None
    # ：挂到 ContextItem 知识库树（与 Document.parent / parent_id 解耦）
    parent_item_id: Optional[str] = None
    title: Optional[str] = Field(None, max_length=255)
    icon: Optional[str] = Field(None, max_length=64)
    cover_image: Optional[str] = None
    initial_content_pm_json: Dict[str, Any] = Field(default_factory=dict)
    initial_content_markdown: str = ""
    initial_content_plaintext: str = ""


def _validate_iso_datetime(v: Optional[str]) -> Optional[str]:
    """校验 ISO 8601 日期时间格式，非法格式在 Schema 层即拒绝而非下游 ValueError"""
    if v is None:
        return v
    from django.utils.dateparse import parse_datetime
    if parse_datetime(v) is None:
        raise ValueError(f"无效的日期时间格式: {v}，请使用 ISO 8601 格式")
    return v


class DocumentUpdateRequest(Schema):
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None
    title: Optional[str] = None
    parent_id: Optional[str] = None
    collection_id: Optional[str] = None
    status: Optional[Literal["active", "archived", "trashed"]] = None
    icon: Optional[str] = None
    cover_image: Optional[str] = None
    # R-A3：cover_position 是封面纵向焦点（0.0 顶 / 1.0 底）。原来无范围校验，
    # service 层会静默 clamp 到 [0, 1] + 200 OK，agent 喂 1.5 时无法区分
    # "传错了"和"传对了"。加 pydantic Field(ge=0, le=1)，越界让 ninja 直接
    # 422 反弹，agent 第一时间感知。service 层 clamp 保留作为防御深度。
    cover_position: Optional[float] = Field(
        None,
        ge=0.0,
        le=1.0,
        description="封面纵向焦点（0.0 顶 / 1.0 底）；越界 [0, 1] 将 422",
    )
    tags: Optional[List[str]] = None
    properties: Optional[Dict[str, Any]] = None
    is_full_width: Optional[bool] = None
    font_style: Optional[Literal["default", "serif", "mono"]] = None
    is_private: Optional[bool] = None

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class DocumentSaveContentRequest(Schema):
    # Whole-document writes are an exceptional, destructive operation.  Keeping
    # this explicit prevents an Agent/CLI convenience call from silently
    # replacing concurrent edits.
    write_intent: Optional[Literal["replace"]] = None
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None
    title: Optional[str] = None
    content_pm_json: Dict[str, Any] = Field(default_factory=dict)
    content_markdown: str = ""
    content_plaintext: str = ""

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class DocumentRecoveryDraftCreateRequest(Schema):
    base_version: Optional[int] = None
    content_pm_json: Dict[str, Any] = Field(default_factory=dict)
    content_markdown: str = Field("", max_length=5 * 1024 * 1024)
    content_plaintext: str = Field("", max_length=5 * 1024 * 1024)


class DocumentRecoveryDraftRestoreRequest(Schema):
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None
    confirm_replace: Literal[True]

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class BlockUpdateRequest(Schema):
    """更新单个 block 请求（TD-3）。"""
    markdown: str
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class BlockHighlightRequest(Schema):
    """给已定位的 block 内精确文本添加原生高亮，而非写入 HTML/Markdown 标记。"""
    text: str = Field(..., min_length=1, max_length=20_000)
    color: Literal["yellow", "purple", "red", "blue", "green", "orange", "pink", "gray"] = "yellow"
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class BlockTextFormatRequest(Schema):
    """对 block 内唯一文本范围应用 TabDoc 已支持的行内格式。"""

    text: str = Field(..., min_length=1, max_length=20_000)
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    underline: Optional[bool] = None
    strike: Optional[bool] = None
    code: Optional[bool] = None
    text_color: Optional[Literal["default", "purple", "red", "yellow", "blue", "green", "orange", "pink", "gray"]] = None
    background_color: Optional[Literal["default", "purple", "red", "yellow", "blue", "green", "orange", "pink", "gray"]] = None
    link_url: Optional[str] = Field(None, max_length=2_048)
    remove_link: bool = False
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None

    @model_validator(mode="after")
    def check_has_format_change(self) -> "BlockTextFormatRequest":
        has_mark_change = any(
            value is not None
            for value in (self.bold, self.italic, self.underline, self.strike, self.code)
        )
        has_color_change = self.text_color is not None or self.background_color is not None
        if not (has_mark_change or has_color_change or self.link_url or self.remove_link):
            raise ValueError("至少提供一项文字格式：粗斜体、颜色或链接")
        if self.link_url and self.remove_link:
            raise ValueError("link_url 与 remove_link 不能同时提供")
        if self.link_url:
            from urllib.parse import urlparse

            parsed = urlparse(self.link_url)
            if parsed.scheme not in {"http", "https", "mailto", "tel"} or not parsed.path and not parsed.netloc:
                raise ValueError("link_url 必须是 http(s)、mailto 或 tel 链接")
        return self

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class BlockInsertRequest(Schema):
    """插入 block 请求（TD-3）；缺省末尾追加，at_start=True 时插到顶部。"""
    markdown: str
    after_block_id: Optional[str] = None
    at_start: bool = False
    image_file_id: Optional[UUID] = None
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class DocumentRestoreRequest(Schema):
    version: Optional[int] = None       # 旧 Revision 版本号（兼容）
    version_id: Optional[str] = None    # 新 DocumentVersion UUID
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None

    @model_validator(mode="after")
    def check_version_or_version_id(self) -> "DocumentRestoreRequest":
        if self.version is None and self.version_id is None:
            raise ValueError("version 和 version_id 至少须提供一个")
        return self

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class DocumentPermissionEntry(Schema):
    subject_type: str
    subject_id: str
    permission: str
    is_active: bool = True


class DocumentPermissionsUpdateRequest(Schema):
    entries: List[DocumentPermissionEntry] = Field(default_factory=list)


_MAX_MARKDOWN_IMPORT_SIZE = 5 * 1024 * 1024  # 与 markdown_exchange._MAX_MARKDOWN_SIZE 对齐

class DocumentImportMarkdownRequest(Schema):
    organization_id: str
    markdown: str = Field("", max_length=_MAX_MARKDOWN_IMPORT_SIZE)


class DocumentImportFileRequest(Schema):
    organization_id: str
    file_record_id: str


class DocumentImportJobCreateRequest(DocumentImportFileRequest):
    selected_model_id: Optional[UUID] = None


class DocumentImportJobOut(Schema):
    id: str
    file_record_id: str
    parsed_document_id: Optional[str] = None
    status: str
    stage: str
    total_pages: int = 0
    processed_pages: int = 0
    failed_pages: int = 0
    retry_count: int = 0
    celery_task_id: str = ""
    worker_id: str = ""
    heartbeat_at: Optional[str] = None
    lease_expires_at: Optional[str] = None
    error_code: str = ""
    error_message: str = ""
    parser_version: str = ""
    result_available: bool = False
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


class DocumentImportJobResultOut(DocumentImportJobOut):
    result_payload: Dict[str, Any] = Field(default_factory=dict)


# ── V3: Hocuspocus / Agent / History 相关 Schemas ──


class AgentWriteRequest(Schema):
    """Agent 写入请求（Markdown）"""
    content_markdown: str
    agent_id: str = ""


class DocHistoryOut(Schema):
    """DocHistory 版本历史响应"""
    id: str
    document_id: str
    is_snapshot: bool
    editor_type: str = ""
    editor_id: str = ""
    expired_at: Optional[str] = None
    created_at: Optional[str] = None
    # 命名版本字段
    is_named: bool = False
    name: str = ""
    pinned: bool = False


class HistoryRestoreRequest(Schema):
    """从 DocHistory 恢复请求"""
    history_id: str
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class CreateNamedVersionRequest(Schema):
    """创建命名版本请求"""
    name: str = Field("", max_length=200)
    base_version: Optional[int] = None
    base_updated_at: Optional[str] = None

    @field_validator("base_updated_at")
    @classmethod
    def check_base_updated_at(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_datetime(v)


class RenameVersionRequest(Schema):
    """重命名版本请求"""
    name: str = Field(..., max_length=200)


# ── Response Schemas ──


class DocumentOut(Schema):
    """文档详情响应"""
    id: str
    organization_id: str
    space_id: Optional[str] = None
    parent_id: Optional[str] = None
    title: str
    status: str
    latest_version: int
    # 文档属性
    icon: str = ""
    cover_image: str = ""
    cover_position: float = 0.5
    tags: List[str] = Field(default_factory=list)
    properties: Dict[str, Any] = Field(default_factory=dict)
    is_full_width: bool = False
    font_style: str = "default"
    # 隐私控制 (BE-09)
    is_private: bool = False
    # 编辑者追踪 (BE-08)
    last_editor_type: str = ""
    last_editor_id: str = ""
    # 回收站 (BE-07)
    trashed_at: Optional[str] = None
    trashed_by: Optional[str] = None
    previous_status: str = ""
    # 审计
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class DocumentVersionOut(Schema):
    """文档版本快照响应"""
    id: str
    document_id: str
    version: Optional[int] = None
    description_markdown: str = ""
    description_json: Dict[str, Any] = Field(default_factory=dict)
    description_plaintext: str = ""
    last_saved_at: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[str] = None


class RevisionOut(Schema):
    """[兼容] 旧版文档版本响应"""
    id: str
    document_id: str
    version: int
    content_pm_json: Dict[str, Any] = Field(default_factory=dict)
    content_markdown: str = ""
    content_plaintext: str = ""
    editor_id: Optional[str] = None
    created_at: Optional[str] = None


class PermissionEntryOut(Schema):
    """权限条目响应"""
    id: str
    document_id: str
    subject_type: str
    subject_id: str
    permission: str
    is_active: bool
    created_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SearchHitOut(Schema):
    """搜索命中响应"""
    document: DocumentOut
    snippet: str
    relevance_score: float
    matched_on_title: bool
    block_id: Optional[str] = None
    block_type: Optional[str] = None
    block_index: Optional[int] = None
    block_preview: str = ""


class BlockSearchHitOut(Schema):
    """文档内 block 搜索命中响应"""
    block_id: str
    block_type: str
    level: Optional[int] = None
    index: int
    snippet: str
    preview: str
    relevance_score: float


class ExportContentOut(Schema):
    """导出内容响应"""
    format: str
    content: str
    mime_type: str
    filename: str


class ImportDraftOut(Schema):
    """导入草稿响应"""
    pm_json: Dict[str, Any] = Field(default_factory=dict)
    markdown: str = ""
    plaintext: str = ""
