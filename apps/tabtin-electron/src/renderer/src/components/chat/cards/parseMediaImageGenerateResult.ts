/**
 * 从 `tabtin media image generate` 的 tool_result / stdout 信封中抽取成品图 URL。
 *
 * 常见形态（多层 unwrap）：
 * - shell envelope: `{ stdout: "<json string>", exit_code: 0 }`
 * - CLI json: `{ ok: true, data: { result_urls: ["https://..."] } }`
 * - Django task: `{ success, status, result_urls, result_url, stored_urls }`
 *
 * 现实坑（2026-07-16 live）：后台任务 wait/pattern_matched 返回的 stdout 可能是
 * **截断的 JSON 尾段**（不以 `{` 开头），整段 JSON.parse 失败，但文本里仍有
 * `result_urls` + https 链接。此时走正则兜底，并把 `\u0026` 解成 `&`。
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

/** tool_result 常带 `<approval_note>...</approval_note>` 前缀，剥掉后再找 JSON。 */
function stripApprovalNote(text: string): string {
  const closed = text.match(/<\/approval_note>\s*([\s\S]*)$/i)
  if (closed?.[1]) return closed[1].trim()
  return text.trim()
}

/** 从混合文本里抽出第一段顶层 `{...}`（括号平衡）。 */
function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function urlFromUnknownCandidate(candidate: unknown): string | undefined {
  if (typeof candidate === 'string') return normalizeMediaImageUrl(candidate)
  if (!Array.isArray(candidate)) return undefined
  for (const item of candidate) {
    if (typeof item !== 'string') continue
    const url = normalizeMediaImageUrl(item)
    if (url) return url
  }
  return undefined
}

function firstHttpsUrl(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const url = urlFromUnknownCandidate(candidate)
    if (url) return url
  }
  return undefined
}

/** 还原截断 JSON / LLM 抄写时残留的 `\u0026` 等 escape，得到可加载的 URL。 */
export function normalizeMediaImageUrl(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  let url = raw.trim()
  if (!url) return undefined
  url = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
  if (!(url.startsWith('https://') || url.startsWith('http://'))) return undefined
  return url
}

/** @deprecated 使用 normalizeMediaImageUrl */
export function normalizeExtractedUrl(raw: string): string | undefined {
  return normalizeMediaImageUrl(raw)
}

/** 去重用身份：origin+pathname（忽略签名 query），避免 & vs \\u0026 漏判。 */
export function mediaImageUrlIdentity(raw: string | null | undefined): string | undefined {
  const url = normalizeMediaImageUrl(raw)
  if (!url) return undefined
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url.split('?')[0] || url
  }
}

function pickUrlFromTaskPayload(payload: Record<string, unknown>): string | undefined {
  return firstHttpsUrl(
    payload.stored_urls,
    payload.result_urls,
    payload.result_url,
    payload.imageUrls,
    payload.image_urls,
    payload.url,
  )
}

/**
 * 截断 stdout 兜底：优先匹配 `"result_urls": [ "https://..." ]`，
 * 再退到文本中任意 http(s) 图链。
 */
export function extractUrlFromTruncatedMediaStdout(text: string): string | undefined {
  if (!text) return undefined

  const resultUrlsBlock = text.match(
    /"result_urls"\s*:\s*\[\s*"((?:\\.|[^"\\])*)"/i,
  )
  if (resultUrlsBlock?.[1]) {
    const url = normalizeMediaImageUrl(resultUrlsBlock[1])
    if (url) return url
  }

  const resultUrlSingle = text.match(/"result_url"\s*:\s*"((?:\\.|[^"\\])*)"/i)
  if (resultUrlSingle?.[1]) {
    const url = normalizeMediaImageUrl(resultUrlSingle[1])
    if (url) return url
  }

  // 任意 https（偏向 tos / jpeg / png）
  const loose = text.match(
    /https:\/\/[^\s"'\\]+(?:\\u0026[^\s"'\\]*)*/i,
  )
  if (loose?.[0]) {
    return normalizeMediaImageUrl(loose[0])
  }
  return undefined
}

/** 递归剥一层 data / ok.data / stdout 字符串。 */
function unwrapLayers(raw: unknown, depth = 0): unknown[] {
  if (depth > 6) return []
  const out: unknown[] = [raw]
  if (typeof raw === 'string') {
    const stripped = stripApprovalNote(raw)
    if (stripped !== raw) out.push(stripped)
    const balanced = extractBalancedJsonObject(stripped)
    if (balanced) {
      const parsed = tryParseJson(balanced)
      if (parsed != null) out.push(...unwrapLayers(parsed, depth + 1))
    } else {
      const parsed = tryParseJson(stripped)
      if (parsed != null) out.push(...unwrapLayers(parsed, depth + 1))
    }
    return out
  }
  const rec = asRecord(raw)
  if (!rec) return out

  if (typeof rec.stdout === 'string' && rec.stdout.trim()) {
    out.push(...unwrapLayers(rec.stdout, depth + 1))
  }
  if (typeof rec.content === 'string' && rec.content.trim()) {
    out.push(...unwrapLayers(rec.content, depth + 1))
  }
  if (rec.data != null) {
    out.push(...unwrapLayers(rec.data, depth + 1))
  }
  const nested = asRecord(rec.data)
  if (nested?.data != null) {
    out.push(...unwrapLayers(nested.data, depth + 1))
  }
  return out
}

/**
 * @returns 第一张可用 HTTPS/HTTP 图 URL；解析失败返回 undefined
 */
export function parseMediaImageGenerateResult(output: unknown): string | undefined {
  const layers = unwrapLayers(output)

  for (const layer of layers) {
    const rec = asRecord(layer)
    if (!rec) continue
    const url = pickUrlFromTaskPayload(rec)
    if (url) return url
  }

  // 截断 / 非 JSON 文本兜底
  for (const layer of layers) {
    if (typeof layer === 'string') {
      const url = extractUrlFromTruncatedMediaStdout(layer)
      if (url) return url
    }
    const rec = asRecord(layer)
    if (typeof rec?.stdout === 'string') {
      const url = extractUrlFromTruncatedMediaStdout(rec.stdout)
      if (url) return url
    }
  }

  return undefined
}
