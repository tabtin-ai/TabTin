/**
 * Theme Color Extractor
 *
 * 从 WebContentsView 中提取网页主题色，支持多种策略：
 * 1. HTML <meta name="theme-color"> 声明（最高优先级）
 * 2. HTML <meta name="msapplication-navbutton-color"> 声明
 * 3. CSS 语义元素背景色采样（header / nav）
 * 4. 页面顶部视觉多点采样
 * 5. 文档背景色兜底（body / html）
 *
 * 设计目标：让状态栏颜色与网页顶部视觉一致（类似 Safari / Arc 浏览器）
 */

import type { WebContents } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('ThemeColorExtractor')

export type ThemeColorSource = 'meta' | 'css' | 'visual' | null

export interface ThemeColorResult {
  color: string | null
  source: ThemeColorSource
}

/**
 * 注入到页面内执行的主题色提取脚本
 *
 * 策略优先级：
 * 1. <meta name="theme-color"> content
 * 2. <meta name="msapplication-navbutton-color"> content
 * 3. CSS 语义元素（header / nav）背景色
 * 4. 页面顶部多点视觉采样
 * 5. 文档背景色兜底（body / html）
 */
const EXTRACT_THEME_COLOR_SCRIPT = `
(function() {
  'use strict';

  // ============ 工具函数 ============

  /**
   * 通过 canvas 把任意 CSS 颜色字符串解析为 {r,g,b,a}。
   * 比正则更可靠：hsl / oklch / named colors / currentColor fallback 全部覆盖。
   */
  function parseColor(colorStr) {
    if (!colorStr || colorStr === 'transparent' || colorStr === 'initial' || colorStr === 'inherit' || colorStr === 'unset') {
      return null;
    }

    // 快速路径：rgb(a) 正则
    var rgbaMatch = colorStr.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:[,/]\\s*([\\d.%]+))?\\)/);
    if (rgbaMatch) {
      var a = 1;
      if (rgbaMatch[4] !== undefined) {
        a = rgbaMatch[4].indexOf('%') !== -1
          ? parseFloat(rgbaMatch[4]) / 100
          : parseFloat(rgbaMatch[4]);
      }
      return { r: Math.round(parseFloat(rgbaMatch[1])), g: Math.round(parseFloat(rgbaMatch[2])), b: Math.round(parseFloat(rgbaMatch[3])), a: a };
    }

    // 通用路径：用 canvas 2d 解析
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      var ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'rgba(0,0,0,0)'; // 重置
      ctx.fillStyle = colorStr;
      // 如果 fillStyle 没变，说明浏览器不认识这个颜色
      if (ctx.fillStyle === 'rgba(0,0,0,0)' || ctx.fillStyle === '#00000000') return null;
      ctx.fillRect(0, 0, 1, 1);
      var data = ctx.getImageData(0, 0, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] / 255 };
    } catch (e) {
      return null;
    }
  }

  function isTransparent(color) {
    return !color || color.a < 0.1;
  }

  /**
   * 排除透明色；允许纯黑/纯白以支持深色/浅色沉浸式工具栏
   */
  function isMeaningfulColor(color) {
    return color && !isTransparent(color);
  }

  function toHex(color) {
    if (!color) return null;
    var r = Math.max(0, Math.min(255, color.r)).toString(16).padStart(2, '0');
    var g = Math.max(0, Math.min(255, color.g)).toString(16).padStart(2, '0');
    var b = Math.max(0, Math.min(255, color.b)).toString(16).padStart(2, '0');
    return '#' + r + g + b;
  }

  /**
   * 标准化任意 CSS 颜色为 #rrggbb，返回 null 表示无效/透明
   */
  function normalizeColor(str) {
    if (!str) return null;
    var trimmed = str.trim();
    if (!trimmed) return null;
    // 快速路径：已经是合法 hex
    var hexMatch = trimmed.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (hexMatch) {
      var hex = hexMatch[1];
      if (hex.length === 3) {
        hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      }
      return '#' + hex.toLowerCase();
    }
    // 通用解析
    var parsed = parseColor(trimmed);
    if (parsed && !isTransparent(parsed)) {
      return toHex(parsed);
    }
    return null;
  }

  // ============ 策略 1：<meta> 声明 ============

  function getMetaThemeColor() {
    var selectors = [
      'meta[name="theme-color"]',
      'meta[name="msapplication-navbutton-color"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var meta = document.querySelector(selectors[i]);
      if (meta) {
        var color = normalizeColor(meta.getAttribute('content'));
        if (color) return color;
      }
    }
    return null;
  }

  // ============ 策略 2：CSS 语义元素背景色 ============

  function getCSSBackgroundColor() {
    var candidates = [
      document.querySelector('header'),
      document.querySelector('nav'),
      document.querySelector('[role="banner"]'),
      document.querySelector('.header'),
      document.querySelector('.navbar'),
      document.querySelector('.nav'),
      document.querySelector('#header'),
      document.querySelector('#navbar'),
      document.querySelector('#nav')
    ];

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!el) continue;
      var style = window.getComputedStyle(el);
      var bgColor = parseColor(style.backgroundColor);
      if (isMeaningfulColor(bgColor)) {
        return toHex(bgColor);
      }
    }

    return null;
  }

  function getDocumentBackgroundColor() {
    // 兜底：body
    if (document.body) {
      var bodyBg = parseColor(window.getComputedStyle(document.body).backgroundColor);
      if (isMeaningfulColor(bodyBg)) {
        return toHex(bodyBg);
      }
    }

    // 最后：html
    var htmlBg = parseColor(window.getComputedStyle(document.documentElement).backgroundColor);
    if (isMeaningfulColor(htmlBg)) {
      return toHex(htmlBg);
    }

    return null;
  }

  // ============ 策略 3：页面顶部视觉多点采样 ============

  var SKIP_TAGS = { IMG:1, IFRAME:1, VIDEO:1, SVG:1, CANVAS:1, PICTURE:1, SOURCE:1 };

  function samplePointColor(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return null;

    var maxDepth = 20; // 防止极端 DOM 树导致过深遍历
    while (el && maxDepth-- > 0) {
      var tag = el.tagName;

      // 跳过非容器类元素
      if (SKIP_TAGS[tag]) {
        el = el.parentElement;
        continue;
      }

      var style = window.getComputedStyle(el);
      var bgColor = parseColor(style.backgroundColor);

      if (isMeaningfulColor(bgColor)) {
        // body / html 代表全局背景，始终接受
        if (tag === 'BODY' || tag === 'HTML') {
          return toHex(bgColor);
        }
        var rect = el.getBoundingClientRect();
        var coversTopBand =
          rect.top <= y + 4 &&
          rect.bottom >= y &&
          rect.width >= window.innerWidth * 0.6;
        // 大 Hero 只在“不覆盖顶部主视觉区域”时跳过，避免错过首屏深色背景
        if (rect.height > 120 && !coversTopBand) {
          el = el.parentElement;
          continue;
        }
        return toHex(bgColor);
      }
      el = el.parentElement;
    }
    return null;
  }

  function getVisualTopColor() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    if (w <= 0 || h <= 0) return null;

    var xs = [w * 0.25, w * 0.50, w * 0.75];
    var ys = [5, 24, 48].filter(function(y) { return y < h; });

    var votes = {};
    var best = null;
    var bestCount = 0;

    for (var yi = 0; yi < ys.length; yi++) {
      for (var xi = 0; xi < xs.length; xi++) {
        var color = samplePointColor(xs[xi], ys[yi]);
        if (!color) continue;
        votes[color] = (votes[color] || 0) + 1;
        if (votes[color] > bestCount) {
          bestCount = votes[color];
          best = color;
        }
      }
    }

    return best;
  }

  // ============ 执行提取 ============

  var themeColor = getMetaThemeColor();
  var source = themeColor ? 'meta' : null;

  if (!themeColor) {
    themeColor = getCSSBackgroundColor();
    source = themeColor ? 'css' : null;
  }

  if (!themeColor) {
    themeColor = getVisualTopColor();
    source = themeColor ? 'visual' : null;
  }

  if (!themeColor) {
    themeColor = getDocumentBackgroundColor();
    source = themeColor ? 'css' : null;
  }

  return {
    color: themeColor || null,
    source: source
  };
})();
`

// ============ 提取 API ============

/**
 * 从 WebContents 中提取主题色
 */
export async function extractThemeColor(webContents: WebContents): Promise<ThemeColorResult> {
  if (!webContents || webContents.isDestroyed()) {
    return { color: null, source: null }
  }

  try {
    const result = await webContents.executeJavaScript(EXTRACT_THEME_COLOR_SCRIPT)

    return {
      color: result?.color || null,
      source: result?.source || null
    }
  } catch (error) {
    // 主题色提取是尽力而为的视觉增强（页面销毁/跳转中失败属正常），用 debug 避免噪声
    log.debug('提取主题色失败:', error instanceof Error ? error.message : error)
    return { color: null, source: null }
  }
}

// ============ 亮度工具（供渲染进程复用） ============

/**
 * 根据 hex 颜色计算 W3C 相对亮度 (0–1)
 */
export function hexToRelativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255

  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/**
 * 判断给定背景色上应该用浅色还是深色前景
 * @returns true 表示背景偏深，应用浅色文字
 */
export function isDarkBackground(hex: string): boolean {
  return hexToRelativeLuminance(hex) < 0.5
}
