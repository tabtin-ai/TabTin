/**
 * 回归测试：browser/_helpers.ts 安全工具函数
 * 覆盖 BT-001 / BT-002 / BT-003 / BT-004 / BT-008 的修复
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock 依赖 ────────────────────────────────────────────────────────────────

const mockGetCLIViewGetter = vi.hoisted(() => vi.fn(() => null as any))
const mockGetCLIActionExecutor = vi.hoisted(() => vi.fn(() => null as any))
const mockGetCLISpaceId = vi.hoisted(() => vi.fn(() => null as any))
const mockGetCLICrawlspaceId = vi.hoisted(() => vi.fn(() => null as any))
const mockGetCLIContextSpaceBridge = vi.hoisted(() => vi.fn(() => null as any))
const mockGetCLIWorkspaceScopeKey = vi.hoisted(() => vi.fn(() => null as any))
const mockGetCLIOrganizationRoot = vi.hoisted(() => vi.fn(() => '/Users/testuser/workspace' as string | null))
const mockGetHomeTabtinPath = vi.hoisted(() => vi.fn((...segments: string[]) =>
  ['/Users/testuser/.tabtin', ...segments].join('/'),
))

vi.mock('../../cli-context', () => ({
  getCLIViewGetter: mockGetCLIViewGetter,
  getCLIActionExecutor: mockGetCLIActionExecutor,
  getCLISpaceId: mockGetCLISpaceId,
  getCLICrawlspaceId: mockGetCLICrawlspaceId,
  getCLIContextSpaceBridge: mockGetCLIContextSpaceBridge,
  getCLIWorkspaceScopeKey: mockGetCLIWorkspaceScopeKey,
  getCLIOrganizationRoot: mockGetCLIOrganizationRoot,
}))

vi.mock('../shared/error-handler', () => ({
  errorResponse: (code: string, message: string, opts?: any) => ({ code, message, ...opts }),
}))

vi.mock('../../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => ({ getSnapshot: () => null }),
}))

vi.mock('../../../view-factory/ViewFactory', () => ({
  getViewFactory: () => ({ getViewState: () => null }),
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return '/Users/testuser'
      return '/tmp'
    },
  },
}))

vi.mock('@tabtin/shared/storage-paths', () => ({
  getHomeTabtinPath: mockGetHomeTabtinPath,
}))

// node:fs 不 mock — 在测试中用 spyOn 拦截

import {
  validateViewExists,
  isSafeUrl,
  resolveWorkspaceLocalHtmlOpen,
  sanitizeSavePath,
  saveScreenshotFromBase64,
  SCREENSHOT_DIR,
  buildBrowserRequestScope,
  resolveTabId,
  resolveContextBrowserTabId,
} from '../browser/_helpers'

// ─── BT-001: validateViewExists 逻辑修正 ────────────────────────────────────

describe('BT-001: validateViewExists', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('viewGetter 不存在时应返回 false（修复前返回 true）', () => {
    mockGetCLIViewGetter.mockReturnValue(null)
    expect(validateViewExists('any-view-id')).toBe(false)
  })

  it('viewGetter 存在但 view 不存在时返回 false', () => {
    mockGetCLIViewGetter.mockReturnValue(() => null)
    expect(validateViewExists('nonexistent-view')).toBe(false)
  })

  it('view 存在且 webContents 未销毁时返回 true', () => {
    mockGetCLIViewGetter.mockReturnValue(() => ({
      webContents: { isDestroyed: () => false },
    }))
    expect(validateViewExists('valid-view')).toBe(true)
  })

  it('view 存在但 webContents 已销毁时返回 false', () => {
    mockGetCLIViewGetter.mockReturnValue(() => ({
      webContents: { isDestroyed: () => true },
    }))
    expect(validateViewExists('destroyed-view')).toBe(false)
  })

  it('viewGetter 抛出异常时返回 false', () => {
    mockGetCLIViewGetter.mockReturnValue(() => { throw new Error('gone') })
    expect(validateViewExists('error-view')).toBe(false)
  })
})

describe('resolveTabId · workspace scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCLISpaceId.mockReturnValue('space-1')
    mockGetCLICrawlspaceId.mockReturnValue('cs-1')
    mockGetCLIWorkspaceScopeKey.mockReturnValue('conversation:session-1')
  })

  afterEach(() => {
    mockGetCLIWorkspaceScopeKey.mockReturnValue(null)
  })

  it('带 thread 时使用对应 Agent workspace scope 查询 active tab', async () => {
    const bridge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        activeTabKey: 'tabweb:view-conversation',
        tabs: [{ type: 'tabweb', id: 'view-conversation' }],
      },
    })
    mockGetCLIContextSpaceBridge.mockReturnValue(bridge)
    mockGetCLIViewGetter.mockReturnValue((viewId: string) => ({
      id: viewId,
      webContents: { isDestroyed: () => false },
    }))

    const resolved = await resolveTabId('auto', buildBrowserRequestScope({
      _thread_id: 'session-1',
    }))

    expect(resolved).toBe('view-conversation')
    expect(mockGetCLIWorkspaceScopeKey).toHaveBeenCalledWith('session-1')
    expect(bridge).toHaveBeenCalledWith('list_context_space', {
      spaceId: 'space-1',
      tabScopeKey: 'conversation:session-1',
      workspaceScopeKey: 'conversation:session-1',
      crawlspaceId: 'cs-1',
    })
  })

  it('无 thread 的人手请求不读取 Agent/legacy 全局 scope，交给前台 fallback', async () => {
    const bridge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        activeTabKey: 'tabweb:view-foreground',
        tabs: [{ type: 'tabweb', id: 'view-foreground' }],
      },
    })
    mockGetCLIContextSpaceBridge.mockReturnValue(bridge)
    mockGetCLIViewGetter.mockReturnValue((viewId: string) => ({
      id: viewId,
      webContents: { isDestroyed: () => false },
    }))

    const resolved = await resolveTabId('auto', buildBrowserRequestScope({}))

    expect(resolved).toBe('view-foreground')
    expect(mockGetCLIWorkspaceScopeKey).not.toHaveBeenCalled()
    expect(bridge).toHaveBeenCalledWith('list_context_space', {
      spaceId: 'space-1',
      crawlspaceId: 'cs-1',
    })
  })
})

describe('buildBrowserRequestScope', () => {
  it('统一读取 camel/snake scope、thread 与 run alias', () => {
    expect(buildBrowserRequestScope({
      space_id: 'space-1',
      tab_scope_key: 'conversation:tab',
      workspace_scope_key: 'conversation:workspace',
      crawlspace_id: 'crawlspace-1',
      thread_id: 'session-A',
      run_id: 'run-A',
    })).toEqual({
      spaceId: 'space-1',
      tabScopeKey: 'conversation:tab',
      workspaceScopeKey: 'conversation:workspace',
      crawlspaceId: 'crawlspace-1',
      _thread_id: 'session-A',
      runId: 'run-A',
    })
  })
})

describe('resolveContextBrowserTabId · deferred browser tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCLISpaceId.mockReturnValue('space-1')
    mockGetCLICrawlspaceId.mockReturnValue('cs-1')
    mockGetCLIWorkspaceScopeKey.mockReturnValue('conversation:session-1')
  })

  afterEach(() => {
    mockGetCLIWorkspaceScopeKey.mockReturnValue(null)
  })

  it('显式 tabId 只要存在于 renderer 标签清单即可解析，不要求 live webContents', async () => {
    const bridge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        activeTabKey: 'tabweb:view-live',
        tabs: [
          { type: 'tabweb', id: 'view-live' },
          { type: 'tabweb', id: 'view-deferred', meta: { url: 'https://example.com' } },
        ],
      },
    })
    mockGetCLIContextSpaceBridge.mockReturnValue(bridge)
    mockGetCLIViewGetter.mockReturnValue(() => null)

    await expect(resolveContextBrowserTabId('view-deferred')).resolves.toBe('view-deferred')
  })

  it('auto 仍只返回 renderer 当前选中的 browser tab', async () => {
    const bridge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        activeTabKey: 'tabweb:view-deferred',
        tabs: [{ type: 'tabweb', id: 'view-deferred' }],
      },
    })
    mockGetCLIContextSpaceBridge.mockReturnValue(bridge)

    await expect(resolveContextBrowserTabId('auto')).resolves.toBe('view-deferred')
  })
})

// ─── BT-003: isSafeUrl URL 协议校验 ─────────────────────────────────────────

describe('BT-003: isSafeUrl', () => {
  it('允许 https:// URL', () => {
    expect(isSafeUrl('https://example.com')).toBe(true)
    expect(isSafeUrl('https://example.com/path?q=1')).toBe(true)
  })

  it('允许 http:// URL', () => {
    expect(isSafeUrl('http://example.com')).toBe(true)
  })

  it('拒绝 file:// 协议', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeUrl('file://localhost/etc/hosts')).toBe(false)
  })

  it('拒绝 javascript: 协议', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('javascript://comment\nalert(1)')).toBe(false)
  })

  it('拒绝 data: 协议', () => {
    expect(isSafeUrl('data:text/html,<h1>test</h1>')).toBe(false)
  })

  it('拒绝非法 URL 格式', () => {
    expect(isSafeUrl('not-a-url')).toBe(false)
    expect(isSafeUrl('')).toBe(false)
    expect(isSafeUrl('//example.com')).toBe(false)
  })

  it('拒绝 ftp: 协议', () => {
    expect(isSafeUrl('ftp://example.com/file')).toBe(false)
  })
})

// ─── : Workspace 本地 HTML 预览放行 ─────────────────────────────────────

describe('#6847: resolveWorkspaceLocalHtmlOpen', () => {
  const root = '/Users/testuser/workspace'

  beforeEach(() => {
    mockGetCLIOrganizationRoot.mockReturnValue(root)
  })

  it('http(s) 交给 isSafeUrl，本函数返回 null', () => {
    expect(resolveWorkspaceLocalHtmlOpen('https://example.com')).toBeNull()
    expect(resolveWorkspaceLocalHtmlOpen('http://example.com')).toBeNull()
  })

  it('放行 Workspace 内 file:// HTML，并返回 localPreviewRoot', () => {
    const result = resolveWorkspaceLocalHtmlOpen(
      `file://${root}/attachments/report.html`,
      root,
    )
    expect(result).toMatchObject({
      ok: true,
      localPreviewRoot: root,
      title: 'report.html',
    })
    if (result?.ok) {
      expect(result.url.startsWith('file://')).toBe(true)
      expect(result.absolutePath).toBe(`${root}/attachments/report.html`)
    }
  })

  it('放行 Workspace 相对路径 HTML', () => {
    const result = resolveWorkspaceLocalHtmlOpen('attachments/page.htm', root)
    expect(result).toMatchObject({
      ok: true,
      localPreviewRoot: root,
      title: 'page.htm',
      absolutePath: `${root}/attachments/page.htm`,
    })
  })

  it('拒绝 Workspace 外的 file://', () => {
    const result = resolveWorkspaceLocalHtmlOpen('file:///etc/passwd.html', root)
    expect(result).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE' })
  })

  it('拒绝 Workspace 内非 HTML 文件', () => {
    const result = resolveWorkspaceLocalHtmlOpen(`${root}/notes.txt`, root)
    expect(result).toMatchObject({ ok: false, code: 'NOT_HTML' })
  })

  it('无工作目录时拒绝本地 HTML 意图', () => {
    const result = resolveWorkspaceLocalHtmlOpen('attachments/a.html', null)
    expect(result).toMatchObject({ ok: false, code: 'NO_WORKSPACE' })
  })
})

// ─── BT-002 / BT-004: sanitizeSavePath 路径穿越防护 ─────────────────────────

describe('BT-002/BT-004: sanitizeSavePath', () => {
  it('允许 ~/.tabtin 目录下的路径', () => {
    const result = sanitizeSavePath('/Users/testuser/.tabtin/screenshots/test.png')
    expect(result).toBeTruthy()
    expect(result).toContain('.tabtin')
  })

  it('允许 /tmp 目录下的路径', () => {
    const result = sanitizeSavePath('/tmp/test.png')
    expect(result).toBeTruthy()
  })

  it('白名单目录由 runtime resolver 提供，而不是直接拼 home/.tabtin', () => {
    mockGetHomeTabtinPath.mockImplementationOnce((...segments: string[]) =>
      ['/Users/testuser/Library/Application Support/TabTin Preprod/runtime', ...segments].join('/'),
    )
    expect(
      sanitizeSavePath('/Users/testuser/Library/Application Support/TabTin Preprod/runtime/screenshots/test.png'),
    ).toBeTruthy()
  })

  it('拒绝路径穿越攻击（../../../../etc/passwd）', () => {
    const result = sanitizeSavePath('/Users/testuser/.tabtin/../../../../etc/passwd')
    expect(result).toBeNull()
  })

  it('拒绝 /etc 目录', () => {
    expect(sanitizeSavePath('/etc/passwd')).toBeNull()
  })

  it('拒绝 ~/.ssh 目录', () => {
    expect(sanitizeSavePath('/Users/testuser/.ssh/authorized_keys')).toBeNull()
  })

  it('拒绝系统根目录', () => {
    expect(sanitizeSavePath('/authorized_keys')).toBeNull()
  })

  it('规范化 .. 路径后判断白名单', () => {
    // /tmp/../etc/passwd 规范化后是 /etc/passwd，应被拒绝
    const result = sanitizeSavePath('/tmp/../etc/passwd')
    expect(result).toBeNull()
  })
})

// ─── BT-008: saveScreenshotFromBase64 共享实现 ───────────────────────────────
// 注：ESM 模块不支持 spyOn fs，这里只测试安全防护逻辑（路径校验在 fs.write 前执行）

describe('BT-008: saveScreenshotFromBase64 共享实现', () => {
  it('SCREENSHOT_DIR 在 ~/.tabtin/screenshots 下', () => {
    expect(SCREENSHOT_DIR).toContain('.tabtin')
    expect(SCREENSHOT_DIR).toContain('screenshots')
  })

  it('提供不安全路径时在写入前抛出错误（路径穿越防护）', () => {
    // 安全检查在 writeFileSync 之前执行，所以会抛出而不写文件
    expect(() =>
      saveScreenshotFromBase64('aGVsbG8=', '/etc/passwd')
    ).toThrow('不允许将截图保存到该路径')
  })

  it('路径穿越攻击被拦截 ../../../../etc/passwd', () => {
    expect(() =>
      saveScreenshotFromBase64('aGVsbG8=', '/Users/testuser/.tabtin/../../../../etc/passwd')
    ).toThrow('不允许将截图保存到该路径')
  })

  it('~/.ssh 路径被拦截', () => {
    expect(() =>
      saveScreenshotFromBase64('aGVsbG8=', '/Users/testuser/.ssh/authorized_keys')
    ).toThrow('不允许将截图保存到该路径')
  })
})
