/**
 * envelope-error.test.ts — `wrapLegacyError` / `liftLegacyResult` 契约回归
 *
 * 测什么：
 *   - wrapLegacyError 返回符合 ipc-shim envelope 规范的 `{ok:false, error:{code,message}}` 形态
 *   - liftLegacyResult 成功路径原样透传，失败路径 wrap code/message
 *   - detail 字段透传
 *
 * 为什么 critical：这两个 helper 是「main 端 IPC handler 失败信号能正确到达
 * renderer」的契约层。helper 形态一旦回归（譬如有人改成 `error: 'string'`），
 * 整条 read-subagent-session / list-subagent-runs 链路又会被 ipc-shim 吞掉成
 * "returned ok:false without a message" 通用错误（v3.2 dogfood 修过一次，
 * 但只修了局部）。
 */
import { describe, it, expect } from 'vitest'
import { wrapLegacyError, liftLegacyResult } from '../envelope-error'

describe('wrapLegacyError', () => {
  it('produces ipc-shim envelope conformant shape with code === message default', () => {
    const result = wrapLegacyError('parent_session_not_alive')
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'parent_session_not_alive',
        message: 'parent_session_not_alive',
      },
    })
  })

  it('uses explicit human-readable message when provided', () => {
    const result = wrapLegacyError(
      'disk_full',
      '本机磁盘空间不足，无法继续写入归档',
    )
    expect(result.error.code).toBe('disk_full')
    expect(result.error.message).toBe('本机磁盘空间不足，无法继续写入归档')
  })

  it('attaches detail when provided', () => {
    const result = wrapLegacyError('read_failed', undefined, {
      errno: -28,
      path: '/tmp/x.jsonl',
    })
    expect(result.error.detail).toEqual({ errno: -28, path: '/tmp/x.jsonl' })
  })

  it('omits detail field when not provided (don\'t pollute envelope with undefined)', () => {
    const result = wrapLegacyError('subagent_not_found')
    expect('detail' in result.error).toBe(false)
  })
})

describe('liftLegacyResult', () => {
  it('passes ok:true result through unchanged (no re-wrap of success payload)', () => {
    const reader = { ok: true as const, lines: [1, 2, 3], truncated: false }
    const lifted = liftLegacyResult(reader)
    expect(lifted).toBe(reader)
  })

  it('wraps ok:false raw string error into envelope object form', () => {
    const reader = { ok: false as const, error: 'subagent_not_found' }
    const lifted = liftLegacyResult(reader)
    expect(lifted).toEqual({
      ok: false,
      error: { code: 'subagent_not_found', message: 'subagent_not_found' },
    })
  })

  it('preserves reader detail-suffix codes (read_failed:ENOSPC) as both code and message', () => {
    // reader 的 `read_failed:detail` 形态——caller 需要按冒号前缀 startsWith 匹配。
    // lift 应该保留原始字符串作为 code（不要拆冒号），以便 renderer 启发式映射
    // 能继续按完整字符串或前缀做判断。
    const reader = { ok: false as const, error: 'read_failed:ENOSPC: no space left' }
    const lifted = liftLegacyResult(reader)
    expect(lifted.ok).toBe(false)
    if (!lifted.ok) {
      expect(lifted.error.code).toBe('read_failed:ENOSPC: no space left')
      expect(lifted.error.message).toBe('read_failed:ENOSPC: no space left')
    }
  })
})
