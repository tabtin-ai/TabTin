/**
 * @tabtin/resource-router · parser
 *
 * 把任意输入字符串解析成 `ResourcePointer`。双端字符级对齐：
 *   - TypeScript: 本文件
 *   - Python: `apps/tabtin_django/apps/services/common/resource_pointer.py`
 *
 * Cross-lang contract test（W2 北极星之一）：
 *   `pnpm --filter @tabtin/resource-router test parse-cross-lang`
 *
 * 解析顺序（D5 双轨识别策略）：
 *   1. 先尝试自有格式 `tabtin://resource/<type>/<id>?<query>`
 *   2. 退化到行业格式（http(s) / file / mailto / tel / 其他）
 *
 * 设计取向：
 *   - 不抛异常——任何无法解析的输入退化为
 *     `{ scheme: 'unknown', type: null, id: <raw>, raw, hint: null }`
 *     调用方可凭 `scheme === 'unknown'` 判断兜底
 *   - URL 解析依赖 Web 标准 URL 类（Node ≥ 16 / 现代浏览器都内置）
 *   - 不假设 baseDir——相对路径 / 裸路径在 W3 remark plugin 阶段就被改写成
 *     `tabtin://resource/file/<encoded>` 形态了，到 parser 这里都是 absolute URI
 */

import type {
  ResourcePointer,
  ResourcePointerScheme,
  TabTinResourceScheme,
} from './types.js'

const SELF_FORMAT_PREFIX_RE = /^(?:tabtin|tabtin-preprod|tabtin-dev):\/\/resource\//
const SELF_FORMAT_RE = /^(?:tabtin|tabtin-preprod|tabtin-dev):\/\/resource\/([^/?#]+)\/([^?#]+)(\?[^#]*)?(#.*)?$/

/**
 * Agent 常见笔误归一化（须与 Python `resource_pointer.py` 保持字符级对齐）。
 *
 * 不是「补全注册表」——unknown type 仍走 pass-through 由 registry lookup
 * 决定能否派发；这里只兜底**字面 typo**：
 *  - `type=doc` → `document`：agent 容易把 carrier app 简写当成 resource type
 *  - `hint=document` → `tabdoc`：agent 容易把 resource type 写进 hint 段
 *  - `hint=doc` → `tabdoc`：agent 容易把 app id 写成简写
 *
 * 主治本仍是 SKILL 教 agent 输出 canonical 形态，alias 只是防御兜底。
 */
const SELF_FORMAT_TYPE_ALIASES: Record<string, string> = {
  doc: 'document',
}

const SELF_FORMAT_HINT_ALIASES: Record<string, string> = {
  document: 'tabdoc',
  doc: 'tabdoc',
}

function normalizeSelfFormatFields(
  type: string,
  hint: string | null,
): { type: string; hint: string | null } {
  const normalizedType = SELF_FORMAT_TYPE_ALIASES[type] ?? type
  let normalizedHint = hint
  if (normalizedHint !== null && normalizedHint in SELF_FORMAT_HINT_ALIASES) {
    normalizedHint = SELF_FORMAT_HINT_ALIASES[normalizedHint]!
  }
  return { type: normalizedType, hint: normalizedHint }
}

/**
 * 把任意 URI 字符串解析成 `ResourcePointer`。
 *
 * @param uri 输入字符串（自有格式 `tabtin://resource/...` / 行业格式 / 兜底裸字符串）
 * @param baseDir 可选；仅作为 ResourcePointer.baseDir 透传，不参与解析逻辑（保留位）
 *
 * @returns 永远返回 ResourcePointer，不抛异常。
 *   - 完全无法识别 scheme 时 `scheme = 'unknown'`
 */
export function parseResourcePointer(
  uri: string,
  baseDir?: string,
): ResourcePointer {
  const raw = String(uri ?? '')

  // ── Step 1. 自有格式优先 ────────────────────────────────────
  if (SELF_FORMAT_PREFIX_RE.test(raw)) {
    const selfPointer = tryParseSelfFormat(raw)
    if (selfPointer) {
      if (baseDir !== undefined) selfPointer.baseDir = baseDir
      return selfPointer
    }
    // 头部对了但 path 形态不合法——退化为 unknown，便于上层 outcome=error
    return {
      scheme: 'tabtin',
      type: null,
      id: raw,
      raw,
      hint: null,
      ...(baseDir !== undefined ? { baseDir } : {}),
    }
  }

  // ── Step 2. 行业格式 ─────────────────────────────────────────
  // 用 URL 类解析；失败说明输入压根不是合法 URI，落 `unknown`。
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {
      scheme: 'unknown',
      type: null,
      id: raw,
      raw,
      hint: null,
      ...(baseDir !== undefined ? { baseDir } : {}),
    }
  }

  // protocol 自带末尾冒号（如 'https:'），统一去掉冒号后写入 scheme
  const schemeWithColon = parsed.protocol
  const scheme: ResourcePointerScheme = schemeWithColon.endsWith(':')
    ? (schemeWithColon.slice(0, -1) as ResourcePointerScheme)
    : (schemeWithColon as ResourcePointerScheme)

  // 行业格式不携带 hint（D5 设计）。id = 原始 URI；调 shellOpenExternal 时直接用 raw。
  return {
    scheme,
    type: null,
    id: raw,
    raw,
    hint: null,
    ...(baseDir !== undefined ? { baseDir } : {}),
  }
}

/**
 * 解析自有格式 `tabtin://resource/<type>/<id>?<query>`。
 * 返回 null 表示「头部对但 path 形态不合法」，调用方应自决是否退化。
 */
function tryParseSelfFormat(raw: string): ResourcePointer | null {
  const match = SELF_FORMAT_RE.exec(raw)
  if (!match) return null

  const typeRaw = match[1]!
  const idRaw = match[2]!
  const queryWithQuestion = match[3] ?? ''

  // type 字段不允许为空 / 空白
  let type = decodeURIComponentSafe(typeRaw).trim()
  if (!type) return null

  // id 字段不允许为空（urlencoded 形态下空字符串 path segment 是异常）
  const id = decodeURIComponentSafe(idRaw)
  if (!id) return null

  let hint: string | null = null
  const meta: Record<string, unknown> = {}

  if (queryWithQuestion.length > 1) {
    const params = new URLSearchParams(queryWithQuestion.slice(1))
    for (const [key, value] of params.entries()) {
      if (key === 'hint') {
        // 只取第一次出现的 hint；空字符串等同于未声明
        if (hint === null && value.length > 0) hint = value
      } else {
        // 多值 query 收敛为数组，单值收敛为 string
        const existing = meta[key]
        if (existing === undefined) {
          meta[key] = value
        } else if (Array.isArray(existing)) {
          existing.push(value)
        } else {
          meta[key] = [existing, value]
        }
      }
    }
  }

  ;({ type, hint } = normalizeSelfFormatFields(type, hint))

  return {
    scheme: 'tabtin',
    type,
    id,
    raw,
    hint,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 把 ResourcePointer 反向序列化成自有格式字符串。
 *
 * 仅对 `scheme === 'tabtin'` 有意义。行业格式直接用 `pointer.raw`。
 * 用途：
 *   - W3 三处生成端（TrackerRunStatusIndicator / TrackerRunBreadcrumb /
 *     AppDeepLink）从 ContextRefType+id 反构 deep link
 *   - 测试覆盖 round-trip（parse → serialize → parse 三者 byte-equal）
 */
export function serializeSelfFormat(
  pointer: Pick<ResourcePointer, 'type' | 'id' | 'hint' | 'meta'>,
  scheme: TabTinResourceScheme = 'tabtin',
): string {
  if (!pointer.type) {
    throw new Error('serializeSelfFormat: pointer.type is required for self format')
  }
  if (!pointer.id) {
    throw new Error('serializeSelfFormat: pointer.id is required for self format')
  }
  const path = `${scheme}://resource/${encodeURIComponent(pointer.type)}/${encodeURIComponent(pointer.id)}`
  const params = new URLSearchParams()
  if (pointer.hint) params.set('hint', pointer.hint)
  if (pointer.meta) {
    for (const [k, v] of Object.entries(pointer.meta)) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) {
        for (const item of v) params.append(k, String(item))
      } else {
        params.set(k, String(v))
      }
    }
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}
