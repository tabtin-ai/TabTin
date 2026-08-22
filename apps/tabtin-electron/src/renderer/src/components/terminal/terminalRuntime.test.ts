import { describe, expect, it, vi } from 'vitest'
import type { TerminalCacheEntry } from './terminalRuntime'
import {
  buildTerminalPasteSegments,
  pasteToTerminal,
  refreshTerminalViewport,
  setTerminalCacheEntry,
  syncTerminalPtySize,
  writeTerminalInput,
} from './terminalRuntime'

function createTerminalCacheEntry(options?: {
  bracketedPasteMode?: boolean
  ignoreBracketedPasteMode?: boolean
  cols?: number
  rows?: number
  isSpawned?: boolean
}): TerminalCacheEntry {
  const terminal = {
    cols: options?.cols ?? 80,
    rows: options?.rows ?? 24,
    modes: {
      bracketedPasteMode: options?.bracketedPasteMode ?? false,
    },
    options: {
      ignoreBracketedPasteMode: options?.ignoreBracketedPasteMode ?? false,
      fontSize: 13,
    },
    refresh: vi.fn(),
  } as unknown as TerminalCacheEntry['terminal']

  return {
    terminal,
    fitAddon: {
      fit: vi.fn(),
    } as unknown as TerminalCacheEntry['fitAddon'],
    searchAddon: {} as TerminalCacheEntry['searchAddon'],
    serializeAddon: {} as TerminalCacheEntry['serializeAddon'],
    cleanup: [],
    isSpawned: options?.isSpawned ?? true,
    isSpawning: false,
    dirtyForSnapshot: false,
    createdAt: Date.now(),
  }
}

describe('terminalRuntime paste', () => {
  it('buildTerminalPasteSegments 在 bracketed 模式下包装并避免拆开代理对', () => {
    const text = `${'a'.repeat(1023)}😀tail`
    const segments = buildTerminalPasteSegments(text, {
      bracketedPasteMode: true,
      maxChunkChars: 1024,
    })

    expect(segments[0]).toBe('\x1b[200~')
    expect(segments.at(-1)).toBe('\x1b[201~')
    expect(segments.slice(1, -1).join('')).toBe(text)
    expect(
      segments.slice(1, -1).every((segment) => {
        const lastCode = segment.charCodeAt(segment.length - 1)
        return !(lastCode >= 0xd800 && lastCode <= 0xdbff)
      }),
    ).toBe(true)
  })

  it('pasteToTerminal 会按 session 串行 flush，多次 paste 不会交错', async () => {
    const sessionId = `terminal-paste-${Date.now()}`
    setTerminalCacheEntry(sessionId, createTerminalCacheEntry({
      bracketedPasteMode: true,
    }))

    const writes: string[] = []
    let resolveFirstWrite: (() => void) | null = null
    const firstWriteGate = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve
    })

    const writeMock = vi
      .fn()
      .mockImplementationOnce(async (_sessionId: string, data: string) => {
        writes.push(data)
        await firstWriteGate
        return { success: true }
      })
      .mockImplementation(async (_sessionId: string, data: string) => {
        writes.push(data)
        return { success: true }
      })

    Object.defineProperty(window, 'tabtin', {
      value: {
        ...(window.tabtin ?? {}),
        pty: {
          write: writeMock,
        },
      },
      writable: true,
      configurable: true,
    })

    const firstPaste = pasteToTerminal(sessionId, 'first')
    const secondPaste = pasteToTerminal(sessionId, 'second')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writeMock).toHaveBeenCalledTimes(1)

    resolveFirstWrite?.()
    await Promise.all([firstPaste, secondPaste])

    expect(writes).toEqual([
      '\x1b[200~',
      'first',
      '\x1b[201~',
      '\x1b[200~',
      'second',
      '\x1b[201~',
    ])
  })

  it('在 bracketed paste 结束标记前不会写入方向键', async () => {
    const sessionId = `terminal-input-${Date.now()}`
    setTerminalCacheEntry(sessionId, createTerminalCacheEntry({
      bracketedPasteMode: true,
    }))

    const writes: string[] = []
    let releasePasteStart: (() => void) | null = null
    const pasteStartGate = new Promise<void>((resolve) => {
      releasePasteStart = resolve
    })
    const writeMock = vi.fn(async (_sessionId: string, data: string) => {
      writes.push(data)
      if (data === '\x1b[200~') {
        await pasteStartGate
      }
      return { success: true }
    })

    Object.defineProperty(window, 'tabtin', {
      value: {
        ...(window.tabtin ?? {}),
        pty: {
          write: writeMock,
        },
      },
      writable: true,
      configurable: true,
    })

    const pastedPath = 'apps/tabtin-electron/src/renderer/src/components/chat/markdown/__tests__/mermaidRender.test.ts'
    const paste = pasteToTerminal(sessionId, pastedPath)
    const arrow = writeTerminalInput(sessionId, '\x1b[D')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writes).toEqual(['\x1b[200~'])

    releasePasteStart?.()
    await Promise.all([paste, arrow])

    expect(writes).toEqual([
      '\x1b[200~',
      pastedPath,
      '\x1b[201~',
      '\x1b[D',
    ])
  })
})

describe('terminalRuntime size sync', () => {
  it('spawn 前 fit 出的尺寸不会挡住 spawn 后的强制 resize', () => {
    const sessionId = `terminal-size-${Date.now()}`
    const entry = createTerminalCacheEntry({
      cols: 96,
      rows: 30,
      isSpawned: false,
    })
    setTerminalCacheEntry(sessionId, entry)

    const resizeMock = vi.fn()
    Object.defineProperty(window, 'tabtin', {
      value: {
        ...(window.tabtin ?? {}),
        pty: {
          resize: resizeMock,
        },
      },
      writable: true,
      configurable: true,
    })

    // 模拟 Portal/parking → 可见 slot：spawn 前已经 fit 到 96 列
    refreshTerminalViewport(sessionId)
    expect(resizeMock).not.toHaveBeenCalled()
    expect(entry.lastSyncedPtySize).toBeUndefined()

    // spawn 完成（PTY 可能仍按 80 列创建）后强制同步当前视口
    entry.isSpawned = true
    const synced = syncTerminalPtySize(sessionId, { force: true })

    expect(synced).toEqual({ cols: 96, rows: 30 })
    expect(resizeMock).toHaveBeenCalledWith(sessionId, 96, 30)
    expect(entry.lastSyncedPtySize).toEqual({ cols: 96, rows: 30 })
  })

  it('refreshTerminalViewport 在已 spawn 时会把 fit 后的尺寸推给 PTY', () => {
    const sessionId = `terminal-refresh-${Date.now()}`
    const entry = createTerminalCacheEntry({
      cols: 80,
      rows: 24,
      isSpawned: true,
    })
    setTerminalCacheEntry(sessionId, entry)

    const resizeMock = vi.fn()
    Object.defineProperty(window, 'tabtin', {
      value: {
        ...(window.tabtin ?? {}),
        pty: {
          resize: resizeMock,
        },
      },
      writable: true,
      configurable: true,
    })

    entry.fitAddon.fit = vi.fn(() => {
      Object.defineProperty(entry.terminal, 'cols', { value: 96, configurable: true })
      Object.defineProperty(entry.terminal, 'rows', { value: 28, configurable: true })
    })

    refreshTerminalViewport(sessionId)

    expect(entry.fitAddon.fit).toHaveBeenCalled()
    expect(resizeMock).toHaveBeenCalledWith(sessionId, 96, 28)
    expect(entry.lastSyncedPtySize).toEqual({ cols: 96, rows: 28 })

    // 相同尺寸不再重复 resize；force 才会再推一次
    resizeMock.mockClear()
    refreshTerminalViewport(sessionId)
    expect(resizeMock).not.toHaveBeenCalled()

    syncTerminalPtySize(sessionId, { force: true })
    expect(resizeMock).toHaveBeenCalledWith(sessionId, 96, 28)
  })
})
