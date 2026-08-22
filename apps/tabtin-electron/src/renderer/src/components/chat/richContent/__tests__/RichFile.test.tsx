import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RichContentBlock } from '@tabtin/chat-client'

const handleResourceLinkClick = vi.fn()
const handleResourceLinkContextMenu = vi.fn()
const openResourceUrlInSpace = vi.fn()
const resourceRouterOpen = vi.fn()
const openResourceTab = vi.fn()
const addSpaceFolder = vi.fn(() => ({ folderId: 'folder-agent', isNew: false }))
const pathExists = vi.fn()
const openPath = vi.fn()
const showItemInFolder = vi.fn()
const openResourcePreview = vi.fn()

const mockVirtualModule = vi.mock as unknown as (
  path: string,
  factory: () => unknown,
  options: { virtual: boolean },
) => void
mockVirtualModule('@tabtin/resource-router', () => ({
  parseResourcePointer: (href: string) => {
    const match = /^tabtin:\/\/resource\/([^/?#]+)\/([^?#]+)(?:\?([^#]*))?/.exec(href)
    const params = new URLSearchParams(match?.[3] ?? '')
    return {
      scheme: 'tabtin',
      type: match ? decodeURIComponent(match[1]!) : 'file',
      id: match ? decodeURIComponent(match[2]!) : href,
      raw: href,
      hint: params.get('hint'),
      meta: Object.fromEntries(params.entries()),
    }
  },
}), { virtual: true })

vi.mock('@tabtin/smartsheet-ui', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => <button type="button" onClick={onSelect}>{children}</button>,
  toast: vi.fn(),
  resolveChoiceTagColors: () => ({ backgroundColor: '#eee', color: '#111' }),
}))

vi.mock('@/services/openResourceLink', () => ({
  handleResourceLinkClick: (event: { preventDefault?: () => void }, href: string) => {
    event.preventDefault?.()
    handleResourceLinkClick(event, href)
  },
  handleResourceLinkContextMenu: (event: { preventDefault?: () => void }, href: string) => {
    event.preventDefault?.()
    handleResourceLinkContextMenu(event, href)
  },
  openResourceUrlInSpace: (...args: unknown[]) => openResourceUrlInSpace(...args),
  resolveSpaceIdForResourceLink: () => 'space-1',
  expandCanvasForScope: vi.fn(),
}))

const openLocalHtmlInSpace = vi.fn().mockResolvedValue({ ok: false, reason: 'open_failed' })
vi.mock('@/services/openLocalHtmlInSpace', () => ({
  openLocalHtmlInSpace: (...args: unknown[]) => openLocalHtmlInSpace(...args),
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (spaceId: string) => spaceId,
}))

vi.mock('@/services/resourceRouter', () => ({
  resourceRouter: {
    open: (...args: unknown[]) => resourceRouterOpen(...args),
  },
  wireResourceRouter: vi.fn(),
  resourceRouterRegistry: {
    register: vi.fn(),
    lookupByScheme: vi.fn(() => []),
  },
  adaptIndustryParams: (params: unknown) => params,
  enrichTabtrackerOpenParams: (params: unknown) => params,
}))

vi.mock('../../preview/useResourcePreviewStore', () => ({
  useResourcePreviewStore: {
    getState: () => ({
      open: (...args: unknown[]) => openResourcePreview(...args),
    }),
  },
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedSpace: { id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' },
      spaces: [{ id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' }],
      selectedAgent: null,
      agentCache: {
        'agent-1': { id: 'agent-1', working_dir: '/Users/me/space', control_device_id: 'dev-A' },
      },
    }),
    getInitialState: () => ({}),
    subscribe: () => () => {},
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign((selector: (state: unknown) => unknown) => selector({
    selectedSpace: { id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' },
    spaces: [{ id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' }],
    selectedAgent: null,
    agentCache: {
      'agent-1': { id: 'agent-1', working_dir: '/Users/me/space', control_device_id: 'dev-A' },
    },
  }), {
    getState: () => ({
      selectedSpace: { id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' },
      spaces: [{ id: 'space-1', type: 'workspace', execution_agent_id: 'agent-1' }],
      selectedAgent: null,
      agentCache: {
        'agent-1': { id: 'agent-1', working_dir: '/Users/me/space', control_device_id: 'dev-A' },
      },
    }),
  }),
}))

// 可变设备态：默认本机即 control device（dev-A）；遥控端用例把 currentDevice 换成 dev-B
const deviceState = {
  currentDevice: { id: 'dev-A' } as { id: string },
  devices: [{ id: 'dev-A', name: 'This Mac' }],
}

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (selector: (state: unknown) => unknown) => selector(deviceState),
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openResourceTab }),
  },
}))

vi.mock('@components/context-space/folder/useFolderStore', () => ({
  useFolderContextStore: {
    getState: () => ({ addSpaceFolder }),
  },
}))

import { RichFile } from '../RichFile'

function fileBlock(overrides: Partial<RichContentBlock> & Record<string, unknown>): RichContentBlock {
  return {
    type: 'rich_content',
    kind: 'file',
    summary: 'report.xlsx',
    ...overrides,
  } as RichContentBlock
}

describe('RichFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    deviceState.currentDevice = { id: 'dev-A' }
    openLocalHtmlInSpace.mockResolvedValue({ ok: false, reason: 'open_failed' })
    pathExists.mockResolvedValue({
      success: true,
      exists: true,
      isFile: true,
      isDirectory: false,
      size: 16000,
      mtimeMs: 123,
    })
    openPath.mockResolvedValue({ success: true })
    showItemInFolder.mockResolvedValue({ success: true })
    ;(window as unknown as { tabtin: Partial<Window['tabtin']> }).tabtin = {
      openPath,
      showItemInFolder,
      fileSystem: {
        pathExists,
      } as Partial<Window['tabtin']['fileSystem']> as Window['tabtin']['fileSystem'],
    }
  })

  it('renders a compact docx local_file artifact card', () => {
    render(
      <RichFile
        block={fileBlock({
          artifact_kind: 'local_file',
          file_type: 'docx',
          relative_path: 'artifacts/report.docx',
          filename: 'report.docx',
          file_size: 8192,
          self_check: { status: 'passed', summary: 'checked' },
        })}
      />,
    )

    expect(screen.getByText('report.docx')).toBeTruthy()
    expect(screen.getByText('card.openFile.format.docx · 8.0 KB')).toBeTruthy()
  })

  it('renders a compact pptx local_file artifact card', () => {
    render(
      <RichFile
        block={fileBlock({
          artifact_kind: 'local_file',
          file_type: 'pptx',
          relative_path: 'artifacts/deck.pptx',
          filename: 'deck.pptx',
          file_size: 24576,
          self_check: { status: 'passed', summary: 'checked' },
        })}
      />,
    )

    expect(screen.getByText('deck.pptx')).toBeTruthy()
    expect(screen.getByText('card.openFile.format.pptx · 24.0 KB')).toBeTruthy()
  })

  it('renders a compact xlsx local_file artifact card and opens via ResourceRouter URL', async () => {
    render(
      <RichFile
        block={fileBlock({
          artifact_kind: 'local_file',
          file_type: 'xlsx',
          relative_path: 'artifacts/report.xlsx',
          filename: 'report.xlsx',
          file_size: 15360,
          self_check: { status: 'passed', summary: 'checked' },
        })}
      />,
    )

    expect(screen.getByText('report.xlsx')).toBeTruthy()
    expect(screen.getByText('card.openFile.format.xlsx · 15.0 KB')).toBeTruthy()
    expect(screen.getByText('card.openFile.openIn')).toBeTruthy()
    expect(screen.queryByTestId('artifact-preview')).toBeNull()
    expect(screen.queryByText('Codex')).toBeNull()
    expect(screen.queryByText('checked')).toBeNull()

    const card = screen.getByTestId('rich-file-card')
    expect(card.getAttribute('data-href')).toBe('tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles&title=report.xlsx')

    // 普通点击走统一主动作（openPrimary → 可预览类型进 Space 预览）
    fireEvent.click(card)
    await waitFor(() => {
      expect(openResourceUrlInSpace).toHaveBeenCalledWith(
        'tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles&title=report.xlsx',
        null,
        expect.objectContaining({
          openIntentHints: expect.objectContaining({ filename: 'report.xlsx' }),
        }),
      )
    })
    expect(handleResourceLinkClick).not.toHaveBeenCalled()
  })

  it('本地 HTML：露出「预览」并与点卡片同走内嵌浏览器', async () => {
    openLocalHtmlInSpace.mockResolvedValue({ ok: true })
    render(
      <RichFile
        block={fileBlock({
          artifact_kind: 'local_file',
          file_type: 'html',
          relative_path: 'artifacts/spring.html',
          filename: 'spring.html',
          file_size: 12288,
        })}
      />,
    )

    expect(screen.getByTestId('artifact-preview')).toBeTruthy()
    expect(screen.getByText('card.openFile.openIn')).toBeTruthy()

    fireEvent.click(screen.getByTestId('artifact-preview'))
    await waitFor(() => {
      expect(openLocalHtmlInSpace).toHaveBeenCalled()
    })
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('previews direct remote xlsx files in the chat lightbox instead of opening tabweb', async () => {
    render(
      <RichFile
        block={fileBlock({
          filename: 'agent-report.xlsx',
          mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          file_size: 1024,
          url: 'https://assets.example.com/tabfiles/uploads/agent-report.xlsx',
        })}
      />,
    )

    fireEvent.click(screen.getByTestId('rich-file-card'))

    expect(openResourcePreview).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'xlsx',
        url: 'https://assets.example.com/tabfiles/uploads/agent-report.xlsx',
        name: 'agent-report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ], 0)
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('renders a compact csv local_file artifact card as a previewable data file', () => {
    render(
      <RichFile
        block={fileBlock({
          artifact_kind: 'local_file',
          file_type: 'csv',
          relative_path: 'artifacts/data.csv',
          filename: 'data.csv',
          file_size: 5120,
          self_check: { status: 'passed', summary: 'checked' },
        })}
      />,
    )

    expect(screen.getByText('data.csv')).toBeTruthy()
    expect(screen.getByText('card.openFile.format.csv · 5.0 KB')).toBeTruthy()

    const card = screen.getByTestId('rich-file-card')
    expect(card.getAttribute('data-href')).toBe('tabtin://resource/file/artifacts%2Fdata.csv?hint=tabfiles&title=data.csv')
  })

  it('uses provided url when present and shows non-passed self-check status', () => {
    render(
      <RichFile
        block={fileBlock({
          url: 'tabtin://resource/file/artifacts%2Fbudget.xlsx?hint=tabfiles',
          file_type: 'xlsx',
          filename: 'budget.xlsx',
          self_check: { status: 'warning', summary: '公式需要复查' },
        })}
      />,
    )

    expect(screen.getByText('budget.xlsx')).toBeTruthy()
    expect(screen.getByText('card.openFile.format.xlsx')).toBeTruthy()
    expect(screen.getByText('公式需要复查')).toBeTruthy()

    const card = screen.getByTestId('rich-file-card')
    expect(card.getAttribute('data-href')).toBe('tabtin://resource/file/artifacts%2Fbudget.xlsx?hint=tabfiles')
  })

  it('auto-opens newly created local file artifacts once', async () => {
    render(
      <RichFile
        block={fileBlock({
          artifact_kind: 'local_file',
          file_type: 'xlsx',
          relative_path: 'artifacts/auto.xlsx',
          filename: 'auto.xlsx',
          auto_open: true,
        })}
      />,
    )

    await waitFor(() => {
      expect(openResourceUrlInSpace).toHaveBeenCalledWith(
        'tabtin://resource/file/artifacts%2Fauto.xlsx?hint=tabfiles&title=auto.xlsx&auto_open=1',
        undefined,
        expect.objectContaining({
          openIntentHints: { filename: 'auto.xlsx' },
        }),
      )
    })
  })

  it('opens 工作空间 as an internal folder tab focused on the artifact file', async () => {
    render(
      <RichFile
        block={fileBlock({
          artifact_kind: 'local_file',
          file_type: 'xlsx',
          relative_path: 'artifacts/report.xlsx',
          filename: 'report.xlsx',
        })}
      />,
    )

    screen.getByText('card.openFile.openInWorkspace').click()

    await waitFor(() => {
      expect(addSpaceFolder).toHaveBeenCalledWith('space-1', {
        rootPath: '/Users/me/space',
        kind: 'sandbox',
        title: 'context:folder.labels.agentTitle',
      })
    })
    expect(openResourceTab).toHaveBeenCalledWith('space-1', {
      type: 'tabfolder',
      id: 'folder-agent',
      title: 'context:folder.labels.agentTitle',
      meta: {
        path: '/Users/me/space',
        kind: 'sandbox',
        reveal_path: '/Users/me/space/artifacts/report.xlsx',
      },
    })
  })

  it('opens unsupported-preview local files through all file action menu entries', async () => {
    render(
      <RichFile
        block={fileBlock({
          artifact_kind: 'local_file',
          file_type: 'md',
          relative_path: 'artifacts/news.md',
          filename: 'news.md',
        })}
      />,
    )

    screen.getByText('card.openFile.openInWorkspace').click()

    await waitFor(() => {
      expect(openResourceTab).toHaveBeenCalledWith('space-1', {
        type: 'tabfolder',
        id: 'folder-agent',
        title: 'context:folder.labels.agentTitle',
        meta: {
          path: '/Users/me/space',
          kind: 'sandbox',
          reveal_path: '/Users/me/space/artifacts/news.md',
        },
      })
    })

    screen.getByText('card.openFile.systemApp').click()
    await waitFor(() => {
      expect(openPath).toHaveBeenCalledWith('/Users/me/space/artifacts/news.md')
    })

    screen.getByText('card.openFile.revealInFinder').click()
    await waitFor(() => {
      expect(showItemInFolder).toHaveBeenCalledWith('/Users/me/space/artifacts/news.md')
    })
  })

  it('遥控端：Open in 下拉替换为不可预览占位，卡片点击不发起打开', () => {
    deviceState.currentDevice = { id: 'dev-B' }
    render(
      <RichFile
        block={fileBlock({
          artifact_kind: 'local_file',
          file_type: 'xlsx',
          relative_path: 'artifacts/report.xlsx',
          filename: 'report.xlsx',
          file_size: 15360,
        })}
      />,
    )

    const placeholder = screen.getByTestId('artifact-remote-unavailable')
    expect(placeholder.textContent).toBe('turnArtifacts.remotePreviewUnavailable')
    expect(placeholder.getAttribute('title')).toBe('card.openFile.remoteUnavailableWithDevice')
    expect(screen.queryByText('card.openFile.openIn')).toBeNull()
    expect(screen.queryByText('card.openFile.openInWorkspace')).toBeNull()

    fireEvent.click(screen.getByTestId('rich-file-card'))
    expect(handleResourceLinkClick).not.toHaveBeenCalled()
  })
})
