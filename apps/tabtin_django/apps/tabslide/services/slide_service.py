"""
TabSlide 演示文稿核心业务服务

存储架构：
  - SlidePage 是唯一 source of truth（每页一行，页面级存储）
  - CAS 版本控制：latest_version + atomic update 防并发覆盖
  - 版本历史：SlideHistory 存 zlib 压缩的全量快照，支持 TTL 降采样
  - 变更记录：SlideChange 记录每次编辑操作的摘要
  - PPTX 按需生成：导出时从 SlidePage 聚合生成
  - 二进制资源走 OSS：图片/视频/音频/字体存 OSS，DB 只存 CDN URL
  - pages_data 字段已废弃，不参与任何运行时读写
"""

from __future__ import annotations
from apps.tabtinspace.services.organization_control_guard import (
    assert_organization_resource_write_allowed_optional,
)

import base64
import binascii
import ipaddress
import json
import logging
import os
import socket
import tempfile
import uuid
import zlib
from datetime import timedelta
from io import BytesIO
from pathlib import Path
import http.client
import ssl
from urllib.parse import urlparse, urljoin
from urllib.request import Request, urlopen
import re
from typing import Any, Dict, List, Optional, Tuple

from django.core.cache import cache
from django.db import models, transaction
from django.utils import timezone

from apps.tabslide.models import (
    HISTORY_MIN_INTERVAL,
    HISTORY_SNAPSHOT_INTERVAL,
    HISTORY_SNAPSHOT_MAX_AGE,
    HISTORY_TTL_FREE,
    SlideChange,
    SlideElementChange,
    SlideHistory,
    SlidePage,
    SlideProject,
)
from apps.tabslide.field_mapping import (
    MODEL_CONTENT_UPDATE_FIELDS,
    frontend_page_to_defaults,
    frontend_page_to_full_defaults,
    model_row_to_frontend_page,
    model_row_to_full_frontend_page,
)
from apps.i18n import _
from apps.tabtinspace.services.base import BaseService
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

MAX_EXPORT_IMAGE_BYTES = 20 * 1024 * 1024
MAX_DIFF_CHAIN_DEPTH = 50
IMAGE_MIME_BY_EXT = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "svg": "image/svg+xml",
    "bmp": "image/bmp",
    "webp": "image/webp",
    "tif": "image/tiff",
    "tiff": "image/tiff",
}


_JS_PROTO_ATTRS = r'(?:href|src|action|formaction|data|dynsrc|lowsrc|background|poster|xlink:href)'
_DANGEROUS_PROTOCOLS = r'(?:javascript|vbscript|data)\s*:'
# 抽取入口专用：放行光栅图 data:image（png/jpeg/gif/webp/bmp），仍拦
# data:text/html、data:image/svg+xml（可带脚本）、javascript:、vbscript:。
# dom_extractor 跑后端 headless、无用户 session，光栅 data: 无 SSRF、DoS 受
# MAX_HTML_SIZE 限制；放行后作者 base64 图能走到 postprocess 的 data:→OSS 上传路，
# slide 存的是我们自己 OSS 的图（durable + FileUsage + 随删项目 GC），不再依赖第三方外链。
_DANGEROUS_PROTOCOLS_FOR_EXTRACTION = (
    r'(?:javascript\s*:|vbscript\s*:|data\s*:(?!\s*image/(?:png|jpe?g|gif|webp|bmp)[;,]))'
)
_DANGEROUS_TAGS = r'iframe|object|embed|form|input|textarea|select|button|meta|base|link|applet'


def _inject_element_ids_from_elements(html: str, elements: list[dict]) -> str:
    """Inject data-element-id using IDs from extracted elements, matching by tag order.

    This ensures the IDs in page.html match those in page.elements,
    so the editor's selectElement() can find the corresponding element data.
    """
    if not html or "data-element-id" in html:
        return html

    text_and_shape_ids = [
        el.get("id", "")
        for el in elements
        if isinstance(el, dict) and el.get("type") in ("text", "shape", "image", "table")
        and el.get("id")
    ]
    if not text_and_shape_ids:
        return html

    tag_pattern = re.compile(
        r'<(h[1-6]|p|div|table|ul|ol|img|blockquote|pre)\b',
        re.IGNORECASE,
    )

    idx = [0]

    def _replacer(match: re.Match) -> str:
        if idx[0] >= len(text_and_shape_ids):
            return match.group(0)
        eid = text_and_shape_ids[idx[0]]
        idx[0] += 1
        tag = match.group(1)
        return f'<{tag} data-element-id="{eid}"'

    return tag_pattern.sub(_replacer, html)


# Phase-3 Wave-1 ECharts 修复：dom_extractor 入口处用"宽松"sanitize，保留可信的可视化脚本。
# 安全模型：dom_extractor 跑在后端 headless Chromium，没有用户 session/cookie，
# 攻击面只剩 SSRF / DoS。我们用关键字黑名单拒绝高危脚本，再让 Playwright route 拦截内网请求。
_SCRIPT_BLACKLIST_RE = re.compile(
    # 网络访问类
    r'\bfetch\s*\(|\bXMLHttpRequest\b|\bnavigator\.sendBeacon\b|'
    # 代码注入类
    r'\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(\s*["\']|'
    # 字符串求值
    r'\bsetTimeout\s*\(\s*["\']|\bsetInterval\s*\(\s*["\']|'
    # cookie / 存储窃取
    r'document\.cookie|window\.localStorage|window\.sessionStorage|'
    # 跳转
    r'window\.location\s*=|location\.replace\s*\(|location\.href\s*=',
    re.IGNORECASE,
)
_SCRIPT_MAX_BYTES = 200 * 1024  # 单条内联脚本上限 200KB，DoS 防御


def _filter_safe_inline_script(match: re.Match) -> str:
    """脚本片段白名单：保留可信的可视化脚本，拒绝高危脚本。"""
    full = match.group(0)
    # 1. 外链 script（src=）：放行 https/cdn 来源，删本地/data: 等
    src_m = re.search(r'\bsrc\s*=\s*["\']([^"\']+)["\']', full, re.IGNORECASE)
    if src_m:
        url = src_m.group(1).strip()
        # 只允许 https:// 或 // (协议相对) 的远端脚本
        if url.startswith(('https://', '//')):
            return full
        return ''
    # 2. 内联 script：内容关键字检测
    body_m = re.search(r'<script\b[^>]*>([\s\S]*?)</script>', full, re.IGNORECASE)
    if not body_m:
        return ''
    body = body_m.group(1)
    if len(body.encode('utf-8', 'replace')) > _SCRIPT_MAX_BYTES:
        return ''
    if _SCRIPT_BLACKLIST_RE.search(body):
        return ''
    return full


def _sanitize_slide_html_for_extraction(html: str) -> str:
    """专为 dom_extractor 入口设计的 sanitize：
    - 保留通过白名单的 <script>（让 ECharts / Chart.js / MathJax 等真正能执行）
    - 其他危险标签 / 属性 / 协议照常清除
    """
    if not html:
        return html
    html = re.sub(
        r'<script\b[^>]*>[\s\S]*?</script>|<script\b[^>]*/?\s*>',
        _filter_safe_inline_script,
        html,
        flags=re.IGNORECASE,
    )
    html = re.sub(r'<(' + _DANGEROUS_TAGS + r')\b[^>]*>[\s\S]*?</\1>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<(' + _DANGEROUS_TAGS + r')\b[^>]*/?\s*>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<foreignObject\b[^>]*>[\s\S]*?</foreignObject>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<foreignObject\b[^>]*/?\s*>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'\bon\w+\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>]+)', '', html, flags=re.IGNORECASE)
    html = re.sub(
        _JS_PROTO_ATTRS + r'\s*=\s*"' + _DANGEROUS_PROTOCOLS_FOR_EXTRACTION + r'[^"]*"',
        'href="#"', html, flags=re.IGNORECASE,
    )
    html = re.sub(
        _JS_PROTO_ATTRS + r"\s*=\s*'" + _DANGEROUS_PROTOCOLS_FOR_EXTRACTION + r"[^']*'",
        "href='#'", html, flags=re.IGNORECASE,
    )
    html = re.sub(
        _JS_PROTO_ATTRS + r'\s*=\s*' + _DANGEROUS_PROTOCOLS_FOR_EXTRACTION + r'[^\s>]+',
        'href="#"', html, flags=re.IGNORECASE,
    )
    return html


def _sanitize_slide_html(html: str) -> str:
    """移除 HTML 中的危险标签和事件属性，防御 XSS。"""
    if not html:
        return html
    html = re.sub(r'<script\b[^>]*>[\s\S]*?</script>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<(' + _DANGEROUS_TAGS + r')\b[^>]*>[\s\S]*?</\1>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<(' + _DANGEROUS_TAGS + r')\b[^>]*/?\s*>', '', html, flags=re.IGNORECASE)
    # I4-07: SVG 安全净化 — 保留 SVG 本身，只移除 SVG 内部的危险子元素
    # <script> 已由上方通用规则移除；这里补充移除 <foreignObject>（可嵌入任意 HTML）
    html = re.sub(r'<foreignObject\b[^>]*>[\s\S]*?</foreignObject>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<foreignObject\b[^>]*/?\s*>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'\bon\w+\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>]+)', '', html, flags=re.IGNORECASE)
    # I4-05/06: 阻断 javascript: / vbscript: / data: 协议（双引号/单引号/无引号）
    html = re.sub(
        _JS_PROTO_ATTRS + r'\s*=\s*"' + _DANGEROUS_PROTOCOLS + r'[^"]*"',
        'href="#"', html, flags=re.IGNORECASE,
    )
    html = re.sub(
        _JS_PROTO_ATTRS + r"\s*=\s*'" + _DANGEROUS_PROTOCOLS + r"[^']*'",
        "href='#'", html, flags=re.IGNORECASE,
    )
    html = re.sub(
        _JS_PROTO_ATTRS + r'\s*=\s*' + _DANGEROUS_PROTOCOLS + r'[^\s>]+',
        'href="#"', html, flags=re.IGNORECASE,
    )
    html = re.sub(
        r'xmlns\s*=\s*(?:"[^"]*"|\'[^\']*\')', '', html, flags=re.IGNORECASE,
    )
    return html


_SANITIZE_MAX_DEPTH = 5
_GROUP_CHILDREN_KEYS = ('elements', 'children', 'groupChildren')
_URL_FIELDS = ('src', 'href', 'link', 'url')
_DANGEROUS_URI_RE = re.compile(
    r'^\s*(?:javascript|vbscript|data)\s*:', re.IGNORECASE,
)
# data:image/* 是 html-spec 鼓励、inline_images 渲染链路依赖的合法图片形态
# 。仅对 **src 字段**放行；href/link/url 是导航语义，保持全量拦。
#
# 与抽取入口 `_sanitize_slide_html_for_extraction` 的差异（见
# test_extraction_sanitizer_data_image.py）：抽取入口拦 svg+xml 是因为整段 HTML
# 会加载进 Playwright 页面，SVG 作为 document 一部分可执行脚本；而这里的 src
# 只被 <img>/image 元素消费（浏览器规范：img 上下文 SVG 禁脚本、禁外部资源），
# 导出侧还会栅格化为 PNG——dom_extractor 自产的内嵌 SVG 正是 svg+xml 形态。
# MIME 后必须跟 `;` 或 `,`（真实 data URI 形态），堵 data:image/png2foo 冒充。
_SAFE_DATA_IMAGE_RE = re.compile(
    r'^\s*data:image/(?:png|jpe?g|gif|webp|bmp|svg\+xml)[;,]', re.IGNORECASE,
)


def _sanitize_url(value: str, *, allow_data_image: bool = False) -> str:
    """将含危险协议的 URL 值替换为安全占位。

    allow_data_image=True（仅 src 字段）时放行 data:image/*；
    data:text/html、javascript: 等仍替换为 '#'。
    """
    if allow_data_image and _SAFE_DATA_IMAGE_RE.match(value):
        return value
    if _DANGEROUS_URI_RE.match(value):
        return '#'
    return value


def _sanitize_dict_urls(d: dict) -> None:
    """净化字典中所有 URL 类字段。"""
    for key in _URL_FIELDS:
        val = d.get(key)
        if isinstance(val, str):
            d[key] = _sanitize_url(val, allow_data_image=(key == 'src'))


def _sanitize_elements_data(elements: list, *, _depth: int = 0) -> list:
    """对 elements_data 中的 HTML 内容做 sanitize，递归处理 group 子元素。"""
    if _depth >= _SANITIZE_MAX_DEPTH:
        return elements
    for element in elements:
        if not isinstance(element, dict):
            continue
        # I4-09: 所有元素类型的 content 都做净化（移除 type=='text' 门控）
        if isinstance(element.get('content'), str):
            element['content'] = _sanitize_slide_html(element['content'])
        text_block = element.get('text')
        if isinstance(text_block, dict) and isinstance(text_block.get('content'), str):
            text_block['content'] = _sanitize_slide_html(text_block['content'])
        props = element.get('props')
        if isinstance(props, dict):
            if isinstance(props.get('content'), str):
                props['content'] = _sanitize_slide_html(props['content'])
            props_text = props.get('text')
            if isinstance(props_text, dict) and isinstance(props_text.get('content'), str):
                props_text['content'] = _sanitize_slide_html(props_text['content'])
            _sanitize_dict_urls(props)
        # I4-08: 净化元素级 URL 字段
        _sanitize_dict_urls(element)
        for key in _GROUP_CHILDREN_KEYS:
            nested = element.get(key)
            if isinstance(nested, list) and nested:
                _sanitize_elements_data(nested, _depth=_depth + 1)
    return elements


class ConflictError(Exception):
    """并发版本冲突（CAS 检测失败）"""


class SlideNotFoundError(ValueError):
    """演示文稿项目不存在"""


class HistoryNotFoundError(ValueError):
    """版本历史记录不存在"""


class PageNotFoundError(ValueError):
    """页面不存在"""


class ElementNotFoundError(ValueError):
    """元素不存在"""


class LegacyFallbackUsed(Exception):
    """diff 链断裂或无锚点时，restore_history_data 使用了 legacy 解码路径。

    调用方必须显式 catch 此异常来获取降级路径恢复的数据，
    防止静默返回可能不完整的数据。
    """

    def __init__(self, pages: list, page_meta, reason: str, history_id, detail: str = ""):
        self.pages = pages
        self.page_meta = page_meta
        self.reason = reason
        self.history_id = history_id
        self.detail = detail
        super().__init__(
            f"SlideHistory {history_id}: legacy fallback activated "
            f"(reason={reason}) — {detail}"
        )


def build_oss_image_handler(
    *,
    organization_id: str = "",
    user_id: str = "",
    context_type: str = "slide_image",
    context_id: str = "",
):
    """
    构建 OSS 图片上传处理器（公共方法，Service / API 层均可调用）。

    返回一个 callable(blob_bytes, content_type) → url_string。
    如果 OSS 服务不可用则返回 None（降级为 base64 内联）。

    当 organization_id 非空时，上传成功后自动注册 FileRecord + FileUsage + 存储计费。
    """
    try:
        from apps.services.oss.services.factory import get_oss_service
        oss_service = get_oss_service()
        if not oss_service:
            return None
    except Exception:
        logger.debug("OSS service not available, images will use base64 inline")
        return None

    import hashlib as _hashlib
    import uuid as _uuid

    _img_counter = [0]

    def handler(blob_bytes: bytes, content_type: str) -> str:
        ext_map = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/svg+xml": "svg",
            "image/webp": "webp",
            "image/bmp": "bmp",
            "video/mp4": "mp4",
            "video/quicktime": "mov",
            "video/webm": "webm",
            "video/ogg": "ogv",
            "video/x-msvideo": "avi",
            "video/x-ms-wmv": "wmv",
            "video/mpeg": "mpeg",
            "audio/mpeg": "mp3",
            "audio/mp4": "m4a",
            "audio/aac": "aac",
            "audio/wav": "wav",
            "audio/x-wav": "wav",
            "audio/ogg": "ogg",
            "audio/flac": "flac",
            "audio/x-ms-wma": "wma",
        }
        normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
        ext = ext_map.get(normalized_content_type, "bin")
        _img_counter[0] += 1
        object_key = f"tabslide/import/{_uuid.uuid4().hex[:12]}/{_img_counter[0]}.{ext}"

        result = oss_service.upload_file(
            BytesIO(blob_bytes),
            object_key,
            content_type=content_type,
        )

        if result.get("success") and result.get("data", {}).get("access_url"):
            url = result["data"].get("cdn_url") or result["data"]["access_url"]
            logger.debug(f"Image uploaded to OSS: {object_key}")

            if organization_id:
                try:
                    from apps.services.oss.services.file_registry import FileRegistryService
                    FileRegistryService.register_uploaded_file(
                        object_key=object_key,
                        file_name=f"{_img_counter[0]}.{ext}",
                        file_size=len(blob_bytes),
                        content_type=content_type,
                        module="tabslide",
                        user_id=user_id,
                        organization_id=organization_id,
                        context_type=context_type,
                        context_id=context_id,
                        upload_source="tabslide_image_import",
                        file_hash=_hashlib.md5(blob_bytes).hexdigest(),
                        enforce_storage_quota=True,
                        is_public=True,
                    )
                except Exception:
                    logger.error("TabSlide 图片注册 FileRecord 失败, 孤儿 OSS 文件: key=%s context=%s/%s", object_key, context_type, context_id, exc_info=True)

            return url

        raise RuntimeError(f"OSS upload failed: {result.get('message', 'unknown')}")

    return handler


def _get_oss_service():
    """获取 OSS 服务实例（如不可用返回 None）。"""
    try:
        from apps.services.oss.services.factory import get_oss_service
        return get_oss_service()
    except Exception:
        logger.error("OSS 服务不可用，PPTX 导出将失败", exc_info=True)
        return None


# 预设尺寸映射
# "ppt"（16:9 主口径）= 1280×720：与 html-spec `.ppt-slide`、PPTX 页面
# （12192000 EMU = 1280×9525）1:1 对齐，HTML→JSON→PPT 全程无缩放。
# 存量 1920 项目不迁移——导出按 canvas 比例映射 EMU，行为不变。
PRESET_DIMENSIONS = {
    "ppt": (1280, 720),
    "4:3": (1024, 768),
    "xiaohongshu": (1080, 1440),
    "poster": (1080, 1920),
}

EMU_PER_INCH = 914400
PX_PER_INCH = 96

# dom_extractor 返回 flat 格式元素（content/src 等在顶层），
# pptx_io._write_element 期望 props-wrapped 格式（内容字段在 props 内）。
#
# PPTElement 顶层结构字段（与 packages/tabslide/src/types/slides.ts 的
# `PPTElementBase` 接口一一对应）。元素的"内容"字段（content/src/fill/gradient 等）
# 都嵌在 `props` 里，**不允许出现在顶层** —— 这是平台层的通用规则，
# 适用于全部 10 种元素类型（text/image/shape/line/chart/table/latex/video/audio/canvas）。
_ELEMENT_STRUCTURAL_KEYS = frozenset({
    "id", "type", "x", "y", "width", "height",
    "rotate", "opacity", "zIndex", "locked", "visible",
    # PPTElementBase optional 字段
    "name", "groupName", "flipH", "flipV", "groupId", "link",
})

# Patch 允许的顶层 key = 结构字段 + props
_PATCH_ALLOWED_TOP_KEYS: frozenset = _ELEMENT_STRUCTURAL_KEYS | frozenset({"props"})

# Phase-3 Wave-4 type-aware 校验：每种 element type **不应**出现在 props 下的字段。
# 命中即拒绝，防止"image 元素被强加 content 字段"这类数据污染（子 Agent 实测发现）。
#
# 设计原则：
#   - 只列**互斥字段**（明显跨类型借用），不做"完整白名单"——避免漏列正常字段把合法 update 误杀
#   - PPTElementBase 通用字段（rotate/opacity/locked 等）不在 props 下，不影响
#   - 不熟悉的 type 跳过（向前兼容未来新 type）
_TYPE_INCOMPATIBLE_PROPS: dict[str, frozenset[str]] = {
    "image": frozenset({
        # 文字元素特有
        "content", "lineHeight", "wordSpace", "paragraphSpace",
        "defaultFontName", "defaultFontSize", "defaultColor",
        "defaultFontWeight", "defaultColorThemeKey",
        "vertical", "autoFit", "textType", "defaultTextAlign",
        # 形状特有
        "path", "viewBox", "pathFormula", "pptxShapeType", "keypoints",
        "gradient",
        # 线条特有
        "start", "end", "points", "lineType",
        # latex / chart / table 特有
        "latex", "data", "axisX", "axisY", "themeColors", "colWidths", "rowHeights",
    }),
    "text": frozenset({
        # 图片特有
        "src", "fixedRatio", "filters", "clip", "objectFit",
        "colorMask", "altText", "imageType", "offlinePendingUpload", "radius",
        # 形状特有
        "path", "viewBox", "pathFormula", "pptxShapeType", "keypoints", "gradient",
        # 线条特有
        "start", "end", "points", "lineType",
        # chart/table/latex 特有
        "latex", "data", "axisX", "axisY", "themeColors", "options",
        "colWidths", "rowHeights",
    }),
    "shape": frozenset({
        # 文字容器特有（shape 自己的文字在 props.text.content，不在 props.content）
        "content", "lineHeight", "wordSpace", "paragraphSpace",
        # 图片特有
        "src", "filters", "clip", "objectFit", "colorMask",
        "altText", "imageType", "radius",
        # 线条特有
        "start", "end", "points", "lineType",
        # chart/table/latex 特有
        "latex", "data", "axisX", "axisY", "themeColors",
        "colWidths", "rowHeights",
    }),
    "line": frozenset({
        "content", "src", "fill", "gradient", "path", "viewBox",
        "pathFormula", "pptxShapeType", "keypoints",
        "fixedRatio", "filters", "clip", "objectFit", "colorMask",
        "altText", "lineHeight", "wordSpace", "paragraphSpace",
        "defaultFontName", "defaultFontSize", "defaultColor",
        "latex", "data", "axisX", "axisY", "options",
    }),
    "latex": frozenset({
        "content", "src", "path", "viewBox", "pathFormula",
        "pptxShapeType", "keypoints", "start", "end", "points",
        "data", "axisX", "axisY",
    }),
    "chart": frozenset({
        "content", "src", "path", "viewBox", "pathFormula",
        "pptxShapeType", "keypoints", "start", "end", "points",
        "latex",
    }),
    "table": frozenset({
        "content", "src", "path", "viewBox", "pathFormula",
        "pptxShapeType", "keypoints", "start", "end", "points",
        "latex", "axisX", "axisY", "themeColors", "options",
    }),
    "video": frozenset({
        "content", "path", "viewBox", "pathFormula", "pptxShapeType",
        "keypoints", "start", "end", "points",
        "latex", "data",
    }),
    "audio": frozenset({
        "content", "path", "viewBox", "pathFormula", "pptxShapeType",
        "keypoints", "start", "end", "points",
        "latex", "data",
    }),
}


def _props_field_belongs_to_type_hint(prop_key: str) -> str:
    """根据 incompatible 表反查这个字段更适合哪种 type，给 Agent 一个迁移提示。"""
    for type_name, incompatible in _TYPE_INCOMPATIBLE_PROPS.items():
        if prop_key in incompatible:
            continue
        # 这个 type 不排斥该字段，说明字段属于这个 type
        return type_name
    return ""


def validate_props_for_element_type(
    element_type: str, patch: dict,
) -> None:
    """type-aware 校验：patch.props 中的字段是否跟 element_type 兼容。

    命中 _TYPE_INCOMPATIBLE_PROPS 表的字段直接抛 PatchValidationError，
    防止 Agent 把 props.content 写到 image 元素这类数据污染。
    """
    if not isinstance(patch, dict):
        return
    incompatible = _TYPE_INCOMPATIBLE_PROPS.get(element_type)
    if not incompatible:
        return  # 未知 type 或没规则 → 跳过

    props = patch.get("props")
    if not isinstance(props, dict):
        return

    errors: list[dict] = []
    for key in props.keys():
        if key in incompatible:
            hint_type = _props_field_belongs_to_type_hint(key)
            hint_target = (
                f"该字段属于 type='{hint_type}' 的元素，不应出现在 type='{element_type}'"
                if hint_type and hint_type != element_type
                else f"该字段不被 type='{element_type}' 元素支持"
            )
            errors.append({
                "field": f"props.{key}",
                "hint": hint_target,
            })
    if errors:
        raise PatchValidationError(errors)


# 常见误写映射 — 给 Agent 友好的迁移提示（避免重复犯同一种错）
# 这些字段在 dom_extractor 的 flat 格式里出现在顶层，但 update 链路要求嵌入 props
_PATCH_COMMON_MISTAKES: dict[str, str] = {
    "content": "props.content",
    "src": "props.src",
    "fill": "props.fill",
    "gradient": "props.gradient",
    "outline": "props.outline",
    "shadow": "props.shadow",
    "text": "props.content",  # PPTist 老命名，常被 Agent 误用
    "color": "props.defaultColor",
    "fontSize": "props.defaultFontSize",
    "fontFamily": "props.defaultFontFamily",
    "fontWeight": "props.defaultFontWeight",
    "path": "props.path",
    "viewBox": "props.viewBox",
    "fixedRatio": "props.fixedRatio",
    "pathFormula": "props.pathFormula",
    "pptxShapeType": "props.pptxShapeType",
}


class PatchValidationError(ValueError):
    """Patch schema 校验错误。携带每个非法字段的提示，方便 Agent 自我修正。"""

    def __init__(self, errors: List[dict]):
        self.errors = errors
        msg = "; ".join(f"{e['field']}: {e['hint']}" for e in errors)
        super().__init__(msg)


def validate_element_patch(patch: Any) -> None:
    """校验单个元素 patch 的 schema。

    规则：
      1. patch 必须是非空 dict
      2. 顶层 key 必须在 `_PATCH_ALLOWED_TOP_KEYS` 范围内
         （等于 PPTElement 结构字段 ∪ {"props"}）
      3. 元素内容字段（content/src/fill/gradient/...）必须嵌入 `props`
         未嵌入 props 的会给出明确提示（"did you mean 'props.content'?"）
    抛 `PatchValidationError`（继承 `ValueError`），上层可统一捕获返回 400。
    """
    if not isinstance(patch, dict):
        raise PatchValidationError([
            {"field": "patch", "hint": f"expected dict, got {type(patch).__name__}"},
        ])
    if not patch:
        raise PatchValidationError([
            {"field": "patch", "hint": "patch is empty, nothing to update"},
        ])

    errors: List[dict] = []
    for key in patch.keys():
        if key in _PATCH_ALLOWED_TOP_KEYS:
            continue
        hint_target = _PATCH_COMMON_MISTAKES.get(key)
        if hint_target:
            errors.append({
                "field": key,
                "hint": (
                    f"unknown top-level key; element content fields belong inside "
                    f"`props`. Did you mean '{hint_target}'?"
                ),
            })
        else:
            errors.append({
                "field": key,
                "hint": (
                    f"unknown top-level key '{key}'. Allowed top-level keys: "
                    f"{sorted(_PATCH_ALLOWED_TOP_KEYS)}. "
                    f"Element content fields (content/src/fill/...) must go inside `props`."
                ),
            })
    if errors:
        raise PatchValidationError(errors)


def _flat_element_to_props_wrapped(element: dict) -> dict:
    """将 flat 格式 PPTElement 转换为 pptx_io 期望的 props-wrapped 格式。

    已经包含 props 的元素保留 props 优先级；混合格式中的顶层内容字段补入 props。
    """
    result: dict = {}
    raw_props = element.get("props")
    props: dict = dict(raw_props) if isinstance(raw_props, dict) else {}
    for key, value in element.items():
        if key in _ELEMENT_STRUCTURAL_KEYS:
            result[key] = value
        elif key == "props":
            continue
        else:
            props.setdefault(key, value)
    result["props"] = props
    return result

SOURCE_SLIDE_EMU_KEY = "_sourceSlideEmu"
FONT_META_THEME_KEY = "_tabslideFontEmbedding"
FONT_META_THEME_FONT_KEYS = ("major_latin", "major_ea", "major_cs", "minor_latin", "minor_ea", "minor_cs")
MAX_EMBEDDED_FONT_COUNT = 96
MAX_SINGLE_FONT_BASE64_LEN = 10 * 1024 * 1024
MAX_TOTAL_FONT_BASE64_LEN = 48 * 1024 * 1024
ALLOWED_FONT_STYLES = {"normal", "bold", "italic", "bolditalic"}
ALLOWED_FONT_FORMATS = {"truetype", "opentype", "woff", "woff2"}


class SlideService(BaseService):
    """
    TabSlide 核心业务服务

    继承 BaseService 获得 organization / space 级权限检查能力。
    """

    # ════════════════════════════════════════════════════════════════════
    # 辅助方法
    # ════════════════════════════════════════════════════════════════════

    def _get_project(self, slide_project_id: str, required_role: str = "viewer") -> SlideProject:
        """获取项目并检查权限"""
        try:
            project = SlideProject.objects.get(id=slide_project_id)
        except SlideProject.DoesNotExist:
            raise SlideNotFoundError(_("tabslide.project_not_found"))

        if not self.check_space_permission(str(project.space_id), required_role=required_role):
            raise PermissionError(_("tabslide.no_permission_to_operate"))

        return project

    def _resolve_dimensions(
        self,
        preset: str,
        canvas_width: Optional[int] = None,
        canvas_height: Optional[int] = None,
    ) -> tuple[int, int]:
        """根据预设和自定义值计算画布尺寸"""
        default_w, default_h = PRESET_DIMENSIONS.get(preset, (1280, 720))
        width = canvas_width if canvas_width else default_w
        height = canvas_height if canvas_height else default_h
        return width, height

    def _editor_info(self, editor_type: str = "") -> Tuple[str, str]:
        """返回 (editor_type, editor_id)，基于当前用户和指定类型。"""
        if not editor_type:
            editor_type = "user"
        editor_id = str(self.user.id) if self.user else ""
        return editor_type, editor_id

    # ════════════════════════════════════════════════════════════════════
    # CAS 版本控制
    # ════════════════════════════════════════════════════════════════════

    def _cas_save_pages(
        self,
        project: SlideProject,
        pages: list[dict],
        *,
        page_meta: dict | None = None,
        editor_type: str = "user",
        editor_id: str = "",
        base_version: Optional[int] = None,
        extra_fields: Optional[dict] = None,
    ) -> int:
        """
        CAS（Compare-And-Set）原子保存页面数据。

        事务内：select_for_update 锁行 → CAS 版本校验 → SlidePage 批量 upsert。
        失败则整体回滚。返回新版本号。
        base_version=None 时使用锁定行的 latest_version（自读自写模式）。
        """
        with transaction.atomic(using=postgres_app_db_alias()):
            # select_for_update 锁定项目行，消除 TOCTOU 窗口
            try:
                project_row = (
                    SlideProject.objects.using(postgres_app_db_alias())
                    .select_for_update()
                    .get(id=project.id)
                )
            except SlideProject.DoesNotExist:
                raise SlideNotFoundError(_("tabslide.project_not_found"))

            if base_version is None:
                base_version = project_row.latest_version
            next_version = base_version + 1

            if project_row.latest_version != base_version:
                raise ConflictError(
                    f"版本冲突：提交版本 {base_version}，当前版本 {project_row.latest_version}"
                )

            valid_page_count = sum(
                1 for p in pages
                if isinstance(p, dict) and isinstance(p.get("id"), str) and p.get("id")
            )
            update_fields = {
                "page_meta": page_meta,
                "page_count": valid_page_count,
                "pptx_dirty": True,
                "latest_version": next_version,
                "last_editor_type": editor_type,
                "last_editor_id": editor_id,
                "updated_at": timezone.now(),
            }
            if self.user:
                update_fields["updated_by"] = self.user
            if extra_fields:
                update_fields.update(extra_fields)

            SlideProject.objects.using(postgres_app_db_alias()).filter(
                id=project.id,
            ).update(**update_fields)

            # SlidePage 在事务内写入，失败则整体回滚
            self._sync_slide_pages(project, pages, version=next_version)

        project.refresh_from_db()

        return next_version

    # ════════════════════════════════════════════════════════════════════
    # SlidePage 页面级存储（Phase 1）
    # ════════════════════════════════════════════════════════════════════

    @staticmethod
    def _sync_slide_pages(
        project: SlideProject,
        pages: list[dict],
        *,
        version: int,
    ) -> None:
        """
        将 pages 列表写入 SlidePage 行存储（批量 upsert + 删除多余页）。

        必须在事务内调用，失败则整个操作回滚。
        使用 bulk_create(update_conflicts=True)，N 页仅需 1 次批量操作。
        """
        seen: dict[str, int] = {}
        for idx, page in enumerate(pages):
            page_id = page.get("id")
            if not page_id:
                logger.warning(
                    "SlideService._sync_slide_pages: pages[%d] 缺少 id，已跳过 (project=%s)",
                    idx, project.id,
                )
                continue
            if page_id in seen:
                logger.warning(
                    "SlideService._sync_slide_pages: pages[%d] 与 pages[%d] 有重复 page_id=%s，"
                    "后出现的覆盖先出现的 (project=%s)",
                    idx, seen[page_id], page_id, project.id,
                )
            seen[page_id] = idx

        incoming_page_ids = set(seen.keys())
        upsert_objects = []
        for page_id, idx in seen.items():
            page = pages[idx]
            defaults = frontend_page_to_full_defaults(page)
            upsert_objects.append(SlidePage(
                project=project,
                page_id=page_id,
                **defaults,
                order=float(idx),
                version=version,
            ))

        if upsert_objects:
            SlidePage.objects.using(postgres_app_db_alias()).bulk_create(
                upsert_objects,
                update_conflicts=True,
                unique_fields=["project", "page_id"],
                update_fields=[
                    *MODEL_CONTENT_UPDATE_FIELDS,
                    "order", "version", "updated_at",
                ],
            )

        # 删除不再存在的页面（空列表 = 清空所有页面）
        delete_qs = SlidePage.objects.using(postgres_app_db_alias()).filter(project=project)
        if incoming_page_ids:
            delete_qs = delete_qs.exclude(page_id__in=incoming_page_ids)
        delete_qs.delete()

    # _async_refresh_pages_cache — REMOVED
    # SlidePage 是唯一 source of truth，不再反向同步 pages_data。
    # 参见 docs/tabslide/single-source-of-truth.md

    @staticmethod
    def _read_pages_from_slide_pages(project: SlideProject) -> list[dict]:
        """
        从 SlidePage 行存储读取完整 pages 列表。

        SlidePage 是唯一 source of truth。返回空列表表示项目没有页面。
        """
        rows = list(
            SlidePage.objects.using(postgres_app_db_alias())
            .filter(project=project)
            .order_by("order")
        )

        return [model_row_to_frontend_page(row) for row in rows]

    @staticmethod
    def _normalize_pages_for_pptx_export(pages: list[dict]) -> list[dict]:
        """将 DB 读取页转换成 pptx_io.write 的导出契约，不改变读取 API 返回值。"""
        normalized_pages: list[dict] = []
        for page in pages:
            if not isinstance(page, dict):
                continue

            export_page = dict(page)
            elements = page.get("elements")
            if isinstance(elements, list):
                export_page["elements"] = [
                    _flat_element_to_props_wrapped(element)
                    for element in elements
                    if isinstance(element, dict)
                ]
            else:
                export_page["elements"] = []

            if not export_page.get("notes") and export_page.get("remark"):
                export_page["notes"] = export_page["remark"]

            normalized_pages.append(export_page)
        return normalized_pages

    @staticmethod
    def _extract_html_sources_by_slide(html: str, expected_pages: int) -> list[str]:
        """
        将多页 HTML 拆分为逐页 html_source（按 .ppt-slide 顺序）。

        返回长度必须与 expected_pages 一致；否则返回空列表表示拆分失败。
        """
        if expected_pages <= 0:
            return []

        raw_html = (html or "").strip()
        if expected_pages == 1:
            return [raw_html]

        try:
            from lxml import etree
            from lxml import html as lxml_html

            root = lxml_html.document_fromstring(raw_html)
            slide_nodes = root.xpath(
                "//*[contains(concat(' ', normalize-space(@class), ' '), ' ppt-slide ')]"
            )
            if len(slide_nodes) < expected_pages:
                return []

            head_nodes = root.xpath("//head")
            head_inner = ""
            if head_nodes:
                head = head_nodes[0]
                head_inner = "".join(
                    etree.tostring(child, encoding="unicode", method="html")
                    for child in head
                )

            slide_html_sources: list[str] = []
            for node in slide_nodes[:expected_pages]:
                slide_outer = etree.tostring(node, encoding="unicode", method="html")
                if head_inner:
                    slide_html_sources.append(
                        f"<html><head>{head_inner}</head><body>{slide_outer}</body></html>"
                    )
                else:
                    slide_html_sources.append(slide_outer)
            return slide_html_sources
        except Exception as exc:
            logger.warning("create_slides: split html sources failed: %s", exc)
            return []

    def save_pages_incremental(
        self,
        slide_project_id: str,
        *,
        changed_pages: dict[str, dict],
        deleted_page_ids: list[str] | None = None,
        page_order: list[str] | None = None,
        base_version: int | None = None,
        editor_type: str = "user",
        agent_run_id: str = "",
    ) -> SlideProject:
        """
        增量保存（V2）：只更新变更的页面，不全量覆盖。

        参数:
          changed_pages: { page_id: { elements: [...], background: {...}, ... } }
            只传变更的页面，未变更的页面不传。
          deleted_page_ids: 要删除的页面 ID 列表（可选）
          page_order: 页面排序列表（可选，所有 page_id 的有序数组）
          base_version: CAS 版本号

        流程:
          1. CAS 校验 + 版本递增
          2. 更新 SlidePage 行（只更新 changed_pages 中的页面）
          3. 删除 deleted_page_ids
          4. 如果 page_order 传入，更新排序
          5. 创建历史快照 + 记录变更
        """
        project = self._get_project(slide_project_id, required_role="editor")
        et, eid = self._editor_info(editor_type)

        # 净化在事务外执行（纯 CPU 操作，不涉及 DB 读取）
        for page_data in changed_pages.values():
            if not isinstance(page_data, dict):
                continue
            if "html" in page_data and isinstance(page_data["html"], str):
                page_data["html"] = _sanitize_slide_html(page_data["html"])
            if isinstance(page_data.get("elements"), list):
                _sanitize_elements_data(page_data["elements"])

        if deleted_page_ids:
            overlap = set(changed_pages.keys()) & set(deleted_page_ids)
            if overlap:
                logger.warning(
                    "save_pages_incremental: overlap between changed_pages and deleted_page_ids: %s (project=%s), "
                    "delete takes precedence",
                    overlap, slide_project_id,
                )
                for pid in overlap:
                    del changed_pages[pid]

        now = timezone.now()
        changed_page_ids = list(changed_pages.keys())

        with transaction.atomic(using=postgres_app_db_alias()):
            # select_for_update 锁行，消除 TOCTOU 窗口（对齐 batch_update_elements）
            try:
                project_row = (
                    SlideProject.objects.using(postgres_app_db_alias())
                    .select_for_update()
                    .get(id=project.id)
                )
            except SlideProject.DoesNotExist:
                raise SlideNotFoundError(_("tabslide.project_not_found"))

            if base_version is None:
                base_version = project_row.latest_version
            next_version = base_version + 1

            if project_row.latest_version != base_version:
                raise ConflictError(
                    f"版本冲突：提交版本 {base_version}，当前版本 {project_row.latest_version}"
                )

            # JSON-first：html_source / content_format 在 frontend_page_to_defaults 内
            # 被 _SEALED_AFTER_CREATION_MODEL_FIELDS 守卫丢弃，无需在此再校验。

            # CAS 推进版本号
            SlideProject.objects.using(postgres_app_db_alias()).filter(
                id=project.id,
            ).update(
                latest_version=next_version,
                last_editor_type=et,
                last_editor_id=eid,
                updated_at=now,
                **({"updated_by": self.user} if self.user else {}),
            )

            pages_affected = list(changed_pages.keys())

            from apps.tabslide.services.pptx_cache import mark_pages_dirty
            mark_pages_dirty(project.id, pages_affected)
            existing_rows = {
                row.page_id: row
                for row in SlidePage.objects.using(postgres_app_db_alias())
                .filter(project=project, page_id__in=pages_affected)
                .only("id", "page_id", "order", *MODEL_CONTENT_UPDATE_FIELDS)
            }

            max_order_agg = SlidePage.objects.using(postgres_app_db_alias()).filter(
                project=project,
            ).aggregate(_max=models.Max("order"))
            current_max_order = max_order_agg["_max"] if max_order_agg["_max"] is not None else -1.0
            new_page_counter = 0

            upsert_objects = []
            for page_id, page_data in changed_pages.items():
                existing = existing_rows.get(page_id)
                if existing:
                    defaults = frontend_page_to_defaults(page_data)
                    for field, value in defaults.items():
                        setattr(existing, field, value)
                    existing.version = next_version
                    upsert_objects.append(existing)
                else:
                    full_defaults = frontend_page_to_full_defaults(page_data)
                    new_page_counter += 1
                    upsert_objects.append(SlidePage(
                        project=project,
                        page_id=page_id,
                        **full_defaults,
                        order=current_max_order + new_page_counter,
                        version=next_version,
                    ))

            if upsert_objects:
                SlidePage.objects.using(postgres_app_db_alias()).bulk_create(
                    upsert_objects,
                    update_conflicts=True,
                    unique_fields=["project", "page_id"],
                    update_fields=[
                        *MODEL_CONTENT_UPDATE_FIELDS,
                        "version", "updated_at",
                    ],
                )

            # 删除页面
            if deleted_page_ids:
                SlidePage.objects.using(postgres_app_db_alias()).filter(
                    project=project,
                    page_id__in=deleted_page_ids,
                ).delete()
                pages_affected.extend(deleted_page_ids)

            # 更新排序（批量写入，避免 N×UPDATE）
            if page_order:
                order_map = {pid: float(idx) for idx, pid in enumerate(page_order)}
                pages_to_reorder = list(
                    SlidePage.objects.using(postgres_app_db_alias()).filter(
                        project=project, page_id__in=page_order,
                    )
                )
                for page in pages_to_reorder:
                    page.order = order_map[page.page_id]
                if pages_to_reorder:
                    SlidePage.objects.using(postgres_app_db_alias()).bulk_update(
                        pages_to_reorder, ["order"], batch_size=200,
                    )

        project.refresh_from_db()

        from apps.tabslide.post_save import run_post_save_hooks
        run_post_save_hooks(
            project,
            version=next_version,
            pages_affected=pages_affected or None,
            change_type="save_pages",
            summary=f"增量保存 {len(changed_pages)} 页" + (
                f"，删除 {len(deleted_page_ids)} 页" if deleted_page_ids else ""
            ),
            editor_type=et,
            editor_id=eid,
            create_history=True,
            agent_run_id=agent_run_id,
        )

        push_pages = [
            {"page_id": pid, **pdata}
            for pid, pdata in changed_pages.items()
        ]
        self._push_pages_to_ydoc(
            project, push_pages,
            page_order=page_order,
            source="save_pages_incremental",
        )

        return project

    # ════════════════════════════════════════════════════════════════════
    # 版本历史
    # ════════════════════════════════════════════════════════════════════

    # ════════════════════════════════════════════════════════════════════
    # 增量版本历史（Phase 4）
    # ════════════════════════════════════════════════════════════════════

    @staticmethod
    def _pages_to_blob(pages: list) -> bytes:
        """pages 列表 → zlib 压缩 JSON bytes"""
        return zlib.compress(
            json.dumps(pages, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            level=6,
        )

    @staticmethod
    def _blob_to_pages(blob: bytes) -> list:
        """zlib 压缩 bytes → pages 列表"""
        return json.loads(zlib.decompress(blob).decode("utf-8"))

    @staticmethod
    def _try_decode_legacy_pages(blob: bytes) -> list | None:
        """
        兼容旧数据：尝试将 blob 解析为全量 pages 列表。

        仅当解压后顶层是 list 才视为合法 pages；dict（diff 结构）不接受。
        """
        try:
            payload = json.loads(zlib.decompress(blob).decode("utf-8"))
        except Exception:
            return None
        return payload if isinstance(payload, list) else None

    @staticmethod
    def _compute_page_diff(old_pages: list, new_pages: list) -> dict:
        """
        计算页面级增量 diff。

        返回格式：
        {
            "added": [{"page_id": ..., "data": {...}}, ...],
            "removed": ["page_id_1", "page_id_2"],
            "changed": [{"page_id": ..., "data": {...}}, ...],
            "order": ["page_id_1", "page_id_2", ...]  # 新的页面顺序
        }

        比全量快照节省 50-95% 存储空间（大多数编辑只改 1-2 页）。
        """
        old_map: Dict[str, dict] = {}
        for page in old_pages:
            pid = page.get("id", "")
            if pid:
                old_map[pid] = page

        new_map: Dict[str, dict] = {}
        new_order: List[str] = []
        for page in new_pages:
            pid = page.get("id", "")
            if pid:
                new_map[pid] = page
                new_order.append(pid)

        added = []
        changed = []
        removed = []

        for pid, new_page in new_map.items():
            if pid not in old_map:
                added.append({"page_id": pid, "data": new_page})
            else:
                # sort_keys 确保 dict key 顺序一致，避免因序列化顺序差异导致误判
                old_json = json.dumps(old_map[pid], ensure_ascii=False, separators=(",", ":"), sort_keys=True)
                new_json = json.dumps(new_page, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
                if old_json != new_json:
                    changed.append({"page_id": pid, "data": new_page})

        for pid in old_map:
            if pid not in new_map:
                removed.append(pid)

        return {
            "added": added,
            "removed": removed,
            "changed": changed,
            "order": new_order,
        }

    @staticmethod
    def _apply_page_diff(base_pages: list, diff: dict) -> list:
        """将增量 diff 应用到 base_pages 上，返回完整 pages。"""
        page_map: Dict[str, dict] = {}
        for page in base_pages:
            pid = page.get("id", "")
            if pid:
                page_map[pid] = page

        for pid in diff.get("removed", []):
            page_map.pop(pid, None)

        for item in diff.get("changed", []):
            pid = item["page_id"]
            if pid not in page_map:
                logger.warning(
                    "_apply_page_diff: changed page_id=%s not in base_pages, inserting as new",
                    pid,
                )
            page_map[pid] = item["data"]

        for item in diff.get("added", []):
            pid = item["page_id"]
            page_map[pid] = item["data"]

        order = diff.get("order", [])
        result = []
        for pid in order:
            if pid in page_map:
                result.append(page_map[pid])
        for pid, page in page_map.items():
            if pid not in order:
                result.append(page)

        return result

    def _find_last_snapshot(self, project: SlideProject) -> Optional[SlideHistory]:
        """找到该项目最近的全量快照（锚点）。"""
        return (
            project.histories.using(postgres_app_db_alias())
            .filter(is_snapshot=True)
            .order_by("-created_at")
            .first()
        )

    def _count_diffs_since_snapshot(
        self, project: SlideProject, snapshot: Optional[SlideHistory],
    ) -> int:
        """计算自上次全量快照以来的增量 diff 数量。"""
        if not snapshot:
            return HISTORY_SNAPSHOT_INTERVAL  # 无锚点 → 强制全量
        return (
            project.histories.using(postgres_app_db_alias())
            .filter(is_snapshot=False, created_at__gt=snapshot.created_at)
            .count()
        )

    def _should_create_full_snapshot(
        self,
        project: SlideProject,
        last_snapshot: Optional[SlideHistory],
        diff_count: int,
    ) -> bool:
        """判断是否应该创建全量快照而非增量 diff。"""
        if diff_count >= HISTORY_SNAPSHOT_INTERVAL:
            return True
        if not last_snapshot:
            return True
        elapsed = (timezone.now() - last_snapshot.created_at).total_seconds()
        if elapsed >= HISTORY_SNAPSHOT_MAX_AGE:
            return True
        return False

    SLIDE_HISTORY_LOCK_TTL = 120

    def create_history_snapshot(
        self,
        project: SlideProject,
        *,
        editor_type: str = "",
        editor_id: str = "",
        ttl_seconds: int = HISTORY_TTL_FREE,
        force: bool = False,
    ) -> Optional[SlideHistory]:
        """
        [已废弃] 私有 SlideHistory 写入路径，已被统一 VersionHistory 替代。

        版本历史现在通过 post_save.py 中的 _write_unified_version_best_effort()
        统一写入 VersionHistory + ChangeLog。

        保留函数签名以兼容可能残留的调用方，但不再实际创建 SlideHistory 记录。
        存量 SlideHistory 数据通过 migrate_slide_histories_incremental 迁移任务逐步迁移到 VH。
        """
        import warnings
        warnings.warn(
            "create_history_snapshot 已废弃，版本历史统一写入 VersionHistory。"
            "此函数现为 no-op，不再创建 SlideHistory 记录。",
            DeprecationWarning,
            stacklevel=2,
        )
        logger.info(
            "[DEPRECATED] create_history_snapshot 被调用但已为 no-op: project=%s editor=%s/%s",
            project.id, editor_type, editor_id,
        )
        return None

    @staticmethod
    def restore_history_data(history: SlideHistory) -> Tuple[list, dict | None]:
        """
        从 SlideHistory 还原页面数据。

        全量快照：直接解压 blob。
        增量 diff：沿 base_history 链回溯到最近的全量锚点，依次应用 diff。

        返回值第二项 page_meta_snapshot 已废弃（始终为 None），保留签名兼容。
        """
        if history.is_snapshot:
            blob = bytes(history.blob)
            pages = json.loads(zlib.decompress(blob).decode("utf-8"))
            return pages, history.page_meta_snapshot

        # 增量 diff → 回溯 diff 链
        diff_chain: list[SlideHistory] = [history]
        current = history
        while current.base_history_id:
            if len(diff_chain) > MAX_DIFF_CHAIN_DEPTH:
                logger.error(
                    "SlideHistory diff chain exceeded max depth %d: %s",
                    MAX_DIFF_CHAIN_DEPTH, history.id,
                )
                raise ValueError(_("tabslide.history_chain_too_deep"))
            try:
                base = SlideHistory.objects.using(postgres_app_db_alias()).get(id=current.base_history_id)
            except SlideHistory.DoesNotExist:
                logger.error(
                    "SlideHistory diff chain broken: %s -> missing %s",
                    current.id, current.base_history_id,
                )
                # 仅兼容“旧版误标记为 diff 的全量快照”；diff 结构禁止当 pages 使用。
                legacy_pages = SlideService._try_decode_legacy_pages(bytes(history.blob))
                if legacy_pages is not None:
                    logger.error(
                        "SlideHistory %s: diff chain broken, legacy fallback "
                        "activated (page_count=%d, missing_base=%s) — "
                        "data may be incomplete or stale",
                        history.id, len(legacy_pages), current.base_history_id,
                    )
                    raise LegacyFallbackUsed(
                        pages=legacy_pages,
                        page_meta=history.page_meta_snapshot,
                        reason="chain_broken",
                        history_id=history.id,
                        detail=(
                            f"missing base_history {current.base_history_id}, "
                            f"decoded {len(legacy_pages)} legacy pages"
                        ),
                    )
                raise ValueError(_("tabslide.history_chain_broken"))

            if base.is_snapshot:
                # 找到锚点
                base_pages = json.loads(zlib.decompress(bytes(base.blob)).decode("utf-8"))
                # 从锚点开始，按时间顺序（正序）依次应用 diff
                for diff_history in reversed(diff_chain):
                    diff_data = json.loads(zlib.decompress(bytes(diff_history.blob)).decode("utf-8"))
                    if not isinstance(diff_data, dict):
                        raise ValueError(_("tabslide.history_diff_corrupted"))
                    base_pages = SlideService._apply_page_diff(base_pages, diff_data)
                return base_pages, history.page_meta_snapshot

            diff_chain.append(base)
            current = base

        logger.error(
            "SlideHistory diff chain has no anchor: %s "
            "(chain_depth=%d, project=%s)",
            history.id, len(diff_chain), history.project_id,
        )
        legacy_pages = SlideService._try_decode_legacy_pages(bytes(history.blob))
        if legacy_pages is not None:
            logger.error(
                "SlideHistory %s: no anchor found, legacy fallback "
                "activated (page_count=%d) — data may be incomplete or stale",
                history.id, len(legacy_pages),
            )
            raise LegacyFallbackUsed(
                pages=legacy_pages,
                page_meta=history.page_meta_snapshot,
                reason="no_anchor",
                history_id=history.id,
                detail=f"no snapshot anchor in chain of depth {len(diff_chain)}, "
                       f"decoded {len(legacy_pages)} legacy pages",
            )
        raise ValueError(_("tabslide.history_no_anchor"))

    def create_named_version(
        self,
        slide_project_id: str,
        name: str = "",
    ) -> "SlideHistory | VersionHistory":
        """创建命名版本（用户手动保存的里程碑，永不过期）。

        优先通过统一 VersionHistory 创建；VH 失败时不再 fallback 到 SlideHistory。
        """
        project = self._get_project(slide_project_id, required_role="editor")

        pages = self._read_pages_from_slide_pages(project)
        if not pages:
            raise ValueError(_("tabslide.no_pages_for_named_version"))

        editor_type, editor_id = self._editor_info("user")
        version_name = name or f"版本 v{project.latest_version}"

        from apps.collab.registry import get_adapter
        from apps.collab.service import VersionHistoryService

        adapter = get_adapter("slide")
        if adapter:
            version_data = adapter.get_version_data(project)
            editor_info = {"editor_type": editor_type, "editor_id": editor_id}
            svc = VersionHistoryService(adapter)
            vh = svc.create_named_version(
                project.id,
                version_name,
                version_data,
                editor_info,
                organization_id=project.organization_id,
            )
            if vh:
                logger.info(
                    "Named version created via VH: project=%s name=%s vh=%s",
                    project.id, version_name, vh.id,
                )
                return vh

        # P2: 私有 SlideHistory 写入路径已下线
        raise RuntimeError(
            f"VersionHistory create_named_version 失败，无法为演示文稿 {project.id} "
            f"创建命名版本 {version_name!r}。私有 SlideHistory 写入路径已下线。"
        )

    def list_histories(
        self,
        slide_project_id: str,
        *,
        include_named_only: bool = False,
        limit: int = 50,
    ) -> list[SlideHistory]:
        """列出版本历史记录。"""
        project = self._get_project(slide_project_id, required_role="viewer")
        qs = project.histories.using(postgres_app_db_alias()).order_by("-created_at")
        if include_named_only:
            qs = qs.filter(is_named=True)
        return list(qs[:limit])

    def restore_history(
        self,
        slide_project_id: str,
        history_id: str,
    ) -> Tuple[SlideProject, list]:
        """恢复到指定的历史版本。

        优先通过统一 VersionHistory 恢复；如果 VH 中无对应记录，
        回退到私有 SlideHistory 只读兼容路径（读取存量旧数据）。
        """
        project = self._get_project(slide_project_id, required_role="editor")

        # 优先尝试通过统一 VersionHistory 恢复
        try:
            from apps.collab.registry import get_adapter
            from apps.collab.service import RebuildError, RestoreError, VersionHistoryService
            from apps.collab.models import VersionHistory
            from django.core.exceptions import ObjectDoesNotExist

            vh = VersionHistory.objects.using(postgres_app_db_alias()).filter(
                id=history_id, resource_type="slide", resource_id=project.id,
            ).first()
            if vh:
                adapter = get_adapter("slide")
                svc = VersionHistoryService(adapter)
                editor_type, editor_id = self._editor_info("user")
                restored_vh = svc.restore_to_version(
                    project.id,
                    vh.id,
                    {"editor_type": editor_type, "editor_id": editor_id},
                    resource=project,
                    target=vh,
                    organization_id=project.organization_id,
                )
                project.refresh_from_db()
                pages = self._read_pages_from_slide_pages(project)
                return project, pages
        except (VersionHistory.DoesNotExist, ObjectDoesNotExist, RebuildError):
            logger.warning(
                "restore_history: VH 中未找到可用版本 project=%s version=%s，"
                "回退到 SlideHistory",
                slide_project_id, history_id, exc_info=True,
            )
        except RestoreError:
            logger.warning(
                "restore_history: VH restore 业务错误 project=%s version=%s，"
                "回退到 SlideHistory",
                slide_project_id, history_id, exc_info=True,
            )

        # [只读兼容路径] 回退到私有 SlideHistory（存量旧数据）
        try:
            history = SlideHistory.objects.using(postgres_app_db_alias()).get(
                id=history_id, project=project,
            )
        except SlideHistory.DoesNotExist:
            raise HistoryNotFoundError(_("tabslide.history_not_found"))

        try:
            pages, page_meta = self.restore_history_data(history)
        except LegacyFallbackUsed as lf:
            logger.warning(
                "restore_history for project %s version %s using legacy "
                "fallback: %s (reason=%s)",
                slide_project_id, history_id, lf.detail, lf.reason,
            )
            pages = lf.pages
            page_meta = lf.page_meta
        editor_type, editor_id = self._editor_info("user")

        new_version = self._cas_save_pages(
            project,
            pages,
            page_meta=page_meta,
            editor_type=editor_type,
            editor_id=editor_id,
        )

        all_page_ids = [p.get("id") or p.get("page_id") for p in pages if isinstance(p, dict)]
        all_page_ids = [pid for pid in all_page_ids if pid]

        from apps.tabslide.post_save import run_post_save_hooks
        run_post_save_hooks(
            project,
            version=new_version,
            pages_affected=all_page_ids or None,
            change_type="restore_history",
            summary=f"恢复到版本 v{history.version}" + (f" ({history.name})" if history.name else ""),
            editor_type=editor_type,
            editor_id=editor_id,
            create_history=True,
            force_history=True,
        )

        self._push_pages_to_ydoc(project, pages, source="restore_history")

        try:
            from apps.collab.api import _force_close_collab_document
            _force_close_collab_document("slide", str(project.id))
        except Exception:
            logger.warning(
                "restore_history: _force_close_collab_document failed for project=%s (non-fatal)",
                project.id, exc_info=True,
            )

        try:
            from apps.collab.adapters.slide import SlideCollabAdapter
            from apps.collab.service import VersionHistoryService

            adapter = SlideCollabAdapter()
            svc = VersionHistoryService(adapter)
            version_data = adapter.get_version_data(project)
            editor_info = {"editor_type": editor_type, "editor_id": editor_id}
            svc.create_history(
                project.id, version_data, editor_info,
                force_snapshot=True,
                organization_id=project.organization_id,
            )
        except Exception:
            logger.warning(
                "restore_history: VH snapshot write failed for project=%s (non-fatal, data already restored)",
                project.id, exc_info=True,
            )

        return project, pages

    def restore_pages_from_snapshot(
        self,
        project: SlideProject,
        pages: list[dict],
        page_meta: dict | None = None,
        extra_fields: dict | None = None,
        *,
        create_history: bool = True,
        editor_type: str = "user",
    ) -> SlideProject:
        """从快照数据恢复页面（供 undo-last-agent-edit / collab restore 调用）。

        extra_fields 用于同步恢复 SlideProject 上的非页面字段
        （如 theme、font_meta），通过 _cas_save_pages 一同写入。

        create_history=False 时跳过 SlideHistory 写入，
        避免 collab 统一框架 restore 后私有表多出重复快照（TSV-011）。

        editor_type 支持 "user" / "agent" / "system"，
        用于审计日志准确归因（TSV-012）。
        """
        et, eid = self._editor_info(editor_type)
        new_version = self._cas_save_pages(
            project,
            pages,
            page_meta=page_meta,
            editor_type=et,
            editor_id=eid,
            extra_fields=extra_fields,
        )

        all_page_ids = [p.get("id") or p.get("page_id") for p in pages if isinstance(p, dict)]
        all_page_ids = [pid for pid in all_page_ids if pid]

        from apps.tabslide.post_save import run_post_save_hooks
        run_post_save_hooks(
            project,
            version=new_version,
            pages_affected=all_page_ids or None,
            change_type="undo_agent_edit",
            summary="撤销 Agent 编辑",
            editor_type=et,
            editor_id=eid,
            create_history=create_history,
            force_history=create_history,
        )

        self._push_pages_to_ydoc(project, pages, source="restore_pages_from_snapshot")
        return project

    # ════════════════════════════════════════════════════════════════════
    # Y.js 同步辅助
    # ════════════════════════════════════════════════════════════════════

    @staticmethod
    def _push_pages_to_ydoc(
        project,
        pages: list[dict],
        page_order: list[str] | None = None,
        source: str = "",
    ) -> None:
        """Fire-and-forget: 将页面级变更推送到 Y.js 协同层。
        DB 已先行持久化，此处仅做 Y.Doc 同步。失败时记录错误但不阻塞。"""
        try:
            from apps.tabslide.services.collab_service import SlideCollabService

            normalized = []
            for p in pages:
                if not isinstance(p, dict):
                    continue
                pid = p.get("page_id") or p.get("id")
                if not pid:
                    continue
                if "page_id" not in p:
                    p = {**p, "page_id": pid}
                normalized.append(p)

            result = SlideCollabService.push_pages(
                project_id=str(project.id),
                pages=normalized,
                page_order=page_order,
                agent_id=f"system:{source}",
                editor_type="system",
            )
            if isinstance(result, dict) and "error" in result:
                logger.warning(
                    "Y.js page push returned error (DB safe, Y.Doc needs refresh): "
                    "project=%s source=%s error=%s",
                    project.id, source, result.get("error", ""),
                )
        except Exception as exc:
            logger.warning(
                "Slide Y.js page push failed (non-blocking): project=%s source=%s err=%s",
                project.id, source, exc,
            )

    # ════════════════════════════════════════════════════════════════════
    # 变更记录
    # ════════════════════════════════════════════════════════════════════

    @staticmethod
    def _record_change(
        project: SlideProject,
        *,
        version: int,
        change_type: str,
        summary: str = "",
        pages_affected: list | None = None,
        editor_type: str = "",
        editor_id: str = "",
    ) -> SlideChange | None:
        """记录一条变更日志。失败不影响主流程。"""
        try:
            return SlideChange.objects.using(postgres_app_db_alias()).create(
                project=project,
                version=version,
                change_type=change_type,
                summary=summary,
                pages_affected=pages_affected,
                editor_type=editor_type,
                editor_id=editor_id,
            )
        except Exception:
            logger.warning(
                "Failed to record change: project=%s type=%s v=%s",
                project.id, change_type, version, exc_info=True,
            )
            return None

    @staticmethod
    def _record_element_change(
        project: SlideProject,
        *,
        page_id: str,
        element_id: str,
        version: int,
        change_type: str = "update",
        changed_fields: list[str] | None = None,
        before_data: dict | None = None,
        after_data: dict | None = None,
        editor_type: str = "",
        editor_id: str = "",
    ) -> None:
        """记录元素级变更（审计追溯用）。失败不影响主流程。"""
        try:
            from datetime import timedelta
            SlideElementChange.objects.using(postgres_app_db_alias()).create(
                project=project,
                page_id=page_id,
                element_id=element_id,
                version=version,
                change_type=change_type,
                changed_fields=changed_fields or [],
                before_data=before_data,
                after_data=after_data,
                editor_type=editor_type,
                editor_id=editor_id,
                expired_at=timezone.now() + timedelta(days=30),
            )
        except Exception:
            logger.warning(
                "Failed to record element change: project=%s el=%s",
                project.id, element_id, exc_info=True,
            )

    def list_changes(
        self,
        slide_project_id: str,
        *,
        since_version: Optional[int] = None,
        limit: int = 50,
    ) -> list[SlideChange]:
        """列出变更记录，可选按版本过滤。"""
        project = self._get_project(slide_project_id, required_role="viewer")
        qs = project.changes.using(postgres_app_db_alias()).order_by("-created_at")
        if since_version is not None:
            qs = qs.filter(version__gt=since_version)
        return list(qs[:limit])

    def list_element_changes(
        self,
        slide_project_id: str,
        *,
        page_id: Optional[str] = None,
        element_id: Optional[str] = None,
        since_version: Optional[int] = None,
        limit: int = 50,
    ) -> list[SlideElementChange]:
        """
        列出元素级变更记录（审计追溯用）。

        支持按 page_id / element_id / version 过滤。
        """
        project = self._get_project(slide_project_id, required_role="viewer")
        qs = project.element_changes.using(postgres_app_db_alias()).order_by("-created_at")
        if page_id:
            qs = qs.filter(page_id=page_id)
        if element_id:
            qs = qs.filter(element_id=element_id)
        if since_version is not None:
            qs = qs.filter(version__gt=since_version)
        return list(qs[:limit])

    # ── EMU 尺寸相关 ──

    @staticmethod
    def _extract_source_slide_emu(theme: Optional[dict]) -> tuple[Optional[int], Optional[int]]:
        """从 project.theme 提取导入源 PPT 的 EMU 尺寸。"""
        if not isinstance(theme, dict):
            return None, None
        raw = theme.get(SOURCE_SLIDE_EMU_KEY)
        if not isinstance(raw, dict):
            return None, None
        width = raw.get("width")
        height = raw.get("height")
        if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
            return width, height
        return None, None

    @staticmethod
    def _inject_source_slide_emu(
        theme: Optional[dict],
        slide_width_emu: Optional[int],
        slide_height_emu: Optional[int],
    ) -> Optional[dict]:
        """将导入源 PPT 的 EMU 尺寸写入 project.theme。"""
        if (
            not isinstance(slide_width_emu, int)
            or not isinstance(slide_height_emu, int)
            or slide_width_emu <= 0
            or slide_height_emu <= 0
        ):
            return theme if isinstance(theme, dict) else None

        next_theme = dict(theme) if isinstance(theme, dict) else {}
        next_theme[SOURCE_SLIDE_EMU_KEY] = {
            "width": int(slide_width_emu),
            "height": int(slide_height_emu),
        }
        return next_theme

    @staticmethod
    def _clear_source_slide_emu(theme: Optional[dict]) -> Optional[dict]:
        """当用户主动改画布尺寸时，清理导入源 EMU 锁定信息。"""
        if not isinstance(theme, dict):
            return theme
        if SOURCE_SLIDE_EMU_KEY not in theme:
            return theme
        next_theme = dict(theme)
        next_theme.pop(SOURCE_SLIDE_EMU_KEY, None)
        return next_theme

    @staticmethod
    def _slide_emu_to_canvas_px(slide_emu: int) -> int:
        """按 96 DPI 将 PPT 页面 EMU 尺寸换算为前端画布像素。"""
        if not isinstance(slide_emu, int) or slide_emu <= 0:
            return 0
        px = int(round(slide_emu * PX_PER_INCH / EMU_PER_INCH))
        return max(px, 1)

    @staticmethod
    def _infer_legacy_canvas_from_ratio(ratio: float) -> tuple[int, int]:
        """历史导入版本的 ratio→canvas 映射（兼容纠偏）。"""
        if ratio > 1.5:
            return 1920, 1080
        if ratio > 1.1:
            return 1024, 768
        if ratio > 0.9:
            return 1080, round(1080 / ratio)
        if ratio > 0.65:
            return 1080, 1440
        return 1080, 1920

    def _maybe_fix_legacy_import_canvas(self, project: SlideProject) -> bool:
        """自动修正历史导入项目的画布尺寸映射偏差。"""
        source_w_emu, source_h_emu = self._extract_source_slide_emu(project.theme)
        if not source_w_emu or not source_h_emu:
            return False

        ratio = source_w_emu / source_h_emu
        legacy_w, legacy_h = self._infer_legacy_canvas_from_ratio(ratio)
        if int(project.canvas_width) != legacy_w or int(project.canvas_height) != legacy_h:
            return False

        target_w = self._slide_emu_to_canvas_px(source_w_emu)
        target_h = self._slide_emu_to_canvas_px(source_h_emu)
        if target_w <= 0 or target_h <= 0:
            return False
        if int(project.canvas_width) == target_w and int(project.canvas_height) == target_h:
            return False

        project.canvas_width = target_w
        project.canvas_height = target_h
        project.save(update_fields=["canvas_width", "canvas_height", "updated_at"])
        logger.info(
            "Auto-fixed legacy TabSlide canvas mapping for project %s: %sx%s -> %sx%s",
            project.id, legacy_w, legacy_h, target_w, target_h,
        )
        return True

    # ── 字体元数据（直接读写 DB font_meta 字段）──

    @staticmethod
    def _sanitize_theme_fonts(theme_fonts: Any) -> Dict[str, str]:
        if not isinstance(theme_fonts, dict):
            return {}
        out: Dict[str, str] = {}
        for key in FONT_META_THEME_FONT_KEYS:
            raw = theme_fonts.get(key)
            if not isinstance(raw, str):
                continue
            val = raw.strip()
            if not val:
                continue
            out[key] = val
        return out

    @staticmethod
    def _sanitize_embedded_fonts(embedded_fonts: Any) -> List[Dict[str, str]]:
        if not isinstance(embedded_fonts, list):
            return []

        out: List[Dict[str, str]] = []
        seen: set[str] = set()
        total_len = 0
        for item in embedded_fonts:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()

            # 支持两种格式：旧版 data_base64 和新版 oss_url
            oss_url = str(item.get("oss_url", "")).strip()
            data_base64 = str(item.get("data_base64", "")).strip()

            if not name or (not data_base64 and not oss_url):
                continue

            style = str(item.get("style", "normal")).strip().lower() or "normal"
            if style not in ALLOWED_FONT_STYLES:
                style = "normal"
            fmt = str(item.get("format", "truetype")).strip().lower() or "truetype"
            if fmt not in ALLOWED_FONT_FORMATS:
                fmt = "truetype"

            # 如果已有 oss_url，跳过 base64 大小检查
            if not oss_url and data_base64:
                if len(data_base64) > MAX_SINGLE_FONT_BASE64_LEN:
                    logger.warning("Embedded font skipped: too large single font (%s)", name)
                    continue
                if total_len + len(data_base64) > MAX_TOTAL_FONT_BASE64_LEN:
                    logger.warning("Embedded fonts truncated: total payload exceeds limit")
                    break
                total_len += len(data_base64)

            dedupe_key = f"{name.lower()}::{style}"
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)

            entry: Dict[str, str] = {
                "name": name,
                "style": style,
                "format": fmt,
            }
            if oss_url:
                entry["oss_url"] = oss_url
            elif data_base64:
                entry["data_base64"] = data_base64

            out.append(entry)
            if len(out) >= MAX_EMBEDDED_FONT_COUNT:
                logger.warning("Embedded fonts truncated: count exceeds limit")
                break

        return out

    @classmethod
    def _normalize_font_meta(cls, payload: Any) -> Dict[str, Any]:
        source = payload if isinstance(payload, dict) else {}
        return {
            "embedded_fonts": cls._sanitize_embedded_fonts(source.get("embedded_fonts")),
            "theme_fonts": cls._sanitize_theme_fonts(source.get("theme_fonts")),
        }

    @classmethod
    def _extract_legacy_font_meta_from_theme(
        cls,
        theme: Optional[dict],
    ) -> Tuple[Optional[dict], Optional[List[Dict[str, str]]], Optional[Dict[str, str]], bool]:
        """
        兼容旧前端将字体元数据塞进 theme._tabslideFontEmbedding 的写法。
        返回: (clean_theme, embedded_fonts, theme_fonts, has_legacy_key)
        """
        if not isinstance(theme, dict):
            return theme, None, None, False

        payload = theme.get(FONT_META_THEME_KEY)
        if not isinstance(payload, dict):
            return theme, None, None, False

        embedded_fonts = cls._sanitize_embedded_fonts(
            payload.get("embeddedFonts", payload.get("embedded_fonts"))
        )
        theme_fonts = cls._sanitize_theme_fonts(
            payload.get("themeFonts", payload.get("theme_fonts"))
        )

        next_theme = dict(theme)
        next_theme.pop(FONT_META_THEME_KEY, None)
        return next_theme, embedded_fonts, theme_fonts, True

    def _save_font_meta(
        self,
        project: SlideProject,
        *,
        embedded_fonts: Optional[List[Dict[str, Any]]] = None,
        theme_fonts: Optional[Dict[str, str]] = None,
        provided: bool = False,
        defer_save: bool = False,
    ) -> None:
        """将字体元数据写入 project.font_meta（DB 字段）。"""
        if not provided:
            return

        existing = project.font_meta or {}

        embedded_source: Any = embedded_fonts if embedded_fonts is not None else existing.get("embedded_fonts")
        theme_fonts_source: Any = theme_fonts if theme_fonts is not None else existing.get("theme_fonts")
        sanitized_embedded = self._sanitize_embedded_fonts(embedded_source)
        sanitized_theme_fonts = self._sanitize_theme_fonts(theme_fonts_source)

        payload: Dict[str, Any] = {
            "embedded_fonts": sanitized_embedded,
            "theme_fonts": sanitized_theme_fonts,
        }
        # 保留 HTML 布局 lint 旁路键（create_slides 写入；不被字体更新冲掉）
        from apps.tabslide.services.html_layout_lint import HTML_LAYOUT_PROBLEMS_KEY

        preserved_layout = existing.get(HTML_LAYOUT_PROBLEMS_KEY)
        if preserved_layout is not None:
            payload[HTML_LAYOUT_PROBLEMS_KEY] = preserved_layout

        project.font_meta = (
            payload
            if (sanitized_embedded or sanitized_theme_fonts or preserved_layout is not None)
            else None
        )
        if not defer_save:
            project.save(update_fields=["font_meta"])

    def get_font_meta(self, project: SlideProject) -> Dict[str, Any]:
        """从 project.font_meta 读取字体元数据。"""
        if project.font_meta and isinstance(project.font_meta, dict):
            return self._normalize_font_meta(project.font_meta)
        return {"embedded_fonts": [], "theme_fonts": {}}

    def _persist_html_layout_problems(
        self,
        project: SlideProject,
        problems: list,
    ) -> None:
        """把 HTML 布局 lint 结果写入 font_meta 旁路键，供随后的 /lint 合并。"""
        from apps.tabslide.services.html_layout_lint import HTML_LAYOUT_PROBLEMS_KEY

        existing = (
            dict(project.font_meta)
            if isinstance(project.font_meta, dict)
            else {}
        )
        if problems:
            existing[HTML_LAYOUT_PROBLEMS_KEY] = problems
        else:
            existing.pop(HTML_LAYOUT_PROBLEMS_KEY, None)

        has_fonts = bool(existing.get("embedded_fonts") or existing.get("theme_fonts"))
        has_layout = HTML_LAYOUT_PROBLEMS_KEY in existing
        project.font_meta = existing if (has_fonts or has_layout) else None
        type(project).objects.using(postgres_app_db_alias()).filter(id=project.id).update(
            font_meta=project.font_meta,
        )

    @staticmethod
    def get_html_layout_problems(project: SlideProject) -> list:
        """读取 create_slides 持久化的 HTML 布局 lint 问题。"""
        from apps.tabslide.services.html_layout_lint import HTML_LAYOUT_PROBLEMS_KEY

        meta = project.font_meta if isinstance(project.font_meta, dict) else {}
        problems = meta.get(HTML_LAYOUT_PROBLEMS_KEY) or []
        return [p for p in problems if isinstance(p, dict)]

    @staticmethod
    def upload_fonts_to_oss(
        embedded_fonts: List[Dict[str, Any]],
        *,
        organization_id: str = "",
        user_id: str = "",
        context_id: str = "",
    ) -> List[Dict[str, Any]]:
        """
        将 embedded_fonts 中的 data_base64 上传到 OSS，替换为 oss_url。
        已有 oss_url 的条目跳过。OSS 不可用时原样返回。
        """
        oss = _get_oss_service()
        if not oss:
            return embedded_fonts

        import hashlib as _hashlib
        import uuid as _uuid

        result = []
        for font in embedded_fonts:
            if not isinstance(font, dict):
                continue

            if font.get("oss_url"):
                result.append(font)
                continue

            data_base64 = font.get("data_base64", "")
            if not data_base64:
                result.append(font)
                continue

            try:
                font_bytes = base64.b64decode(data_base64)
            except Exception:
                logger.warning("Failed to decode font base64 for %s", font.get("name"))
                result.append(font)
                continue

            fmt = font.get("format", "truetype")
            ext_map = {"truetype": "ttf", "opentype": "otf", "woff": "woff", "woff2": "woff2"}
            ext = ext_map.get(fmt, "ttf")
            object_key = f"tabslide/fonts/{_uuid.uuid4().hex[:12]}.{ext}"

            content_type_map = {
                "truetype": "font/ttf",
                "opentype": "font/otf",
                "woff": "font/woff",
                "woff2": "font/woff2",
            }
            content_type = content_type_map.get(fmt, "application/octet-stream")

            try:
                upload_result = oss.upload_file(
                    BytesIO(font_bytes), object_key, content_type=content_type,
                )
                if upload_result.get("success") and upload_result.get("data", {}).get("access_url"):
                    url = upload_result["data"].get("cdn_url") or upload_result["data"]["access_url"]
                    new_font = {k: v for k, v in font.items() if k != "data_base64"}
                    new_font["oss_url"] = url
                    result.append(new_font)
                    logger.info("Font uploaded to OSS: %s → %s", font.get("name"), object_key)

                    if organization_id:
                        try:
                            from apps.services.oss.services.file_registry import FileRegistryService
                            FileRegistryService.register_uploaded_file(
                                object_key=object_key,
                                file_name=font.get("name", "font") + f".{ext}",
                                file_size=len(font_bytes),
                                content_type=content_type,
                                module="tabslide",
                                user_id=user_id,
                                organization_id=organization_id,
                                context_type="font",
                                context_id=context_id,
                                upload_source="tabslide_font",
                                file_hash=_hashlib.md5(font_bytes).hexdigest(),
                                enforce_storage_quota=True,
                                is_public=True,
                            )
                        except Exception:
                            logger.error("TabSlide 字体注册 FileRecord 失败, 孤儿 OSS 文件: key=%s font=%s", object_key, font.get("name"), exc_info=True)

                    continue
            except Exception as e:
                logger.warning("Font OSS upload failed for %s: %s", font.get("name"), e)

            result.append(font)

        return result

    # ── 图片安全 ──

    @staticmethod
    def _is_internal_ip(ip: ipaddress._BaseAddress) -> bool:
        return (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        )

    @classmethod
    def _resolve_safe_ip(cls, hostname: str) -> str:
        """Resolve hostname, validate all resolved IPs, return first safe IP.

        Raises ValueError if hostname resolves to internal/blocked addresses.
        """
        normalized = (hostname or "").strip().rstrip(".").lower()
        if not normalized or normalized in {"localhost", "localhost.localdomain"}:
            raise ValueError("blocked host")

        try:
            ip = ipaddress.ip_address(normalized)
            if cls._is_internal_ip(ip):
                raise ValueError("blocked IP")
            return normalized
        except ValueError as e:
            if "blocked" in str(e):
                raise

        try:
            addr_infos = socket.getaddrinfo(normalized, None)
        except Exception:
            raise ValueError("cannot resolve host")

        if not addr_infos:
            raise ValueError("cannot resolve host")

        for info in addr_infos:
            ip = ipaddress.ip_address(info[4][0])
            if cls._is_internal_ip(ip):
                raise ValueError("blocked internal IP")

        return addr_infos[0][4][0]

    @classmethod
    def _is_blocked_image_host(cls, host: str) -> bool:
        """阻止访问本地/内网地址，避免图片代理被滥用为 SSRF。"""
        try:
            cls._resolve_safe_ip(host)
            return False
        except ValueError:
            return True

    @staticmethod
    def _load_data_url_image_bytes(src: str, max_bytes: int) -> bytes:
        if "," not in src:
            raise ValueError(_("tabslide.invalid_data_url_format"))
        header, b64_data = src.split(",", 1)
        if ";base64" not in header.lower():
            raise ValueError(_("tabslide.only_base64_data_url"))
        mime = header[5:].split(";", 1)[0].strip().lower() if header.startswith("data:") else ""
        if not mime.startswith("image/"):
            raise ValueError(_("tabslide.only_image_data_url"))
        if not b64_data:
            raise ValueError(_("tabslide.empty_image_data_url"))
        try:
            image_bytes = base64.b64decode(b64_data, validate=True)
        except (binascii.Error, ValueError):
            try:
                image_bytes = base64.b64decode(b64_data)
            except Exception as e:
                raise ValueError(_("tabslide.data_url_decode_failed", error=str(e)))
        if not image_bytes:
            raise ValueError(_("tabslide.empty_image_content"))
        if len(image_bytes) > max_bytes:
            raise ValueError(_("tabslide.image_size_exceeded", max_mb=max_bytes // (1024 * 1024)))
        return image_bytes

    _MAX_IMAGE_REDIRECTS = 5

    @classmethod
    def _open_ip_pinned_conn(
        cls, resolved_ip: str, hostname: str, port: int, use_ssl: bool,
    ) -> http.client.HTTPConnection:
        """Create an HTTP(S) connection to a pre-resolved IP (prevents DNS rebinding)."""
        sock = socket.create_connection((resolved_ip, port), timeout=20)
        if use_ssl:
            ctx = ssl.create_default_context()
            try:
                sock = ctx.wrap_socket(sock, server_hostname=hostname)
            except Exception:
                sock.close()
                raise
        conn = (
            http.client.HTTPSConnection(hostname, port)
            if use_ssl
            else http.client.HTTPConnection(hostname, port)
        )
        conn.sock = sock
        return conn

    @classmethod
    def _download_remote_image_bytes(cls, src: str, max_bytes: int) -> bytes:
        parsed = urlparse(src)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError(_("tabslide.only_http_image_url"))
        if not parsed.hostname:
            raise ValueError(_("tabslide.image_url_missing_host"))

        hostname = parsed.hostname
        use_ssl = parsed.scheme == "https"
        port = parsed.port or (443 if use_ssl else 80)
        path = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")

        try:
            resolved_ip = cls._resolve_safe_ip(hostname)
        except ValueError:
            raise ValueError(_("tabslide.image_url_blocked"))

        headers = {
            "Host": hostname,
            "User-Agent": "TabTin-TabSlide/1.0",
            "Accept": "image/*,*/*;q=0.8",
        }

        try:
            for _attempt in range(cls._MAX_IMAGE_REDIRECTS):
                conn = cls._open_ip_pinned_conn(resolved_ip, hostname, port, use_ssl)
                try:
                    conn.request("GET", path, headers=headers)
                    resp = conn.getresponse()

                    if resp.status in (301, 302, 303, 307, 308):
                        location = resp.getheader("Location")
                        resp.read()
                        conn.close()
                        if not location:
                            raise ValueError(_("tabslide.image_download_failed", error="empty redirect"))
                        current_scheme = "https" if use_ssl else "http"
                        new_parsed = urlparse(
                            urljoin(f"{current_scheme}://{hostname}{path}", location)
                        )
                        new_host = new_parsed.hostname
                        if not new_host:
                            raise ValueError(_("tabslide.image_url_missing_host"))
                        if new_host != hostname:
                            try:
                                resolved_ip = cls._resolve_safe_ip(new_host)
                            except ValueError:
                                raise ValueError(_("tabslide.image_redirect_blocked"))
                            hostname = new_host
                        use_ssl = new_parsed.scheme == "https"
                        port = new_parsed.port or (443 if use_ssl else 80)
                        path = (new_parsed.path or "/") + (
                            f"?{new_parsed.query}" if new_parsed.query else ""
                        )
                        headers["Host"] = hostname
                        continue

                    content_type = (resp.getheader("Content-Type") or "").lower()
                    if content_type and not content_type.startswith("image/"):
                        raise ValueError(
                            _("tabslide.remote_not_image", content_type=content_type)
                        )

                    cl = resp.getheader("Content-Length")
                    if cl:
                        try:
                            cl_int = int(cl)
                        except (TypeError, ValueError):
                            cl_int = None
                        if cl_int is not None and cl_int > max_bytes:
                            raise ValueError(
                                _("tabslide.image_size_exceeded", max_mb=max_bytes // (1024 * 1024))
                            )

                    image_bytes = resp.read(max_bytes + 1)
                    conn.close()

                    if not image_bytes:
                        raise ValueError(_("tabslide.empty_downloaded_image"))
                    if len(image_bytes) > max_bytes:
                        raise ValueError(
                            _("tabslide.image_size_exceeded", max_mb=max_bytes // (1024 * 1024))
                        )
                    return image_bytes
                except Exception:
                    conn.close()
                    raise

            raise ValueError(
                _("tabslide.image_download_failed", error="too many redirects")
            )
        except ValueError:
            raise
        except Exception as e:
            raise ValueError(_("tabslide.image_download_failed", error=str(e)))

    def normalize_image_for_export(self, src: str) -> dict:
        """导出前图片归一化：输入 data URL / http(s) URL，输出标准 data URL。"""
        if not isinstance(src, str) or not src.strip():
            raise ValueError(_("tabslide.src_required"))
        source = src.strip()

        if source.startswith("data:"):
            image_bytes = self._load_data_url_image_bytes(source, MAX_EXPORT_IMAGE_BYTES)
        elif source.startswith("http://") or source.startswith("https://"):
            image_bytes = self._download_remote_image_bytes(source, MAX_EXPORT_IMAGE_BYTES)
        else:
            raise ValueError(_("tabslide.only_data_url_or_http"))

        from apps.tabslide.services.pptx_io import (
            _guess_image_format,
            _normalize_image_bytes_for_pptx,
        )

        source_format = (_guess_image_format(image_bytes, src_hint=source) or "unknown").lower()
        normalized_bytes = _normalize_image_bytes_for_pptx(image_bytes, src_hint=source)
        if not normalized_bytes:
            raise ValueError(_("tabslide.image_normalize_empty"))

        target_format = (_guess_image_format(normalized_bytes, src_hint=None) or source_format).lower()
        if target_format == "unknown":
            target_format = "png"
        mime = IMAGE_MIME_BY_EXT.get(target_format, "image/png")
        data_url = f"data:{mime};base64,{base64.b64encode(normalized_bytes).decode('ascii')}"

        return {
            "data_url": data_url,
            "source_format": source_format,
            "target_format": target_format,
            "converted": normalized_bytes != image_bytes,
            "byte_size": len(normalized_bytes),
        }

    # ════════════════════════════════════════════════════════════════════
    # PPTX OSS 上传
    # ════════════════════════════════════════════════════════════════════

    @staticmethod
    def _upload_pptx_to_oss(
        local_path: str,
        project_id: str,
        *,
        organization_id: str = "",
        user_id: str = "",
    ) -> Optional[str]:
        """将本地 PPTX 文件上传到 OSS，返回 CDN URL。失败返回 None。"""
        oss = _get_oss_service()
        if not oss:
            return None

        import hashlib as _hashlib
        import uuid as _uuid
        object_key = f"tabslide/exports/{project_id}/{_uuid.uuid4().hex[:8]}.pptx"

        try:
            file_size = os.path.getsize(local_path)
            hasher = _hashlib.md5()
            with open(local_path, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    hasher.update(chunk)
            file_hash = hasher.hexdigest()

            with open(local_path, "rb") as f:
                result = oss.upload_file(
                    f, object_key,
                    content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                )
            if not result.get("success"):
                logger.error(
                    "PPTX OSS 上传失败: key=%s code=%s msg=%s",
                    object_key, result.get("error_code"), result.get("message"),
                )
                return None

            if result.get("data", {}).get("access_url"):
                url = result["data"].get("cdn_url") or result["data"]["access_url"]

                # download_url 是无签名的持久地址，由 CLI 匿名 GET 下载；私有桶下
                # 对象若不显式设为 public-read，这个 GET 必定 403。与其余公开资产
                # 上传路径（api_open_storage / attachment_service / oss.api 等）对齐。
                if not oss.set_object_public_read(object_key):
                    if getattr(oss, "config", {}).get("access_mode") == "private":
                        logger.error(
                            "PPTX 导出对象 public-read ACL 设置失败，私有桶下无法匿名下载: key=%s",
                            object_key,
                        )
                        try:
                            delete_result = oss.delete_file(object_key)
                            if not delete_result.get("success"):
                                logger.warning(
                                    "清理 ACL 失败的 PPTX 对象失败: key=%s code=%s msg=%s",
                                    object_key,
                                    delete_result.get("error_code"),
                                    delete_result.get("message"),
                                )
                        except Exception:
                            logger.warning("清理 ACL 失败的 PPTX 对象失败: key=%s", object_key, exc_info=True)
                        return None
                    logger.warning(
                        "PPTX 导出对象 public-read ACL 设置失败，沿用 bucket 公共访问口径: key=%s",
                        object_key,
                    )

                logger.info("PPTX uploaded to OSS: %s", object_key)

                if organization_id:
                    try:
                        from apps.services.oss.services.file_registry import FileRegistryService
                        new_record = FileRegistryService.register_uploaded_file(
                            object_key=object_key,
                            file_name=f"{project_id}.pptx",
                            file_size=file_size,
                            content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                            module="tabslide",
                            user_id=user_id,
                            organization_id=organization_id,
                            context_type="export_pptx",
                            context_id=project_id,
                            upload_source="tabslide_pptx_export",
                            file_hash=file_hash,
                            enforce_storage_quota=True,
                            is_public=True,
                        )
                        new_record_id = str(new_record.id) if new_record else ""
                    except Exception:
                        logger.error("TabSlide PPTX 注册 FileRecord 失败, 孤儿 OSS 文件: key=%s project=%s", object_key, project_id, exc_info=True)
                        new_record_id = ""

                    if new_record_id:
                        try:
                            from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
                            deactivate_file_usages_and_release_storage(
                                module="tabslide",
                                context_filter={"context_type": "export_pptx", "context_id": project_id},
                                exclude_file_record_id=new_record_id,
                                organization_id=organization_id,
                                user_id=user_id,
                                biz_type="tabslide_export_cleanup",
                                biz_id=project_id,
                                log_prefix="TabSlide",
                            )
                        except Exception:
                            logger.warning("TabSlide 清理旧导出 FileUsage 失败: project=%s", project_id, exc_info=True)

                return url
        except Exception as e:
            logger.warning("PPTX OSS upload failed: %s", e)

        return None

    # ════════════════════════════════════════════════════════════════════
    # CRUD
    # ════════════════════════════════════════════════════════════════════

    def create_project(
        self,
        organization_id: str,
        space_id: str,
        name: str = "未命名演示文稿",
        preset: str = "ppt",
        canvas_width: Optional[int] = None,
        canvas_height: Optional[int] = None,
        theme: Optional[dict] = None,
        embedded_fonts: Optional[List[Dict[str, Any]]] = None,
        theme_fonts: Optional[Dict[str, str]] = None,
    ) -> SlideProject:
        """创建演示文稿项目

        TODO(QTA-23): 当前无演示文稿数量配额检查。MembershipTier 缺少 max_slide_projects 字段，
        用户可无限创建演示文稿。后续需在此处调用 QuotaService().check_quota('max_slide_projects', ...)
        并在 MembershipTier 模型和 seed 数据中补齐该字段。
        """
        if not self.check_space_permission(space_id, required_role="editor"):
            raise PermissionError(_("tabslide.no_permission_to_create"))

        assert_organization_resource_write_allowed_optional(organization_id)

        clean_theme = theme
        legacy_embedded = None
        legacy_theme_fonts = None
        legacy_found = False
        if embedded_fonts is None and theme_fonts is None:
            clean_theme, legacy_embedded, legacy_theme_fonts, legacy_found = self._extract_legacy_font_meta_from_theme(theme)

        resolved_embedded = embedded_fonts if embedded_fonts is not None else legacy_embedded
        resolved_theme_fonts = theme_fonts if theme_fonts is not None else legacy_theme_fonts
        font_meta_provided = (
            embedded_fonts is not None
            or theme_fonts is not None
            or legacy_found
        )

        normalized_preset = SlideProject.normalize_preset(preset)
        width, height = self._resolve_dimensions(normalized_preset, canvas_width, canvas_height)

        # 先创建项目（font_meta 暂为空），再上传字体以获得有效 context_id
        sanitized_theme_fonts = self._sanitize_theme_fonts(resolved_theme_fonts) if font_meta_provided else None
        sanitized_embedded_raw = self._sanitize_embedded_fonts(resolved_embedded) if font_meta_provided else None

        project = SlideProject.objects.create(
            organization_id=organization_id,
            space_id=space_id,
            name=name,
            preset=normalized_preset,
            canvas_width=width,
            canvas_height=height,
            theme=clean_theme,
            font_meta=None,
            created_by=self.user,
            updated_by=self.user,
        )

        if font_meta_provided and sanitized_embedded_raw:
            sanitized_embedded = self.upload_fonts_to_oss(
                sanitized_embedded_raw,
                organization_id=organization_id,
                user_id=str(self.user.id) if self.user else "",
                context_id=str(project.id),
            )
            if sanitized_embedded or sanitized_theme_fonts:
                project.font_meta = {
                    "embedded_fonts": sanitized_embedded,
                    "theme_fonts": sanitized_theme_fonts or {},
                }
                project.save(update_fields=["font_meta"])
        elif font_meta_provided and sanitized_theme_fonts:
            project.font_meta = {
                "embedded_fonts": [],
                "theme_fonts": sanitized_theme_fonts,
            }
            project.save(update_fields=["font_meta"])

        ResourceBridge.on_create(project, user=self.user)
        return project

    def list_projects(
        self,
        organization_id: str,
        space_id: str,
        *,
        scope: str = "space",
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[SlideProject], int]:
        """
        列出演示文稿项目（分页）。

        scope="space"：仅当前 Space（默认）。
        scope="organization"：用户在 organization 内可访问的所有 Space。
        返回 (projects, total) 元组。
        """
        limit = max(1, min(limit, 100))
        offset = max(0, offset)

        if scope == "organization":
            if not self.user:
                raise PermissionError(_("tabslide.no_permission_to_access_space"))
            from apps.tabtinspace.services.accessible_space_resolver import get_accessible_space_ids
            accessible = get_accessible_space_ids(str(self.user.id), organization_id)
            if not accessible:
                return [], 0
            qs = SlideProject.objects.filter(
                organization_id=organization_id,
                space_id__in=accessible,
                status="active",
            ).order_by("-updated_at")
        else:
            if not self.check_space_permission(space_id, required_role="viewer"):
                raise PermissionError(_("tabslide.no_permission_to_access_space"))
            qs = SlideProject.objects.filter(
                organization_id=organization_id,
                space_id=space_id,
                status="active",
            ).order_by("-updated_at")

        total = qs.count()
        projects = list(qs[offset : offset + limit])
        return projects, total

    def get_project_detail(self, slide_project_id: str) -> tuple[SlideProject, list]:
        """获取项目详情（SlidePage 是唯一数据源）。"""
        project = self._get_project(slide_project_id, required_role="viewer")
        self._maybe_fix_legacy_import_canvas(project)
        pages = self._read_pages_from_slide_pages(project)
        return project, pages

    def update_project(
        self,
        slide_project_id: str,
        *,
        name: Optional[str] = None,
        preset: Optional[str] = None,
        canvas_width: Optional[int] = None,
        canvas_height: Optional[int] = None,
        theme: Optional[dict] = None,
        thumbnail: Optional[str] = None,
        embedded_fonts: Optional[List[Dict[str, Any]]] = None,
        theme_fonts: Optional[Dict[str, str]] = None,
    ) -> SlideProject:
        """更新项目元数据"""
        project = self._get_project(slide_project_id, required_role="editor")

        resolved_embedded = embedded_fonts
        resolved_theme_fonts = theme_fonts
        font_meta_provided = embedded_fonts is not None or theme_fonts is not None

        if name is not None:
            normalized_name = name.strip()
            project.name = normalized_name
        if preset is not None:
            project.preset = SlideProject.normalize_preset(preset)
        resized_canvas = False
        if canvas_width is not None:
            project.canvas_width = canvas_width
            resized_canvas = True
        if canvas_height is not None:
            project.canvas_height = canvas_height
            resized_canvas = True
        if theme is not None:
            next_theme = theme
            if not font_meta_provided:
                next_theme, legacy_embedded, legacy_theme_fonts, legacy_found = self._extract_legacy_font_meta_from_theme(theme)
                if legacy_found:
                    font_meta_provided = True
                    resolved_embedded = legacy_embedded
                    resolved_theme_fonts = legacy_theme_fonts
            if isinstance(project.theme, dict) and SOURCE_SLIDE_EMU_KEY in project.theme:
                if not isinstance(next_theme, dict):
                    next_theme = {}
                if SOURCE_SLIDE_EMU_KEY not in next_theme:
                    merged_theme = dict(next_theme)
                    merged_theme[SOURCE_SLIDE_EMU_KEY] = project.theme[SOURCE_SLIDE_EMU_KEY]
                    next_theme = merged_theme
            project.theme = next_theme
        if resized_canvas:
            project.theme = self._clear_source_slide_emu(project.theme)
        if thumbnail is not None:
            project.thumbnail = thumbnail

        # 字体 base64 → OSS 迁移
        if font_meta_provided and resolved_embedded:
            resolved_embedded = self.upload_fonts_to_oss(
                self._sanitize_embedded_fonts(resolved_embedded),
                organization_id=str(getattr(project, "organization_id", "")),
                user_id=str(self.user.id) if self.user else "",
                context_id=str(project.id),
            )

        # 字体元数据 → DB font_meta
        self._save_font_meta(
            project,
            embedded_fonts=resolved_embedded,
            theme_fonts=resolved_theme_fonts,
            provided=font_meta_provided,
            defer_save=True,
        )

        content_changed = theme is not None or resized_canvas or font_meta_provided

        if content_changed:
            project.latest_version = (project.latest_version or 0) + 1

        project.updated_by = self.user
        project.save()

        ResourceBridge.on_update(project, user=self.user)

        if content_changed:
            changes = []
            if theme is not None:
                changes.append("主题")
            if resized_canvas:
                changes.append("画布尺寸")
            if font_meta_provided:
                changes.append("字体")
            try:
                from apps.tabslide.post_save import run_post_save_hooks
                run_post_save_hooks(
                    project,
                    version=project.latest_version,
                    change_type="update_project",
                    summary="/".join(changes) + "变更",
                    editor_type="user",
                    create_history=True,
                    force_history=True,
                )
            except Exception:
                logger.warning(
                    "update_project: run_post_save_hooks failed for project=%s (non-fatal)",
                    project.id, exc_info=True,
                )

        return project

    def archive_project(self, slide_project_id: str) -> SlideProject:
        """归档（软删除）项目"""
        project = self._get_project(slide_project_id, required_role="editor")

        project.status = "archived"
        project.updated_by = self.user
        project.save(update_fields=["status", "updated_by", "updated_at"])

        ResourceBridge.on_archive(project, user=self.user)
        self._deactivate_project_file_usages(project)
        return project

    @staticmethod
    def _deactivate_project_file_usages(project) -> None:
        """归档项目时 deactivate 其关联的所有 FileUsage 并释放存储计量。

        覆盖所有 context_type（project / export_pptx / font / import_image / slide_image / preview_image）。
        """
        try:
            from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage

            deactivate_file_usages_and_release_storage(
                module="tabslide",
                context_filter={"context_id": str(project.id)},
                organization_id=str(getattr(project, "organization_id", "")),
                user_id=str(getattr(project, "created_by_id", "") or ""),
                biz_type="tabslide_archive_release",
                biz_id=str(project.id),
                log_prefix="TabSlide 归档",
            )
        except Exception as e:
            logger.error("TabSlide 归档清理 FileUsage 失败: %s", e, exc_info=True)

    @staticmethod
    def _reactivate_project_file_usages(project) -> None:
        """从回收站恢复项目时 reactivate 其关联的 FileUsage 并恢复存储计量。"""
        try:
            from apps.services.oss.services.reactivate_utils import reactivate_file_usages_and_restore_storage

            result = reactivate_file_usages_and_restore_storage(
                module="tabslide",
                context_filter={"context_id": str(project.id)},
                organization_id=str(getattr(project, "organization_id", "")),
                user_id=str(getattr(project, "created_by_id", "") or ""),
                biz_type="tabslide_restore_storage",
                biz_id=str(project.id),
                log_prefix="TabSlide 恢复",
            )
            if result.has_failures:
                logger.warning(
                    "TabSlide 恢复 FileUsage 部分失败: %d 个文件不可恢复",
                    len(result.failed_files),
                )
        except Exception as e:
            logger.error("TabSlide 恢复 FileUsage 失败: %s", e, exc_info=True)

    @transaction.atomic(using=postgres_app_db_alias())
    def trash_project(self, slide_project_id: str) -> SlideProject:
        """将演示文稿移入回收站"""
        project = self._get_project(slide_project_id, required_role="editor")

        project.trash(user_id=self.user.id if self.user else None)
        project.updated_by = self.user
        project.save(update_fields=[
            "status", "trashed_at", "trashed_by", "previous_status",
            "updated_by", "updated_at",
        ])

        ResourceBridge.on_trash(project, user=self.user)
        self._deactivate_project_file_usages(project)
        return project

    @transaction.atomic(using=postgres_app_db_alias())
    def restore_project(self, slide_project_id: str) -> SlideProject:
        """从回收站恢复演示文稿"""
        project = self._get_project(slide_project_id, required_role="editor")
        if not project.is_trashed:
            raise ValueError(_("tabslide.project_not_in_trash"))

        ResourceBridge.check_restore_quota(project)

        project.restore_from_trash()
        project.updated_by = self.user
        project.save(update_fields=[
            "status", "trashed_at", "trashed_by", "previous_status",
            "updated_by", "updated_at",
        ])

        ResourceBridge.on_restore(project, user=self.user)
        self._reactivate_project_file_usages(project)
        return project

    @transaction.atomic(using=postgres_app_db_alias())
    def permanent_delete_project(self, slide_project_id: str) -> None:
        """永久删除演示文稿（仅限回收站中的项目）"""
        project = self._get_project(slide_project_id, required_role="editor")
        if project.status != "trashed":
            raise ValueError(_("tabslide.only_delete_trashed"))

        user_id = getattr(self.user, "id", None)
        logger.debug(
            "[PermanentDelete] module=tabslide resource=%s name=%r user=%s",
            project.id, getattr(project, "title", ""), user_id,
        )

        self._deactivate_project_file_usages(project)

        if not ResourceBridge.on_delete(project, user=self.user):
            logger.warning(
                "[PermanentDelete] ResourceBridge.on_delete 返回 False, "
                "ContextItem 可能未清理: %s(%s)",
                type(project).__name__, project.id,
            )
        project.delete()

    # ════════════════════════════════════════════════════════════════════
    # 创建模式：HTML → pages
    # ════════════════════════════════════════════════════════════════════

    def _extract_slides_from_html(
        self,
        slide_project_id: str,
        project: SlideProject,
        html: str,
        title: Optional[str] = None,
        mode: str = "direct",
        inline_images: bool = False,
    ) -> tuple[list, str | None, int]:
        """HTML → 前端 page dict 列表。只负责提取与净化，不写库。

        inline_images=True 时不构建 OSS image_handler——dom_extractor 的图片
        （栅格化 SVG / rasterize 截图）保留 / 内嵌 data:base64，不产生 OSS 对象。
        """
        import time as _time

        MAX_HTML_SIZE = 2 * 1024 * 1024  # 2 MB
        VALID_MODES = ("direct", "hybrid", "screenshot")

        if not html or not html.strip():
            raise ValueError(_("tabslide.html_content_required"))

        # Phase-3 Wave-1 ECharts 修复：dom_extractor 入口走宽松 sanitize（保留可信 <script>），
        # 让 ECharts / Chart.js / MathJax 等可视化脚本真正能执行；这是后端 headless Chromium，
        # 没有用户 session 接触面，安全风险靠脚本黑名单 + Playwright 网络拦截控制。
        html = _sanitize_slide_html_for_extraction(html)

        html_bytes = html.encode("utf-8")
        if len(html_bytes) > MAX_HTML_SIZE:
            raise ValueError(
                f"HTML 内容过大 ({len(html_bytes) / 1024 / 1024:.1f}MB)，"
                f"上限为 {MAX_HTML_SIZE // 1024 // 1024}MB"
            )

        if mode not in VALID_MODES:
            raise ValueError(
                f"不支持的模式 '{mode}'，可选: {', '.join(VALID_MODES)}"
            )

        if mode == "direct" and ".ppt-slide" not in html and "ppt-slide" not in html:
            logger.warning(
                "create_slides: direct mode but HTML missing .ppt-slide class | project=%s",
                slide_project_id,
            )

        t_start = _time.monotonic()
        html_size_kb = len(html_bytes) / 1024
        logger.info(
            "extract_slides_from_html start | project=%s mode=%s html_size=%.1fKB",
            slide_project_id, mode, html_size_kb,
        )

        # inline_images：不给 image_handler → dom_extractor 保留 / 内嵌 data:base64
        image_handler = None if inline_images else build_oss_image_handler(
            organization_id=str(getattr(project, "organization_id", "") or ""),
            user_id=str(self.user.id) if self.user else "",
            context_type="slide_image",
            context_id=str(project.id),
        )

        t_extract = _time.monotonic()
        create_slides_oss_url = None
        if mode == "direct":
            from apps.tabslide.services.dom_extractor import extract_elements_from_html

            pages = extract_elements_from_html(
                html,
                canvas_width=project.canvas_width or 1280,
                canvas_height=project.canvas_height or 720,
                image_handler=image_handler,
            )
        else:
            from apps.tabslide.services.slides_generator import generate_pptx_from_content

            output_fd, output_path = tempfile.mkstemp(suffix=".pptx")
            os.close(output_fd)
            try:
                generate_pptx_from_content(
                    content=html,
                    file_path=output_path,
                    slide_title=title or project.name,
                    mode=mode if mode in ("hybrid", "screenshot") else "hybrid",
                )

                from apps.tabslide.services.pptx_io import read
                pages = read(output_path, project.canvas_width, project.canvas_height, image_handler=image_handler)
                create_slides_oss_url = self._upload_pptx_to_oss(
                    output_path, str(project.id),
                    organization_id=str(getattr(project, "organization_id", "")),
                    user_id=str(self.user.id) if self.user else "",
                )
            finally:
                try:
                    os.unlink(output_path)
                except OSError:
                    pass

        # JSON-first：elements 是运行时真相源（content_format 永远是 'json'）。
        # html_source 一次性写入作 Agent 后续创作的"风格参考语料"，read-only after creation。
        slide_html_sources = self._extract_html_sources_by_slide(html, len(pages))
        for idx, page in enumerate(pages):
            if not isinstance(page, dict):
                continue
            if idx < len(slide_html_sources):
                page["html"] = slide_html_sources[idx]

        # 剥离 extract 临时字段，供 create_slides 持久化到 font_meta 旁路键
        from apps.tabslide.services.html_layout_lint import collect_layout_problems

        self._last_html_layout_problems = collect_layout_problems(pages)

        extract_ms = round((_time.monotonic() - t_extract) * 1000)
        total_elements = sum(
            len(p.get("elements", []) if isinstance(p, dict) else [])
            for p in pages
        )

        blank_pages = []
        for idx, page in enumerate(pages):
            if isinstance(page, dict) and not page.get("elements"):
                blank_pages.append(idx + 1)
                logger.error(
                    "create_slides: page %d extracted 0 elements | project=%s",
                    idx + 1, slide_project_id,
                )
        if blank_pages:
            logger.error(
                "create_slides: %d blank page(s) detected: %s | project=%s",
                len(blank_pages), blank_pages, slide_project_id,
            )

        logger.info(
            "extract_slides_from_html done | project=%s mode=%s pages=%d elements=%d blank=%d extract_ms=%d",
            slide_project_id, mode, len(pages), total_elements, len(blank_pages), extract_ms,
        )

        for page in pages:
            if isinstance(page, dict) and isinstance(page.get("elements"), list):
                _sanitize_elements_data(page["elements"])
                page["elements"] = [
                    _flat_element_to_props_wrapped(el)
                    for el in page["elements"]
                    if isinstance(el, dict)
                ]

        total_ms = round((_time.monotonic() - t_start) * 1000)
        return pages, create_slides_oss_url, total_ms

    def _register_embedded_fonts_for_pages(self, project: SlideProject, pages: list, source: str) -> None:
        # Phase-2 Wave-2：根据页面内容自动注册需要嵌入的字体。
        try:
            from apps.tabslide.services.font_registry import build_font_meta_for_pages

            font_meta = build_font_meta_for_pages(pages)
            new_embedded = (font_meta or {}).get("embedded_fonts") or []
            if new_embedded:
                existing = dict(project.font_meta or {})
                existing_embedded = list(existing.get("embedded_fonts") or [])
                seen_names = {
                    (e.get("name") or "").strip()
                    for e in existing_embedded
                    if isinstance(e, dict)
                }
                added: list[str] = []
                for ef in new_embedded:
                    name = (ef.get("name") or "").strip()
                    if name and name not in seen_names:
                        existing_embedded.append(ef)
                        seen_names.add(name)
                        added.append(name)
                if added:
                    existing["embedded_fonts"] = existing_embedded
                    project.font_meta = existing
                    SlideProject.objects.using(postgres_app_db_alias()).filter(id=project.id).update(font_meta=existing)
                    logger.info(
                        "%s: auto-registered %d embedded font(s) for project=%s: %s",
                        source, len(added), project.id, added,
                    )
        except Exception as font_err:
            logger.warning(
                "%s: font auto-registration failed for project=%s: %s",
                source, project.id, font_err, exc_info=True,
            )

    def create_slides(
        self,
        slide_project_id: str,
        html: str,
        title: Optional[str] = None,
        mode: str = "direct",
        agent_run_id: str = "",
        inline_images: bool = False,
    ) -> tuple[SlideProject, list]:
        """
        Agent 创建模式：HTML → SlidePage。

        注意：该路径会用本次 HTML 生成出的 pages 替换项目全部页面。

        inline_images=True（ render 链路）：栅格化图片不上传 OSS，
        以 data:base64 内嵌 PPTElement.src——用于用完即删的临时渲染项目。
        """
        project = self._get_project(slide_project_id, required_role="editor")
        pages, create_slides_oss_url, total_ms = self._extract_slides_from_html(
            slide_project_id, project, html, title=title, mode=mode,
            inline_images=inline_images,
        )
        layout_problems = list(getattr(self, "_last_html_layout_problems", []) or [])

        editor_type, editor_id = self._editor_info("agent")

        new_version = self._cas_save_pages(
            project,
            pages,
            editor_type=editor_type,
            editor_id=editor_id,
            extra_fields={"pptx_dirty": mode != "direct"},
        )

        if mode != "direct" and create_slides_oss_url:
            SlideProject.objects.using(postgres_app_db_alias()).filter(id=project.id).update(pptx_oss_url=create_slides_oss_url)
            project.pptx_oss_url = create_slides_oss_url

        self._register_embedded_fonts_for_pages(project, pages, "create_slides")
        self._persist_html_layout_problems(project, layout_problems)

        all_page_ids = [
            p.get("id") or p.get("page_id") for p in pages if isinstance(p, dict)
        ]
        all_page_ids = [pid for pid in all_page_ids if pid]

        from apps.tabslide.post_save import run_post_save_hooks
        run_post_save_hooks(
            project,
            version=new_version,
            pages_affected=all_page_ids or None,
            change_type="create_slides",
            summary=f"AI 生成 {len(pages)} 页幻灯片",
            editor_type=editor_type,
            editor_id=editor_id,
            create_history=True,
            force_history=True,
            agent_run_id=agent_run_id,
        )

        logger.info(
            "create_slides done | project=%s mode=%s pages=%d total_ms=%d",
            slide_project_id, mode, len(pages), total_ms,
        )

        page_order = [p.get("id") for p in pages if isinstance(p, dict) and p.get("id")]
        self._push_pages_to_ydoc(project, pages, page_order=page_order, source="create_slides")

        return project, pages

    def append_slides(
        self,
        slide_project_id: str,
        html: str,
        title: Optional[str] = None,
        mode: str = "direct",
        page_id: str | None = None,
        after_page_id: str | None = None,
        base_version: int | None = None,
        agent_run_id: str = "",
    ) -> tuple[SlideProject, list]:
        """追加模式：HTML → 新页面；不会删除或替换已有页面。"""
        project = self._get_project(slide_project_id, required_role="editor")
        pages, _create_slides_oss_url, total_ms = self._extract_slides_from_html(
            slide_project_id, project, html, title=title, mode=mode,
        )
        # 与 create_slides 对称：合并追加页的 HTML 布局问题到 font_meta（不清空旧页问题）
        new_layout = list(getattr(self, "_last_html_layout_problems", []) or [])
        if new_layout:
            merged = self.get_html_layout_problems(project) + new_layout
            self._persist_html_layout_problems(project, merged)
        if not pages:
            raise ValueError("HTML 未生成任何页面")
        if page_id and len(pages) != 1:
            raise ValueError("指定 page_id 时 HTML 只能生成 1 页")
        effective_base_version = base_version if base_version is not None else project.latest_version

        existing_pages = self._read_pages_from_slide_pages(project)
        existing_page_ids = [
            p.get("id") for p in existing_pages
            if isinstance(p, dict) and p.get("id")
        ]
        if page_id and page_id in existing_page_ids:
            raise ValueError(f"页面 ID 已存在: {page_id}")

        appended_pages: dict[str, dict] = {}
        appended_page_ids: list[str] = []
        for idx, page in enumerate(pages):
            if not isinstance(page, dict):
                continue
            new_page_id = page_id if page_id and idx == 0 else f"page-{uuid.uuid4().hex[:12]}"
            while new_page_id in existing_page_ids or new_page_id in appended_pages:
                new_page_id = f"page-{uuid.uuid4().hex[:12]}"
            page["id"] = new_page_id
            appended_pages[new_page_id] = page
            appended_page_ids.append(new_page_id)

        if not appended_pages:
            raise ValueError("HTML 未生成任何页面")

        if after_page_id:
            if after_page_id not in existing_page_ids:
                raise PageNotFoundError(_("tabslide.page_not_found_with_id", page_id=after_page_id))
            insert_at = existing_page_ids.index(after_page_id) + 1
        else:
            insert_at = len(existing_page_ids)
        page_order = existing_page_ids[:insert_at] + appended_page_ids + existing_page_ids[insert_at:]

        project = self.save_pages_incremental(
            slide_project_id,
            changed_pages=appended_pages,
            deleted_page_ids=[],
            page_order=page_order,
            base_version=effective_base_version,
            editor_type="agent",
            agent_run_id=agent_run_id,
        )
        self._register_embedded_fonts_for_pages(project, list(appended_pages.values()), "append_slides")

        logger.info(
            "append_slides done | project=%s mode=%s appended=%d total_ms=%d",
            slide_project_id, mode, len(appended_pages), total_ms,
        )
        all_pages = self._read_pages_from_slide_pages(project)
        return project, all_pages

    # ════════════════════════════════════════════════════════════════════
    # 保存编辑器修改 — CAS 写 DB + 创建快照 + 记录变更
    # ════════════════════════════════════════════════════════════════════

    def save_pages(
        self,
        slide_project_id: str,
        pages: list[dict],
        *,
        base_version: Optional[int] = None,
        editor_type: str = "user",
        agent_run_id: str = "",
    ) -> SlideProject:
        """
        编辑器保存：pages JSON → CAS 写入 DB → 创建历史快照 → 记录变更

        前端可传 base_version 做 CAS 校验（防并发覆盖）。
        不传时自动使用当前版本（自读自写模式，兼容旧前端）。
        """
        project = self._get_project(slide_project_id, required_role="editor")
        et, eid = self._editor_info(editor_type)

        # 净化 elements_data（纯 CPU 操作，事务外）
        # JSON-first：page['html'] / page['contentFormat'] 在 frontend_page_to_defaults
        # 内被 _SEALED_AFTER_CREATION_MODEL_FIELDS 守卫丢弃，不再到达 DB，因此无需 sanitize。
        for page in pages:
            if not isinstance(page, dict):
                continue
            if isinstance(page.get("elements"), list):
                _sanitize_elements_data(page["elements"])

        new_version = self._cas_save_pages(
            project,
            pages,
            editor_type=et,
            editor_id=eid,
            base_version=base_version,
        )

        from apps.tabslide.post_save import run_post_save_hooks
        run_post_save_hooks(
            project,
            version=new_version,
            change_type="save_pages",
            summary=f"保存 {len(pages)} 页",
            editor_type=et,
            editor_id=eid,
            create_history=True,
            agent_run_id=agent_run_id,
        )

        # E2E-022 + VS-002 fix: DB-first 写入后通知 collab-live 更新 Y.Doc version。
        # 使用统一降级函数：invalidate 失败或 updated=false 时自动降级为 force-close。
        try:
            from apps.collab.api import _invalidate_or_force_close
            _invalidate_or_force_close("slide", str(project.id), new_version)
        except Exception:
            logger.warning(
                "save_pages: notify collab-live version sync 失败 (slide=%s version=%d)",
                slide_project_id, new_version, exc_info=True,
            )

        page_order = [p.get("id") for p in pages if isinstance(p, dict) and p.get("id")]
        self._push_pages_to_ydoc(project, pages, page_order=page_order, source="save_pages")

        return project

    @staticmethod
    def _extract_page_meta(pages: list[dict]) -> dict | None:
        """从 pages 中提取扩展元数据（动画、翻页效果）。"""
        meta: dict = {}
        for page in pages:
            page_id = page.get("id")
            if not page_id:
                continue
            entry: dict = {}
            animations = page.get("animations")
            if isinstance(animations, list) and animations:
                entry["animations"] = animations
            turning_mode = page.get("turningMode")
            if isinstance(turning_mode, str) and turning_mode and turning_mode != "no":
                entry["turningMode"] = turning_mode
            if entry:
                meta[page_id] = entry
        return meta if meta else None

    @staticmethod
    def _merge_page_meta(pages: list[dict], page_meta: dict | None) -> list[dict]:
        """将 page_meta 中的扩展数据合并回 pages。"""
        if not page_meta or not isinstance(page_meta, dict):
            return pages
        for page in pages:
            page_id = page.get("id")
            if not page_id or page_id not in page_meta:
                continue
            entry = page_meta[page_id]
            if not isinstance(entry, dict):
                continue
            if "animations" in entry and isinstance(entry["animations"], list):
                page["animations"] = entry["animations"]
            if "turningMode" in entry and isinstance(entry["turningMode"], str):
                page["turningMode"] = entry["turningMode"]
        return pages

    # ════════════════════════════════════════════════════════════════════
    # 纯解析 PPTX（不创建项目）
    # ════════════════════════════════════════════════════════════════════

    @staticmethod
    def parse_pptx_content(
        file_base64: str,
        *,
        file_name: str = "import.pptx",
        canvas_width: int | None = None,
        canvas_height: int | None = None,
    ) -> dict:
        """
        纯解析 PPTX 文件内容（base64），返回 pages + 元数据。

        业务逻辑从 api.py handler 下沉至此，使 API 层保持薄壳。
        """
        import base64 as _b64
        import tempfile

        MAX_FILE_SIZE = 50 * 1024 * 1024

        file_bytes = _b64.b64decode(file_base64)
        if len(file_bytes) > MAX_FILE_SIZE:
            raise ValueError(
                f"文件大小 {len(file_bytes) / 1024 / 1024:.1f}MB 超过上限 50MB"
            )

        tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
        tmp_path = tmp.name
        try:
            tmp.write(file_bytes)
            tmp.close()

            if canvas_width and canvas_height:
                cw, ch = canvas_width, canvas_height
            else:
                cw, ch = SlideService._detect_pptx_dimensions(tmp_path)

            image_handler = build_oss_image_handler()

            from apps.tabslide.services.pptx_io import (
                extract_embedded_fonts,
                extract_theme_fonts,
                extract_theme_payload,
                read,
            )
            pages = read(tmp_path, canvas_width=cw, canvas_height=ch, image_handler=image_handler)
            theme_fonts = extract_theme_fonts(tmp_path)
            theme_payload = extract_theme_payload(tmp_path)
            embedded_fonts = extract_embedded_fonts(tmp_path)

            SlideService._generate_html_for_imported_pages(pages, cw, ch)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        ratio = cw / ch if ch > 0 else 1.78
        preset = "ppt" if ratio > 1.5 else "4:3" if ratio > 1.2 else "portrait"
        name = (file_name or "import.pptx").replace(".pptx", "").replace(".PPTX", "")

        result: dict = {
            "pages": pages,
            "canvas_width": cw,
            "canvas_height": ch,
            "preset": preset,
            "name": name,
            "page_count": len(pages),
        }
        if theme_payload:
            result["theme"] = theme_payload
        if embedded_fonts:
            result["embedded_fonts"] = embedded_fonts
        if theme_fonts:
            result["theme_fonts"] = theme_fonts
        return result

    # ════════════════════════════════════════════════════════════════════
    # 导入 PPTX
    # ════════════════════════════════════════════════════════════════════

    def import_pptx(
        self,
        organization_id: str,
        space_id: str,
        file_name: str,
        file_chunks,
        max_size: int = 50 * 1024 * 1024,
        agent_run_id: str = "",
        editor_type: str = "",
        collection_id: Optional[str] = None,
    ) -> tuple[SlideProject, list]:
        """上传 PPTX → 一次性解析 → SlidePage + font_meta 写入 DB"""
        if not self.check_space_permission(space_id, required_role="editor"):
            raise PermissionError(_("tabslide.no_permission_to_import"))
        if collection_id:
            from apps.tabtinspace.models import Collection
            from apps.tabtinspace.services.asset_host import asset_host_q
            if not Collection.objects.filter(asset_host_q(space_id), id=collection_id).exists():
                raise ValueError(_("tabtinspace.collection_not_found"))

        tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
        tmp_path = tmp.name
        try:
            total_bytes = 0
            for chunk in file_chunks:
                total_bytes += len(chunk)
                if total_bytes > max_size:
                    tmp.close()
                    raise ValueError(
                        f"文件大小 {total_bytes / 1024 / 1024:.1f}MB 超过上限 "
                        f"{max_size / 1024 / 1024:.0f}MB"
                    )
                tmp.write(chunk)
            tmp.close()

            from apps.tabslide.services.pptx_io import (
                InvalidPptxError,
                extract_embedded_fonts,
                read_all,
                validate_pptx_file,
            )

            validate_pptx_file(tmp_path)

            geometry = self._detect_pptx_geometry(tmp_path)
            canvas_width = geometry["canvas_width"]
            canvas_height = geometry["canvas_height"]
            slide_width_emu = geometry["slide_width_emu"]
            slide_height_emu = geometry["slide_height_emu"]

            import uuid as _uuid
            _import_batch_id = str(_uuid.uuid4())
            image_handler = build_oss_image_handler(
                organization_id=organization_id,
                user_id=str(self.user.id) if self.user else "",
                context_type="import_image",
                context_id=_import_batch_id,
            )
            result_all = read_all(tmp_path, canvas_width=canvas_width, canvas_height=canvas_height, image_handler=image_handler)
            pages = result_all["pages"]
            theme_payload = result_all["theme_payload"]
            theme_fonts = result_all["theme_fonts"]
            embedded_fonts = extract_embedded_fonts(tmp_path)

            self._generate_html_for_imported_pages(pages, canvas_width, canvas_height)

            name = Path(file_name).stem if file_name else "导入的演示文稿"

            ratio = canvas_width / canvas_height if canvas_height > 0 else 1.78
            preset = "ppt" if ratio > 1.5 else "4:3" if ratio > 1.2 else "ppt"

            sanitized_embedded = self._sanitize_embedded_fonts(embedded_fonts)
            sanitized_embedded = self.upload_fonts_to_oss(
                sanitized_embedded,
                organization_id=organization_id,
                user_id=str(self.user.id) if self.user else "",
                context_id=_import_batch_id,
            )
            sanitized_theme_fonts = self._sanitize_theme_fonts(theme_fonts)
            font_meta = None
            if sanitized_embedded or sanitized_theme_fonts:
                font_meta = {
                    "embedded_fonts": sanitized_embedded,
                    "theme_fonts": sanitized_theme_fonts,
                }

            pptx_oss_url = self._upload_pptx_to_oss(
                tmp_path, "import",
                organization_id=organization_id,
                user_id=str(self.user.id) if self.user else "",
            ) or ""
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        _inferred_editor_type = editor_type or ("agent" if agent_run_id else "user")
        editor_type_val, editor_id = self._editor_info(_inferred_editor_type)

        with transaction.atomic(using=postgres_app_db_alias()):
            project = SlideProject.objects.create(
                organization_id=organization_id,
                space_id=space_id,
                name=name,
                preset=preset,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
                page_count=len(pages),
                pptx_oss_url=pptx_oss_url,
                pptx_dirty=False,
                pages_data=None,
                font_meta=font_meta,
                theme=self._inject_source_slide_emu(
                    theme_payload,
                    slide_width_emu=slide_width_emu,
                    slide_height_emu=slide_height_emu,
                ),
                latest_version=1,
                last_editor_type=editor_type_val,
                last_editor_id=editor_id,
                created_by=self.user,
                updated_by=self.user,
            )

            # SlidePage 必须在同一事务内写入，失败则整个导入回滚
            self._sync_slide_pages(project, pages, version=1)
            context_item = ResourceBridge.on_create(
                project,
                user=self.user,
                collection_id=collection_id,
            )
            if context_item is None:
                raise RuntimeError("演示文稿已创建，但写入云盘资源索引失败")

        if _import_batch_id:
            _backfill_ok = False
            for _attempt in range(3):
                try:
                    from apps.services.oss.models import FileUsage
                    _updated = FileUsage.objects.filter(
                        module="tabslide",
                        context_type__in=["import_image", "font"],
                        context_id=_import_batch_id,
                        is_active=True,
                    ).update(context_id=str(project.id))
                    _backfill_ok = True
                    logger.info(
                        "导入 FileUsage context_id 回填成功（图片+字体）: project=%s, updated=%d, attempt=%d",
                        project.id, _updated, _attempt + 1,
                    )
                    break
                except Exception:
                    if _attempt == 2:
                        logger.error(
                            "导入 FileUsage context_id 回填最终失败（已重试 3 次）: "
                            "project=%s, batch_id=%s — 这些 FileUsage 记录（图片+字体）将无法被项目清理匹配",
                            project.id, _import_batch_id, exc_info=True,
                        )
                    else:
                        import time as _time
                        _time.sleep(0.5)
            if not _backfill_ok:
                logger.error(
                    "PPTX 导入 FileUsage 回填失败，batch_id=%s 未关联到 project=%s，"
                    "需要手动修复: UPDATE file_usage SET context_id='%s' WHERE context_id='%s'",
                    _import_batch_id, project.id, project.id, _import_batch_id,
                )

        all_page_ids = [
            p.get("id") or p.get("page_id") for p in pages if isinstance(p, dict)
        ]
        all_page_ids = [pid for pid in all_page_ids if pid]

        from apps.tabslide.post_save import run_post_save_hooks
        run_post_save_hooks(
            project,
            version=project.latest_version,
            pages_affected=all_page_ids or None,
            change_type="import_pptx",
            summary=f"导入 {name} ({len(pages)} 页)",
            editor_type=editor_type_val,
            editor_id=editor_id,
            create_history=True,
            force_history=True,
            agent_run_id=agent_run_id,
        )

        self._push_pages_to_ydoc(project, pages, source="import_pptx")

        return project, pages

    @staticmethod
    def _generate_html_for_imported_pages(
        pages: list[dict],
        canvas_width: int,
        canvas_height: int,
    ) -> None:
        """
        为 pptx_io.read() 产出的 PPTElement 页面生成 html_source 缓存。

        链路：PPTElement JSON → build_slide_html → html_source。
        导入的页面保持 contentFormat='json'（PPTElement 渲染是高保真的），
        html_source 仅作为 Agent 读取和后续 HTML-first 迁移的缓存，
        不影响前端渲染路径。
        """
        from apps.tabslide.services.preview_service import build_slide_html

        for page in pages:
            if not isinstance(page, dict):
                continue
            elements = page.get("elements", [])
            background = page.get("background")
            try:
                html = build_slide_html(
                    elements=elements,
                    background=background,
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                )
                page["html"] = html
            except Exception as exc:
                logger.warning(
                    "import_pptx: failed to generate html for page %s: %s",
                    page.get("id", "?"), exc,
                )

    @staticmethod
    def _detect_pptx_geometry(pptx_path: str) -> dict:
        """从 PPTX 文件中检测画布尺寸（px）与原始页面尺寸（EMU）。"""
        try:
            from pptx import Presentation

            prs = Presentation(pptx_path)
            w_emu = prs.slide_width or 0
            h_emu = prs.slide_height or 0

            if w_emu == 0 or h_emu == 0:
                return {
                    "canvas_width": 1280,
                    "canvas_height": 720,
                    "slide_width_emu": None,
                    "slide_height_emu": None,
                }

            canvas_width = SlideService._slide_emu_to_canvas_px(int(w_emu))
            canvas_height = SlideService._slide_emu_to_canvas_px(int(h_emu))

            return {
                "canvas_width": canvas_width,
                "canvas_height": canvas_height,
                "slide_width_emu": int(w_emu),
                "slide_height_emu": int(h_emu),
            }
        except Exception as e:
            logger.warning(f"Failed to detect PPTX dimensions: {e}")
            return {
                "canvas_width": 1280,
                "canvas_height": 720,
                "slide_width_emu": None,
                "slide_height_emu": None,
            }

    @staticmethod
    def _detect_pptx_dimensions(pptx_path: str) -> tuple[int, int]:
        """兼容旧调用：仅返回画布尺寸（px）。"""
        geometry = SlideService._detect_pptx_geometry(pptx_path)
        return int(geometry["canvas_width"]), int(geometry["canvas_height"])

    # ════════════════════════════════════════════════════════════════════
    # 导出 — 按需从 SlidePage 聚合生成 PPTX，上传 OSS
    # ════════════════════════════════════════════════════════════════════

    def get_export_pptx_path(self, slide_project_id: str) -> tuple[SlideProject, str]:
        """
        获取可导出的 PPTX 文件。

        JSON-first：所有页面已是 elements_data（PPTElement[]）真相源，导出直接序列化。
        使用智能缓存 — 内容哈希匹配时直接返回 OSS URL，否则生成 PPTX 并缓存。
        """
        project = self._get_project(slide_project_id, required_role="viewer")

        pages = self._read_pages_from_slide_pages(project)
        if not pages:
            raise ValueError(_("tabslide.no_pages_for_export"))
        pages = self._normalize_pages_for_pptx_export(pages)

        from apps.tabslide.services.pptx_cache import get_cached_or_generate_pptx

        path_or_url, is_oss = get_cached_or_generate_pptx(project, pages)
        project.refresh_from_db()
        return project, path_or_url

    def _generate_pptx_from_pages(self, project: SlideProject, pages: list[dict]) -> str:
        """从 pages 列表生成 PPTX 文件并上传 OSS，返回 OSS URL。

        JSON-first：pages 中每页已是 PPTElement[]，直接交 pptx_io.write 序列化。
        临时文件在本方法内完成清理，不泄漏到调用方。
        """
        from apps.tabslide.services.pptx_io import write

        pages = self._normalize_pages_for_pptx_export(pages)
        output_fd, output_path = tempfile.mkstemp(suffix=".pptx")
        os.close(output_fd)
        try:
            source_slide_width_emu, source_slide_height_emu = self._extract_source_slide_emu(project.theme)

            write(
                pages=pages,
                output_path=output_path,
                canvas_width=project.canvas_width,
                canvas_height=project.canvas_height,
                template_path=None,
                source_slide_width_emu=source_slide_width_emu,
                source_slide_height_emu=source_slide_height_emu,
                # 不内嵌字体：WPS pptxrw 解析内嵌字体空指针崩溃，pptx 在 WPS 打开即闪退。
                font_meta=None,
                aigc_metadata={
                    "projectId": str(project.id),
                    "organizationId": str(getattr(project, "organization_id", "") or ""),
                    "spaceId": str(getattr(project, "space_id", "") or ""),
                    "name": project.name or "",
                },
            )

            oss_url = self._upload_pptx_to_oss(
                output_path, str(project.id),
                organization_id=str(getattr(project, "organization_id", "")),
                user_id=str(self.user.id) if self.user else "",
            )
            if oss_url:
                return oss_url
            raise RuntimeError(_("tabslide.pptx_upload_failed"))
        finally:
            try:
                os.unlink(output_path)
            except OSError:
                pass

    # ════════════════════════════════════════════════════════════════════
    # 元素级编辑
    # ════════════════════════════════════════════════════════════════════

    def _best_effort_sync_yjs(
        self,
        project_id: str,
        sync_changes: List[Dict[str, Any]],
    ) -> None:
        """DB-first 写入后，把同样的 patch 推到 Y.Doc，避免被 collab persist 反向覆盖。

        场景：Agent 通过 API 改 PPT 元素，DB-first 路径走通（因为 Y.js-first
        在 Y.Doc 没数据时会失败降级）。但如果**同时**有用户在 Electron 客户端
        打开了同一个 PPT，前端 Y.Doc 还持有旧数据，5s debounce 后 onStore 会把
        旧数据 persist 回 SlidePage，把 Agent 的修改吃掉。

        这个 helper 在 DB 写入之后再次尝试推 Y.Doc：
          - Y.Doc 在线且有 page 数据：被 patch 更新 → 跟 DB 一致 → 后续 persist 无冲突
          - Y.Doc 未启动 / 无 page 数据：applied=0，无副作用
          - collab-live 不可达：仅记 log，DB 写入不回滚

        是 best-effort，绝不让任何异常冒泡影响 DB 写入。
        """
        if not sync_changes:
            return
        try:
            from apps.tabslide.services.collab_service import SlideCollabService
            from apps.services.common.config import is_yjs_first_enabled
            if not is_yjs_first_enabled("tabslide"):
                return
            result = SlideCollabService.push_element_changes(
                project_id=project_id,
                changes=[
                    {
                        "page_id": c["page_id"],
                        "type": "update",
                        "element_id": c["element_id"],
                        "patch": c["patch"],
                    }
                    for c in sync_changes
                ],
                editor_type="system",
            )
            applied = int(result.get("applied", 0) or 0)
            if applied > 0:
                logger.info(
                    "best-effort Y.Doc sync: applied %d/%d patches to Y.Doc after DB write (project=%s)",
                    applied, len(sync_changes), project_id,
                )
        except Exception:
            logger.warning(
                "best-effort Y.Doc sync failed (DB write succeeded, but online clients may briefly hold stale data): project=%s",
                project_id, exc_info=True,
            )

    def update_element_by_page_id(
        self,
        slide_project_id: str,
        page_id: str,
        element_id: str,
        patch: dict,
        *,
        base_version: Optional[int] = None,
        editor_type: str = "agent",
    ) -> dict:
        """
        通过 page_id（而非 page_index）精准修改元素。

        相比 update_element 的优势：
        - page_id 是稳定标识符，不受页面插入/删除影响
        - 直接查 SlidePage 表，不需要先排序再按索引定位
        """
        project = self._get_project(slide_project_id, required_role="editor")
        et, eid = self._editor_info(editor_type)

        with transaction.atomic(using=postgres_app_db_alias()):
            # select_for_update 锁行，消除读取元素与写入之间的 TOCTOU 窗口
            try:
                project_row = (
                    SlideProject.objects.using(postgres_app_db_alias())
                    .select_for_update()
                    .get(id=project.id)
                )
            except SlideProject.DoesNotExist:
                raise SlideNotFoundError(_("tabslide.project_not_found"))

            if base_version is None:
                base_version = project_row.latest_version
            next_version = base_version + 1

            if project_row.latest_version != base_version:
                raise ConflictError(
                    f"版本冲突：提交版本 {base_version}，当前版本 {project_row.latest_version}"
                )

            try:
                slide_page = SlidePage.objects.using(postgres_app_db_alias()).get(
                    project=project, page_id=page_id,
                )
            except SlidePage.DoesNotExist:
                raise PageNotFoundError(_("tabslide.page_not_found", page_id=page_id))

            elements = slide_page.elements_data or []
            target = None
            for el in elements:
                if el.get("id") == element_id:
                    target = el
                    break

            if not target:
                raise ElementNotFoundError(_("tabslide.element_not_found_on_page", element_id=element_id, page_id=page_id))

            # Phase-3 Wave-4 type-aware 校验：拦截"image 元素被强加 content"这类数据污染
            # (子 Agent 实测发现 server 之前会静默接受，导致 element 永久带上无效字段)
            try:
                validate_props_for_element_type(target.get("type", ""), patch)
            except PatchValidationError:
                raise

            import copy
            before_snapshot = copy.deepcopy({k: target.get(k) for k in patch})

            _deep_merge(target, patch)
            _sanitize_elements_data(elements)

            after_snapshot = {k: target.get(k) for k in patch}

            SlideProject.objects.using(postgres_app_db_alias()).filter(
                id=project.id,
            ).update(
                latest_version=next_version,
                last_editor_type=et,
                last_editor_id=eid,
                updated_at=timezone.now(),
                **({"updated_by": self.user} if self.user else {}),
            )

            from apps.tabslide.services.pptx_cache import mark_pages_dirty
            mark_pages_dirty(str(project.id), [page_id])

            slide_page.elements_data = elements
            slide_page.version = next_version
            slide_page.save(using=postgres_app_db_alias(), update_fields=["elements_data", "version", "updated_at"])

        project.refresh_from_db()
        from apps.tabslide.post_save import run_post_save_hooks
        run_post_save_hooks(
            project,
            version=next_version,
            pages_affected=[page_id],
            change_type="update_element",
            summary=f"修改页面 {page_id} 元素 {element_id}",
            editor_type=et,
            editor_id=eid,
            create_history=True,
        )

        # 元素级变更记录（审计追溯）
        self._record_element_change(
            project,
            page_id=page_id,
            element_id=element_id,
            version=next_version,
            change_type="update",
            changed_fields=list(patch.keys()),
            before_data=before_snapshot,
            after_data=after_snapshot,
            editor_type=et,
            editor_id=eid,
        )

        # best-effort 把同样的 patch 推到 Y.Doc，避免在线客户端的旧数据反向覆盖
        self._best_effort_sync_yjs(str(project.id), [{
            "page_id": page_id,
            "element_id": element_id,
            "patch": patch,
        }])

        return target

    def batch_update_elements(
        self,
        slide_project_id: str,
        updates: List[Dict[str, Any]],
        *,
        base_version: Optional[int] = None,
        editor_type: str = "agent",
        agent_run_id: str = "",
    ) -> dict:
        """
        Agent 批量修改元素（跨页面，一个事务）。

        updates: [{ page_id, element_id, patch }, ...]

        返回:
        {
            "applied": 成功修改的元素数,
            "total": 总请求数,
            "version": 新版本号,
            "pages_affected": [修改的 page_id 列表],
            "skipped": [{"page_id", "element_id", "reason": "page_not_found"|"element_not_found"}, ...],
        }
        """
        project = self._get_project(slide_project_id, required_role="editor")
        et, eid = self._editor_info(editor_type)

        if base_version is None:
            base_version = project.latest_version
        next_version = base_version + 1

        # 按 page_id 分组
        pages_updates: Dict[str, List[Dict[str, Any]]] = {}
        for update in updates:
            pid = update.get("page_id", "")
            if pid:
                pages_updates.setdefault(pid, []).append(update)

        if not pages_updates:
            raise ValueError(_("tabslide.no_valid_element_updates"))

        applied_count = 0
        pages_affected = []
        pending_element_changes = []
        skipped = []

        with transaction.atomic(using=postgres_app_db_alias()):
            # select_for_update 锁行 + CAS 校验，但不立即推进版本
            try:
                project_row = (
                    SlideProject.objects.using(postgres_app_db_alias())
                    .select_for_update()
                    .get(id=project.id)
                )
            except SlideProject.DoesNotExist:
                raise SlideNotFoundError(_("tabslide.project_not_found"))

            if project_row.latest_version != base_version:
                raise ConflictError(
                    f"版本冲突：提交版本 {base_version}，当前版本 {project_row.latest_version}"
                )

            for page_id, page_updates in pages_updates.items():
                try:
                    slide_page = (
                        SlidePage.objects.using(postgres_app_db_alias())
                        .select_for_update()
                        .get(project=project, page_id=page_id)
                    )
                except SlidePage.DoesNotExist:
                    logger.warning("batch_update: page %s not found, skipping", page_id)
                    for upd in page_updates:
                        skipped.append({
                            "page_id": page_id,
                            "element_id": upd.get("element_id", ""),
                            "reason": "page_not_found",
                        })
                    continue

                import copy
                elements = slide_page.elements_data or []
                el_map = {el.get("id", ""): el for el in elements}
                page_modified = False
                element_changes = []

                for update in page_updates:
                    eid_target = update.get("element_id", "")
                    patch = update.get("patch", {})
                    if eid_target in el_map and patch:
                        target_el = el_map[eid_target]
                        # Phase-3 Wave-4 type-aware 校验：批量也要做
                        # 单条不合法不会拖累其他元素，统一进 skipped 列表
                        try:
                            validate_props_for_element_type(
                                target_el.get("type", ""), patch,
                            )
                        except PatchValidationError as ve:
                            skipped.append({
                                "page_id": page_id,
                                "element_id": eid_target,
                                "reason": "props_incompatible_with_type",
                                "details": ve.errors,
                            })
                            continue
                        before = copy.deepcopy(target_el)
                        _deep_merge(target_el, patch)
                        element_changes.append((page_id, eid_target, patch, before, target_el))
                        applied_count += 1
                        page_modified = True
                    elif eid_target not in el_map:
                        skipped.append({
                            "page_id": page_id,
                            "element_id": eid_target,
                            "reason": "element_not_found",
                        })

                if page_modified:
                    _sanitize_elements_data(elements)
                    slide_page.elements_data = elements
                    slide_page.version = next_version
                    slide_page.save(
                        using=postgres_app_db_alias(),
                        update_fields=["elements_data", "version", "updated_at"],
                    )
                    pages_affected.append(page_id)
                    pending_element_changes.extend(element_changes)

            # 仅在实际有修改时才推进版本号
            if applied_count > 0:
                SlideProject.objects.using(postgres_app_db_alias()).filter(
                    id=project.id,
                ).update(
                    latest_version=next_version,
                    last_editor_type=et,
                    last_editor_id=eid,
                    updated_at=timezone.now(),
                    **({"updated_by": self.user} if self.user else {}),
                )

                if pages_affected:
                    from apps.tabslide.services.pptx_cache import mark_pages_dirty
                    mark_pages_dirty(str(project.id), pages_affected)

        project.refresh_from_db()
        actual_version = project.latest_version

        if applied_count > 0:
            from apps.tabslide.post_save import run_post_save_hooks
            run_post_save_hooks(
                project,
                version=actual_version,
                pages_affected=pages_affected,
                change_type="update_element",
                summary=f"批量修改 {applied_count} 个元素（{len(pages_affected)} 页）",
                editor_type=et,
                editor_id=eid,
                create_history=True,
                agent_run_id=agent_run_id,
            )

            for pid, eid_target, patch, before, after in pending_element_changes:
                self._record_element_change(
                    project,
                    page_id=pid,
                    element_id=eid_target,
                    version=actual_version,
                    change_type="update",
                    changed_fields=list(patch.keys()),
                    before_data=before,
                    after_data=after,
                    editor_type=et,
                    editor_id=eid,
                )

            # best-effort 把同样的 patch 推到 Y.Doc，避免在线客户端的旧数据反向覆盖
            sync_changes = [
                {"page_id": pid, "element_id": eid_t, "patch": p}
                for pid, eid_t, p, _b, _a in pending_element_changes
            ]
            self._best_effort_sync_yjs(str(project.id), sync_changes)

        return {
            "applied": applied_count,
            "total": len(updates),
            "version": actual_version,
            "pages_affected": pages_affected,
            "skipped": skipped,
        }

    # ════════════════════════════════════════════════════════════════════
    # 按需加载（Phase 2）
    # ════════════════════════════════════════════════════════════════════

    def get_page_detail(self, slide_project_id: str, page_id: str) -> dict:
        """
        获取单页完整数据（含 elements_data）。

        用途：
          - Agent 元素编辑前只需加载目标页（避免全量读取）
          - 前端懒加载页面内容
        """
        project = self._get_project(slide_project_id, required_role="viewer")
        try:
            page = SlidePage.objects.using(postgres_app_db_alias()).get(
                project=project, page_id=page_id,
            )
        except SlidePage.DoesNotExist:
            raise PageNotFoundError(_("tabslide.page_not_found", page_id=page_id))

        result = model_row_to_full_frontend_page(page)
        return {
            **result,
            "version": page.version,
        }

    def get_pages_outline(self, slide_project_id: str) -> list[dict]:
        """
        获取所有页面大纲（不含 elements_data）。

        返回轻量级页面列表，用于：
          - 缩略图面板和页面导航
          - 快速判断页面数量和排序
          - Agent 选择目标页面

        不含 elements_data，100 页大纲 < 10KB（vs 全量 ~6MB）。
        """
        project = self._get_project(slide_project_id, required_role="viewer")
        rows = (
            SlidePage.objects.using(postgres_app_db_alias())
            .filter(project=project)
            .order_by("order")
            .only(
                "page_id", "order", "background", "remark",
                "turning_mode", "version",
                "section_tag", "slide_type", "slide_notes",
                "elements_data",
            )
        )
        from apps.tabslide.field_mapping import model_key_to_fe, normalize_background_for_api
        return [
            {
                "id": r.page_id,
                "order": r.order,
                "summary": self._extract_page_summary(r.elements_data),
                "element_count": len(r.elements_data) if isinstance(r.elements_data, list) else 0,
                "background": normalize_background_for_api(r.background),
                "remark": r.remark or "",
                model_key_to_fe("turning_mode"): r.turning_mode or "",
                **({"section_tag": r.section_tag} if r.section_tag is not None else {}),
                **({"slide_type": r.slide_type} if r.slide_type else {}),
                **({"slide_notes": r.slide_notes} if r.slide_notes is not None else {}),
                "version": r.version,
            }
            for r in rows
        ]

    @staticmethod
    def _extract_page_summary(elements_data: list | None, max_len: int = 60) -> str:
        """从 elements_data 提取首个文本元素的纯文本作为页面摘要。"""
        if not elements_data:
            return ""
        import re as _re
        for el in elements_data:
            if not isinstance(el, dict) or el.get("type") != "text":
                continue
            props = el.get("props", el)
            content = props.get("content", "")
            if not content:
                continue
            plain = _re.sub(r"<[^>]+>", "", content).strip()
            if plain:
                return plain[:max_len]
        return ""

    # ════════════════════════════════════════════════════════════════════
    # 增量同步
    # ════════════════════════════════════════════════════════════════════

    def check_sync_status(
        self,
        slide_project_id: str,
        client_version: int,
    ) -> dict:
        """
        检查客户端是否需要同步。

        返回:
          - has_changes: 是否有新变更
          - latest_version: 服务端当前版本
          - changes: 自 client_version 以来的变更摘要列表
        """
        project = self._get_project(slide_project_id, required_role="viewer")

        has_changes = project.latest_version > client_version
        changes = []
        if has_changes:
            recent_changes = list(
                project.changes.using(postgres_app_db_alias())
                .filter(version__gt=client_version)
                .order_by("version")
                .values("version", "change_type", "summary", "editor_type", "created_at")[:20]
            )
            changes = [
                {
                    "version": c["version"],
                    "change_type": c["change_type"],
                    "summary": c["summary"],
                    "editor_type": c["editor_type"],
                    "created_at": c["created_at"].isoformat() if c["created_at"] else None,
                }
                for c in recent_changes
            ]

        return {
            "has_changes": has_changes,
            "latest_version": project.latest_version,
            "changes": changes,
        }


_DEEP_MERGE_BLOCKED_KEYS = frozenset({
    "type", "id", "elements", "elementOrder", "elementsMap",
    "content_format", "page_id", "project",
})


def _deep_merge(target: dict, patch: dict, *, _depth: int = 0) -> None:
    """递归深度合并 patch 到 target。

    安全策略：
    - 仅顶层（depth=0）过滤 _DEEP_MERGE_BLOCKED_KEYS，防止 Agent 注入结构字段
    - 嵌套层允许 type 等字段通过（如 fill.type、shadow.type）
    - 数组处理：带 id 的元素按 ID 匹配合并，否则整体替换
    """
    for key, value in patch.items():
        if _depth == 0 and key in _DEEP_MERGE_BLOCKED_KEYS:
            continue
        if key in target and isinstance(target[key], dict) and isinstance(value, dict):
            _deep_merge(target[key], value, _depth=_depth + 1)
        elif (
            key in target
            and isinstance(target[key], list)
            and isinstance(value, list)
            and value
            and all(isinstance(v, dict) and "id" in v for v in value)
        ):
            _merge_list_by_id(target[key], value)
        else:
            target[key] = value


def _merge_list_by_id(target_list: list, patch_list: list) -> None:
    """按 id 字段合并两个 dict 数组，保留未被 patch 覆盖的元素。"""
    index: dict[str, dict] = {}
    for item in target_list:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            index[item["id"]] = item
    for patch_item in patch_list:
        if not isinstance(patch_item, dict):
            continue
        pid = patch_item.get("id")
        if not isinstance(pid, str):
            target_list.append(patch_item)
            continue
        if pid in index:
            _deep_merge(index[pid], patch_item)
        else:
            target_list.append(patch_item)
            index[pid] = patch_item
