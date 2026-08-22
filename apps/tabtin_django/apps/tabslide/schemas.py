"""
TabSlide 模块 Pydantic Schemas（Django Ninja 用）

包含请求/响应 Schema，涵盖：
  - 项目 CRUD
  - 页面保存（含 CAS 版本号）
  - 版本历史（列表 / 恢复 / 命名版本）
  - 变更记录
  - 增量同步
  - PPTX 导入导出
"""

from typing import Any, ClassVar, Dict, List, Optional

from ninja import Schema
from pydantic import Field, model_validator


# ─── 请求 Schemas ────────────────────────────────────────


class ProjectCreateRequest(Schema):
    organization_id: str
    space_id: str
    name: str = "未命名演示文稿"
    preset: str = "ppt"  # ppt | xiaohongshu | poster | custom
    canvas_width: Optional[int] = Field(default=None, ge=1)
    canvas_height: Optional[int] = Field(default=None, ge=1)
    theme: Optional[Dict[str, Any]] = None
    embedded_fonts: Optional[List[Dict[str, Any]]] = None
    theme_fonts: Optional[Dict[str, str]] = None


class ProjectUpdateRequest(Schema):
    name: Optional[str] = None
    preset: Optional[str] = None
    canvas_width: Optional[int] = Field(default=None, ge=1)
    canvas_height: Optional[int] = Field(default=None, ge=1)
    theme: Optional[Dict[str, Any]] = None
    thumbnail: Optional[str] = None
    embedded_fonts: Optional[List[Dict[str, Any]]] = None
    theme_fonts: Optional[Dict[str, str]] = None


class CreateSlidesRequest(Schema):
    """
    创建模式：Agent 提交 HTML，dom_extractor 一次性转 PPTElement[] 落库。

    哲学：HTML 是 Agent 的创作方言，落库后真相源始终是 PPTElement[]（content_format='json'）。
    html_source 字段保留作 Agent 后续创作的"风格参考语料"，read-only after creation。
    创建后任何写入路径都不再接受 contentFormat='html'，请使用 update / batch-update 编辑。
    """
    html: str
    title: Optional[str] = None
    mode: Optional[str] = "direct"
    #  render 链路：图片（栅格化 SVG / rasterize 截图等）不上传 OSS，
    # 以 data:base64 内嵌 PPTElement.src——用于「用完即删」的临时渲染项目，
    # 导出 pptx 全程自包含、不依赖 OSS 可达性。长期云项目保持默认 False。
    inline_images: Optional[bool] = False


class AppendSlidesRequest(CreateSlidesRequest):
    """
    追加模式：Agent 提交 HTML，转换为新页面后增量写入现有演示文稿。

    与 create-slides 不同，本请求不会替换旧页面；after_page_id 用于控制插入位置。
    page_id 仅允许在 HTML 只生成 1 页时指定。
    """
    page_id: Optional[str] = None
    after_page_id: Optional[str] = None
    base_version: Optional[int] = None


MAX_PAGES_PER_REQUEST = 500


class SavePagesRequest(Schema):
    """
    保存编辑器修改：页面 PPTElement[] payload → CAS 写入 DB。

    JSON-first 哲学（重要）：
      - pages 中每页必须使用 elements: PPTElement[] 字段
      - 不再接受 contentFormat='html' 或 html 字段写入；带这些字段会被静默丢弃
      - 创作期 HTML 通过 /create-slides 入口处理（一次性转 JSON）

    base_version: 可选，前端持有的版本号。
      - 提供时做 CAS 检查，版本不一致抛出 409 Conflict
      - 不提供时自动使用服务端当前版本（兼容旧前端）
    """
    pages: List[Dict[str, Any]]  # List[SlidePage] as JSON
    base_version: Optional[int] = None

    @model_validator(mode="after")
    def _validate_pages_have_id(self) -> "SavePagesRequest":
        if len(self.pages) > MAX_PAGES_PER_REQUEST:
            raise ValueError(
                f"pages 包含 {len(self.pages)} 页，超过上限 {MAX_PAGES_PER_REQUEST}"
            )
        invalid = [
            i for i, p in enumerate(self.pages)
            if not isinstance(p.get("id"), str) or not p["id"]
        ]
        if invalid:
            raise ValueError(
                f"pages[{','.join(str(i) for i in invalid)}] 缺少有效的 string 'id' 字段"
            )
        return self


class UpdateElementRequest(Schema):
    """编辑模式：Agent 精准修改单个元素"""
    patch: Dict[str, Any]  # Partial<SlideElement>
    base_version: Optional[int] = None


class ParsePptxRequest(Schema):
    """纯解析 PPTX：base64 编码的 PPTX 文件 → SlideElement[] + 元数据（不创建项目）"""
    MAX_FILE_SIZE: ClassVar[int] = 50 * 1024 * 1024
    MAX_BASE64_LENGTH: ClassVar[int] = (50 * 1024 * 1024 * 4) // 3 + 4

    file_base64: str = Field(..., max_length=70_000_000)
    file_name: Optional[str] = "import.pptx"
    canvas_width: Optional[int] = None
    canvas_height: Optional[int] = None

    @model_validator(mode="after")
    def check_base64_size(self) -> "ParsePptxRequest":
        if len(self.file_base64) > self.MAX_BASE64_LENGTH:
            estimated_mb = len(self.file_base64) * 3 / 4 / 1024 / 1024
            raise ValueError(
                f"Base64 数据过大（约 {estimated_mb:.1f}MB），超过上限 50MB"
            )
        return self


class ExportRequest(Schema):
    format: str = "pptx"


class NormalizeImageRequest(Schema):
    """图片归一化请求（用于导出降级：URL/dataURL -> 标准 data URL）"""
    src: str


# ── 版本历史相关 ──


class CreateNamedVersionRequest(Schema):
    """创建命名版本（用户手动保存的里程碑）"""
    name: str = ""


class RestoreHistoryRequest(Schema):
    """恢复历史版本"""
    history_id: str


class SyncCheckRequest(Schema):
    """增量同步检查"""
    client_version: int


class SavePagesV2Request(Schema):
    """
    增量保存（V2）：只传变更的页面，不全量覆盖。

    changed_pages: { page_id: { elements: [...], background: {...}, ... } }
      只传变更的页面。每个页面对象中只需包含变更的字段。
      JSON-first 哲学：不再接受 html / content_format 字段写入，带这些字段会被静默丢弃。
    deleted_page_ids: 要删除的页面 ID 列表（可选）
    page_order: 页面排序列表（可选，所有 page_id 的有序数组）
    base_version: CAS 版本号
    """
    changed_pages: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    deleted_page_ids: Optional[List[str]] = None
    page_order: Optional[List[str]] = None
    base_version: Optional[int] = None

    @model_validator(mode="after")
    def _validate_page_count(self) -> "SavePagesV2Request":
        total = len(self.changed_pages) + len(self.deleted_page_ids or [])
        if total > MAX_PAGES_PER_REQUEST:
            raise ValueError(
                f"单次请求涉及 {total} 页，超过上限 {MAX_PAGES_PER_REQUEST}"
            )
        return self


# ── Agent 精准编辑（Phase 5） ──


class UpdateElementByPageIdRequest(Schema):
    """Agent 精准修改元素（通过 page_id 定位，比 page_index 更稳定）"""
    patch: Dict[str, Any]
    base_version: Optional[int] = None


class BatchElementUpdate(Schema):
    """单个元素变更"""
    page_id: str
    element_id: str
    patch: Dict[str, Any]


class BatchUpdateElementsRequest(Schema):
    """
    Agent 批量修改元素（Y.js-first 架构）

    变更通过 Y.js CRDT 协作链路推送，自动实时广播 + 持久化。
    base_version 仅在 Y.js-first 失败降级到 DB-first 时使用。
    """
    updates: List[BatchElementUpdate]
    base_version: Optional[int] = None


# ── Preview & Lint 相关 ──


class PreviewRequest(Schema):
    """Agent 截图预览请求"""
    page_id: Optional[str] = None  # 不传则预览第一页
    response_format: str = "url"  # url | base64


class LintRequest(Schema):
    """Agent 视觉检查请求"""
    page_id: Optional[str] = None  # 不传则检查所有页
    problems_only: bool = False
    # Phase-3 Wave-3 体验改善：允许只看 error/warning（默认 info 太吵）
    min_severity: Optional[str] = None  # "error" / "warning" / "info" (none=全部)
    # 跳过 visual lint（DOM 渲染慢），只跑 structural（毫秒级，适合 Agent 频繁自检）
    skip_visual: bool = False


class GrepRequest(Schema):
    """Agent 全文本搜索请求：在 PPT 所有页的元素文字里找子串。

    简单可预期：不做正则、不做模糊匹配、不做 NFD 归一化，就是大小写不敏感的子串。
    返回元素的 page_id + element_id，方便 Agent 立即用 slide update 改。
    """
    query: str  # 要搜的子串（大小写不敏感）
    page_id: Optional[str] = None  # 限制单页
    # 默认 ["text", "shape"]：text 元素的 props.content + shape 元素的 props.text.content
    element_types: Optional[List[str]] = None
    max_results: int = Field(default=50, ge=1, le=500)


# ─── 响应 ────────────────────────────────────────
# 所有端点统一使用 api.py 中的 _serialize_* 函数构建 dict 响应，
# 不再维护并行的 Pydantic 响应 Schema（避免双写漂移，参见 BS-007）。
