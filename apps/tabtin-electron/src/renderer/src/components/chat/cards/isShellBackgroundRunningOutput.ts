/**
 * 识别 shell / run_terminal_command 的「仍在后台跑」快照。
 *
 * wait_ms 耗尽时工具会先返回 `{ status: "running", ... }`（进程未杀），
 * 此时尚无成品 URL——生图卡不得把 phase=end 当成失败。
 * 见 。
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return null
  }
}

function isRunningRecord(rec: Record<string, unknown>): boolean {
  if (rec.backgrounded === true) return true
  if (rec.status === 'running') return true
  return false
}

/** tool_result / lifecycle output 是否表示命令仍在后台执行。 */
export function isShellBackgroundRunningOutput(output: unknown): boolean {
  if (output == null) return false

  if (typeof output === 'string') {
    const parsed = tryParseJsonObject(output)
    if (parsed && isRunningRecord(parsed)) return true
    return false
  }

  const rec = asRecord(output)
  if (!rec) return false
  if (isRunningRecord(rec)) return true

  // shell envelope 常{ status, stdout: "<json>" } 或 content 包一层
  for (const key of ['stdout', 'content', 'output'] as const) {
    const nested = rec[key]
    if (typeof nested === 'string') {
      const parsed = tryParseJsonObject(nested)
      if (parsed && isRunningRecord(parsed)) return true
    } else {
      const nestedRec = asRecord(nested)
      if (nestedRec && isRunningRecord(nestedRec)) return true
    }
  }

  const data = asRecord(rec.data)
  if (data && isRunningRecord(data)) return true

  return false
}
