/**
 * Unit tests for `apps/tabtin-electron/src/preload/ipc-shim.ts`
 *
 * Coverage focus (W2-α exit criteria):
 *   - LEGACY_HANDLERS passthrough
 *   - envelope ok:true → unwrap data
 *   - envelope ok:false → throw PlatformIpcError with full diagnostics
 *   - non-envelope, non-LEGACY → throw LEGACY_SHAPE
 *   - main-process throw → wrap into PlatformIpcError(IPC_REJECT)
 *   - PlatformIpcError JSON.stringify roundtrip preserves all fields
 *   - PlatformIpcError instance fields are own enumerable (cross-contextBridge survival)
 *   - subscribeIpcCalls subscribe / unsubscribe / multiple subscribers
 *   - sendIpc thin wrapper records ring buffer entry
 *   - getRecentIpcCalls returns shallow copy
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mock state ─────────────────────────────────────────────────
const { ipcMockState } = vi.hoisted(() => ({
  ipcMockState: {
    invokeHandler: null as ((channel: string, ...args: unknown[]) => unknown | Promise<unknown>) | null,
    sendCalls: [] as Array<{ channel: string; args: unknown[] }>,
  },
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      if (!ipcMockState.invokeHandler) {
        throw new Error(`[test] No invokeHandler set for "${channel}"`)
      }
      return ipcMockState.invokeHandler(channel, ...args)
    },
    send: (channel: string, ...args: unknown[]) => {
      ipcMockState.sendCalls.push({ channel, args })
    },
  },
}))

import {
  __resetIpcShimForTesting,
  getRecentIpcCalls,
  invokeIpc,
  LEGACY_HANDLERS,
  PlatformIpcError,
  sendIpc,
  subscribeIpcCalls,
  type IpcCallRecord,
} from '../ipc-shim'
import {
  __resetIpcInspectorBridgeForTests,
  buildDevInspectorBridge,
  type IpcCallRecordForInspector,
} from '../dev-inspector-bridge'

// ── Helpers ────────────────────────────────────────────────────────────

function setHandler(handler: (channel: string, ...args: unknown[]) => unknown | Promise<unknown>): void {
  ipcMockState.invokeHandler = handler
}

beforeEach(() => {
  ipcMockState.invokeHandler = null
  ipcMockState.sendCalls = []
  __resetIpcShimForTesting()
  __resetIpcInspectorBridgeForTests()
})

afterEach(() => {
  __resetIpcShimForTesting()
  __resetIpcInspectorBridgeForTests()
})

// ── PlatformIpcError class shape ───────────────────────────────────────

describe('PlatformIpcError', () => {
  it('exposes all fields as own enumerable properties (contextBridge survives)', () => {
    const err = new PlatformIpcError({
      code: 'UNAUTHORIZED',
      message: 'unauthorized origin',
      ipc_channel: 'auth:login',
      trace_id: 'a3b2c1d4e5f6',
      detail: { hint: 'login again' },
    })

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PlatformIpcError)
    expect(err.name).toBe('PlatformIpcError')
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.message).toBe('unauthorized origin')
    expect(err.ipc_channel).toBe('auth:login')
    expect(err.trace_id).toBe('a3b2c1d4e5f6')
    expect(err.detail).toEqual({ hint: 'login again' })

    // All diagnostic fields must be own enumerable so v8 structured clone
    // (used by contextBridge) preserves them on the renderer side. Default
    // Error.message is enumerable:false — a regression here would silently
    // drop `.message` after cross-process hop.
    const ownEnumerable = Object.entries(Object.getOwnPropertyDescriptors(err))
      .filter(([, desc]) => desc.enumerable === true)
      .map(([key]) => key)
    expect(ownEnumerable.sort()).toEqual(
      ['code', 'detail', 'ipc_channel', 'message', 'name', 'trace_id'].sort(),
    )
  })

  it('omits trace_id / detail from instance when not provided (value undefined)', () => {
    const err = new PlatformIpcError({
      code: 'INTERNAL_ERROR',
      message: 'boom',
      ipc_channel: 'foo:bar',
    })
    expect(err.trace_id).toBeUndefined()
    expect(err.detail).toBeUndefined()
    // Note: TS class field declarations may pre-create the property slot
    // (see useDefineForClassFields). What matters for callers is the
    // value, not whether the slot exists. The toJSON() roundtrip
    // (next test) is the contract that omits undefined fields cleanly.
  })

  it('JSON.stringify roundtrip preserves all diagnostic fields via toJSON', () => {
    const err = new PlatformIpcError({
      code: 'UNAUTHORIZED',
      message: 'forbidden',
      ipc_channel: 'workspace:open',
      trace_id: 'abc123def456',
      detail: { fallback: { title: '新对话' } },
    })

    const json = JSON.stringify(err)
    const parsed = JSON.parse(json) as Record<string, unknown>

    expect(parsed).toEqual({
      name: 'PlatformIpcError',
      code: 'UNAUTHORIZED',
      message: 'forbidden',
      ipc_channel: 'workspace:open',
      trace_id: 'abc123def456',
      detail: { fallback: { title: '新对话' } },
    })
  })

  it('JSON.stringify omits undefined trace_id / detail to keep payload clean', () => {
    const err = new PlatformIpcError({
      code: 'INTERNAL_ERROR',
      message: 'err',
      ipc_channel: 'foo:bar',
    })
    const json = JSON.stringify(err)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed).toEqual({
      name: 'PlatformIpcError',
      code: 'INTERNAL_ERROR',
      message: 'err',
      ipc_channel: 'foo:bar',
    })
    expect(parsed).not.toHaveProperty('trace_id')
    expect(parsed).not.toHaveProperty('detail')
  })

  it('cross-process safe identity check via err.name === "PlatformIpcError"', () => {
    // Renderer-side check pattern (when instanceof can't be trusted across
    // contextBridge): err.name should match.
    const err = new PlatformIpcError({
      code: 'X',
      message: 'y',
      ipc_channel: 'z:w',
    })
    expect(err.name).toBe('PlatformIpcError')
  })
})

// ── invokeIpc envelope ok:true ─────────────────────────────────────────

describe('invokeIpc — envelope ok:true', () => {
  it('returns data unwrapped when channel is NOT in LEGACY_HANDLERS', async () => {
    setHandler(() => ({
      ok: true,
      data: { profile: { id: 42, name: 'Alice' } },
      trace_id: 't-001',
    }))

    const result = await invokeIpc<{ profile: { id: number; name: string } }>(
      'workspace:get-profile',
      'arg-1',
    )

    expect(result).toEqual({ profile: { id: 42, name: 'Alice' } })

    const records = getRecentIpcCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      channel: 'workspace:get-profile',
      status: 'ok',
      trace_id: 't-001',
    })
  })

  it('handles ok:true with undefined data (envelope shape valid even if data is missing)', async () => {
    setHandler(() => ({ ok: true, data: undefined, trace_id: 't-empty' }))
    const result = await invokeIpc('workspace:noop')
    expect(result).toBeUndefined()
    expect(getRecentIpcCalls()[0].status).toBe('ok')
  })
})

// ── invokeIpc envelope ok:false ────────────────────────────────────────

describe('invokeIpc — envelope ok:false', () => {
  it('throws PlatformIpcError with full diagnostics including trace_id', async () => {
    setHandler(() => ({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'forbidden origin',
        retryable: false,
        detail: { hint: 'login again' },
      },
      trace_id: 'tr-9876ab',
    }))

    let caught: unknown
    try {
      await invokeIpc('workspace:open', { id: 1 })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(PlatformIpcError)
    const err = caught as PlatformIpcError
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.message).toBe('forbidden origin')
    expect(err.ipc_channel).toBe('workspace:open')
    expect(err.trace_id).toBe('tr-9876ab')
    expect(err.detail).toEqual({ hint: 'login again' })

    const records = getRecentIpcCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      channel: 'workspace:open',
      status: 'error',
      trace_id: 'tr-9876ab',
      error_code: 'UNAUTHORIZED',
      error_message: 'forbidden origin',
    })
  })

  it('falls back to UNKNOWN_ERROR when error.code is missing or non-string', async () => {
    setHandler(() => ({
      ok: false,
      error: { message: 'mystery failure' },
    }))

    await expect(invokeIpc('workspace:open')).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
      message: 'mystery failure',
    })
  })

  it('synthesizes a default message when error.message is missing', async () => {
    setHandler(() => ({
      ok: false,
      error: { code: 'BOOM' },
    }))

    await expect(invokeIpc('workspace:open')).rejects.toMatchObject({
      code: 'BOOM',
      message: expect.stringContaining('returned ok:false without a message'),
    })
  })

  it('omits trace_id when envelope has none', async () => {
    setHandler(() => ({
      ok: false,
      error: { code: 'X', message: 'Y' },
    }))

    let caught: PlatformIpcError | null = null
    try {
      await invokeIpc('foo:bar')
    } catch (err) {
      caught = err as PlatformIpcError
    }
    expect(caught?.trace_id).toBeUndefined()
  })
})

// ── invokeIpc LEGACY_HANDLERS passthrough ──────────────────────────────

describe('invokeIpc — LEGACY_HANDLERS passthrough', () => {
  it('keeps the Worktree preflight channel on the legacy contract', () => {
    expect(LEGACY_HANDLERS.has('git:worktreeRemovePreflight')).toBe(true)
  })

  it('passes through legacy {success: true} shape without throwing', async () => {
    expect(LEGACY_HANDLERS.has('auth:get')).toBe(true) // sanity check
    setHandler(() => ({ success: true, data: { token: 'xyz' } }))

    const result = await invokeIpc<{ success: boolean; data: { token: string } }>('auth:get')

    expect(result).toEqual({ success: true, data: { token: 'xyz' } })
    expect(getRecentIpcCalls()[0]).toMatchObject({
      channel: 'auth:get',
      status: 'legacy',
    })
  })

  it('passes through legacy {success: false, error: "string"} without throwing', async () => {
    setHandler(() => ({ success: false, error: 'auth failed' }))

    const result = await invokeIpc<{ success: boolean; error: string }>('auth:get')

    expect(result).toEqual({ success: false, error: 'auth failed' })
    expect(getRecentIpcCalls()[0]).toMatchObject({
      channel: 'auth:get',
      status: 'legacy',
    })
  })

  it('passes through legacy raw value (string) without throwing', async () => {
    expect(LEGACY_HANDLERS.has('ping')).toBe(true)
    setHandler(() => 'pong')

    const result = await invokeIpc<string>('ping')

    expect(result).toBe('pong')
    expect(getRecentIpcCalls()[0]).toMatchObject({
      channel: 'ping',
      status: 'legacy',
    })
  })

  it('passes through legacy raw value (number) without throwing', async () => {
    setHandler(() => 42)

    // pick a known legacy channel that returns numeric for this scenario
    expect(LEGACY_HANDLERS.has('notification:setBadgeCount')).toBe(true)
    const result = await invokeIpc<number>('notification:setBadgeCount', 42)

    expect(result).toBe(42)
  })

  it('captures trace_id from legacy result if it happens to carry one', async () => {
    setHandler(() => ({ success: true, data: 'x', trace_id: 'tr-legacy' }))
    await invokeIpc('auth:get')
    expect(getRecentIpcCalls()[0].trace_id).toBe('tr-legacy')
  })

  // Wave 2-α self-review fix: even when a channel is in LEGACY_HANDLERS,
  // the wrapping infra (e.g. ipc-lazy LOAD_FAILED / HANDLER_NOT_FOUND
  // paths from utils/ipc-lazy.ts) returns a wire envelope with ok:false.
  // Silently passing that through would let callers see an undefined
  // result and skip toast — the exact "失败信号被吞掉" trap that
  // motivated the contract project. So invokeIpc throws on envelope
  // ok:false even for LEGACY channels (legacy-shaped errors like
  // `{success:false}` still pass through unchanged).
  it('throws on envelope ok:false even when channel is in LEGACY_HANDLERS (ipc-lazy LOAD_FAILED short-circuit)', async () => {
    expect(LEGACY_HANDLERS.has('fs:readDir')).toBe(true) // a typical lazy-loaded channel
    setHandler(() => ({
      ok: false,
      error: {
        code: 'LOAD_FAILED',
        message: 'Deferred 模块加载失败: FileSystemIPC (channel fs:readDir)',
        detail: { module: 'FileSystemIPC', channel: 'fs:readDir', error_message: 'EBUSY' },
      },
      trace_id: 'tr-load-fail',
    }))

    let caught: unknown
    try {
      await invokeIpc('fs:readDir', '/tmp')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PlatformIpcError)
    const err = caught as PlatformIpcError
    expect(err.code).toBe('LOAD_FAILED')
    expect(err.trace_id).toBe('tr-load-fail')
    expect(err.ipc_channel).toBe('fs:readDir')
    expect((err.detail as { module?: string }).module).toBe('FileSystemIPC')

    expect(getRecentIpcCalls()[0]).toMatchObject({
      channel: 'fs:readDir',
      status: 'error',
      error_code: 'LOAD_FAILED',
      trace_id: 'tr-load-fail',
    })
  })

  it('still passes through legacy {success:false, error:"string"} for LEGACY channels (only envelope ok:false is intercepted)', async () => {
    expect(LEGACY_HANDLERS.has('auth:get')).toBe(true)
    // Legacy shape has neither `ok` nor envelope structure — should pass through
    setHandler(() => ({ success: false, error: 'token expired' }))
    const result = await invokeIpc<{ success: boolean; error: string }>('auth:get')
    expect(result).toEqual({ success: false, error: 'token expired' })
    expect(getRecentIpcCalls()[0].status).toBe('legacy')
  })

  it('still passes through ok:true envelope-ish for LEGACY channels as raw (no unwrap to data)', async () => {
    // ui:report-theme 仍在 LEGACY 内（W6 注释里标了 "returns {ok:true, theme}
    // envelope-ish"）。即便它带 ok:true，缺 data 字段，invokeIpc 透传原始
    // 对象给 caller 而非走 envelope unwrap。这样 LEGACY 透传与 envelope
    // 解析互不干扰。
    expect(LEGACY_HANDLERS.has('ui:report-theme')).toBe(true)
    setHandler(() => ({ ok: true, theme: 'dark' }))
    const result = await invokeIpc<{ ok: boolean; theme: string }>('ui:report-theme')
    expect(result).toEqual({ ok: true, theme: 'dark' })
    expect(getRecentIpcCalls()[0].status).toBe('legacy')
  })

  it('passes through LocalMcpProbeSummary ok:false domain shape for localMcp:probeConnection', async () => {
    expect(LEGACY_HANDLERS.has('localMcp:probeConnection')).toBe(true)
    const probeFailure = {
      ok: false as const,
      probedAt: '2026-07-05T01:00:00.000Z',
      tools: [],
      resources: [],
      prompts: [],
      error: 'Connection refused',
    }
    setHandler(() => probeFailure)
    const result = await invokeIpc<typeof probeFailure>('localMcp:probeConnection', 'conn-1')
    expect(result).toEqual(probeFailure)
    expect(getRecentIpcCalls()[0].status).toBe('legacy')
  })

  it('passes through git-style {ok:false, error:"string"} for LEGACY channels', async () => {
    expect(LEGACY_HANDLERS.has('git:status')).toBe(true)
    setHandler(() => ({ ok: false, error: 'access denied' }))
    const result = await invokeIpc<{ ok: boolean; error: string }>('git:status')
    expect(result).toEqual({ ok: false, error: 'access denied' })
    expect(getRecentIpcCalls()[0].status).toBe('legacy')
  })
})

// ── invokeIpc Tier 0 LEGACY_SHAPE strict mode ──────────────────────────

describe('invokeIpc — non-envelope non-LEGACY → throw LEGACY_SHAPE', () => {
  it('throws PlatformIpcError(LEGACY_SHAPE) when handler returns non-envelope plain object', async () => {
    expect(LEGACY_HANDLERS.has('hypothetical:newchannel')).toBe(false)
    setHandler(() => ({ random: 'data', no_ok_field: true }))

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let caught: unknown
    try {
      await invokeIpc('hypothetical:newchannel')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PlatformIpcError)
    const err = caught as PlatformIpcError
    expect(err.code).toBe('LEGACY_SHAPE')
    expect(err.ipc_channel).toBe('hypothetical:newchannel')
    expect(err.message).toContain('non-envelope shape')
    expect(err.message).toContain('hypothetical:newchannel')

    expect(consoleWarn).toHaveBeenCalled()
    consoleWarn.mockRestore()

    expect(getRecentIpcCalls()[0]).toMatchObject({
      channel: 'hypothetical:newchannel',
      status: 'error',
      error_code: 'LEGACY_SHAPE',
    })
  })

  it('throws LEGACY_SHAPE for null return', async () => {
    setHandler(() => null)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(invokeIpc('hypothetical:nullreturn')).rejects.toMatchObject({
      code: 'LEGACY_SHAPE',
    })
    consoleWarn.mockRestore()
  })

  it('throws LEGACY_SHAPE for undefined return', async () => {
    setHandler(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(invokeIpc('hypothetical:voidreturn')).rejects.toMatchObject({
      code: 'LEGACY_SHAPE',
    })
    consoleWarn.mockRestore()
  })

  it('throws LEGACY_SHAPE when ok field is non-boolean (e.g. truthy string)', async () => {
    setHandler(() => ({ ok: 'yes', data: {} }))
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(invokeIpc('hypothetical:badok')).rejects.toMatchObject({
      code: 'LEGACY_SHAPE',
    })
    consoleWarn.mockRestore()
  })
})

// ── invokeIpc main-process throw ───────────────────────────────────────

describe('invokeIpc — main-process throw → PlatformIpcError(IPC_REJECT)', () => {
  it('wraps main-process Error throw into PlatformIpcError(IPC_REJECT)', async () => {
    setHandler(() => {
      throw new Error('module load failed')
    })

    let caught: unknown
    try {
      await invokeIpc('hypothetical:throws')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(PlatformIpcError)
    const err = caught as PlatformIpcError
    expect(err.code).toBe('IPC_REJECT')
    expect(err.message).toBe('module load failed')
    expect(err.ipc_channel).toBe('hypothetical:throws')
    expect(err.trace_id).toBeUndefined()

    expect(getRecentIpcCalls()[0]).toMatchObject({
      channel: 'hypothetical:throws',
      status: 'error',
      error_code: 'IPC_REJECT',
      error_message: 'module load failed',
    })
  })

  it('handles non-Error thrown values (string)', async () => {
    setHandler(() => {
      throw 'plain string thrown'
    })

    await expect(invokeIpc('hypothetical:throws-string')).rejects.toMatchObject({
      code: 'IPC_REJECT',
      message: 'plain string thrown',
    })
  })
})

// ── subscribeIpcCalls / ring buffer ────────────────────────────────────

describe('subscribeIpcCalls + ring buffer', () => {
  it('notifies subscriber on every invokeIpc call (ok / error / legacy)', async () => {
    const captured: IpcCallRecord[] = []
    const unsub = subscribeIpcCalls((rec) => captured.push(rec))

    setHandler(() => ({ ok: true, data: 'x', trace_id: 't1' }))
    await invokeIpc('hypothetical:env-ok')

    setHandler(() => ({ ok: false, error: { code: 'X', message: 'y' }, trace_id: 't2' }))
    await invokeIpc('hypothetical:env-err').catch(() => {})

    setHandler(() => ({ success: true })) // legacy
    await invokeIpc('auth:get')

    unsub()
    expect(captured).toHaveLength(3)
    expect(captured[0].status).toBe('ok')
    expect(captured[1].status).toBe('error')
    expect(captured[2].status).toBe('legacy')
  })

  it('unsubscribed callback no longer receives records', async () => {
    const captured: IpcCallRecord[] = []
    const unsub = subscribeIpcCalls((rec) => captured.push(rec))

    setHandler(() => ({ ok: true, data: 1 }))
    await invokeIpc('hypothetical:e1')

    unsub()
    setHandler(() => ({ ok: true, data: 2 }))
    await invokeIpc('hypothetical:e2')

    expect(captured).toHaveLength(1)
  })

  it('multiple subscribers all receive the same record', async () => {
    const a: IpcCallRecord[] = []
    const b: IpcCallRecord[] = []
    subscribeIpcCalls((rec) => a.push(rec))
    subscribeIpcCalls((rec) => b.push(rec))

    setHandler(() => ({ ok: true, data: 'x' }))
    await invokeIpc('hypothetical:both')

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]).toEqual(b[0])
  })

  it('subscriber error is swallowed and does not block other subscribers or the IPC call', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const captured: IpcCallRecord[] = []
    subscribeIpcCalls(() => {
      throw new Error('subscriber crash')
    })
    subscribeIpcCalls((rec) => captured.push(rec))

    setHandler(() => ({ ok: true, data: 'x' }))
    const result = await invokeIpc('hypothetical:resilience')

    expect(result).toBe('x')
    expect(captured).toHaveLength(1)
    expect(consoleErr).toHaveBeenCalled()
    consoleErr.mockRestore()
  })

  it('getRecentIpcCalls returns shallow copy not internal reference', async () => {
    setHandler(() => ({ ok: true, data: 'x' }))
    await invokeIpc('hypothetical:shallow-copy')

    const snap1 = getRecentIpcCalls()
    expect(snap1).toHaveLength(1)

    setHandler(() => ({ ok: true, data: 'y' }))
    await invokeIpc('hypothetical:shallow-copy-2')

    const snap2 = getRecentIpcCalls()
    expect(snap1).toHaveLength(1) // snap1 not mutated
    expect(snap2).toHaveLength(2)
  })

  it('ring buffer caps at 200 entries (oldest discarded)', async () => {
    setHandler(() => ({ ok: true, data: null }))
    for (let i = 0; i < 205; i++) {
      await invokeIpc(`hypothetical:cap-${i}`)
    }
    const records = getRecentIpcCalls()
    expect(records).toHaveLength(200)
    // First 5 entries should have been dropped
    expect(records[0].channel).toBe('hypothetical:cap-5')
    expect(records[199].channel).toBe('hypothetical:cap-204')
  })
})

// ── sendIpc thin wrapper ───────────────────────────────────────────────

describe('sendIpc', () => {
  it('forwards to ipcRenderer.send with channel + args', () => {
    sendIpc('foo:event', { x: 1 }, 'extra')
    expect(ipcMockState.sendCalls).toEqual([
      { channel: 'foo:event', args: [{ x: 1 }, 'extra'] },
    ])
  })

  it('records a ring buffer entry with status=legacy (no return value to inspect)', () => {
    sendIpc('foo:event', { x: 1 })
    const records = getRecentIpcCalls()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      channel: 'foo:event',
      status: 'legacy',
    })
    expect(records[0].result_summary).toBeUndefined()
  })
})

// ── LEGACY_HANDLERS sanity ─────────────────────────────────────────────

describe('LEGACY_HANDLERS sanity', () => {
  it('contains the explicit W2-δ-scoped channels', () => {
    expect(LEGACY_HANDLERS.has('tin-bridge:request')).toBe(true)
    expect(LEGACY_HANDLERS.has('pty:snapshot-save-sync')).toBe(true)
  })

  // ：desktop cleanup 域内 `{ok, removed, failed}` 必须透传，否则成功清凭证后
  // 被误判 LEGACY_SHAPE → 假失败 toast。
  it('contains desktop wipe/uninstall cleanup channels ', () => {
    expect(LEGACY_HANDLERS.has('desktop:wipe-credentials')).toBe(true)
    expect(LEGACY_HANDLERS.has('desktop:wipe-local-data')).toBe(true)
    expect(LEGACY_HANDLERS.has('desktop:uninstall-app')).toBe(true)
    expect(LEGACY_HANDLERS.has('desktop:list-cleanup-paths')).toBe(true)
  })

  it('passes through WipeResult {ok:true} without throwing ', async () => {
    const wipeResult = {
      ok: true,
      removed: ['C:\\Users\\x\\AppData\\Roaming\\TabTin\\credentials.json'],
      failed: [] as Array<{ path: string; error: string }>,
      skippedProtected: [] as string[],
    }
    setHandler(() => wipeResult)

    const result = await invokeIpc<typeof wipeResult>('desktop:wipe-credentials')

    expect(result).toEqual(wipeResult)
    expect(getRecentIpcCalls()[0]).toMatchObject({
      channel: 'desktop:wipe-credentials',
      status: 'legacy',
    })
  })

  it('passes through WipeResult {ok:false, failed:[...]} without throwing ', async () => {
    const wipeResult = {
      ok: false,
      removed: [] as string[],
      failed: [{ path: '/tmp/credentials.json', errorCode: 'busy' as const }],
      skippedProtected: [] as string[],
    }
    setHandler(() => wipeResult)

    const result = await invokeIpc<typeof wipeResult>('desktop:wipe-credentials')

    expect(result).toEqual(wipeResult)
    expect(result.ok).toBe(false)
    expect(getRecentIpcCalls()[0].status).toBe('legacy')
  })

  it('does NOT contain api:request — W7 已迁出 LEGACY，main 端用 okResponse 包 HTTP 响应', () => {
    expect(LEGACY_HANDLERS.has('api:request')).toBe(false)
  })

  it('is a non-empty Set (transitional reality, expected to drain over Wave 2-7)', () => {
    expect(LEGACY_HANDLERS.size).toBeGreaterThan(50)
  })

  it('is type-level read-only (TS forbids .add at compile time)', () => {
    // ReadonlySet<string> is a TypeScript-only barrier — at runtime it's
    // still a regular Set so .add() doesn't actually throw. The contract
    // is enforced by the @ts-expect-error directive below: if a future
    // refactor makes LEGACY_HANDLERS mutable (Set instead of ReadonlySet),
    // the @ts-expect-error becomes "unused" and TS compilation fails.
    // @ts-expect-error LEGACY_HANDLERS is ReadonlySet<string>; .add is forbidden at compile time
    const _check: (s: string) => void = (s) => LEGACY_HANDLERS.add(s)
    expect(typeof _check).toBe('function')
  })
})

// ── Args summarization safety ──────────────────────────────────────────

// ── W2-ζ IpcInspector hook integration ────────────────────────────────

describe('IpcInspector hook integration (W2-ζ collaboration)', () => {
  it('forwards every invokeIpc call to dev-inspector-bridge subscribers', async () => {
    const inspector = buildDevInspectorBridge({
      // Minimal IpcRenderer mock — only needs `on` / `removeListener` for
      // the HTTP path; we're testing IPC subscriptions here.
      on: () => {},
      removeListener: () => {},
    } as unknown as Parameters<typeof buildDevInspectorBridge>[0])
    expect(inspector).not.toBeNull()

    const captured: IpcCallRecordForInspector[] = []
    const unsub = inspector!.subscribeIpcCalls((rec) => captured.push(rec))

    setHandler(() => ({ ok: true, data: { profile: 'A' }, trace_id: 't-1' }))
    await invokeIpc('hypothetical:inspector-ok')

    setHandler(() => ({ ok: false, error: { code: 'X', message: 'y' }, trace_id: 't-2' }))
    await invokeIpc('hypothetical:inspector-err').catch(() => {})

    setHandler(() => ({ success: true })) // legacy
    await invokeIpc('auth:get')

    unsub()

    expect(captured).toHaveLength(3)
    expect(captured[0]).toMatchObject({
      source: 'ipc',
      channel: 'hypothetical:inspector-ok',
      status: 'ok',
      trace_id: 't-1',
      result: { profile: 'A' },
    })
    expect(captured[1]).toMatchObject({
      source: 'ipc',
      channel: 'hypothetical:inspector-err',
      status: 'error',
      trace_id: 't-2',
      error: { code: 'X', message: 'y' },
    })
    expect(captured[2]).toMatchObject({
      source: 'ipc',
      channel: 'auth:get',
      status: 'legacy',
      result: { success: true },
    })
  })

  it('forwards sendIpc calls to inspector with status=legacy', () => {
    const inspector = buildDevInspectorBridge({
      on: () => {},
      removeListener: () => {},
    } as unknown as Parameters<typeof buildDevInspectorBridge>[0])
    expect(inspector).not.toBeNull()

    const captured: IpcCallRecordForInspector[] = []
    const unsub = inspector!.subscribeIpcCalls((rec) => captured.push(rec))

    sendIpc('foo:event', { a: 1 })

    unsub()
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      source: 'ipc',
      channel: 'foo:event',
      status: 'legacy',
      args: [{ a: 1 }],
    })
  })

  it('redacts presigned download URLs before forwarding IPC args to inspector', async () => {
    const inspector = buildDevInspectorBridge({
      on: () => {},
      removeListener: () => {},
    } as unknown as Parameters<typeof buildDevInspectorBridge>[0])
    const captured: IpcCallRecordForInspector[] = []
    const unsub = inspector!.subscribeIpcCalls((rec) => captured.push(rec))
    setHandler(() => ({ ok: true, data: { status: 200, headers: {}, data: new ArrayBuffer(0) } }))

    await invokeIpc('oss:get-presigned-object', 'https://oss.example/file?signature=secret')
    unsub()

    expect(captured[0]?.args).toEqual(['<redacted>'])
    expect(JSON.stringify(captured[0])).not.toContain('signature=secret')
  })

  it('redacts URL query strings from api:request diagnostics without changing the caller result', async () => {
    const inspector = buildDevInspectorBridge({
      on: () => {},
      removeListener: () => {},
    } as unknown as Parameters<typeof buildDevInspectorBridge>[0])
    const captured: IpcCallRecordForInspector[] = []
    const unsub = inspector!.subscribeIpcCalls((rec) => captured.push(rec))
    const signedUrl = 'https://oss.example/file.docx?signature=secret&expires=123'
    setHandler(() => ({
      ok: true,
      data: { status: 200, data: { success: true, data: { url: signedUrl } } },
    }))

    const result = await invokeIpc<{ data: { data: { url: string } } }>('api:request')
    unsub()

    expect(result.data.data.url).toBe(signedUrl)
    expect(JSON.stringify(captured[0])).not.toContain('signature=secret')
    expect(JSON.stringify(captured[0])).toContain('https://oss.example/file.docx?<redacted>')
    expect(getRecentIpcCalls()[0]?.result_summary).not.toContain('signature=secret')
  })
})

describe('args / result summarization', () => {
  it('redacts presigned download URLs in the ring buffer', async () => {
    setHandler(() => ({ ok: true, data: null }))
    await invokeIpc('oss:get-presigned-object', 'https://oss.example/file?signature=secret')

    expect(getRecentIpcCalls()[0]?.args_summary).toBe('[\"<redacted>\"]')
  })

  it('truncates very large args summary to ~200 chars', async () => {
    setHandler(() => ({ ok: true, data: null }))
    const bigArg = 'x'.repeat(1000)
    await invokeIpc('hypothetical:bigargs', bigArg)
    const rec = getRecentIpcCalls()[0]
    expect(rec.args_summary.length).toBeLessThanOrEqual(204) // 200 + '...'
    expect(rec.args_summary.endsWith('...')).toBe(true)
  })

  it('handles unserializable args gracefully (e.g. cyclic ref)', async () => {
    setHandler(() => ({ ok: true, data: null }))
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    await invokeIpc('hypothetical:cyclic', cyclic)
    const rec = getRecentIpcCalls()[0]
    expect(rec.args_summary).toBe('<unserializable>')
  })
})
