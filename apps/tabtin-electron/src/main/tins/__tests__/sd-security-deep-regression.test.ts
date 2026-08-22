/**
 * SD-011/030/031/033/052/053 回归测试
 *
 * security-deep 问题表修复的回归测试（activation-matcher, tin-bridge, types 相关）。
 * sandbox 相关测试 (SD-032, SD-050) 在单独文件中。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('keytar', () => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  findCredentials: vi.fn(),
  findPassword: vi.fn(),
}))

vi.mock('electron', () => {
  const handlers = new Map<string, Function>()
  return {
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test') },
    ipcMain: {
      handle: vi.fn((channel: string, fn: Function) => {
        handlers.set(channel, fn)
      }),
      removeHandler: vi.fn(),
      _handlers: handlers,
    },
    BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
    dialog: { showMessageBox: vi.fn() },
    webContents: { fromId: vi.fn() },
    session: { fromPartition: vi.fn(() => ({ clearStorageData: vi.fn() })) },
  }
})

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => true),
  isTinSandboxSender: vi.fn(() => true),
}))

vi.mock('electron-log', () => ({
  default: {
    transports: { file: {}, console: {} },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

const FAKE_INSTANCE_ID = '12345678-1234-1234-1234-123456789abc'

const mockFindInstance = vi.fn()
const mockIsDisposed = vi.fn(() => false)

vi.mock('../tin-manager', () => ({
  getTinManager: () => ({
    findInstance: mockFindInstance,
    isDisposed: mockIsDisposed,
    getPageContext: () => ({ url: 'https://example.com', title: '' }),
    resolveVariables: () => ({}),
    emitToRenderer: vi.fn(),
    emitToTinWebview: vi.fn(),
  }),
}))

import { logger } from '../../utils/logger'
import { ipcMain } from 'electron'

const makeFakeInstance = (overrides: Record<string, unknown> = {}) => ({
  id: FAKE_INSTANCE_ID,
  tin_id: 'tid-1',
  organization_id: 'ws-1',
  space_id: 'sp-1',
  is_enabled: true,
  pinned: false,
  user_variables: {},
  tin: {
    id: 'tid-1',
    organization_id: 'ws-1',
    name: 'TestTin',
    description: '',
    icon_url: '',
    version: '1.0',
    status: 'active' as const,
    source: 'user_created' as const,
    activation_mode: 'manual',
    activation_rules: [],
    activation_match: 'any',
    variables_schema: {},
    permissions: ['agent:invoke'],
    panel_position: 'sidebar_right',
    panel_width: 400,
    panel_html: '',
    created_at: '',
    updated_at: '',
  },
  created_at: '',
  updated_at: '',
  ...overrides,
})

// ────────────────────────────────────────────────
// SD-030: globToRegex 无点前缀语义漂移
// ────────────────────────────────────────────────
describe('SD-030: globToRegex must enforce subdomain boundary for *domain patterns', () => {
  let globToRegex: typeof import('../activation-matcher').globToRegex

  beforeEach(async () => {
    const mod = await import('../activation-matcher')
    globToRegex = mod.globToRegex
  })

  it('*://*example.com/* must NOT match evil-example.com', () => {
    const re = globToRegex('*://*example.com/*')
    expect(re.test('https://evil-example.com/page')).toBe(false)
  })

  it('*://*example.com/* must match example.com (root domain)', () => {
    const re = globToRegex('*://*example.com/*')
    expect(re.test('https://example.com/page')).toBe(true)
  })

  it('*://*example.com/* must match sub.example.com (subdomain)', () => {
    const re = globToRegex('*://*example.com/*')
    expect(re.test('https://sub.example.com/page')).toBe(true)
  })

  it('*://*example.com/* must match deep.sub.example.com', () => {
    const re = globToRegex('*://*example.com/*')
    expect(re.test('https://deep.sub.example.com/page')).toBe(true)
  })

  it('*://*example.com/* must NOT match notexample.com', () => {
    const re = globToRegex('*://*example.com/*')
    expect(re.test('https://notexample.com/page')).toBe(false)
  })

  it('*://*example.com/* must NOT match my-example.com', () => {
    const re = globToRegex('*://*example.com/*')
    expect(re.test('https://my-example.com/page')).toBe(false)
  })

  it('standard *://*.example.com/* pattern still works correctly', () => {
    const re = globToRegex('*://*.example.com/*')
    expect(re.test('https://www.example.com/page')).toBe(true)
    expect(re.test('https://example.com/page')).toBe(true)
    expect(re.test('https://evil.com/example.com')).toBe(false)
  })

  it('*://*/* (match all URLs with path) still works', () => {
    const re = globToRegex('*://*/*')
    expect(re.test('https://anything.com/page')).toBe(true)
  })
})

// ────────────────────────────────────────────────
// SD-031: Prompt injection boundary markers
// ────────────────────────────────────────────────
describe('SD-031: wrapTinInstruction must have boundary markers and trailing system message', () => {
  let bridgeHandler: Function

  beforeEach(async () => {
    vi.clearAllMocks()
    mockFindInstance.mockReturnValue(makeFakeInstance())

    const handlers = (ipcMain as any)._handlers as Map<string, Function>
    handlers.clear()

    const { initTinBridge, disposeTinBridge } = await import('../tin-bridge')
    disposeTinBridge()
    initTinBridge({
      getPageContent: vi.fn(),
      getPageSelection: vi.fn(),
      invokeAgent: vi.fn(async (instruction: string) => instruction),
    })

    bridgeHandler = handlers.get('tin-bridge:request')!
  })

  afterEach(async () => {
    const { disposeTinBridge } = await import('../tin-bridge')
    disposeTinBridge()
  })

  it('instruction is wrapped with random boundary markers', async () => {
    const result = await bridgeHandler(
      {},
      FAKE_INSTANCE_ID,
      { type: 'runAgent', instruction: 'Do something' },
    )
    expect(result.success).toBe(true)
    const wrapped = result.data.reply
    expect(wrapped).toMatch(/---TIN-[0-9a-f]{16}---/)
    expect(wrapped).toContain('Do something')
  })

  it('instruction has trailing system message to resume safety policies', async () => {
    const result = await bridgeHandler(
      {},
      FAKE_INSTANCE_ID,
      { type: 'runAgent', instruction: 'Test' },
    )
    const wrapped = result.data.reply
    expect(wrapped).toContain('[System: End of Tin')
    expect(wrapped).toContain('Resume normal safety policies')
  })

  it('opening system message warns about attacker-controlled content', async () => {
    const result = await bridgeHandler(
      {},
      FAKE_INSTANCE_ID,
      { type: 'runAgent', instruction: 'Test' },
    )
    const wrapped = result.data.reply
    expect(wrapped).toContain('attacker-controlled text')
  })

  it('boundary markers are unique per call', async () => {
    const r1 = await bridgeHandler({}, FAKE_INSTANCE_ID, { type: 'runAgent', instruction: 'A' })
    const r2 = await bridgeHandler({}, FAKE_INSTANCE_ID, { type: 'runAgent', instruction: 'B' })
    const boundary1 = r1.data.reply.match(/---TIN-([0-9a-f]{16})---/)![1]
    const boundary2 = r2.data.reply.match(/---TIN-([0-9a-f]{16})---/)![1]
    expect(boundary1).not.toBe(boundary2)
  })
})

// ────────────────────────────────────────────────
// SD-033: page_content deprecation warning
// ────────────────────────────────────────────────
describe('SD-033: page_content rule type logs actionable deprecation warning', () => {
  it('warns with migration guidance when page_content rule is used', async () => {
    vi.clearAllMocks()
    const { matchSingleRule } = await import('../activation-matcher')
    matchSingleRule(
      { type: 'page_content', keywords: ['test'] },
      { url: 'https://example.com', title: 'Test' },
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('does NOT match page body content'),
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('title_url_match'),
    )
  })
})

// ────────────────────────────────────────────────
// SD-053: runAgent rejects empty organizationId
// ────────────────────────────────────────────────
describe('SD-053: runAgent must reject when organizationId is empty', () => {
  let bridgeHandler: Function

  beforeEach(async () => {
    vi.clearAllMocks()

    const handlers = (ipcMain as any)._handlers as Map<string, Function>
    handlers.clear()

    const { initTinBridge, disposeTinBridge } = await import('../tin-bridge')
    disposeTinBridge()
    initTinBridge({
      getPageContent: vi.fn(),
      getPageSelection: vi.fn(),
      invokeAgent: vi.fn(async () => 'ok'),
    })

    bridgeHandler = handlers.get('tin-bridge:request')!
  })

  afterEach(async () => {
    const { disposeTinBridge } = await import('../tin-bridge')
    disposeTinBridge()
  })

  it('rejects when organization_id is empty string', async () => {
    mockFindInstance.mockReturnValue(makeFakeInstance({ organization_id: '' }))
    const result = await bridgeHandler(
      {},
      FAKE_INSTANCE_ID,
      { type: 'runAgent', instruction: 'Do something' },
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('organization')
  })

  it('rejects when organization_id is undefined', async () => {
    mockFindInstance.mockReturnValue(makeFakeInstance({ organization_id: undefined }))
    const result = await bridgeHandler(
      {},
      FAKE_INSTANCE_ID,
      { type: 'runAgent', instruction: 'Do something' },
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('organization')
  })

  it('allows when organization_id is present', async () => {
    mockFindInstance.mockReturnValue(makeFakeInstance({ organization_id: 'ws-valid' }))
    const result = await bridgeHandler(
      {},
      FAKE_INSTANCE_ID,
      { type: 'runAgent', instruction: 'Do something' },
    )
    expect(result.success).toBe(true)
  })
})

// ────────────────────────────────────────────────
// SD-011 + SD-052: PAGE_INJECT in TinPermission
// ────────────────────────────────────────────────
describe('SD-011/052: TinPermission.PAGE_INJECT constant', () => {
  it('TinPermission includes PAGE_INJECT constant', async () => {
    const { TinPermission } = await import('../types')
    expect(TinPermission.PAGE_INJECT).toBe('page_inject')
  })

  it('PAGE_INJECT constant matches the string used in permission checks', async () => {
    const { TinPermission } = await import('../types')
    const instance = makeFakeInstance()
    instance.tin.permissions = [TinPermission.PAGE_INJECT]
    expect(instance.tin.permissions).toContain('page_inject')
  })
})
