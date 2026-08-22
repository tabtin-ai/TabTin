/**
 * `@tabtin/agent-host` 受限 shell / 不可信输出的 TabTin 业务判定。
 *
 * 这三样是 TabTin CLI 特有知识，从中性 agent-runtime 内核迁出，由两宿主
 * （electron / daemon）装配时注入：
 *   - {@link RESTRICTED_READONLY_VERBS}：受限模式下 schema 未命中时判「只读」的
 *     启发式动词表（注入 `createTabtinReadonlyChecker` 的 `readonlyVerbs`）。
 *   - {@link RESTRICTED_BROWSER_NAV_ALLOWLIST}：受限模式浏览器导航豁免（注入
 *     `browserNavAllowlist`）。
 *   - {@link isUntrustedShellCommand}：`tabtin fetch|browser` 输出算外部不可信字节，
 *     需 fence（注入 `EngineConfig.isUntrustedShellCommand`）。
 *
 * `isUntrustedShellCommand` 的分词/判定逻辑与迁移前 agent-runtime
 * `tool-output-sanitizer` 的 `isUntrustedExternalShellCommand` 逐字一致，保持
 * 注入防护行为字节级不变。
 */

/**
 * 受限模式 schema 未命中时的只读兜底动词表。集合中的动词都是「tabtin <subcmd>
 * 只读子命令」的业务假设，非中性 shell 语义，故不留在中性内核。
 */
export const RESTRICTED_READONLY_VERBS: ReadonlySet<string> = new Set([
  'list',
  'get',
  'read',
  'show',
  'status',
  'search',
  'info',
  'inspect',
  'count',
  'find',
  'view',
  'history',
  'ls',
  'help',
  'version',
  'doctor',
  'diff',
  'stat',
  'stats',
  'check',
  'describe',
  'detail',
  'commands',
  'capabilities',
  'list-blocks',
  'search-blocks',
  'list-servers',
  'list-tools',
  'list-resources',
  'list-prompts',
  'read-resource',
  'get-prompt',
  'glance',
  'print',
  'capture',
  'wait',
  'console',
  'cookies',
  'resource',
  'stream',
  'ua',
  'console-messages',
  'network',
  'tab',
  'tabs',
  'state',
  'query',
  'records',
  'statistics',
  'outline',
  'page',
  'preview',
  'lint',
  'dry-run',
  'grep',
  'glob',
  'export',
  'dump',
  'download',
  'list-skills',
  'list-bindings',
])

/**
 *  / ：受限模式放行「浏览器导航 + 看」——即便 Risk=write 也放行的 browser
 * 子命令（相对 `browser` 的子路径）。仅含导航/切换查看，不含任何页面自动化与
 * 状态改动。
 */
export const RESTRICTED_BROWSER_NAV_ALLOWLIST: ReadonlySet<string> = new Set([
  'open',
  'nav',
  'tab switch',
])

/** @deprecated 改用 RESTRICTED_BROWSER_NAV_ALLOWLIST；保留给尚未迁移的 Daemon 装配。 */
export const PLAN_BROWSER_NAV_ALLOWLIST = RESTRICTED_BROWSER_NAV_ALLOWLIST

/**
 * FR-09 /  —— `tabtin fetch` / `tabtin browser …` 抓取的外部字节经
 * `run_terminal_command` 传输，需 fence，否则绕过 W3 fence allow-list。
 *
 * 基于 token（引号感知）判定，非子串启发：`tabtin` + `fetch|browser` 作为前两个
 * 命令 token。pipeline 保守：env / 单个 `cd &&` 归一后任一 `|`-段命中即整段视为
 * 不可信（`tabtin fetch … | jq` 仍 fence）；`echo tabtin fetch` 不命中。
 */
export function isUntrustedShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  for (const segment of splitShellPipelineSegments(trimmed)) {
    for (const normalized of expandShellAndSegments(segment)) {
      if (segmentIsTabtinFetchOrBrowser(normalized)) return true
    }
  }
  return false
}

function splitShellPipelineSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const c = command[i]

    if (escaped) {
      current += c
      escaped = false
      continue
    }

    if (c === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += c
      continue
    }

    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += c
      continue
    }

    if (c === '|' && !inSingleQuote && !inDoubleQuote) {
      segments.push(current)
      current = ''
      continue
    }

    current += c
  }

  segments.push(current)
  return segments.map((s) => s.trim()).filter((s) => s.length > 0)
}

function expandShellAndSegments(segment: string): string[] {
  const parts = splitShellAndSegments(segment)
  return parts.length > 0 ? parts : [segment.trim()]
}

function splitShellAndSegments(segment: string): string[] {
  const parts: string[] = []
  let current = ''
  const state: ShellScanState = {
    inSingleQuote: false,
    inDoubleQuote: false,
    escaped: false,
  }

  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]

    if (consumeEscapedChar(state, c, (value) => { current += value })) {
      continue
    }
    if (startEscape(state, c)) {
      continue
    }
    if (toggleShellQuote(state, c, (value) => { current += value })) {
      continue
    }
    if (isShellAndSeparator(segment, i, state)) {
      parts.push(current.trim())
      current = ''
      i += 1
      continue
    }

    current += c
  }

  if (state.inSingleQuote || state.inDoubleQuote || state.escaped) {
    return [segment.trim()]
  }

  const tail = current.trim()
  if (tail.length > 0) parts.push(tail)
  return parts.filter((p) => p.length > 0)
}

interface ShellScanState {
  inSingleQuote: boolean
  inDoubleQuote: boolean
  escaped: boolean
}

function consumeEscapedChar(
  state: ShellScanState,
  c: string,
  append: (value: string) => void,
): boolean {
  if (!state.escaped) return false
  append(c)
  state.escaped = false
  return true
}

function startEscape(state: ShellScanState, c: string): boolean {
  if (c !== '\\' || state.inSingleQuote) return false
  state.escaped = true
  return true
}

function toggleShellQuote(
  state: ShellScanState,
  c: string,
  append?: (value: string) => void,
): boolean {
  if (c === "'" && !state.inDoubleQuote) {
    state.inSingleQuote = !state.inSingleQuote
    append?.(c)
    return true
  }
  if (c === '"' && !state.inSingleQuote) {
    state.inDoubleQuote = !state.inDoubleQuote
    append?.(c)
    return true
  }
  return false
}

function isShellAndSeparator(
  segment: string,
  i: number,
  state: ShellScanState,
): boolean {
  return (
    segment[i] === '&' &&
    segment[i + 1] === '&' &&
    !state.inSingleQuote &&
    !state.inDoubleQuote
  )
}

function tokenizeShellCommand(segment: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let hasContent = false
  const state: ShellScanState = {
    inSingleQuote: false,
    inDoubleQuote: false,
    escaped: false,
  }

  const append = (value: string): void => {
    current += value
    hasContent = true
  }

  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]

    if (consumeEscapedChar(state, c, append)) {
      continue
    }
    if (startEscape(state, c)) {
      continue
    }
    if (toggleTokenQuote(state, c, () => { hasContent = true })) {
      continue
    }
    if (isTokenSeparator(c, state)) {
      if (hasContent) {
        tokens.push(current)
        current = ''
        hasContent = false
      }
      continue
    }

    append(c)
  }

  if (state.inSingleQuote || state.inDoubleQuote || state.escaped) return null
  if (hasContent) tokens.push(current)
  return tokens
}

function toggleTokenQuote(
  state: ShellScanState,
  c: string,
  markContent: () => void,
): boolean {
  if (c === "'" && !state.inDoubleQuote) {
    state.inSingleQuote = !state.inSingleQuote
    markContent()
    return true
  }
  if (c === '"' && !state.inSingleQuote) {
    state.inDoubleQuote = !state.inDoubleQuote
    markContent()
    return true
  }
  return false
}

function isTokenSeparator(c: string, state: ShellScanState): boolean {
  return (c === ' ' || c === '\t') && !state.inSingleQuote && !state.inDoubleQuote
}

function stripShellEnvPrefix(segment: string): string {
  let stripped = segment.trim()
  const envPrefixRe = /^[A-Za-z_][A-Za-z0-9_]*=[^\s$`]+\s+/
  let guard = 0
  while (envPrefixRe.test(stripped) && guard < 16) {
    stripped = stripped.replace(envPrefixRe, '')
    guard += 1
  }
  return stripped.trim()
}

function segmentIsTabtinFetchOrBrowser(segment: string): boolean {
  let main = stripShellEnvPrefix(segment)
  const andParts = splitShellAndSegments(main)
  main = andParts.length > 0 ? andParts[andParts.length - 1]! : main

  const cdMatch = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*(.+)$/s.exec(main.trim())
  if (cdMatch) {
    main = cdMatch[2]!.trim()
  }

  const tokens = tokenizeShellCommand(main)
  if (!tokens || tokens.length < 2) return false
  if (tokens[0] !== 'tabtin') return false
  return tokens[1] === 'fetch' || tokens[1] === 'browser'
}
