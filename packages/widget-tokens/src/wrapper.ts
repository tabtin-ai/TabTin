/**
 * wrapper.ts — single source of truth for the widget sandbox iframe HTML
 * wrapper used by:
 *
 *   1. **Chat preview** (`apps/tabtin-electron/src/renderer/src/components/chat/
 *      RichContentRenderer.tsx`'s `wrapWidgetCode`) — rendered into the chat
 *      iframe via `srcDoc`.
 *   2. **Electron offscreen render** (`apps/tabtin-electron/src/main/services/
 *      WidgetRenderService.ts`) — written to a temp file then `loadFile`'d in
 *      the hidden BrowserWindow, then `capturePage` produces the PNG.
 *   3. **Daemon offscreen render** (`apps/tabtin-daemon/src/browser/
 *      DaemonBrowserService.ts.captureWidget`) — `page.setContent(wrapper)`
 *      then `page.screenshot()`.
 *
 * **Why a shared module**: widget RFC §四 4.2 risk #1 ("design tokens 注入和
 * chat 内 RichWidget 不一致 → 用户看到'不是真的'"). All three call sites
 * import this module so a CSS variable rename / CSP tweak / SVG fade-in
 * tweak only happens **once**.
 *
 * **Hard constraints**:
 *
 *   - **CSP must be byte-for-byte identical** between this wrapper and the
 *     `<meta http-equiv="Content-Security-Policy">` written by chat preview.
 *     Drift = "image_url renders fine but chat preview blocks scripts" or
 *     vice versa.
 *   - **`sandbox="allow-scripts"`** (no `allow-same-origin`) is set on the
 *     iframe element by the renderer side; this wrapper does NOT add a
 *     second sandbox layer to avoid double-encoding.
 *   - **Fonts must be `await document.fonts.ready`'d** before screenshot —
 *     `WidgetRenderService` and `captureWidget` enforce this. Wrapper
 *     itself does not pre-load custom fonts (uses system stack).
 *
 * Format support (Wave 6 done): `format: 'svg' | 'html' | 'mermaid'`.
 * Mermaid source is compiled to SVG by the TS runtime's
 * `prepareWidgetSource()` (see `packages/agent-runtime/src/tools/show-widget/
 * mermaid-compiler.ts`) **before** it reaches this wrapper — so wrapper
 * itself never carries Mermaid runtime, preserving the "no runtime script"
 * CSP constraint. sendPrompt support (Wave 7) lives in
 * `buildSendPromptBootstrap()` below.
 */

import { themeBundle } from './theme-bundle.js'

/**
 * **CSP — widget RFC §四 4.4 字面约束**.
 *
 * - `default-src 'none'`：默认拒绝一切外链
 * - `style-src 'unsafe-inline'`：允许 SVG inline style
 * - `script-src 'unsafe-inline'`：允许 inline script（Wave 7 sendPrompt）
 *   **不**含 https，所以外链 script 仍被拒
 * - `img-src https: data:`：允许 https 图片 + base64 data URI
 * - `font-src 'self' data:`：允许 base64 字体（不允许外链）
 *
 * 修改这条字符串前请同步：
 *   - `apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx` 内 wrapWidgetCode 的 `<meta>` 行
 *   - `packages/skills/bundled/platform/visualization/tabtin-widget/sandbox.md`
 *   - widget RFC §四 4.4
 */
export const WIDGET_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; font-src 'self' data:"

/**
 * Legacy compatibility tokens — Wave 2 上线时已经写到 SVG 里的
 * `var(--widget-fg)` / `var(--widget-bg)` / `var(--widget-accent)` 历史
 * widget code 仍要能跑（持久化的 blocks_json 不会改写）。映射到
 * 新 token 而不是删除——保持向后兼容。
 */
export const WIDGET_LEGACY_COMPAT_TOKENS =
  '--widget-fg:hsl(var(--foreground));--widget-bg:transparent;--widget-accent:hsl(var(--accent));'

/**
 * Default viewport / container width.
 *
 * widget RFC §四 4.2 wrapper 模板：680×400 是 chat panel 内 widget 卡片
 * 视觉甜点（与桌面 chat panel 600-720px 宽对齐）。SVG 内 viewBox 决定
 * 实际比例，wrapper 用 `width:680` 让 SVG 自动 fit。
 */
export const DEFAULT_VIEWPORT = {
  width: 680,
  height: 400,
} as const

export interface BuildWrapperOptions {
  /**
   * Chat UI 当前主题。决定注入 light 还是 dark 块。
   * 注入路径：`:root{<token-bundle><legacy-compat>}`，避免依赖
   * `prefers-color-scheme`（chat 用 `.dark` class 手动切换，不跟 OS）。
   */
  theme?: 'light' | 'dark'
  /**
   * 渲染容器宽（px）。用于烤图模式 `body` 给个明确宽度让 SVG 按 viewBox
   * 缩放。Chat 预览模式宽度由 iframe 容器的 CSS 决定，传 undefined 即可。
   */
  width?: number
  /**
   * Reduced motion——烤图时设 true 跳过 SVG fade-in 动画，避免截到
   * 50% 透明的"未完成态"（widget RFC §四 4.2 已知坑 + Wave 3 fade-in
   * `prefers-reduced-motion` 兜底）。
   */
  reducedMotion?: boolean
  /**
   * Lightbox 专用有限 viewport：iframe 文档内部负责二维滚动，并接收父层
   * `tabtin:preview-scale` 消息用 CSS zoom 缩放内容。默认关闭，聊天卡片和
   * Electron/Daemon 烤图继续使用原来的 content-sized 契约。
   */
  lightboxViewport?: boolean
  /**
   * **P0-1 后语义**（2026-04-30）：widgetId 只作为"是否在 wrapper 里注入
   * sendPrompt 启动脚本"的开关——**具体值不会写进 wrapper HTML 的任何位置**
   * （包括 script 源码、postMessage 协议字段、DOM 属性）。
   *
   * - 非空 string：注入 sendPrompt bootstrap script，widget 内 `window.sendPrompt`
   *   可用；postMessage 不带 widget_id（父页从 trustedFrames 反推）
   * - `undefined` / `null` / `''`：注入一个最小 no-op stub（`window.sendPrompt=
   *   function(){}`），让 widget 内 onclick="sendPrompt(...)" 调用不报 ReferenceError
   *   但确实是 no-op（offscreen 烤图 / placeholder 阶段用）
   *
   * **为什么不删除这个参数**：外部调用方（RichWidget.tsx / WidgetRenderService /
   * DaemonBrowserService）已经传真实 widgetId，用来区分"真交互"vs"烤图/placeholder"。
   * 删参数会让调用方写更多条件分支。
   */
  widgetId?: string | null
}

function normalizeWidgetBodyCode(code: string): string {
  if (!/<\s*(?:!doctype|html|head|body)\b/i.test(code)) return code
  const styleTags = code.match(/<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi)?.join('\n') ?? ''
  const bodyMatch = code.match(/<\s*body\b[^>]*>([\s\S]*?)<\s*\/\s*body\s*>/i)
  return [styleTags, bodyMatch ? bodyMatch[1] : code].filter(Boolean).join('\n')
}

export const SEND_PROMPT_TEXT_MAX_LENGTH = 1000
export const SEND_PROMPT_META_MAX_BYTES = 4 * 1024

/**
 * **P0-1 第二层安全修复（2026-04-30）**：wrapper 不再把 widget_id 写进 script 源码。
 *
 * **攻击背景**：旧实现把 widget_id 作为字面量 `var widgetId="wgt_xxx";` 注入 IIFE，
 * widget 内的恶意 script（绕过 sanitizer 或未来新 bypass）能 `document.querySelectorAll('script').textContent`
 * 读出来，然后直接 `parent.postMessage({type:'tabtin:sendPrompt', widget_id, text, timestamp}, '*')`，
 * 完全绕过 wrapper 的 `isTrusted` 手势门——因为恶意 script 并不走 `window.sendPrompt`，
 * 而是直接伪造 postMessage 协议。
 *
 * **修法（三层纵深）**：
 *
 *   1. wrapper 内 sendPrompt script 不知道自己 widget 的 widget_id / session_id
 *      （`widgetId` 参数仅作为"是否启用 sendPrompt"的布尔开关用，具体值不写入源码）
 *   2. `window.sendPrompt(text, meta)` 发出的 postMessage **不再带** widget_id /
 *      session_id / timestamp 字段。
 *   3. 父页 `widgetSendPromptHandler.ts` 通过 `event.source → trustedFrames`
 *      WeakMap 反推 widget_id + session_id，**不信任** `event.data` 里任何标识字段
 *      （即使恶意 script 伪造也无效，父页只认 registry）。
 *
 * **验证方式**：
 *   - `buildWrapper({ widgetId: 'wgt_xxx' })` 输出 grep `wgt_xxx` 必须 0 命中
 *     （widget_id 具体值不得出现在 wrapper HTML 中任何位置）
 *   - widget_id 从"广告牌"降级为"内部标识"，攻击面消失
 *
 * **行为保留**：
 *   - widgetId 缺失时依旧不注入 sendPrompt script（sandbox placeholder / 烤图路径）
 *   - text trim / 1000 字符上限 / meta 4KB 上限 / `isTrusted` 2s 手势窗口全部保留
 */
export function buildSendPromptBootstrap(widgetId?: string | null): string {
  // P0-1 修复：widgetId 只作为"启用标志"判断，具体值**不写进**返回的 JS 源码。
  //
  // **安全 Review 自修（2026-04-30）**：widgetId 缺失时注入一个最小 no-op stub
  // （而不是整段 script 空）——让 widget 内 `onclick="sendPrompt(...)"` 调用
  // 不报 ReferenceError，但确实 no-op（offscreen 烤图路径没用户点击、
  // placeholder 阶段用户手快点到 widget 时不 crash）。
  //
  // stub 对攻击面零影响：没有 widget_id 就没有 registry 映射，父页的
  // trustedFrames.get(source) 返回 undefined 直接 drop message——
  // 即使 widget 代码直接 `parent.postMessage(...)` 绕过 stub 也被父页拦。
  if (typeof widgetId !== 'string' || widgetId === '') {
    // 最小 no-op stub，不接收参数不发消息。与完整 sendPrompt 的签名一致。
    return 'window.sendPrompt=function(){};'
  }
  return [
    '(function(){',
    `var MAX_TEXT_LENGTH=${SEND_PROMPT_TEXT_MAX_LENGTH};`,
    `var MAX_META_BYTES=${SEND_PROMPT_META_MAX_BYTES};`,
    'var lastTrustedGestureAt=0;',
    'function markTrustedGesture(event){if(event&&event.isTrusted)lastTrustedGestureAt=Date.now();}',
    'document.addEventListener("click",markTrustedGesture,true);',
    'document.addEventListener("pointerup",markTrustedGesture,true);',
    'document.addEventListener("keydown",markTrustedGesture,true);',
    'function byteLength(value){',
    'try{return new TextEncoder().encode(value).length;}catch(_err){return value.length;}',
    '}',
    'window.sendPrompt=function(text,meta){',
    'try{',
    'if(typeof text!=="string")return;',
    'if(Date.now()-lastTrustedGestureAt>2000)return;',
    'var normalizedText=text.trim();',
    'if(!normalizedText)return;',
    'if(normalizedText.length>MAX_TEXT_LENGTH)normalizedText=normalizedText.slice(0,MAX_TEXT_LENGTH);',
    // P0-1 第二层：postMessage payload **不带** widget_id / session_id / timestamp —
    // 父页 (widgetSendPromptHandler.ts) 通过 event.source 反推这些字段，只信 registry。
    'var message={type:"tabtin:sendPrompt",text:normalizedText};',
    'if(meta!==undefined){',
    'var serialized=JSON.stringify(meta);',
    'if(serialized===undefined||byteLength(serialized)>MAX_META_BYTES)return;',
    'message.meta=JSON.parse(serialized);',
    '}',
    'parent.postMessage(message,"*");',
    '}catch(_err){}',
    '};',
    '})();',
  ].join('')
}

/**
 * Compose the inner `<style>` body shared between chat preview and offscreen
 * render. Exported separately so tests can assert "chat preview srcdoc and
 * offscreen render wrapper share identical style payload".
 */
export function buildWrapperStyle(options: BuildWrapperOptions = {}): string {
  const tokens = options.theme === 'dark' ? themeBundle.dark : themeBundle.light
  const widthDecl = typeof options.width === 'number' ? `body{width:${options.width}px;}` : ''
  const lightboxViewportDecl = options.lightboxViewport
    ? [
        // Lightbox：
        // - 默认 fit：双轴 contain 居中（对齐 PNG object-contain），无多余滚动条
        // - tall：按宽铺满 + 纵向滚动（高图可读，不被静默裁切）
        // #tabtin-widget-content 必须有明确宽高，svg 的 max-height:100% 才不会算成 0（白屏）
        'html,body{width:100%;height:100%;min-height:0;overflow:hidden;}',
        'body{display:flex;align-items:center;justify-content:center;overflow:hidden;box-sizing:border-box;}',
        '#tabtin-widget-content{display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-width:0;min-height:0;box-sizing:border-box;}',
        'svg{display:block;max-width:100%;max-height:100%;width:auto;height:auto;margin:0 auto;}',
        'html[data-lightbox-mode="tall"] body{display:block;overflow:auto;align-items:stretch;justify-content:flex-start;}',
        'html[data-lightbox-mode="tall"] #tabtin-widget-content{display:block;width:100%;height:auto;}',
        'html[data-lightbox-mode="tall"] svg{width:100%;max-width:100%;height:auto;max-height:none;}',
      ].join('\n')
    : ''
  // Reduced motion: 直接 `animation:none` 强行覆盖；不走 @media query —
  // OffscreenWindowPool 烤图时 BrowserWindow 默认尊重 prefers-reduced-motion=
  // no-preference，必须主动注入。
  const motionOverride = options.reducedMotion
    ? 'svg *,body{animation:none !important;}'
    : ''
  return [
    // ── 主题 token：globals.css 自动抽出（light 或 dark 二选一）+ 旧 token 映射兼容
    `:root{${tokens}${WIDGET_LEGACY_COMPAT_TOKENS}}`,
    // ── 基础结构样式
    // height:auto + min-height:0：避免 iframe 视口把 html/body 撑高后，
    // scrollHeight 只能增不能减，图示下方留下大块留白。
    'html,body{margin:0;padding:0;background:transparent;height:auto;min-height:0;}',
    'body{padding:12px;font-family:-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:hsl(var(--foreground));overflow:hidden;}',
    '*,*::before,*::after{box-sizing:border-box;}',
    'button,input,select,textarea{font:inherit;}',
    widthDecl,
    'svg{max-width:100%;height:auto;display:block;color:hsl(var(--foreground));}',
    // 默认 SVG text 用 currentColor，让 LLM 写 `<text>` 不指定 fill 时仍可读
    'svg text{fill:currentColor;}',
    lightboxViewportDecl,
    // ── Widget Wave 3：流式 fade-in 动效（动画 + forwards 终态）
    // 与 RichContentRenderer 的 wrapWidgetCode 字面一致——chat 预览和烤图
    // 视觉表现完全相同。烤图模式通过 reducedMotion=true 覆盖。
    '@keyframes widget-fade-in{from{opacity:0;}to{opacity:1;}}',
    'svg *{animation:widget-fade-in 0.2s ease-out;animation-fill-mode:forwards;}',
    'body{animation:widget-fade-in 0.2s ease-out;animation-fill-mode:forwards;}',
    // 用户系统级 prefers-reduced-motion 仍尊重（与 chat 预览一致）
    '@media (prefers-reduced-motion:reduce){svg *,body{animation:none;}}',
    // 显式 reducedMotion 覆盖（烤图路径用，确保截图不抓 50% 透明帧）
    motionOverride,
  ].join('\n')
}

/**
 * 完整 HTML 包装器——给离屏渲染（Electron WidgetRenderService loadFile +
 * Daemon page.setContent）和 chat 预览（renderer 内 wrapWidgetCode）共用。
 *
 * **不**做 sanitize——iframe sandbox + CSP 已经隔离 attack surface；双重
 * sanitize 反而会破坏 LLM 流式吐的不完整 SVG（用户期望看到 partial）。
 */
/**
 * iframe 内高度自适应脚本：ResizeObserver 监听 body 内容高度变化，通过
 * postMessage 通知父页面更新 iframe 高度。50ms 防抖避免流式更新频繁触发。
 *
 * **为什么不用 documentElement.scrollHeight**：iframe 一旦被父页设成较高
 * （初始 min-height、流式期短暂变高），html 会填满视口，scrollHeight 只增不减，
 * 矮 SVG 下方就会大块留白。改为量 children 的 getBoundingClientRect 下沿 +
 * body padding-bottom，高度可随内容缩小。
 */
export function buildResizeObserverBootstrap(): string {
  return [
    '(function(){',
    'if(window===window.parent)return;',
    'var last=0,timer;',
    'function measure(){',
    'var body=document.body;if(!body)return 0;',
    'var maxBottom=0,children=body.children;',
    'for(var i=0;i<children.length;i++){',
    'var el=children[i],tag=el.tagName;',
    'if(tag==="SCRIPT"||tag==="STYLE")continue;',
    'var bottom=el.getBoundingClientRect().bottom;',
    'if(bottom>maxBottom)maxBottom=bottom;',
    '}',
    'var padBottom=0;',
    'try{padBottom=parseFloat(getComputedStyle(body).paddingBottom)||0;}catch(_e){}',
    'return Math.ceil(maxBottom+padBottom);',
    '}',
    'function report(){',
    'clearTimeout(timer);',
    'timer=setTimeout(function(){',
    'var h=measure();',
    'if(h!==last&&h>0){last=h;parent.postMessage({type:"tabtin:resize",height:h},"*");}',
    '},50);',
    '}',
    'if(typeof ResizeObserver!=="undefined"){new ResizeObserver(report).observe(document.body);}',
    'report();',
    'window.addEventListener("load",report);',
    '})();',
  ].join('')
}

/**
 * Lightbox 父层只传有限倍率；缩放在 iframe 内完成。
 *
 * CSS zoom 会参与布局尺寸计算，因此 50% 不留下 transform spacer 空白，
 * 500% 的宽高都会扩大 body scrollWidth/scrollHeight，左侧与底部均可达。
 * 只接受 parent 发出的有限数字，不给 sandbox 增加任何权限。
 *
 * 注：Electron Lightbox 父层现用 transform:scale（对齐 PNG）；本 bootstrap
 * 仍保留，便于兼容仍发 tabtin:preview-scale 的调用方，默认 apply(1) 无副作用。
 */
export function buildPreviewScaleBootstrap(enabled = false): string {
  if (!enabled) return ''
  return [
    '(function(){',
    'var root=document.getElementById("tabtin-widget-content");',
    'if(!root)return;',
    'function apply(raw){',
    'if(typeof raw!=="number"||!Number.isFinite(raw))return;',
    'var scale=Math.max(0.5,Math.min(5,raw));',
    'root.style.zoom=String(scale);',
    '}',
    // 不校验 event.source===parent：sandbox 无 allow-same-origin 时
    // Chromium 偶发 source 为空/不可比，会静默丢掉父层缩放消息。
    // 消息类型本身已足够窄；最坏只是改 CSS zoom。
    'window.addEventListener("message",function(event){',
    'var data=event.data;',
    'if(!data||data.type!=="tabtin:preview-scale")return;',
    'apply(data.scale);',
    '});',
    'apply(1);',
    '})();',
  ].join('')
}

/**
 * Lightbox：按 SVG 固有比例在「fit / tall」间切换。
 *
 * - 全宽后高度 ≤ 视口 → fit（contain，无滚动条）
 * - 全宽后高度 > 视口 → tall（宽铺满，纵向滚动，满足 ）
 */
export function buildLightboxFitBootstrap(enabled = false): string {
  if (!enabled) return ''
  return [
    '(function(){',
    'function intrinsicSize(svg){',
    'try{var vb=svg.viewBox&&svg.viewBox.baseVal;',
    'if(vb&&vb.width>0&&vb.height>0)return{w:vb.width,h:vb.height};}catch(_e){}',
    'var w=parseFloat(svg.getAttribute("width")||"")||0;',
    'var h=parseFloat(svg.getAttribute("height")||"")||0;',
    'if(w>0&&h>0)return{w:w,h:h};',
    'try{var b=svg.getBBox();if(b&&b.width>0&&b.height>0)return{w:b.width,h:b.height};}catch(_e2){}',
    'return null;',
    '}',
    'function apply(){',
    'var root=document.getElementById("tabtin-widget-content");',
    'if(!root)return;',
    'var svg=root.querySelector("svg");',
    'if(!svg){document.documentElement.setAttribute("data-lightbox-mode","fit");return;}',
    'var size=intrinsicSize(svg);',
    'if(!size){document.documentElement.setAttribute("data-lightbox-mode","fit");return;}',
    'var cs=getComputedStyle(document.body);',
    'var padX=(parseFloat(cs.paddingLeft)||0)+(parseFloat(cs.paddingRight)||0);',
    'var padY=(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);',
    'var availW=Math.max(0,document.documentElement.clientWidth-padX);',
    'var availH=Math.max(0,document.documentElement.clientHeight-padY);',
    'if(availW<=0||availH<=0)return;',
    'var heightAtFullWidth=availW*(size.h/size.w);',
    'document.documentElement.setAttribute("data-lightbox-mode",heightAtFullWidth>availH+1?"tall":"fit");',
    '}',
    'apply();',
    'window.addEventListener("load",apply);',
    'window.addEventListener("resize",apply);',
    'if(typeof ResizeObserver!=="undefined"){new ResizeObserver(apply).observe(document.documentElement);}',
    '})();',
  ].join('')
}

export function buildWrapper(code: string, options: BuildWrapperOptions = {}): string {
  const bodyCode = normalizeWidgetBodyCode(code)
  const bootstrap = buildSendPromptBootstrap(options.widgetId)
  const previewBodyCode = options.lightboxViewport
    ? `<div id="tabtin-widget-content">${bodyCode}</div>`
    : bodyCode
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">`,
    '<script>',
    bootstrap,
    '</script>',
    '<style>',
    buildWrapperStyle(options),
    '</style>',
    '</head>',
    '<body>',
    previewBodyCode,
    '<script>',
    buildLightboxFitBootstrap(options.lightboxViewport),
    '</script>',
    '<script>',
    buildPreviewScaleBootstrap(options.lightboxViewport),
    '</script>',
    '<script>',
    buildResizeObserverBootstrap(),
    '</script>',
    '</body>',
    '</html>',
  ].join('\n')
}
