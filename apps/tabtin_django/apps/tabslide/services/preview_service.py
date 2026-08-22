"""
TabSlide Preview & Visual Lint Service

Server-side rendering of slide pages using Playwright for:
  - Agent self-inspection (preview screenshots)
  - Visual lint (automated quality checks)

Renders PPTElement data to a minimal HTML page, screenshots with Playwright,
and optionally injects lint checks for common visual issues.
"""

from __future__ import annotations

import asyncio
import html as _html_mod
import json
import logging
import os
import re
import tempfile
import uuid
from typing import Any, Optional

from apps.tabslide.services.html_render_runtime import (
    ECHARTS_SCRIPT_HTML,
    MATHJAX_SCRIPT_HTML,
    build_local_font_face_css,
    load_render_document,
    wait_for_image_decode,
    wait_for_optional_render_ready,
)

logger = logging.getLogger(__name__)

SLIDE_WIDTH_PX = 1280
SLIDE_HEIGHT_PX = 720
DEFAULT_SCALE_FACTOR = 2


def _flatten_backend_element(el: dict[str, Any]) -> dict[str, Any]:
    """
    Flatten backend-format element (base + props nesting) to a flat dict.

    Backend stores elements as {type, id, x, y, width, height, ..., props: {...}}.
    The preview renderer expects all properties at the top level.
    """
    props = el.get("props")
    if not isinstance(props, dict):
        return el
    flat = {k: v for k, v in el.items() if k != "props"}
    for k, v in props.items():
        if k not in flat:
            flat[k] = v
    return flat


# ============================================================================
# HTML Builder: PPTElement[] → HTML string
# ============================================================================


def build_slide_html(
    elements: list[dict[str, Any]],
    background: dict[str, Any] | None = None,
    canvas_width: int = 1280,
    canvas_height: int = 720,
) -> str:
    """
    Build a standalone HTML page that renders PPTElements as positioned DOM nodes.

    This is a simplified server-side renderer — not pixel-perfect with the React
    frontend, but accurate enough for Agent preview and lint checks.
    """
    bg_css = _build_background_css(background)

    elements_html = "\n".join(
        _render_element(_flatten_backend_element(el), canvas_width, canvas_height)
        for el in elements
        if el.get("type") and not el.get("isDelete")
    )

    has_chart = any(e.get("type") == "chart" for e in elements)
    has_latex = any(e.get("type") == "latex" for e in elements)

    cdn_scripts = ""
    if has_chart:
        cdn_scripts += ECHARTS_SCRIPT_HTML
    if has_latex:
        cdn_scripts += (
            '<script>'
            'window.MathJax = {tex:{inlineMath:[["\\\\(","\\\\)"]]},svg:{fontCache:"global"}};'
            '</script>\n'
            + MATHJAX_SCRIPT_HTML
        )

    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
{build_local_font_face_css()}{cdn_scripts}
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ overflow: hidden; }}
.ppt-slide {{
  position: relative;
  width: {canvas_width}px;
  height: {canvas_height}px;
  {bg_css}
  overflow: hidden;
  font-family: 'Inter', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}}
.element {{
  position: absolute;
}}
.element[data-element-type="text"] {{
  overflow: visible;
}}
</style>
</head>
<body>
<div class="ppt-slide">
{elements_html}
</div>
</body>
</html>"""

    return _inline_oss_image_urls(html)


# ============================================================================
# OSS image inlining
#
# 背景：preview_service 用 Playwright headless 渲染 HTML 截图，浏览器加载
# `<img src="https://...oss-cn-wuhan-lr.aliyuncs.com/...">` 时走系统 DNS。
# 部分本地开发环境跑透明代理（ClashX/Surge），把所有公网域名劫持到
# 198.18.x.x 假 IP（RFC 5735 reserved range），导致图片加载失败，
# preview 截图里只剩占位框。
#
# 修复策略与 pptx_io 已落地的 `_download_image_smart` 保持一致：命中我们
# OSS bucket 的 URL → OSS SDK 下载后内联为 data: URI；外部 URL 保持原状
# （Playwright 自行处理，外部域名不受 198.18 劫持影响）。
# ============================================================================


_OSS_IMG_SRC_RE = re.compile(
    r'(<img\s+[^>]*?src\s*=\s*["\'])([^"\']+)(["\'])',
    re.IGNORECASE,
)
_OSS_BG_URL_RE = re.compile(
    r"(background-image\s*:\s*url\(\s*['\"]?)([^'\")]+)(['\"]?\s*\))",
    re.IGNORECASE,
)


def _guess_image_mime(url: str) -> str:
    """根据 URL 扩展名推断 MIME；默认 PNG。"""
    low = url.lower().split("?", 1)[0]
    if low.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if low.endswith(".gif"):
        return "image/gif"
    if low.endswith(".webp"):
        return "image/webp"
    if low.endswith(".svg"):
        return "image/svg+xml"
    if low.endswith(".bmp"):
        return "image/bmp"
    return "image/png"


def _inline_oss_image_urls(html: str) -> str:
    """把 HTML 里命中我们 OSS bucket 的图片 URL 替换为 base64 data: URI。

    用途：避免 Playwright headless 在本地代理 DNS 劫持的环境下无法加载 OSS
    图片。复用 `pptx_io._download_image_smart` 的下载策略（OSS SDK 优先，
    SDK 失败回退 HTTPS），保持与导出链路一致。

    扫两类引用：
      - `<img src="...">`（image element / 用户 HTML 内容）
      - `background-image: url(...)`（slide 背景 / shape 装饰）

    仅替换命中我们 OSS bucket 的 URL，外部 URL（CDN / fonts / 其他源图片）
    保持原状由 Playwright 自行加载。
    """
    if not html or not isinstance(html, str):
        return html

    import html as _stdlib_html

    try:
        from apps.tabslide.services.pptx_io import (
            _download_image_smart,
            _parse_oss_url_to_object_key,
        )
    except Exception as exc:
        # 上游依赖异常不应阻断 preview；保守保留原 HTML
        logger.warning("inline OSS URL skipped, pptx_io import failed: %s", exc)
        return html

    # 缓存同一 HTML 内重复出现的 URL，避免重复下载
    cache: dict[str, Optional[str]] = {}

    def _resolve(raw_url: str) -> Optional[str]:
        """把 OSS URL 解析为 data: URI；非 OSS / 失败时返回 None。"""
        if raw_url in cache:
            return cache[raw_url]

        # HTML 转义可能把 & 转成 &amp;（_html_attr 干的），解一下原样喂给下载器
        decoded = _stdlib_html.unescape(raw_url)

        # data: URL 已经是内联格式，无需处理
        if decoded.startswith("data:"):
            cache[raw_url] = None
            return None

        if _parse_oss_url_to_object_key(decoded) is None:
            cache[raw_url] = None
            return None

        try:
            payload = _download_image_smart(decoded, max_bytes=20 * 1024 * 1024)
        except Exception as exc:
            logger.warning("OSS inline download error: %s url=%s", exc, decoded[:120])
            payload = None

        if not payload:
            cache[raw_url] = None
            return None

        import base64
        mime = _guess_image_mime(decoded)
        encoded = base64.b64encode(payload).decode("ascii")
        data_uri = f"data:{mime};base64,{encoded}"
        cache[raw_url] = data_uri
        return data_uri

    def _replace_img(match: re.Match) -> str:
        prefix, url, suffix = match.group(1), match.group(2), match.group(3)
        data_uri = _resolve(url)
        if data_uri is None:
            return match.group(0)
        return f"{prefix}{data_uri}{suffix}"

    def _replace_bg(match: re.Match) -> str:
        prefix, url, suffix = match.group(1), match.group(2), match.group(3)
        data_uri = _resolve(url)
        if data_uri is None:
            return match.group(0)
        return f"{prefix}{data_uri}{suffix}"

    html = _OSS_IMG_SRC_RE.sub(_replace_img, html)
    html = _OSS_BG_URL_RE.sub(_replace_bg, html)
    return html


def _build_background_css(bg: dict[str, Any] | None) -> str:
    """构造 .ppt-slide 的 background CSS。

    兼容两种字段命名（同 `field_mapping.normalize_background_for_api`）：
      - 前端/API 出参格式：`{"type":"solid","color":"#XXXXXX"}`
      - DB 内部存储格式：`{"type":"solid","value":"#XXXXXX"}`
      - PPTX 导入产生的 `"theme"` 类型也按 theme.color 兼容
    """
    if not bg:
        return "background-color: #ffffff;"

    bg_type = bg.get("type", "solid")

    # solid / color / theme 都解析为单色填充
    if bg_type in ("solid", "color", "theme"):
        color_value = (
            bg.get("color")
            or (bg.get("theme", {}) or {}).get("color")
            or (bg.get("value") if isinstance(bg.get("value"), str) else None)
            or "#ffffff"
        )
        color = _safe_css_color(str(color_value), '#ffffff')
        return f"background-color: {color};"

    if bg_type == "gradient":
        gradient = bg.get("gradient", {})
        colors = gradient.get("colors", [])
        if colors:
            stops = ", ".join(
                f"{_safe_css_color(str(c.get('color', '#fff')), '#fff')} "
                f"{_safe_float(c.get('pos', c.get('position', 0))) * 100}%"
                for c in colors
            )
            angle = _safe_float(gradient.get("rotate", 0))
            return f"background: linear-gradient({angle}deg, {stops});"
        return "background-color: #ffffff;"

    if bg_type == "image":
        # image 字段历史上有 dict 和 string 两种形态：
        #   - {"image": {"src": "...", "size": "cover"}}（新）
        #   - {"image": "https://..."} 或 {"src": "..."}（老）
        image_field = bg.get("image")
        src = ""
        size = "cover"
        if isinstance(image_field, dict):
            src = image_field.get("src", "")
            size_raw = image_field.get("size") or bg.get("imageSize") or "cover"
            size = size_raw if size_raw in _BG_IMAGE_SIZE_WHITELIST else "cover"
        elif isinstance(image_field, str):
            src = image_field
            size_raw = bg.get("imageSize") or "cover"
            size = size_raw if size_raw in _BG_IMAGE_SIZE_WHITELIST else "cover"
        else:
            src = bg.get("src", "")
            size_raw = bg.get("imageSize") or "cover"
            size = size_raw if size_raw in _BG_IMAGE_SIZE_WHITELIST else "cover"
        if src:
            safe_src = str(src).replace("'", "%27").replace("\\", "%5C")
            return f"background-image: url('{safe_src}'); background-size: {size}; background-position: center;"

    return "background-color: #ffffff;"


def _build_data_ts(el: dict[str, Any]) -> str:
    """Build data-ts-* attribute string for roundtrip metadata preservation."""
    parts: list[str] = []
    _TS_KEYS = {
        "colorMask": "data-ts-color-mask",
        "clip": "data-ts-clip",
        "pattern": "data-ts-pattern",
        "points": "data-ts-points",
        "broken": "data-ts-line-type",
        "curve": "data-ts-line-type",
        "cubic": "data-ts-line-type",
        "control": "data-ts-line-control",
    }
    for key in ("colorMask", "clip", "pattern"):
        val = el.get(key)
        if val:
            attr = _TS_KEYS[key]
            parts.append(f'{attr}="{_html_attr(json.dumps(val))}"')

    for lt in ("broken", "curve", "cubic"):
        ctrl = el.get(lt)
        if ctrl:
            parts.append(f'data-ts-line-type="{lt}"')
            if isinstance(ctrl, list):
                parts.append(f'data-ts-line-control="{_html_attr(json.dumps(ctrl))}"')
            break

    points = el.get("points")
    if points and isinstance(points, list) and any(p for p in points):
        parts.append(f'data-ts-points="{_html_attr(json.dumps(points))}"')

    return " ".join(parts)


def _html_attr(value: str) -> str:
    """Escape a string for safe inclusion in an HTML attribute (double- or single-quoted)."""
    return (
        value.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


_RE_HEX_COLOR = re.compile(r'^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$')
_RE_CSS_FUNC_COLOR = re.compile(r'^(?:rgb|rgba|hsl|hsla)\(\s*[-\d.%,\s/]+\s*\)$')

_CSS_NAMED_COLORS = frozenset({
    'transparent', 'currentcolor',
    'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure',
    'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown',
    'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue',
    'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod',
    'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
    'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon',
    'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey',
    'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray',
    'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
    'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray',
    'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred',
    'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen',
    'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
    'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey',
    'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue',
    'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow',
    'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
    'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen',
    'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
    'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin',
    'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
    'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise',
    'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum',
    'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue',
    'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna',
    'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow',
    'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato',
    'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
    'yellowgreen',
})

_OBJECT_FIT_VALUES = frozenset({'contain', 'cover', 'fill', 'none', 'scale-down'})
_OUTLINE_STYLE_VALUES = frozenset({'solid', 'dashed', 'dotted', 'double', 'none'})
_BG_IMAGE_SIZE_WHITELIST = frozenset({'cover', 'contain', 'auto', '100% 100%'})
_TEXT_ALIGN_VALUES = frozenset({'left', 'center', 'right', 'justify', 'start', 'end'})
_VERTICAL_ALIGN_VALUES = frozenset({'top', 'middle', 'bottom', 'baseline'})
_CSS_FILTER_FUNCTIONS = frozenset({
    'blur', 'brightness', 'contrast', 'grayscale', 'hueRotate',
    'invert', 'opacity', 'saturate', 'sepia', 'drop-shadow',
})


def _sanitize_content_html(html: str) -> str:
    """Strip dangerous tags/attrs from rich-text HTML content before rendering.

    Preserves formatting tags (<span>, <b>, <i>, <br>, <p>, <div>, <em>,
    <strong>, <u>, <s>, <sub>, <sup>, <ul>, <ol>, <li>) while removing
    script injection vectors.
    """
    if html is None:
        return ""
    if not html:
        return html
    html = re.sub(r'<script\b[^>]*>[\s\S]*?</script>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<(iframe|object|embed|form|input|textarea|select|button|meta|base|link|applet)\b[^>]*>[\s\S]*?</\1>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<(iframe|object|embed|form|input|textarea|select|button|meta|base|link|applet)\b[^>]*/?\s*>', '', html, flags=re.IGNORECASE)
    html = re.sub(r'\bon\w+\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>]+)', '', html, flags=re.IGNORECASE)
    _DANGEROUS_PROTO = r'(?:javascript|vbscript|data\s*)'
    html = re.sub(r'(?:href|src|action|formaction|xlink:href)\s*=\s*"' + _DANGEROUS_PROTO + r':[^"]*"', 'href="#"', html, flags=re.IGNORECASE)
    html = re.sub(r"(?:href|src|action|formaction|xlink:href)\s*=\s*'" + _DANGEROUS_PROTO + r":[^']*'", "href='#'", html, flags=re.IGNORECASE)
    html = re.sub(r'(?:href|src|action|formaction|xlink:href)\s*=\s*' + _DANGEROUS_PROTO + r':[^\s>]+', 'href="#"', html, flags=re.IGNORECASE)
    return html


def _safe_font_name(name: str) -> str:
    """Strip characters that could break out of a CSS font-family string."""
    if not isinstance(name, str):
        return ""
    return re.sub(r"['\";{}()\\/<>]", "", name).strip()


_RE_SAFE_SVG_PATH = re.compile(r'[^MmZzLlHhVvCcSsQqTtAa0-9eE.,\s+\-]')


def _safe_svg_path(d: str) -> str:
    """Sanitize an SVG path `d` attribute to prevent attribute injection."""
    if not isinstance(d, str):
        return ""
    return _RE_SAFE_SVG_PATH.sub('', d)


def _safe_css_color(value: str, fallback: str = 'transparent') -> str:
    """Validate a CSS color value against a whitelist of safe formats."""
    if not isinstance(value, str):
        return fallback
    v = value.strip()
    if not v:
        return fallback
    if v.lower() in _CSS_NAMED_COLORS:
        return v
    if _RE_HEX_COLOR.match(v):
        return v
    if _RE_CSS_FUNC_COLOR.match(v):
        return v
    return fallback


def _safe_float(value: Any, fallback: float = 0.0) -> float:
    """Convert to float, returning *fallback* on any failure or non-finite result."""
    import math
    try:
        f = float(value)
        return f if math.isfinite(f) else fallback
    except (TypeError, ValueError):
        return fallback


def _json_data_attr(key: str, value: Any) -> str:
    """Build a data-ts-* attribute with JSON-encoded value, safe for HTML."""
    import json as _json
    json_str = _json.dumps(value, ensure_ascii=False)
    return f'data-ts-{key}="{_html_attr(json_str)}"'


_RE_SCRIPT_TAG = re.compile(r'<script[^>]*>.*?</script>', re.DOTALL | re.IGNORECASE)
_RE_SCRIPT_SELF_CLOSE = re.compile(r'<script[^>]*/\s*>', re.IGNORECASE)
_RE_EVENT_ATTR_QUOTED = re.compile(r'\s+on\w+\s*=\s*["\'][^"\']*["\']', re.IGNORECASE)
_RE_EVENT_ATTR_UNQUOTED = re.compile(r'\s+on\w+\s*=\s*[^\s>]+', re.IGNORECASE)
_RE_JS_URI_HREF = re.compile(r'((?:xlink:)?href\s*=\s*["\'])\s*javascript:', re.IGNORECASE)
_RE_DATA_URI_HREF = re.compile(r'((?:xlink:)?href\s*=\s*["\'])\s*data:', re.IGNORECASE)
_RE_FOREIGN_OBJECT = re.compile(r'<foreignObject[^>]*>.*?</foreignObject>', re.DOTALL | re.IGNORECASE)


def _sanitize_svg(svg_str: str) -> str:
    """Strip dangerous elements/attributes from user-supplied SVG content."""
    if not isinstance(svg_str, str):
        return ""
    s = svg_str.replace('\x00', '')
    s = _RE_SCRIPT_TAG.sub('', s)
    s = _RE_SCRIPT_SELF_CLOSE.sub('', s)
    s = _RE_FOREIGN_OBJECT.sub('', s)
    s = _RE_EVENT_ATTR_QUOTED.sub('', s)
    s = _RE_EVENT_ATTR_UNQUOTED.sub('', s)
    s = _RE_JS_URI_HREF.sub(r'\1#', s)
    s = _RE_DATA_URI_HREF.sub(r'\1#', s)
    return s


def _build_theme_data_attrs(el: dict[str, Any]) -> str:
    """Output theme key / theme transform data attributes for roundtrip preservation."""
    import json as _json
    parts: list[str] = []

    for key in ("defaultColorThemeKey", "fillThemeKey", "colorThemeKey"):
        val = el.get(key)
        if val:
            parts.append(f'data-ts-{key}="{_html_attr(str(val))}"')

    fill_transforms = el.get("fillThemeTransforms")
    if fill_transforms and isinstance(fill_transforms, dict):
        parts.append(_json_data_attr("fillThemeTransforms", fill_transforms))

    theme_color_keys = el.get("themeColorKeys")
    if theme_color_keys and isinstance(theme_color_keys, list):
        parts.append(_json_data_attr("themeColorKeys", theme_color_keys))

    point_sizes = el.get("pointSizes")
    if point_sizes and isinstance(point_sizes, list):
        parts.append(_json_data_attr("pointSizes", point_sizes))

    broken2 = el.get("broken2")
    if broken2 and isinstance(broken2, list):
        parts.append(_json_data_attr("broken2", broken2))

    line_shadow = el.get("shadow") if el.get("type") == "line" else None
    if line_shadow and isinstance(line_shadow, dict):
        parts.append(_json_data_attr("lineShadow", line_shadow))

    auto_fit = el.get("autoFit")
    if auto_fit:
        parts.append(f'data-ts-autoFit="{_html_attr(str(auto_fit))}"')

    if el.get("type") == "chart":
        chart_fill = el.get("fill")
        if chart_fill:
            parts.append(f'data-ts-chartFill="{_html_attr(str(chart_fill))}"')
        chart_outline = el.get("outline")
        if chart_outline and isinstance(chart_outline, dict):
            parts.append(_json_data_attr("chartOutline", chart_outline))

    if el.get("type") == "table":
        cell_min = el.get("cellMinHeight")
        if cell_min:
            parts.append(f'data-ts-cellMinHeight="{cell_min}"')
        table_outline = el.get("outline")
        if table_outline and isinstance(table_outline, dict):
            parts.append(_json_data_attr("tableOutline", table_outline))
        table_theme = el.get("theme")
        if table_theme and isinstance(table_theme, dict):
            parts.append(_json_data_attr("tableTheme", table_theme))
        table_borders = el.get("borders")
        if table_borders and isinstance(table_borders, dict):
            parts.append(_json_data_attr("tableBorders", table_borders))

    return (" " + " ".join(parts)) if parts else ""


def _render_element(el: dict[str, Any], cw: int, ch: int) -> str:
    el_type = el.get("type", "")
    x = _safe_float(el.get("left", el.get("x", 0)), 0)
    y = _safe_float(el.get("top", el.get("y", 0)), 0)
    w = _safe_float(el.get("width", 100), 100)
    h = _safe_float(el.get("height", 100), 100)
    rotate = _safe_float(el.get("rotate", 0), 0)
    opacity = _safe_float(el.get("opacity", 1), 1)
    flip_h = el.get("flipH", False)
    flip_v = el.get("flipV", False)

    transform_parts: list[str] = []
    if rotate:
        transform_parts.append(f"rotate({rotate}deg)")
    if flip_h:
        transform_parts.append("scaleX(-1)")
    if flip_v:
        transform_parts.append("scaleY(-1)")
    transform = " ".join(transform_parts)

    if el.get("visible") is False:
        style = (
            f"left: {x}px; top: {y}px; width: {w}px; height: {h}px; "
            f"opacity: {opacity}; display: none; "
        )
    else:
        style = (
            f"left: {x}px; top: {y}px; width: {w}px; height: {h}px; "
            f"opacity: {opacity}; "
        )
    if transform:
        style += f"transform: {transform}; "

    data_attrs = f'data-element-id="{_html_attr(str(el.get("id", "")))}" data-element-type="{_html_attr(el_type)}"'
    group_id = el.get("groupId")
    if group_id:
        data_attrs += f' data-group-id="{_html_attr(str(group_id))}"'
    group_name = el.get("groupName")
    if group_name:
        data_attrs += f' data-group-name="{_html_attr(str(group_name))}"'
    if el.get("locked"):
        data_attrs += ' data-locked="true"'
    el_name = el.get("name")
    if el_name:
        data_attrs += f' data-element-name="{_html_attr(str(el_name))}"'
    link = el.get("link")
    if link and isinstance(link, dict) and link.get("target"):
        data_attrs += f' data-link-type="{_html_attr(str(link.get("type", "web")))}" data-link-target="{_html_attr(str(link["target"]))}"'

    data_attrs += _build_theme_data_attrs(el)

    if el_type == "text":
        return _render_text_element(el, style, data_attrs)
    elif el_type == "image":
        return _render_image_element(el, style, data_attrs)
    elif el_type == "shape":
        return _render_shape_element(el, style, data_attrs)
    elif el_type == "table":
        return _render_table_element(el, style, data_attrs)
    elif el_type == "chart":
        return _render_chart_element(el, style, data_attrs)
    elif el_type == "line":
        return _render_line_element(el, style, data_attrs)
    elif el_type == "latex":
        return _render_latex_element(el, style, data_attrs)
    elif el_type == "video":
        return _render_video_element(el, style, data_attrs)
    elif el_type == "audio":
        return _render_audio_element(el, style, data_attrs)
    else:
        return f'<div class="element" style="{style}" {data_attrs}></div>'


def _render_text_element(el: dict, style: str, data_attrs: str) -> str:
    content = _sanitize_content_html(el.get("content", ""))
    font_size = el.get("defaultFontSize", 16)
    font_name = el.get("defaultFontName", "")
    color = el.get("defaultColor", "#333")
    v_align = el.get("verticalAlign", "top")

    safe_color = _safe_css_color(str(color), "#333")
    safe_font_size = _safe_float(font_size, 16)
    inner_style = f"font-size: {safe_font_size}px; color: {safe_color}; "
    if font_name:
        inner_style += f"font-family: '{_safe_font_name(str(font_name))}', sans-serif; "
    if v_align == "middle":
        inner_style += "display: flex; align-items: center; height: 100%; "
    elif v_align == "bottom":
        inner_style += "display: flex; align-items: flex-end; height: 100%; "

    lh = el.get("lineHeight")
    if lh:
        inner_style += f"line-height: {_safe_float(lh, 1.5)}; "

    ws = el.get("wordSpace")
    if ws:
        inner_style += f"letter-spacing: {_safe_float(ws, 0)}px; "

    if el.get("vertical"):
        inner_style += "writing-mode: vertical-rl; "

    fill = el.get("fill")
    if fill:
        style += f"background-color: {_safe_css_color(str(fill), 'transparent')}; "

    outline = el.get("outline")
    if outline and outline.get("width"):
        ol_w = _safe_float(outline['width'], 1)
        ol_s = outline.get('style', 'solid')
        ol_s = ol_s if ol_s in _OUTLINE_STYLE_VALUES else 'solid'
        ol_c = _safe_css_color(str(outline.get('color', '#333')), '#333')
        style += f"border: {ol_w}px {ol_s} {ol_c}; "

    shadow = el.get("shadow")
    if shadow:
        sh = _safe_float(shadow.get("h", 2), 2)
        sv = _safe_float(shadow.get("v", 2), 2)
        sb = _safe_float(shadow.get("blur", 4), 4)
        sc = _safe_css_color(str(shadow.get("color", "rgba(0,0,0,0.2)")), "rgba(0,0,0,0.2)")
        style += f"box-shadow: {sh}px {sv}px {sb}px {sc}; "

    margin = el.get("margin")
    if margin:
        mt, mr, mb, ml = margin.get("top", 0), margin.get("right", 0), margin.get("bottom", 0), margin.get("left", 0)
        style += f"padding: {mt}px {mr}px {mb}px {ml}px; "
    else:
        style += "padding: 10px; "

    ps = el.get("paragraphSpace")
    ps_style = ""
    if ps:
        ps_style = f" --ts-para-space: {_safe_float(ps, 0)}px;"

    return f'<div class="element" style="{style}{ps_style}" {data_attrs}><div style="{inner_style}">{content}</div></div>'


def _render_image_element(el: dict, style: str, data_attrs: str) -> str:
    src = el.get("src", "")
    if not src:
        return f'<div class="element" style="{style} background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: ;" {data_attrs}>Image</div>'

    raw_fit = el.get("objectFit", "cover")
    obj_fit = raw_fit if raw_fit in _OBJECT_FIT_VALUES else "cover"
    radius = el.get("radius", 0)
    img_style = f"width: 100%; height: 100%; object-fit: {obj_fit};"
    if radius:
        style += f"border-radius: {radius}px; overflow: hidden; "

    outline = el.get("outline")
    if outline and outline.get("width"):
        ol_w = _safe_float(outline['width'], 1)
        ol_s = outline.get('style', 'solid')
        ol_s = ol_s if ol_s in _OUTLINE_STYLE_VALUES else 'solid'
        ol_c = _safe_css_color(str(outline.get('color', '#333')), '#333')
        style += f"border: {ol_w}px {ol_s} {ol_c}; "

    shadow = el.get("shadow")
    if shadow:
        sh = _safe_float(shadow.get("h", 2), 2)
        sv = _safe_float(shadow.get("v", 2), 2)
        sb = _safe_float(shadow.get("blur", 4), 4)
        sc = _safe_css_color(str(shadow.get("color", "rgba(0,0,0,0.2)")), "rgba(0,0,0,0.2)")
        style += f"box-shadow: {sh}px {sv}px {sb}px {sc}; "

    filters = el.get("filters")
    if filters:
        parts = []
        for k, v in filters.items():
            if k not in _CSS_FILTER_FUNCTIONS:
                continue
            fv = _safe_float(v, 0)
            if k == "hueRotate":
                parts.append(f"hue-rotate({fv}deg)")
            elif k == "blur":
                parts.append(f"blur({fv}px)")
            else:
                parts.append(f"{k}({fv})")
        if parts:
            img_style += f" filter: {' '.join(parts)};"

    alt = el.get("altText", "")
    ts = _build_data_ts(el)
    ts_attr = f" {ts}" if ts else ""

    color_mask = el.get("colorMask")
    mask_html = ""
    if color_mask:
        safe_mask = _safe_css_color(str(color_mask))
        mask_html = (
            f'<div style="position:absolute;inset:0;background:{safe_mask};'
            f'pointer-events:none;border-radius:inherit;"></div>'
        )
    # 显式 absolute 定位：.element class 已经给了 absolute，但这里历史上把
    # outer div 写成 position:relative（为给 mask_html 的 inset:0 提供 positioning
    # context），这会反向覆盖 .element 的 absolute → image 走 normal flow，导致
    # 后续元素位置累加错位。`.element { position: absolute }` 本身就是 positioned
    # ancestor，mask_html 能正确锚定，无需再额外指定 relative。
    return (
        f'<div class="element" style="{style} position:absolute;" {data_attrs}>'
        f'<img src="{_html_attr(src)}" alt="{_html_attr(alt)}" style="{img_style}" crossorigin="anonymous"{ts_attr} />'
        f'{mask_html}</div>'
    )


def _render_shape_element(el: dict, style: str, data_attrs: str) -> str:
    # Phase-3 Wave-2 修复：没有 fill 也没有 gradient 时，shape 必须渲染为透明
    # 而非默认灰色 #e0e0e0，否则像 `.sh-inset-hi`（inset shadow 装饰层）这类
    # 无填充的装饰 shape 会盖住下面色块，把整页变灰。
    raw_fill = el.get("fill")
    has_explicit_fill = raw_fill is not None and not (isinstance(raw_fill, str) and not raw_fill.strip())
    if isinstance(raw_fill, dict):
        raw_fill = raw_fill.get("color")
        has_explicit_fill = bool(raw_fill)
    fill_color = _safe_css_color(str(raw_fill), "#e0e0e0") if has_explicit_fill else "none"

    gradient = el.get("gradient")
    gradient_css = ""
    if gradient and isinstance(gradient, dict):
        colors = gradient.get("colors", [])
        if colors:
            angle = _safe_float(gradient.get("rotate", 0))
            stops = ", ".join(
                f"{_safe_css_color(str(c.get('color', '#fff')), '#fff')} {_safe_float(c.get('pos', 0)) * 100}%"
                for c in colors
            )
            gradient_css = f"linear-gradient({angle}deg, {stops})"

    outline = el.get("outline")
    outline_color = _safe_css_color(str(outline.get("color", "#333")), "#333") if outline and outline.get("width") else ""
    outline_width = _safe_float(outline["width"], 1) if outline and outline.get("width") else 0

    shadow = el.get("shadow")
    if shadow:
        sh = _safe_float(shadow.get("h", 2), 2)
        sv = _safe_float(shadow.get("v", 2), 2)
        sb = _safe_float(shadow.get("blur", 4), 4)
        sc = _safe_css_color(str(shadow.get("color", "rgba(0,0,0,0.2)")), "rgba(0,0,0,0.2)")
        style += f"box-shadow: {sh}px {sv}px {sb}px {sc}; "

    path = el.get("path")
    view_box = el.get("viewBox")
    pf = el.get("pathFormula") or el.get("pptxShapeType") or el.get("shapeType", "")

    text = el.get("text", {})
    content = text.get("content", "") if isinstance(text, dict) else ""
    text_html = ""
    if content:
        txt_size = _safe_float(text.get("defaultFontSize", 14) if isinstance(text, dict) else 14, 14)
        txt_color = _safe_css_color(str(text.get("defaultColor", "#333") if isinstance(text, dict) else "#333"), "#333")
        txt_font = text.get("defaultFontName", "") if isinstance(text, dict) else ""
        txt_font_css = f"font-family: '{_safe_font_name(str(txt_font))}', sans-serif; " if txt_font else ""
        safe_content = _sanitize_content_html(str(content) if content else "")
        text_html = (
            f'<div style="position:absolute;inset:0;display:flex;align-items:center;'
            f'justify-content:center;padding:8px;text-align:center;'
            f'font-size:{txt_size}pt;color:{txt_color};{txt_font_css}'
            f'overflow:hidden;word-break:break-word;pointer-events:none;">{safe_content}</div>'
        )

    ts = _build_data_ts(el)
    ts_attr = f" {ts}" if ts else ""

    use_svg = bool(path and view_box and isinstance(view_box, list) and len(view_box) >= 2)
    if use_svg and pf not in ("ellipse", "circle"):
        vb_w, vb_h = _safe_float(view_box[0], 100), _safe_float(view_box[1], 100)
        svg_fill = fill_color
        if gradient_css:
            svg_fill = "url(#shapeGrad)"
        stroke_attr = ""
        if outline_width:
            _raw_ol_cap = outline.get("lineCap", "") if outline else ""
            _ol_cap = _raw_ol_cap if _raw_ol_cap in _LINE_CAP_VALUES else ""
            _raw_ol_join = outline.get("lineJoin", "") if outline else ""
            _ol_join = _raw_ol_join if _raw_ol_join in _LINE_JOIN_VALUES else ""
            stroke_attr = f' stroke="{outline_color}" stroke-width="{outline_width}"'
            _ol_style = outline.get("style", "solid") if outline else "solid"
            if _ol_style in ("dashed", "longDash"):
                stroke_attr += f' stroke-dasharray="{max(outline_width * 3, 8)} {max(outline_width * 2, 4)}"'
            elif _ol_style == "dotted":
                stroke_attr += f' stroke-dasharray="{outline_width} {outline_width * 2}"'
                if not _ol_cap:
                    _ol_cap = "round"
            elif _ol_style == "dashDot":
                stroke_attr += f' stroke-dasharray="{max(outline_width * 3, 8)} {max(outline_width, 3)} {outline_width} {max(outline_width, 3)}"'
                if not _ol_cap:
                    _ol_cap = "round"
            elif _ol_style == "longDashDot":
                stroke_attr += f' stroke-dasharray="{max(outline_width * 5, 16)} {max(outline_width, 3)} {outline_width} {max(outline_width, 3)}"'
                if not _ol_cap:
                    _ol_cap = "round"
            if _ol_cap:
                stroke_attr += f' stroke-linecap="{_ol_cap}"'
            if _ol_join:
                stroke_attr += f' stroke-linejoin="{_ol_join}"'
        grad_def = ""
        if gradient_css and gradient and isinstance(gradient, dict):
            colors = gradient.get("colors", [])
            grad_stops = "".join(
                f'<stop offset="{_safe_float(c.get("pos", 0)) * 100}%" stop-color="{_safe_css_color(str(c.get("color", "#fff")), "#fff")}"/>'
                for c in colors
            )
            grad_def = f'<defs><linearGradient id="shapeGrad">{grad_stops}</linearGradient></defs>'

        safe_path = _safe_svg_path(str(path))
        return (
            f'<div class="element" style="{style}" {data_attrs}{ts_attr}>'
            f'<svg viewBox="0 0 {vb_w} {vb_h}" style="width:100%;height:100%;display:block;" preserveAspectRatio="none">'
            f'{grad_def}<path d="{safe_path}" fill="{svg_fill}"{stroke_attr}/></svg>'
            f'{text_html}</div>'
        )

    if gradient_css:
        style += f"background: {gradient_css}; "
    elif has_explicit_fill:
        style += f"background-color: {fill_color}; "
    if outline_width:
        _bs_map = {"dashed": "dashed", "dotted": "dotted", "dashDot": "dashed",
                    "longDash": "dashed", "longDashDot": "dashed"}
        _bs = _bs_map.get(outline.get("style", "solid"), "solid") if outline else "solid"
        style += f"border: {outline_width}px {_bs} {outline_color}; "

    radius = el.get("radius", 0)
    if radius:
        style += f"border-radius: {radius}px; "
    if pf in ("roundRect", "round-rect"):
        kp = el.get("keypoints")
        if kp and isinstance(kp, list) and kp[0]:
            w = el.get("width", 100)
            h = el.get("height", 100)
            r = round(kp[0] * min(w, h))
            style += f"border-radius: {r}px; "
        elif not radius:
            style += "border-radius: 8px; "
    elif pf in ("ellipse", "circle"):
        style += "border-radius: 50%; "

    inner = text_html if text_html else ""
    return f'<div class="element" style="{style}" {data_attrs}{ts_attr}>{inner}</div>'


def _render_table_element(el: dict, style: str, data_attrs: str) -> str:
    data = el.get("data", [])
    if not data:
        return f'<div class="element" style="{style} background: #f5f5f5;" {data_attrs}>Table</div>'

    theme = el.get("theme", {})
    raw_header_bg = theme.get("color", "#4472C4") if isinstance(theme, dict) else "#4472C4"
    header_bg = _safe_css_color(str(raw_header_bg), "#4472C4")

    rows_html = []
    for i, row in enumerate(data):
        cells = []
        for cell in row:
            if isinstance(cell, dict):
                raw_content = cell.get("richText") or cell.get("text", "")
            else:
                raw_content = str(cell)
            display_content = _sanitize_content_html(str(raw_content)) if raw_content else ""
            cell_style = ""
            border_css = "border: 1px solid #ddd; "
            span_attrs = ""
            if isinstance(cell, dict):
                try:
                    colspan = int(cell.get("colspan", 1))
                except (TypeError, ValueError):
                    colspan = 1
                try:
                    rowspan = int(cell.get("rowspan", 1))
                except (TypeError, ValueError):
                    rowspan = 1
                if colspan > 1:
                    span_attrs += f' colspan="{colspan}"'
                if rowspan > 1:
                    span_attrs += f' rowspan="{rowspan}"'
                cs = cell.get("style", {}) or {}
                if cs.get("bold"):
                    cell_style += "font-weight: bold; "
                if cs.get("italic"):
                    cell_style += "font-style: italic; "
                if cs.get("color"):
                    cell_style += f"color: {_safe_css_color(str(cs['color']), '#333')}; "
                if cs.get("bgColor") or cs.get("backcolor"):
                    cell_style += f"background-color: {_safe_css_color(str(cs.get('bgColor') or cs.get('backcolor')), 'transparent')}; "
                if cs.get("fontSize"):
                    cell_style += f"font-size: {_safe_float(cs['fontSize'], 14)}pt; "
                _cell_font = cs.get("fontName") or cs.get("fontFamily")
                if _cell_font:
                    cell_style += f"font-family: '{_safe_font_name(str(_cell_font))}', sans-serif; "
                if cs.get("underline"):
                    cell_style += "text-decoration: underline; "
                _cell_align = cs.get("align", "")
                if _cell_align and _cell_align in _TEXT_ALIGN_VALUES:
                    cell_style += f"text-align: {_cell_align}; "
                _cell_valign = cs.get("verticalAlign", "")
                if _cell_valign and _cell_valign in _VERTICAL_ALIGN_VALUES:
                    cell_style += f"vertical-align: {_cell_valign}; "
                cell_borders = cs.get("cellBorders") or cs.get("borders")
                if cell_borders:
                    border_parts = []
                    for side in ("top", "right", "bottom", "left"):
                        b = cell_borders.get(side)
                        if b:
                            b_w = _safe_float(b.get('width', 1), 1)
                            b_s = b.get('style', 'solid')
                            b_s = b_s if b_s in _OUTLINE_STYLE_VALUES else 'solid'
                            b_c = _safe_css_color(str(b.get('color', '#ddd')), '#ddd')
                            border_parts.append(f"border-{side}: {b_w}px {b_s} {b_c};")
                        else:
                            border_parts.append(f"border-{side}: none;")
                    border_css = " ".join(border_parts) + " "

            tag = "th" if i == 0 else "td"
            if i == 0:
                cell_style += f"background-color: {header_bg}; color: white; font-weight: bold; "
            cells.append(f'<{tag}{span_attrs} style="{border_css}padding: 6px 10px; {cell_style}">{display_content}</{tag}>')
        rows_html.append(f'<tr>{"".join(cells)}</tr>')

    col_widths = el.get("colWidths", [])
    colgroup = ""
    if col_widths and isinstance(col_widths, list):
        total = sum(col_widths) or 1
        cols = "".join(f'<col style="width:{round(c / total * 100, 2)}%"/>' for c in col_widths)
        colgroup = f"<colgroup>{cols}</colgroup>"

    row_heights = el.get("rowHeights", [])

    rows_with_heights = []
    for idx, row_html in enumerate(rows_html):
        if row_heights and idx < len(row_heights) and row_heights[idx]:
            rows_with_heights.append(row_html.replace("<tr>", f'<tr style="height:{row_heights[idx]}px;">'))
        else:
            rows_with_heights.append(row_html)

    return f'''<div class="element" style="{style} overflow: auto;" {data_attrs}>
<table style="width: 100%; border-collapse: collapse; font-size: 14px;">
{colgroup}{"".join(rows_with_heights)}
</table>
</div>'''


def _render_chart_element(el: dict, style: str, data_attrs: str) -> str:
    import json as _json

    chart_type = el.get("chartType", "bar")
    chart_data = el.get("data") or el.get("chartData")
    if not chart_data:
        return (
            f'<div class="element" style="{style} background: #fafafa; display: flex; '
            f'align-items: center; justify-content: center; border: 1px dashed #ccc; '
            f'color: ; font-size: 14px;" {data_attrs}>[Chart: {chart_type}]</div>'
        )

    chart_id = f"chart_{id(el)}"
    option = _build_echarts_option(chart_type, chart_data, el) if isinstance(chart_data, dict) else {}
    option_json = _json.dumps(option, ensure_ascii=False).replace("</", "<\\/")

    chart_meta_attrs = f' data-ts-chartType="{_html_attr(chart_type)}"'
    chart_meta_attrs += f' {_json_data_attr("chartData", chart_data)}'
    chart_title = el.get("chartTitle")
    if chart_title:
        chart_meta_attrs += f' data-ts-chartTitle="{_html_attr(str(chart_title))}"'
    theme_colors = el.get("themeColors")
    if theme_colors:
        chart_meta_attrs += f' {_json_data_attr("themeColors", theme_colors)}'
    chart_options = el.get("options")
    if chart_options:
        chart_meta_attrs += f' {_json_data_attr("chartOptions", chart_options)}'
    text_color = el.get("textColor")
    if text_color:
        chart_meta_attrs += f' data-ts-textColor="{_html_attr(str(text_color))}"'
    grid_color = el.get("gridColor")
    if grid_color:
        chart_meta_attrs += f' data-ts-gridColor="{_html_attr(str(grid_color))}"'

    return (
        f'<div class="element" style="{style}" {data_attrs}{chart_meta_attrs}>'
        f'<div id="{chart_id}" style="width:100%; height:100%;"></div>'
        f'<script>'
        f'(function(){{ var c = echarts.init(document.getElementById("{chart_id}")); '
        f'c.setOption({option_json}); }})()'
        f'</script></div>'
    )


def _build_echarts_option(chart_type: str, data: dict, el: dict | None = None) -> dict:
    """Convert PPTChartElement data to an ECharts option with styling."""
    el = el or {}
    labels = data.get("labels", [])
    datasets = data.get("series") or data.get("datasets") or []
    opts = el.get("options") or {}

    series = []
    for ds in datasets:
        s: dict = {"type": chart_type, "data": ds.get("data", [])}
        name = ds.get("name") or ds.get("label")
        if name:
            s["name"] = name
        if opts.get("lineSmooth") and chart_type == "line":
            s["smooth"] = True
        if opts.get("stack"):
            s["stack"] = "total"
        series.append(s)

    option: dict = {"animation": False, "series": series}

    theme_colors = el.get("themeColors")
    if theme_colors and isinstance(theme_colors, list):
        option["color"] = theme_colors

    chart_title = el.get("chartTitle")
    if chart_title:
        option["title"] = {"text": chart_title, "left": "center", "top": 8}

    text_color = el.get("textColor")
    if text_color:
        option["textStyle"] = {"color": text_color}

    if labels:
        option["xAxis"] = {"type": "category", "data": labels}
        option["yAxis"] = {"type": "value"}
    if chart_type == "pie":
        option.pop("xAxis", None)
        option.pop("yAxis", None)

    if opts.get("showLegend") is not False and len(series) > 1:
        option["legend"] = {"bottom": 0}

    grid_color = el.get("gridColor")
    if grid_color:
        if "xAxis" in option:
            option["xAxis"]["axisLine"] = {"lineStyle": {"color": grid_color}}
        if "yAxis" in option:
            option["yAxis"]["splitLine"] = {"lineStyle": {"color": grid_color}}

    return option


_LINE_CAP_VALUES = frozenset({'butt', 'round', 'square'})
_LINE_JOIN_VALUES = frozenset({'miter', 'round', 'bevel'})


def _render_line_element(el: dict, style: str, data_attrs: str) -> str:
    color = _safe_css_color(str(el.get("color", "#333")), "#333")
    line_w = _safe_float(el.get("lineWidth", el.get("borderWidth", 2)), 2)
    line_style_name = el.get("style", "solid")
    start = el.get("start", [0, 0])
    end = el.get("end")
    w = _safe_float(el.get("width", 100), 100)
    h = _safe_float(el.get("height", 0), 0)

    if not end:
        end = [w, 0] if h == 0 else [0, h]

    ts = _build_data_ts(el)
    ts_attr = f" {ts}" if ts else ""

    raw_cap = el.get("lineCap", "")
    raw_join = el.get("lineJoin", "")
    line_cap = raw_cap if raw_cap in _LINE_CAP_VALUES else ""
    line_join = raw_join if raw_join in _LINE_JOIN_VALUES else ""

    dash = ""
    if line_style_name in ("dashed", "longDash"):
        dash = f' stroke-dasharray="{max(line_w * 3, 8)} {max(line_w * 2, 4)}"'
    elif line_style_name == "dotted":
        dash = f' stroke-dasharray="{line_w} {line_w * 2}"'
        if not line_cap:
            line_cap = "round"
    elif line_style_name == "dashDot":
        dash = f' stroke-dasharray="{max(line_w * 3, 8)} {max(line_w, 3)} {line_w} {max(line_w, 3)}"'
        if not line_cap:
            line_cap = "round"
    elif line_style_name == "longDashDot":
        dash = f' stroke-dasharray="{max(line_w * 5, 16)} {max(line_w, 3)} {line_w} {max(line_w, 3)}"'
        if not line_cap:
            line_cap = "round"

    cap_attr = f' stroke-linecap="{line_cap}"' if line_cap else ""
    join_attr = f' stroke-linejoin="{line_join}"' if line_join else ""

    vb_w = max(w, 1)
    vb_h = max(h, line_w * 2)
    sx1 = _safe_float(start[0] if isinstance(start, list) else 0)
    sy1 = _safe_float(start[1] if isinstance(start, list) and len(start) > 1 else 0)
    sx2 = _safe_float(end[0] if isinstance(end, list) else w)
    sy2 = _safe_float(end[1] if isinstance(end, list) and len(end) > 1 else 0)

    broken = el.get("broken")
    broken2 = el.get("broken2")
    curve = el.get("curve")
    cubic = el.get("cubic")

    stroke_common = f'stroke="{color}" stroke-width="{line_w}"{dash}{cap_attr}{join_attr}'

    if broken and broken2 and isinstance(broken, list) and isinstance(broken2, list):
        mx1, my1 = _safe_float(broken[0]), _safe_float(broken[1])
        mx2, my2 = _safe_float(broken2[0]), _safe_float(broken2[1])
        path_d = f"M {sx1} {sy1} L {mx1} {my1} L {mx2} {my2} L {sx2} {sy2}"
        line_svg = f'<path d="{path_d}" fill="none" {stroke_common}/>'
    elif broken and isinstance(broken, list) and len(broken) >= 2:
        mx, my = _safe_float(broken[0]), _safe_float(broken[1])
        path_d = f"M {sx1} {sy1} L {mx} {my} L {sx2} {sy2}"
        line_svg = f'<path d="{path_d}" fill="none" {stroke_common}/>'
    elif curve and isinstance(curve, list) and len(curve) >= 2:
        cx, cy = _safe_float(curve[0]), _safe_float(curve[1])
        path_d = f"M {sx1} {sy1} Q {cx} {cy} {sx2} {sy2}"
        line_svg = f'<path d="{path_d}" fill="none" {stroke_common}/>'
    elif cubic and isinstance(cubic, list) and len(cubic) >= 2:
        if isinstance(cubic[0], list):
            c1x, c1y = _safe_float(cubic[0][0]), _safe_float(cubic[0][1])
            c2x = _safe_float(cubic[1][0]) if len(cubic) > 1 else c1x
            c2y = _safe_float(cubic[1][1]) if len(cubic) > 1 else c1y
        else:
            c1x, c1y = _safe_float(cubic[0]), _safe_float(cubic[1])
            c2x, c2y = c1x, c1y
        path_d = f"M {sx1} {sy1} C {c1x} {c1y} {c2x} {c2y} {sx2} {sy2}"
        line_svg = f'<path d="{path_d}" fill="none" {stroke_common}/>'
    else:
        line_svg = f'<line x1="{sx1}" y1="{sy1}" x2="{sx2}" y2="{sy2}" {stroke_common}/>'

    points = el.get("points", ["", ""])
    point_sizes = el.get("pointSizes", [None, None])
    _ps_map = {"sm": 4, "med": 6, "lg": 8}

    def _marker_sz(ps_entry) -> int:
        if isinstance(ps_entry, dict):
            return max(_ps_map.get(ps_entry.get("w", "med"), 6),
                       _ps_map.get(ps_entry.get("len", "med"), 6))
        if isinstance(ps_entry, str):
            return _ps_map.get(ps_entry, 6)
        return 6

    def _marker_body(pt_type: str, sz: float, fill: str) -> str:
        hsz = sz / 2
        if pt_type == "dot":
            return f'<circle cx="{hsz}" cy="{hsz}" r="{hsz * 0.75}" fill="{fill}"/>'
        if pt_type == "diamond":
            return f'<polygon points="{sz} {hsz},{hsz} 0,0 {hsz},{hsz} {sz}" fill="{fill}"/>'
        return f'<polygon points="0,0 {sz},{hsz} 0,{sz}" fill="{fill}"/>'

    marker_defs = ""
    start_marker = ""
    end_marker = ""
    if points and isinstance(points, list):
        if len(points) > 0 and points[0]:
            sz = _marker_sz(point_sizes[0] if point_sizes and len(point_sizes) > 0 else None)
            hsz = sz / 2
            body = _marker_body(points[0], sz, color)
            marker_defs += f'<marker id="startM" markerWidth="{sz}" markerHeight="{sz}" refX="{hsz}" refY="{hsz}" orient="auto-start-reverse">{body}</marker>'
            start_marker = ' marker-start="url(#startM)"'
        if len(points) > 1 and points[1]:
            sz = _marker_sz(point_sizes[1] if point_sizes and len(point_sizes) > 1 else None)
            hsz = sz / 2
            body = _marker_body(points[1], sz, color)
            marker_defs += f'<marker id="endM" markerWidth="{sz}" markerHeight="{sz}" refX="{hsz}" refY="{hsz}" orient="auto">{body}</marker>'
            end_marker = ' marker-end="url(#endM)"'

    if start_marker or end_marker:
        line_svg = line_svg.replace("/>", f"{start_marker}{end_marker}/>")

    defs = f"<defs>{marker_defs}</defs>" if marker_defs else ""

    return (
        f'<div class="element" style="{style}" {data_attrs}{ts_attr}>'
        f'<svg viewBox="0 0 {vb_w} {vb_h}" style="width:100%;height:100%;overflow:visible;" preserveAspectRatio="none">'
        f'{defs}{line_svg}</svg></div>'
    )


def _render_latex_element(el: dict, style: str, data_attrs: str) -> str:
    import json as _json

    latex = el.get("latex", "")
    svg = el.get("svg", "")
    raw_color = el.get("color")
    color = _safe_css_color(str(raw_color), '') if raw_color else ''
    color_style = f"color:{color};" if color else ""

    latex_meta = ""
    if latex:
        escaped_json = _html_attr(_json.dumps(latex, ensure_ascii=False))
        latex_meta += f' data-ts-latex="{escaped_json}"'
    if raw_color:
        latex_meta += f' data-ts-latexColor="{_html_attr(str(raw_color))}"'

    if svg:
        safe_svg = _sanitize_svg(svg)
        return (
            f'<div class="element" style="{style} display:flex;align-items:center;'
            f'justify-content:center;padding:8px;{color_style}" {data_attrs}{latex_meta}>{safe_svg}</div>'
        )

    escaped = latex.replace("\\", "\\\\").replace("`", "\\`")
    return (
        f'<div class="element" style="{style} display:flex;align-items:center;'
        f'justify-content:center;padding:8px;{color_style}" {data_attrs}{latex_meta}>'
        f'<span class="latex-render">\\({escaped}\\)</span></div>'
    )


def _render_video_element(el: dict, style: str, data_attrs: str) -> str:
    src = el.get("src", "")
    poster = el.get("poster", "")
    autoplay = el.get("autoplay", False)
    poster_attr = f' poster="{_html_attr(poster)}"' if poster else ""
    autoplay_attr = " autoplay muted" if autoplay else ""
    loop_attr = " loop" if el.get("loop") else ""
    if not src:
        return (
            f'<div class="element" style="{style} background:;display:flex;'
            f'align-items:center;justify-content:center;color:#fff;font-size:14px;" {data_attrs}>'
            f'[Video]</div>'
        )
    return (
        f'<div class="element" style="{style}" {data_attrs}>'
        f'<video src="{_html_attr(src)}"{poster_attr}{autoplay_attr}{loop_attr} controls '
        f'style="width:100%;height:100%;object-fit:contain;"></video></div>'
    )


def _render_audio_element(el: dict, style: str, data_attrs: str) -> str:
    src = el.get("src", "")
    audio_color = el.get("color")
    color_attr = f' data-ts-audioColor="{_html_attr(str(audio_color))}"' if audio_color else ""
    if not src:
        return (
            f'<div class="element" style="{style} background:#f5f5f5;display:flex;'
            f'align-items:center;justify-content:center;color:;font-size:14px;" {data_attrs}{color_attr}>'
            f'[Audio]</div>'
        )
    loop_attr = " loop" if el.get("loop") else ""
    autoplay_attr = " autoplay muted" if el.get("autoplay") else ""
    return (
        f'<div class="element" style="{style} display:flex;align-items:center;'
        f'justify-content:center;" {data_attrs}{color_attr}>'
        f'<audio src="{_html_attr(src)}" controls{loop_attr}{autoplay_attr} style="width:90%;"></audio></div>'
    )


# ============================================================================
# Playwright Rendering
# ============================================================================


async def _render_page_screenshot(
    html: str,
    canvas_width: int = 1280,
    canvas_height: int = 720,
    scale_factor: int = DEFAULT_SCALE_FACTOR,
) -> bytes:
    """Render HTML to PNG bytes using Playwright."""
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        )
        try:
            page = await browser.new_page(
                viewport={"width": canvas_width, "height": canvas_height},
                device_scale_factor=scale_factor,
            )

            await load_render_document(page, html)
            await _wait_for_rendering(page, html)

            slide_el = await page.query_selector(".ppt-slide")
            if slide_el:
                png_bytes = await slide_el.screenshot(type="png")
            else:
                png_bytes = await page.screenshot(type="png")

            return png_bytes
        finally:
            await browser.close()


async def _wait_for_rendering(page: Any, html: str) -> None:
    """Wait for dynamic content (ECharts, MathJax) to finish rendering."""
    has_echarts = "echarts" in html
    has_mathjax = "MathJax" in html

    try:
        await asyncio.wait_for(
            page.evaluate("async () => { await document.fonts.ready; return true; }"),
            timeout=3,
        )
    except Exception:
        logger.warning("[TabSlidePreview] font_ready_timeout")

    try:
        await wait_for_image_decode(page)
    except Exception:
        logger.warning("[TabSlidePreview] image_decode_timeout")

    try:
        await wait_for_optional_render_ready(page)
    except Exception:
        logger.warning("[TabSlidePreview] optional_render_ready_timeout")

    if has_echarts:
        try:
            await page.wait_for_function(
                "() => typeof echarts !== 'undefined'",
                timeout=5000,
            )
        except Exception:
            pass
        await page.wait_for_timeout(500)

    if has_mathjax:
        await page.wait_for_timeout(300)

    if not has_echarts and not has_mathjax:
        await page.wait_for_timeout(300)


async def _run_visual_lint(
    html: str,
    canvas_width: int = 1280,
    canvas_height: int = 720,
) -> list[dict[str, Any]]:
    """Render HTML and inject visual lint checks (single page, own browser)."""
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        )
        try:
            page = await browser.new_page(
                viewport={"width": canvas_width, "height": canvas_height},
                device_scale_factor=1,
            )

            await load_render_document(page, html)
            await _wait_for_rendering(page, html)

            problems = await page.evaluate(_LINT_SCRIPT)
            return problems or []
        finally:
            await browser.close()


async def _run_visual_lint_batch(
    html_pages: list[str],
    canvas_width: int = 1280,
    canvas_height: int = 720,
) -> list[list[dict[str, Any]]]:
    """Lint multiple pages sharing a single browser instance."""
    from playwright.async_api import async_playwright

    results: list[list[dict[str, Any]]] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        )
        try:
            page = await browser.new_page(
                viewport={"width": canvas_width, "height": canvas_height},
                device_scale_factor=1,
            )
            for html in html_pages:
                await load_render_document(page, html)
                await _wait_for_rendering(page, html)
                problems = await page.evaluate(_LINT_SCRIPT)
                results.append(problems or [])
        finally:
            await browser.close()
    return results


_LINT_SCRIPT = """
() => {
  const problems = [];
  const slide = document.querySelector('.ppt-slide');
  if (!slide) return problems;

  const slideRect = slide.getBoundingClientRect();
  const slideW = slideRect.width;
  const slideH = slideRect.height;

  const elements = slide.querySelectorAll('.element');
  elements.forEach(el => {
    const id = el.dataset.elementId || '';
    const type = el.dataset.elementType || '';
    const rect = el.getBoundingClientRect();
    const relX = rect.left - slideRect.left;
    const relY = rect.top - slideRect.top;

    // Check: element out of bounds
    if (relX + rect.width < 0 || relY + rect.height < 0 || relX > slideW || relY > slideH) {
      problems.push({
        type: 'out_of_bounds',
        element_id: id,
        element_type: type,
        severity: 'error',
        message: `Element completely outside slide canvas`,
        bbox: { x: relX, y: relY, width: rect.width, height: rect.height }
      });
    } else if (relX < 0 || relY < 0 || relX + rect.width > slideW || relY + rect.height > slideH) {
      problems.push({
        type: 'partially_out_of_bounds',
        element_id: id,
        element_type: type,
        severity: 'warning',
        message: `Element partially outside slide canvas`,
        bbox: { x: relX, y: relY, width: rect.width, height: rect.height }
      });
    }

    // Check: text overflow
    if (type === 'text') {
      const inner = el.querySelector('div');
      if (inner && inner.scrollHeight > inner.clientHeight + 2) {
        problems.push({
          type: 'text_overflow',
          element_id: id,
          element_type: type,
          severity: 'warning',
          message: `Text content overflows container (scrollH=${inner.scrollHeight}, clientH=${inner.clientHeight})`,
          bbox: { x: relX, y: relY, width: rect.width, height: rect.height }
        });
      }
    }

    // Check: font too small
    const computedStyle = window.getComputedStyle(el);
    const fontSize = parseFloat(computedStyle.fontSize);
    if (fontSize > 0 && fontSize < 12 && type === 'text') {
      problems.push({
        type: 'font_too_small',
        element_id: id,
        element_type: type,
        severity: 'info',
        message: `Font size ${fontSize}px is below recommended minimum (12px)`,
        bbox: { x: relX, y: relY, width: rect.width, height: rect.height }
      });
    }

    // Check: zero dimensions
    if (rect.width < 1 || rect.height < 1) {
      problems.push({
        type: 'zero_size',
        element_id: id,
        element_type: type,
        severity: 'error',
        message: `Element has near-zero dimensions (${rect.width}x${rect.height})`,
        bbox: { x: relX, y: relY, width: rect.width, height: rect.height }
      });
    }
  });

  // Check: element overlap (n^2, only for small element counts)
  if (elements.length <= 50) {
    const slideArea = slideW * slideH;
    const rects = Array.from(elements).map(el => {
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      return {
        id: el.dataset.elementId || '',
        type: el.dataset.elementType || '',
        left: r.left - slideRect.left,
        top: r.top - slideRect.top,
        right: r.right - slideRect.left,
        bottom: r.bottom - slideRect.top,
        area: a,
        isFullCanvas: a > slideArea * 0.9
      };
    }).filter(r => r.area > 100);

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (a.isFullCanvas || b.isFullCanvas) continue;
        const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const overlapArea = overlapX * overlapY;
        const minArea = Math.min(a.area, b.area);
        if (minArea > 0 && overlapArea / minArea > 0.5) {
          problems.push({
            type: 'significant_overlap',
            element_id: a.id,
            element_type: a.type,
            severity: 'info',
            message: `Significant overlap (${Math.round(overlapArea/minArea*100)}%) with element ${b.id}`,
            bbox: { x: a.left, y: a.top, width: a.right-a.left, height: a.bottom-a.top }
          });
        }
      }
    }
  }

  // Check: large empty area (if few elements cover small portion of slide)
  if (elements.length > 0 && elements.length <= 3) {
    let totalArea = 0;
    elements.forEach(el => {
      const r = el.getBoundingClientRect();
      totalArea += r.width * r.height;
    });
    const slideArea = slideW * slideH;
    if (slideArea > 0 && totalArea / slideArea < 0.1) {
      problems.push({
        type: 'sparse_layout',
        element_id: '',
        element_type: '',
        severity: 'info',
        message: `Only ${Math.round(totalArea/slideArea*100)}% of slide area is used (${elements.length} elements)`,
        bbox: { x: 0, y: 0, width: slideW, height: slideH }
      });
    }
  }

  // Check: text/background contrast ratio (WCAG AA ≥ 4.5:1)
  function _luminance(r, g, b) {
    const [rs, gs, bs] = [r, g, b].map(c => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }
  function _contrastRatio(l1, l2) {
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }
  function _parseColor(str) {
    if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
    const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
    return null;
  }

  elements.forEach(el => {
    const type = el.dataset.elementType || '';
    if (type !== 'text' && type !== 'shape') return;
    const inner = el.querySelector('div');
    if (!inner || !inner.textContent.trim()) return;

    const cs = window.getComputedStyle(inner);
    const fg = _parseColor(cs.color);
    if (!fg) return;

    let bg = _parseColor(cs.backgroundColor);
    if (!bg) {
      const parentCs = window.getComputedStyle(el);
      bg = _parseColor(parentCs.backgroundColor);
    }
    if (!bg) {
      const slideCs = window.getComputedStyle(slide);
      bg = _parseColor(slideCs.backgroundColor);
    }
    if (!bg) bg = [255, 255, 255];

    const fgL = _luminance(fg[0], fg[1], fg[2]);
    const bgL = _luminance(bg[0], bg[1], bg[2]);
    const ratio = _contrastRatio(fgL, bgL);

    if (ratio < 3) {
      const id = el.dataset.elementId || '';
      const rect = el.getBoundingClientRect();
      problems.push({
        type: 'low_contrast',
        element_id: id,
        element_type: type,
        severity: 'warning',
        message: `Low text/background contrast ratio ${ratio.toFixed(1)}:1 (WCAG AA requires >= 4.5:1)`,
        bbox: { x: rect.left - slideRect.left, y: rect.top - slideRect.top, width: rect.width, height: rect.height }
      });
    } else if (ratio < 4.5) {
      const id = el.dataset.elementId || '';
      const rect = el.getBoundingClientRect();
      problems.push({
        type: 'low_contrast',
        element_id: id,
        element_type: type,
        severity: 'info',
        message: `Text/background contrast ratio ${ratio.toFixed(1)}:1 is below WCAG AA (4.5:1)`,
        bbox: { x: rect.left - slideRect.left, y: rect.top - slideRect.top, width: rect.width, height: rect.height }
      });
    }
  });

  return problems;
}
"""


# ============================================================================
# Public API
# ============================================================================


def _run_async_safe(coro):
    """Run an async coroutine from synchronous code, safe for Python 3.10–3.12+.

    Handles three cases:
      1. No running loop → asyncio.run()
      2. Loop exists and is running → offload to a thread
      3. Loop exists but not running → loop.run_until_complete()
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, coro).result(timeout=60)

    return asyncio.run(coro)


def render_slide_preview(
    elements: list[dict[str, Any]],
    background: dict[str, Any] | None = None,
    canvas_width: int = 1280,
    canvas_height: int = 720,
) -> bytes:
    """
    Render a single slide page to PNG bytes.

    Returns raw PNG bytes. Caller is responsible for uploading to OSS or
    encoding as base64.
    """
    html = build_slide_html(elements, background, canvas_width, canvas_height)
    return _run_async_safe(
        _render_page_screenshot(html, canvas_width, canvas_height)
    )


def render_slide_preview_safe(
    elements: list[dict[str, Any]],
    background: dict[str, Any] | None = None,
    canvas_width: int = 1280,
    canvas_height: int = 720,
) -> bytes:
    """Event-loop-safe version — now delegates to _run_async_safe."""
    html = build_slide_html(elements, background, canvas_width, canvas_height)
    return _run_async_safe(
        _render_page_screenshot(html, canvas_width, canvas_height)
    )


def run_visual_lint(
    elements: list[dict[str, Any]],
    background: dict[str, Any] | None = None,
    canvas_width: int = 1280,
    canvas_height: int = 720,
) -> list[dict[str, Any]]:
    """
    Run visual lint checks on a slide page.

    Returns a list of problem dicts, each with:
      type, element_id, element_type, severity, message, bbox
    """
    html = build_slide_html(elements, background, canvas_width, canvas_height)
    return _run_async_safe(
        _run_visual_lint(html, canvas_width, canvas_height)
    )


def run_visual_lint_batch(
    pages: list[dict[str, Any]],
    canvas_width: int = 1280,
    canvas_height: int = 720,
) -> list[list[dict[str, Any]]]:
    """
    Lint multiple slide pages using a single shared browser instance.

    Each entry in *pages* should have 'elements' and optionally 'background'.
    Returns a list of problem-lists, one per page.
    """
    html_pages = [
        build_slide_html(
            p.get("elements", []),
            p.get("background"),
            canvas_width,
            canvas_height,
        )
        for p in pages
    ]
    return _run_async_safe(
        _run_visual_lint_batch(html_pages, canvas_width, canvas_height)
    )
