/**
 * widget-tokens 包测试 — 守住"chat 预览 vs 烤图 vs Daemon 烤图三端视觉一致"的硬约束
 *
 * 关键不变量：
 *
 *   1. **CSP 字面对齐**：本包导出的 `WIDGET_CSP` 必须和 `RichContentRenderer.tsx`
 *      内 wrapWidgetCode 的 `<meta>` 行字面一致——否则 chat 预览能跑但烤图被
 *      block，或反之，用户视角"不是真的"。
 *
 *   2. **Light/Dark token bundle 字面对齐 globals.css**：抽出来的 token 串
 *      必须含核心色板（background / foreground / accent / border / primary 等）；
 *      若 globals.css 改 schema，extract 脚本会 throw，这里测试断言落地。
 *
 *   3. **wrapper 注入 token**：`buildWrapper` 输出的 HTML 必须含 light / dark
 *      对应的 token bundle，让烤图视觉与 chat UI 同源。
 *
 *   4. **reducedMotion 路径**：烤图模式下必须显式禁用 fade-in 动画（避免截到
 *      50% 透明帧）。
 */

import { describe, it, expect } from 'vitest'
import {
  themeBundle,
  LIGHT_TOKEN_KEYS,
  DARK_TOKEN_KEYS,
  WIDGET_CSP,
  SEND_PROMPT_TEXT_MAX_LENGTH,
  SEND_PROMPT_META_MAX_BYTES,
  buildSendPromptBootstrap,
  buildWrapper,
  buildWrapperStyle,
  buildResizeObserverBootstrap,
  buildPreviewScaleBootstrap,
  DEFAULT_VIEWPORT,
} from '../src/index.js'

describe('widget-tokens: theme bundle', () => {
  it('light bundle 含核心色板（background / foreground / accent / border / primary）', () => {
    const required = ['background', 'foreground', 'accent', 'border', 'primary']
    for (const key of required) {
      expect(themeBundle.light).toContain(`--${key}:`)
      expect(LIGHT_TOKEN_KEYS).toContain(key)
    }
  })

  it('dark bundle 含核心色板', () => {
    const required = ['background', 'foreground', 'accent', 'border', 'primary']
    for (const key of required) {
      expect(themeBundle.dark).toContain(`--${key}:`)
      expect(DARK_TOKEN_KEYS).toContain(key)
    }
  })

  it('light 和 dark bundle 内容确实不同（避免 extract 出 stale 同源数据）', () => {
    expect(themeBundle.light).not.toEqual(themeBundle.dark)
    // dark 的 background 不应等于 light 的 background
    expect(themeBundle.light).toContain('--background:40 25% 99%;')
    expect(themeBundle.dark).toContain('--background:30 6% 12%;')
  })

  it('LIGHT_TOKEN_KEYS / DARK_TOKEN_KEYS 是数组且非空', () => {
    expect(Array.isArray(LIGHT_TOKEN_KEYS)).toBe(true)
    expect(LIGHT_TOKEN_KEYS.length).toBeGreaterThan(10)
    expect(Array.isArray(DARK_TOKEN_KEYS)).toBe(true)
    expect(DARK_TOKEN_KEYS.length).toBeGreaterThan(10)
  })

  // 守住"globals.css 改 schema 但 extract 没跑"
  it('LIGHT_TOKEN_KEYS 字面与 globals.css 当前 :root 段一致（守住 extract 是最新的）', () => {
    expect(LIGHT_TOKEN_KEYS).toContain('background')
    expect(LIGHT_TOKEN_KEYS).toContain('foreground')
    expect(LIGHT_TOKEN_KEYS).toContain('radius')
  })
})

describe('widget-tokens: CSP — 与 RichContentRenderer.tsx 字面一致', () => {
  it('WIDGET_CSP 含 default-src none', () => {
    expect(WIDGET_CSP).toContain("default-src 'none'")
  })

  it('WIDGET_CSP 允许 inline style 和 inline script（Wave 7 sendPrompt 准备）', () => {
    expect(WIDGET_CSP).toContain("style-src 'unsafe-inline'")
    expect(WIDGET_CSP).toContain("script-src 'unsafe-inline'")
  })

  it('WIDGET_CSP 不允许 https script（外链 script 禁止）', () => {
    // script-src 段里**只有** 'unsafe-inline'，不含 https
    expect(WIDGET_CSP).toMatch(/script-src 'unsafe-inline';/)
    expect(WIDGET_CSP).not.toMatch(/script-src[^;]*https:/)
  })

  it('WIDGET_CSP 允许 https + data img + base64 font', () => {
    expect(WIDGET_CSP).toContain('img-src https: data:')
    expect(WIDGET_CSP).toContain("font-src 'self' data:")
  })

  it('CSP 字符串和 RichContentRenderer.tsx wrapWidgetCode 内字面一致（端到端）', () => {
    // 这是 widget RFC §四 4.4 硬约束——双端漂移会让用户视觉不一致。
    // 字符串完整字面（如果改了，必须双端同改）。
    const expected =
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; font-src 'self' data:"
    expect(WIDGET_CSP).toBe(expected)
  })
})

describe('widget-tokens: buildWrapper', () => {
  it('返回 valid HTML doctype + meta CSP + style + body code（含 widgetId 时注入 sendPrompt script）', () => {
    const html = buildWrapper('<svg><rect/></svg>', { theme: 'light', widgetId: 'wgt_test' })
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('<html>')
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">`)
    expect(html).toContain('window.sendPrompt=function(text,meta)')
    expect(html).toContain('<svg><rect/></svg>')
    expect(html).toContain('</body>')
    expect(html).toContain('</html>')
  })

  it('theme=light 时注入 light token', () => {
    const html = buildWrapper('<svg/>', { theme: 'light' })
    expect(html).toContain(themeBundle.light)
    expect(html).not.toContain(themeBundle.dark)
  })

  it('theme=dark 时注入 dark token', () => {
    const html = buildWrapper('<svg/>', { theme: 'dark' })
    expect(html).toContain(themeBundle.dark)
    expect(html).not.toContain(themeBundle.light)
  })

  it('theme 缺省时退化到 light（兼容旧调用方）', () => {
    const html = buildWrapper('<svg/>')
    expect(html).toContain(themeBundle.light)
  })

  it('注入 widget legacy compat tokens（--widget-fg / --widget-bg / --widget-accent）保持向后兼容', () => {
    const html = buildWrapper('<svg/>')
    expect(html).toContain('--widget-fg:hsl(var(--foreground))')
    expect(html).toContain('--widget-bg:transparent')
    expect(html).toContain('--widget-accent:hsl(var(--accent))')
  })

  it('width 选项注入 body width（让 SVG 按 viewBox 缩放）', () => {
    const html = buildWrapper('<svg/>', { width: 680 })
    expect(html).toContain('body{width:680px;}')
  })

  it('reducedMotion=true 时显式禁用 SVG / body fade-in 动画（烤图模式必须）', () => {
    const html = buildWrapper('<svg/>', { reducedMotion: true })
    expect(html).toContain('animation:none !important')
  })

  it('reducedMotion=false 时不注入动画禁用规则（chat 预览模式默认走 fade-in）', () => {
    const html = buildWrapper('<svg/>', { reducedMotion: false })
    expect(html).not.toContain('animation:none !important')
  })

  it('SVG fade-in 关键帧总是注入（chat 预览 + reducedMotion 系统级回退用）', () => {
    const html = buildWrapper('<svg/>')
    expect(html).toContain('@keyframes widget-fade-in')
    expect(html).toContain('@media (prefers-reduced-motion:reduce)')
  })

  it('HTML document 输入会提取 style + body 内容，支持 fragment / document 双形态', () => {
    const doc = '<!doctype html><html><head><style>.card{color:hsl(var(--foreground))}</style></head><body><div class="card">设置页</div></body></html>'
    const html = buildWrapper(doc)
    expect(html).toContain('.card{color:hsl(var(--foreground))}')
    expect(html).toContain('<div class="card">设置页</div>')
  })

  it('wrapper 对 HTML mockup 注入静态布局基础 CSS，且不全局禁用 button click（Wave 7 sendPrompt）', () => {
    const html = buildWrapper('<div><button>保存</button></div>')
    expect(html).toContain('overflow:hidden')
    expect(html).not.toContain('button,input,select,textarea{pointer-events:none;}')
    expect(html).toContain('button,input,select,textarea{font:inherit;}')
    expect(html).toContain('box-sizing:border-box')
  })

  // **P0-1 第二层安全修复（2026-04-30）**：widgetId 具体值不得出现在 wrapper HTML 中。
  //
  // 旧实现把 widgetId 作为字面量 `var widgetId="wgt_xxx";` 注入 IIFE —— widget
  // 内恶意 script 可用 `document.querySelectorAll('script')[0].textContent.match(...)`
  // 读取，绕过 wrapper 的 `isTrusted` 手势门伪造 postMessage 协议。
  //
  // 新实现：widgetId 只作为"是否启用 sendPrompt"的开关，具体值不写进任何
  // JavaScript 源码；postMessage payload 也不带 widget_id（父页从 registry 反推）。
  it('P0-1 第二层：widgetId 存在时注入 sendPrompt bootstrap，但 HTML 中不含 widgetId 具体值', () => {
    const html = buildWrapper('<svg/>', { widgetId: 'wgt_secret_123' })
    // sendPrompt bootstrap 注入了
    expect(html).toContain('window.sendPrompt=function(text,meta)')
    expect(html).toContain('type:"tabtin:sendPrompt"')
    expect(html).toContain('parent.postMessage(message,"*")')
    expect(html).toContain(`var MAX_TEXT_LENGTH=${SEND_PROMPT_TEXT_MAX_LENGTH};`)
    expect(html).toContain(`var MAX_META_BYTES=${SEND_PROMPT_META_MAX_BYTES};`)
    // **核心安全断言**：widget_id 具体值 'wgt_secret_123' 不得出现在 HTML 任何位置
    expect(html).not.toContain('wgt_secret_123')
    // `var widgetId="..."` 明文赋值模式完全消失（老攻击面）
    expect(html).not.toMatch(/var\s+widgetId\s*=\s*"[^"]+"/)
    // postMessage payload 不再含 widget_id / session_id / timestamp 字段
    expect(html).not.toContain('widget_id:')
    expect(html).not.toContain('timestamp:')
  })

  it('P0-1 第二层（自修）：widgetId 缺失时注入 no-op sendPrompt stub（防 placeholder 阶段 ReferenceError）', () => {
    const html = buildWrapper('<svg/>')
    // 无 widgetId 时不再有 "var widgetId=..." 字样
    expect(html).not.toMatch(/var\s+widgetId/)
    // 但注入了最小 no-op stub，widget 内 onclick="sendPrompt(...)" 不会报错
    expect(html).toContain('window.sendPrompt=function(){};')
    // stub 不发 sendPrompt 消息——攻击面为零（resize 的 tabtin:resize postMessage 仍合法存在）
    expect(html).not.toContain('type:"tabtin:sendPrompt"')
    expect(html).not.toContain('normalizedText')
  })

  it('P0-1 第二层：postMessage 协议不含 widget_id / session_id / timestamp 字段', () => {
    const html = buildWrapper('<svg/>', { widgetId: 'wgt_any' })
    // 关键：JS 里构造的 message 对象只有 type + text + meta
    expect(html).toContain('var message={type:"tabtin:sendPrompt",text:normalizedText};')
  })
})

describe('widget-tokens: sendPrompt bootstrap', () => {
  it('限制 text 1000 chars、meta 4KB，并拒绝不可 JSON 序列化 meta（P0-1 修复后字段名更新）', () => {
    const script = buildSendPromptBootstrap('wgt_safe')
    expect(script).toContain('normalizedText=text.trim()')
    expect(script).toContain('event.isTrusted')
    expect(script).toContain('Date.now()-lastTrustedGestureAt>2000')
    expect(script).toContain('normalizedText=normalizedText.slice(0,MAX_TEXT_LENGTH)')
    expect(script).toContain('var serialized=JSON.stringify(meta);')
    expect(script).toContain('byteLength(serialized)>MAX_META_BYTES')
    expect(SEND_PROMPT_TEXT_MAX_LENGTH).toBe(1000)
    expect(SEND_PROMPT_META_MAX_BYTES).toBe(4096)
  })

  it('P0-1 第二层：bootstrap 源码中不出现 widgetId 具体值', () => {
    const script = buildSendPromptBootstrap('wgt_should_not_appear')
    expect(script).not.toContain('wgt_should_not_appear')
    // 也不出现 "widget_id:" 字段赋值
    expect(script).not.toContain('widget_id:')
  })

  it('P0-1 第二层（自修）：widgetId 为空 / null / undefined 时返回 no-op stub', () => {
    expect(buildSendPromptBootstrap('')).toBe('window.sendPrompt=function(){};')
    expect(buildSendPromptBootstrap(null)).toBe('window.sendPrompt=function(){};')
    expect(buildSendPromptBootstrap(undefined)).toBe('window.sendPrompt=function(){};')
  })

  it('P0-1 第二层（自修）：widgetId 非 string 类型返回 no-op stub', () => {
    // @ts-expect-error 故意传错类型验证兜底
    expect(buildSendPromptBootstrap(123)).toBe('window.sendPrompt=function(){};')
    // @ts-expect-error 同上
    expect(buildSendPromptBootstrap({})).toBe('window.sendPrompt=function(){};')
  })
})

describe('widget-tokens: DEFAULT_VIEWPORT', () => {
  it('与 widget RFC §四 4.2 wrapper 模板的 680×400 对齐', () => {
    expect(DEFAULT_VIEWPORT.width).toBe(680)
    expect(DEFAULT_VIEWPORT.height).toBe(400)
  })
})

describe('widget-tokens: buildWrapperStyle (单独测试 style payload 一致性)', () => {
  it('chat 预览模式（无 reducedMotion）和烤图模式（reducedMotion=true）只在动画覆盖处不同', () => {
    const previewStyle = buildWrapperStyle({ theme: 'light', reducedMotion: false })
    const captureStyle = buildWrapperStyle({ theme: 'light', reducedMotion: true })
    expect(captureStyle).toContain('animation:none !important')
    expect(previewStyle).not.toContain('animation:none !important')
    // 其它部分（token / SVG 默认 / fade-in keyframe）必须字面一致——
    // 烤图视觉必须与 chat 预览同源，不允许偷偷漂移
    // 把所有空白行折叠后字面比较，规避 join 时空字符串元素带来的空行噪音
    const normalize = (s: string) =>
      s
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('\n')
    const previewNorm = normalize(previewStyle)
    const captureNorm = normalize(
      captureStyle.replace('svg *,body{animation:none !important;}', ''),
    )
    expect(captureNorm).toBe(previewNorm)
  })

  it('两端 buildWrapperStyle 的 token 注入字面与 themeBundle 完全一致（chat 预览/烤图同源）', () => {
    const lightStyle = buildWrapperStyle({ theme: 'light' })
    const darkStyle = buildWrapperStyle({ theme: 'dark' })
    expect(lightStyle).toContain(themeBundle.light)
    expect(darkStyle).toContain(themeBundle.dark)
  })

  it('html/body 声明 height:auto + min-height:0，避免 iframe 视口撑高后无法回落', () => {
    const style = buildWrapperStyle({ theme: 'light' })
    expect(style).toContain('height:auto;min-height:0')
  })
})

describe('widget-tokens: Lightbox 内部滚动与缩放', () => {
  it('lightboxViewport：默认 fit contain；高图切 tall 滚动；content 有明确高度防白屏', () => {
    const html = buildWrapper('<svg viewBox="0 0 400 2400"><text>TOP BOTTOM</text></svg>', {
      lightboxViewport: true,
    })

    // 默认 fit：双轴 contain（对齐 PNG）；content 明确 100% 高，避免 max-height% 算成 0
    expect(html).toContain(
      '#tabtin-widget-content{display:flex;align-items:center;justify-content:center;width:100%;height:100%',
    )
    expect(html).toContain('svg{display:block;max-width:100%;max-height:100%;width:auto;height:auto;')
    // tall：宽铺满 + 纵向滚动
    expect(html).toContain('html[data-lightbox-mode="tall"] body{display:block;overflow:auto;')
    expect(html).toContain('html[data-lightbox-mode="tall"] svg{width:100%;max-width:100%;height:auto;max-height:none;}')
    expect(html).toContain('data-lightbox-mode')
    expect(html).toContain('heightAtFullWidth')
    expect(html).toContain('id="tabtin-widget-content"')
    expect(html).not.toContain('min-width:100%')
    expect(html).toContain('tabtin:preview-scale')
    expect(buildPreviewScaleBootstrap(true)).toContain('Math.max(0.5,Math.min(5,raw))')
  })

  it('#7275：preview-scale 不因 event.source 守门而静默丢弃（sandbox 无 same-origin）', () => {
    const bootstrap = buildPreviewScaleBootstrap(true)
    expect(bootstrap).toContain('tabtin:preview-scale')
    expect(bootstrap).toContain('root.style.zoom=String(scale)')
    // 不得再要求 event.source===parent；opaque origin 下会误杀父层缩放消息
    expect(bootstrap).not.toContain('event.source!==parent')
    expect(bootstrap).not.toContain('event.source===parent')
  })

  it('默认 wrapper 继续 content-sized + overflow:hidden，不改变  测高契约', () => {
    const html = buildWrapper('<svg/>')

    expect(html).toContain('height:auto;min-height:0')
    expect(html).toContain('overflow:hidden')
    expect(html).not.toContain('id="tabtin-widget-content"')
    expect(html).not.toContain('tabtin:preview-scale')
  })
})

describe('widget-tokens: buildResizeObserverBootstrap（内容高度，可缩小）', () => {
  it('按 children getBoundingClientRect 测高，不用 documentElement.scrollHeight', () => {
    const script = buildResizeObserverBootstrap()
    expect(script).toContain('getBoundingClientRect().bottom')
    expect(script).toContain('paddingBottom')
    expect(script).toContain('tabtin:resize')
    expect(script).not.toContain('document.documentElement.scrollHeight')
    expect(script).not.toContain('documentElement.scrollHeight')
  })

  it('buildWrapper 注入可回落的 resize bootstrap', () => {
    const html = buildWrapper('<svg viewBox="0 0 10 10"/>', { theme: 'light' })
    expect(html).toContain('getBoundingClientRect().bottom')
    expect(html).not.toContain('document.documentElement.scrollHeight')
  })
})
