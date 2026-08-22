import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  sendResourceOpenFallback,
  getTabByView,
  isOrganizationTab,
  shellOpenExternal,
} = vi.hoisted(() => ({
  sendResourceOpenFallback: vi.fn((_mainWindow: unknown, _payload: unknown) => true),
  getTabByView: vi.fn((_viewId: unknown) => 'org-tab-1'),
  isOrganizationTab: vi.fn((_tabId: unknown) => true),
  shellOpenExternal: vi.fn((_url: unknown) => Promise.resolve()),
}))

vi.mock('../../resource-open-fallback', () => ({
  sendResourceOpenFallback: (mainWindow: unknown, payload: unknown) =>
    sendResourceOpenFallback(mainWindow, payload),
}))

vi.mock('../../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: () => ({
    getTabByView: (viewId: unknown) => getTabByView(viewId),
    isOrganizationTab: (tabId: unknown) => isOrganizationTab(tabId),
  }),
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  shell: {
    openExternal: (url: unknown) => shellOpenExternal(url),
  },
}))

import { openUrlInWorkspaceTab } from '../open-in-tab'

describe('openUrlInWorkspaceTab preview intercept', () => {
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sendResourceOpenFallback.mockReturnValue(true)
    getTabByView.mockReturnValue('org-tab-1')
    isOrganizationTab.mockReturnValue(true)
  })

  it('routes crawlspace xlsx window.open to Preview Modal fallback IPC', () => {
    const result = openUrlInWorkspaceTab({
      url: 'https://assets.example.com/report.xlsx',
      viewId: 'view-1',
      mainWindow: mainWindow as never,
      disposition: 'new-window',
    })

    expect(result).toBe('preview')
    expect(sendResourceOpenFallback).toHaveBeenCalledWith(mainWindow, expect.objectContaining({
      url: 'https://assets.example.com/report.xlsx',
      source: 'crawlspace_window_open',
      viewId: 'view-1',
    }))
    expect(shellOpenExternal).not.toHaveBeenCalled()
  })

  it('keeps html pages on the tabweb create-view path', () => {
    const result = openUrlInWorkspaceTab({
      url: 'https://example.com/index.html',
      viewId: 'view-1',
      mainWindow: mainWindow as never,
      title: 'Example',
    })

    expect(result).toBe('sent')
    expect(sendResourceOpenFallback).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'workspace:create-view-requested',
      expect.objectContaining({
        url: 'https://example.com/index.html',
      }),
    )
  })

  it.each([
    'https://cdn.example.com/a.pdf',
    'https://cdn.example.com/a.csv',
    'https://cdn.example.com/a.png',
  ])('previewable %s does not create tabweb view', (url) => {
    expect(openUrlInWorkspaceTab({ url, viewId: 'view-1', mainWindow: mainWindow as never })).toBe('preview')
    expect(sendResourceOpenFallback).toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
      'workspace:create-view-requested',
      expect.anything(),
    )
  })

  it.each([
    'bitbrowser://open?profile=secret',
    'douyin-pc://launch',
  ])('rejects external app protocol %s without creating tab or openExternal', (url) => {
    expect(openUrlInWorkspaceTab({ url, viewId: 'view-1', mainWindow: mainWindow as never })).toBe('invalid')
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
    expect(shellOpenExternal).not.toHaveBeenCalled()
    expect(sendResourceOpenFallback).not.toHaveBeenCalled()
  })
})
