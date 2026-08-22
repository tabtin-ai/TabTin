from __future__ import annotations

import base64
import asyncio
import copy
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import html
import logging
import re
import sys
from typing import Any
from urllib.parse import urlparse

from apps.tabdoc.models import Document
from apps.tabdoc.services.document_service import DocumentService
from apps.tabdoc.services.markdown_exchange import (
    markdown_to_pm_json,
    pm_json_to_html,
    pm_json_to_markdown,
    render_markdown_html,
)
from apps.tabdoc.services.metrics import get_tabdoc_metrics
from apps.i18n import get_text as _

logger = logging.getLogger("tabdoc.exchange")

_CTRL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_HTML_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_ESCAPED_HTML_IMG_TAG_RE = re.compile(r"&lt;img\b.*?&gt;", re.IGNORECASE | re.DOTALL)
_HTML_IMG_ALT_RE = re.compile(r"""\balt\s*=\s*(['"])(.*?)\1""", re.IGNORECASE | re.DOTALL)
_PDF_RENDER_TIMEOUT_SECONDS = 45
# PDF 导出默认 2x，与 TabSlide 导出清晰度策略对齐，避免 SVG/位图在 Retina/打印下发糊
_PDF_DEVICE_SCALE_FACTOR = 2
_PDF_RENDERER_UNAVAILABLE_MESSAGE = (
    "PDF 导出需要可用的 Playwright Chromium renderer；"
    "请确认后端已安装浏览器运行时（python -m playwright install chromium）"
)
_PDF_ALLOWED_LOCAL_PATHS = {"/api/services/oss/local-object"}

_EXPORT_HTML_STYLE = """
    :root {
      color-scheme: light;
      --novel-black: ;
      --novel-highlight-default: transparent;
      --novel-highlight-purple: #f3e8ff;
      --novel-highlight-red: #fee2e2;
      --novel-highlight-yellow: #fef9c3;
      --novel-highlight-blue: #dbeafe;
      --novel-highlight-green: #dcfce7;
      --novel-highlight-orange: #ffedd5;
      --novel-highlight-pink: #fce7f3;
      --novel-highlight-gray: #f3f4f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #fff;
      color: #111827;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    .tabdoc-export {
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      padding: 40px 24px 64px;
    }
    .tabdoc-export.tabdoc-full-width { max-width: none; }
    .tabdoc-export-title {
      margin: 0 0 2rem;
      color: #0f172a;
      font-size: 2rem;
      font-weight: 700;
      line-height: 1.2;
    }
    .tabdoc-font-serif .ProseMirror {
      font-family: Georgia, Cambria, "Times New Roman", "Songti SC", "SimSun", serif;
    }
    .tabdoc-font-mono .ProseMirror {
      font-family: "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace;
    }
    .ProseMirror {
      font-size: 14px;
      line-height: 1.75;
      overflow-wrap: anywhere;
    }
    .tabdoc-small-text .ProseMirror {
      font-size: 12px;
      line-height: 1.7;
    }
    .ProseMirror h1 { font-size: 1.75em; font-weight: 700; line-height: 1.3; margin: 2em 0 0.5em; }
    .ProseMirror h2 { font-size: 1.375em; font-weight: 600; line-height: 1.35; margin: 1.5em 0 0.4em; }
    .ProseMirror h3 { font-size: 1.125em; font-weight: 600; line-height: 1.4; margin: 1.25em 0 0.3em; }
    .ProseMirror h4 { font-size: 1em; font-weight: 600; line-height: 1.45; margin: 1em 0 0.25em; }
    .ProseMirror h5 { font-size: 0.925em; font-weight: 600; line-height: 1.5; margin: 0.85em 0 0.2em; }
    .ProseMirror h6 { color: #6b7280; font-size: 0.85em; font-weight: 600; line-height: 1.5; margin: 0.75em 0 0.15em; }
    .ProseMirror p { margin: 0.5rem 0; }
    .ProseMirror a { color: #2563eb; text-decoration: underline; text-underline-offset: 3px; }
    .ProseMirror blockquote {
      margin: 1rem 0;
      padding-left: 1rem;
      border-left: 3px solid #d1d5db;
      color: #4b5563;
    }
    .ProseMirror ul, .ProseMirror ol {
      margin: 0.75rem 0;
      padding-left: 1.5rem;
    }
    .ProseMirror ul ul { list-style-type: circle; }
    .ProseMirror ul ul ul { list-style-type: square; }
    .ProseMirror ol ol { list-style-type: lower-alpha; }
    .ProseMirror ol ol ol { list-style-type: lower-roman; }
    .ProseMirror li > ul, .ProseMirror li > ol { margin: 0.25rem 0; }
    .ProseMirror .task-list {
      list-style: none;
      padding-left: 0;
    }
    .ProseMirror .task-list > li {
      display: grid;
      grid-template-columns: 1rem minmax(0, 1fr);
      gap: 0.5rem;
      align-items: flex-start;
      margin: 0.25rem 0;
    }
    .ProseMirror .task-list > li > input[type="checkbox"] {
      grid-column: 1;
      grid-row: 1;
      width: 1rem;
      height: 1rem;
      margin: 0.2rem 0 0;
      accent-color: #f59e0b;
    }
    .ProseMirror .task-list > li > :not(input) {
      grid-column: 2;
      min-width: 0;
    }
    .ProseMirror .task-list > li > p {
      margin: 0;
    }
    .ProseMirror table {
      width: 100%;
      margin: 1rem 0;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .ProseMirror th,
    .ProseMirror td {
      min-width: 1em;
      padding: 0.45rem 0.6rem;
      border: 1px solid #d1d5db;
      vertical-align: top;
    }
    .ProseMirror th {
      background: #f3f4f6;
      font-weight: 600;
      text-align: left;
    }
    .ProseMirror pre {
      overflow-x: auto;
      margin: 1rem 0;
      padding: 0.85rem 1rem;
      border-radius: 0.5rem;
      background: #0f172a;
      color: #e5e7eb;
    }
    .ProseMirror code {
      font-family: "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace;
      font-size: 0.9em;
    }
    .ProseMirror :not(pre) > code {
      padding: 0.1rem 0.25rem;
      border-radius: 0.25rem;
      background: #f3f4f6;
      color: #be123c;
    }
    .ProseMirror img {
      max-width: 100%;
      height: auto;
      border-radius: 0.5rem;
    }
    .ProseMirror hr {
      margin: 2rem 0;
      border: 0;
      border-top: 1px solid #e5e7eb;
    }
    .ProseMirror .tabdata-block,
    .ProseMirror .tabwhiteboard-block {
      margin: 1rem 0;
      padding: 1rem;
      border: 1px solid #d1d5db;
      border-radius: 0.75rem;
      background: #f9fafb;
      color: #4b5563;
    }
""".strip()

def _html_img_tag_to_plaintext(match: re.Match[str]) -> str:
    alt_match = _HTML_IMG_ALT_RE.search(html.unescape(match.group(0)))
    if not alt_match:
        return ""
    alt = html.unescape(alt_match.group(2)).strip()
    return f"[{alt}]" if alt else ""


def _strip_inline_image_html(text: str) -> str:
    without_raw_images = _HTML_IMG_TAG_RE.sub(_html_img_tag_to_plaintext, text)
    return _ESCAPED_HTML_IMG_TAG_RE.sub(_html_img_tag_to_plaintext, without_raw_images)


class DocumentExchangeService(DocumentService):
    def import_from_file(
        self,
        *,
        organization_id: str,
        space_id: str | None = None,
        file_record_id: str,
    ) -> dict[str, Any]:
        """
        Legacy sync import entrypoint.

        File imports are now created through DocumentImportJobService so large
        or slow parses do not block the HTTP request.
        """
        metrics = get_tabdoc_metrics()
        try:
            # ：只校验 Organization；space_id 废弃忽略
            if not self.check_organization_permission(organization_id, required_role="editor"):
                raise PermissionError(_("tabdoc.no_permission_to_import"))

            # INT-24: 校验 file_record_id 归属当前 organization，防止 IDOR 水平越权
            from apps.services.oss.models import FileRecord
            try:
                FileRecord.objects.only("id").get(
                    pk=file_record_id, organization_id=organization_id,
                )
            except FileRecord.DoesNotExist:
                raise PermissionError(_("tabdoc.file_not_in_organization"))

            raise RuntimeError("TabDoc 文件导入已迁移到后台 Job，请使用 /api/tabdoc/import/jobs")
        except Exception:
            metrics.record_import_failure()
            logger.error(
                "import_from_file failed: file_record=%s organization=%s",
                file_record_id, organization_id, exc_info=True,
            )
            raise

    def import_markdown_draft(
        self,
        *,
        organization_id: str,
        space_id: str | None = None,
        markdown: str,
    ) -> dict[str, Any]:
        metrics = get_tabdoc_metrics()
        try:
            # ：只校验 Organization；space_id 废弃忽略
            if not self.check_organization_permission(organization_id, required_role="editor"):
                raise PermissionError(_("tabdoc.no_permission_to_import"))

            normalized_markdown = (markdown or "").replace("\r\n", "\n").replace("\r", "\n")
            pm_json = markdown_to_pm_json(normalized_markdown)
            plaintext = self._normalize_plaintext(normalized_markdown)
            metrics.record_import_success()
            return {
                "pm_json": pm_json,
                "markdown": normalized_markdown,
                "plaintext": plaintext,
            }
        except Exception:
            metrics.record_import_failure()
            logger.error(
                "import_markdown_draft failed: organization=%s",
                organization_id, exc_info=True,
            )
            raise

    _SUPPORTED_EXPORT_FORMATS = ("markdown", "html", "txt", "docx", "pdf")

    def export_document_content(
        self,
        document: Document,
        *,
        export_format: str,
    ) -> dict[str, Any]:
        if not self.check_document_permission(document, required_role="viewer"):
            raise PermissionError(_("tabdoc.no_permission_to_export"))

        pm_json, markdown = self._resolve_document_content(document)
        normalized_format = (export_format or "markdown").strip().lower()
        safe_title = self._safe_filename(document.title)

        if normalized_format == "markdown":
            return {
                "format": "markdown",
                "content": self._build_markdown_export_document(markdown, document.title),
                "mime_type": "text/markdown; charset=utf-8",
                "filename": f"{safe_title}.md",
            }

        if normalized_format == "html":
            html_content = self._build_export_body_html(pm_json, markdown)
            return {
                "format": "html",
                "content": self._build_html_export_document(document, html_content),
                "mime_type": "text/html; charset=utf-8",
                "filename": f"{safe_title}.html",
            }

        if normalized_format == "txt":
            plaintext = self._build_txt_export_body(
                pm_json,
                markdown,
                getattr(document, "description_plaintext", ""),
            )
            return {
                "format": "txt",
                "content": self._build_plaintext_export_document(plaintext, document.title),
                "mime_type": "text/plain; charset=utf-8",
                "filename": f"{safe_title}.txt",
            }

        if normalized_format == "docx":
            docx_bytes = self._build_docx(pm_json, markdown, document.title)
            return {
                "format": "docx",
                "content_bytes": docx_bytes,
                "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "filename": f"{safe_title}.docx",
            }

        if normalized_format == "pdf":
            # Playwright 资源策略只放行平台资产；外链 PNG/JPEG 需先内联为 data URI
            pdf_pm_json = self._pm_json_with_inlined_remote_images(pm_json)
            html_content = self._build_export_body_html(pdf_pm_json, markdown)
            pdf_bytes = self._build_pdf(document, html_content)
            return {
                "format": "pdf",
                "content_bytes": pdf_bytes,
                "mime_type": "application/pdf",
                "filename": f"{safe_title}.pdf",
            }

        raise ValueError(
            f"不支持的导出格式: {export_format}，"
            f"支持的格式: {', '.join(self._SUPPORTED_EXPORT_FORMATS)}"
        )

    # ── 内部工具方法 ──────────────────────────────────────────────────

    def _resolve_document_content(self, document: Document) -> tuple[dict, str]:
        """从 Document 解析出 pm_json 和 markdown，兼容旧 Revision 数据。

        优先级：description_binary（via collab-live）→ description_json → latest_revision
        """
        fallback_pm_json, fallback_markdown = self._resolve_from_stored_fields(document)
        if document.description_binary:
            result = self._resolve_from_binary(document.description_binary, document.id)
            if result:
                binary_pm_json, binary_markdown = result
                if not self._is_binary_result_degraded(binary_pm_json, fallback_pm_json, fallback_markdown):
                    return self._materialize_private_images(
                        document,
                        binary_pm_json,
                        binary_markdown,
                    )
                logger.warning(
                    "export: binary→formats result degraded for doc %s, "
                    "falling back to description_json/markdown",
                    document.id,
                )

        return self._materialize_private_images(
            document,
            fallback_pm_json,
            fallback_markdown,
        )

    @staticmethod
    def _materialize_private_images(
        document: Document,
        pm_json: dict,
        fallback_markdown: str,
    ) -> tuple[dict, str]:
        from apps.tabdoc.services.image_asset_service import ImageAssetService

        materialized = ImageAssetService.materialize_pm_json(document, pm_json)
        return materialized, pm_json_to_markdown(materialized) or fallback_markdown

    def _resolve_from_stored_fields(self, document: Document) -> tuple[dict, str]:
        pm_json = document.description_json or {}
        markdown = (document.description_markdown or "").strip()
        if not pm_json or pm_json == {}:
            latest_revision = self.get_latest_revision(document)
            if latest_revision:
                pm_json = latest_revision.content_pm_json or {}
                markdown = (latest_revision.content_markdown or "").strip()
        if pm_json and self._pm_json_needs_fresh_markdown(pm_json):
            fresh_markdown = pm_json_to_markdown(pm_json)
            if fresh_markdown:
                markdown = fresh_markdown
        elif not markdown:
            markdown = pm_json_to_markdown(pm_json)
        if not markdown:
            markdown = document.description_plaintext or ""
        return pm_json, markdown

    @staticmethod
    def _pm_json_needs_fresh_markdown(pm_json: dict) -> bool:
        if not isinstance(pm_json, dict):
            return False

        def walk(node: dict) -> bool:
            node_type = node.get("type")
            if node_type in {"image", "mathematics", "tabdataBlock", "tabwhiteboard"}:
                return True
            marks = node.get("marks")
            if isinstance(marks, list):
                for mark in marks:
                    if isinstance(mark, dict) and mark.get("type") in {"highlight", "underline", "textStyle"}:
                        return True
            children = node.get("content")
            if isinstance(children, list):
                return any(walk(child) for child in children if isinstance(child, dict))
            return False

        return walk(pm_json)

    @staticmethod
    def _resolve_from_binary(
        binary_data: bytes | memoryview,
        document_id: Any,
    ) -> tuple[dict, str] | None:
        """通过 collab-live API 将 Y.js binary 转换为 pm_json + markdown。

        返回 None 表示转换失败，调用方应 fallback 到 JSON/Markdown 字段。
        """
        from apps.services.common.live_api import call_live_api

        try:
            from apps.collab.adapters.docs import unwrap_binary_snapshot
            raw_binary, _ = unwrap_binary_snapshot(binary_data)
            blob_b64 = base64.b64encode(raw_binary).decode()
            formats = call_live_api("/convert/binary-to-formats", {
                "binary_b64": blob_b64,
            })
            pm_json = formats.get("json", {})
            markdown = (formats.get("markdown", "") or "").strip()
            if pm_json:
                derived_markdown = pm_json_to_markdown(pm_json)
                if derived_markdown:
                    markdown = derived_markdown
            if pm_json or markdown:
                return pm_json, markdown
            return None
        except Exception:
            logger.warning(
                "export: binary→formats conversion failed for doc %s, "
                "falling back to JSON/Markdown fields",
                document_id,
                exc_info=True,
            )
            return None

    @staticmethod
    def _is_binary_result_degraded(
        binary_pm_json: dict,
        fallback_pm_json: dict,
        fallback_markdown: str = "",
    ) -> bool:
        """Return True when live conversion clearly lost content from stored JSON."""
        fallback_stats = DocumentExchangeService._collect_pm_json_stats(fallback_pm_json)
        if fallback_stats["node_count"] == 0:
            binary_stats = DocumentExchangeService._collect_pm_json_stats(binary_pm_json)
            return bool(
                fallback_markdown.strip()
                and binary_stats["escaped_img_text_nodes"] > 0
                and (
                    "<img" in fallback_markdown
                    or "&lt;img" in fallback_markdown
                    or "![" in fallback_markdown
                )
            )

        binary_stats = DocumentExchangeService._collect_pm_json_stats(binary_pm_json)
        if binary_stats["node_count"] == 0:
            return True

        if (
            fallback_stats["image_nodes"] > binary_stats["image_nodes"]
            and binary_stats["escaped_img_text_nodes"] > 0
        ):
            return True

        fallback_top_blocks = fallback_stats["top_blocks"]
        binary_top_blocks = binary_stats["top_blocks"]
        if fallback_top_blocks >= 3 and binary_top_blocks <= max(1, fallback_top_blocks // 2):
            fallback_text_chars = fallback_stats["text_chars"]
            binary_text_chars = binary_stats["text_chars"]
            if fallback_text_chars == 0 or binary_text_chars < fallback_text_chars * 0.7:
                return True

        return False

    @staticmethod
    def _collect_pm_json_stats(pm_json: dict) -> dict[str, int]:
        if not isinstance(pm_json, dict):
            return {
                "top_blocks": 0,
                "node_count": 0,
                "image_nodes": 0,
                "escaped_img_text_nodes": 0,
                "text_chars": 0,
            }

        content = pm_json.get("content")
        top_nodes = [item for item in content if isinstance(item, dict)] if isinstance(content, list) else []
        stats = {
            "top_blocks": len(top_nodes),
            "node_count": 0,
            "image_nodes": 0,
            "escaped_img_text_nodes": 0,
            "text_chars": 0,
        }

        def walk(node: dict) -> None:
            stats["node_count"] += 1
            node_type = node.get("type")
            if node_type == "image":
                stats["image_nodes"] += 1
            if node_type == "text":
                text = str(node.get("text") or "")
                stats["text_chars"] += len(text)
                if "<img" in text or "&lt;img" in text:
                    stats["escaped_img_text_nodes"] += 1
            children = node.get("content")
            if isinstance(children, list):
                for child in children:
                    if isinstance(child, dict):
                        walk(child)

        for top_node in top_nodes:
            walk(top_node)

        return stats

    @staticmethod
    def _safe_filename(title: str | None) -> str:
        safe = (title or "document").strip()
        safe = _CTRL_CHAR_RE.sub("", safe)
        for ch in ('/', '\\', ':', '*', '?', '"', '<', '>', '|'):
            safe = safe.replace(ch, '-')
        safe = safe.strip('- ')
        if len(safe) > 200:
            safe = safe[:200]
        return safe or "document"

    @staticmethod
    def _display_title(title: str | None) -> str:
        clean = _CTRL_CHAR_RE.sub("", title or "").strip()
        return clean or "Untitled"

    @classmethod
    def _build_markdown_export_document(cls, markdown: str, title: str | None) -> str:
        display_title = cls._display_title(title)
        body = (markdown or "").strip()
        if not body:
            return f"# {display_title}"
        return f"# {display_title}\n\n{body}"

    @classmethod
    def _build_plaintext_export_document(cls, plaintext: str, title: str | None) -> str:
        display_title = cls._display_title(title)
        body = (plaintext or "").strip()
        if not body:
            return display_title
        return f"{display_title}\n\n{body}"

    @classmethod
    def _build_txt_export_body(
        cls,
        pm_json: dict[str, Any],
        markdown: str,
        stored_plaintext: str | None = "",
    ) -> str:
        plaintext = cls._pm_json_to_plaintext(pm_json)
        if plaintext:
            return plaintext
        if (markdown or "").strip():
            markdown_plaintext = cls._pm_json_to_plaintext(markdown_to_pm_json(markdown))
            if markdown_plaintext:
                return markdown_plaintext
        return _strip_inline_image_html((stored_plaintext or "").strip() or (markdown or "").strip())

    @classmethod
    def _prepend_export_title_pm_json(
        cls,
        pm_json: dict[str, Any],
        title: str | None,
    ) -> dict[str, Any]:
        title_node = {
            "type": "heading",
            "attrs": {"level": 1},
            "content": [{"type": "text", "text": cls._display_title(title)}],
        }
        cloned = copy.deepcopy(pm_json) if isinstance(pm_json, dict) else {"type": "doc", "content": []}
        content = cloned.get("content")
        if not isinstance(content, list):
            content = []
        cloned["type"] = cloned.get("type") or "doc"
        cloned["content"] = [title_node, *content]
        return cloned

    @staticmethod
    def _build_export_body_html(pm_json: dict[str, Any], markdown: str) -> str:
        html_pm_json = DocumentExchangeService._pm_json_with_public_asset_urls(pm_json)
        html_content = pm_json_to_html(html_pm_json)
        if not html_content and markdown:
            markdown_pm_json = markdown_to_pm_json(markdown)
            markdown_pm_json = DocumentExchangeService._pm_json_with_public_asset_urls(markdown_pm_json)
            html_content = pm_json_to_html(markdown_pm_json)
        if not html_content:
            html_content = render_markdown_html(markdown)
        return html_content

    @staticmethod
    def _pm_json_with_public_asset_urls(pm_json: dict[str, Any]) -> dict[str, Any]:
        """Rewrite platform-owned image refs for downloaded HTML/PDF output."""
        if not isinstance(pm_json, dict) or not pm_json:
            return pm_json

        try:
            from apps.services.oss.services.public_assets import build_public_asset_url
        except Exception:
            logger.debug("export: public asset URL helper unavailable", exc_info=True)
            return pm_json

        cloned = copy.deepcopy(pm_json)

        def walk(node: Any) -> None:
            if not isinstance(node, dict):
                return
            if node.get("type") == "image":
                attrs = node.get("attrs")
                if isinstance(attrs, dict):
                    src = str(attrs.get("src") or "")
                    public_src = build_public_asset_url(src)
                    if public_src:
                        attrs["src"] = public_src
            children = node.get("content")
            if isinstance(children, list):
                for child in children:
                    walk(child)

        walk(cloned)
        return cloned

    @classmethod
    def _pm_json_with_inlined_remote_images(cls, pm_json: dict[str, Any]) -> dict[str, Any]:
        """将远程/平台图片下载后写成 data URI，供 PDF Playwright 安全渲染。

        PDF 资源策略故意不放行任意外链（防 SSRF）；Agent 生图等外链 PNG/JPEG
        若不内联，会在导出结果中消失。平台资产与公网 http(s) 统一走 DOCX
        同款下载逻辑，失败时保留原 src（仍可能被策略拦截）。
        """
        if not isinstance(pm_json, dict) or not pm_json:
            return pm_json

        try:
            from apps.tabdoc.services.docx_converter import (
                _batch_download_images,
                _collect_image_urls,
                image_bytes_to_data_uri,
            )
        except Exception:
            logger.debug("export: image inline helpers unavailable", exc_info=True)
            return pm_json

        # 先把平台 object key 收成可下载 URL，再批量拉取
        rewritten = cls._pm_json_with_public_asset_urls(pm_json)
        content = rewritten.get("content")
        if not isinstance(content, list):
            return rewritten

        urls = _collect_image_urls(content)
        if not urls:
            return rewritten

        downloaded = _batch_download_images(urls)
        if not downloaded:
            return rewritten

        data_uris = {
            src: image_bytes_to_data_uri(img_bytes)
            for src, img_bytes in downloaded.items()
            if img_bytes
        }
        if not data_uris:
            return rewritten

        def walk(node: Any) -> None:
            if not isinstance(node, dict):
                return
            if node.get("type") == "image":
                attrs = node.get("attrs")
                if isinstance(attrs, dict):
                    src = str(attrs.get("src") or "")
                    inlined = data_uris.get(src)
                    if inlined:
                        attrs["src"] = inlined
            children = node.get("content")
            if isinstance(children, list):
                for child in children:
                    walk(child)

        walk(rewritten)
        return rewritten

    @classmethod
    def _build_html_export_document(cls, document: Document, body_html: str) -> str:
        title = cls._display_title(getattr(document, "title", None))
        escaped_title = html.escape(title, quote=True)

        classes = ["tabdoc-export", "tabdoc-page"]
        font_style = str(getattr(document, "font_style", "") or "default").strip().lower()
        if font_style == "serif":
            classes.append("tabdoc-font-serif")
        elif font_style == "mono":
            classes.append("tabdoc-font-mono")

        properties = getattr(document, "properties", None)
        if isinstance(properties, dict) and properties.get("small_text"):
            classes.append("tabdoc-small-text")
        if bool(getattr(document, "is_full_width", False)):
            classes.append("tabdoc-full-width")

        article_class = html.escape(" ".join(classes), quote=True)
        return (
            "<!doctype html>\n"
            '<html lang="zh-CN">\n'
            "<head>\n"
            '  <meta charset="utf-8" />\n'
            '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n'
            f"  <title>{escaped_title}</title>\n"
            "  <style>\n"
            f"{_EXPORT_HTML_STYLE}\n"
            "  </style>\n"
            "</head>\n"
            "<body>\n"
            f'  <article class="{article_class}">\n'
            "    <header>\n"
            f'      <h1 class="tabdoc-export-title">{escaped_title}</h1>\n'
            "    </header>\n"
            f'    <div class="ProseMirror">{body_html}</div>\n'
            "  </article>\n"
            "</body>\n"
            "</html>"
        )

    @classmethod
    def _build_pdf(cls, document: Document, body_html: str) -> bytes:
        html_document = cls._build_html_export_document(document, body_html)
        return cls._render_html_to_pdf_bytes(html_document)

    @classmethod
    def _is_pdf_resource_url_allowed(cls, url: str) -> bool:
        parsed = urlparse(url)
        scheme = (parsed.scheme or "").lower()
        if scheme in ("", "about", "data", "blob"):
            return True
        if scheme not in ("http", "https"):
            return False

        host = (parsed.hostname or "").strip().lower().rstrip(".")
        local_object_proxy = parsed.path in _PDF_ALLOWED_LOCAL_PATHS
        if local_object_proxy and host in {"127.0.0.1", "::1", "localhost"}:
            return True

        try:
            from apps.services.oss.services.public_assets import public_asset_object_key_from_ref
            if public_asset_object_key_from_ref(url):
                return True
        except Exception:
            logger.debug("PDF export platform asset URL check failed", exc_info=True)

        return False

    @classmethod
    def _render_html_to_pdf_bytes(cls, html_document: str) -> bytes:
        def _do_render() -> bytes:
            cls._ensure_playwright_subprocess_event_loop_policy()
            try:
                from playwright.sync_api import sync_playwright
            except ImportError as exc:
                raise RuntimeError(_PDF_RENDERER_UNAVAILABLE_MESSAGE) from exc

            try:
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    try:
                        page = browser.new_page(
                            viewport={"width": 1200, "height": 1600},
                            # 2x：避免 SVG/位图按 1x 烤进 PDF 后在 Retina/打印下发糊
                            device_scale_factor=_PDF_DEVICE_SCALE_FACTOR,
                        )

                        def route_pdf_request(route):
                            request_url = route.request.url
                            if cls._is_pdf_resource_url_allowed(request_url):
                                route.continue_()
                                return
                            logger.warning("PDF export blocked unsafe resource URL: %s", request_url)
                            route.abort()

                        page.route("**/*", route_pdf_request)
                        page.set_content(html_document, wait_until="load", timeout=30_000)
                        try:
                            page.wait_for_load_state("networkidle", timeout=5_000)
                        except Exception:
                            logger.info("PDF export proceeds before all remote assets become idle")
                        page.emulate_media(media="screen")
                        pdf_bytes = page.pdf(
                            format="A4",
                            print_background=True,
                            margin={
                                "top": "18mm",
                                "right": "16mm",
                                "bottom": "18mm",
                                "left": "16mm",
                            },
                        )
                    finally:
                        browser.close()
            except RuntimeError:
                raise
            except Exception as exc:
                error_text = str(exc)
                if "Executable doesn't exist" in error_text or "playwright install" in error_text:
                    raise RuntimeError(_PDF_RENDERER_UNAVAILABLE_MESSAGE) from exc
                if isinstance(exc, NotImplementedError):
                    raise RuntimeError(
                        "PDF 导出无法启动 Playwright renderer：当前 asyncio event loop 不支持子进程"
                    ) from exc
                raise RuntimeError(f"{_PDF_RENDERER_UNAVAILABLE_MESSAGE}: {exc}") from exc

            if not isinstance(pdf_bytes, bytes) or not pdf_bytes:
                raise RuntimeError("PDF renderer 未返回有效内容")
            return pdf_bytes

        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tabdoc-pdf")
        try:
            future = pool.submit(_do_render)
            return future.result(timeout=_PDF_RENDER_TIMEOUT_SECONDS)
        except FuturesTimeoutError as exc:
            future.cancel()
            raise RuntimeError(
                f"PDF 导出超时（>{_PDF_RENDER_TIMEOUT_SECONDS}s），请稍后重试"
            ) from exc
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

    @staticmethod
    def _ensure_playwright_subprocess_event_loop_policy() -> None:
        """Daphne/Twisted may install a Windows selector loop that cannot spawn Playwright."""
        if sys.platform != "win32":
            return
        proactor_policy = getattr(asyncio, "WindowsProactorEventLoopPolicy", None)
        if proactor_policy is None:
            return
        if not isinstance(asyncio.get_event_loop_policy(), proactor_policy):
            asyncio.set_event_loop_policy(proactor_policy())

    @staticmethod
    def _pm_json_to_plaintext(pm_json: dict[str, Any]) -> str:
        """递归提取 ProseMirror JSON 中的纯文本。"""
        def _extract(node: dict) -> str:
            node_type = node.get("type", "")
            if node_type == "text":
                return _strip_inline_image_html(str(node.get("text", "")))
            if node_type == "hardBreak":
                return "\n"
            if node_type == "mathematics":
                attrs = node.get("attrs") or {}
                return str(attrs.get("latex") or attrs.get("value") or "")
            if node_type == "image":
                attrs = node.get("attrs") or {}
                alt = str(attrs.get("alt") or "")
                return f"[{alt}]" if alt else ""
            if node_type == "tabdataBlock":
                attrs = node.get("attrs") or {}
                title = str(attrs.get("title") or "未命名表格")
                return f"[表格: {title}]"
            if node_type == "htmlBlock":
                attrs = node.get("attrs") or {}
                title = str(attrs.get("title") or "未命名 HTML")
                return f"[HTML: {title}]"
            children = node.get("content", [])
            if not isinstance(children, list):
                return ""
            parts = [_extract(c) for c in children if isinstance(c, dict)]
            if node_type in ("paragraph", "heading", "blockquote", "listItem", "taskItem"):
                return "".join(parts) + "\n"
            return "".join(parts)

        content = pm_json.get("content", [])
        if not isinstance(content, list):
            return ""
        lines = [_extract(n) for n in content if isinstance(n, dict)]
        return "\n".join(line.strip() for line in "".join(lines).split("\n") if line.strip())

    @classmethod
    def _build_docx(
        cls,
        pm_json: dict[str, Any],
        markdown: str,
        title: str | None,
    ) -> bytes:
        from apps.tabdoc.services.docx_converter import pm_json_to_docx_bytes
        docx_pm_json = pm_json
        content = pm_json.get("content") if isinstance(pm_json, dict) else None
        if (not isinstance(content, list) or not content) and (markdown or "").strip():
            docx_pm_json = markdown_to_pm_json(markdown)
        return pm_json_to_docx_bytes(
            cls._prepend_export_title_pm_json(docx_pm_json, title),
            markdown_fallback=cls._build_plaintext_export_document(markdown, title),
        )
