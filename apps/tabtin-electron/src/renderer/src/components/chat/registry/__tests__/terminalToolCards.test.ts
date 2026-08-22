/**
 * terminalToolCards — `run_terminal_command` collapsed 卡片摘要契约
 *
 * 钉死 collapsed 列表态的反馈循环：intent 优先，兼容旧 description，
 * fallback 到 command。
 *
 * 与 expanded 态 TerminalCard 的"intent + command 双显示"互补——
 * collapsed 看意图，expanded 看意图 + 实际命令对照。
 */

import { describe, it, expect } from 'vitest'
import { TERMINAL_TOOL_CARDS, extractTerminal } from '../terminalToolCards'

describe('run_terminal_command · compactSummary（collapsed 卡片摘要）', () => {
  const desc = TERMINAL_TOOL_CARDS.run_terminal_command
  const summarize = desc.compactSummary!

  it('intent 是非空 string → 用 intent 作为摘要（替代截断的 command）', () => {
    const result = summarize({ command: 'git reset --hard origin/main', intent: 'Discard all local changes' })
    expect(result).toBe('Discard all local changes')
  })

  it('intent 缺省 → fallback 到截断后的 command', () => {
    const result = summarize({ command: 'ls src/' })
    expect(result).toBe('ls src/')
  })

  it('intent 是空字符串 → fallback 到 command', () => {
    const result = summarize({ command: 'pwd', intent: '' })
    expect(result).toBe('pwd')
  })

  it('intent 是 whitespace-only → fallback 到 command（trim 后判空）', () => {
    const result = summarize({ command: 'date', intent: '   \n\t  ' })
    expect(result).toBe('date')
  })

  it('intent 是非 string 类型（number / null）→ fallback 到 command', () => {
    expect(summarize({ command: 'whoami', intent: 42 })).toBe('whoami')
    expect(summarize({ command: 'whoami', intent: null })).toBe('whoami')
  })

  it('intent 长度 > 60 → 截断 60 字符 + 省略号（防止 collapsed 标题撑爆）', () => {
    const long =
      'Recursively traverse all subdirectories and find files matching the given pattern then delete them'
    const result = summarize({ command: 'find . -delete', intent: long })
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(63) // 60 + '...'
    expect(result!.startsWith('Recursively traverse')).toBe(true)
  })

  it('intent trim 后再截断（首尾空格不计入 60 限额）', () => {
    const padded = '   ' + 'a'.repeat(80) + '   '
    const result = summarize({ command: 'noop', intent: padded })
    expect(result).not.toBeNull()
    // trim 掉前后空格再截断 60 字符
    expect(result!.startsWith('aaaa')).toBe(true)
    expect(result!.length).toBeLessThanOrEqual(63)
  })

  it('input 包了 kwargs → 兼容旧形态', () => {
    const result = summarize({ kwargs: { command: 'ls', intent: 'List files' } })
    expect(result).toBe('List files')
  })

  it('旧 description 回放 → 仍作为摘要兼容', () => {
    const result = summarize({ command: 'ls', description: 'List files' })
    expect(result).toBe('List files')
  })

  it('input 是 null → 返回 null（兼容空 input 的渲染路径）', () => {
    expect(summarize(null)).toBeNull()
    expect(summarize(undefined)).toBeNull()
  })

  it('input 是 object 但完全无字段 → 兜底为空字符串截断（不 crash）', () => {
    const result = summarize({})
    // 没 command 也没 intent/description → truncate('', 60) === ''
    expect(result).toBe('')
  })

  it('无 intent 时保持通用终端摘要，不在 registry 解析业务命令', () => {
    const result = summarize({
      command: 'tabtin media image generate --prompt "a red apple"',
    })
    expect(result).toBe('tabtin media image generate --prompt "a red apple"')
  })

  it('media image generate 有 intent → 仍优先 intent', () => {
    const result = summarize({
      command: 'tabtin media image generate --prompt "a"',
      intent: '画一张红苹果',
    })
    expect(result).toBe('画一张红苹果')
  })
})

// ── 2026-05-17 dogfood 事故回归：extractTerminal 失败路径覆盖 ─────────
//
// 现场：terminal 超时 → runtime `buildToolErrorResult` 输出
// `{ success:false, error_kind:'request_timeout', error:'Command timed out...', stdout:'', stderr:'' }`。
// 老 extractTerminal 的 has-shape 钩子里只识别 success 路径字段（stdout / exit_code 等），
// 这种 error-only payload 直接 `return null` → TerminalCardRenderer 退到 legacy fallback
// → 用户看到 body 完全空白 + "结果正在同步…"，错误原因（hint / error 文案）完全消失。
//
// 修复：has-shape 同时识别 error 路径字段；stderr fallback 把顶层 `error` 升到
// stderr 让用户能看到原因。
describe('extractTerminal · 失败路径覆盖（dogfood 回归）', () => {
  it('error-only payload（success=false, error_kind, error）→ 识别为 terminal kind 并把 error 升到 stderr', () => {
    const errorPayload = {
      success: false,
      error_kind: 'request_timeout',
      abort_reason: 'timeout',
      timeout_ms: 120000,
      stdout: '',
      stderr: '',
      error: 'Command timed out after 120000ms — shell process was terminated.',
      agent_session_id: 'agent-s1-1779015722271-72ha',
    }
    const result = extractTerminal(errorPayload)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('terminal')
    expect((result as { stderr: string }).stderr).toContain('timed out')
    expect((result as { stdout: string }).stdout).toBe('')
    expect((result as { exit_code: number | null }).exit_code).toBeNull()
    expect((result as { session_id?: string }).session_id).toContain('agent-s1')
  })

  it('已有 stderr 时不被 error 字段覆盖（成功路径 + 部分 stderr 正确保留）', () => {
    const result = extractTerminal({
      stdout: 'partial',
      stderr: 'real stderr',
      exit_code: 1,
      error: 'should-not-overwrite',
    })
    expect((result as { stderr: string }).stderr).toBe('real stderr')
  })

  it('JSON string payload 也走错误路径兜底', () => {
    const result = extractTerminal(JSON.stringify({
      success: false,
      error_kind: 'execute_error',
      error: 'boom',
    }))
    expect(result).not.toBeNull()
    expect((result as { stderr: string }).stderr).toBe('boom')
  })

  it('完全无任何字段（empty object） → 返回 null（不识别为 terminal kind）', () => {
    expect(extractTerminal({})).toBeNull()
  })
})
