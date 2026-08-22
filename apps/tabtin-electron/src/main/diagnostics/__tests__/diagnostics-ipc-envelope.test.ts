/**
 * diagnostics IPC envelope 契约回归：handler 必须返 okResponse / errResponse，
 * 否则 preload invokeIpc 会对未登记 channel 抛 LEGACY_SHAPE。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  wrapLogSnapshot,
  handleSaveBundle,
  handleOpenLogDir,
  handleQueueSupportUpload,
} from '../diagnostics-handlers'
import type { DiagnosticsLogSnapshot } from '../../../shared/diagnostics-types'

function isEnvelopeShape(value: unknown): value is { ok: boolean } {
  return (
    typeof value === 'object'
    && value !== null
    && 'ok' in value
    && typeof (value as { ok: unknown }).ok === 'boolean'
  )
}

describe('diagnostics handlers envelope contract ', () => {
  it('wrapLogSnapshot 返 ok:true envelope，且 data 为业务 snapshot', () => {
    const snapshot: DiagnosticsLogSnapshot = {
      available: false,
      logDir: null,
      mainLog: null,
      oldLog: null,
      note: 'dev mode',
    }
    const env = wrapLogSnapshot(snapshot)
    expect(isEnvelopeShape(env)).toBe(true)
    expect(env.ok).toBe(true)
    if (env.ok) {
      expect(env.data).toEqual(snapshot)
    }
  })

  it('handleSaveBundle 非法 payload 返 errResponse，不是 raw {success:false}', async () => {
    const env = await handleSaveBundle(null, {
      merge: vi.fn(),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      resolveDir: () => '/tmp/diag',
    })
    expect(isEnvelopeShape(env)).toBe(true)
    expect(env.ok).toBe(false)
    if (!env.ok) {
      expect(env.error.code).toBe('VALIDATION_ERROR')
      expect(env.error.message).toContain('payload')
    }
    expect(env).not.toHaveProperty('success')
  })

  it('handleSaveBundle 成功路径返 okResponse(DiagnosticsSaveResult)', async () => {
    const zipBytes = Buffer.from('PK\x03\x04fake')
    const env = await handleSaveBundle(
      { filename: 'tabtin-diag-test-1.0.0-20260708-120000.zip', base64: zipBytes.toString('base64') },
      {
        merge: vi.fn(async (buf: Buffer) => ({
          buffer: buf,
          mainLogAttached: false,
          oldLogAttached: false,
          note: 'no main.log',
        })),
        mkdir: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => undefined),
        resolveDir: () => '/tmp/TabTin/diagnostics',
        reveal: vi.fn(),
      },
    )
    expect(isEnvelopeShape(env)).toBe(true)
    expect(env.ok).toBe(true)
    if (env.ok) {
      expect(env.data.absolutePath).toContain('tabtin-diag-test')
      expect(env.data.mainLogAttached).toBe(false)
      expect(env.data).not.toHaveProperty('success')
    }
  })

  it('handleOpenLogDir 无 logDir 返 UNAVAILABLE envelope', async () => {
    const env = await handleOpenLogDir({
      readSnapshot: vi.fn(async () => ({
        available: false,
        logDir: null,
        mainLog: null,
        oldLog: null,
        note: 'dev',
      })),
      mkdir: vi.fn(),
      openPath: vi.fn(),
    })
    expect(isEnvelopeShape(env)).toBe(true)
    expect(env.ok).toBe(false)
    if (!env.ok) {
      expect(env.error.code).toBe('UNAVAILABLE')
    }
  })

  it('主动上传会把已合并的完整包放入可靠队列', async () => {
    const queue = vi.fn(async () => 'support-bundle')
    const env = await handleQueueSupportUpload(
      { filename: 'diagnostic.zip', base64: Buffer.from('zip').toString('base64'), organizationId: 'org-1', clientInstallId: 'install-1' },
      { merge: vi.fn(async (buffer: Buffer) => ({ buffer })), queue },
    )
    expect(env.ok).toBe(true)
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', clientInstallId: 'install-1' }))
  })
})
