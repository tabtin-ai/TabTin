"""
TabSlide 结构性 lint —— 纯 JSON 层检查，不依赖 Playwright 渲染。

跟 `preview_service._LINT_SCRIPT`（DOM 渲染后视觉检查）互补：
- visual lint：检测 "渲染出来对不对" → 出画/溢出/对比度/字号过小/重叠
- structural lint：检测 "数据结构对不对" → id 重复/字段错位/shape 没视觉/img src 空

适合 Agent 编辑后快速自检（毫秒级），出问题立刻能定位元素 id。
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


# 出现在元素**顶层**就视为"应该挪进 props"的内容字段。
# 这些字段在 dom_extractor flat 输出里会出现，但落 DB 后应该被 _flat_element_to_props_wrapped 移到 props。
# 如果仍出现在顶层，说明 Agent 写错了 patch 或某条 import 链路漏了 wrap。
_CONTENT_FIELDS_BELONGING_IN_PROPS = frozenset({
    "content", "text", "src", "fill", "gradient", "outline", "shadow",
    "color", "fontSize", "fontFamily", "fontWeight",
    "defaultColor", "defaultFontSize", "defaultFontName", "defaultFontWeight",
    "path", "viewBox", "fixedRatio", "pathFormula", "pptxShapeType",
    "keypoints", "lineHeight", "wordSpace", "paragraphSpace",
    "data", "axisX", "axisY", "options",  # chart 字段
})


# 跨页全局错误（如 duplicate_element_id）的 page_id 用占位
_GLOBAL_PAGE_ID = ""


def _shape_has_visual(props: dict) -> bool:
    """判断 shape 元素是否有任何可见的填充 / 边框 / 阴影。"""
    if not isinstance(props, dict):
        return False
    if props.get("fill"):
        return True
    if isinstance(props.get("gradient"), dict) and props["gradient"].get("colors"):
        return True
    if isinstance(props.get("outline"), dict) and props["outline"].get("width"):
        return True
    if isinstance(props.get("shadow"), dict) and props["shadow"]:
        return True
    if props.get("bgImage") or props.get("_bgImageMode"):
        return True
    # SVG path 自身没填色就算无视觉，但 viewBox 可能有意义（线/虚线 shape）
    return False


def _is_invalid_src(src: Any) -> bool:
    """判断 image src 是否无效。

    data:image/* 是合法形态（ inline_images 渲染链路的正常产物，
    OSS 不可用时的 base64 回退也是它）；其他 data:（text/html 等）仍视为无效。
    """
    if not src or not isinstance(src, str):
        return True
    s = src.strip()
    if not s:
        return True
    if s.startswith("data:"):
        return not s.startswith("data:image/")
    return False


def _element_bbox(el: dict) -> tuple[float, float, float, float]:
    """返回 (x, y, width, height)，缺失字段默认 0。"""
    x = float(el.get("x") or el.get("left") or 0)
    y = float(el.get("y") or el.get("top") or 0)
    w = float(el.get("width") or 0)
    h = float(el.get("height") or 0)
    return x, y, w, h


def _check_page(
    page: dict,
    canvas_w: int,
    canvas_h: int,
    seen_ids: dict[str, list[str]],
    font_check: bool,
) -> list[dict]:
    """检查单页所有结构性问题。

    seen_ids：跨页累积的 element_id → [page_id, page_id, ...]，
    页面级检查完后调用方负责跨页找 duplicate。
    """
    problems: list[dict] = []
    page_id = page.get("id") or page.get("page_id") or ""
    elements = page.get("elements") or []
    if not isinstance(elements, list):
        return problems

    image_area_total = 0.0
    canvas_area = float(canvas_w * canvas_h) if canvas_w > 0 and canvas_h > 0 else 1.0
    fonts_in_page: set[str] = set()

    for idx, el in enumerate(elements):
        if not isinstance(el, dict):
            problems.append({
                "type": "non_dict_element",
                "element_id": "",
                "element_type": "",
                "severity": "error",
                "message": f"element[{idx}] is not a dict",
                "page_id": page_id,
            })
            continue

        eid = el.get("id")
        etype = el.get("type", "")
        props = el.get("props") if isinstance(el.get("props"), dict) else {}

        # R1: 元素必须有 id（否则 update 拿不到）
        if not eid:
            problems.append({
                "type": "element_missing_id",
                "element_id": "",
                "element_type": etype,
                "severity": "error",
                "message": (
                    f"element[{idx}] (type={etype}) has no `id` field — "
                    "Agent 无法通过 update CLI 单独修改它"
                ),
                "page_id": page_id,
            })
        else:
            seen_ids.setdefault(eid, []).append(page_id)

        # R2: 顶层不应出现"内容字段"（应该在 props 下）
        flat_violations = [
            k for k in el.keys() if k in _CONTENT_FIELDS_BELONGING_IN_PROPS
        ]
        if flat_violations:
            problems.append({
                "type": "flat_content_field",
                "element_id": eid or "",
                "element_type": etype,
                "severity": "warning",
                "message": (
                    f"内容字段 {sorted(flat_violations)} 出现在顶层，"
                    f"应嵌入 props 下（Agent update 走 patch.props.X 路径）"
                ),
                "page_id": page_id,
            })

        # R3: shape 既无 fill 也无 gradient 也无 outline / shadow → 看不见的占位
        if etype == "shape" and not _shape_has_visual(props):
            x, y, w, h = _element_bbox(el)
            problems.append({
                "type": "shape_no_visual",
                "element_id": eid or "",
                "element_type": etype,
                "severity": "warning",
                "message": (
                    "shape 既无 fill 也无 gradient/outline/shadow，渲染时不可见 "
                    "（可能是 inset shadow 装饰层残留或数据丢失）"
                ),
                "bbox": {"x": x, "y": y, "width": w, "height": h},
                "page_id": page_id,
            })

        # R4: text 元素 content 为空
        if etype == "text":
            content = props.get("content") if props else None
            if isinstance(content, str) and not content.strip():
                problems.append({
                    "type": "text_empty_content",
                    "element_id": eid or "",
                    "element_type": etype,
                    "severity": "info",
                    "message": "text 元素 props.content 是空字符串",
                    "page_id": page_id,
                })
            elif content is None and not el.get("content"):
                # text 缺失 content 字段（既不在顶层也不在 props）
                problems.append({
                    "type": "text_missing_content",
                    "element_id": eid or "",
                    "element_type": etype,
                    "severity": "warning",
                    "message": "text 元素既无 props.content 也无顶层 content",
                    "page_id": page_id,
                })
            elif isinstance(content, str) and len(content) > 2000:
                # 单 text 元素文本过长，可能需要拆分
                problems.append({
                    "type": "text_overlong",
                    "element_id": eid or "",
                    "element_type": etype,
                    "severity": "info",
                    "message": f"text content 字符数 {len(content)} 过多，建议拆分为多个元素",
                    "page_id": page_id,
                })

        # R5: image src 无效
        if etype == "image":
            src = props.get("src") if props else None
            if not src:
                src = el.get("src")
            if _is_invalid_src(src):
                problems.append({
                    "type": "image_invalid_src",
                    "element_id": eid or "",
                    "element_type": etype,
                    "severity": "warning",
                    "message": (
                        f"image src 无效（current={(src or '')[:80]!r}）— "
                        "应为 https URL 或已上传 OSS 的链接"
                    ),
                    "page_id": page_id,
                })
            x, y, w, h = _element_bbox(el)
            image_area_total += max(0, w) * max(0, h)

        # R6: 负向 / 零 / NaN 尺寸（视觉 lint 也会检 zero_size 但只检 zero，负值不查）
        x, y, w, h = _element_bbox(el)
        if w < 0 or h < 0:
            problems.append({
                "type": "negative_dimensions",
                "element_id": eid or "",
                "element_type": etype,
                "severity": "error",
                "message": f"width/height 为负值 ({w}x{h})",
                "bbox": {"x": x, "y": y, "width": w, "height": h},
                "page_id": page_id,
            })

        # R10: 元素出画——纯几何即可判定，不必等 visual lint。
        # HTML 内容溢出 .ppt-slide 容器时，浏览器 overflow:hidden 裁掉，
        # 但抽取量到真实 bbox，导出 PPT 无裁剪概念 → 元素画到页面外。
        # 容差 2px 吸收量框取整误差。
        if canvas_w > 0 and canvas_h > 0 and w > 0 and h > 0:
            overflow_parts = []
            if x + w > canvas_w + 2:
                overflow_parts.append(f"右越界 {x + w - canvas_w:.0f}px")
            if y + h > canvas_h + 2:
                overflow_parts.append(f"下越界 {y + h - canvas_h:.0f}px")
            if x < -2 or y < -2:
                overflow_parts.append(f"负坐标 ({x:.0f},{y:.0f})")
            if overflow_parts:
                problems.append({
                    "type": "out_of_canvas",
                    "element_id": eid or "",
                    "element_type": etype,
                    "severity": "warning",
                    "message": (
                        f"元素超出画布 {canvas_w}x{canvas_h}（{'；'.join(overflow_parts)}）"
                        "——导出 PPT 会画到页面外，请压缩该页内容或调整布局"
                    ),
                    "bbox": {"x": x, "y": y, "width": w, "height": h},
                    "page_id": page_id,
                })

        # R7: 字体未注册（仅 text 类型）
        if font_check and etype == "text" and props:
            fam = props.get("defaultFontName") or props.get("fontFamily") or ""
            if isinstance(fam, str) and fam:
                fonts_in_page.add(fam.strip())

    # R11: 页面下半部空白（ 视觉质量）——内容垂直覆盖不足即"头重脚轻"。
    # 用所有元素的 max(y+h) 相对 canvas_h 的占比判定；忽略近乎全屏的背景元素
    # 不会影响该指标（背景本身就到底）。少于 4 个元素的页（如纯封面）不检查。
    content_elements = [e for e in elements if isinstance(e, dict)]
    if canvas_h > 0 and len(content_elements) >= 4:
        max_bottom = 0.0
        for e in content_elements:
            ex, ey, ew, eh = _element_bbox(e)
            if ew > 0 and eh > 0:
                max_bottom = max(max_bottom, ey + eh)
        coverage = max_bottom / canvas_h
        if 0 < coverage < 0.72:
            problems.append({
                "type": "sparse_page_bottom",
                "element_id": "",
                "element_type": "",
                "severity": "warning",
                "message": (
                    f"页面内容只延伸到画布 {coverage * 100:.0f}% 高度，下半部大面积空白"
                    "——把内容块垂直撑满版心（flex 分布 / 增大间距与字号），或合并到其他页"
                ),
                "page_id": page_id,
            })

    # R8: 单页 image 总面积 > 70% canvas → 截图主导（可编辑度低）
    if image_area_total / canvas_area > 0.7:
        problems.append({
            "type": "media_dominates_page",
            "element_id": "",
            "element_type": "",
            "severity": "info",
            "message": (
                f"该页 image 元素总面积占 canvas {image_area_total / canvas_area * 100:.0f}%，"
                "可编辑度低；考虑用文字 / 形状重组关键信息"
            ),
            "page_id": page_id,
        })

    # R9: 未注册字体（基于 font_registry 的别名表）
    if fonts_in_page and font_check:
        try:
            from apps.tabslide.services.font_registry import (
                _FONT_ALIASES,
                _normalize_family_name,
            )

            unregistered: list[str] = []
            for fam in fonts_in_page:
                normalized = _normalize_family_name(fam)
                if not normalized:
                    continue
                # 直接命中
                if normalized in _FONT_ALIASES:
                    continue
                # 大小写不敏感命中
                lower = normalized.lower()
                if any(key.lower() == lower for key in _FONT_ALIASES):
                    continue
                unregistered.append(fam)
            if unregistered:
                problems.append({
                    "type": "unregistered_font",
                    "element_id": "",
                    "element_type": "",
                    "severity": "info",
                    "message": (
                        f"该页使用未注册字体 {sorted(unregistered)[:5]}"
                        " — 渲染时会回退到系统字体，可能跟设计稿不一致"
                    ),
                    "page_id": page_id,
                })
        except Exception:
            logger.debug("font registry not available, skipping font check")

    return problems


def check_structural_issues(
    pages: list[dict],
    canvas_w: int = 1280,
    canvas_h: int = 720,
    *,
    font_check: bool = True,
) -> list[dict]:
    """对所有页面跑结构性 lint，返回扁平 problems 列表。

    每个 problem 形如：
      {
        "type": "<rule_name>",
        "element_id": "<element-id 或空>",
        "element_type": "<type 或空>",
        "severity": "error" | "warning" | "info",
        "message": "<human readable>",
        "page_id": "<page-id 或空>",
        "bbox": {...},  # 部分规则有
      }
    """
    if not isinstance(pages, list):
        return []

    all_problems: list[dict] = []
    seen_ids: dict[str, list[str]] = {}

    for page in pages:
        if not isinstance(page, dict):
            continue
        all_problems.extend(_check_page(page, canvas_w, canvas_h, seen_ids, font_check))

    # 跨页重复 id 检查（在所有页面收集完之后）
    for eid, pages_with_id in seen_ids.items():
        if len(pages_with_id) > 1:
            all_problems.append({
                "type": "duplicate_element_id",
                "element_id": eid,
                "element_type": "",
                "severity": "error",
                "message": (
                    f"element_id '{eid}' 在 {len(pages_with_id)} 个位置出现："
                    f"{pages_with_id[:5]} — update CLI 无法准确定位"
                ),
                "page_id": pages_with_id[0],
            })

    return all_problems
