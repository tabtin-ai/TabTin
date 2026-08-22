/**
 * 将 shell 命令拆成可执行片段，同时保留引号内的换行 / 分号 / 管道。
 *
 * 交付物识别只需要知道某个 tabtin 命令是否出现在复合命令中，
 * 不应因为 Agent 用多行变量承载 JSON 或使用 shell 续行而漏识别。
 * 这里只做保守扫描，不尝试实现完整 shell parser。
 */
export function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  const flush = (): void => {
    const segment = current.trim()
    if (segment) segments.push(segment)
    current = ''
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!

    if (escaped) {
      if (char !== '\n' && char !== '\r') current += char
      escaped = false
      continue
    }
    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += char
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
      continue
    }

    if (
      !inSingleQuote
      && !inDoubleQuote
      && (char === '\n' || char === '\r' || char === ';' || char === '|' || char === '&')
    ) {
      flush()
      const next = command[index + 1]
      if ((char === '\r' && next === '\n') || next === char) index += 1
      continue
    }
    current += char
  }

  if (escaped) current += '\\'
  flush()
  return segments
}
