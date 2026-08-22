/**
 * 把生图 tool output 收成可读失败详情（字符串 / 空 / 截断 JSON 都能出内容）。
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return undefined
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return asRecord(parsed)
  } catch {
    return null
  }
}

/** 从 shell envelope / 错误 JSON 里抽 stderr / error / stdout。 */
function extractReadableParts(output: unknown): string[] {
  const parts: string[] = []

  if (typeof output === 'string') {
    const asObj = tryParseJsonObject(output)
    if (asObj) {
      parts.push(...extractReadableParts(asObj))
      return parts
    }
    parts.push(output.trim())
    return parts
  }

  const rec = asRecord(output)
  if (!rec) return parts

  const stderr = pickString(rec.stderr, rec.error, rec.error_message, rec.message)
  const stdout = pickString(rec.stdout, rec.output)
  const errorKind = pickString(rec.error_kind)

  if (errorKind) parts.push(`error_kind: ${errorKind}`)
  if (stderr) parts.push(stderr)
  if (stdout && stdout !== stderr) {
    // stdout 可能很长；失败详情只留尾部更有用（常含真正错误）
    parts.push(stdout.length > 1200 ? `…${stdout.slice(-1200)}` : stdout)
  }

  if (parts.length === 0) {
    try {
      const dumped = JSON.stringify(rec, null, 2)
      if (dumped && dumped !== '{}' && dumped !== 'null') {
        parts.push(dumped.length > 2000 ? `${dumped.slice(0, 2000)}…` : dumped)
      }
    } catch {
      // ignore
    }
  }

  return parts.filter(Boolean)
}

/**
 * @returns 始终返回非空字符串，保证「查看详情」点开必有内容。
 */
export function formatMediaImageFailureDetails(
  output: unknown,
  command?: string | null,
): string {
  const parts = extractReadableParts(output)
  if (parts.length > 0) {
    return parts.join('\n\n').slice(0, 4000)
  }

  const lines: string[] = []
  if (command?.trim()) {
    lines.push(`command: ${command.trim()}`)
  }
  lines.push('未能解析图片 URL，且工具输出为空。请重试或检查模型 / 配额。')
  return lines.join('\n')
}
