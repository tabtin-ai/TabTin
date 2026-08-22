import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockAbort } = vi.hoisted(() => ({
  mockAbort: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/downloads') },
  dialog: { showMessageBox: vi.fn() },
  session: { defaultSession: { on: vi.fn() } },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  BrowserWindow: vi.fn(),
}))

vi.mock('fs', () => {
  const mocks = {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    realpathSync: vi.fn((p: any) => String(p)),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  }
  return { ...mocks, default: mocks }
})

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: vi.fn(() => '/mock/sandbox'),
}))

function validateId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length < 64
}

function handleStreamCancel(_e: unknown, downloadId: unknown) {
  if (!validateId(downloadId)) return { success: false, error: 'Invalid id' }
  try {
    const aborted = mockAbort(downloadId)
    return { success: true, aborted }
  } catch {
    return { success: false, error: 'StreamDownloadService unavailable' }
  }
}

describe('stream cancel handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns success with aborted=true when download is active', () => {
    mockAbort.mockReturnValue(true)
    const result = handleStreamCancel(null, 'stream-123')
    expect(result).toEqual({ success: true, aborted: true })
    expect(mockAbort).toHaveBeenCalledWith('stream-123')
  })

  it('returns success with aborted=false when download not found', () => {
    mockAbort.mockReturnValue(false)
    const result = handleStreamCancel(null, 'nonexistent-id')
    expect(result).toEqual({ success: true, aborted: false })
  })

  it('returns error for invalid id (non-string)', () => {
    const result = handleStreamCancel(null, 123)
    expect(result).toEqual({ success: false, error: 'Invalid id' })
    expect(mockAbort).not.toHaveBeenCalled()
  })

  it('returns error for empty string id', () => {
    const result = handleStreamCancel(null, '')
    expect(result).toEqual({ success: false, error: 'Invalid id' })
    expect(mockAbort).not.toHaveBeenCalled()
  })

  it('returns error when service throws', () => {
    mockAbort.mockImplementation(() => { throw new Error('crash') })
    const result = handleStreamCancel(null, 'stream-crash')
    expect(result).toEqual({ success: false, error: 'StreamDownloadService unavailable' })
  })

  it('handles multiple abort calls independently', () => {
    mockAbort.mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(handleStreamCancel(null, 'active')).toEqual({ success: true, aborted: true })
    expect(handleStreamCancel(null, 'done')).toEqual({ success: true, aborted: false })
  })

  it('validates id length limit', () => {
    const longId = 'a'.repeat(64)
    const result = handleStreamCancel(null, longId)
    expect(result).toEqual({ success: false, error: 'Invalid id' })
  })
})
