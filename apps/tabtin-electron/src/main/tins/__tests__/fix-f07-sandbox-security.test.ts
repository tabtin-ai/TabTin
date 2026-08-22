/**
 * F07 修复回归测试（Part 2）
 *
 * CR-011: Sandbox 文件写入使用 0o600 权限 + 完整性校验
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { writeCalls, readCalls, chmodCalls, rmCalls, readOverrideRef } = vi.hoisted(() => {
  const writeCalls: any[] = []
  const readCalls: any[] = []
  const chmodCalls: any[] = []
  const rmCalls: any[] = []
  const readOverrideRef = { fn: null as ((p: string) => string) | null }
  return { writeCalls, readCalls, chmodCalls, rmCalls, readOverrideRef }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mock-user-data' },
  session: { fromPartition: vi.fn(() => ({ clearStorageData: vi.fn(() => Promise.resolve()) })) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}))

vi.mock('fs', async (importOriginal: any) => {
  const actual = await importOriginal()
  const mocked = {
    ...actual,
    existsSync: () => true,
    mkdirSync: () => {},
    writeFileSync: (path: string, content: string, options: any) => {
      writeCalls.push({ path, content, options })
    },
    readFileSync: (path: string) => {
      if (readOverrideRef.fn) {
        const fn = readOverrideRef.fn
        readOverrideRef.fn = null
        const r = fn(path)
        readCalls.push({ path, result: r })
        return r
      }
      const last = [...writeCalls].reverse().find((c: any) => c.path === path)
      const r = last?.content ?? ''
      readCalls.push({ path, result: r })
      return r
    },
    chmodSync: (path: string, mode: number) => {
      chmodCalls.push({ path, mode })
    },
    rmSync: (path: string, options: any) => {
      rmCalls.push({ path, options })
    },
  }
  return { ...mocked, default: mocked }
})


vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('../tin-bridge', () => ({
  generateTinPreloadScript: () => '/* preload */',
  disposeTinBridge: vi.fn(),
}))

vi.mock('../../auth', () => ({
  isTrustedSender: () => true,
}))

import { prepareSandbox } from '../tin-sandbox'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

describe('CR-011: Sandbox files written with 0o600 permissions and integrity check', () => {
  beforeEach(() => {
    writeCalls.length = 0
    readCalls.length = 0
    chmodCalls.length = 0
    rmCalls.length = 0
    readOverrideRef.fn = null
  })

  it('writes preload and HTML files with mode 0o600', () => {
    prepareSandbox({
      instanceId: VALID_UUID,
      panelHtml: '<div>Hello</div>',
      variables: {},
      pageContext: { url: 'https://example.com', title: 'Test' },
    })

    expect(writeCalls.length).toBeGreaterThanOrEqual(2)
    for (const call of writeCalls) {
      expect(call.options).toEqual(expect.objectContaining({ mode: 0o600 }))
    }
  })

  it('calls chmodSync with 0o600 after writing', () => {
    prepareSandbox({
      instanceId: VALID_UUID,
      panelHtml: '<div>Hello</div>',
      variables: {},
      pageContext: { url: 'https://example.com', title: 'Test' },
    })

    expect(chmodCalls.length).toBeGreaterThanOrEqual(2)
    for (const call of chmodCalls) {
      expect(call.mode).toBe(0o600)
    }
  })

  it('performs read-back integrity check after writing', () => {
    prepareSandbox({
      instanceId: VALID_UUID,
      panelHtml: '<div>Hello</div>',
      variables: {},
      pageContext: { url: 'https://example.com', title: 'Test' },
    })

    expect(readCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('throws if integrity check fails (file tampered after write)', () => {
    readOverrideRef.fn = () => 'TAMPERED BY MALWARE'

    expect(() =>
      prepareSandbox({
        instanceId: VALID_UUID,
        panelHtml: '<div>Hello</div>',
        variables: {},
        pageContext: { url: 'https://example.com', title: 'Test' },
      }),
    ).toThrow('Sandbox file integrity check failed')
  })

  it('deletes the tampered file after integrity failure', () => {
    readOverrideRef.fn = () => 'TAMPERED BY MALWARE'

    expect(() =>
      prepareSandbox({
        instanceId: VALID_UUID,
        panelHtml: '<div>Hello</div>',
        variables: {},
        pageContext: { url: 'https://example.com', title: 'Test' },
      }),
    ).toThrow()

    const rmPreload = rmCalls.find((c: any) => c.path.includes('preload.js'))
    expect(rmPreload).toBeDefined()
    expect(rmPreload.options).toEqual({ force: true })
  })
})
