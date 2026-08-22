/**
 * 重构来源：packages/agent-runtime/src/tools/show-widget.ts（行 141-210）
 * 拆分时间：2026-04-30
 * 重构原因：show-widget.ts 711 行单文件过大，按职责拆分
 * 职责：widget 源代码沙箱化相关的所有校验 / 清洗函数。
 *       与业务逻辑无耦合，可独立单测。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

const EVENT_HANDLER_ATTR_RE = /\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi

function stripAttributeQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isSafeSendPromptHandler(attrName: string, attrValue: string): boolean {
  if (attrName.toLowerCase() !== 'onclick') return false
  const value = stripAttributeQuotes(attrValue)
  if (!/^sendPrompt\s*\(/.test(value)) return false
  if (/[;\n\r]/.test(value.replace(/;\s*$/, ''))) return false
  return /^sendPrompt\s*\(\s*(?:"[^"]{1,1000}"|'[^']{1,1000}')(?:\s*,[\s\S]{1,4096})?\)\s*;?\s*$/.test(value)
}

function findUnsafeEventHandler(code: string): string | null {
  EVENT_HANDLER_ATTR_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EVENT_HANDLER_ATTR_RE.exec(code)) != null) {
    if (!isSafeSendPromptHandler(match[1], match[2])) {
      return match[1]
    }
  }
  return null
}

export function hasDangerousHtml(code: string): string | null {
  const checks: Array<[RegExp, string]> = [
    [/<\s*script\b/i, 'HTML widgets are no-script: <script> is not allowed'],
    [/\bjavascript\s*:/i, 'HTML widgets cannot contain javascript: URLs'],
    [/<\s*(iframe|object|embed)\b/i, 'HTML widgets cannot embed iframe/object/embed content'],
    [/<\s*form\b/i, 'HTML widgets cannot submit forms'],
  ]
  for (const [re, message] of checks) {
    if (re.test(code)) return message
  }
  const unsafeHandler = findUnsafeEventHandler(code)
  if (unsafeHandler) {
    return `HTML widgets can only use onclick="sendPrompt(...)" handlers; found ${unsafeHandler}`
  }
  return null
}

export function hasDangerousMermaidSource(code: string): string | null {
  const checks: Array<[RegExp, string]> = [
    [/\bclick\b/i, 'Mermaid click directives are disabled for no-script widgets'],
    [/\bjavascript\s*:/i, 'Mermaid widgets cannot contain javascript: URLs'],
    [/\son[a-z]+\s*=/i, 'Mermaid widgets cannot contain inline event handlers'],
  ]
  for (const [re, message] of checks) {
    if (re.test(code)) return message
  }
  return null
}

/**
 * scrubSvg options — P0-4 修复：信任边界分层。
 *
 * - **默认**（LLM 直接写的 SVG，不受控来源）：清 `<foreignObject>`——它能装任意
 *   HTML + 嵌套 script，攻击面极大。
 * - **`trustedOrigin: true`**（Mermaid 编译器产出的 SVG）：保留 `<foreignObject>`
 *   壳——Mermaid v11 flowchart 默认 `htmlLabels: true` 用 foreignObject 承载节点
 *   label，清掉会让 flowchart 节点文字全消失。
 *   trusted 来源是 Mermaid 源码 DSL 经 `securityLevel: 'strict'` + `hasDangerousMermaidSource`
 *   前置拦截后产出的受控 HTML（`<div><span>`+text），内部 script 理论不可能，
 *   但 defense-in-depth 下仍清 `<script>` / `<iframe>` / `<object>` / `<embed>` /
 *   `on*=` / `javascript:`（万一 Mermaid 未来升级引入新 DOM 模式）。
 *
 * **TODO**（backlog）：若未来受控源扩展到 3+（如 TabSlide 编译产物、TabDoc
 * 导出的 SVG），迁移到 `source?: 'llm' | 'mermaid' | ...` 的 tagged union 防误用。
 * `trustedOrigin: boolean` 在类型层面无法区分"谁是受控源"——如果某条 LLM 路径
 * 误加了 `{ trustedOrigin: true }` 编译器不会报错。
 */
export interface ScrubSvgOptions {
  /** `true` 表示 SVG 来自受控源（当前仅 Mermaid 编译器），保留 foreignObject。 */
  trustedOrigin?: boolean
}

export function scrubSvg(svg: string, options: ScrubSvgOptions = {}): string {
  // P0-1 第一层修复（unclosed `<script>` 绕过）：
  //   旧实现只清成对 `<script>...</script>`，attack payload
  //   `<svg><script>parent.postMessage(...` (不闭合) 不命中成对正则，原样通过 →
  //   iframe fallback parser 吃到 EOF 当 script 执行，绕过整条 scrub 防线。
  //   修法：成对正则先跑一遍（处理正常情况），再跑独立 `<script` 开标签正则
  //   把所有剩余的 `<script>` / `<script ...>` 开标签 / 自闭合标签都清掉。
  let scrubbed = svg
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*script\b[^>]*\/?\s*>/gi, '')
    // **安全 Review 自修（2026-04-30）**：无论 trustedOrigin，一律清
    // `<iframe>/<object>/<embed>` 开标签——即使 Mermaid 未来升级吐出这些 DOM
    // 元素，也不会变成新攻击面。只清开标签不清内容：浏览器解析时 `<iframe>`
    // 开标签触发 load 机制，去掉开标签后元素不再 load 远程内容。
    // `hasDangerousHtml` 在 HTML format 路径已经前置拦，本层是 SVG 路径的 mirror。
    .replace(/<\s*(iframe|object|embed)\b[^>]*\/?\s*>/gi, '')
    .replace(/<\s*\/\s*(iframe|object|embed)\s*>/gi, '')

  if (!options.trustedOrigin) {
    scrubbed = scrubbed.replace(
      /<\s*foreignObject\b[^>]*>[\s\S]*?<\s*\/\s*foreignObject\s*>/gi,
      '',
    )
  }

  return scrubbed
    .replace(EVENT_HANDLER_ATTR_RE, (full, attrName: string, attrValue: string) =>
      isSafeSendPromptHandler(attrName, attrValue) ? full : '')
    .replace(/\s(?:href|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '')
    .replace(/\bjavascript\s*:/gi, '')
}
