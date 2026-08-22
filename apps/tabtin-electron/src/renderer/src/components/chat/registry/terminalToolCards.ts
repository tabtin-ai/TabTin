/**
 * 终端执行 + SSH + 外部 Agent 终端类工具
 */

import type { ToolCardDescriptor, ToolOutputData } from '@tabtin/chat-client'
import { truncate, getNestedArgs, unwrapData } from './toolCardUtils'

/**
 * `run_terminal_command` collapsed 卡片摘要：intent 优先，兼容旧 description，
 * fallback 到 command。
 *
 * 摘要公式：
 *   `intent ?? description ?? truncate(command, MAX)`
 *
 * 设计意图：collapsed 列表态用户扫一眼就能看出"这条 AI 在干嘛"。
 * intent 是 LLM 自述的 5-10 字意图，比截断的 raw command 更人类可读
 * （`git reset --hard origin/main` 截断 → "Discard all local changes"）。
 *
 * TerminalCard 折叠行直接消费此摘要（ToolStepCard 对终端走 self-framed 路径，
 * 外壳 compactSummary 不渲染）；Conversation Canvas 等其它消费方仍读本 helper。
 *
 * 仅 `run_terminal_command` 用此 helper（其它 terminal_execute / execute_in_terminal
 * schema 暂无 intent/description 字段；提取逻辑兼容缺省，不影响那两个工具的现状）。
 */
function summarizeCommandWithIntent(input: unknown): string | null {
  const args = getNestedArgs(input)
  if (!args) return null
  const desc = typeof args.intent === 'string'
    ? args.intent.trim()
    : typeof args.description === 'string'
      ? args.description.trim()
      : ''
  if (desc) return truncate(desc, 60)
  const command = String(args.command ?? '')
  return truncate(command, 60)
}

export function extractTerminal(output: unknown): ToolOutputData | null {
  let payload = output
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (!payload || typeof payload !== 'object') return null

  const d = unwrapData(payload)
  // 钩子放宽（2026-05-17 dogfood 事故堵漏）：除了 stdout/exit_code/backgrounded
  // 这些"成功路径"字段外，也接受 `error` / `error_kind` 这些"失败路径"字段——
  // runtime `buildToolErrorResult` 输出形态 `{ success:false, error_kind, error, ... }`
  // 也应该被识别为 terminal kind 才能走结构化卡片渲染（否则 dogfood 里 tool
  // 超时/抛错只能退到 legacy fallback，body 显示"no output"）。
  // 后台命令新 envelope（ / shell.ts `wait_ms=0` 路径）形态为
  // `{status:"running", session_id, pid, output_file, stdout_tail}`——既无
  // exit_code 也无 stdout，旧 hasSuccessShape 会漏判成 null 退到 legacy。补上
  // status / output_file / pid / stdout_tail 让后台 running 快照也走结构化卡片。
  const hasSuccessShape = 'exit_code' in d || 'exitCode' in d || 'stdout' in d || 'output' in d
    || 'backgrounded' in d || 'status' in d || 'output_file' in d || 'pid' in d || 'stdout_tail' in d
  const hasErrorShape = 'error' in d || 'error_kind' in d
  if (!hasSuccessShape && !hasErrorShape) return null
  // 后台判定：旧 PTY 语义 `backgrounded:true`，或新 envelope `status:"running"`
  // （前台命令阻塞到结束才返回，终态是 completed/failed，不会是 running）。
  const backgrounded = d.backgrounded === true || d.status === 'running'
  const exitCode = d.exit_code ?? d.exitCode
  const durationMs = d.duration_ms ?? d.durationMs
  // 失败路径 stderr fallback：runtime 把"为什么挂的"写在顶层 `error`
  // （譬如 `Command timed out after 120000ms`），原 stderr 通常为空字符串。
  // 没有 stderr 时把 error 升到 stderr 让用户能看到原因；有 stderr 则保留原值。
  const stderr = String(d.stderr ?? '')
  const errorMsg = typeof d.error === 'string' ? d.error : ''
  const effectiveStderr = stderr || errorMsg
  return {
    kind: 'terminal',
    command: String(d.command ?? ''),
    // 后台 running 快照的实时输出在 stdout_tail（非 stdout）；一并兜底。
    stdout: String(d.stdout ?? d.output ?? d.stdout_tail ?? ''),
    stderr: effectiveStderr,
    exit_code: backgrounded ? null : (exitCode != null ? Number(exitCode) : null),
    cwd: String(d.cwd ?? ''),
    duration_ms: typeof durationMs === 'number' ? durationMs : undefined,
    backgrounded,
    session_id: (d.session_id ?? d.sessionId ?? d.agent_session_id ?? d.agentSessionId) != null
      ? String(d.session_id ?? d.sessionId ?? d.agent_session_id ?? d.agentSessionId)
      : undefined,
    space_id: (d.space_id ?? d.spaceId) != null ? String(d.space_id ?? d.spaceId) : undefined,
  } as ToolOutputData
}

export const TERMINAL_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  run_terminal_command: {
    id: 'terminal', category: 'tool', labelKey: 'chat.card.terminal', icon: 'Terminal',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'TerminalCard',
    compactSummary: summarizeCommandWithIntent,
    extractOutput: extractTerminal,
  },
  terminal_execute: {
    id: 'terminal', category: 'tool', labelKey: 'chat.card.terminal', icon: 'Terminal',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'TerminalCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args ? truncate(String(args.command ?? ''), 60) : null },
    extractOutput: extractTerminal,
  },
  execute_in_terminal: {
    id: 'terminal-pty', category: 'tool', labelKey: 'chat.card.terminal', icon: 'Terminal',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'TerminalCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args ? truncate(String(args.command ?? ''), 60) : null },
    extractOutput: extractTerminal,
  },
  write_to_terminal: {
    id: 'terminal-write', category: 'tool', labelKey: 'chat.card.terminal', icon: 'Terminal',
    riskLevel: 'strict', defaultCollapsed: true, renderer: 'TerminalCard',
    compactSummary: (input) => {
      const args = getNestedArgs(input)
      const data = String(args?.data ?? '')
      if (data === '\x03') return 'Ctrl+C'
      return truncate(data, 40)
    },
  },
  read_terminal_output: {
    id: 'terminal-read', category: 'tool', labelKey: 'chat.card.terminal', icon: 'Terminal',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
    compactSummary: (input) => {
      const args = getNestedArgs(input)
      const sid = args?.session_id ? String(args.session_id) : ''
      return sid ? `read [${sid.slice(-6)}]` : 'read output'
    },
  },
  list_terminal_sessions: {
    id: 'terminal-list', category: 'tool', labelKey: 'chat.card.terminal', icon: 'Terminal',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
    compactSummary: () => 'list sessions',
  },

  /* ── SSH ─── */
  ssh_execute: {
    id: 'ssh', category: 'tool', labelKey: 'chat.card.ssh', icon: 'Server',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'SSHCard',
    compactSummary: (input) => {
      const args = getNestedArgs(input)
      if (!args) return null
      const server = args.server_name ?? ''
      const cmd = truncate(String(args.command ?? ''), 40)
      return server ? `[${server}] ${cmd}` : cmd
    },
    extractOutput: extractTerminal,
  },
}

/**
 * Historical transcript display only. These names are not current TabTin tool
 * registry keys; keep them only so imported / old external-agent messages render.
 */
export const HISTORICAL_TERMINAL_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  bash: {
    id: 'historical_terminal', category: 'tool', labelKey: 'chat.card.historical_terminal', icon: 'Terminal',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'TerminalCard', extractOutput: extractTerminal,
  },
  Bash: {
    id: 'historical_terminal', category: 'tool', labelKey: 'chat.card.historical_terminal', icon: 'Terminal',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'TerminalCard', extractOutput: extractTerminal,
  },
  shell: {
    id: 'historical_terminal', category: 'tool', labelKey: 'chat.card.historical_terminal', icon: 'Terminal',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'TerminalCard', extractOutput: extractTerminal,
  },
}
