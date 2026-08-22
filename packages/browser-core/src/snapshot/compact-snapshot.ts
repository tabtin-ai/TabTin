/**
 * Compact Snapshot Formatter（electron-free 纯函数，双端共享）
 *
 * 把可访问性树（accessibility tree）文本压成 token 友好的 YAML-like 紧凑格式，
 * 让 Agent 用 `e1/e2/...` 元素引用代替冗长的 CSS 选择器。
 * 典型页面：5000+ tokens → < 500 tokens。
 *
 * BR-16：本模块原先有两份逐字段对齐的副本——
 *   - Electron：`apps/tabtin-electron/src/main/cli/routes/browser/compact-snapshot.ts`
 *   - Daemon：  `apps/tabtin-daemon/src/cli/routes/browser-compact-snapshot.ts`
 * 二者都是无 electron/playwright 依赖的纯字符串逻辑，现收编进 browser-core 单一实现，
 * 两端 route 一起指向这里（去重，收口 BR-8 P3c）。
 *
 * 同时修了 `parseAriaLine` 的名字解析：BR-14 修好后 `AccessibilityTreeBuilder.toText`
 * 产出的格式是 `[role] 名字 [attrs]`（**名字不带引号**），而老解析只认带引号的名字，
 * 导致 `name=''` → selector 全落空 → `eN` 解析得到但 selector 为空 → `act --ref eN`
 * 报「click requires selector」。本实现兼容「不带引号」格式，同时保留对老带引号格式的兼容。
 *
 * BR-17：selector 回解从「按名字字符串等值匹配 xpathMap」升级为「按行尾稳定句柄
 * `{b<backendDOMNodeId>}` 直取精确 xpath」。名字匹配对重复文本元素有损（多个同名只命中
 * 第一条 xpath、或干脆退化到 `has-text(name)` 不唯一/不可见），句柄是每个 AX 节点自带的
 * DOM backendId，由 `AccessibilityTreeBuilder.buildWithXPath` 一次性批量解析成唯一 xpath，
 * 故每个 `eN` 都拿到确定性、唯一、精确的 selector。无句柄时（iframe/shadow 内、解析失败）
 * 才退回旧的名字/id/has-text 链（行为不回退）。
 */

import { assignSemanticFingerprints, type SemanticFingerprint } from '../runtime/ref-semantic';
import type { RefEntry } from '../runtime/RefCache';

/** 紧凑快照里的一个可交互元素。 */
export interface CompactElement {
  ref: string
  tag: string
  role?: string
  name: string
  selector: string
  /** BR-17：AX backendDOMNodeId，快路径句柄。 */
  backendId?: string
  attributes?: string
  state: string[]
}

/** 紧凑快照整体结构。 */
export interface CompactSnapshot {
  url: string
  title: string
  elements: CompactElement[]
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio',
  'combobox', 'slider', 'spinbutton', 'switch',
  'tab', 'menuitem', 'option', 'searchbox',
  'listbox', 'menu', 'menubar', 'toolbar',
])

const INTERACTIVE_TAGS = new Set([
  'button', 'a', 'input', 'select', 'textarea',
  'details', 'summary',
])

const TAG_MAP: Record<string, string> = {
  textbox: 'input', checkbox: 'input', radio: 'input',
  combobox: 'select', link: 'a', button: 'button',
  slider: 'input', spinbutton: 'input', switch: 'input',
  searchbox: 'input',
}

interface ParsedAriaLine {
  role: string
  tag: string
  name: string
  id?: string
  /** BR-17：行尾 `{b<backendDOMNodeId>}` 句柄，用于在 xpathMap 里直取精确 xpath。 */
  backendId?: string
  attrs?: string
  visible?: boolean
  disabled?: boolean
  draggable?: boolean
  focusable?: boolean
  hasAction?: boolean
  checked?: boolean
}

/**
 * 从单行 a11y 文本解析出 role / 名字 / 属性等。
 *
 * 支持两种名字格式：
 *  - 新（BR-14 producer）：`[role] 名字 [attrs]`——名字不带引号，位于 role 括号之后、
 *    末尾属性括号 ` [...]` 之前。无名节点形如 `[button] [disabled]`（rest 直接以 `[` 开头）→ name=''。
 *  - 老（兼容）：`[role] "名字" ...`——名字带引号，优先取引号内文本。
 *
 * 注意：属性括号里的 `value="..."` 含引号，必须先剥离末尾属性括号再取名字，
 * 否则会把 value 误当成名字。
 */
function parseAriaLine(rawLine: string): ParsedAriaLine | null {
  // BR-17：先剥离行尾稳定句柄 `{b<backendDOMNodeId>}`，避免干扰后续 role/name/attrs 解析
  // （注意句柄用 `{}`、属性用 `[]`，两者不会混淆；句柄只可能在最末尾）。
  let backendId: string | undefined
  let line = rawLine
  const handleMatch = line.match(/\s*\{b(\d+)\}\s*$/)
  if (handleMatch) {
    backendId = handleMatch[1]
    line = line.slice(0, handleMatch.index).trimEnd()
  }

  const roleMatch = line.match(/^\[?(\w+)(?:\[([^\]]*)\])?\]?\s*/)
  if (!roleMatch) return null

  const role = roleMatch[1]
  const bracketAttrs = roleMatch[2] || ''
  const rest = line.slice(roleMatch[0].length)

  // 先剥离末尾属性括号 ` [attr1, attr2, value="x"]`，剩下的才是名字候选段。
  const namePart = rest.replace(/\s*\[[^\]]*\]\s*$/, '').trim()

  let name = ''
  if (namePart.startsWith('"')) {
    // 老格式兼容：名字整体带引号，取引号内文本。
    const quoted = namePart.match(/^"([^"]*)"/)
    name = quoted ? quoted[1] : namePart
  } else if (!namePart.startsWith('[')) {
    // 新格式：剥离属性括号后剩的就是名字（无名节点 namePart 以 `[` 开头或为空）。
    name = namePart
  }

  const idMatch = bracketAttrs.match(/id=["']?([^"'\s,]+)/)
  const typeMatch = bracketAttrs.match(/type=["']?([^"'\s,]+)/)
  const placeholderMatch = rest.match(/placeholder=["']?([^"'\s]+)/)

  let attrs = ''
  if (typeMatch) attrs += `type=${typeMatch[1]}`
  if (placeholderMatch) attrs += `${attrs ? ' ' : ''}placeholder="${placeholderMatch[1]}"`

  return {
    role,
    tag: TAG_MAP[role] || role,
    name,
    id: idMatch?.[1],
    backendId,
    attrs: attrs || undefined,
    visible: !line.includes('hidden'),
    disabled: line.includes('disabled'),
    draggable: line.includes('draggable'),
    focusable: line.includes('focusable'),
    hasAction: line.includes('clickable') || line.includes('editable'),
    checked: line.includes('checked=true') ? true : line.includes('checked=false') ? false : undefined,
  }
}

/**
 * 解出一个交互元素的 selector，优先级：
 *  1. BR-17 句柄直取——`parsed.backendId` 命中 `xpathMap`（新管线：`Record<backendId, xpath>`）→
 *     精确唯一 xpath，重复文本元素也确定命中。
 *  2. 兼容旧 `Record<xpath, label>` 映射——按名字/整行字符串等值匹配（无句柄时才走，对新映射天然不命中、无副作用）。
 *  3. `#id`（a11y 行解析出 id）。
 *  4. 兜底 `tag:has-text(name)`（不唯一、可能不可见——仅最后手段）。
 */
function resolveSelector(
  parsed: ParsedAriaLine,
  trimmed: string,
  xpathMap: Record<string, string>,
): string {
  if (parsed.backendId) {
    const xpath = xpathMap[parsed.backendId]
    if (xpath) return xpath.startsWith('xpath=') ? xpath : `xpath=${xpath}`
  }

  for (const [xp, label] of Object.entries(xpathMap)) {
    if ((parsed.name && label === parsed.name) || label === trimmed) {
      return xp.startsWith('/') ? `xpath=${xp}` : xp
    }
  }

  if (parsed.id) return `#${parsed.id}`
  if (parsed.tag && parsed.name) return `${parsed.tag}:has-text("${parsed.name.slice(0, 30)}")`
  return ''
}

/** 从可访问性树文本 + xpath 映射构建紧凑快照。 */
export function buildCompactSnapshot(
  url: string,
  title: string,
  accessibilityTree: string,
  xpathMap: Record<string, string>,
): CompactSnapshot {
  const elements: CompactElement[] = []
  let refCounter = 0

  const lines = accessibilityTree.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const parsed = parseAriaLine(trimmed)
    if (!parsed) continue

    const isInteractive =
      INTERACTIVE_ROLES.has(parsed.role) ||
      INTERACTIVE_TAGS.has(parsed.tag) ||
      parsed.focusable ||
      parsed.hasAction

    if (!isInteractive) continue

    const selector = resolveSelector(parsed, trimmed, xpathMap)

    // BR-16：解不出 selector 的元素（无名、无 id、xpath 未命中）即便 eN 编号也无法被
    // `act --ref eN` 使用——直接跳过，保证每个 eN 都有非空 selector、且 eN 编号连续。
    if (!selector) continue

    refCounter++
    const ref = `e${refCounter}`

    const state: string[] = []
    if (parsed.visible !== false) state.push('visible')
    if (parsed.disabled) state.push('disabled')
    if (parsed.draggable) state.push('draggable')
    if (parsed.checked != null) state.push(parsed.checked ? 'checked' : 'unchecked')

    elements.push({
      ref,
      tag: parsed.tag || parsed.role,
      role: parsed.role !== parsed.tag ? parsed.role : undefined,
      name: parsed.name.slice(0, 60),
      selector,
      backendId: parsed.backendId,
      attributes: parsed.attrs,
      state,
    })
  }

  return { url, title, elements }
}

/** 把紧凑快照渲染成 YAML-like 文本。 */
export function formatCompactSnapshot(snapshot: CompactSnapshot): string {
  const lines: string[] = [
    `url: ${snapshot.url}`,
    `title: ${snapshot.title}`,
    `elements:`,
  ]

  for (const el of snapshot.elements) {
    const stateStr = el.state.length > 0 ? ` [${el.state.join(', ')}]` : ''
    const attrStr = el.attributes ? ` ${el.attributes}` : ''
    const nameStr = el.name ? ` "${el.name}"` : ''
    lines.push(`  ${el.ref}: ${el.tag}${nameStr}${attrStr}${stateStr}`)
  }

  return lines.join('\n')
}

/** 从紧凑快照构建 `eN → RefEntry` 映射（供 RefCache 灌入）。 */
export function buildRefEntries(snapshot: CompactSnapshot): Map<string, RefEntry> {
  const semantics = assignSemanticFingerprints(snapshot.elements)
  const map = new Map<string, RefEntry>()
  snapshot.elements.forEach((el, index) => {
    const xpath = el.selector.startsWith('xpath=') ? el.selector.slice(6) : undefined
    map.set(el.ref, {
      selector: el.selector,
      xpath,
      backendId: el.backendId,
      semantic: semantics[index],
    })
  })
  return map
}

/**
 * 从紧凑快照构建 `b<backendDOMNodeId> → RefEntry` 映射（供 RefCache 灌入）。
 *
 * 全量 a11y 树（默认 snapshot 的 compact 回退、`--no-compact`、以及 FC request_snapshot）
 * 在交互行尾暴露 `{b<backendId>}` 句柄，Agent 会自然地照抄成 `act --ref b1086`。此前只有
 * compact 的 `eN` 进 RefCache，`bN` 无人登记 → act 回解不到 selector → 报「click requires
 * selector or coordinates」。把 `bN` 与 `eN` 指向同一元素的同一 xpath，Agent 看到什么句柄就能
 * act 什么句柄（一套寻址）。仅对解析出 backendId 且 selector 非空的元素登记。
 */
export function buildBackendRefEntries(snapshot: CompactSnapshot): Map<string, RefEntry> {
  const semantics = assignSemanticFingerprints(snapshot.elements)
  const map = new Map<string, RefEntry>()
  snapshot.elements.forEach((el, index) => {
    if (!el.backendId) return
    const xpath = el.selector.startsWith('xpath=') ? el.selector.slice(6) : undefined
    map.set(`b${el.backendId}`, {
      selector: el.selector,
      xpath,
      backendId: el.backendId,
      semantic: semantics[index],
    })
  })
  return map
}

/** @deprecated 使用 buildRefEntries；保留兼容旧调用方。 */
export function buildRefMap(snapshot: CompactSnapshot): Map<string, { selector: string; xpath?: string; semantic?: SemanticFingerprint; backendId?: string }> {
  return buildRefEntries(snapshot)
}
