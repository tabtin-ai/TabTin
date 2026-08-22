"""
TabSlide Direct DOM Extractor

Converts Agent-generated HTML directly to PPTElement JSON by analyzing
the DOM tree in Playwright.

Pipeline:  HTML → Playwright → 纯 DOM 文本/图片 + DOM shapes/tables
"""

from __future__ import annotations

import asyncio
import base64
import html
import json
import logging
import re as _re
import sys
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from apps.tabslide.services.html_layout_lint import (
    HTML_LAYOUT_LINT_JS,
    problems_from_layout_metrics,
)
from apps.tabslide.services.html_render_runtime import (
    PLATFORM_HEAD_RESOURCES_HTML,
    build_local_font_face_css,
    load_render_document,
    wait_for_image_decode,
    wait_for_optional_render_ready,
)

logger = logging.getLogger(__name__)


SLIDE_SELECTOR = ".ppt-slide"


def _new_playwright_event_loop():
    """Create an event loop that can spawn Playwright on Windows."""
    if sys.platform == "win32":
        proactor_loop = getattr(asyncio, "ProactorEventLoop", None)
        if proactor_loop is not None:
            return proactor_loop()
    return asyncio.new_event_loop()


def _run_async_safe(coro):
    """Run a coroutine from sync code without inheriting Daphne's selector loop."""
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    if running_loop is not None and running_loop.is_running():
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(_run_async_safe, coro).result(timeout=60)

    loop = _new_playwright_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ─── CDN / Component Library CSS ─────────────────────────────────────────

_BASE_HEAD_RESOURCES = PLATFORM_HEAD_RESOURCES_HTML + """
<style>
  :root {
    --slide-primary:  #2563eb;
    --slide-accent:   #dc2626;
    --slide-text:     #1f2937;
    --slide-text-secondary: #64748b;
    --slide-bg:       #ffffff;
    --slide-bg-subtle:#f8fafc;
    --slide-border:   #e2e8f0;
    --slide-blue:   #2563eb;
    --slide-teal:   #0f766e;
    --slide-green:  #059669;
    --slide-orange: #f59e0b;
    --slide-red:    #dc2626;
    --slide-purple: #7c3aed;
    --slide-success: #059669;
    --slide-warning: #f59e0b;
    --slide-error:   #dc2626;
    --slide-info:    #2563eb;
    --slide-font-heading: 'Inter', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    --slide-font-body:    'Inter', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    --slide-font-mono:    'JetBrains Mono', 'Fira Code', monospace;
    --slide-radius-sm:  8px;
    --slide-radius-md:  12px;
    --slide-radius-lg:  16px;
    --slide-radius-xl:  24px;
    --slide-radius-full:9999px;
    --slide-shadow-sm:  0 1px 3px rgba(0,0,0,0.08);
    --slide-shadow-md:  0 4px 12px rgba(0,0,0,0.08);
    --slide-shadow-lg:  0 8px 24px rgba(0,0,0,0.12);
    --slide-shadow-xl:  0 16px 48px rgba(0,0,0,0.15);
  }

  body { margin:0; padding:0; background:#f0f0f0; }
  .ppt-slide {
    font-family: var(--slide-font-body);
    color: var(--slide-text);
    line-height: 1.5;
    box-sizing: border-box;
  }
  .ppt-slide *, .ppt-slide *::before, .ppt-slide *::after { box-sizing: border-box; }

  .slide-cover {
    display:flex; flex-direction:column; justify-content:center; align-items:center;
    text-align:center; padding:80px;
  }
  .slide-content {
    display:flex; flex-direction:column; padding:60px 80px; gap:32px;
  }
  .slide-split {
    display:grid; grid-template-columns:1fr 1fr; gap:48px; padding:60px 80px; align-items:center;
  }
  .slide-split-40-60 {
    display:grid; grid-template-columns:2fr 3fr; gap:48px; padding:60px 80px; align-items:center;
  }
  .slide-grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
  .slide-grid-3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:24px; }
  .slide-grid-4 { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:24px; }

  .slide-title {
    font-family: var(--slide-font-heading);
    font-size:48px; font-weight:700; line-height:1.2; margin:0;
    color: var(--slide-text);
  }
  .slide-title-lg {
    font-family: var(--slide-font-heading);
    font-size:64px; font-weight:800; line-height:1.1; margin:0;
  }
  .slide-subtitle {
    font-size:28px; font-weight:400; line-height:1.4; margin:0;
    color: var(--slide-text-secondary);
  }
  .slide-heading {
    font-family: var(--slide-font-heading);
    font-size:36px; font-weight:700; line-height:1.3; margin:0;
  }
  .slide-body { font-size:20px; font-weight:400; line-height:1.6; margin:0; color: var(--slide-text); }
  .slide-caption { font-size:14px; font-weight:400; color: var(--slide-text-secondary); margin:0; }
  .slide-label { font-size:14px; font-weight:500; text-transform:uppercase; letter-spacing:0.05em; color: var(--slide-text-secondary); margin:0; }
  .slide-number { font-family: var(--slide-font-heading); font-size:56px; font-weight:800; line-height:1; margin:0; color: var(--slide-primary); }
  .slide-code { font-family: var(--slide-font-mono); font-size:16px; background:var(--slide-bg-subtle); border-radius:var(--slide-radius-sm); padding:16px 24px; overflow-x:auto; white-space:pre; }

  .slide-card { background:var(--slide-bg); border-radius:var(--slide-radius-lg); padding:32px; box-shadow:var(--slide-shadow-md); }
  .slide-card-bordered { background:var(--slide-bg); border-radius:var(--slide-radius-lg); padding:32px; border:1px solid var(--slide-border); }
  .slide-card-accent { background:var(--slide-bg); border-radius:var(--slide-radius-lg); padding:32px; box-shadow:var(--slide-shadow-md); border-left:4px solid var(--slide-primary); }
  .slide-card-filled { background:var(--slide-primary); border-radius:var(--slide-radius-lg); padding:32px; color:#fff; }
  .slide-card-glass { background:rgba(255,255,255,0.85); backdrop-filter:blur(12px); border-radius:var(--slide-radius-lg); padding:32px; border:1px solid rgba(255,255,255,0.3); }

  .slide-kpi { background:var(--slide-bg); border-radius:var(--slide-radius-lg); padding:32px; box-shadow:var(--slide-shadow-md); display:flex; flex-direction:column; gap:8px; }
  .slide-kpi .kpi-label { font-size:14px; color:var(--slide-text-secondary); }
  .slide-kpi .kpi-value { font-size:48px; font-weight:700; color:var(--slide-primary); line-height:1.1; }
  .slide-kpi .kpi-change { font-size:14px; }
  .slide-kpi .kpi-change.up { color:var(--slide-success); }
  .slide-kpi .kpi-change.down { color:var(--slide-error); }

  .slide-table { width:100%; border-collapse:collapse; font-size:16px; }
  .slide-table th { background:var(--slide-primary); color:#fff; font-weight:600; padding:12px 16px; text-align:left; }
  .slide-table td { padding:12px 16px; border-bottom:1px solid var(--slide-border); }
  .slide-table tr:nth-child(even) td { background:var(--slide-bg-subtle); }
  .slide-table-minimal { width:100%; border-collapse:collapse; font-size:16px; }
  .slide-table-minimal th { font-weight:600; padding:12px 16px; text-align:left; border-bottom:2px solid var(--slide-text); }
  .slide-table-minimal td { padding:12px 16px; border-bottom:1px solid var(--slide-border); }

  .slide-badge { display:inline-flex; align-items:center; gap:4px; font-size:13px; font-weight:600; padding:4px 12px; border-radius:var(--slide-radius-full); background:var(--slide-bg-subtle); color:var(--slide-text); }
  .slide-badge-primary { background:rgba(37,99,235,0.12); color:var(--slide-primary); }
  .slide-badge-success { background:rgba(5,150,105,0.12);  color:var(--slide-success); }
  .slide-badge-warning { background:rgba(245,158,11,0.12); color:var(--slide-warning); }
  .slide-badge-error   { background:rgba(220,38,38,0.12);  color:var(--slide-error);   }

  .slide-list { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:12px; }
  .slide-list li { display:flex; align-items:flex-start; gap:12px; font-size:20px; }
  .slide-list li::before { content:''; width:8px; height:8px; border-radius:50%; flex-shrink:0; background:var(--slide-primary); margin-top:8px; }

  .slide-divider { border:none; height:2px; background:var(--slide-border); margin:16px 0; }
  .slide-divider-accent { border:none; height:3px; background:var(--slide-primary); margin:16px 0; width:60px; }
  .slide-accent-bar { width:60px; height:4px; border-radius:2px; background:var(--slide-primary); }
  .slide-icon-circle { width:48px; height:48px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:20px; background:rgba(37,99,235,0.12); color:var(--slide-primary); }
  .slide-quote { border-left:4px solid var(--slide-primary); padding:16px 24px; font-size:22px; font-style:italic; color:var(--slide-text-secondary); background:var(--slide-bg-subtle); border-radius:0 var(--slide-radius-sm) var(--slide-radius-sm) 0; }
  .slide-step-number { width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:700; background:var(--slide-primary); color:#fff; flex-shrink:0; }

  .slide-progress { height:8px; border-radius:4px; background:var(--slide-border); overflow:hidden; }
  .slide-progress-fill { height:100%; border-radius:4px; background:var(--slide-primary); }

  .slide-timeline { display:flex; flex-direction:column; gap:0; padding-left:20px; border-left:2px solid var(--slide-border); }
  .slide-timeline-item { position:relative; padding:0 0 24px 24px; }
  .slide-timeline-item::before { content:''; position:absolute; left:-7px; top:4px; width:12px; height:12px; border-radius:50%; background:var(--slide-primary); border:2px solid var(--slide-bg); }

  /*
   * data-ts-* Metadata Protocol:
   *   <hr data-ts-points='["arrow",""]' />         Line arrows
   *   <hr data-ts-line-type="curve" />              Line type
   *   <img data-ts-color-mask="rgba(0,0,0,0.3)" /> Image color overlay
   *   <img data-ts-clip='{"shape":"rect",...}' />   Image clip
   *   <div data-ts-pattern='{"type":"stripe",...}' /> Shape pattern
   */
</style>
"""


# ─── HTML Wrapping ────────────────────────────────────────────────────────


def _ensure_full_html(html: str) -> str:
    """Wrap raw HTML in a full document with CDN resources if needed."""
    stripped = html.strip()
    has_head = "<head" in stripped.lower()
    has_html_tag = stripped.lower().startswith("<!doctype") or stripped.lower().startswith("<html")
    # 内置字体 + 组件基础样式始终注入（slide HTML 一律用原生 CSS，平台不再注入 Tailwind）。
    font_css = build_local_font_face_css()
    head_inject = font_css + _BASE_HEAD_RESOURCES

    if has_html_tag and has_head:
        # 注入到 <head> 开头，让平台基础样式作为“默认值”：Agent 自己的 <style> 在其后，
        # 同 CSS 特异性下后者胜出，避免 .ppt-slide 基础 color/font-family 反盖 Agent 的
        # 幻灯片级样式（如 .slide-cover{color:white} 被 .ppt-slide{color:#1f2937} 盖掉，
        # 导致暗底白字被渲染成深色）。
        head_open = _re.search(r"<head[^>]*>", stripped, _re.IGNORECASE)
        if head_open:
            pos = head_open.end()
            return stripped[:pos] + head_inject + stripped[pos:]
        return stripped.replace("</head>", head_inject + "</head>", 1)

    if has_html_tag and not has_head:
        insert_pos = stripped.lower().find("<html")
        end_of_tag = stripped.find(">", insert_pos) + 1
        return (
            stripped[:end_of_tag]
            + "<head>" + font_css + _BASE_HEAD_RESOURCES + "</head>"
            + stripped[end_of_tag:]
        )

    return (
        "<!DOCTYPE html><html><head>"
        + font_css
        + _BASE_HEAD_RESOURCES
        + "</head><body>"
        + stripped
        + "</body></html>"
    )


# ─── Small JS helpers for slide-specific metadata ────────────────────────

_EXTRACT_BG_JS = """(slideEl) => {
    const st = getComputedStyle(slideEl);
    function rgbToHex(rgb) {
        if (!rgb || rgb === 'transparent') return null;
        if (rgb.startsWith('#')) return rgb.toUpperCase();
        const m = rgb.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
        if (!m) return null;
        return '#' + [m[1],m[2],m[3]].map(x => parseInt(x).toString(16).padStart(2,'0')).join('').toUpperCase();
    }
    function isTransparent(c) { return !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)'; }

    function parseGradient(cssGrad) {
        const linM = cssGrad.match(/linear-gradient\\(\\s*(\\d+)deg/);
        const rotate = linM ? parseInt(linM[1]) : 0;
        const colorStops = [];
        const re = /rgba?\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+(?:\\s*,\\s*[\\d.]+)?\\s*\\)|#[0-9a-fA-F]{3,8}/g;
        let match;
        while ((match = re.exec(cssGrad)) !== null) {
            colorStops.push(rgbToHex(match[0]) || match[0]);
        }
        if (colorStops.length < 2) return null;
        const colors = colorStops.map((c, i) => ({
            pos: i / (colorStops.length - 1),
            color: c,
        }));
        return { type: 'linear', rotate: rotate, colors: colors };
    }

    const bgImage = st.backgroundImage;
    if (bgImage && bgImage !== 'none') {
        if (bgImage.includes('gradient')) {
            const parsed = parseGradient(bgImage);
            if (parsed) return { type: 'gradient', gradient: parsed };
            return { type: 'gradient', gradient: { css: bgImage } };
        }
        if (bgImage.includes('url(')) {
            const um = bgImage.match(/url\\(["']?(.+?)["']?\\)/);
            if (um) return { type: 'image', image: { src: um[1], size: 'cover' } };
        }
    }
    const bgColor = st.backgroundColor;
    if (!isTransparent(bgColor)) {
        return { type: 'solid', value: rgbToHex(bgColor) || '#FFFFFF' };
    }
    return { type: 'solid', value: '#FFFFFF' };
}"""


_DETECT_CANVAS_JS = """(slideEl) => {
    // Phase-3 Wave-1：把 ECharts 容器 div、Chart.js canvas 都纳入截图范围
    const selector = [
        'canvas',
        '[_echarts_instance_]',
        // ECharts 常见容器命名：id="chart1" / id="chart-2" / class="echarts-..."
        'div[id^="chart"]',
        'div[class*="echarts"]',
        'div.echarts-container',
    ].join(',');
    const candidates = slideEl.querySelectorAll(selector);
    const slideRect = slideEl.getBoundingClientRect();
    // 用 Set 去重：ECharts init 后会同时有 [_echarts_instance_] 属性 + 内嵌 canvas，
    // 取最外层（带 _echarts_instance_ 的 div）足以
    const seen = new Set();
    const results = [];
    Array.from(candidates).forEach(c => {
        if (c.closest && c.closest('[data-tabslide-rasterized]')) return;
        // 若已被某个祖先（也是候选）覆盖，跳过子元素
        let p = c.parentElement;
        let absorbed = false;
        while (p && p !== slideEl) {
            if (seen.has(p)) { absorbed = true; break; }
            p = p.parentElement;
        }
        if (absorbed) return;
        const r = c.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        // 必须与 slide 有交集
        if (r.right < slideRect.left || r.left > slideRect.right) return;
        if (r.bottom < slideRect.top || r.top > slideRect.bottom) return;
        seen.add(c);
        results.push({
            x: r.left - slideRect.left,
            y: r.top - slideRect.top,
            width: r.width,
            height: r.height,
        });
    });
    return results;
}"""


# Phase-2 Wave-2 栅格化兜底：识别"必须整块截图"的元素
#
# 触发条件：
#   1. 显式：任何带 data-tabslide-rasterize 属性的元素（Agent 主动声明）
#   2. 隐式：使用 backdrop-filter / clip-path / mask / mix-blend-mode 或
#          复杂 filter（drop-shadow/hue-rotate/saturate/...）的元素
#   3. 隐式：直接子元素含装饰性 SVG（含 path 且子节点 >= 2）的元素
#
# 副作用：在被选中元素及其后代上加 data-tabslide-rasterized="1" 属性，
#   使后续的 walker / SHAPES / TEXT_LAYOUT / PURE_DOM 等扫描跳过该子树。
#   截图完成后调用 _CLEANUP_RASTERIZE_MARKS_JS 清理。
_DETECT_RASTERIZE_REGIONS_JS = """(slideEl) => {
    const slideRect = slideEl.getBoundingClientRect();
    const MAX_REGIONS = 20;
    const COMPLEX_FILTER_RE = /drop-shadow|hue-rotate|saturate|sepia|invert|contrast|grayscale/i;

    function isVisible(el, cs, rect) {
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity) === 0) return false;
        if (rect.width < 2 || rect.height < 2) return false;
        // 必须与 slide 有交集
        if (rect.right < slideRect.left || rect.left > slideRect.right) return false;
        if (rect.bottom < slideRect.top || rect.top > slideRect.bottom) return false;
        return true;
    }

    const candidates = [];

    // 显式标记最高优先级
    slideEl.querySelectorAll('[data-tabslide-rasterize]').forEach(function(el) {
        if (el === slideEl) return;
        candidates.push({ el: el, reason: 'explicit' });
    });

    // 隐式触发
    const all = slideEl.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el === slideEl) continue;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        // 不重复检测显式标记的元素
        if (el.hasAttribute && el.hasAttribute('data-tabslide-rasterize')) continue;

        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (!isVisible(el, cs, rect)) continue;

        let reason = null;
        const bdf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
        if (bdf && bdf !== 'none') reason = 'backdrop-filter';
        else if (cs.clipPath && cs.clipPath !== 'none') reason = 'clip-path';
        else if (cs.mask && cs.mask !== 'none' && cs.mask !== 'auto') reason = 'mask';
        else if (cs.webkitMaskImage && cs.webkitMaskImage !== 'none') reason = 'mask';
        else if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') reason = 'mix-blend-mode';
        else if (cs.filter && cs.filter !== 'none' && COMPLEX_FILTER_RE.test(cs.filter)) reason = 'filter';

        // 装饰 SVG 图标容器：直接子节点含 <svg>，且 svg 内有任意图形
        // （path/line/polyline/circle/rect/...）。旧条件要求 path 且 ≥2 子节点，
        // 导致 Lucide 式 circle+line 图标被拆成「渐变 shape + 全白 SVG PNG」方块。
        if (!reason && tag !== 'SVG' && tag !== 'svg' && !(el.closest && el.closest('svg'))) {
            const directKids = el.children || [];
            for (let j = 0; j < directKids.length; j++) {
                const k = directKids[j];
                if (k.tagName === 'svg' || k.tagName === 'SVG') {
                    const geom = k.querySelectorAll(
                        'path,line,polyline,polygon,circle,ellipse,rect'
                    );
                    if (geom.length >= 1) {
                        reason = 'svg-decorative';
                    }
                    break;
                }
            }
        }

        if (reason) candidates.push({ el: el, reason: reason });
    }

    if (candidates.length === 0) return [];

    // 去重嵌套：若 A 是 B 的祖先并且 A 也在候选集合中，则 B 被吸收
    const elSet = new Set(candidates.map(function(c) { return c.el; }));
    const filtered = [];
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        let p = c.el.parentElement;
        let absorbed = false;
        while (p && p !== slideEl) {
            if (elSet.has(p)) { absorbed = true; break; }
            p = p.parentElement;
        }
        if (!absorbed) filtered.push(c);
    }

    let kept = filtered;
    if (filtered.length > MAX_REGIONS) {
        console.warn('[TabSlide rasterize] regions exceeded limit ' + filtered.length + ' > ' + MAX_REGIONS + ', truncating');
        kept = filtered.slice(0, MAX_REGIONS);
    }

    const results = [];
    for (let i = 0; i < kept.length; i++) {
        const c = kept[i];
        const el = c.el;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;

        // 给 root 元素打标记；closest('[data-tabslide-rasterized]') 会在 root 本身和所有后代上 match
        el.setAttribute('data-tabslide-rasterized', '1');

        // 裁剪到 slide 边界内（防止 raster region 超出 slide 边界导致截图失败）
        const left = Math.max(rect.left, slideRect.left);
        const top = Math.max(rect.top, slideRect.top);
        const right = Math.min(rect.right, slideRect.right);
        const bottom = Math.min(rect.bottom, slideRect.bottom);
        const width = Math.max(0, right - left);
        const height = Math.max(0, bottom - top);
        if (width < 2 || height < 2) {
            el.removeAttribute('data-tabslide-rasterized');
            continue;
        }

        results.push({
            x: left - slideRect.left,
            y: top - slideRect.top,
            width: width,
            height: height,
            reason: c.reason,
        });
    }
    return results;
}"""


_CLEANUP_RASTERIZE_MARKS_JS = """(slideEl) => {
    let cleaned = 0;
    slideEl.querySelectorAll('[data-tabslide-rasterized]').forEach(function(el) {
        el.removeAttribute('data-tabslide-rasterized');
        cleaned++;
    });
    return cleaned;
}"""


# Phase-3 Wave-5：raster 区域内文字"双轨提取"——子 Agent 实测发现复合视觉块（KPI 卡片 /
# SWOT 象限等）整块栅格化后，内部所有文字都进了 image，Agent 无法 update 改文字。
#
# 双轨策略：
#   ① 截图前找出 raster 区域内的"普通纯色文字元素"（含直接文字、不含渐变/混合模式）
#      标记 + 临时 visibility:hidden
#   ② 截图（图里只剩装饰背景，无文字）
#   ③ 恢复 visibility（保留标记）
#   ④ walker / pure_dom 提取阶段：raster 子树本来 skip，但带 data-raster-extract 标记的元素允许提取
#   ⑤ 最终清理标记
#
# 不提取的"渐变文字"（gold-text / -webkit-background-clip:text / mix-blend-mode）继续留在 image 里——
# 提取后会失去渐变效果，跟视觉精度的 trade-off
_PREPARE_RASTER_TEXT_EXTRACT_JS = """(slideEl) => {
    let prepared = 0;

    function isExtractableText(el) {
        if (!el || el === slideEl) return false;
        if (el.closest && el.closest('svg')) return false;
        if (el.matches && el.matches('i[class*="fa-"], svg.svg-inline--fa')) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity) === 0) return false;
        // 必须含直接文字节点
        let hasDirectText = false;
        for (const n of el.childNodes) {
            if (n.nodeType === 3 && n.textContent.trim()) { hasDirectText = true; break; }
        }
        if (!hasDirectText) return false;
        // 排除 mix-blend-mode（视觉依赖跟下层混合，提取后会塌掉）
        if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return false;
        // 注：渐变文字（webkit-background-clip:text）也提取——KPI 卡片的 hero 数字
        // 几乎都是渐变（gold-text 等），Agent 最常想改的就是这些数字。
        // trade-off：提取后会塌成纯色，但比"无法编辑"好得多。
        return true;
    }

    const rasterRoots = slideEl.querySelectorAll('[data-tabslide-rasterized="1"]');
    rasterRoots.forEach(root => {
        // root 自身 + 全部后代
        const all = [root, ...root.querySelectorAll('*')];
        all.forEach(el => {
            if (!isExtractableText(el)) return;
            el.setAttribute('data-raster-extract', '1');
            // 保留原 style.visibility 以便后续恢复
            const orig = el.style.visibility || '';
            el.setAttribute('data-orig-visibility', orig);
            el.style.setProperty('visibility', 'hidden', 'important');
            prepared++;
        });
    });

    return prepared;
}"""


_RESTORE_HIDDEN_RASTER_TEXTS_JS = """(slideEl) => {
    let restored = 0;
    slideEl.querySelectorAll('[data-raster-extract="1"]').forEach(el => {
        const orig = el.getAttribute('data-orig-visibility') || '';
        if (orig) {
            el.style.visibility = orig;
        } else {
            el.style.removeProperty('visibility');
        }
        el.removeAttribute('data-orig-visibility');
        restored++;
    });
    return restored;
}"""


_CLEANUP_RASTER_EXTRACT_MARKS_JS = """(slideEl) => {
    let cleaned = 0;
    slideEl.querySelectorAll('[data-raster-extract]').forEach(el => {
        el.removeAttribute('data-raster-extract');
        cleaned++;
    });
    return cleaned;
}"""


_EXTRACT_TABLES_JS = """(slideEl, opts) => {
    const PT_PER_PX = 0.75;
    const tables = slideEl.querySelectorAll('table');
    if (!tables.length) return [];
    const slideRect = slideEl.getBoundingClientRect();
    const scaleX = opts.canvasWidth / slideRect.width;
    const scaleY = opts.canvasHeight / slideRect.height;
    const fontScale = Math.min(scaleX, scaleY);

    function rgbToHex(rgb) {
        if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return null;
        if (rgb.startsWith('#')) return rgb;
        const m = rgb.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
        if (!m) return null;
        return '#' + [m[1],m[2],m[3]].map(x => parseInt(x).toString(16).padStart(2,'0')).join('');
    }

    const results = [];
    tables.forEach((table, tIdx) => {
        // Phase-2 Wave-2 栅格化兜底：raster 区域内的 table 由整块截图接管
        if (table.closest && table.closest('[data-tabslide-rasterized]')) return;
        const tRect = table.getBoundingClientRect();
        if (tRect.width < 2 || tRect.height < 2) return;

        const rows = table.querySelectorAll('tr');
        if (!rows.length) return;

        const data = [];
        let maxCols = 0;
        let headerRowCount = 0;
        const theadRows = table.querySelectorAll('thead tr');
        headerRowCount = theadRows.length;

        rows.forEach((tr, rIdx) => {
            const cells = tr.querySelectorAll('th, td');
            const rowData = [];
            cells.forEach(cell => {
                const cs = getComputedStyle(cell);
                const cellBg = rgbToHex(cs.backgroundColor);
                const cellColor = rgbToHex(cs.color);
                const isHeader = cell.tagName === 'TH';
                var rawAlign = cs.textAlign;
                if (rawAlign === 'start') rawAlign = 'left';
                else if (rawAlign === 'end') rawAlign = 'right';
                rowData.push({
                    text: cell.textContent.trim(),
                    bold: isHeader || cs.fontWeight >= 600 || cs.fontWeight === 'bold',
                    color: cellColor || (isHeader ? '#ffffff' : '#1f2937'),
                    bgColor: cellBg,
                    fontSize: Math.round((parseFloat(cs.fontSize) || 16) * PT_PER_PX * fontScale * 100) / 100,
                    align: rawAlign,
                    colspan: parseInt(cell.getAttribute('colspan')) || 1,
                    rowspan: parseInt(cell.getAttribute('rowspan')) || 1,
                });
            });
            if (rowData.length > maxCols) maxCols = rowData.length;
            data.push(rowData);
        });

        // Compute column widths from first data row
        const colWidths = [];
        if (rows.length > 0) {
            const firstRowCells = rows[0].querySelectorAll('th, td');
            let totalW = 0;
            firstRowCells.forEach(c => { totalW += c.getBoundingClientRect().width; });
            firstRowCells.forEach(c => {
                colWidths.push(totalW > 0 ? c.getBoundingClientRect().width / totalW : 1 / firstRowCells.length);
            });
        }

        results.push({
            x: (tRect.left - slideRect.left) * scaleX,
            y: (tRect.top - slideRect.top) * scaleY,
            width: tRect.width * scaleX,
            height: tRect.height * scaleY,
            data: data,
            colWidths: colWidths,
            theme: { headerRow: headerRowCount > 0, stripedRows: table.classList.contains('slide-table') },
            outline: { color: '#e2e8f0', width: 0.5, style: 'solid' },
            borders: {
                insideH: { color: '#e2e8f0', width: 0.5 },
                insideV: { color: '#e2e8f0', width: 0.5 },
            },
        });
    });
    return results;
}"""


_EXTRACT_SHAPES_JS = """(slideEl, opts) => {
    const PT_PER_PX = 0.75;
    const PX_PER_IN = 96;
    const slideRect = slideEl.getBoundingClientRect();
    const scaleX = opts.canvasWidth / slideRect.width;
    const scaleY = opts.canvasHeight / slideRect.height;

    function rgbToHex(rgbStr) {
        if (!rgbStr || rgbStr === 'transparent' || rgbStr === 'rgba(0, 0, 0, 0)') return null;
        if (rgbStr.startsWith('#')) return rgbStr.length <= 4 ? rgbStr : ('#' + rgbStr.slice(1, 7)).toUpperCase();
        const m = rgbStr.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
        if (!m) return null;
        return '#' + [m[1], m[2], m[3]].map(x => parseInt(x, 10).toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function isTransparentBg(c) {
        return !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
    }

    // 填充色（保留 alpha）：rgba(255,255,255,0.08) 这类半透明卡片背景若丢掉 alpha 会变成
    // 不透明白（#FFFFFF），把暗底页上的白色文字盖成白底白字不可见。这里把 alpha<1 的转成
    // 8 位 #RRGGBBAA（SVG path fill 原生支持），保持半透明叠加效果。
    function rgbToFill(rgbStr) {
        if (isTransparentBg(rgbStr)) return null;
        if (rgbStr.startsWith('#')) return rgbStr.toUpperCase();
        var m = rgbStr.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?/);
        if (!m) return null;
        var hex = '#' + [m[1], m[2], m[3]].map(function(x){ return parseInt(x,10).toString(16).padStart(2,'0'); }).join('');
        if (m[4] != null && parseFloat(m[4]) < 1) {
            hex += Math.round(parseFloat(m[4]) * 255).toString(16).padStart(2, '0');
        }
        return hex.toUpperCase();
    }

    // Phase-2 Wave-1 渐变/URL 改造：把 background-image 解析成 PPTElement 友好结构
    function parseLinearGradient(cssGrad) {
        // 角度解析：支持 "linear-gradient(45deg, ...)" 和方向关键字 "to right" / "to bottom" 等
        var rotate = 180; // CSS 默认 "to bottom" = PPTX 180°（CSS 0deg = 向上，等价 PPTX 0°）
        var angleM = cssGrad.match(/linear-gradient\\(\\s*(-?[\\d.]+)deg/);
        if (angleM) {
            rotate = parseFloat(angleM[1]);
        } else {
            var dirM = cssGrad.match(/linear-gradient\\(\\s*to\\s+([a-z\\s]+?)[,\\s]/);
            if (dirM) {
                var dir = dirM[1].trim();
                var map = {
                    'top': 0, 'right': 90, 'bottom': 180, 'left': 270,
                    'top right': 45, 'bottom right': 135,
                    'bottom left': 225, 'top left': 315,
                };
                if (map[dir] != null) rotate = map[dir];
            }
        }
        // 提取颜色 stop（颜色 + 可选位置 %）
        // 匹配 "rgba(...)" 或 "#RRGGBB" 后跟可选空格 + 百分比
        var stops = [];
        var stopRe = /(rgba?\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+(?:\\s*,\\s*[\\d.]+)?\\s*\\)|#[0-9a-fA-F]{3,8})(?:\\s+(-?[\\d.]+)%)?/g;
        var m;
        while ((m = stopRe.exec(cssGrad)) !== null) {
            var color = m[1];
            // 保留 alpha：rgba 转为 #RRGGBBAA
            var hex = null;
            if (color.startsWith('#')) {
                hex = color.length <= 4 ? color.toUpperCase() : color.slice(0, 9).toUpperCase();
            } else {
                var rgbaM = color.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?/);
                if (rgbaM) {
                    var r = parseInt(rgbaM[1]).toString(16).padStart(2,'0');
                    var g = parseInt(rgbaM[2]).toString(16).padStart(2,'0');
                    var b = parseInt(rgbaM[3]).toString(16).padStart(2,'0');
                    hex = ('#' + r + g + b).toUpperCase();
                    if (rgbaM[4] != null) {
                        var a = Math.round(parseFloat(rgbaM[4]) * 255).toString(16).padStart(2,'0');
                        hex += a.toUpperCase();
                    }
                }
            }
            if (!hex) continue;
            var pos = m[2] != null ? parseFloat(m[2]) / 100 : null;
            stops.push({ color: hex, pos: pos });
        }
        if (stops.length < 2) return null;
        // 没显式位置的，按均匀分布插值
        var n = stops.length;
        for (var i = 0; i < n; i++) {
            if (stops[i].pos == null) stops[i].pos = i / (n - 1);
        }
        return {
            type: 'linear',
            rotate: rotate,
            colors: stops.map(function(s) { return { pos: Math.max(0, Math.min(1, s.pos)), color: s.color }; }),
        };
    }

    function parseUrlBackground(cssBgImage, cs) {
        var um = cssBgImage.match(/url\\(\\s*["']?([^"')]+)["']?\\s*\\)/);
        if (!um) return null;
        var src = um[1];
        var size = (cs.backgroundSize || 'auto').toLowerCase().trim();
        var mode = 'cover';
        if (size === 'contain') mode = 'contain';
        else if (size === 'cover') mode = 'cover';
        else if (size === 'auto' || size === 'auto auto') mode = 'auto';
        return { src: src, mode: mode };
    }

    function splitBoxShadowLayers(boxShadow) {
        // 按逗号拆多层 shadow，忽略 rgba(...) 内的逗号
        if (!boxShadow) return [];
        var layers = [];
        var buf = '';
        var depth = 0;
        for (var i = 0; i < boxShadow.length; i++) {
            var ch = boxShadow[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth = Math.max(0, depth - 1);
            if (ch === ',' && depth === 0) {
                if (buf.trim()) layers.push(buf.trim());
                buf = '';
                continue;
            }
            buf += ch;
        }
        if (buf.trim()) layers.push(buf.trim());
        return layers;
    }

    function parseBoxShadow(boxShadow) {
        // 外阴影 → PPTX outerShdw；inset 层留给 parseInsetOutlineAsBorder
        if (!boxShadow || boxShadow === 'none') return null;
        var layers = splitBoxShadowLayers(boxShadow);
        for (var li = 0; li < layers.length; li++) {
            var layer = layers[li];
            if (layer.indexOf('inset') !== -1) continue;
            const colorMatch = layer.match(/rgba?\\([^)]+\\)/);
            const parts = layer.match(/([-\\d.]+)(px|pt)/g);
            if (!parts || parts.length < 2) continue;
            const offsetX = parseFloat(parts[0]);
            const offsetY = parseFloat(parts[1]);
            const blur = parts.length > 2 ? parseFloat(parts[2]) : 0;
            let opacity = 0.5;
            if (colorMatch) {
                const opM = colorMatch[0].match(/,\\s*([\\d.]+)\\s*\\)\\s*$/);
                if (opM) opacity = parseFloat(opM[1]);
            }
            let color = '#000000';
            if (colorMatch) {
                const hx = rgbToHex(colorMatch[0]);
                if (hx) color = hx;
            }
            return { h: offsetX, v: offsetY, blur: blur, color: color, opacity: opacity };
        }
        return null;
    }

    function parseInsetOutlineAsBorder(boxShadow) {
        // 常见「假描边」：inset 0 0 0 1.5px rgba(...) → PPTX outline
        // OOXML 无 inset shadow，降级为均匀描边（与 border:1.5px solid 对齐）
        if (!boxShadow || boxShadow === 'none') return null;
        if (boxShadow.indexOf('inset') === -1) return null;
        var layers = splitBoxShadowLayers(boxShadow);
        for (var li = 0; li < layers.length; li++) {
            var layer = layers[li];
            if (layer.indexOf('inset') === -1) continue;
            var colorMatch = layer.match(/rgba?\\([^)]+\\)|#[0-9a-fA-F]{3,8}/);
            var parts = layer.match(/([-\\d.]+)(px|pt)/g);
            if (!parts || parts.length < 2) continue;
            var ox = parseFloat(parts[0]);
            var oy = parseFloat(parts[1]);
            var blur = parts.length > 2 ? parseFloat(parts[2]) : 0;
            var spread = parts.length > 3 ? parseFloat(parts[3]) : 0;
            if (Math.abs(ox) > 0.01 || Math.abs(oy) > 0.01) continue;
            var widthPx = 0;
            if (spread > 0) widthPx = spread;
            else if (blur > 0) widthPx = blur;
            if (widthPx <= 0) continue;
            // 用 rgbToFill 保留 alpha（ghost 按钮常为 rgba(...,0.22)）
            var color = '#000000';
            if (colorMatch) {
                var hx = rgbToFill(colorMatch[0]) || rgbToHex(colorMatch[0]);
                if (hx) color = hx;
            }
            return { color: color, width: widthPx * PT_PER_PX, style: 'solid' };
        }
        return null;
    }

    function borderWidthPx(cs) {
        const t = parseFloat(cs.borderTopWidth) || 0;
        const r = parseFloat(cs.borderRightWidth) || 0;
        const b = parseFloat(cs.borderBottomWidth) || 0;
        const l = parseFloat(cs.borderLeftWidth) || 0;
        return { t, r, b, l, max: Math.max(t, r, b, l), uniform: t === r && r === b && b === l };
    }

    function parseBorderRadiusPx(cs, rect) {
        const raw = cs.borderRadius || '0px';
        const first = raw.split(/\\s+/)[0] || '0px';
        const fv = parseFloat(first);
        if (Number.isNaN(fv) || fv <= 0) return 0;
        if (first.indexOf('%') !== -1) return (fv / 100) * Math.min(rect.width, rect.height);
        if (first.indexOf('pt') !== -1) return fv * (96 / 72);
        return fv;
    }

    function ancestorHasNonTransparentBg(el) {
        let p = el.parentElement;
        while (p && p !== slideEl) {
            const pcs = getComputedStyle(p);
            if (!isTransparentBg(pcs.backgroundColor)) return true;
            p = p.parentElement;
        }
        return false;
    }

    const results = [];
    // div + 常见「胶囊/按钮」宿主：span/a/button（.tt-badge / .tt-tag / ghost button）
    const candidates = slideEl.querySelectorAll('div, span, a, button');
    candidates.forEach((el) => {
        if (el === slideEl) return;
        if (el.classList && el.classList.contains('ppt-slide')) return;
        if (el.closest && el.closest('table')) return;
        // Phase-2 Wave-2 栅格化兜底：raster 区域（含自身和后代）由 page.screenshot 接管
        if (el.closest && el.closest('[data-tabslide-rasterized]')) return;

        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;

        // Phase-2 Wave-1 渐变/URL 改造：把 background-image 解析后继续走 shape 输出
        const bgImg = cs.backgroundImage;
        let gradientData = null;
        let bgImageData = null;
        let radialWarning = false;
        if (bgImg && bgImg !== 'none') {
            if (bgImg.indexOf('linear-gradient') !== -1) {
                gradientData = parseLinearGradient(bgImg);
            } else if (bgImg.indexOf('radial-gradient') !== -1) {
                radialWarning = true;
            }
            if (bgImg.indexOf('url(') !== -1) {
                bgImageData = parseUrlBackground(bgImg, cs);
            }
        }

        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;

        const bg = cs.backgroundColor;
        const hasBg = !isTransparentBg(bg);
        const bw = borderWidthPx(cs);
        const hasBorder = bw.max > 0;
        const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
        const brPx = parseBorderRadiusPx(cs, rect);
        const hasRadius = brPx > 0;
        const hasGradient = !!gradientData;
        const hasBgImage = !!bgImageData;
        const tag = (el.tagName || '').toLowerCase();
        const isDiv = tag === 'div';

        // 渐变 / url() / 半径 / 实色 / 边框 / 阴影 任一存在即认为是可见 shape
        if (!(hasBg || hasBorder || hasShadow || hasRadius || hasGradient || hasBgImage)) return;

        // 非 div：必须有真实装饰（底/边/影/渐变），避免纯文字 span 因继承圆角误出空框
        if (!isDiv && !(hasBg || hasBorder || hasShadow || hasGradient || hasBgImage)) return;

        if (ancestorHasNonTransparentBg(el) && !hasBg && !hasBorder && !hasShadow && !hasGradient && !hasBgImage) return;

        const parent = el.parentElement;
        if (parent && parent !== slideEl) {
            const pr = parent.getBoundingClientRect();
            const sameBox =
                Math.abs(rect.left - pr.left) < 1.5 &&
                Math.abs(rect.top - pr.top) < 1.5 &&
                Math.abs(rect.width - pr.width) < 2 &&
                Math.abs(rect.height - pr.height) < 2;
            const pcs = getComputedStyle(parent);
            if (sameBox && !isTransparentBg(pcs.backgroundColor) && !hasBg && !hasBorder && !hasShadow) return;
        }

        const x = (rect.left - slideRect.left) * scaleX;
        const y = (rect.top - slideRect.top) * scaleY;
        const w = rect.width * scaleX;
        const h = rect.height * scaleY;

        const fillHex = hasBg ? (rgbToFill(bg) || '#FFFFFF') : null;

        let line = null;
        let borderLines = [];
        if (hasBorder && bw.max > 0) {
            if (bw.uniform) {
                line = {
                    color: rgbToFill(cs.borderColor) || '#000000',
                    width: bw.max * PT_PER_PX,
                    style: 'solid',
                };
            } else {
                const tPx = parseFloat(cs.borderTopWidth) || 0;
                const rPx = parseFloat(cs.borderRightWidth) || 0;
                const bPx = parseFloat(cs.borderBottomWidth) || 0;
                const lPx = parseFloat(cs.borderLeftWidth) || 0;
                if (tPx > 0) {
                    const inset = (tPx / 2) * scaleY;
                    const yLine = y + inset;
                    borderLines.push({
                        x1: x, y1: yLine, x2: x + w, y2: yLine,
                        width: tPx * PT_PER_PX,
                        color: rgbToHex(cs.borderTopColor || cs.borderColor) || '#000000',
                    });
                }
                if (rPx > 0) {
                    const inset = (rPx / 2) * scaleX;
                    const xLine = x + w - inset;
                    borderLines.push({
                        x1: xLine, y1: y, x2: xLine, y2: y + h,
                        width: rPx * PT_PER_PX,
                        color: rgbToHex(cs.borderRightColor || cs.borderColor) || '#000000',
                    });
                }
                if (bPx > 0) {
                    const inset = (bPx / 2) * scaleY;
                    const yLine = y + h - inset;
                    borderLines.push({
                        x1: x, y1: yLine, x2: x + w, y2: yLine,
                        width: bPx * PT_PER_PX,
                        color: rgbToHex(cs.borderBottomColor || cs.borderColor) || '#000000',
                    });
                }
                if (lPx > 0) {
                    const inset = (lPx / 2) * scaleX;
                    const xLine = x + inset;
                    borderLines.push({
                        x1: xLine, y1: y, x2: xLine, y2: y + h,
                        width: lPx * PT_PER_PX,
                        color: rgbToHex(cs.borderLeftColor || cs.borderColor) || '#000000',
                    });
                }
            }
        }

        var shadow = parseBoxShadow(cs.boxShadow);
        if (shadow) {
            var sScale = Math.min(scaleX, scaleY);
            shadow.h = shadow.h * scaleX;
            shadow.v = shadow.v * scaleY;
            shadow.blur = shadow.blur * sScale;
        }

        // inset 假描边：无 CSS border 时补 outline（有真实 border 时以 border 为准）
        if (!line && (!borderLines || borderLines.length === 0)) {
            var insetLine = parseInsetOutlineAsBorder(cs.boxShadow);
            if (insetLine) line = insetLine;
        }

        // 元素整体透明度（装饰圆常用 opacity:0.4）；与 fill 的 #RRGGBBAA 分开，
        // Python 侧会避免双重乘。
        var elOpacity = parseFloat(cs.opacity);
        if (isNaN(elOpacity) || elOpacity > 1) elOpacity = 1;
        if (elOpacity < 0) elOpacity = 0;

        // 方案 A：装饰宿主（pill/badge/tag）合成 shape + 内嵌文字。
        // 短文案 + 有装饰 + 无嵌套装饰子节点 + 高度有限 → 走 shape.text（verticalAlign middle），
        // 避免「空 roundRect + walker 整行顶对齐字」叠歪。大卡片 / 空圆点不触发。
        // 不含 hasBgImage：Python 侧 url 背景会早退成 type=image 并丢掉 text；字改由 walker 承担。
        var hostTextPayload = null;
        var hostText = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (
            hostText
            && hostText.length <= 64
            && rect.height <= 80
            && !hasBgImage
            && (hasBg || hasBorder || hasShadow || hasGradient)
        ) {
            var nestedDecorated = false;
            var hostKids = Array.from(el.children || []);
            for (var hk = 0; hk < hostKids.length; hk++) {
                var hcs = getComputedStyle(hostKids[hk]);
                if (!isTransparentBg(hcs.backgroundColor)) { nestedDecorated = true; break; }
                if (hcs.boxShadow && hcs.boxShadow !== 'none') { nestedDecorated = true; break; }
                var hbi = hcs.backgroundImage || '';
                if (hbi && hbi !== 'none') { nestedDecorated = true; break; }
            }
            if (!nestedDecorated) {
                var fontSizePx = parseFloat(cs.fontSize) || 12;
                var fontScale = Math.min(scaleX, scaleY);
                var fontPt = Math.round(fontSizePx * PT_PER_PX * fontScale * 100) / 100;
                var colorHex = rgbToFill(cs.color) || rgbToHex(cs.color) || '#000000';
                var fontFamily = (cs.fontFamily || 'Inter').split(',')[0].replace(/['"]/g, '').trim();
                var tt = cs.textTransform || 'none';
                var displayText = hostText;
                if (tt === 'uppercase') displayText = hostText.toUpperCase();
                else if (tt === 'lowercase') displayText = hostText.toLowerCase();
                else if (tt === 'capitalize') {
                    displayText = hostText.replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
                }
                // shape.text 与普通文本框共用浏览器最终行数契约；否则 writer 无法区分
                // 单行 badge/pill 与真正需要换行的复合形状文本。
                var sourceLineCount = 1;
                try {
                    var hostRange = document.createRange();
                    hostRange.selectNodeContents(el);
                    var hostLineTops = [];
                    Array.from(hostRange.getClientRects()).forEach(function(lineRect) {
                        if (lineRect.width <= 0 || lineRect.height <= 0) return;
                        var top = lineRect.top;
                        if (!hostLineTops.some(function(existingTop) { return Math.abs(existingTop - top) <= 1; })) {
                            hostLineTops.push(top);
                        }
                    });
                    sourceLineCount = Math.max(1, hostLineTops.length);
                } catch (_) {}
                var align = 'center';
                var ta = cs.textAlign || '';
                if (ta === 'left' || ta === 'start') align = 'left';
                else if (ta === 'right' || ta === 'end') align = 'right';
                else if (ta === 'justify') align = 'justify';
                // inline-flex / flex 胶囊常见靠 align-items 居中，text-align 仍是 start
                if (
                    (cs.display === 'inline-flex' || cs.display === 'flex')
                    && (String(cs.justifyContent || '').indexOf('center') !== -1
                        || String(cs.alignItems || '').indexOf('center') !== -1)
                ) {
                    align = 'center';
                }
                var esc = String(displayText)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                hostTextPayload = {
                    content: (
                        '<p style="text-align:' + align + '">'
                        + '<span style="font-size:' + fontPt + 'pt;color:' + colorHex + '">'
                        + esc + '</span></p>'
                    ),
                    defaultFontSize: fontPt,
                    defaultColor: colorHex,
                    defaultFontName: fontFamily,
                    defaultFontFamily: cs.fontFamily || fontFamily,
                    sourceLineCount: sourceLineCount,
                    wordWrap: sourceLineCount !== 1,
                    align: align,
                    verticalAlign: 'middle',
                    margin: { top: 0, right: 0, bottom: 0, left: 0 },
                };
            }
        }

        results.push({
            x: x,
            y: y,
            width: w,
            height: h,
            fill: fillHex,
            fillCss: hasBg ? bg : null,
            borderRadiusPx: brPx * Math.min(scaleX, scaleY),
            line: line,
            borderLines: borderLines,
            shadow: shadow,
            opacity: elOpacity,
            // Phase-2 Wave-1 渐变/URL 改造：透传给后处理
            gradient: gradientData,
            bgImage: bgImageData,
            radialWarning: radialWarning,
            text: hostTextPayload,
        });
    });
    return results;
}"""


_FIX_ICON_TEXT_JS = """(slideEl) => {
    const icons = slideEl.querySelectorAll('i[class*="fa-"], span[class*="fa-"], svg.svg-inline--fa');
    let fixes = 0;
    icons.forEach(icon => {
        icon.style.display = 'none';
        fixes++;
    });
    const badges = slideEl.querySelectorAll('.slide-badge, [class*="badge"]');
    badges.forEach(badge => {
        badge.childNodes.forEach(node => {
            if (node.nodeType === 3) {
                const text = node.textContent.trim();
                if (text) {
                    const span = document.createElement('span');
                    span.textContent = text;
                    span.style.cssText = 'font-family:inherit;font-size:inherit;color:inherit;';
                    node.parentNode.replaceChild(span, node);
                    fixes++;
                }
            }
        });
    });
    return fixes;
}"""


_EXTRACT_TEXT_LAYOUT_JS = """(slideEl, opts) => {
    const slideRect = slideEl.getBoundingClientRect();
    const scaleX = opts.canvasWidth / slideRect.width;
    const scaleY = opts.canvasHeight / slideRect.height;
    const fontScale = Math.min(scaleX, scaleY);
    const BLOCK_DISPLAYS = new Set(['block','flex','grid','table','list-item','flow-root']);

    // 保留 alpha：rgba(...,0.48) → #RRGGBBAA，供 pptx_io 写 a:alpha
    function rgbToHex(rgbStr) {
        if (!rgbStr || rgbStr === 'transparent' || rgbStr === 'rgba(0, 0, 0, 0)') return null;
        if (rgbStr.startsWith('#')) {
            var h = rgbStr.slice(1);
            if (h.length === 3 || h.length === 4) {
                var exp = '#' + h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
                if (h.length === 4 && (h[3]+h[3]).toLowerCase() !== 'ff') exp += (h[3]+h[3]);
                return exp.toUpperCase();
            }
            if (h.length === 8) {
                var base8 = ('#' + h.slice(0, 6)).toUpperCase();
                var aa8 = h.slice(6, 8).toUpperCase();
                return aa8 === 'FF' ? base8 : base8 + aa8;
            }
            return ('#' + h.slice(0, 6)).toUpperCase();
        }
        const m = rgbStr.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?/);
        if (!m) return null;
        var hex = '#' + [m[1],m[2],m[3]].map(function(x) { return parseInt(x,10).toString(16).padStart(2,'0'); }).join('').toUpperCase();
        if (m[4] != null && parseFloat(m[4]) < 1) {
            hex += Math.round(Math.max(0, Math.min(1, parseFloat(m[4]))) * 255).toString(16).padStart(2,'0').toUpperCase();
        }
        return hex;
    }

    function numericFontWeight(fw) {
        if (fw === 'bold' || fw === 'bolder') return 700;
        const n = parseInt(fw, 10);
        return (typeof n === 'number' && !isNaN(n)) ? n : 400;
    }

    function isBoldWeight(fw) {
        return fw === 'bold' || numericFontWeight(fw) >= 600;
    }

    function applyTextTransform(text, tt) {
        if (!tt || tt === 'none') return text;
        if (tt === 'uppercase') return text.toUpperCase();
        if (tt === 'lowercase') return text.toLowerCase();
        if (tt === 'capitalize') return text.replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
        return text;
    }

    function parseLetterSpacingPx(cs, fontSizePx) {
        var ls = cs.letterSpacing;
        if (!ls || ls === 'normal') return null;
        var v;
        if (String(ls).indexOf('em') !== -1) v = parseFloat(ls) * fontSizePx;
        else v = parseFloat(ls);
        return (typeof v === 'number' && !isNaN(v)) ? v : null;
    }

    var SINGLE_WEIGHT_FONTS = ['impact'];
    function shouldSkipBold(fontFamily) {
        if (!fontFamily) return false;
        var normalized = fontFamily.toLowerCase().replace(/['"]/g, '').split(',')[0].trim();
        return SINGLE_WEIGHT_FONTS.indexOf(normalized) !== -1;
    }

    function collectInlineMarginWarnings(scopeEl) {
        var warnings = [];
        scopeEl.querySelectorAll('span, b, strong, i, em, u, a').forEach(function(node) {
            var cs = window.getComputedStyle(node);
            ['Left','Right','Top','Bottom'].forEach(function(side) {
                var mv = parseFloat(cs['margin' + side]);
                if (mv > 0) {
                    warnings.push('Inline element <' + node.tagName.toLowerCase() + '> has margin' + side + ' which is not supported in PowerPoint. Remove margin from inline elements.');
                }
            });
        });
        return warnings;
    }

    function parseInlineFormatting(element, baseOptions, runs, baseTextTransform) {
        var prevNodeIsText = false;
        var nodes = element.childNodes;
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var textTransform = baseTextTransform;
            var isText = node.nodeType === 3 || (node.nodeType === 1 && node.tagName === 'BR');
            if (isText) {
                var raw = (node.nodeType === 1 && node.tagName === 'BR') ? '\\n' : String(node.textContent || '').replace(/\\s+/g, ' ');
                var text = baseTextTransform(raw);
                var prevRun = runs[runs.length - 1];
                if (prevNodeIsText && prevRun) {
                    prevRun.text += text;
                } else {
                    runs.push({
                        text: text,
                        bold: !!baseOptions.bold,
                        italic: !!baseOptions.italic,
                        underline: !!baseOptions.underline,
                        color: baseOptions.color != null ? baseOptions.color : null,
                        fontSize: baseOptions.fontSize != null ? baseOptions.fontSize : null
                    });
                }
            } else if (node.nodeType === 1 && node.textContent && String(node.textContent).trim()) {
                var tag = node.tagName;
                if (tag === 'SPAN' || tag === 'B' || tag === 'STRONG' || tag === 'I' || tag === 'EM' || tag === 'U') {
                    var opt = {
                        bold: !!baseOptions.bold,
                        italic: !!baseOptions.italic,
                        underline: !!baseOptions.underline,
                        color: baseOptions.color != null ? baseOptions.color : null,
                        fontSize: baseOptions.fontSize != null ? baseOptions.fontSize : null
                    };
                    var computed = window.getComputedStyle(node);
                    if (isBoldWeight(computed.fontWeight) && !shouldSkipBold(computed.fontFamily)) opt.bold = true;
                    if (computed.fontStyle === 'italic') opt.italic = true;
                    if (computed.textDecoration && computed.textDecoration.indexOf('underline') !== -1) opt.underline = true;
                    // Phase-3 Wave-5 渐变文字 fallback：webkit-background-clip:text 的渐变文字，
                    // computed.color 是继承父链的默认色（#1F2937），但 text-fill-color 是 transparent。
                    // 改用渐变 background-image 首色作为 run.color，避免 KPI 数字塌成深灰。
                    var fillCol = computed.webkitTextFillColor || computed.textFillColor || '';
                    var bgClip = computed.webkitBackgroundClip || computed.backgroundClip || '';
                    var isGradText = (
                        (fillCol === 'transparent' || fillCol === 'rgba(0, 0, 0, 0)')
                        && bgClip.indexOf('text') !== -1
                    );
                    if (isGradText) {
                        var bgImg = computed.backgroundImage || '';
                        var gm = bgImg.match(/rgba?\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+(?:\\s*,\\s*[\\d.]+)?\\s*\\)|#[0-9a-fA-F]{3,8}/);
                        if (gm) {
                            opt.color = rgbToHex(gm[0]) || gm[0];
                        }
                    } else if (computed.color && computed.color !== 'rgb(0, 0, 0)') {
                        var hx = rgbToHex(computed.color);
                        if (hx) opt.color = hx;
                    }
                    if (computed.fontSize) opt.fontSize = Math.round(parseFloat(computed.fontSize) * fontScale * 100) / 100;
                    if (computed.textTransform && computed.textTransform !== 'none') {
                        var transformStr = computed.textTransform;
                        textTransform = function(t) {
                            return applyTextTransform(baseTextTransform(t), transformStr);
                        };
                    }
                    parseInlineFormatting(node, opt, runs, textTransform);
                } else {
                    parseInlineFormatting(node, baseOptions, runs, baseTextTransform);
                }
            }
            prevNodeIsText = isText;
        }
        if (runs.length > 0) {
            runs[0].text = runs[0].text.replace(/^\\s+/, '');
            runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\\s+$/, '');
        }
        return runs.filter(function(r) { return r.text && r.text.length > 0; });
    }

    function findBlockAncestor(el) {
        let cur = el.parentElement;
        while (cur && cur !== slideEl) {
            const d = getComputedStyle(cur).display;
            if (BLOCK_DISPLAYS.has(d)) return cur;
            cur = cur.parentElement;
        }
        return slideEl;
    }

    const results = [];
    const textEls = slideEl.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div,li,td,th,label,a,pre,code,blockquote');
    textEls.forEach(function(el) {
        // Phase-2 Wave-2 栅格化兜底：raster 区域内文字由整块截图接管
        // Phase-3 Wave-5 双轨提取：raster 内带 data-raster-extract 的"普通纯色文字"允许提取
        // querySelectorAll 已经把每个元素拿出来了，不存在"递归被吞"问题，这里直接放行/拒绝
        const _rRoot = el.closest && el.closest('[data-tabslide-rasterized]');
        const _rExtract = el.closest && el.closest('[data-raster-extract]');
        if (_rRoot && !_rExtract) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;

        const textAlign = cs.textAlign === 'start' ? 'left' : cs.textAlign === 'end' ? 'right' : cs.textAlign;
        const container = findBlockAncestor(el);
        const cRect = container.getBoundingClientRect();

        const fontWeight = numericFontWeight(cs.fontWeight);
        const fontStyle = cs.fontStyle || 'normal';
        const textDecoration = cs.textDecoration || 'none';
        const textTransform = cs.textTransform || 'none';
        const fontSizePx = parseFloat(cs.fontSize) || 0;
        var colorHex = rgbToHex(cs.color) || '#000000';
        // Phase-3 Wave-5 渐变文字 fallback：检测 root 是否是 webkit-background-clip:text 渐变容器
        // 或祖先链上有这种容器，命中就把 colorHex 改成渐变 background-image 首色
        function detectGradientColor(node) {
            var n = node;
            while (n && n !== slideEl && n.nodeType === 1) {
                var ncs = window.getComputedStyle(n);
                var fillCol = ncs.webkitTextFillColor || ncs.textFillColor || '';
                var bgClip = ncs.webkitBackgroundClip || ncs.backgroundClip || '';
                if ((fillCol === 'transparent' || fillCol === 'rgba(0, 0, 0, 0)') && bgClip.indexOf('text') !== -1) {
                    var bgImg = ncs.backgroundImage || '';
                    var gm = bgImg.match(/rgba?\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+(?:\\s*,\\s*[\\d.]+)?\\s*\\)|#[0-9a-fA-F]{3,8}/);
                    if (gm) return rgbToHex(gm[0]) || gm[0];
                }
                n = n.parentElement;
            }
            return null;
        }
        var gradColor = detectGradientColor(el);
        if (gradColor) colorHex = gradColor;
        const fontFamily = cs.fontFamily || '';

        const rootOpts = {
            bold: isBoldWeight(cs.fontWeight) && !shouldSkipBold(cs.fontFamily),
            italic: fontStyle === 'italic',
            underline: textDecoration.indexOf('underline') !== -1,
            color: colorHex,
            fontSize: fontSizePx ? Math.round(fontSizePx * fontScale * 100) / 100 : null
        };
        const ttRoot = (textTransform && textTransform !== 'none')
            ? function(s) { return applyTextTransform(s, textTransform); }
            : function(s) { return s; };

        var runs = [];
        var hasInline = el.querySelector && el.querySelector('b, i, u, strong, em, span, br');
        if (hasInline) {
            runs = parseInlineFormatting(el, rootOpts, [], ttRoot);
        }
        if (!runs || runs.length === 0) {
            var plain = ttRoot(String(el.textContent || '').replace(/\\s+/g, ' ').trim());
            if (plain) {
                runs = [{
                    text: plain,
                    bold: !!rootOpts.bold,
                    italic: !!rootOpts.italic,
                    underline: !!rootOpts.underline,
                    color: rootOpts.color,
                    fontSize: rootOpts.fontSize
                }];
            }
        }

        var inlineLayoutWarnings = collectInlineMarginWarnings(el);
        var letterSpacingPx = parseLetterSpacingPx(cs, fontSizePx);
        if (letterSpacingPx != null) {
            letterSpacingPx = Math.round(letterSpacingPx * fontScale * 1000) / 1000;
        }
        var elOpacity = parseFloat(cs.opacity);
        if (isNaN(elOpacity) || elOpacity > 1) elOpacity = 1;
        if (elOpacity < 0) elOpacity = 0;
        if (colorHex.length === 9 && elOpacity < 1) {
            var aaL = parseInt(colorHex.slice(7, 9), 16) / 255 * elOpacity;
            colorHex = colorHex.slice(0, 7) + Math.round(Math.max(0, Math.min(1, aaL)) * 255).toString(16).padStart(2, '0').toUpperCase();
            elOpacity = 1;
        } else if (colorHex.length === 9) {
            elOpacity = 1;
        }

        var row = {
            x: Math.round((r.left - slideRect.left) * scaleX),
            y: Math.round((r.top - slideRect.top) * scaleY),
            width: Math.round(r.width * scaleX),
            height: Math.round(r.height * scaleY),
            textAlign: textAlign,
            containerX: Math.round((cRect.left - slideRect.left) * scaleX),
            containerWidth: Math.round(cRect.width * scaleX),
            fontWeight: fontWeight,
            fontStyle: fontStyle,
            textDecoration: textDecoration,
            textTransform: textTransform,
            fontSize: fontSizePx ? Math.round(fontSizePx * fontScale * 100) / 100 : fontSizePx,
            color: colorHex,
            fontFamily: fontFamily,
            letterSpacing: letterSpacingPx,
            opacity: elOpacity,
            runs: runs
        };
        if (inlineLayoutWarnings.length > 0) {
            row.inlineLayoutWarnings = inlineLayoutWarnings;
        }
        results.push(row);
    });
    return results;
}"""


# Playwright 内联 JS 共享：文字真实包围盒（Range），供 _PURE_DOM / _WALKER 文本提取复用。
_JS_TEXT_BOX_RECT = """
    // 文本的“墨迹框”和“排版框”不是同一个概念：Range bbox 只覆盖已经画出的字，
    // 若把它直接作为 PPT 文本框宽度，任何字体替换都会触发二次换行。这里仍用 Range
    // 定位文字并排除空装饰节点，但沿文本流方向扩展到父容器内、相邻兄弟之间的可用区域。
    // 这样 flex 圆点不会被文字覆盖，同时 PPT 拥有与浏览器相同的排版余量。
    function textBoxRect(el, fallback) {
        try {
            var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
            var n;
            var union = null;
            var lineBands = [];
            while ((n = walker.nextNode())) {
                if (!(n.textContent || '').trim()) continue;
                var rng = document.createRange();
                rng.selectNodeContents(n);
                var rects = Array.from(rng.getClientRects ? rng.getClientRects() : []);
                if (rects.length === 0) rects = [rng.getBoundingClientRect()];
                for (var ri = 0; ri < rects.length; ri++) {
                    var rb = rects[ri];
                    if (!rb || (rb.width <= 0 && rb.height <= 0)) continue;
                    if (!union) {
                        union = { left: rb.left, top: rb.top, right: rb.right, bottom: rb.bottom };
                    } else {
                        union.left = Math.min(union.left, rb.left);
                        union.top = Math.min(union.top, rb.top);
                        union.right = Math.max(union.right, rb.right);
                        union.bottom = Math.max(union.bottom, rb.bottom);
                    }
                    var band = lineBands.find(function(item) {
                        return rb.top < item.bottom && rb.bottom > item.top;
                    });
                    if (band) {
                        band.top = Math.min(band.top, rb.top);
                        band.bottom = Math.max(band.bottom, rb.bottom);
                    } else {
                        lineBands.push({ top: rb.top, bottom: rb.bottom });
                    }
                }
            }
            if (union) {
                var cs = window.getComputedStyle(el);
                var align = cs.textAlign === 'start' ? 'left' : cs.textAlign === 'end' ? 'right' : cs.textAlign;
                var leftBound = fallback.left;
                var rightBound = fallback.right;
                // auto-width 文本节点（温度、标签等）从父级获得真实可用宽度；显式宽度元素
                // 的 fallback 自身已经是正确排版框。父级 padding 和相邻兄弟共同限定边界。
                if (fallback.width <= (union.right - union.left) + 1 && el.parentElement) {
                    var parent = el.parentElement;
                    var pr = parent.getBoundingClientRect();
                    var pcs = window.getComputedStyle(parent);
                    leftBound = pr.left + (parseFloat(pcs.paddingLeft) || 0);
                    rightBound = pr.right - (parseFloat(pcs.paddingRight) || 0);
                    Array.from(parent.children || []).forEach(function(sibling) {
                        if (sibling === el) return;
                        var sr = sibling.getBoundingClientRect();
                        if (!sr || sr.width <= 0 || sr.height <= 0) return;
                        if (sr.right <= union.left + 1) leftBound = Math.max(leftBound, sr.right);
                        if (sr.left >= union.right - 1) rightBound = Math.min(rightBound, sr.left);
                    });
                }
                // el 自身含空圆点/图标时也把这些装饰当作边界，避免整容器 walker 压住它们。
                Array.from(el.children || []).forEach(function(child) {
                    if ((child.textContent || '').trim()) return;
                    var cr = child.getBoundingClientRect();
                    if (!cr || cr.width <= 0 || cr.height <= 0) return;
                    if (cr.right <= union.left + 1) leftBound = Math.max(leftBound, cr.right);
                    if (cr.left >= union.right - 1) rightBound = Math.min(rightBound, cr.left);
                });

                leftBound = Math.min(leftBound, union.left);
                rightBound = Math.max(rightBound, union.right);
                var flowLeft = union.left;
                var flowRight = union.right;
                if (align === 'right') {
                    flowLeft = leftBound;
                } else if (align === 'center') {
                    var center = (union.left + union.right) / 2;
                    var half = Math.max(
                        (union.right - union.left) / 2,
                        Math.min(center - leftBound, rightBound - center)
                    );
                    flowLeft = center - half;
                    flowRight = center + half;
                } else if (align === 'justify') {
                    flowLeft = leftBound;
                    flowRight = rightBound;
                } else {
                    flowRight = rightBound;
                }
                return {
                    x: flowLeft,
                    y: union.top,
                    left: flowLeft,
                    top: union.top,
                    right: flowRight,
                    bottom: union.bottom,
                    width: flowRight - flowLeft,
                    height: union.bottom - union.top,
                    inkLeft: union.left,
                    inkRight: union.right,
                    sourceLineCount: Math.max(1, lineBands.length),
                };
            }
            // 无可见文字节点时回退整容器（兼容纯装饰 / 空节点）
            var rngAll = document.createRange();
            rngAll.selectNodeContents(el);
            var rbAll = rngAll.getBoundingClientRect();
            if (rbAll && rbAll.width > 0 && rbAll.height > 0) return rbAll;
        } catch (e) {}
        return fallback;
    }
"""


_PURE_DOM_EXTRACT_SLIDE_JS = """(slideEl, opts) => {
    const PT_PER_PX = 0.75;
    const slideRect = slideEl.getBoundingClientRect();
    const scaleX = opts.canvasWidth / slideRect.width;
    const scaleY = opts.canvasHeight / slideRect.height;
    const out = [];

    function rgbToHex(rgbStr) {
        if (!rgbStr || rgbStr === 'transparent' || rgbStr === 'rgba(0, 0, 0, 0)') return null;
        if (rgbStr.startsWith('#')) {
            var h = rgbStr.slice(1);
            if (h.length === 3 || h.length === 4) {
                var exp = '#' + h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
                if (h.length === 4 && (h[3]+h[3]).toLowerCase() !== 'ff') exp += (h[3]+h[3]);
                return exp.toUpperCase();
            }
            if (h.length === 8) {
                var base8 = ('#' + h.slice(0, 6)).toUpperCase();
                var aa8 = h.slice(6, 8).toUpperCase();
                return aa8 === 'FF' ? base8 : base8 + aa8;
            }
            return ('#' + h.slice(0, 6)).toUpperCase();
        }
        const m = rgbStr.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?/);
        if (!m) return null;
        var hex = '#' + [m[1], m[2], m[3]].map(function(x) { return parseInt(x, 10).toString(16).padStart(2, '0'); }).join('').toUpperCase();
        if (m[4] != null && parseFloat(m[4]) < 1) {
            hex += Math.round(Math.max(0, Math.min(1, parseFloat(m[4]))) * 255).toString(16).padStart(2,'0').toUpperCase();
        }
        return hex;
    }

    function applyTextTransform(text, tt) {
        if (!tt || tt === 'none') return text;
        if (tt === 'uppercase') return text.toUpperCase();
        if (tt === 'lowercase') return text.toLowerCase();
        if (tt === 'capitalize') return text.replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
        return text;
    }

    function collapseTextNodeWhitespace(root) {
        if (!root) return;
        var nodes = [];
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = walker.nextNode())) nodes.push(n);
        for (var i = 0; i < nodes.length; i++) {
            var p = nodes[i].parentElement;
            if (p && (p.tagName === 'PRE' || p.closest && p.closest('pre'))) continue;
            nodes[i].textContent = String(nodes[i].textContent || '').replace(/[ \\t\\f\\v]+/g, ' ').replace(/\\n+/g, ' ');
        }
    }

    function inTable(el) {
        return el.closest && el.closest('table');
    }
""" + _JS_TEXT_BOX_RECT + """
    function normalizeTextAlign(cs) {
        const ta = cs.textAlign || 'left';
        if (ta === 'start') return 'left';
        if (ta === 'end') return 'right';
        return ta;
    }

    /** 与 html2pptx 一致：块级文本框用 getBoundingClientRect 相对 slide；居中来自 text-align 或 flex 父级 */
    function outerHtmlWithTextAlign(el, textAlignCss) {
        const prev = el.getAttribute('style');
        const clone = el.cloneNode(true);
        try {
            collapseTextNodeWhitespace(clone);
            if (textAlignCss && textAlignCss !== 'left') {
                const existing = clone.getAttribute('style') || '';
                if (!/text-align\\s*:/i.test(existing)) {
                    const base = existing.trim();
                    const merged = (base ? base.replace(/;?\\s*$/, '') + '; ' : '') + 'text-align: ' + textAlignCss + ';';
                    clone.setAttribute('style', merged);
                }
            }
            var raw = clone.outerHTML;
            if (/^<h[1-6]\\b/i.test(raw)) {
                raw = raw.replace(/^<h[1-6]\\b/i, '<p').replace(/<\\/h[1-6]>$/i, '</p>');
            }
            return raw;
        } finally {
            void prev;
        }
    }

    const nodes = slideEl.querySelectorAll('*');
    for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (el === slideEl) continue;
        if (el.classList && el.classList.contains('ppt-slide')) continue;
        // Phase-2 Wave-2 栅格化兜底：raster 区域整块截图，跳过内部一切
        // Phase-3 Wave-5 双轨提取：raster 内带 data-raster-extract 标记的文字也允许提取
        const _rRoot = el.closest && el.closest('[data-tabslide-rasterized]');
        const _rExtract = el.closest && el.closest('[data-raster-extract]');
        if (_rRoot && !_rExtract) continue;

        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        const tag = el.tagName;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;

        if (tag === 'IMG') {
            out.push({
                type: 'image',
                x: Math.round((r.left - slideRect.left) * scaleX),
                y: Math.round((r.top - slideRect.top) * scaleY),
                width: Math.round(r.width * scaleX),
                height: Math.round(r.height * scaleY),
                src: el.src || '',
                rotate: 0,
                opacity: 1,
                locked: false,
                visible: true,
                flipH: false,
                flipV: false,
                fixedRatio: true
            });
            continue;
        }

        if (tag === 'svg' || tag === 'SVG') {
            try {
                var serializer = new XMLSerializer();
                var svgStr = serializer.serializeToString(el);
                var dataUri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
                out.push({
                    type: 'image',
                    x: Math.round((r.left - slideRect.left) * scaleX),
                    y: Math.round((r.top - slideRect.top) * scaleY),
                    width: Math.round(r.width * scaleX),
                    height: Math.round(r.height * scaleY),
                    src: dataUri,
                    rotate: 0,
                    opacity: 1,
                    locked: false,
                    visible: true,
                    flipH: false,
                    flipV: false,
                    fixedRatio: true
                });
            } catch(e) {}
            continue;
        }

        if (el.closest && el.closest('svg')) continue;

        const textTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
        if (textTags.indexOf(tag) !== -1) {
            if (inTable(el)) continue;
            const text = (el.textContent || '').trim();
            if (!text) continue;
            const fontSizePx = parseFloat(cs.fontSize) || 16;
            var colorHex = rgbToHex(cs.color) || '#000000';
            const fontFamily = (cs.fontFamily || 'Inter').split(',')[0].replace(/['"]/g, '').trim();
            const textAlignNorm = normalizeTextAlign(cs);
            const textTransform = cs.textTransform || 'none';
            var content = outerHtmlWithTextAlign(el, textAlignNorm);
            // PPT 不认 CSS text-transform：预应用到文本节点
            if (textTransform && textTransform !== 'none') {
                content = content.replace(/>([^<]+)</g, function(_m, t) {
                    return '>' + applyTextTransform(t, textTransform) + '<';
                });
            }
            const fontScale = Math.min(scaleX, scaleY);
            // 几何用文字真实包围盒；margin=0（盒子已紧贴文字，无需内边距）。
            const tb = textBoxRect(el, r);
            var elOpacity = parseFloat(cs.opacity);
            if (isNaN(elOpacity) || elOpacity > 1) elOpacity = 1;
            if (elOpacity < 0) elOpacity = 0;
            // rgba 字色 × 元素 opacity 只乘一次写入 AA
            if (colorHex.length === 9 && elOpacity < 1) {
                var aaT = parseInt(colorHex.slice(7, 9), 16) / 255 * elOpacity;
                colorHex = colorHex.slice(0, 7) + Math.round(Math.max(0, Math.min(1, aaT)) * 255).toString(16).padStart(2, '0').toUpperCase();
                elOpacity = 1;
            } else if (colorHex.length === 9) {
                elOpacity = 1;
            }
            const row = {
                type: 'text',
                x: Math.round((tb.left - slideRect.left) * scaleX),
                y: Math.round((tb.top - slideRect.top) * scaleY),
                width: Math.round(tb.width * scaleX),
                height: Math.round(tb.height * scaleY),
                content: content,
                defaultFontName: fontFamily,
                fontFamilyFallbacks: cs.fontFamily || fontFamily,
                defaultColor: colorHex,
                defaultFontSize: Math.round(fontSizePx * PT_PER_PX * fontScale * 100) / 100,
                sourceLineCount: tb.sourceLineCount || 1,
                wordWrap: (tb.sourceLineCount || 1) !== 1,
                flowX: Math.round((tb.left - slideRect.left) * scaleX),
                flowWidth: Math.round(tb.width * scaleX),
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                rotate: 0,
                opacity: elOpacity,
                locked: false,
                visible: true,
                flipH: false,
                flipV: false
            };
            // 只读真实 text-align（不从 flex 推断）；垂直对齐不再推断，由几何位置决定。
            if (textAlignNorm === 'justify') {
                row.defaultTextAlign = 'justify';
            } else if (textAlignNorm === 'right') {
                row.defaultTextAlign = 'right';
            } else if (textAlignNorm === 'center') {
                row.defaultTextAlign = 'center';
            }
            var lhPx = parseFloat(cs.lineHeight);
            if (!isNaN(lhPx) && fontSizePx > 0) {
                row.lineHeight = Math.round((lhPx / fontSizePx) * 100) / 100;
            }
            var lsRaw = cs.letterSpacing;
            if (lsRaw && lsRaw !== 'normal') {
                var lsPx = (String(lsRaw).indexOf('em') !== -1)
                    ? parseFloat(lsRaw) * fontSizePx
                    : parseFloat(lsRaw);
                if (!isNaN(lsPx)) {
                    row.wordSpace = Math.round(lsPx * fontScale * 1000) / 1000;
                }
            }
            out.push(row);
            continue;
        }
    }
    return out;
}"""


# Phase-2 Wave-1 walker 改造：识别 div/span/li 等容器中的文字
# 与 _PURE_DOM_EXTRACT_SLIDE_JS 的 P/H1-6 识别并存，后处理通过位置+文本前缀去重
_WALKER_TEXT_EXTRACT_JS = """(slideEl, opts) => {
    const PT_PER_PX = 0.75;
    const slideRect = slideEl.getBoundingClientRect();
    const scaleX = opts.canvasWidth / slideRect.width;
    const scaleY = opts.canvasHeight / slideRect.height;
    const fontScale = Math.min(scaleX, scaleY);
    const out = [];
    const seen = new Set();

    // 这些 tag 不进入 walker（让 _PURE_DOM_EXTRACT_SLIDE_JS 处理或属于装饰/纯视觉）
    const SKIP_TAGS = new Set(['SCRIPT','STYLE','SVG','CANVAS','IMG','BR','HR','TABLE','THEAD','TBODY','TR','TD','TH','P','H1','H2','H3','H4','H5','H6']);
    // 这些 inline tag 不会触发"叶子文本"识别（它们应该被父容器吸收）
    const INLINE_TAGS = new Set(['SPAN','B','STRONG','I','EM','U','A','SMALL','SUB','SUP','MARK','CODE','KBD','TIME','BR']);

    function rgbToHex(rgbStr) {
        if (!rgbStr || rgbStr === 'transparent' || rgbStr === 'rgba(0, 0, 0, 0)') return null;
        if (rgbStr.startsWith('#')) {
            var h = rgbStr.slice(1);
            if (h.length === 3 || h.length === 4) {
                var exp = '#' + h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
                if (h.length === 4 && (h[3]+h[3]).toLowerCase() !== 'ff') exp += (h[3]+h[3]);
                return exp.toUpperCase();
            }
            if (h.length === 8) {
                var base8 = ('#' + h.slice(0, 6)).toUpperCase();
                var aa8 = h.slice(6, 8).toUpperCase();
                return aa8 === 'FF' ? base8 : base8 + aa8;
            }
            return ('#' + h.slice(0, 6)).toUpperCase();
        }
        const m = rgbStr.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?/);
        if (!m) return null;
        var hex = '#' + [m[1], m[2], m[3]].map(function(x) { return parseInt(x, 10).toString(16).padStart(2, '0'); }).join('').toUpperCase();
        if (m[4] != null && parseFloat(m[4]) < 1) {
            hex += Math.round(Math.max(0, Math.min(1, parseFloat(m[4]))) * 255).toString(16).padStart(2,'0').toUpperCase();
        }
        return hex;
    }

    function normalizeTextAlign(cs) {
        const ta = cs.textAlign || 'left';
        if (ta === 'start') return 'left';
        if (ta === 'end') return 'right';
        return ta;
    }

    function applyTextTransform(text, tt) {
        if (!tt || tt === 'none') return text;
        if (tt === 'uppercase') return text.toUpperCase();
        if (tt === 'lowercase') return text.toLowerCase();
        if (tt === 'capitalize') return text.replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
        return text;
    }

    function collapseTextNodeWhitespace(root) {
        if (!root) return;
        var nodes = [];
        var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = tw.nextNode())) nodes.push(n);
        for (var i = 0; i < nodes.length; i++) {
            var p = nodes[i].parentElement;
            if (p && (p.tagName === 'PRE' || (p.closest && p.closest('pre')))) continue;
            nodes[i].textContent = String(nodes[i].textContent || '').replace(/[ \\t\\f\\v]+/g, ' ').replace(/\\n+/g, ' ');
        }
    }

    function inViewport(rect) {
        const relX = rect.left - slideRect.left;
        const relY = rect.top - slideRect.top;
        if (relX > slideRect.width || relY > slideRect.height) return false;
        if (relX + rect.width < 0 || relY + rect.height < 0) return false;
        return true;
    }

    function isVisible(el, cs, rect) {
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity) === 0) return false;
        if (rect.width < 2 || rect.height < 2) return false;
        return inViewport(rect);
    }

    function buildPlainTextContent(el, textAlign, textTransform) {
        // 用 innerHTML 保留 inline 格式（span/b/strong 等），但去掉脚本/style / 源码缩进空白
        const clone = el.cloneNode(true);
        clone.querySelectorAll && clone.querySelectorAll('script, style').forEach(function(n) { n.remove(); });
        collapseTextNodeWhitespace(clone);
        var inner = clone.innerHTML || (el.textContent || '').trim();
        if (textTransform && textTransform !== 'none') {
            inner = inner.replace(/>([^<]+)</g, function(_m, t) {
                return '>' + applyTextTransform(t, textTransform) + '<';
            });
            // 纯文本无标签时
            if (inner.indexOf('<') === -1) inner = applyTextTransform(inner, textTransform);
        }
        const alignAttr = (textAlign && textAlign !== 'left') ? (' style="text-align: ' + textAlign + ';"') : '';
        return '<p' + alignAttr + '>' + inner + '</p>';
    }
""" + _JS_TEXT_BOX_RECT + """
    function emitText(el, cs, rect) {
        const innerText = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!innerText) return;

        const tb = textBoxRect(el, rect);
        const relX = Math.round((tb.left - slideRect.left) * scaleX);
        const relY = Math.round((tb.top - slideRect.top) * scaleY);
        const textTransform = cs.textTransform || 'none';
        const transformedKey = applyTextTransform(innerText, textTransform).substring(0, 20);
        const key = relX + '_' + relY + '_' + transformedKey;
        if (seen.has(key)) return;
        seen.add(key);

        const fontSizePx = parseFloat(cs.fontSize) || 16;
        // Phase-3 Wave-5 渐变文字 fallback：如果 color/text-fill-color 是 transparent
        // （webkit-background-clip:text 的典型组合），从 background-image 里抠出第一个色
        // 作为 defaultColor，避免 text 渲染成"看不见"。
        var colorHex = rgbToHex(cs.color) || '';
        const fillCol = cs.webkitTextFillColor || cs.textFillColor || '';
        const isTransparent = !colorHex || colorHex === '#TRANSPARENT'
            || fillCol === 'transparent' || fillCol === 'rgba(0, 0, 0, 0)'
            || cs.color === 'transparent' || cs.color === 'rgba(0, 0, 0, 0)';
        if (isTransparent) {
            // 从 background-image 抠首色
            const bgImg = cs.backgroundImage || '';
            const m = bgImg.match(/rgba?\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+(?:\\s*,\\s*[\\d.]+)?\\s*\\)|#[0-9a-fA-F]{3,8}/);
            if (m) {
                colorHex = rgbToHex(m[0]) || m[0];
            } else {
                colorHex = '#FFFFFF'; // 兜底白（深色主题更常见）
            }
        }
        if (!colorHex) colorHex = '#000000';
        const fontFamily = (cs.fontFamily || 'Inter').split(',')[0].replace(/['"]/g, '').trim();
        const textAlignNorm = normalizeTextAlign(cs);
        var elOpacity = parseFloat(cs.opacity);
        if (isNaN(elOpacity) || elOpacity > 1) elOpacity = 1;
        if (elOpacity < 0) elOpacity = 0;
        if (colorHex.length === 9 && elOpacity < 1) {
            var aaW = parseInt(colorHex.slice(7, 9), 16) / 255 * elOpacity;
            colorHex = colorHex.slice(0, 7) + Math.round(Math.max(0, Math.min(1, aaW)) * 255).toString(16).padStart(2, '0').toUpperCase();
            elOpacity = 1;
        } else if (colorHex.length === 9) {
            elOpacity = 1;
        }

        const row = {
            type: 'text',
            x: relX,
            y: relY,
            width: Math.round(tb.width * scaleX),
            height: Math.round(tb.height * scaleY),
            content: buildPlainTextContent(el, textAlignNorm, textTransform),
            defaultFontName: fontFamily,
            fontFamilyFallbacks: cs.fontFamily || fontFamily,
            defaultColor: colorHex,
            defaultFontSize: Math.round(fontSizePx * PT_PER_PX * fontScale * 100) / 100,
            sourceLineCount: tb.sourceLineCount || 1,
            wordWrap: (tb.sourceLineCount || 1) !== 1,
            flowX: relX,
            flowWidth: Math.round(tb.width * scaleX),
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            rotate: 0,
            opacity: elOpacity,
            locked: false,
            visible: true,
            flipH: false,
            flipV: false,
            // Phase-2 Wave-1 walker 改造：标记来源便于去重时识别
            _fromWalker: true,
            _walkerTag: el.tagName.toLowerCase(),
            _walkerKey: key,
        };
        // 只读真实 text-align；垂直对齐不再推断，由几何位置决定。
        if (textAlignNorm === 'justify') row.defaultTextAlign = 'justify';
        else if (textAlignNorm === 'right') row.defaultTextAlign = 'right';
        else if (textAlignNorm === 'center') row.defaultTextAlign = 'center';
        // 行高比值：见 _PURE_DOM_EXTRACT_SLIDE_JS 说明，避免紧凑行高元素被裁。
        var lhPx = parseFloat(cs.lineHeight);
        if (!isNaN(lhPx) && fontSizePx > 0) {
            row.lineHeight = Math.round((lhPx / fontSizePx) * 100) / 100;
        }
        var lsRaw = cs.letterSpacing;
        if (lsRaw && lsRaw !== 'normal') {
            var lsPx = (String(lsRaw).indexOf('em') !== -1)
                ? parseFloat(lsRaw) * fontSizePx
                : parseFloat(lsRaw);
            if (!isNaN(lsPx)) {
                row.wordSpace = Math.round(lsPx * fontScale * 1000) / 1000;
            }
        }
        out.push(row);
    }

    function walk(el) {
        if (!el || el === slideEl) {
            // 从 slideEl 进入递归子节点
        } else {
            const tag = el.tagName;
            if (SKIP_TAGS.has(tag)) return;
            if (el.closest && el.closest('svg')) return;
            // Phase-2 Wave-2 栅格化兜底：raster 区域内（含自身）走截图，walker 跳过 emitText
            // Phase-3 Wave-5 双轨提取：跳过当前元素 emitText，但**仍递归子节点**，
            // 让带 data-raster-extract 标记的孙节点能被处理（之前直接 return 把子树整个吞了）
            const _rRoot = el.closest && el.closest('[data-tabslide-rasterized]');
            const _rExtract = el.closest && el.closest('[data-raster-extract]');
            if (_rRoot && !_rExtract) {
                // 自己不 emit，但递归子节点，可能里面有 data-raster-extract 标记
                const kids = el.children || [];
                for (let i = 0; i < kids.length; i++) {
                    walk(kids[i]);
                }
                return;
            }

            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (!isVisible(el, cs, rect)) return;

            // 收集"非 inline 子元素"判断容器属于"叶子/inline 容器"
            const childElements = Array.from(el.children || []).filter(function(c) {
                return !SKIP_TAGS.has(c.tagName);
            });
            const directText = Array.from(el.childNodes)
                .filter(function(n) { return n.nodeType === 3; })
                .map(function(n) { return (n.textContent || '').trim(); })
                .join('');

            // 直接子级已有 P/H1-6：正文由 PURE_DOM 抽取。若仍把整容器当叶子
            // （.list-item = span.list-num + p），会与 p 双重落盘（「任务拆解…」×2）。
            const BLOCK_TEXT_TAGS = new Set(['P','H1','H2','H3','H4','H5','H6']);
            const hasBlockTextChild = Array.from(el.children || []).some(function(c) {
                return BLOCK_TEXT_TAGS.has(c.tagName);
            });

            function isTransparentBgLocal(c) {
                return !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
            }
            // 与 _EXTRACT_SHAPES_JS 方案 A 对齐：仅当会产出 shape.text 时跳过。
            // url()/radial-only 背景不合成（image 路径无 text / radial 未进 gradient），勿在此 return。
            function isCompositeShapeHost(node, nodeCs, nodeRect) {
                var t = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
                if (!t || t.length > 64) return false;
                if (!nodeRect || nodeRect.height > 80) return false;
                var bg = nodeCs.backgroundColor;
                var hasBg = !isTransparentBgLocal(bg);
                var bw = parseFloat(nodeCs.borderTopWidth) || 0;
                var hasBorder = bw > 0
                    || (parseFloat(nodeCs.borderRightWidth) || 0) > 0
                    || (parseFloat(nodeCs.borderBottomWidth) || 0) > 0
                    || (parseFloat(nodeCs.borderLeftWidth) || 0) > 0;
                var hasShadow = nodeCs.boxShadow && nodeCs.boxShadow !== 'none';
                var bi = nodeCs.backgroundImage || '';
                var hasUrlBg = bi.indexOf('url(') !== -1;
                var hasLinearGrad = bi.indexOf('linear-gradient') !== -1;
                if (hasUrlBg) return false;
                if (!(hasBg || hasBorder || hasShadow || hasLinearGrad)) return false;
                var kids = Array.from(node.children || []);
                for (var i = 0; i < kids.length; i++) {
                    var kcs = getComputedStyle(kids[i]);
                    if (!isTransparentBgLocal(kcs.backgroundColor)) return false;
                    if (kcs.boxShadow && kcs.boxShadow !== 'none') return false;
                    var kbi = kcs.backgroundImage || '';
                    if (kbi && kbi !== 'none') return false;
                }
                return true;
            }
            if (isCompositeShapeHost(el, cs, rect)) {
                return;  // shape 管线输出带字 roundRect；此处不下探避免双份字
            }

            // 子节点含装饰胶囊时：禁止整行 allChildrenInline 吞并（否则箭头丢失、pill 空壳）
            const hasCompositeChild = Array.from(el.children || []).some(function(c) {
                if (SKIP_TAGS.has(c.tagName)) return false;
                try {
                    var crs = c.getBoundingClientRect();
                    return isCompositeShapeHost(c, getComputedStyle(c), crs);
                } catch (e) { return false; }
            });

            const isLeafText = childElements.length === 0 && directText.length > 0;
            const allChildrenInline = childElements.length > 0 && childElements.every(function(c) {
                if (INLINE_TAGS.has(c.tagName)) return true;
                const cd = getComputedStyle(c).display;
                return cd === 'inline' || cd === 'inline-block';
            });
            // flex space-between：拆成独立文本框（脚注 "TabTin Team" | "2026"）。
            // 子节点计数含 P/H（SKIP_TAGS），否则 `<p>+<span>` 混用会误合成单框丢右端。
            // 仅 space-between（脚注主场景）；space-around/evenly 误拆风险大，不在此自动拆。
            const jc = String(cs.justifyContent || '').toLowerCase();
            const flexKids = Array.from(el.children || []).filter(function(c) {
                return c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE';
            });
            const isFlexSplit = (cs.display === 'flex' || cs.display === 'inline-flex')
                && jc === 'space-between'
                && flexKids.length >= 2;

            if (
                !hasBlockTextChild
                && !hasCompositeChild
                && !isFlexSplit
                && (isLeafText || allChildrenInline)
            ) {
                emitText(el, cs, rect);
                return;  // 命中后不再下探，避免父子重复
            }
        }
        // 递归非 skip 子元素
        const kids = el.children || [];
        for (let i = 0; i < kids.length; i++) {
            walk(kids[i]);
        }
    }

    walk(slideEl);
    return out;
}"""


def _ensure_slide_element_ids(elements: list | None) -> None:
    if not elements:
        return
    for el in elements:
        if isinstance(el, dict) and "id" not in el:
            el["id"] = str(uuid.uuid4())


def _mark_data_uri_images(elements: list | None) -> None:
    """data URI 走 __originalSrc 供 postprocess 上传。"""
    if not elements:
        return
    for el in elements:
        if not isinstance(el, dict) or el.get("type") != "image":
            continue
        src = el.get("src") or ""
        if isinstance(src, str) and src.startswith("data:") and "__originalSrc" not in el:
            el["__originalSrc"] = src


# ─── Post-processing ─────────────────────────────────────────────────────


def _dom_shape_extract_to_ppt_element(raw: dict) -> dict:
    """将 _EXTRACT_SHAPES_JS 的单条结果转为扁平 PPTElement（type=shape 或 type=image）。

    Phase-2 Wave-1 渐变/URL 改造：raw 可携带 gradient / bgImage 字段。
    - bgImage（background-image: url(...)）→ 输出 type=image
    - gradient（linear-gradient）→ 输出 type=shape 且带 gradient 字段
    """
    bg_image = raw.get("bgImage") if isinstance(raw, dict) else None
    if isinstance(bg_image, dict) and bg_image.get("src"):
        w_img = float(raw.get("width") or 0)
        h_img = float(raw.get("height") or 0)
        return {
            "id": str(uuid.uuid4()),
            "type": "image",
            "x": raw.get("x", 0),
            "y": raw.get("y", 0),
            "width": w_img,
            "height": h_img,
            "src": str(bg_image.get("src") or ""),
            "rotate": 0,
            "opacity": 1,
            "locked": False,
            "visible": True,
            "flipH": False,
            "flipV": False,
            "fixedRatio": False,
            # 透传 background-size 语义供后续 OOXML 写入参考（cover / contain / auto）
            "_bgImageMode": str(bg_image.get("mode") or "cover"),
        }

    w = float(raw.get("width") or 0)
    h = float(raw.get("height") or 0)
    min_side = max(min(w, h), 1e-6)
    br = float(raw.get("borderRadiusPx") or 0)
    ratio = min(br / min_side, 0.5) if br > 0 else 0.0
    # border-radius:50% 且接近正方形 → 椭圆/圆（OOXML ellipse），避免 roundRect adj 近似失真
    aspect_delta = abs(w - h) / max(w, h, 1e-6)
    is_ellipse = ratio >= 0.49 and aspect_delta < 0.15

    vw = max(int(round(w)), 1)
    vh = max(int(round(h)), 1)

    if is_ellipse:
        rx, ry = vw / 2.0, vh / 2.0
        path = (
            f"M {vw} {ry} "
            f"A {rx} {ry} 0 1 1 0 {ry} "
            f"A {rx} {ry} 0 1 1 {vw} {ry} Z"
        )
        pptx_shape_type = "ellipse"
    elif ratio > 0:
        r = max(int(round(ratio * min(vw, vh))), 1)
        path = (
            f"M {r} 0 L {vw - r} 0 Q {vw} 0 {vw} {r} "
            f"L {vw} {vh - r} Q {vw} {vh} {vw - r} {vh} "
            f"L {r} {vh} Q 0 {vh} 0 {vh - r} "
            f"L 0 {r} Q 0 0 {r} 0 Z"
        )
        pptx_shape_type = "roundRect"
    else:
        path = f"M 0 0 L {vw} 0 L {vw} {vh} L 0 {vh} Z"
        pptx_shape_type = "rect"

    out: dict = {
        "id": str(uuid.uuid4()),
        "type": "shape",
        "x": raw.get("x", 0),
        "y": raw.get("y", 0),
        "width": w,
        "height": h,
        "viewBox": [vw, vh],
        "path": path,
        "fixedRatio": False,
        "rotate": 0,
        "opacity": 1,
        "locked": False,
        "visible": True,
        "pptxShapeType": pptx_shape_type,
    }
    if pptx_shape_type == "roundRect":
        out["pathFormula"] = "roundRect"
        out["keypoints"] = [round(ratio, 4)] * 4

    fill_hex = raw.get("fill")
    fill_css = raw.get("fillCss")
    if isinstance(fill_hex, str) and fill_hex.startswith("#"):
        out["fill"] = fill_hex.strip().upper()
    elif isinstance(fill_css, str) and fill_css.strip():
        parsed = _re.match(
            r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?",
            fill_css,
        )
        if parsed:
            fill_out = "#{:02X}{:02X}{:02X}".format(
                int(parsed.group(1)), int(parsed.group(2)), int(parsed.group(3))
            )
            if parsed.group(4) is not None:
                try:
                    alpha = float(parsed.group(4))
                    if 0 <= alpha < 1:
                        fill_out += f"{round(alpha * 255):02X}"
                except (TypeError, ValueError):
                    pass
            out["fill"] = fill_out
        else:
            out["fill"] = fill_css.strip()
    elif isinstance(fill_hex, str) and fill_hex.strip():
        out["fill"] = fill_hex.strip()

    # 元素 opacity：与 fill 自带 alpha 合并时只乘一次，避免双重变虚
    try:
        el_opacity = float(raw.get("opacity", 1) or 1)
    except (TypeError, ValueError):
        el_opacity = 1.0
    el_opacity = max(0.0, min(1.0, el_opacity))
    fill_val = out.get("fill")
    fill_has_alpha = (
        isinstance(fill_val, str)
        and fill_val.startswith("#")
        and len(fill_val) == 9
    )
    if fill_has_alpha and el_opacity < 1.0:
        try:
            base = fill_val[1:7]
            aa = int(fill_val[7:9], 16) / 255.0
            merged = max(0.0, min(1.0, aa * el_opacity))
            out["fill"] = f"#{base}{round(merged * 255):02X}"
            out["opacity"] = 1
        except (TypeError, ValueError):
            out["opacity"] = el_opacity
    elif el_opacity < 1.0:
        out["opacity"] = el_opacity

    line = raw.get("line")
    border_lines_raw = raw.get("borderLines")
    if isinstance(border_lines_raw, list) and len(border_lines_raw) > 0:
        line = None
    if isinstance(line, dict) and line.get("width"):
        try:
            lw = float(line["width"])
            if lw > 0:
                out["outline"] = {
                    "color": str(line.get("color") or "#000000"),
                    "width": lw,
                    "style": str(line.get("style") or "solid"),
                }
        except (TypeError, ValueError):
            pass

    sh = raw.get("shadow")
    if isinstance(sh, dict) and (sh.get("blur") or sh.get("h") or sh.get("v")):
        try:
            out["shadow"] = {
                "h": float(sh.get("h", 0)),
                "v": float(sh.get("v", 0)),
                "blur": float(sh.get("blur", 0)),
                "color": str(sh.get("color") or "#000000"),
                "opacity": float(sh.get("opacity", 0.5)),
            }
        except (TypeError, ValueError):
            pass

    # Phase-2 Wave-1 渐变/URL 改造：写入 PPTElement.gradient（同 packages/tabslide/src/types/slides.ts Gradient）
    grad = raw.get("gradient")
    if isinstance(grad, dict):
        gtype = grad.get("type")
        gcolors = grad.get("colors")
        if gtype in ("linear", "radial") and isinstance(gcolors, list) and len(gcolors) >= 2:
            try:
                norm_colors = []
                for c in gcolors:
                    if not isinstance(c, dict):
                        continue
                    pos = c.get("pos")
                    color = c.get("color")
                    if color is None:
                        continue
                    try:
                        pos_f = float(pos) if pos is not None else 0.0
                    except (TypeError, ValueError):
                        pos_f = 0.0
                    norm_colors.append({
                        "pos": max(0.0, min(1.0, pos_f)),
                        "color": str(color).upper() if str(color).startswith("#") else str(color),
                    })
                if len(norm_colors) >= 2:
                    out["gradient"] = {
                        "type": gtype,
                        "rotate": float(grad.get("rotate", 0)),
                        "colors": norm_colors,
                    }
            except (TypeError, ValueError):
                pass

    if raw.get("radialWarning"):
        logger.warning(
            "[SlideExtractor] radial-gradient not yet supported (Phase-2 Wave-1); element kept as solid/transparent shape"
        )

    # 方案 A：装饰宿主内嵌文字（flat 字段；export 时经 _flat_element_to_props_wrapped 进 props.text）
    text_payload = raw.get("text")
    if isinstance(text_payload, dict) and isinstance(text_payload.get("content"), str):
        content = text_payload["content"].strip()
        if content:
            shape_text = {
                "content": content,
                "align": str(text_payload.get("align") or "center"),
                "verticalAlign": str(text_payload.get("verticalAlign") or "middle"),
                "defaultFontSize": text_payload.get("defaultFontSize"),
                "defaultColor": text_payload.get("defaultColor"),
                "defaultFontName": text_payload.get("defaultFontName")
                or text_payload.get("defaultFontFamily"),
                "defaultFontFamily": text_payload.get("defaultFontFamily")
                or text_payload.get("defaultFontName"),
                "margin": text_payload.get("margin")
                if isinstance(text_payload.get("margin"), dict)
                else {"top": 0, "right": 0, "bottom": 0, "left": 0},
            }
            if isinstance(text_payload.get("sourceLineCount"), (int, float)):
                shape_text["sourceLineCount"] = max(
                    1, int(text_payload["sourceLineCount"])
                )
            if isinstance(text_payload.get("wordWrap"), bool):
                shape_text["wordWrap"] = text_payload["wordWrap"]
            out["text"] = shape_text

    return out


def _dom_border_line_to_ppt_element(raw: dict) -> dict | None:
    """将 borderLines 单条转为后端 line 元素（props.start/end 相对包围盒左上角，与 pptx_io._write_line_element 一致）。"""
    try:
        x1 = float(raw.get("x1", 0))
        y1 = float(raw.get("y1", 0))
        x2 = float(raw.get("x2", 0))
        y2 = float(raw.get("y2", 0))
    except (TypeError, ValueError):
        return None
    min_x = min(x1, x2)
    min_y = min(y1, y2)
    max_x = max(x1, x2)
    max_y = max(y1, y2)
    bw = max_x - min_x
    bh = max_y - min_y
    if bw <= 0 and bh <= 0:
        return None
    try:
        line_width = float(raw.get("width") or 1.0)
    except (TypeError, ValueError):
        line_width = 1.0
    color = str(raw.get("color") or "#000000")
    start = [x1 - min_x, y1 - min_y]
    end = [x2 - min_x, y2 - min_y]
    return {
        "id": str(uuid.uuid4()),
        "type": "line",
        "x": min_x,
        "y": min_y,
        "width": bw if bw > 0 else 1.0,
        "height": bh if bh > 0 else 1.0,
        "rotate": 0,
        "opacity": 1,
        "locked": False,
        "visible": True,
        "props": {
            "start": start,
            "end": end,
            "style": "solid",
            "color": color,
            "lineWidth": line_width,
            "points": ["", ""],
        },
    }


def _layout_px_to_pt(px: object) -> float | None:
    try:
        if px is None:
            return None
        return round(float(px) * 0.75, 2)
    except (TypeError, ValueError):
        return None


def _normalize_hex_color(c: object) -> str | None:
    if c is None:
        return None
    s = str(c).strip()
    if not s:
        return None
    return s.upper() if s.startswith("#") else s


def _layout_font_weight_to_int(fw: object) -> int | None:
    if fw is None:
        return None
    if isinstance(fw, bool):
        return None
    if isinstance(fw, (int, float)):
        return int(fw)
    s = str(fw).strip().lower()
    if s in ("bold", "bolder"):
        return 700
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def _runs_warrant_rich_html(runs: list[dict]) -> bool:
    if len(runs) > 1:
        return True
    if len(runs) != 1:
        return False
    r = runs[0]
    if not isinstance(r, dict):
        return False
    if r.get("bold") or r.get("italic") or r.get("underline"):
        return True
    c = _normalize_hex_color(r.get("color"))
    if c and c not in ("#000000", "#000"):
        return True
    if r.get("fontSize") is not None:
        return True
    return False


def _plain_text_len_from_html(content: object) -> int:
    if not isinstance(content, str) or not content:
        return 0
    plain = _re.sub(r"<[^>]+>", " ", content)
    plain = _re.sub(r"\s+", " ", plain).strip()
    return len(plain)


def _layout_runs_text_len(runs: object) -> int:
    if not isinstance(runs, list):
        return 0
    total = 0
    for r in runs:
        if isinstance(r, dict) and r.get("text") is not None:
            total += len(str(r.get("text") or ""))
    return total


def _layout_area(layout: dict) -> float:
    try:
        return max(0.0, float(layout.get("width") or 0)) * max(0.0, float(layout.get("height") or 0))
    except (TypeError, ValueError):
        return 0.0


def _prefer_layout(a: dict, b: dict) -> dict:
    """同 (x,y) 冲突时偏好文本更长 / 面积更大的 layout（避免 $ span 盖掉代码块）。"""
    a_len = _layout_runs_text_len(a.get("runs"))
    b_len = _layout_runs_text_len(b.get("runs"))
    if a_len != b_len:
        return a if a_len > b_len else b
    return a if _layout_area(a) >= _layout_area(b) else b


def _layout_runs_plain_text(layout: dict) -> str:
    runs = layout.get("runs") if isinstance(layout, dict) else None
    if not isinstance(runs, list):
        return ""
    parts: list[str] = []
    for r in runs:
        if isinstance(r, dict) and r.get("text") is not None:
            parts.append(str(r.get("text") or ""))
    return _re.sub(r"\s+", " ", "".join(parts)).strip()


def _element_content_plain_text(el: dict) -> str:
    plain = _re.sub(r"<[^>]+>", " ", str(el.get("content") or ""))
    return _re.sub(r"\s+", " ", plain).strip()


def _layout_is_content_subset(el: dict, layout: dict) -> bool:
    """layout runs 文本明显短于已有 content → 视为错配（如撞上内层 $ span）。"""
    existing_len = _plain_text_len_from_html(el.get("content"))
    runs_len = _layout_runs_text_len(layout.get("runs"))
    if existing_len <= 0 or runs_len <= 0:
        return False
    # 至少短一半且差距 ≥ 8 字符（"$" vs 整段命令）
    return runs_len * 2 < existing_len and (existing_len - runs_len) >= 8


def _layout_text_mismatches_content(el: dict, layout: dict) -> bool:
    """判断 layout 文本是否跨越了当前 DOM 节点的内容边界。

    父级 flex 容器可能与第一个子节点共享左上角，但它的 layout 文本还会包含
    后续兄弟节点。若把这个父级文本当成子节点的匹配结果，会造成串文和异常换行。
    忽略大小写：layout 侧常已应用 text-transform（EYEBROW），walker content 仍是原文。
    """
    existing = _element_content_plain_text(el).casefold()
    layout_text = _layout_runs_plain_text(layout).casefold()
    if not existing or not layout_text:
        return False
    if existing == layout_text:
        return False
    if existing in layout_text:
        return True
    if layout_text in existing:
        return False
    return True


def _text_runs_to_html_fragment(
    runs: list[dict],
    default_color: str,
    default_size_pt: float,
) -> str:
    parts: list[str] = []
    dc = (_normalize_hex_color(default_color) or "#000000").upper()
    for run in runs:
        if not isinstance(run, dict):
            continue
        text = run.get("text")
        if text is None or text == "":
            continue
        # layout JS 对 BR 产出 '\\n'；拼回 HTML 时还原为 <br>
        chunks = str(text).split("\n")
        for i, chunk in enumerate(chunks):
            if chunk:
                escaped = html.escape(chunk, quote=False)
                t = escaped
                if run.get("bold"):
                    t = f"<strong>{t}</strong>"
                if run.get("italic"):
                    t = f"<em>{t}</em>"
                if run.get("underline"):
                    t = f"<u>{t}</u>"
                r_color = _normalize_hex_color(run.get("color"))
                r_fs_pt = _layout_px_to_pt(run.get("fontSize"))
                span_styles: list[str] = []
                if r_color and r_color.upper() not in ("#000000", "#000") and r_color.upper() != dc:
                    span_styles.append(f"color: {r_color}")
                if r_fs_pt is not None and abs(float(r_fs_pt) - float(default_size_pt)) > 0.05:
                    span_styles.append(f"font-size: {r_fs_pt}pt")
                if span_styles:
                    t = f'<span style="{"; ".join(span_styles)}">{t}</span>'
                parts.append(t)
            if i < len(chunks) - 1:
                parts.append("<br>")
    return "".join(parts)


def _apply_plain_text_transform(text: str, tt: str) -> str:
    if not tt or tt == "none" or not text:
        return text
    if tt == "uppercase":
        return text.upper()
    if tt == "lowercase":
        return text.lower()
    if tt == "capitalize":
        return _re.sub(r"\b\w", lambda m: m.group(0).upper(), text)
    return text


def _map_html_text_nodes(content: str, mapper) -> str:
    """对 HTML 中标签外的文本片段应用 mapper（保留标签本身）。"""
    if not content:
        return content
    parts: list[str] = []
    for token in _re.split(r"(<[^>]+>)", content):
        if not token:
            continue
        if token.startswith("<"):
            parts.append(token)
        else:
            parts.append(mapper(token))
    return "".join(parts)


def _apply_text_transform_to_html_content(content: str, tt: str) -> str:
    """把 text-transform 预应用到 HTML 文本节点（PPT 不解析 CSS text-transform）。"""
    if not content or not tt or tt == "none":
        return content
    if "text-transform" in content.lower():
        # 去掉历史无效 wrapper，继续对文本节点预应用
        content = _re.sub(
            r'<div\s+style=["\']text-transform:\s*[^"\']+["\']\s*>',
            "",
            content,
            flags=_re.IGNORECASE,
        )
        content = _re.sub(r"</div>\s*$", "", content, flags=_re.IGNORECASE)

    def _map(token: str) -> str:
        return html.escape(
            _apply_plain_text_transform(html.unescape(token), tt),
            quote=False,
        )

    return _map_html_text_nodes(content, _map)


def _normalize_extracted_html_whitespace(content: str) -> str:
    """折叠 HTML 源码缩进空白；`<pre>` 豁免。"""
    if not isinstance(content, str) or not content or "<pre" in content.lower():
        return content

    def _map(token: str) -> str:
        return _re.sub(r"[ \t\f\v]+", " ", token).replace("\n", " ")

    return _map_html_text_nodes(content, _map)


def _enrich_text_element_from_layout(el: dict, layout: dict) -> None:
    """利用 DOM 侧 text_layout 元数据增强 text 元素（向后兼容，仅增字段）。"""
    warnings = layout.get("inlineLayoutWarnings")
    if isinstance(warnings, list):
        for w in warnings:
            if isinstance(w, str) and w.strip():
                logger.warning("[SlideExtractor] text layout: %s", w.strip())

    fw = _layout_font_weight_to_int(layout.get("fontWeight"))
    if fw is not None and fw >= 600:
        el["defaultFontWeight"] = "bold"

    # letter-spacing → wordSpace（px）；pptx_io 已支持
    ls = layout.get("letterSpacing")
    if ls is not None and el.get("wordSpace") is None:
        try:
            el["wordSpace"] = round(float(ls), 3)
        except (TypeError, ValueError):
            pass

    tt = layout.get("textTransform")
    if not isinstance(tt, str):
        tt = "none"

    runs = layout.get("runs")
    # 错配守卫：子集（代码块撞 `$`）或完全不同文案（同排卡片标题串文）时，
    # 只保留字重/字距等元数据，绝不覆盖 content / defaultColor。
    if (
        _layout_is_content_subset(el, layout if isinstance(layout, dict) else {})
        or _layout_text_mismatches_content(el, layout if isinstance(layout, dict) else {})
    ):
        c = el.get("content")
        if isinstance(c, str):
            el["content"] = _normalize_extracted_html_whitespace(c)
        return

    # HTML 固定画布的最终排版契约：保留浏览器已渲染行数，并使用“可排版宽度”而非
    # Range 墨迹宽度。只有 layout 明确给出更宽且同向的 flow box 才扩展，避免旧版
    # containerWidth 粗暴覆盖导致圆圈数字/相邻标题错位。
    source_line_count = layout.get("sourceLineCount")
    try:
        line_count = max(1, int(source_line_count))
    except (TypeError, ValueError):
        line_count = None
    if line_count is not None:
        el["sourceLineCount"] = line_count
        el["wordWrap"] = line_count != 1

    flow_x = layout.get("flowX")
    flow_width = layout.get("flowWidth")
    try:
        current_x = float(el.get("x") or 0)
        current_width = float(el.get("width") or 0)
        candidate_x = float(flow_x)
        candidate_width = float(flow_width)
        same_anchor = abs(candidate_x - current_x) <= max(3.0, current_width * 0.1)
        if same_anchor and candidate_width >= current_width and candidate_width > 0:
            el["x"] = candidate_x
            el["width"] = candidate_width
    except (TypeError, ValueError):
        pass

    font_family = layout.get("fontFamily")
    if isinstance(font_family, str) and font_family.strip():
        el["fontFamilyFallbacks"] = font_family.strip()

    # 半透明字色；9 位色已含 alpha 时强制 opacity=1，避免与 alphaModFix 双重变虚
    layout_color = layout.get("color")
    if isinstance(layout_color, str) and layout_color.startswith("#"):
        el["defaultColor"] = layout_color.upper()
        if len(layout_color) == 9:
            el["opacity"] = 1

    # 元素 opacity（颜色已带 AA 时不叠；并清掉残留）
    layout_op = layout.get("opacity")
    dc = str(el.get("defaultColor") or "")
    if dc.startswith("#") and len(dc) == 9:
        el["opacity"] = 1
    elif layout_op is not None:
        try:
            op = max(0.0, min(1.0, float(layout_op)))
            if op < 1.0:
                el["opacity"] = op
        except (TypeError, ValueError):
            pass

    if not isinstance(runs, list) or not runs:
        c = el.get("content")
        if isinstance(c, str):
            c = _normalize_extracted_html_whitespace(c)
            if tt and tt != "none":
                c = _apply_text_transform_to_html_content(c, tt)
            el["content"] = c
        return

    dict_runs = [r for r in runs if isinstance(r, dict)]
    if not _runs_warrant_rich_html(dict_runs):
        c = el.get("content")
        if isinstance(c, str):
            c = _normalize_extracted_html_whitespace(c)
            if tt and tt != "none":
                # runs 路径通常已预应用 transform；无 rich html 时仍兜底
                c = _apply_text_transform_to_html_content(c, tt)
            el["content"] = c
        return

    default_color = el.get("defaultColor") or layout.get("color") or "#000000"
    raw_fs = el.get("defaultFontSize")
    try:
        default_size_pt = float(raw_fs) if raw_fs is not None else float(_layout_px_to_pt(layout.get("fontSize")) or 16.0)
    except (TypeError, ValueError):
        default_size_pt = float(_layout_px_to_pt(layout.get("fontSize")) or 16.0)

    # runs 文本在 JS 侧已做过 text-transform；此处只拼 HTML
    inner = _text_runs_to_html_fragment(runs, str(default_color), default_size_pt)
    if inner.strip():
        dta = el.get("defaultTextAlign")
        if dta and dta in ("center", "right", "justify"):
            el["content"] = f'<p style="text-align: {dta};">{inner}</p>'
        else:
            el["content"] = f"<p>{inner}</p>"


def _plain_text_summary(el: dict, limit: int = 80) -> str:
    content = el.get("content") or ""
    if not isinstance(content, str):
        return ""
    stripped = _re.sub(r"<[^>]+>", "", content)
    return _re.sub(r"\s+", " ", stripped).strip()[:limit]


def _shape_embedded_plain(el: dict, limit: int = 80) -> str:
    """shape 方案 A 内嵌文字的纯文本摘要。"""
    text = el.get("text")
    if not isinstance(text, dict):
        return ""
    content = text.get("content") or ""
    if not isinstance(content, str):
        return ""
    stripped = _re.sub(r"<[^>]+>", "", content)
    return _re.sub(r"\s+", " ", stripped).strip()[:limit]


def _boxes_overlap_2d(a: dict, b: dict, *, min_ratio: float = 0.4) -> bool:
    """两框面积重叠比（相对较小框）≥ min_ratio。"""
    try:
        ax, ay = float(a.get("x", 0)), float(a.get("y", 0))
        aw, ah = float(a.get("width", 0)), float(a.get("height", 0))
        bx, by = float(b.get("x", 0)), float(b.get("y", 0))
        bw, bh = float(b.get("width", 0)), float(b.get("height", 0))
    except (TypeError, ValueError):
        return False
    if aw <= 0 or ah <= 0 or bw <= 0 or bh <= 0:
        return False
    ix0, iy0 = max(ax, bx), max(ay, by)
    ix1, iy1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    iw, ih = ix1 - ix0, iy1 - iy0
    if iw <= 0 or ih <= 0:
        return False
    inter = iw * ih
    return inter / min(aw * ah, bw * bh) >= min_ratio


def _dedup_text_covered_by_shape_text(elements: list[dict]) -> list[dict]:
    """方案 A 兜底：去掉与带 text 的装饰 shape 重叠且文案相同的独立 text。

    walker 已对合成宿主 return，但启发式偶发不一致时仍可能双份落盘。
    """
    if not elements:
        return elements
    hosts: list[tuple[dict, str]] = []
    for el in elements:
        if not isinstance(el, dict) or el.get("type") != "shape":
            continue
        plain = _shape_embedded_plain(el, 120)
        if plain:
            hosts.append((el, plain))
    if not hosts:
        return elements
    keep: list[dict] = []
    dropped = 0
    for el in elements:
        if not isinstance(el, dict) or el.get("type") != "text":
            keep.append(el)
            continue
        plain = _plain_text_summary(el, 120)
        if plain and any(
            plain == host_plain and _boxes_overlap_2d(el, host)
            for host, host_plain in hosts
        ):
            dropped += 1
            continue
        keep.append(el)
    if dropped:
        logger.info(
            "[SlideExtractor] shape-text dedup: dropped %d text covered by shape.text",
            dropped,
        )
    return keep


def _text_boxes_near_overlap(a: dict, b: dict, *, y_tol: float = 8.0) -> bool:
    """同行近邻：y 接近且水平投影重叠（list-item 整行 vs 内层 p，x 常差一个编号宽）。"""
    try:
        ax, ay = float(a.get("x", 0)), float(a.get("y", 0))
        aw, ah = float(a.get("width", 0)), float(a.get("height", 0))
        bx, by = float(b.get("x", 0)), float(b.get("y", 0))
        bw, bh = float(b.get("width", 0)), float(b.get("height", 0))
    except (TypeError, ValueError):
        return False
    if abs(ay - by) > y_tol and abs((ay + ah / 2) - (by + bh / 2)) > y_tol:
        return False
    a0, a1 = ax, ax + max(aw, 0)
    b0, b1 = bx, bx + max(bw, 0)
    overlap = min(a1, b1) - max(a0, b0)
    if overlap <= 0:
        return False
    min_w = max(min(aw, bw), 1.0)
    return overlap / min_w >= 0.5


def _walker_text_dedup(elements: list[dict]) -> list[dict]:
    """Phase-2 Wave-1 walker 改造：去重 walker 与 P/H1-6 重叠的文字元素。

    1) 精确 key = (round(x), round(y), text[:20])
    2) 软匹配：同行近邻 + 一方正文是另一方的子串/去编号后缀（list-item 整行 vs 内层 p）
    遇冲突时保留**非 walker**（P/H1-6 原 pipeline），因其有完整 inline 格式。
    """
    if not elements:
        return elements
    seen: dict[tuple[int, int, str], int] = {}
    keep: list[dict] = []
    dropped = 0

    def _drop_in_favor_of(keep_idx: int, challenger: dict, challenger_is_walker: bool) -> None:
        nonlocal dropped
        existing_is_walker = bool(keep[keep_idx].get("_fromWalker"))
        if existing_is_walker and not challenger_is_walker:
            keep[keep_idx] = challenger
        dropped += 1

    for el in elements:
        if not isinstance(el, dict) or el.get("type") != "text":
            keep.append(el)
            continue
        try:
            x_key = int(round(float(el.get("x", 0))))
            y_key = int(round(float(el.get("y", 0))))
        except (TypeError, ValueError):
            keep.append(el)
            continue
        # 提取文字摘要：优先用 walker 自己的 _walkerKey，否则从 content 提取
        text_summary = ""
        wk = el.get("_walkerKey")
        if isinstance(wk, str):
            # walker key 格式: "x_y_text20"
            parts = wk.rsplit("_", 1)
            text_summary = parts[-1] if len(parts) > 1 else wk
        if not text_summary:
            text_summary = _plain_text_summary(el, 20)
        key = (x_key, y_key, text_summary)

        is_walker = bool(el.get("_fromWalker"))
        if key in seen:
            _drop_in_favor_of(seen[key], el, is_walker)
            continue

        # 软去重：与已保留文本同行重叠且正文包含关系
        plain = _plain_text_summary(el, 120)
        soft_hit: int | None = None
        if plain:
            for idx, prev in enumerate(keep):
                if not isinstance(prev, dict) or prev.get("type") != "text":
                    continue
                prev_plain = _plain_text_summary(prev, 120)
                if not prev_plain:
                    continue
                if plain != prev_plain and plain not in prev_plain and prev_plain not in plain:
                    continue
                if not _text_boxes_near_overlap(el, prev):
                    continue
                soft_hit = idx
                break
        if soft_hit is not None:
            _drop_in_favor_of(soft_hit, el, is_walker)
            continue

        seen[key] = len(keep)
        keep.append(el)
    if dropped:
        logger.info("[SlideExtractor] walker dedup: dropped %d duplicate text elements", dropped)
    return keep


def _strip_walker_marks(elements: list[dict]) -> None:
    """删除内部临时标记字段，保持 PPTElement schema 干净。

    Phase-2 Wave-2 栅格化兜底：同时清理 raster 相关字段。
    """
    if not elements:
        return
    for el in elements:
        if not isinstance(el, dict):
            continue
        for k in (
            "_fromWalker",
            "_walkerTag",
            "_walkerKey",
            "_bgImageMode",
            "_fromRasterize",
            "_rasterizeReason",
        ):
            el.pop(k, None)


def _raster_bbox_dedup(elements: list[dict]) -> list[dict]:
    """Phase-2 Wave-2 栅格化兜底：把 raster image bbox 内的其他元素去掉。

    其他扫描函数本应靠 data-tabslide-rasterized 标记完全跳过 raster 子树，
    但有些路径（_FIX_ICON_TEXT 之前的截图、并行处理）可能漏过；这里做兜底，
    确保最终输出里 raster 区域只剩 image 元素。

    保留规则：
      - image 自身（_fromRasterize=True）永远保留
      - text 元素（type=='text'）永远保留 —— Phase-3 Wave-5 双轨提取契约：
        raster 区域内的纯色文字在截图前已被临时隐藏，截图里没有它们，
        所以这里把这些 text 元素留下来作为"可编辑覆盖层"叠在 image 上
      - shape / line / 其他元素：中心点落在 raster bbox 内则丢弃
    """
    if not elements:
        return elements
    raster_imgs = [
        e for e in elements
        if isinstance(e, dict) and e.get("type") == "image" and e.get("_fromRasterize")
    ]
    if not raster_imgs:
        return elements

    raster_boxes: list[tuple[float, float, float, float]] = []
    for img in raster_imgs:
        try:
            ix = float(img.get("x", 0))
            iy = float(img.get("y", 0))
            iw = float(img.get("width", 0))
            ih = float(img.get("height", 0))
        except (TypeError, ValueError):
            continue
        if iw <= 0 or ih <= 0:
            continue
        raster_boxes.append((ix, iy, ix + iw, iy + ih))

    if not raster_boxes:
        return elements

    def _in_any_raster(el: dict) -> bool:
        if not isinstance(el, dict):
            return False
        if el.get("_fromRasterize"):
            return False  # 自己永远保留
        # Phase-3 Wave-5 双轨提取：text 元素豁免（截图里已无文字，叠在 image 上不冲突）
        if el.get("type") == "text":
            return False
        try:
            ex = float(el.get("x", 0))
            ey = float(el.get("y", 0))
            ew = float(el.get("width", 0))
            eh = float(el.get("height", 0))
        except (TypeError, ValueError):
            return False
        cx = ex + ew / 2
        cy = ey + eh / 2
        for (x1, y1, x2, y2) in raster_boxes:
            if x1 <= cx <= x2 and y1 <= cy <= y2:
                return True
        return False

    keep: list[dict] = []
    dropped = 0
    for el in elements:
        if _in_any_raster(el):
            dropped += 1
            continue
        keep.append(el)
    if dropped:
        logger.info(
            "[SlideExtractor] raster bbox dedup: dropped %d elements inside %d raster region(s)",
            dropped, len(raster_boxes),
        )
    return keep


def _clamp_elements_to_canvas(
    elements: list[dict],
    canvas_w: float,
    canvas_h: float,
) -> list[dict]:
    """画布视口对齐（方案 A）：只丢弃**完全**在画布外的元素，不改任何几何。

    `.ppt-slide` 在浏览器里是 `overflow:hidden`；PPT 放映视口同样会裁页外内容。
    故意探出画布的装饰圆（负坐标 / 超宽）应保留原始 bbox，由视口裁切呈现「探边」
    效果——旧逻辑对部分越界 shape 做 bbox clamp 会把装饰圆裁小、构图失真。

    - **完全**出画 → 丢弃（浏览器本来看不见）
    - **部分**越界 → 保留原几何；正文溢出靠 structural lint `out_of_canvas` 提示改 HTML
    """
    if canvas_w <= 0 or canvas_h <= 0 or not elements:
        return elements

    kept: list[dict] = []
    dropped = 0
    for el in elements:
        if not isinstance(el, dict):
            kept.append(el)
            continue
        try:
            x = float(el.get("x", 0) or 0)
            y = float(el.get("y", 0) or 0)
            w = float(el.get("width", 0) or 0)
            h = float(el.get("height", 0) or 0)
        except (TypeError, ValueError):
            kept.append(el)
            continue

        # 完全出画（左/上用 <0 而非 <=0，避免误杀 y=0 且 h≈0 的顶边 connector）
        if x >= canvas_w or y >= canvas_h or x + w < 0 or y + h < 0:
            dropped += 1
            continue

        kept.append(el)

    if dropped:
        logger.info(
            "[SlideExtractor] canvas viewport: dropped %d fully-offscreen element(s) (canvas %.0fx%.0f)",
            dropped, canvas_w, canvas_h,
        )
    return kept


def _postprocess_slide_elements(
    elements: list[dict],
    image_handler: Callable | None = None,
    canvas_w: int = 1280,
    text_layout_data: list[dict] | None = None,
    extracted_shapes: list[dict] | None = None,
) -> list[dict]:
    """Post-process PPTElement dicts using precise DOM layout metadata."""

    prepended: list[dict] = []
    if extracted_shapes:
        for item in extracted_shapes:
            if not isinstance(item, dict):
                continue
            try:
                prepended.append(_dom_shape_extract_to_ppt_element(item))
            except Exception as e:
                logger.warning("dom shape extract conversion failed: %s", e)
            border_lines = item.get("borderLines")
            if isinstance(border_lines, list):
                for bl in border_lines:
                    if not isinstance(bl, dict):
                        continue
                    try:
                        line_el = _dom_border_line_to_ppt_element(bl)
                        if line_el:
                            prepended.append(line_el)
                    except Exception as e:
                        logger.warning("dom border line conversion failed: %s", e)
    elements = prepended + (elements or [])

    # Phase-2 Wave-1 walker 改造：去重 walker 与 P/H1-6 重叠的文字
    elements = _walker_text_dedup(elements)

    # 方案 A：shape.text 已承载胶囊文案时，去掉重叠的独立 text
    elements = _dedup_text_covered_by_shape_text(elements)

    # Phase-2 Wave-2 栅格化兜底：raster image bbox 内的 text/shape 兜底剔除
    elements = _raster_bbox_dedup(elements)

    layout_map: dict[str, dict] = {}
    if text_layout_data:
        for item in text_layout_data:
            if not isinstance(item, dict):
                continue
            try:
                key = f"{int(round(float(item['x'])))}_{int(round(float(item['y'])))}"
            except (KeyError, TypeError, ValueError):
                continue
            prev = layout_map.get(key)
            layout_map[key] = item if prev is None else _prefer_layout(prev, item)

    for el in elements:
        if not isinstance(el, dict):
            continue
        original_src = el.pop("__originalSrc", None)
        if original_src and el.get("type") == "image":
            resolved = original_src
            if image_handler and original_src.startswith("data:"):
                try:
                    header, b64data = original_src.split(",", 1)
                    mime = header.split(";")[0].replace("data:", "")
                    blob = base64.b64decode(b64data)
                    resolved = image_handler(blob, mime or "image/png")
                except Exception:
                    logger.warning("Failed to decode data URI, using raw src")
            el["src"] = resolved

        if el.get("type") == "image":
            src = el.get("src", "")
            if isinstance(src, str) and src.startswith("file://"):
                # Agent scripts can create new image nodes after the preprocessor
                # ran. Never turn those paths into a second arbitrary-file read.
                el["src"] = ""
                logger.warning("[SlideExtractor] dynamic_file_url_blocked")

        if el.get("type") == "text":
            x = el.get("x", 0)
            y = el.get("y", 0)
            w = el.get("width", 0)
            h = el.get("height", 0)

            key = f"{int(round(float(x or 0)))}_{int(round(float(y or 0)))}"
            layout = layout_map.get(key)

            if not layout and text_layout_data:
                # exact key 未命中时按 (x,y,h) 邻近匹配。旧逻辑只看 y+h，会把同排
                # 多卡片标题 / 脚注两端互相串文（「文档协作」←「研发场景」、「2025」←「团队版」）。
                x_rounded = int(round(float(x or 0)))
                y_rounded = int(round(float(y or 0)))
                h_rounded = int(round(float(h or 0)))
                best: dict | None = None
                best_dist: float | None = None
                for item in text_layout_data:
                    if not isinstance(item, dict):
                        continue
                    try:
                        ix = float(item.get("x", -9999))
                        iy = float(item.get("y", -9999))
                        ih = float(item.get("height", -9999))
                    except (TypeError, ValueError):
                        continue
                    if abs(iy - y_rounded) > 3 or abs(ih - h_rounded) > 3:
                        continue
                    if abs(ix - x_rounded) > 24:
                        continue
                    dist = abs(ix - x_rounded) + abs(iy - y_rounded)
                    if best is None or dist < (best_dist or 1e18):
                        best = item
                        best_dist = dist
                    elif dist == best_dist:
                        best = _prefer_layout(best, item)
                layout = best

            # 命中后若仍是 content 子集 / 文本完全对不上，放弃该 layout
            if layout and (
                _layout_is_content_subset(el, layout)
                or _layout_text_mismatches_content(el, layout)
            ):
                layout = None

            # 保留文本自身 getBoundingClientRect 几何，不再用「包含它的 shape」覆盖 x/width。
            # 旧逻辑把 text 的 x/width 替换成包含其中心点的 shape（且取遍历到的第一个 = 最外层
            # 卡片），会把 flex 行里的定位子元素（如 step-num 圆里的数字、圆旁边的标题）整体撑成
            # 整卡宽 → 数字左对齐跑偏、标题左移压住圆圈。文本自身的测量框已是最终渲染位置。
            # Phase-2 Wave-3 已同理移除基于 layout.containerX/Width 的覆盖；defaultTextAlign 由
            # _PURE_DOM_EXTRACT_SLIDE_JS / _WALKER_TEXT_EXTRACT_JS 从 computed style 写入。
            if layout:
                text_align = layout.get("textAlign", "left")
                if text_align in ("center", "right", "justify") and not el.get("defaultTextAlign"):
                    el["defaultTextAlign"] = text_align

            if layout:
                try:
                    _enrich_text_element_from_layout(el, layout)
                except Exception as ex:
                    logger.warning("text layout enrichment failed: %s", ex)
            else:
                # 无 layout 命中时仍折叠源码缩进空白（walker / pure DOM 多数路径已做）
                c = el.get("content")
                if isinstance(c, str):
                    el["content"] = _normalize_extracted_html_whitespace(c)

    _strip_walker_marks(elements)
    return elements


# ─── Table Region Replacement ────────────────────────────────────────


def _replace_table_regions(
    ppt_elements: list[dict],
    table_elements: list[dict],
) -> list[dict]:
    """Replace text outputs that overlap with <table> regions
    with structured PPTElement table dicts that pptx_io can write natively."""
    if not table_elements:
        return ppt_elements

    def _rects_overlap(a: dict, b: dict, threshold: float = 0.5) -> bool:
        ax1, ay1 = a.get("x", 0), a.get("y", 0)
        ax2 = ax1 + a.get("width", 0)
        ay2 = ay1 + a.get("height", 0)
        bx1, by1 = b.get("x", 0), b.get("y", 0)
        bx2 = bx1 + b.get("width", 0)
        by2 = by1 + b.get("height", 0)
        ix1, iy1 = max(ax1, bx1), max(ay1, by1)
        ix2, iy2 = min(ax2, bx2), min(ay2, by2)
        if ix1 >= ix2 or iy1 >= iy2:
            return False
        inter_area = (ix2 - ix1) * (iy2 - iy1)
        a_area = max((ax2 - ax1) * (ay2 - ay1), 1)
        return (inter_area / a_area) >= threshold

    filtered = []
    for el in ppt_elements:
        overlaps_table = False
        for tbl in table_elements:
            if _rects_overlap(el, tbl):
                overlaps_table = True
                break
        if not overlaps_table:
            filtered.append(el)

    for idx, tbl in enumerate(table_elements):
        table_el = {
            "id": f"tbl_{uuid.uuid4().hex[:8]}",
            "type": "table",
            "x": tbl["x"],
            "y": tbl["y"],
            "width": tbl["width"],
            "height": tbl["height"],
            "rotate": 0,
            "opacity": 1,
            "locked": False,
            "visible": True,
            "data": tbl.get("data", []),
            "colWidths": tbl.get("colWidths", []),
            "theme": tbl.get("theme", {}),
            "outline": tbl.get("outline", {}),
            "borders": tbl.get("borders", {}),
        }
        filtered.append(table_el)
        logger.info(
            "Replaced table region #%d: %dx%d at (%d,%d), %d rows",
            idx, int(tbl["width"]), int(tbl["height"]),
            int(tbl["x"]), int(tbl["y"]),
            len(tbl.get("data", [])),
        )

    return filtered


# ─── file:// → data URI pre-processing ───────────────────────────────────

_FILE_URL_RE = _re.compile(
    r'(src\s*=\s*["\'])(file://[^"\']+)(["\'])',
    _re.IGNORECASE,
)
_MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024


def _inline_file_urls(
    html: str,
    *,
    trusted_roots: tuple[Path, ...] = (),
) -> str:
    """Inline bounded image files only when the caller explicitly trusts their root.

    Headless Chromium blocks file:// protocol, causing images to render with
    wrong dimensions (height:auto → ~16px). Inlining as data URIs ensures
    correct getBoundingClientRect() during DOM extraction. Untrusted references
    are rejected before Agent-authored scripts or later extraction can read them.
    Callers that accept local assets must pass an explicit trusted root so a
    broken slide is never produced silently.
    """
    import mimetypes as _mt
    from urllib.parse import unquote, urlparse

    resolved_roots = tuple(root.resolve() for root in trusted_roots)

    def _replacer(m: _re.Match) -> str:
        prefix, file_url, suffix = m.group(1), m.group(2), m.group(3)
        try:
            parsed_path = unquote(urlparse(file_url).path)
            if sys.platform == "win32" and _re.match(r"^/[A-Za-z]:/", parsed_path):
                parsed_path = parsed_path[1:]
            path = Path(parsed_path).resolve(strict=True)
            trusted = any(path.is_relative_to(root) for root in resolved_roots)
            mime = _mt.guess_type(path.name)[0] or ""
            if (
                not trusted
                or not path.is_file()
                or not mime.startswith("image/")
                or path.stat().st_size > _MAX_INLINE_FILE_BYTES
            ):
                raise ValueError("untrusted_or_invalid_image")
            data = path.read_bytes()
            b64 = base64.b64encode(data).decode("ascii")
            return f'{prefix}data:{mime};base64,{b64}{suffix}'
        except Exception as exc:
            logger.warning(
                "[SlideExtractor] file_url_blocked reason=%s",
                type(exc).__name__,
            )
            return f"{prefix}{suffix}"

    if _FILE_URL_RE.search(html) and not resolved_roots:
        raise ValueError(
            "HTML contains file:// image URLs but no trusted_roots were provided"
        )

    return _FILE_URL_RE.sub(_replacer, html)


# ─── Core Async Extraction ───────────────────────────────────────────────


async def _load_page_content(page, full_html: str) -> None:
    """Load the complete structural DOM through the bounded render runtime."""
    await load_render_document(page, full_html, slide_selector=SLIDE_SELECTOR)


async def _extract_async(
    html: str,
    canvas_w: int,
    canvas_h: int,
    image_handler: Optional[Callable] = None,
    trusted_roots: tuple[Path, ...] = (),
) -> list[dict]:
    """Async core: load HTML in Playwright, extract text/images/shapes/tables via DOM scripts."""
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        )
        try:
            page = await browser.new_page(
                viewport={"width": 1920, "height": 10800},
            )
            page.on(
                "console",
                lambda msg: logger.info("[BrowserConsole] type=%s", msg.type),
            )

            full_html = _ensure_full_html(html)
            full_html = _inline_file_urls(full_html, trusted_roots=trusted_roots)
            await _load_page_content(page, full_html)

            # 量框前等字体加载完成：字体未就绪时 getBoundingClientRect 会按临时 fallback
            # 字体计算，得到的框尺寸与最终字体不一致 → 渲染端换回目标字体后文字溢出。
            try:
                await asyncio.wait_for(
                    page.evaluate("async () => { await document.fonts.ready; return true; }"),
                    timeout=3,
                )
            except Exception:
                logger.warning("[SlideExtractor] document.fonts.ready wait failed")

            try:
                await wait_for_image_decode(page)
            except Exception:
                logger.warning("[SlideExtractor] image_decode_timeout")

            try:
                await wait_for_optional_render_ready(page)
            except Exception:
                logger.warning("[SlideExtractor] optional_render_ready_timeout")

            await page.wait_for_timeout(300)

            # Phase-3 Wave-1 ECharts 修复：等 ECharts/Chart.js 的容器都完成 init。
            # 判定依据：div[id^="chart"] / div.echarts-container / canvas 出现，且
            # 至少有一个真正渲染了 ([_echarts_instance_] 属性 或 canvas 内部 width>0)。
            # 没有图表的页面跳过等待。
            has_chart_containers = await page.evaluate(
                """() => {
                    const sel = 'canvas, [class*="echarts"], .echarts-container, [_echarts_instance_]';
                    return document.querySelectorAll(sel).length > 0;
                }"""
            )
            if has_chart_containers:
                try:
                    await page.wait_for_function(
                        """() => {
                            const candidates = document.querySelectorAll(
                                'canvas, [class*="echarts"], .echarts-container, [_echarts_instance_]'
                            );
                            if (candidates.length === 0) return true;
                            let initialized = 0;
                            for (const c of candidates) {
                                if (c.hasAttribute && c.hasAttribute('_echarts_instance_')) { initialized++; continue; }
                                if (c.tagName === 'CANVAS') {
                                    const w = c.getAttribute('width');
                                    if (w && parseInt(w) > 0) { initialized++; continue; }
                                }
                                // ECharts 容器 div 通常有内嵌 canvas（width 已设）
                                const inner = c.querySelector && c.querySelector('canvas');
                                if (inner) {
                                    const w = inner.getAttribute('width');
                                    if (w && parseInt(w) > 0) { initialized++; continue; }
                                }
                            }
                            return initialized > 0 && initialized >= candidates.length * 0.5;
                        }""",
                        timeout=4000,
                    )
                    logger.info("[SlideExtractor] chart containers initialized")
                except Exception:
                    logger.warning("[SlideExtractor] chart init wait timed out (4s)")
                await page.wait_for_timeout(800)
            else:
                await page.wait_for_timeout(500)

            slides = await page.query_selector_all(SLIDE_SELECTOR)
            if not slides:
                raise ValueError("No .ppt-slide elements found in HTML")

            pages = []
            for i, slide_el in enumerate(slides):
                dims = await slide_el.evaluate(
                    "el => ({ w: el.offsetWidth, h: el.offsetHeight })"
                )
                css_w = dims["w"] or 1280
                css_h = dims["h"] or 720
                sx = canvas_w / css_w
                sy = canvas_h / css_h

                logger.info(
                    "Extracting slide %d/%d (CSS %dx%d → canvas %dx%d, scale %.2fx%.2f)",
                    i + 1, len(slides), css_w, css_h, canvas_w, canvas_h, sx, sy,
                )

                await slide_el.scroll_into_view_if_needed()

                # HTML 布局 lint：在 clamp / 抽取前量真实内容高度，捕获将被
                # overflow:hidden 裁掉的正文（structural lint 在 clamp 后看不到）
                page_id = f"page-{i + 1}"
                layout_problems: list[dict] = []
                try:
                    layout_metrics = await slide_el.evaluate(HTML_LAYOUT_LINT_JS)
                    layout_problems = problems_from_layout_metrics(
                        layout_metrics,
                        page_id=page_id,
                        canvas_w=float(canvas_w),
                        canvas_h=float(canvas_h),
                    )
                    if layout_problems:
                        logger.warning(
                            "[SlideExtractor] slide %d: html layout lint %d problem(s): %s",
                            i + 1,
                            len(layout_problems),
                            ", ".join(
                                f"{p.get('type')}:{p.get('severity')}"
                                for p in layout_problems
                            ),
                        )
                except Exception as e:
                    logger.warning(
                        "[SlideExtractor] slide %d: html layout lint failed: %s",
                        i + 1, e,
                    )

                background = await slide_el.evaluate(_EXTRACT_BG_JS)

                # Phase-2 Wave-2 栅格化兜底：先检测 + 截图复杂区域，再让 _FIX_ICON_TEXT_JS
                # 隐藏 icon。顺序很关键：raster screenshot 必须在 icon 被隐藏前抓，否则
                # 截图里的 icon 全没；但标记要保留到所有扫描完成后再清理，让 walker / shapes /
                # text_layout / pure_dom 跳过 raster 子树。
                raster_image_elements: list[dict] = []
                raster_marked = False
                try:
                    try:
                        raster_rects = await slide_el.evaluate(_DETECT_RASTERIZE_REGIONS_JS)
                        if not isinstance(raster_rects, list):
                            raster_rects = []
                    except Exception as e:
                        logger.warning("[SlideExtractor] rasterize detection failed: %s", e)
                        raster_rects = []

                    # Phase-2 Wave-2 debug: 总是 log 检测结果，便于排查"应被 raster 但漏掉"的情况
                    logger.info(
                        "[SlideExtractor] slide %d: rasterize detect returned %d region(s)",
                        i + 1, len(raster_rects),
                    )

                    if raster_rects:
                        raster_marked = True
                        try:
                            raster_slide_abs = await slide_el.evaluate(
                                "el => { const r = el.getBoundingClientRect();"
                                " return { left: r.left, top: r.top }; }"
                            )
                        except Exception as e:
                            logger.warning("[SlideExtractor] failed to read slide bounding rect: %s", e)
                            raster_slide_abs = {"left": 0, "top": 0}

                        logger.info(
                            "[SlideExtractor] slide %d: rasterize detected %d region(s)",
                            i + 1, len(raster_rects),
                        )

                        # Phase-3 Wave-5 双轨提取：截图前先隐藏 raster 区域内的"普通纯色文字"，
                        # 截图完恢复，后续 walker / pure_dom 把这些文字单独提取为 text 元素。
                        # 这样 image 是"无文字装饰背景"，text 是"可编辑覆盖层"，Agent 改文字
                        # 不被栅格化锁死（之前 KPI 卡片整块截图导致 234.6 万无法 update）。
                        text_extract_prepared = False
                        try:
                            n_prepared = await slide_el.evaluate(_PREPARE_RASTER_TEXT_EXTRACT_JS)
                            text_extract_prepared = bool(n_prepared)
                            if n_prepared:
                                logger.info(
                                    "[SlideExtractor] slide %d: hide+extract %d texts inside raster",
                                    i + 1, n_prepared,
                                )
                        except Exception as e:
                            logger.warning(
                                "[SlideExtractor] prepare raster text extract failed: %s", e,
                            )

                        # 截图前把幻灯片 / body / html 背景临时置透明：omit_background 只能去掉
                        # 浏览器默认底色，去不掉 .ppt-slide 自绘的渐变/底色；不清掉的话透明装饰
                        # （如淡水印图标）会把背后渐变一起拍进不透明贴块。截完立即恢复。
                        bg_cleared = False
                        try:
                            await slide_el.evaluate(
                                "el => { const clear = (n) => { if (!n) return;"
                                " n.setAttribute('data-ts-bg-save', n.getAttribute('style') || '');"
                                " n.style.setProperty('background', 'transparent', 'important');"
                                " n.style.setProperty('background-image', 'none', 'important'); };"
                                " clear(el); clear(document.body); clear(document.documentElement); }"
                            )
                            bg_cleared = True
                        except Exception as e:
                            logger.warning("[SlideExtractor] clear bg for raster failed: %s", e)

                        for rr in raster_rects:
                            try:
                                rr_w = float(rr.get("width") or 0)
                                rr_h = float(rr.get("height") or 0)
                                if rr_w < 2 or rr_h < 2:
                                    continue
                                png_bytes = await page.screenshot(
                                    type="png",
                                    # 透明背景截图：只截 rasterize 区域自身内容，不把背后的
                                    # 幻灯片背景（渐变/底色）一起拍进去。否则透明装饰（如淡水印
                                    # 图标）会变成带底色的不透明贴块，叠回幻灯片显成深色方块。
                                    omit_background=True,
                                    clip={
                                        "x": raster_slide_abs.get("left", 0) + float(rr.get("x", 0)),
                                        "y": raster_slide_abs.get("top", 0) + float(rr.get("y", 0)),
                                        "width": rr_w,
                                        "height": rr_h,
                                    },
                                )
                            except Exception as e:
                                logger.warning(
                                    "[SlideExtractor] raster screenshot failed (reason=%s): %s",
                                    rr.get("reason"), e,
                                )
                                continue

                            src_url = ""
                            if image_handler and png_bytes:
                                try:
                                    src_url = image_handler(png_bytes, "image/png") or ""
                                except Exception as e:
                                    logger.warning(
                                        "[SlideExtractor] raster image upload failed (reason=%s): %s",
                                        rr.get("reason"), e,
                                    )
                                    src_url = ""
                            if not src_url and png_bytes:
                                # 无 handler（inline 模式）或上传失败：data:base64 内嵌，
                                # 保证栅格化图不因存储不可用而丢失
                                src_url = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")

                            raster_image_elements.append({
                                "id": str(uuid.uuid4())[:8],
                                "type": "image",
                                "x": float(rr.get("x", 0)) * sx,
                                "y": float(rr.get("y", 0)) * sy,
                                "width": rr_w * sx,
                                "height": rr_h * sy,
                                "rotate": 0,
                                "opacity": 1,
                                "src": src_url,
                                "locked": False,
                                "visible": True,
                                "fixedRatio": False,
                                "_fromRasterize": True,
                                "_rasterizeReason": str(rr.get("reason") or "explicit"),
                            })

                        # 恢复被临时清空的背景（幻灯片 / body / html）
                        if bg_cleared:
                            try:
                                await slide_el.evaluate(
                                    "el => { const restore = (n) => { if (!n || !n.hasAttribute('data-ts-bg-save')) return;"
                                    " const s = n.getAttribute('data-ts-bg-save');"
                                    " if (s) { n.setAttribute('style', s); } else { n.removeAttribute('style'); }"
                                    " n.removeAttribute('data-ts-bg-save'); };"
                                    " restore(el); restore(document.body); restore(document.documentElement); }"
                                )
                            except Exception as e:
                                logger.warning("[SlideExtractor] restore bg after raster failed: %s", e)

                        # 截图完成，恢复 visibility（保留 data-raster-extract 标记，让后续提取生效）
                        if text_extract_prepared:
                            try:
                                await slide_el.evaluate(_RESTORE_HIDDEN_RASTER_TEXTS_JS)
                            except Exception as e:
                                logger.warning(
                                    "[SlideExtractor] restore hidden raster texts failed: %s", e,
                                )

                    # Pre-extraction: hide FA icons and wrap badge text nodes
                    await slide_el.evaluate(_FIX_ICON_TEXT_JS)

                    opts = {"canvasWidth": canvas_w, "canvasHeight": canvas_h}

                    text_layout_data = await slide_el.evaluate(
                        _EXTRACT_TEXT_LAYOUT_JS,
                        opts,
                    )
                    if not isinstance(text_layout_data, list):
                        text_layout_data = []

                    ppt_elements: list = []
                    try:
                        raw_pure = await slide_el.evaluate(_PURE_DOM_EXTRACT_SLIDE_JS, opts)
                    except Exception as e:
                        logger.warning("[SlideExtractor] pure DOM extract failed: %s", e)
                        raw_pure = None

                    if isinstance(raw_pure, list):
                        ppt_elements = list(raw_pure)
                        logger.info(
                            "[SlideExtractor] slide %d: pure DOM text/images (%d elements)",
                            i + 1,
                            len(ppt_elements),
                        )
                    else:
                        logger.warning(
                            "[SlideExtractor] slide %d: pure DOM returned %s, no elements extracted",
                            i + 1,
                            type(raw_pure).__name__,
                        )

                    # Phase-2 Wave-1 walker 改造：识别 div/span/li 等容器中的文字
                    try:
                        raw_walker = await slide_el.evaluate(_WALKER_TEXT_EXTRACT_JS, opts)
                    except Exception as e:
                        logger.warning("[SlideExtractor] walker text extract failed: %s", e)
                        raw_walker = None

                    if isinstance(raw_walker, list) and raw_walker:
                        before = len(ppt_elements)
                        ppt_elements.extend(raw_walker)
                        logger.info(
                            "[SlideExtractor] slide %d: walker added %d text elements (total now %d)",
                            i + 1,
                            len(ppt_elements) - before,
                            len(ppt_elements),
                        )

                    # Phase-2 Wave-2 栅格化兜底：把 raster image 加入 elements，
                    # 让后续 _raster_bbox_dedup 能识别并剔除区域内残余文字/形状
                    # Phase-3 Wave-5 双轨提取：raster image 必须**垫底**（zIndex 最低），
                    # 否则会盖住双轨提取出的 text 元素，导致 KPI 数字 / 标签全部看不见
                    if raster_image_elements:
                        ppt_elements = list(raster_image_elements) + ppt_elements

                    _ensure_slide_element_ids(ppt_elements)
                    _mark_data_uri_images(ppt_elements)

                    extracted_shapes = await slide_el.evaluate(_EXTRACT_SHAPES_JS, opts)
                    if not isinstance(extracted_shapes, list):
                        extracted_shapes = []

                    ppt_elements = _postprocess_slide_elements(
                        ppt_elements,
                        image_handler,
                        canvas_w=canvas_w,
                        text_layout_data=text_layout_data,
                        extracted_shapes=extracted_shapes,
                    )

                    # Post-extraction: extract <table> as native table elements
                    table_elements = await slide_el.evaluate(
                        _EXTRACT_TABLES_JS,
                        {"canvasWidth": canvas_w, "canvasHeight": canvas_h},
                    )
                    if table_elements:
                        ppt_elements = _replace_table_regions(
                            ppt_elements, table_elements,
                        )

                    canvas_rects = await slide_el.evaluate(_DETECT_CANVAS_JS)
                    if canvas_rects:
                        slide_rect = await slide_el.evaluate(
                            "el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top }; }"
                        )
                        for cr in canvas_rects:
                            try:
                                png_bytes = await page.screenshot(
                                    type="png",
                                    clip={
                                        "x": slide_rect["left"] + cr["x"],
                                        "y": slide_rect["top"] + cr["y"],
                                        "width": cr["width"],
                                        "height": cr["height"],
                                    },
                                )
                                if png_bytes:
                                    if image_handler:
                                        url = image_handler(png_bytes, "image/png")
                                    else:
                                        # inline 模式（无 handler）：data:base64 内嵌，
                                        # 否则 canvas 图表（ECharts / Chart.js）会整个丢失
                                        url = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
                                    ppt_elements.append({
                                        "id": str(uuid.uuid4())[:8],
                                        "type": "image",
                                        "x": cr["x"] * sx,
                                        "y": cr["y"] * sy,
                                        "width": cr["width"] * sx,
                                        "height": cr["height"] * sy,
                                        "rotate": 0,
                                        "opacity": 1,
                                        "src": url,
                                        "locked": False,
                                        "visible": True,
                                    })
                            except Exception as e:
                                logger.warning("Canvas screenshot failed: %s", e)

                    #  所见即所得：溢出 .ppt-slide（overflow:hidden）的部分
                    # 在浏览器里不可见，导出前按画布裁边 / 丢弃完全出画的元素
                    ppt_elements = _clamp_elements_to_canvas(
                        ppt_elements, float(canvas_w), float(canvas_h),
                    )

                    for idx, el in enumerate(ppt_elements):
                        el["zIndex"] = idx

                    page_dict: dict = {
                        "id": page_id,
                        "elements": ppt_elements,
                        "background": background or {"type": "solid", "color": "#FFFFFF"},
                    }
                    if layout_problems:
                        page_dict["layout_problems"] = layout_problems
                    pages.append(page_dict)
                finally:
                    # Phase-2 Wave-2 栅格化兜底：成对清理临时 DOM 标记，无论中间是否报错
                    if raster_marked:
                        try:
                            await slide_el.evaluate(_CLEANUP_RASTERIZE_MARKS_JS)
                        except Exception as e:
                            logger.warning("[SlideExtractor] raster mark cleanup failed: %s", e)
                        # Phase-3 Wave-5 双轨提取：清理 data-raster-extract 标记
                        try:
                            await slide_el.evaluate(_CLEANUP_RASTER_EXTRACT_MARKS_JS)
                        except Exception as e:
                            logger.warning(
                                "[SlideExtractor] raster-extract mark cleanup failed: %s", e,
                            )

        finally:
            await browser.close()

    return pages


def extract_elements_batch(
    html_pages: list[str],
    canvas_width: int = 1280,
    canvas_height: int = 720,
    image_handler: Optional[Callable] = None,
    trusted_roots: tuple[Path, ...] = (),
) -> list[list[dict]]:
    """Extract elements from multiple HTML pages in a single Playwright session."""
    results = []
    for html in html_pages:
        pages = extract_elements_from_html(
            html, canvas_width, canvas_height, image_handler, trusted_roots,
        )
        results.append(pages)
    return results


# ─── Public API ───────────────────────────────────────────────────────────


def _validate_html_constraints(html: str) -> list[str]:
    """
    Pre-validate HTML against PPTX-mappable constraints.

    Returns a list of warning messages (non-blocking).
    These correspond to the hard constraints in html-spec/SKILL.md.
    """
    warnings = []
    html_lower = html.lower()

    # Phase-2 Wave-2 栅格化兜底：backdrop-filter 现在由 raster fallback 接管，
    # 不再视为约束违反，仅 info 级别提示
    if "backdrop-filter" in html_lower:
        logger.info(
            "[SlideExtractor] HTML uses 'backdrop-filter'; affected regions will be rasterized as image."
        )

    if "transition:" in html_lower or "animation:" in html_lower or "@keyframes" in html_lower:
        warnings.append(
            "HTML contains CSS animation/transition which will be lost in PPT conversion. "
            "Use static styles only."
        )

    bg_image_in_div = _re.findall(
        r'<div[^>]*style=["\'][^"\']*background-image\s*:', html, _re.IGNORECASE
    )
    if bg_image_in_div:
        warnings.append(
            f"Found {len(bg_image_in_div)} <div> with background-image. "
            "Use <img> tags instead for better PPT conversion."
        )

    text_tags_with_bg = _re.findall(
        r'<(?:p|h[1-6])[^>]*style=["\'][^"\']*(?:background|border|box-shadow)\s*:',
        html, _re.IGNORECASE,
    )
    if text_tags_with_bg:
        warnings.append(
            f"Found {len(text_tags_with_bg)} text element(s) (<p>/<h*>) with background/border/shadow. "
            "Move these styles to a parent <div> wrapper."
        )

    # linear-gradient 已映射为 shape fill；仅 radial-gradient 仍会降级
    if _re.search(r"radial-gradient\s*\(", html, _re.IGNORECASE):
        warnings.append(
            "HTML contains radial-gradient; only linear-gradient maps to PPTX shape fills. "
            "Radial fills degrade to solid/transparent."
        )

    return warnings


def extract_elements_from_html(
    html: str,
    canvas_width: int = 1280,
    canvas_height: int = 720,
    image_handler: Optional[Callable] = None,
    trusted_roots: tuple[Path, ...] = (),
    **_kwargs,
) -> list[dict]:
    """
    Extract PPTElement pages directly from Agent-generated HTML.

    Returns a list of page dicts compatible with _cas_save_pages():
        [{ "id": "page-1", "elements": [...], "background": {...} }, ...]

    Args:
        html: Complete HTML string with .ppt-slide containers
        canvas_width: Target canvas width in px (default 1920)
        canvas_height: Target canvas height in px (default 1080)
        image_handler: Optional callable(bytes, mime_type) → URL for uploading
                       fallback screenshots to OSS
    """
    constraint_warnings = _validate_html_constraints(html)
    if constraint_warnings:
        for w in constraint_warnings:
            logger.warning("[SlideExtractor] HTML constraint violation: %s", w)

    return _run_async_safe(
        _extract_with_deadline(
            html, canvas_width, canvas_height, image_handler, trusted_roots,
        )
    )


async def _extract_with_deadline(
    html: str,
    canvas_width: int,
    canvas_height: int,
    image_handler: Optional[Callable],
    trusted_roots: tuple[Path, ...] = (),
) -> list[dict]:
    """Keep browser cleanup inside the worker's existing 60-second boundary."""
    return await asyncio.wait_for(
        _extract_async(
            html, canvas_width, canvas_height, image_handler, trusted_roots,
        ),
        timeout=55,
    )
