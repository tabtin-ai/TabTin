/**
 * W3.3 D-5 §6 · main 守护测试：StorageExportFileWriter 路径安全 + sanitize 行为。
 *
 * 守住：
 *   1. _sanitizeFilename 拒绝路径分隔符 / `..` / 非法字符
 *   2. _sanitizeFilename 接受合法名（含中文、含 ISO timestamp）
 *   3. resolveExportDir 返回 `{downloads}/TabTin/exports`
 *
 * 不测试 IPC handler 注册本身——`guardedHandle` 依赖 isTrustedSender，
 * 在单测里 mock 复杂；这部分由 e2e（用户实跑）兜底。
 */

import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === 'downloads') return '/Users/tester/Downloads'
      throw new Error(`unexpected getPath ${key}`)
    }),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => true),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('StorageExportFileWriter · sanitize + 路径解析', () => {
  it('_sanitizeFilename 接受合法文件名', async () => {
    const { __internal } = await import('../StorageExportFileWriter')
    expect(__internal.sanitizeFilename('tabtin-bookmarks-2026-05-04T03-16-00-000Z.json')).toBe(
      'tabtin-bookmarks-2026-05-04T03-16-00-000Z.json',
    )
    expect(__internal.sanitizeFilename('tabtin-voice-中文-test.json')).toBe(
      'tabtin-voice-中文-test.json',
    )
    // 长文件名截到 240
    const long = 'a'.repeat(300) + '.json'
    expect(__internal.sanitizeFilename(long)?.length).toBeLessThanOrEqual(240)
  })

  it('_sanitizeFilename 拒绝路径穿越 / 非法字符 / 空值 / Windows reserved name', async () => {
    const { __internal } = await import('../StorageExportFileWriter')
    expect(__internal.sanitizeFilename('')).toBeNull()
    expect(__internal.sanitizeFilename('   ')).toBeNull()
    expect(__internal.sanitizeFilename('../../etc/passwd')).toBeNull()
    expect(__internal.sanitizeFilename('foo/bar.json')).toBeNull()
    expect(__internal.sanitizeFilename('foo\\bar.json')).toBeNull()
    expect(__internal.sanitizeFilename('foo..json')).toBeNull()
    expect(__internal.sanitizeFilename('foo\u0000bar.json')).toBeNull()
    expect(__internal.sanitizeFilename('foo|bar.json')).toBeNull()
    expect(__internal.sanitizeFilename('foo<bar>.json')).toBeNull()
    expect(__internal.sanitizeFilename(123 as unknown as string)).toBeNull()
    expect(__internal.sanitizeFilename(null as unknown as string)).toBeNull()
    // Windows reserved names（带后缀也拒绝）
    expect(__internal.sanitizeFilename('CON.json')).toBeNull()
    expect(__internal.sanitizeFilename('con.json')).toBeNull()
    expect(__internal.sanitizeFilename('PRN')).toBeNull()
    expect(__internal.sanitizeFilename('NUL.txt')).toBeNull()
    expect(__internal.sanitizeFilename('COM1.json')).toBeNull()
    expect(__internal.sanitizeFilename('LPT9.json')).toBeNull()
    // 含 reserved 但不是单独 reserved 名的应保留
    expect(__internal.sanitizeFilename('CON-ext.json')).toBe('CON-ext.json')
    expect(__internal.sanitizeFilename('connector.json')).toBe('connector.json')
  })

  it('resolveExportDir 返回 {downloads}/TabTin/exports', async () => {
    const { __internal } = await import('../StorageExportFileWriter')
    expect(__internal.resolveExportDir()).toBe(
      path.join('/Users/tester/Downloads', 'TabTin', 'exports'),
    )
  })

  it('IPC channel 名固定，避免后端漂移', async () => {
    const { __internal } = await import('../StorageExportFileWriter')
    expect(__internal.CHANNEL_SAVE_EXPORT).toBe('storage-manager:save-export')
    expect(__internal.CHANNEL_RESOLVE_EXPORT_DIR).toBe('storage-manager:resolve-export-dir')
  })
})
