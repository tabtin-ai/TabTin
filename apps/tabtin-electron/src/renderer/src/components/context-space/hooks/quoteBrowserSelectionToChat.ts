import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'
import { crawlViewClient } from '@/crawlspace/electron/crawl-view-client'
import { emitBrowserAnnotationInject } from '@components/chat/context/browserAnnotationInjection'
import { fallbackBrowserAnnotationToDraft } from '@/services/browserAnnotationDraftFallback'
import { createContextRef, type ChatAttachment } from '@components/chat/types'

type ContextTranslator = (key: string, defaultValue: string) => string

interface BrowserAnnotationInput {
  url: string
  viewId?: string
  title?: string
  favicon?: string
  crawlspaceId?: string
  includeScreenshot?: boolean
  t?: ContextTranslator
}

interface QuoteBrowserSelectionInput extends BrowserAnnotationInput {
  text: string
}

type BrowserAnnotationKind = 'text' | 'element'
type BrowserAnnotationRect = { x: number; y: number; width: number; height: number; scroll_x?: number; scroll_y?: number }
type BrowserAnnotationCaptureRect = { x: number; y: number; width: number; height: number }

interface BrowserAnnotationMetadata {
  selection?: { kind: BrowserAnnotationKind; text: string }
  rect?: BrowserAnnotationRect
  captureRect?: BrowserAnnotationCaptureRect
  viewport?: { width: number; height: number }
  dom?: {
    tag?: string
    role?: string
    text?: string
    aria_label?: string
    selector?: string
    xpath?: string
    outer_html_preview?: string
  }
  /**
   * ：注释落点区域的内容快照。框选那一刻在原 tab（带完整登录态与渲染现场）
   * 采集，穿透 open shadow DOM——「获取注释内容」类请求无需 Agent 再开浏览器。
   */
  content?: { text: string; truncated?: boolean }
}

interface BrowserAnnotationTheme {
  primary: string
  primaryForeground: string
}

type ExecuteScriptResponse = { success: boolean; result?: unknown; error?: string }
type ScreenshotResponse = { success: boolean; data?: string; error?: string }

function translate(t: ContextTranslator | undefined, key: string, defaultValue: string): string {
  return t ? t(key, defaultValue) : i18n.t(key, { ns: 'context', defaultValue })
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function buildAnnotationIdentity(url: string, metadata: BrowserAnnotationMetadata, fallbackText: string): string {
  const domKey = metadata.dom?.selector || metadata.dom?.xpath || metadata.dom?.tag || ''
  const selectionKind = metadata.selection?.kind || 'element'
  const selectionText = selectionKind === 'text'
    ? (metadata.selection?.text || fallbackText).slice(0, 200)
    : ''
  const textRect = selectionKind === 'text' && metadata.rect
    ? [metadata.rect.x, metadata.rect.y, metadata.rect.width, metadata.rect.height]
    : null
  return JSON.stringify([
    url,
    selectionKind,
    domKey,
    selectionText,
    textRect,
  ])
}

/**
 * 页面内容快照采集片段。
 *
 * 与 innerText/textContent 的区别：按「扁平树」语义穿透 open shadow DOM——
 * 命中 shadowRoot 时走 shadowRoot（slot 处回接 assignedNodes），否则走 light DOM。
 * B 站评论区（bili-comments 多层嵌套 shadow）这类 Web Components 站点上，
 * innerText 取出来是空白，而快照能拿到真实可读文本。
 * 体量由 maxChars 限幅（超出置 truncated），跳过 script/style/noscript/template
 * 与 aria-hidden 子树。
 *
 * 导出仅供单测直接求值验证穿透语义；运行时只作为脚本片段注入页面。
 */
export const CONTENT_SNAPSHOT_SNIPPET = `
  function collectContentSnapshot(root, maxChars) {
    let out = '';
    let truncated = false;
    function push(raw) {
      if (truncated) return;
      const t = String(raw || '').replace(/\\s+/g, ' ').trim();
      if (!t) return;
      const sep = out ? ' ' : '';
      if (out.length + sep.length + t.length > maxChars) {
        const remain = maxChars - out.length - sep.length;
        if (remain > 0) out += sep + t.slice(0, remain);
        truncated = true;
        return;
      }
      out += sep + t;
    }
    function walk(node, depth) {
      if (!node || truncated || depth > 64) return;
      if (node.nodeType === Node.TEXT_NODE) { push(node.textContent); return; }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
        if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
        if (tag === 'SLOT' && typeof node.assignedNodes === 'function') {
          const assigned = node.assignedNodes({ flatten: true });
          for (let i = 0; i < assigned.length; i += 1) walk(assigned[i], depth + 1);
          return;
        }
        if (node.shadowRoot) {
          const kids = node.shadowRoot.childNodes;
          for (let i = 0; i < kids.length; i += 1) walk(kids[i], depth + 1);
          return;
        }
      }
      const children = node.childNodes;
      for (let i = 0; i < children.length; i += 1) walk(children[i], depth + 1);
    }
    walk(root, 0);
    return { text: out, truncated: truncated };
  }
`

/** 快照体量上限（字符）。Django 侧按 ref 预算再做 token 级截断兜底。 */
const CONTENT_SNAPSHOT_MAX_CHARS = 8000

const SELECTION_ANNOTATION_SCRIPT = `(() => {
  const selection = window.getSelection();
  const text = (selection?.toString() || '').trim();
  if (!selection || selection.rangeCount === 0 || !text) return null;
  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const fallbackRect = range.getBoundingClientRect();
  if (rects.length === 0 && !(fallbackRect.width > 0 && fallbackRect.height > 0)) return null;
  const allRects = rects.length > 0 ? rects : [fallbackRect];
  const left = Math.max(0, Math.min(...allRects.map((rect) => rect.left)));
  const top = Math.max(0, Math.min(...allRects.map((rect) => rect.top)));
  const right = Math.min(window.innerWidth, Math.max(...allRects.map((rect) => rect.right)));
  const bottom = Math.min(window.innerHeight, Math.max(...allRects.map((rect) => rect.bottom)));
  const padding = 8;
  const captureLeft = Math.max(0, left - padding);
  const captureTop = Math.max(0, top - padding);
  const captureRight = Math.min(window.innerWidth, right + padding);
  const captureBottom = Math.min(window.innerHeight, bottom + padding);

  const rawNode = range.commonAncestorContainer;
  const element = (rawNode.nodeType === Node.ELEMENT_NODE ? rawNode : rawNode.parentElement);

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/["\\\\#.:?[\\]()>+~*'=|\\s]/g, '\\\\$&');
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) return '#' + cssEscape(el.id);
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      current = current.parentElement;
      if (parts.length >= 8) break;
    }
    return parts.length ? parts.join(' > ') : '';
  }

  function xpathFor(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = current.previousSibling;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === current.nodeName) index += 1;
        sibling = sibling.previousSibling;
      }
      parts.unshift(current.nodeName.toLowerCase() + '[' + index + ']');
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }

  const elementText = (element?.innerText || element?.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
  const outerHtml = (element?.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 500);

  return {
    selection: { kind: 'text', text },
    rect: {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(1, Math.round(right - left)),
      height: Math.max(1, Math.round(bottom - top)),
      scroll_x: Math.round(window.scrollX || 0),
      scroll_y: Math.round(window.scrollY || 0),
    },
    captureRect: {
      x: Math.round(captureLeft),
      y: Math.round(captureTop),
      width: Math.max(1, Math.round(captureRight - captureLeft)),
      height: Math.max(1, Math.round(captureBottom - captureTop)),
    },
    viewport: {
      width: Math.max(1, Math.round(window.innerWidth || 1)),
      height: Math.max(1, Math.round(window.innerHeight || 1)),
    },
    dom: element ? {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      text: elementText,
      aria_label: element.getAttribute('aria-label') || '',
      selector: selectorFor(element),
      xpath: xpathFor(element),
      outer_html_preview: outerHtml,
    } : undefined,
  };
})()`

function getBrowserAnnotationTheme(): BrowserAnnotationTheme {
  if (typeof document === 'undefined') {
    return { primary: '215 65% 52%', primaryForeground: '0 0% 99%' }
  }
  const style = getComputedStyle(document.documentElement)
  return {
    primary: style.getPropertyValue('--primary').trim() || '215 65% 52%',
    primaryForeground: style.getPropertyValue('--primary-foreground').trim() || '0 0% 99%',
  }
}

function buildElementAnnotationScript(theme: BrowserAnnotationTheme): string {
  const themeLiteral = JSON.stringify(theme).replace(/</g, '\\u003c')
  return `(() => new Promise((resolve) => {
  const annotationTheme = ${themeLiteral};
  function themeHsl(value, alpha) {
    return alpha == null ? 'hsl(' + value + ')' : 'hsl(' + value + ' / ' + alpha + ')';
  }
  const cleanupKey = '__tabtinBrowserAnnotationCleanup__';
  const cancelKey = '__tabtinBrowserAnnotationCancel__';
  if (typeof window[cleanupKey] === 'function') {
    try { window[cleanupKey](); } catch {}
  }
  const existing = document.getElementById('__tabtin_browser_annotation_overlay__');
  if (existing) existing.remove();

  const cursorClass = '__tabtin_browser_annotation_active__';
  const cursorStyle = document.createElement('style');
  cursorStyle.textContent = 'html.' + cursorClass + ' *, html.' + cursorClass + ' { cursor: crosshair !important; }';

  const overlay = document.createElement('div');
  overlay.id = '__tabtin_browser_annotation_overlay__';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '2147483647';
  overlay.style.pointerEvents = 'none';
  overlay.style.cursor = 'crosshair';
  overlay.style.background = 'transparent';

  const highlight = document.createElement('div');
  highlight.style.position = 'fixed';
  highlight.style.border = '2px solid ' + themeHsl(annotationTheme.primary);
  highlight.style.background = themeHsl(annotationTheme.primary, 0.14);
  highlight.style.boxShadow = '0 0 0 1px ' + themeHsl(annotationTheme.primary, 0.20) + ', 0 12px 40px ' + themeHsl(annotationTheme.primary, 0.18);
  highlight.style.borderRadius = '6px';
  highlight.style.pointerEvents = 'none';
  highlight.style.display = 'none';
  highlight.style.transition = 'left 120ms ease, top 120ms ease, width 120ms ease, height 120ms ease, opacity 120ms ease';
  highlight.style.opacity = '0';

  const label = document.createElement('div');
  label.style.position = 'fixed';
  label.style.padding = '3px 7px';
  label.style.borderRadius = '999px';
  label.style.background = 'rgba(15, 23, 42, 0.86)';
  label.style.color = themeHsl(annotationTheme.primary);
  label.style.font = '12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  label.style.pointerEvents = 'none';
  label.style.display = 'none';
  label.style.backdropFilter = 'blur(8px)';
  label.style.boxShadow = '0 8px 24px rgba(15, 23, 42, 0.18)';

  overlay.appendChild(highlight);
  overlay.appendChild(label);
  overlay.appendChild(cursorStyle);
  document.documentElement.appendChild(overlay);
  const previousCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = 'crosshair';
  document.documentElement.classList.add(cursorClass);

  let currentElement = null;
  let currentRect = null;
  let done = false;

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/["\\\\#.:?[\\]()>+~*'=|\\s]/g, '\\\\$&');
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) return '#' + cssEscape(el.id);
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      current = current.parentElement;
      if (parts.length >= 8) break;
    }
    return parts.length ? parts.join(' > ') : '';
  }

  function xpathFor(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = current.previousSibling;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === current.nodeName) index += 1;
        sibling = sibling.previousSibling;
      }
      parts.unshift(current.nodeName.toLowerCase() + '[' + index + ']');
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }

  function cleanup() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.clearTimeout(timeoutId);
    overlay.remove();
    document.documentElement.style.cursor = previousCursor;
    document.documentElement.classList.remove(cursorClass);
    if (window[cleanupKey] === cleanup) {
      delete window[cleanupKey];
    }
    if (window[cancelKey] === cancel) {
      delete window[cancelKey];
    }
  }

  window[cleanupKey] = cleanup;

  function finish(value) {
    if (done) return;
    done = true;
    cleanup();
    resolve(value);
  }

  function cancel() {
    finish(null);
  }

  window[cancelKey] = cancel;

  ${CONTENT_SNAPSHOT_SNIPPET}

  function captureForElement(element, rect) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (!(right > left && bottom > top)) return null;
    const padding = 8;
    const captureLeft = Math.max(0, left - padding);
    const captureTop = Math.max(0, top - padding);
    const captureRight = Math.min(window.innerWidth, right + padding);
    const captureBottom = Math.min(window.innerHeight, bottom + padding);
    const text = (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
    const outerHtml = (element.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 500);
    let content = null;
    try {
      const snapshot = collectContentSnapshot(element, ${CONTENT_SNAPSHOT_MAX_CHARS});
      if (snapshot && snapshot.text) content = snapshot;
    } catch (err) {
      // 快照失败不阻断注释主流程（rect/dom/截图仍可用）
      content = null;
    }
    return {
      // shadow DOM 宿主（如 bili-comments）innerText 为空，退快照文本再退 tagName，
      // 让选中文本预览始终可读。
      selection: { kind: 'element', text: text || (content ? content.text.slice(0, 200) : '') || element.tagName.toLowerCase() },
      content: content || undefined,
      rect: {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.max(1, Math.round(right - left)),
        height: Math.max(1, Math.round(bottom - top)),
        scroll_x: Math.round(window.scrollX || 0),
        scroll_y: Math.round(window.scrollY || 0),
      },
      captureRect: {
        x: Math.round(captureLeft),
        y: Math.round(captureTop),
        width: Math.max(1, Math.round(captureRight - captureLeft)),
        height: Math.max(1, Math.round(captureBottom - captureTop)),
      },
      viewport: {
        width: Math.max(1, Math.round(window.innerWidth || 1)),
        height: Math.max(1, Math.round(window.innerHeight || 1)),
      },
      dom: {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        text,
        aria_label: element.getAttribute('aria-label') || '',
        selector: selectorFor(element),
        xpath: xpathFor(element),
        outer_html_preview: outerHtml,
      },
    };
  }

  function resolveElementAtPoint(event) {
    const x = event.clientX;
    const y = event.clientY;
    const elements = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(x, y)
      : [event.target];
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    let fallback = null;
    for (const element of elements) {
      if (!element || element === overlay || overlay.contains(element)) continue;
      if (element === document.documentElement || element === document.body) continue;
      if (element.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = element.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      if (!fallback) fallback = element;
      const area = rect.width * rect.height;
      if (area <= viewportArea * 0.75) return element;
    }
    return fallback || event.target;
  }

  function updateHighlight(element) {
    if (!element || element === overlay || overlay.contains(element)) return;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    currentElement = element;
    currentRect = rect;
    highlight.style.display = 'block';
    highlight.style.opacity = '1';
    highlight.style.left = Math.max(0, rect.left) + 'px';
    highlight.style.top = Math.max(0, rect.top) + 'px';
    highlight.style.width = Math.max(1, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left)) + 'px';
    highlight.style.height = Math.max(1, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top)) + 'px';
    label.style.display = 'block';
    label.style.left = Math.max(8, Math.min(window.innerWidth - 240, rect.left)) + 'px';
    label.style.top = Math.max(8, rect.top - 30) + 'px';
    label.textContent = '<' + element.tagName.toLowerCase() + '>  Click to add  ·  Esc to cancel';
  }

  function onMove(event) {
    updateHighlight(resolveElementAtPoint(event));
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const element = resolveElementAtPoint(event);
    if (element) updateHighlight(element);
    if (!currentElement || !currentRect) {
      finish(null);
      return;
    }
    finish(captureForElement(currentElement, currentRect));
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    }
  }

  function onScroll() {
    if (currentElement) updateHighlight(currentElement);
  }

  const timeoutId = window.setTimeout(() => finish(null), 60000);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
}))()`
}

function base64ToFile(base64: string, filename: string, mimeType: string): File {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], filename, { type: mimeType })
}

function createAnnotationAttachment(file: File, annotationId: string): ChatAttachment {
  const previewUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(file)
    : undefined
  return {
    id: `browser-annotation-${annotationId}`,
    file,
    filename: file.name,
    mimeType: file.type || 'image/png',
    size: file.size,
    type: 'image',
    status: 'pending',
    previewUrl,
  }
}

async function injectBrowserAnnotationToChat({
  metadata,
  url,
  viewId,
  title,
  favicon,
  crawlspaceId,
  fallbackText,
  includeScreenshot = false,
  t,
}: BrowserAnnotationInput & {
  metadata: BrowserAnnotationMetadata
  fallbackText: string
}): Promise<boolean> {
  const annotationKey = buildAnnotationIdentity(url, metadata, fallbackText)
  // 含截图时给 annotationId 拼一个每次唯一的后缀，避免同 url/同元素的二次截图被
  // ChatInput 的 attachment 去重逻辑（按 att.id 去重）丢弃。截图是快照，每次都应
  // 是一张新附件；纯 DOM 注释（无截图）保留稳定 annotationId，仍按元素身份去重。
  const attachmentIdSuffix = includeScreenshot
    ? `-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    : ''
  const annotationId = `ann-${stableHash(annotationKey)}${attachmentIdSuffix}`
  let attachment: ChatAttachment | undefined
  if (includeScreenshot) {
    const screenshot = await crawlViewClient.screenshot({ format: 'png' }, viewId) as ScreenshotResponse
    if (!screenshot?.success || !screenshot.data) {
      throw new Error(screenshot?.error || 'screenshot unavailable')
    }
    const file = base64ToFile(screenshot.data, `browser-annotation-${annotationId}.png`, 'image/png')
    attachment = createAnnotationAttachment(file, annotationId)
  }
  const pageTitle = title || url
  const preview = (metadata.selection?.text || fallbackText || pageTitle).slice(0, 2000)
  const contextRef = createContextRef('web_annotation', url, pageTitle, {
    tabType: 'tabweb',
    meta: {
      preview,
      url,
      pageTitle,
      annotationId,
      annotationKey,
      selection: metadata.selection || { kind: 'element', text: preview },
      rect: metadata.rect,
      dom: metadata.dom,
      ...(metadata.content?.text ? { contentSnapshot: metadata.content } : {}),
      ...(attachment ? {
        screenshotAttachmentId: attachment.id,
        screenshotFilename: attachment.filename,
      } : {}),
      ...(favicon ? { favicon } : {}),
      ...(crawlspaceId ? { crawlspaceId } : {}),
    },
  })

  const consumed = emitBrowserAnnotationInject({ contextRef, attachment })
  if (consumed) {
    toast({ title: translate(t, 'quoteSelection.success', '已引用网页注释到对话') })
    return true
  }

  // ：没有任何对话 composer 接住（工作台全屏浏览器场景）——
  // 自动开新任务草稿承接引用，而不是静默丢弃 + 谎报成功。
  const routed = fallbackBrowserAnnotationToDraft({
    contextRef,
    attachment,
    sourceUrl: url,
    sourceTitle: pageTitle,
  })
  if (!routed) {
    toast({
      title: translate(t, 'quoteSelection.fallbackFailed', '无法引用网页注释：没有可用的对话'),
      variant: 'destructive',
    })
    return false
  }
  toast({ title: translate(t, 'quoteSelection.fallbackSuccess', '已创建新任务并引用网页注释') })
  return true
}

export async function quoteBrowserSelectionToChat({
  text,
  url,
  viewId,
  title,
  favicon,
  crawlspaceId,
  t,
}: QuoteBrowserSelectionInput): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed) {
    toast({
      title: translate(t, 'quoteSelection.empty', '请先在网页中选中文本'),
      variant: 'destructive',
    })
    return false
  }

  if (!viewId) {
    toast({
      title: translate(t, 'quoteSelection.captureFailed', '无法截取网页注释'),
      variant: 'destructive',
    })
    return false
  }

  try {
    const metadataResult = await crawlViewClient.executeScript(SELECTION_ANNOTATION_SCRIPT, viewId) as ExecuteScriptResponse
    const metadata = metadataResult?.success ? metadataResult.result as BrowserAnnotationMetadata | null : null
    if (!metadata?.captureRect) {
      throw new Error(metadataResult?.error || 'selection rect unavailable')
    }

    return await injectBrowserAnnotationToChat({
      metadata,
      url,
      viewId,
      title,
      favicon,
      crawlspaceId,
      fallbackText: trimmed,
      t,
    })
  } catch (err) {
    toast({
      title: translate(t, 'quoteSelection.captureFailed', '无法截取网页注释'),
      description: err instanceof Error ? err.message : undefined,
      variant: 'destructive',
    })
    return false
  }
}

export async function cancelBrowserAnnotationToChat(viewId?: string): Promise<boolean> {
  if (!viewId) return false
  try {
    const result = await crawlViewClient.cancelAnnotation(viewId) as ExecuteScriptResponse
    return Boolean(result?.success && result.result)
  } catch {
    return false
  }
}

export async function captureBrowserViewportToChat({
  url,
  viewId,
  title,
  favicon,
  crawlspaceId,
  t,
}: BrowserAnnotationInput): Promise<boolean> {
  if (!url || url === 'about:blank' || !viewId) {
    toast({
      title: translate(t, 'quoteSelection.captureFailed', '无法截取网页注释'),
      variant: 'destructive',
    })
    return false
  }

  try {
    const metadata: BrowserAnnotationMetadata = {
      selection: { kind: 'element', text: title || url },
      dom: {
        tag: 'viewport',
        text: title || url,
      },
    }
    return await injectBrowserAnnotationToChat({
      metadata,
      url,
      viewId,
      title,
      favicon,
      crawlspaceId,
      fallbackText: title || url,
      includeScreenshot: true,
      t,
    })
  } catch (err) {
    toast({
      title: translate(t, 'quoteSelection.captureFailed', '无法截取网页注释'),
      description: err instanceof Error ? err.message : undefined,
      variant: 'destructive',
    })
    return false
  }
}

export async function startBrowserAnnotationToChat({
  url,
  viewId,
  title,
  favicon,
  crawlspaceId,
  includeScreenshot,
  t,
}: BrowserAnnotationInput): Promise<boolean> {
  if (!url || url === 'about:blank' || !viewId) {
    toast({
      title: translate(t, 'quoteSelection.captureFailed', '无法截取网页注释'),
      variant: 'destructive',
    })
    return false
  }

  try {
    toast({ title: translate(t, 'quoteSelection.pickElement', '点击页面元素以添加网页注释，按 Esc 取消') })
    const metadataResult = await crawlViewClient.executeScript(
      buildElementAnnotationScript(getBrowserAnnotationTheme()),
      viewId,
    ) as ExecuteScriptResponse
    const metadata = metadataResult?.success ? metadataResult.result as BrowserAnnotationMetadata | null : null
    if (!metadata) {
      toast({ title: translate(t, 'quoteSelection.cancelled', '已取消网页注释') })
      return false
    }
    return await injectBrowserAnnotationToChat({
      metadata,
      url,
      viewId,
      title,
      favicon,
      crawlspaceId,
      fallbackText: title || url,
      includeScreenshot,
      t,
    })
  } catch (err) {
    toast({
      title: translate(t, 'quoteSelection.captureFailed', '无法截取网页注释'),
      description: err instanceof Error ? err.message : undefined,
      variant: 'destructive',
    })
    return false
  }
}
