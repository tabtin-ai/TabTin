/**
 * surface-audit.ts 单测。
 *
 * 覆盖：
 *   - _computeInputHash：SHA-256 前 8 位 hex、边界值处理
 *   - _createAuditDir：目录路径结构
 *   - writeSurfaceAuditLog：写入 + 读回验证 JSONL 格式、目录自动创建
 *   - 写入失败时静默不抛
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

/* ── mock homedir 让审计写到临时目录 ── */
let _tempHome: string

// 注意：storage-paths.ts 用 `import os from 'node:os'`（默认导入）后调用
// `os.homedir()`，所以 mock factory 必须同时覆盖命名导出和 default 导出，
// 否则跨包 import 拿到的仍然是真实 os 对象。
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  const homedir = () => _tempHome
  const actualDefault = (actual as unknown as { default?: typeof actual }).default ?? actual
  return {
    ...actual,
    homedir,
    default: { ...actualDefault, homedir },
  }
})

import {
  writeSurfaceAuditLog,
  _computeInputHash,
  _createAuditDir,
  __resetEnsuredDirsForTest,
  type SurfaceAuditEntry,
} from '../surface-audit.js'

beforeEach(() => {
  _tempHome = mkdtempSync(join(tmpdir(), 'surface-audit-test-'))
  __resetEnsuredDirsForTest()
})

afterEach(() => {
  rmSync(_tempHome, { recursive: true, force: true })
})

// ─── _computeInputHash ──────────────────────────────────────────

describe('_computeInputHash', () => {
  it('返回 SHA-256 前 8 位 hex', () => {
    const input = { sessionId: 'test-123' }
    const expected = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex')
      .slice(0, 8)

    expect(_computeInputHash(input)).toBe(expected)
    expect(_computeInputHash(input)).toHaveLength(8)
  })

  it('undefined 输入 → 空字符串的 hash', () => {
    const expected = createHash('sha256')
      .update('')
      .digest('hex')
      .slice(0, 8)

    expect(_computeInputHash(undefined)).toBe(expected)
  })

  it('相同输入产生相同 hash', () => {
    const a = _computeInputHash({ key: 'value' })
    const b = _computeInputHash({ key: 'value' })
    expect(a).toBe(b)
  })

  it('不同输入产生不同 hash', () => {
    const a = _computeInputHash({ key: 'value-a' })
    const b = _computeInputHash({ key: 'value-b' })
    expect(a).not.toBe(b)
  })

  it('只包含 hex 字符', () => {
    const hash = _computeInputHash({ complex: [1, 2, 3] })
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
  })
})

// ─── _createAuditDir ────────────────────────────────────────────

describe('_createAuditDir', () => {
  it('从 channel 的 module 部分派生目录', () => {
    const dir = _createAuditDir('chat:export-md')
    expect(dir).toContain('audit-log')
    expect(dir).toMatch(/chat$/)
  })

  it('不同 module 对应不同目录', () => {
    const chatDir = _createAuditDir('chat:export-md')
    const workspaceDir = _createAuditDir('workspace:open')
    expect(chatDir).not.toBe(workspaceDir)
    expect(chatDir).toMatch(/chat$/)
    expect(workspaceDir).toMatch(/workspace$/)
  })

  it('无冒号的 channel → 整个字符串作为 module', () => {
    const dir = _createAuditDir('standalone')
    expect(dir).toMatch(/standalone$/)
  })

  it('空字符串 channel → _unknown 兜底', () => {
    const dir = _createAuditDir('')
    expect(dir).toMatch(/_unknown$/)
  })
})

// ─── writeSurfaceAuditLog ───────────────────────────────────────

describe('writeSurfaceAuditLog', () => {
  function _makeEntry(overrides: Partial<SurfaceAuditEntry> = {}): SurfaceAuditEntry {
    return {
      timestamp: '2026-05-03T20:00:00.000Z',
      channel: 'chat:export-md',
      trace_id: 'abc123xyz789',
      input_hash: 'deadbeef',
      ok: true,
      duration_ms: 42,
      ...overrides,
    }
  }

  it('写入有效的 JSONL（可解析回 SurfaceAuditEntry）', () => {
    const entry = _makeEntry()
    writeSurfaceAuditLog(entry)

    const auditDir = join(_tempHome, '.tabtin', 'audit-log', 'chat')
    expect(existsSync(auditDir)).toBe(true)

    const files = readdirSync(auditDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)

    const content = readFileSync(join(auditDir, files[0]), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)

    const parsed = JSON.parse(lines[0])
    expect(parsed.timestamp).toBe('2026-05-03T20:00:00.000Z')
    expect(parsed.channel).toBe('chat:export-md')
    expect(parsed.trace_id).toBe('abc123xyz789')
    expect(parsed.input_hash).toBe('deadbeef')
    expect(parsed.ok).toBe(true)
    expect(parsed.duration_ms).toBe(42)
  })

  it('失败条目包含 error_code 字段', () => {
    const entry = _makeEntry({
      ok: false,
      error_code: 'SESSION_NOT_FOUND',
    })
    writeSurfaceAuditLog(entry)

    const auditDir = join(_tempHome, '.tabtin', 'audit-log', 'chat')
    const files = readdirSync(auditDir)
    const content = readFileSync(join(auditDir, files[0]), 'utf-8')
    const parsed = JSON.parse(content.trim())

    expect(parsed.ok).toBe(false)
    expect(parsed.error_code).toBe('SESSION_NOT_FOUND')
  })

  it('多次写入追加到同一文件', () => {
    writeSurfaceAuditLog(_makeEntry({ input_hash: 'aaaa1111' }))
    writeSurfaceAuditLog(_makeEntry({ input_hash: 'bbbb2222' }))
    writeSurfaceAuditLog(_makeEntry({ input_hash: 'cccc3333' }))

    const auditDir = join(_tempHome, '.tabtin', 'audit-log', 'chat')
    const files = readdirSync(auditDir)
    const content = readFileSync(join(auditDir, files[0]), 'utf-8')
    const lines = content.trim().split('\n')

    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]).input_hash).toBe('aaaa1111')
    expect(JSON.parse(lines[1]).input_hash).toBe('bbbb2222')
    expect(JSON.parse(lines[2]).input_hash).toBe('cccc3333')
  })

  it('不同 module 写到不同子目录', () => {
    writeSurfaceAuditLog(_makeEntry({ channel: 'chat:export-md' }))
    writeSurfaceAuditLog(_makeEntry({ channel: 'workspace:open' }))

    const baseDir = join(_tempHome, '.tabtin', 'audit-log')
    expect(existsSync(join(baseDir, 'chat'))).toBe(true)
    expect(existsSync(join(baseDir, 'workspace'))).toBe(true)
  })

  it('trace_id 为 undefined 时 JSONL 里不含该字段', () => {
    writeSurfaceAuditLog(_makeEntry({ trace_id: undefined }))

    const auditDir = join(_tempHome, '.tabtin', 'audit-log', 'chat')
    const files = readdirSync(auditDir)
    const content = readFileSync(join(auditDir, files[0]), 'utf-8')
    const parsed = JSON.parse(content.trim())

    expect('trace_id' in parsed).toBe(false)
  })

  it('自动创建嵌套目录', () => {
    const baseDir = join(_tempHome, '.tabtin', 'audit-log', 'chat')
    expect(existsSync(baseDir)).toBe(false)

    writeSurfaceAuditLog(_makeEntry())

    expect(existsSync(baseDir)).toBe(true)
  })

  it('目录已存在时不报错（幂等）', () => {
    writeSurfaceAuditLog(_makeEntry())
    writeSurfaceAuditLog(_makeEntry())

    const auditDir = join(_tempHome, '.tabtin', 'audit-log', 'chat')
    const files = readdirSync(auditDir)
    const content = readFileSync(join(auditDir, files[0]), 'utf-8')
    expect(content.trim().split('\n')).toHaveLength(2)
  })
})

// ─── 写入失败静默 ────────────────────────────────────────────────

describe('写入失败时静默不抛', () => {
  it('appendFileSync 报错时不向外抛异常', () => {
    const fs = require('node:fs')
    const originalAppend = fs.appendFileSync
    fs.appendFileSync = () => { throw new Error('磁盘已满') }

    expect(() => {
      writeSurfaceAuditLog({
        timestamp: new Date().toISOString(),
        channel: 'chat:test',
        input_hash: '00000000',
        ok: true,
        duration_ms: 1,
      })
    }).not.toThrow()

    fs.appendFileSync = originalAppend
  })
})
