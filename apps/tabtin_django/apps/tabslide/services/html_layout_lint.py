"""HTML 阶段布局 lint：在 Playwright 抽取前检测 .ppt-slide 内容是否撑破画布。

与 structural_lint（抽取后 JSON 几何）互补：
- 本模块看 **源 HTML 真实布局**（scrollHeight / 子节点 bbox），
  能报出「字在 y≥720、会被 overflow:hidden 裁掉」的问题；
- structural 只看见 clamp 后仍残留的部分越界 shape。

问题形态与 structural_lint 对齐，便于 CLI / Agent 统一消费。
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# 存入 SlideProject.font_meta 的旁路键（_normalize_font_meta 不会透出给字体 API）
HTML_LAYOUT_PROBLEMS_KEY = "html_layout_problems"

# 超过该像素视为明确撑破（error）；2–阈值之间为 warning（量框误差）
_OVERFLOW_ERROR_PX = 24.0
_OVERFLOW_WARN_PX = 2.0

# 注入 Playwright：对单个 .ppt-slide 元素 evaluate
HTML_LAYOUT_LINT_JS = """
(el) => {
  const root = el.getBoundingClientRect();
  const canvasW = root.width;
  const canvasH = root.height;
  let contentBottom = 0;
  let contentRight = 0;
  const nodes = el.querySelectorAll('*');
  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i].getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    const bottom = r.bottom - root.top;
    const right = r.right - root.left;
    if (bottom > contentBottom) contentBottom = bottom;
    if (right > contentRight) contentRight = right;
  }
  const clippedTexts = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length < 2) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) continue;
    const top = r.top - root.top;
    const bottom = r.bottom - root.top;
    // 完全在画布下方 / 右侧 → 浏览器 overflow:hidden 下不可见
    if (top >= canvasH - 0.5 || (r.left - root.left) >= canvasW - 0.5) {
      clippedTexts.push({
        text: t.slice(0, 48),
        y: Math.round(top * 10) / 10,
        bottom: Math.round(bottom * 10) / 10,
      });
    }
  }
  return {
    canvasW: Math.round(canvasW),
    canvasH: Math.round(canvasH),
    contentBottom: Math.round(contentBottom * 10) / 10,
    contentRight: Math.round(contentRight * 10) / 10,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    clippedTexts: clippedTexts.slice(0, 8),
    clippedTextCount: clippedTexts.length,
  };
}
"""


def problems_from_layout_metrics(
    metrics: dict[str, Any] | None,
    *,
    page_id: str,
    canvas_w: float,
    canvas_h: float,
) -> list[dict]:
    """把 Playwright 量到的布局指标转成 lint problems（纯函数，可单测）。"""
    if not isinstance(metrics, dict):
        return []

    problems: list[dict] = []
    try:
        content_bottom = float(metrics.get("contentBottom") or 0)
        content_right = float(metrics.get("contentRight") or 0)
        scroll_h = float(metrics.get("scrollHeight") or 0)
        client_h = float(metrics.get("clientHeight") or 0)
    except (TypeError, ValueError):
        return []

    # 优先用子节点 bbox；scrollHeight 作补充（含 padding 塌缩场景）
    overflow_bottom = max(0.0, content_bottom - canvas_h, scroll_h - client_h)
    overflow_right = max(0.0, content_right - canvas_w)

    if overflow_bottom > _OVERFLOW_WARN_PX or overflow_right > _OVERFLOW_WARN_PX:
        parts = []
        if overflow_bottom > _OVERFLOW_WARN_PX:
            parts.append(f"下越界 {overflow_bottom:.0f}px（内容底≈{content_bottom:.0f}）")
        if overflow_right > _OVERFLOW_WARN_PX:
            parts.append(f"右越界 {overflow_right:.0f}px（内容右≈{content_right:.0f}）")
        severity = (
            "error"
            if overflow_bottom > _OVERFLOW_ERROR_PX or overflow_right > _OVERFLOW_ERROR_PX
            else "warning"
        )
        problems.append({
            "type": "html_overflow",
            "element_id": "",
            "element_type": "",
            "severity": severity,
            "message": (
                f"HTML 内容超出画布 {int(canvas_w)}x{int(canvas_h)}"
                f"（{'；'.join(parts)}）——浏览器 overflow:hidden 会裁掉，"
                "导出后对应文字/图标也会丢失。请精简该页或拆页后重新 render"
            ),
            "page_id": page_id,
            "metrics": {
                "content_bottom": content_bottom,
                "content_right": content_right,
                "overflow_bottom": overflow_bottom,
                "overflow_right": overflow_right,
            },
        })

    clipped_count = int(metrics.get("clippedTextCount") or 0)
    clipped_samples = metrics.get("clippedTexts") or []
    if clipped_count > 0:
        samples = []
        if isinstance(clipped_samples, list):
            for item in clipped_samples[:5]:
                if isinstance(item, dict) and item.get("text"):
                    samples.append(str(item["text"]))
        sample_hint = ("：" + " / ".join(samples)) if samples else ""
        # 有明确撑破时降为 info（避免与 html_overflow 重复吵）；仅裁字时升 warning
        severity = "info" if problems else "warning"
        problems.append({
            "type": "html_clipped_text",
            "element_id": "",
            "element_type": "text",
            "severity": severity,
            "message": (
                f"有 {clipped_count} 段文字完全落在画布外（将被裁切）{sample_hint}"
            ),
            "page_id": page_id,
        })

    return problems


def collect_layout_problems(pages: list[dict] | None) -> list[dict]:
    """从 extract 产出的 page dict 上收集 layout_problems，并剥离临时字段。"""
    if not pages:
        return []
    all_problems: list[dict] = []
    for page in pages:
        if not isinstance(page, dict):
            continue
        probs = page.pop("layout_problems", None)
        if isinstance(probs, list):
            all_problems.extend(p for p in probs if isinstance(p, dict))
    return all_problems
