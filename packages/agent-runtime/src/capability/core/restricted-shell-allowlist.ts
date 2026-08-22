/**
 * 受限模式 shell 命令 input 级白名单（L16 / W5.5 + J3a）。
 *
 * **背景**：宪法不变量 2 把业务能力全压到 `tabtin <command>` CLI；W3 又把
 * `run_terminal_command` 整体加进受限模式 deny list，结果叠加成"Plan/Ask/Study
 * 三个模式完全没有业务能力"——LLM 连 `tabtin doc list` 这种纯只读查询都跑不了。
 *
 * **方案 A**（用户 2026-05-04 拍板）：受限模式仍允许 `run_terminal_command` 调用，
 * 但只放行 `tabtin <subcmd>` 形态、且对应 CLI 命令 `Risk` 字段为 `RiskNone`（空字符串）
 * 的命令。Risk 由 `tabtin commands --format json` 自描述提供。
 *
 * **J3a（2026-05-10）**：在 tabtin readonly 通道之外**追加**系统命令通道，
 * 追加系统命令 readonly + flag allowlist：
 * 第一批覆盖 6 个高频系统命令：`git` / `tree` / `find` / `sed` / `xargs` / `ps`。
 * 决策链：tabtin parser 命中 → 走原 Risk 决策；tabtin parser 失败（非 tabtin
 * 命令）→ 尝试系统命令 allowlist；都不命中则保持原 reject 路径。
 * 系统命令 allowlist 实现见 sibling 文件 `system-command-allowlist.ts`。
 *
 * **执行位置**：`shell.ts._executeCommandTool().execute` 入口；Cap 装配时由宿主
 * （ElectronAgentHost / DaemonAgentHost）按当前 `agentMode` 注入相应 checker。
 *
 * **安全策略（CLI schema 权威 + 启发式兜底 + 系统命令 allowlist）**：
 *   1. CLI schema 命中：Risk='write'/'high-risk-write' → 拒绝；Risk='' → 直接放行。
 *      命中 schema 表示 CLI 端已对该命令做出 Risk 标注，二次启发式只会引入位置参数
 *      错杀（W5.5-R3 P0-1 的 bug：`tabtin doc read <uuid>` 把 uuid 当末尾动词）。
 *   2. CLI schema 未命中（命令不在 registry）：启发式兜底——终末动词在已知只读列表
 *      则放行（兜底 schema 暂时漏注册的只读子命令），否则按 unknown_command 拒绝。
 *   3. CLI schema lookup 抛错（registry 不可达）：fail-close，code='lookup_failed'。
 *   4. **J3a 新增**：tabtin parser 失败（非 tabtin 命令）时尝试系统命令 allowlist，
 *      命中即放行；不命中保持原 not_tabtin reject 路径。
 *
 * **不在意之处**：
 *   - 调用方负责注入 fetchCommandRisk 实现；本模块不直接 spawn 子进程。
 *   - 任何 fetch 失败都视为"无法判断 → 拒绝"（fail-close），让 LLM 收到清晰
 *     错误指引切到 agent 模式或换只读命令，而非默许执行。
 */

import {
  tokenizeShellCommand,
  validateSystemCommand,
} from './system-command-allowlist.js'
import path from 'node:path'
export { tokenizeShellCommand } from './system-command-allowlist.js'

/**
 * 空的只读动词兜底集。runtime 内核不内置任何业务 / CLI 动词知识——
 * schema 未命中时的启发式兜底动词表由宿主经 `CreateCheckerDeps.readonlyVerbs`
 * 注入（宿主按其 CLI 命令面维护，含守护断言）。未注入时兜底集为空：
 * schema 未命中的命令一律按 unknown_command 拒绝（保守 fail-close）。
 */
const EMPTY_READONLY_VERBS: ReadonlySet<string> = new Set<string>()

/**
 * Checker 返回结果。`reason` 用中文给 LLM 看，`code` 给上层做分类（telemetry/测试断言）。
 */
export interface ShellAllowlistDecision {
  allowed: boolean
  reason?: string
  code?:
    | 'not_tabtin'
    | 'unknown_command'
    | 'write_risk'
    | 'lookup_failed'
    | 'empty_command'
    /** J3a：系统命令 allowlist 拒绝（含 unknown flag / find denylist / sed dangerous expression 等）。 */
    | 'system_command_rejected'
}

export interface RestrictedShellAllowlistChecker {
  isAllowed(command: string): Promise<ShellAllowlistDecision>
}

/**
 * 命令 Risk 查询回调。返回值约定：
 *   - `''`（空字符串） / `'none'` → RiskNone（只读）
 *   - `'write'`                   → RiskWrite
 *   - `'high-risk-write'`         → RiskHigh
 *   - `null`                      → 命令不在 schema 里（未知命令）
 *   - 抛错                        → 透传给 checker 视为 lookup_failed
 *
 * 实现见宿主装配（`ElectronAgentHost` 调 `tabtin commands --format json` + 缓存）。
 */
export type FetchCommandRisk = (subcmdPath: string) => Promise<string | null>

interface CreateCheckerDeps {
  fetchCommandRisk: FetchCommandRisk
  /**
   * 受限模式允许 `cd <path> && ...` 的执行根。宿主必须传当前 workspace root；
   * 未传时任何 cd 段 fail-close，避免只读系统命令被带到工作目录外枚举。
   */
  allowedCwdRoot?: string
  /**
   * ：Plan 模式专用——放行浏览器导航命令（即便 Risk=write）。集合为
   * 宿主提供的、相对 `browser` 的子路径动词（如 `open` / `nav` / `tab switch`）。
   * ask / study 模式不传（保持纯只读）。runtime 内核不内置该集合内容。
   */
  browserNavAllowlist?: ReadonlySet<string>
  /**
   * schema 未命中时的启发式只读兜底动词表（小写终末动词），由宿主按其 CLI
   * 命令面注入。runtime 内核不内置任何业务动词；未注入时兜底集为空，
   * schema 未命中一律按 unknown_command 拒绝。
   */
  readonlyVerbs?: ReadonlySet<string>
}

/**
 * 把命令字符串拆出真正要执行的 `tabtin <subcmd...>` 部分。
 *
 * 处理这几种合法形态：
 *   - `tabtin doc list --format json`            → ['doc','list']
 *   - `cd /tmp && tabtin doc list`               → ['doc','list']
 *   - `cd /tmp && tabtin doc list --format json` → ['doc','list']
 *   - `FOO=bar tabtin doc list`                  → ['doc','list']（env 前缀）
 *   - 任何含 `|`、`;`、`>`、` && ` 后接非 tabtin / 含 `$(...)` / 含反引号 → 拒绝
 *
 * 设计取舍：复合命令一律拒绝（除唯一允许的 `cd <path> &&` 前缀），避免 LLM 用
 *  `tabtin doc list || rm -rf /` 这类绕过。
 */
/**
 * parser 失败原因分类。供 `createTabtinReadonlyChecker` 内决定是否进系统命令通道：
 *   - `not_tabtin` / `bare_command_not_tabtin`：mainSegment 第一个非 env token 不是 tabtin
 *     → **可进系统命令通道**（mainSegment 已剥 cd 前缀和 env 前缀，可直接给
 *     `validateSystemCommand` 校验）
 *   - 其他（empty / metachar / multi_and / bad_cd）：根本性失败 → 不进系统命令通道
 */
type ParseFailReason =
  | 'empty'
  | 'metachar'
  | 'multi_and'
  | 'bad_cd'
  | 'not_tabtin'

type ParseTabtinFailure = {
  ok: false
  reason: string
  failKind: ParseFailReason
  mainSegment?: string
}

type ParseTabtinSuccess = {
  ok: true
  tokens: string[]
  mainSegment: string
}

function rejectUnsupportedShellSyntax(trimmed: string): ParseTabtinFailure | null {
  if (!trimmed) return { ok: false, reason: '命令为空', failKind: 'empty' }

  // 拒绝命令注入字符（pipe / redirect / subshell / background / heredoc）
  // 注意：& 不能直接拒绝因为合法的 `&&` 前缀；下面的拆分会处理
  if (/[|;><`]/.test(trimmed)) {
    return {
      ok: false,
      reason: '命令含管道 / 重定向 / 子 shell 字符',
      failKind: 'metachar',
    }
  }
  if (/\$\(/.test(trimmed)) {
    return { ok: false, reason: '命令含 $(...) 子 shell', failKind: 'metachar' }
  }
  return null
}

// ─── ：复合命令顶层拆段（引号感知，fail-close） ─────────────────────
//
// 目标：只读白名单命令的管道 / 串联组合（`git log | sed -n '1,20p'`、
// `git status; git log -5`）按「每段独立过白名单，全过才放行」联合校验，
// 让受限模式的批量取证一步完成，而不是逐命令往返。
//
// 安全边界（任一命中即放弃拆段，回退旧单段路径 → 旧 metachar 拒绝）：
//   - 重定向 `>` `<`、反引号、`$(...)`：写文件 / 子 shell，永远拒；
//   - 引号外裸 `&`（非 `&&`）：后台执行，拒；
//   - 引号外反斜杠转义：`\|` 等可改变拆分语义，保守拒；
//   - 双引号内 `$` / 反引号 / 反斜杠：会被 shell 展开，保守拒；
//   - 引号未闭合：拒。
// 单引号内任意字符不展开、安全保留（`--format='%h|%s'` 的 `|` 不当拆分符）。
// 段内容随后仍走既有单段校验（rejectUnsupportedShellSyntax 双保险 +
// tabtin Risk / 系统命令 allowlist），拆段器只负责"拆得安全"。

type TopLevelSplit =
  | { kind: 'segments'; segments: string[] }
  | { kind: 'single' }
  | { kind: 'unsafe' }
  /** 必须直接拒绝、不回退旧路径的注入形态（旧路径存在漏放，如裸 `&` 后台执行）。 */
  | { kind: 'reject'; reason: string }

function splitTopLevelSegments(input: string): TopLevelSplit {
  const segments: string[] = []
  let current = ''
  let sawSplitter = false
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      current += ch
      i++
      continue
    }
    if (quote === '"') {
      if (ch === '$' || ch === '`' || ch === '\\') return { kind: 'unsafe' }
      if (ch === '"') quote = null
      current += ch
      i++
      continue
    }
    switch (ch) {
      case "'":
      case '"':
        quote = ch
        current += ch
        i++
        continue
      case '`':
      case '>':
      case '<':
      case '\\':
        return { kind: 'unsafe' }
      case '\n':
      case '\r':
        return { kind: 'reject', reason: '命令含换行分隔符（受限模式拒绝）' }
      case '$':
        if (input[i + 1] === '(') return { kind: 'unsafe' }
        current += ch
        i++
        continue
      case '|':
        sawSplitter = true
        segments.push(current)
        current = ''
        i += input[i + 1] === '|' ? 2 : 1
        continue
      case ';':
        sawSplitter = true
        segments.push(current)
        current = ''
        i++
        continue
      case '&':
        // 裸 & 后台执行：旧路径（metachar 正则不含 &）存在漏放，必须直接拒绝。
        if (input[i + 1] !== '&') {
          return { kind: 'reject', reason: '命令含后台执行 &（受限模式拒绝）' }
        }
        sawSplitter = true
        segments.push(current)
        current = ''
        i += 2
        continue
      default:
        current += ch
        i++
        continue
    }
  }
  if (quote !== null) return { kind: 'unsafe' }
  if (!sawSplitter) return { kind: 'single' }
  segments.push(current)
  const trimmed = segments.map((s) => s.trim()).filter((s) => s.length > 0)
  if (trimmed.length === 0) return { kind: 'unsafe' }
  return { kind: 'segments', segments: trimmed }
}

/** 纯目录切换段（`cd` / `cd <path>`）：只读，复合校验中直接放行。 */
function isBareCdSegment(segment: string): boolean {
  return /^cd(\s+("[^"]+"|'[^']+'|\S+))?$/.test(segment)
}

function readCdPath(segment: string): { value: string; quoted: boolean } | null {
  const match = /^cd\s+("[^"]+"|'[^']+'|\S+)$/.exec(segment)
  if (!match) return null
  const rawPath = match[1]
  if (
    (rawPath.startsWith('"') && rawPath.endsWith('"')) ||
    (rawPath.startsWith("'") && rawPath.endsWith("'"))
  ) {
    return { value: rawPath.slice(1, -1), quoted: true }
  }
  return { value: rawPath, quoted: false }
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateCdSegment(
  segment: string,
  segmentIndex: number,
  allowedCwdRoot: string | undefined,
): ShellAllowlistDecision | null {
  if (!isBareCdSegment(segment)) return null
  const cdPath = readCdPath(segment)
  if (!cdPath) {
    return {
      allowed: false,
      reason: '受限模式 cd 段必须显式指定路径',
      code: 'not_tabtin',
    }
  }
  if (!cdPath.quoted && /(^~|\$|[*?[])/.test(cdPath.value)) {
    return {
      allowed: false,
      reason: '受限模式 cd 路径不能包含 shell 展开',
      code: 'not_tabtin',
    }
  }
  if (segmentIndex !== 0) {
    return {
      allowed: false,
      reason: '受限模式 cd 只能作为复合命令第一段',
      code: 'not_tabtin',
    }
  }
  if (!allowedCwdRoot) {
    return {
      allowed: false,
      reason: '受限模式缺少工作目录根，拒绝 cd 复合命令',
      code: 'not_tabtin',
    }
  }
  const root = path.resolve(allowedCwdRoot)
  const target = path.resolve(root, cdPath.value)
  if (!isPathInsideOrEqual(root, target)) {
    return {
      allowed: false,
      reason: '受限模式 cd 路径必须位于工作目录根内',
      code: 'not_tabtin',
    }
  }
  return { allowed: true }
}

function extractMainSegmentAfterAllowedCd(
  trimmed: string,
  allowedCwdRoot: string | undefined,
): ParseTabtinFailure | { mainSegment: string } {
  // 允许 0 或 1 个 `cd <path> &&` 前缀（与 tabtin doc / browser 等业务命令的真实工作流对齐）
  // 用 split('&&') 确认整条命令最多两段，且第一段是单一 cd
  const segments = trimmed.split(/\s*&&\s*/)
  if (segments.length > 2) {
    return {
      ok: false,
      reason: '只允许单层 cd ... && tabtin ... 复合命令',
      failKind: 'multi_and',
    }
  }
  if (segments.length === 2) {
    const cdSeg = segments[0].trim()
    // 接受 `cd <path>` / `cd "<path with space>"` / `cd '<path>'` 三种形态。
    // 引号路径在 LLM 跑 `cd "/Users/me/My Documents" && tabtin doc list` 时常见，
    // 旧 `\S+` 正则会把含空格的路径当成多 token 导致复合命令被误判越界。
    if (!/^cd\s+("[^"]+"|'[^']+'|\S+)$/.test(cdSeg)) {
      return {
        ok: false,
        reason: '复合命令前缀必须是单一 cd <path>',
        failKind: 'bad_cd',
      }
    }
    const cdDecision = validateCdSegment(cdSeg, 0, allowedCwdRoot)
    if (!cdDecision?.allowed) {
      return {
        ok: false,
        reason: cdDecision?.reason ?? '复合命令前缀必须是安全 cd <path>',
        failKind: 'bad_cd',
      }
    }
  }
  return { mainSegment: segments[segments.length - 1] }
}

function parseTabtinSubcommand(
  command: string,
  allowedCwdRoot?: string,
): ParseTabtinSuccess | ParseTabtinFailure {
  const trimmed = command.trim()
  const syntaxFailure = rejectUnsupportedShellSyntax(trimmed)
  if (syntaxFailure) return syntaxFailure

  const segmentResult = extractMainSegmentAfterAllowedCd(trimmed, allowedCwdRoot)
  if ('ok' in segmentResult) return segmentResult
  const mainSegment = segmentResult.mainSegment

  // 允许 mainSegment 前置 KEY=value 形态 env（不含 spaces / shell 元字符）
  const tokens = mainSegment.trim().split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=[^\s$`]+$/.test(tokens[i])) {
    i++
  }
  const cmdTokens = tokens.slice(i)

  // 同步在原始字符串上剥掉 env 前缀，保留 quote / 多空格不变形——
  // 给系统命令通道用（system command tokenizer 自己会再做 quote 处理）。
  // 失败兜底：若 regex 替换循环异常退出，回退到 cmdTokens.join(' ')（最坏情况
  // 仅丢失多空格信息，不影响命令语义校验）。
  let strippedMain = mainSegment.trim()
  const envPrefixRe = /^[A-Za-z_][A-Za-z0-9_]*=[^\s$`]+\s+/
  let safetyGuard = 0
  while (envPrefixRe.test(strippedMain) && safetyGuard < 16) {
    strippedMain = strippedMain.replace(envPrefixRe, '')
    safetyGuard++
  }

  if (cmdTokens.length === 0 || cmdTokens[0] !== 'tabtin') {
    return {
      ok: false,
      reason: '只允许 tabtin 命令（受限模式）',
      failKind: 'not_tabtin',
      mainSegment: strippedMain,
    }
  }

  // 提取 tabtin 后非 flag 的位置参数（直到首个以 - 开头的 token）作为子命令路径。
  // tabtin 子命令路径最多支持 3 层（如 `tabtin browser tab list` / `tabtin table record insert`）
  const subTokens: string[] = []
  for (let j = 1; j < cmdTokens.length; j++) {
    const t = cmdTokens[j]
    if (t.startsWith('-')) break
    subTokens.push(t)
    if (subTokens.length >= 4) break // 保守上限，避免吞误识别
  }

  if (subTokens.length === 0) {
    // 裸 `tabtin` 不属于"具体子命令"——返回但让上层用 'tabtin' 作为名字尝试 lookup（commands meta 等）
    return { ok: true, tokens: [], mainSegment: strippedMain }
  }

  return { ok: true, tokens: subTokens, mainSegment: strippedMain }
}

/**
 * 把 parser 失败 reason 映射成既有 ShellAllowlistDecision.code，保证向后兼容。
 * （J3a 之前 not_tabtin / metachar / multi_and / bad_cd 都用 not_tabtin code，
 * 测试断言依赖这个；新加的 system_command_rejected 仅当系统命令 allowlist 拒绝时使用。）
 */
function failKindToLegacyCode(
  failKind: ParseFailReason,
): ShellAllowlistDecision['code'] {
  if (failKind === 'empty') return 'empty_command'
  return 'not_tabtin'
}

function handleParseFailure(parsed: ParseTabtinFailure): ShellAllowlistDecision {
  // J3a：parser 因为"非 tabtin 命令"失败 + mainSegment 可用时，
  // 给系统命令 allowlist 一次机会。其他原因（empty / metachar / multi_and /
  // bad_cd）属根本性失败，不进系统通道——保持原 reject 行为。
  if (parsed.failKind === 'not_tabtin' && parsed.mainSegment) {
    const sysDecision = validateSystemCommand(parsed.mainSegment)
    if (sysDecision.allowed) return { allowed: true }
    // 系统命令 allowlist 也拒绝：把更具体的 system_command_rejected
    // 反馈出去，便于 LLM 区分"完全不识别"vs"识别但 flag 不允许"。
    return {
      allowed: false,
      reason:
        sysDecision.reason ??
        `系统命令 allowlist 拒绝（code=${sysDecision.code ?? 'unknown'}）`,
      code: 'system_command_rejected',
    }
  }
  return {
    allowed: false,
    reason: parsed.reason,
    code: failKindToLegacyCode(parsed.failKind),
  }
}

/** Cobra 的纯帮助调用只打印 usage，不执行命令业务逻辑。 */
function isPureHelpInvocation(mainSegment: string): boolean {
  const tokens = tokenizeShellCommand(mainSegment.trim())
  if (!tokens || tokens[0] !== 'tabtin') return false
  const commandPath = tokens.slice(1, -1)
  const helpFlag = tokens[tokens.length - 1]
  return (
    commandPath.length >= 1 &&
    commandPath.length <= 4 &&
    commandPath.every((token) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(token)) &&
    (helpFlag === '--help' || helpFlag === '-h')
  )
}

interface RiskLookupResult {
  risk: string | null
  matchedPath: string
  lookupFailed: boolean
}

async function lookupRegisteredRisk(
  tokens: string[],
  fetchCommandRisk: FetchCommandRisk,
): Promise<RiskLookupResult> {
  let risk: string | null = null
  let matchedPath = ''
  let lookupFailed = false
  for (let len = tokens.length; len >= 1; len--) {
    const path = `tabtin ${tokens.slice(0, len).join(' ')}`
    try {
      const r = await fetchCommandRisk(path)
      if (r !== null) {
        risk = r
        matchedPath = path
        break
      }
    } catch {
      lookupFailed = true
      // 继续尝试更短前缀；如果全部失败则 lookupFailed
    }
  }
  return { risk, matchedPath, lookupFailed }
}

function decideUnknownRisk(
  tokens: string[],
  lookupFailed: boolean,
  readonlyVerbs: ReadonlySet<string>,
): ShellAllowlistDecision {
  if (lookupFailed) {
    return {
      allowed: false,
      reason:
        '受限模式无法查询命令安全等级（CLI registry 不可达）。请确认 Daemon 启动后重试，' +
        '或在输入框左下角的模式选择器切换到 Agent 模式后再执行。',
      code: 'lookup_failed',
    }
  }
  // CLI schema 未命中——启发式兜底：终末动词在已知只读列表 → 放行
  // （兜底 schema 暂时漏注册的只读子命令）；否则按未识别命令拒绝。
  // 注意 lastVerb 只用于"未注册命令"分支：schema 命中场景已经走 Risk 字段决策，
  // 不会再走到这里，所以位置参数被错当动词的 P0 bug 不会复现。
  const lastVerb = tokens[tokens.length - 1].toLowerCase()
  if (readonlyVerbs.has(lastVerb)) return { allowed: true }
  return {
    allowed: false,
    reason: `未识别的命令 ${tokens.slice(0, 3).join(' ')}（受限模式仅放行 tabtin 已注册的只读子命令）`,
    code: 'unknown_command',
  }
}

function decideRegisteredRisk(risk: string, matchedPath: string): ShellAllowlistDecision {
  // CLI schema 命中：信任 Risk 字段标注，不再二次启发式判断。
  // 历史 bug：之前在此处用 `parsed.tokens[len-1]` 二次启发式，导致
  // `tabtin doc read <uuid>` 这类位置参数被当成"未知动词"错杀。
  const normalizedRisk = risk.trim().toLowerCase()
  if (normalizedRisk === 'write' || normalizedRisk === 'high-risk-write') {
    return {
      allowed: false,
      reason: `命令 ${matchedPath} 标记为 ${normalizedRisk}（修改类操作），受限模式拒绝。`,
      code: 'write_risk',
    }
  }
  return { allowed: true }
}

/**
 * 创建 tabtin-readonly checker。
 *
 * 用法（宿主端示例）：
 * ```ts
 * const checker = createTabtinReadonlyChecker({
 *   fetchCommandRisk: async (subcmd) => {
 *     // 调本地 tabtin commands 缓存或直接 spawn `tabtin commands --format json`
 *     return riskMap.get(subcmd) ?? null
 *   },
 * })
 * const decision = await checker.isAllowed('tabtin doc list --format json')
 * ```
 */
export function createTabtinReadonlyChecker(
  deps: CreateCheckerDeps,
): RestrictedShellAllowlistChecker {
  const { fetchCommandRisk, browserNavAllowlist, allowedCwdRoot } = deps
  const readonlyVerbs = deps.readonlyVerbs ?? EMPTY_READONLY_VERBS

  async function checkSingleSegment(command: string): Promise<ShellAllowlistDecision> {
    const parsed = parseTabtinSubcommand(command, allowedCwdRoot)
    if (!parsed.ok) {
      return handleParseFailure(parsed)
    }

    // 处理裸 `tabtin`（无子命令）—— help/version 等无害默认行为，放行
    if (parsed.tokens.length === 0) {
      return { allowed: true }
    }

    // ：Plan 模式浏览器导航豁免——`browser open/nav/tab switch` 即便
    // Risk=write 也放行（"导航+看"是规划期合理操作）。仅当宿主注入
    // browserNavAllowlist（Plan 模式）时生效；其它写命令仍走下方 Risk 决策。
    if (browserNavAllowlist && parsed.tokens[0] === 'browser') {
      const sub = parsed.tokens.slice(1)
      for (let len = Math.min(sub.length, 2); len >= 1; len--) {
        if (browserNavAllowlist.has(sub.slice(0, len).join(' '))) {
          return { allowed: true }
        }
      }
    }

    // 处理 `tabtin help <subcmd>...` —— Cobra 内置 help 子命令永远只读，
    // 单纯打印命令 usage，不会触发任何业务逻辑。直接放行避免被 unknown_command
    // 错杀（help 路径本身不会出现在 `tabtin commands --format json` schema 里）。
    if (parsed.tokens[0] === 'help') {
      return { allowed: true }
    }

    // 动态 CLI 召回只给一级入口，并引导 `tabtin <一级命令> --help` 继续发现。
    // 仅放行结尾为 help flag、且中间没有其它 flag/参数的纯帮助调用，避免把
    // `--help` 当作业务参数值时绕过写命令风险校验。
    if (isPureHelpInvocation(parsed.mainSegment)) {
      return { allowed: true }
    }

    // 尝试从最长匹配开始向上查找已注册命令的 Risk。
    // 例如 `tabtin browser tab list` 优先尝试 4-token / 3-token / 2-token。
    const riskLookup = await lookupRegisteredRisk(parsed.tokens, fetchCommandRisk)
    return riskLookup.risk === null
      ? decideUnknownRisk(parsed.tokens, riskLookup.lookupFailed, readonlyVerbs)
      : decideRegisteredRisk(riskLookup.risk, riskLookup.matchedPath)
  }

  return {
    async isAllowed(command: string): Promise<ShellAllowlistDecision> {
      // ：复合命令联合校验。仅当顶层拆段**安全且确有拆分符**时启用：
      // 每段独立过白名单（cd 段直接放行），任一段被拒即整条拒绝（fail-close）。
      // 拆段不安全（重定向 / 子 shell / 裸 & / 引号异常）或无拆分符时，
      // 原样走旧单段路径——单段行为零回归，危险形态仍由旧 metachar 检查拒绝。
      const split = splitTopLevelSegments(command.trim())
      if (split.kind === 'reject') {
        return { allowed: false, reason: split.reason, code: 'not_tabtin' }
      }
      if (split.kind === 'segments') {
        for (let index = 0; index < split.segments.length; index++) {
          const segment = split.segments[index]
          const cdDecision = validateCdSegment(segment, index, allowedCwdRoot)
          if (cdDecision) {
            if (cdDecision.allowed) continue
            return cdDecision
          }
          const decision = await checkSingleSegment(segment)
          if (!decision.allowed) {
            return {
              ...decision,
              reason: `复合命令中的「${segment.slice(0, 80)}」被拒：${decision.reason ?? '未知原因'}`,
            }
          }
        }
        return { allowed: true }
      }
      return checkSingleSegment(command)
    },
  }
}

/**
 * 给宿主用的"从 `tabtin commands --format json` 完整 schema 列表生成 Risk 查询函数"工具。
 *
 * 把整个 schema 数组压成 Map<fullName, risk>，避免每次 fetch 都 spawn 子进程。
 *
 * **跳过 `is_group` 条目**：`tabtin commands` 现在也输出 pure group
 * 入口命令（`doc` / `mcp` 等，供 relevant-cli 召回），它们 risk 为空（裸跑只显示
 * help）。但 checker 的 Risk lookup 是最长前缀匹配——若 group 进了 map，未注册的
 * 写子命令（如假想的 `tabtin doc <未注册写动词>`）会借 `tabtin doc` 的空 risk 被
 * 误放行。跳过 group 保持修复前语义：未注册子命令仍走 unknown_command 启发式兜底。
 */
export function buildRiskMapFromSchemas(
  schemas: ReadonlyArray<{ name?: string; risk?: string; is_group?: boolean }>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const s of schemas) {
    if (s?.is_group === true) continue
    if (typeof s?.name === 'string' && s.name.length > 0) {
      const name = s.name.trim()
      const normalizedName = name.startsWith('tabtin ') ? name : `tabtin ${name}`
      map.set(normalizedName, typeof s.risk === 'string' ? s.risk : '')
    }
  }
  return map
}

/** `tabtin commands --format json` 单条命令 schema 的宿主消费视图。 */
export interface CliCommandSchema {
  name?: string
  risk?: string
  output_schema?: Array<{ key?: string; label?: string; type?: string }>
  /** pure group 入口命令标记：仅供发现/召回，不进 risk map。 */
  is_group?: boolean
}

/**
 * 解析 `tabtin commands --format json` 的 stdout 为命令 schema 数组。
 *
 * Go CLI 输出 SuccessEnvelope 形状 `{ ok, data: { commands, global_flags } }`，
 * 解包取 `data.commands`；同时兼容早期 / 其它形状（顶层直接是数组，或直接
 * `{ commands }`）。
 *
 * 宿主 `ElectronAgentHost` / `DaemonAgentHost` 的 `loadCliCommandsAsync` **共用**
 * 此解析，避免两端各写一份 inline 实现造成漂移—— 即因 Go 改输出 envelope
 * 后 Daemon 侧未同步解包，schema 恒为 null，受限模式 fail-close 误拒只读命令。
 *
 * @returns 命令 schema 数组；stdout 非法 JSON 或形状不含数组时返回 null。
 */
export function parseTabtinCommandsJson(stdout: string): CliCommandSchema[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) return parsed as CliCommandSchema[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { commands?: unknown; data?: { commands?: unknown } }
    const commands = obj.data?.commands ?? obj.commands
    if (Array.isArray(commands)) return commands as CliCommandSchema[]
  }
  return null
}

/**
 * 测试用辅助：暴露内部 parser 让 unit test 能验证命令解析正确性。
 */
export const __testExports = {
  parseTabtinSubcommand,
}
