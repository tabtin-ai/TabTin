import React from 'react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnArtifact } from '../turnArtifacts'
import { ImConversationCanvasProvider } from '@/components/tabchat/ImConversationCanvasContext'

const openResourceUrlInSpace = vi.fn()
const openLocalArtifactWithSystemApp = vi.fn()
const openLocalHtmlInSpace = vi.fn()
const openArtifactWorkspaceDir = vi.fn()
const revealArtifactInFinder = vi.fn()
const openSharedResourceTab = vi.fn()
const openCloudDocumentPreview = vi.fn()
const toast = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      if (key === 'turnArtifacts.showMoreFiles') {
        return `${key}:${options?.count ?? 0}`
      }
      return key
    },
    i18n: { language: 'zh-CN' },
  }),
}))

// 遥控端判定可按用例切换
const remoteViewerState = {
  isRemoteViewer: false,
  isResolving: false,
  controlDeviceName: null as string | null,
  controlDeviceId: null as string | null,
  workingDir: null as string | null,
}

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
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  // 模拟 Portal 仍沿 React 树冒泡：Item 不 stopPropagation，靠 Content.onClick 阻断。
  DropdownMenuContent: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (event: React.MouseEvent) => void
  }) => (
    <div data-testid="dropdown-menu-content" onClick={onClick}>
      {children}
    </div>
  ),
  DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) =>
    <button type="button" onClick={() => onSelect?.()}>{children}</button>,
  resolveChoiceTagColors: vi.fn(() => ({ backgroundColor: '#000000', color: '#ffffff' })),
  stableHash: vi.fn(() => 0),
  CHOICE_COLOR_HEX_MAP: {},
  FALLBACK_TAG_BG_COLORS: [],
  FALLBACK_TAG_TEXT_COLORS: [],
  normalizeHexColor: vi.fn((value: string) => value),
  isLightHexColor: vi.fn(() => false),
  toast: (...args: unknown[]) => toast(...args),
}))

vi.mock('@/services/openResourceLink', () => ({
  openResourceUrlInSpace: (...args: unknown[]) => openResourceUrlInSpace(...args),
  resolveSpaceIdForResourceLink: () => 'space-1',
  expandCanvasForScope: vi.fn(),
}))

vi.mock('@/services/openLocalArtifactSystemApp', () => ({
  openLocalArtifactWithSystemApp: (...args: unknown[]) =>
    openLocalArtifactWithSystemApp(...args),
}))

vi.mock('@/services/openLocalHtmlInSpace', () => ({
  openLocalHtmlInSpace: (...args: unknown[]) => openLocalHtmlInSpace(...args),
}))

vi.mock('@/services/localArtifactActions', () => ({
  openArtifactWorkspaceDir: (...args: unknown[]) => openArtifactWorkspaceDir(...args),
  revealArtifactInFinder: (...args: unknown[]) => revealArtifactInFinder(...args),
}))

vi.mock('@/services/openSharedResource', () => ({
  openSharedResourceTab: (...args: unknown[]) => openSharedResourceTab(...args),
}))

vi.mock('@/components/chat/preview/useCloudDocumentPreviewStore', () => ({
  useCloudDocumentPreviewStore: {
    getState: () => ({ open: (...args: unknown[]) => openCloudDocumentPreview(...args) }),
  },
}))

vi.mock('@/components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: {
    getState: () => ({
      selectedProjectId: 'space-1',
      activeTaskSessionId: 'session-1',
    }),
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      messagesBySessionId: {},
    }),
  },
}))

// 与真实实现同口径的最小判定：hint=tabfiles 视为本地文件产物
vi.mock('@/services/localFileResourceResolver', () => {
  const isLocal = (href: string) =>
    /^tabtin:\/\/resource\/file\//.test(href) && href.includes('hint=tabfiles')
  const previewable = (href: string) => {
    const lower = href.toLowerCase()
    return lower.includes('.xlsx') || lower.includes('.mp4')
  }
  return {
    shouldResolveAsLocalFile: (pointer: { scheme: string; type: string; hint: string | null }) =>
      pointer.scheme === 'tabtin' && pointer.type === 'file' && pointer.hint === 'tabfiles',
    isLocalFilePreviewSupported: (path: string) => {
      const lower = path.toLowerCase()
      return lower.endsWith('.xlsx') || lower.endsWith('.mp4')
    },
    isLocalFileArtifactHref: (href: string) => isLocal(href),
    isUnsupportedLocalArtifactHref: (href: string) => isLocal(href) && !previewable(href),
    isLocalHtmlArtifactHref: (href: string) =>
      isLocal(href) && (href.toLowerCase().includes('.html') || href.toLowerCase().includes('.htm')),
    resolveLocalFilePath: vi.fn(),
  }
})

vi.mock('@components/context-space/hooks/useIsRemoteViewer', () => ({
  useIsRemoteViewer: () => remoteViewerState,
}))

import { TurnArtifactsCard } from '../TurnArtifactsCard'

const LOCAL_FILE_ARTIFACT: TurnArtifact = {
  id: 'a1',
  kind: 'file',
  title: 'demo-table.xlsx',
  href: 'tabtin://resource/file/artifacts%2Fdemo-table.xlsx?hint=tabfiles&title=demo-table.xlsx',
  subtitleKey: 'previewFile',
}

const LOCAL_HTML_ARTIFACT: TurnArtifact = {
  id: 'a-html',
  kind: 'file',
  title: 'spring.html',
  href: 'tabtin://resource/file/artifacts%2Fspring.html?hint=tabfiles&title=spring.html',
  subtitleKey: 'previewFile',
}

const UNSUPPORTED_LOCAL_ARTIFACT: TurnArtifact = {
  id: 'a-zip',
  kind: 'file',
  title: 'bundle.zip',
  href: 'tabtin://resource/file/artifacts%2Fbundle.zip?hint=tabfiles&title=bundle.zip',
  subtitleKey: 'previewFile',
}

const CLOUD_DOC_ARTIFACT: TurnArtifact = {
  id: 'a2',
  kind: 'doc',
  title: '随手文档',
  href: 'tabtin://resource/document/doc_1?hint=tabdoc',
  subtitleKey: 'previewDoc',
}

const PROJECT_TASK_DOC_ARTIFACT: TurnArtifact = {
  ...CLOUD_DOC_ARTIFACT,
  id: 'a-project-task-doc',
  resourceSpaceId: 'companion-workspace-1',
}

function makeLocalFileArtifact(index: number): TurnArtifact {
  return {
    id: `local-file-${index}`,
    kind: 'file',
    title: `file-${index}.md`,
    href: `tabtin://resource/file/artifacts%2Ffile-${index}.md?hint=tabfiles&title=file-${index}.md`,
    subtitleKey: 'previewFile',
  }
}

function renderCard(artifacts: TurnArtifact[], historyArtifacts: TurnArtifact[] = []) {
  return render(
    <TurnArtifactsCard
      artifacts={artifacts}
      historyArtifacts={historyArtifacts}
      sessionId="session-1"
    />,
  )
}

describe('TurnArtifactsCard — 与 create_file 卡统一的打开方式', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    remoteViewerState.isRemoteViewer = false
    remoteViewerState.controlDeviceName = null
    openResourceUrlInSpace.mockResolvedValue({ outcome: 'in_space_opened', carrierAppId: 'tabfiles', resolveSource: 'manifest_default' })
    openLocalHtmlInSpace.mockResolvedValue({ ok: false, reason: 'open_failed' })
    openLocalArtifactWithSystemApp.mockResolvedValue({ ok: true, absolutePath: '/abs/x' })
    revealArtifactInFinder.mockResolvedValue({ ok: true })
  })

  it('挂载本轮产物卡不会自动打开或创建标签', async () => {
    const artifacts = [
      {
        ...makeLocalFileArtifact(1),
        title: 'file-1.xlsx',
        href: 'tabtin://resource/file/artifacts%2Ffile-1.xlsx?hint=tabfiles&title=file-1.xlsx',
      },
      {
        ...makeLocalFileArtifact(2),
        title: 'file-2.xlsx',
        href: 'tabtin://resource/file/artifacts%2Ffile-2.xlsx?hint=tabfiles&title=file-2.xlsx',
      },
    ]
    renderCard(artifacts)

    await waitFor(() => expect(openResourceUrlInSpace).not.toHaveBeenCalled())

    fireEvent.click(screen.getAllByTestId('artifact-file-row')[1]!)
    await waitFor(() => {
      expect(openResourceUrlInSpace).toHaveBeenCalledTimes(1)
      expect(openResourceUrlInSpace).toHaveBeenCalledWith(
        artifacts[1].href,
        'conversation:session-1',
        expect.objectContaining({ openIntentHints: { filename: 'file-2.xlsx' } }),
      )
    })
  })

  it('本轮没有可渲染产物时不显示空标题壳', () => {
    renderCard([])

    expect(screen.queryByTestId('turn-artifacts-card')).toBeNull()
    expect(screen.queryByText('turnArtifacts.title')).toBeNull()
  })

  it('子 Agent 产物行展示来源名称 badge', () => {
    renderCard([{
      ...LOCAL_FILE_ARTIFACT,
      sourceSubagentName: '文件操作助手',
    }])
    const badge = screen.getByTestId('artifact-subagent-source-badge')
    expect(badge.textContent).toBe('文件操作助手')
  })

  it('子 Agent 来源过长时限制 badge 宽度并保留完整提示', () => {
    const longSourceName = '你之前已经抓取了多个上海写字楼保洁相关网页到本地目录'
    renderCard([{
      ...LOCAL_FILE_ARTIFACT,
      sourceSubagentName: longSourceName,
    }])

    const badge = screen.getByTestId('artifact-subagent-source-badge')
    expect(badge.textContent).toBe(longSourceName)
    expect(badge.className).toContain('max-w-[min(40%,12rem)]')
    expect(badge.className).toContain('truncate')
    expect(badge.getAttribute('title')).toBeTruthy()
  })

  it('标题为「产物」；历史产物手风琴内联展开且去重本轮项', () => {
    const older: TurnArtifact = {
      id: 'older-file',
      kind: 'file',
      title: 'older.md',
      href: 'tabtin://resource/file/older.md?hint=tabfiles&title=older.md',
      subtitleKey: 'previewFile',
    }
    renderCard([LOCAL_FILE_ARTIFACT], [LOCAL_FILE_ARTIFACT, older])

    expect(screen.getByText('turnArtifacts.title')).toBeTruthy()
    expect(screen.getByTestId('other-artifacts-toggle').textContent).toContain('turnArtifacts.otherArtifacts')
    expect(screen.queryByTestId('other-artifacts-list')).toBeNull()

    fireEvent.click(screen.getByTestId('other-artifacts-toggle'))
    const list = screen.getByTestId('other-artifacts-list')
    expect(list.textContent).toContain('older.md')
    expect(list.textContent).not.toContain(LOCAL_FILE_ARTIFACT.title)
  })

  it('无历史轮产物时不渲染历史产物手风琴', () => {
    renderCard([LOCAL_FILE_ARTIFACT], [])
    expect(screen.queryByTestId('other-artifacts-accordion')).toBeNull()
  })

  it('本轮不超过 5 个产物时完整展示，历史产物不计入上限', () => {
    const currentArtifacts = Array.from({ length: 5 }, (_, index) => makeLocalFileArtifact(index + 1))
    const olderArtifact: TurnArtifact = {
      ...makeLocalFileArtifact(99),
      id: 'older-file',
      title: 'older.md',
    }

    renderCard(currentArtifacts, [olderArtifact])

    expect(screen.getAllByTestId('artifact-file-row')).toHaveLength(5)
    expect(screen.queryByTestId('turn-artifacts-toggle')).toBeNull()
    expect(screen.getByTestId('other-artifacts-toggle')).toBeTruthy()
  })

  it('本轮超过 5 个产物时默认折叠，支持展开全部并从底部收起', () => {
    const artifacts = Array.from({ length: 7 }, (_, index) => makeLocalFileArtifact(index + 1))
    renderCard(artifacts)

    expect(screen.getAllByTestId('artifact-file-row')).toHaveLength(5)
    expect(screen.queryByText('file-6.md')).toBeNull()
    expect(screen.queryByText('file-7.md')).toBeNull()

    const expandButton = screen.getByTestId('turn-artifacts-toggle')
    expect(expandButton.textContent).toContain('turnArtifacts.showMoreFiles:2')
    expect(expandButton.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(expandButton)

    expect(screen.getAllByTestId('artifact-file-row')).toHaveLength(7)
    expect(screen.getByText('file-7.md')).toBeTruthy()
    const collapseButton = screen.getByTestId('turn-artifacts-toggle')
    expect(collapseButton.textContent).toContain('turnArtifacts.collapse')
    expect(collapseButton.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(collapseButton)

    expect(screen.getAllByTestId('artifact-file-row')).toHaveLength(5)
    expect(screen.queryByText('file-6.md')).toBeNull()
    expect(screen.getByTestId('turn-artifacts-toggle').textContent).toContain(
      'turnArtifacts.showMoreFiles:2',
    )
  })

  it('本机：可预览本地文件——整行可点触发 Space 预览 + 提供「Open in」下拉', async () => {
    renderCard([LOCAL_FILE_ARTIFACT])

    expect(screen.queryByTestId('artifact-remote-unavailable')).toBeNull()
    // 非 HTML：可点整行 + Open in；不单独露「预览」（留给 HTML / 云文档）
    expect(screen.getByTestId('artifact-file-row')).toBeTruthy()
    expect(screen.getByText('card.openFile.openIn')).toBeTruthy()
    expect(screen.queryByTestId('artifact-preview')).toBeNull()

    fireEvent.click(screen.getByTestId('artifact-file-row'))
    await waitFor(() => {
      expect(openResourceUrlInSpace).toHaveBeenCalledWith(
        LOCAL_FILE_ARTIFACT.href,
        'conversation:session-1',
        expect.objectContaining({
          suppressErrorToast: true,
          openIntentHints: { filename: 'demo-table.xlsx' },
        }),
      )
    })
  })

  it('本机：本地 HTML 露出「预览」，与点行同语义走内嵌浏览器', async () => {
    openLocalHtmlInSpace.mockResolvedValue({ ok: true })
    renderCard([LOCAL_HTML_ARTIFACT])

    expect(screen.getByTestId('artifact-preview')).toBeTruthy()
    expect(screen.getByText('card.openFile.openIn')).toBeTruthy()

    fireEvent.click(screen.getByTestId('artifact-preview'))
    await waitFor(() => {
      expect(openLocalHtmlInSpace).toHaveBeenCalled()
    })
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('文件产物打开时透传 Artifact filename metadata', async () => {
    renderCard([LOCAL_FILE_ARTIFACT])

    fireEvent.click(screen.getByTestId('artifact-file-row'))
    await waitFor(() => {
      expect(openResourceUrlInSpace).toHaveBeenCalledWith(
        LOCAL_FILE_ARTIFACT.href,
        'conversation:session-1',
        expect.objectContaining({
          openIntentHints: { filename: 'demo-table.xlsx' },
        }),
      )
    })
  })

  it('白名单外本地产物：点开降级系统应用打开（不再「暂不支持」死胡同）', async () => {
    renderCard([UNSUPPORTED_LOCAL_ARTIFACT])

    fireEvent.click(screen.getByTestId('artifact-file-row'))
    await waitFor(() => {
      expect(openLocalArtifactWithSystemApp).toHaveBeenCalledWith(
        UNSUPPORTED_LOCAL_ARTIFACT.href,
        'conversation:session-1',
      )
    })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'turnArtifacts.openedWithSystemApp',
    }))
  })

  it('「Open in」下拉：System app / Reveal in Finder 与 create_file 卡同款动作', async () => {
    renderCard([LOCAL_FILE_ARTIFACT])

    fireEvent.click(screen.getByText('card.openFile.systemApp'))
    await waitFor(() => {
      expect(openLocalArtifactWithSystemApp).toHaveBeenCalledWith(
        LOCAL_FILE_ARTIFACT.href,
        'conversation:session-1',
      )
    })

    fireEvent.click(screen.getByText('card.openFile.openInWorkspace'))
    expect(openArtifactWorkspaceDir).toHaveBeenCalledWith(
      LOCAL_FILE_ARTIFACT.href,
      'conversation:session-1',
    )

    fireEvent.click(screen.getByText(/card\.openFile\.revealIn(Finder|Os)/))
    expect(revealArtifactInFinder).toHaveBeenCalledWith(
      LOCAL_FILE_ARTIFACT.href,
      'conversation:session-1',
    )
  })

  it('可预览本地文件 Space 打开失败：降级系统应用（与 create_file 卡同款兜底）', async () => {
    openResourceUrlInSpace.mockResolvedValue({
      outcome: 'error',
      carrierAppId: null,
      resolveSource: 'system_fallback',
      errorMessage: 'space 打不开',
    })
    renderCard([LOCAL_FILE_ARTIFACT])

    fireEvent.click(screen.getByTestId('artifact-file-row'))
    await waitFor(() => {
      expect(openLocalArtifactWithSystemApp).toHaveBeenCalledWith(
        LOCAL_FILE_ARTIFACT.href,
        'conversation:session-1',
      )
    })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'turnArtifacts.openedWithSystemApp',
    }))
  })

  it('遥控端：本地文件产物下拉替换为不可预览占位 + 副标题标注远程设备文件', () => {
    remoteViewerState.isRemoteViewer = true
    remoteViewerState.controlDeviceName = '主端 Mac'
    renderCard([LOCAL_FILE_ARTIFACT])

    const placeholder = screen.getByTestId('artifact-remote-unavailable')
    expect(placeholder.textContent).toBe('turnArtifacts.remotePreviewUnavailable')
    expect(placeholder.getAttribute('title')).toBe('card.openFile.remoteUnavailableWithDevice')
    expect(screen.getByText('turnArtifacts.previewFile · card.openFile.remoteChip')).toBeTruthy()
  })

  it('遥控端：云文档产物不受影响，仍可预览', () => {
    remoteViewerState.isRemoteViewer = true
    renderCard([CLOUD_DOC_ARTIFACT])

    expect(screen.queryByTestId('artifact-remote-unavailable')).toBeNull()
    fireEvent.click(screen.getAllByText('turnArtifacts.preview')[0]!)
    expect(openResourceUrlInSpace).toHaveBeenCalledWith(
      CLOUD_DOC_ARTIFACT.href,
      'conversation:session-1',
      { suppressErrorToast: true },
    )
  })

  it('Project Task 待验收文档留在当前 Project scope，以真实工作空间归属打开', async () => {
    renderCard([PROJECT_TASK_DOC_ARTIFACT])

    fireEvent.click(screen.getAllByText('turnArtifacts.preview')[0]!)

    await waitFor(() => {
      expect(openCloudDocumentPreview).toHaveBeenCalledWith({
        documentId: 'doc_1',
        resourceSpaceId: 'companion-workspace-1',
      })
    })
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
    expect(openSharedResourceTab).not.toHaveBeenCalled()
  })

  it('IM 共享任务的表格产物在当前私聊画布打开，不把 tabtin URI 当外链', async () => {
    const artifact: TurnArtifact = {
      id: 'shared-table',
      kind: 'table',
      title: '今天天气',
      href: 'tabtin://resource/table/324dc4f9-f459-4e9c-87dc-d3669fcc6a60?hint=tabdata',
      subtitleKey: 'previewTable',
    }
    render(
      <ImConversationCanvasProvider value={{
        conversationId: 'im-conversation-1',
        scopeKey: 'im:im-conversation-1',
        executionSpaceId: 'recipient-workspace-1',
      }}>
        <TurnArtifactsCard
          artifacts={[artifact]}
          sessionId="shared-task-session-1"
        />
      </ImConversationCanvasProvider>,
    )

    fireEvent.click(screen.getAllByText('turnArtifacts.preview')[0]!)

    await waitFor(() => {
      expect(openSharedResourceTab).toHaveBeenCalledWith({
        hostSpaceId: 'recipient-workspace-1',
        resourceType: 'table',
        resourceId: '324dc4f9-f459-4e9c-87dc-d3669fcc6a60',
        resourceSpaceId: undefined,
        tabScopeKey: 'im:im-conversation-1',
      })
    })
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('本轮产物文档可点版本历史，打开预览并默认展开 VH', async () => {
    renderCard([PROJECT_TASK_DOC_ARTIFACT])

    fireEvent.click(screen.getByTestId('artifact-version-history'))

    await waitFor(() => {
      expect(openCloudDocumentPreview).toHaveBeenCalledWith({
        documentId: 'doc_1',
        resourceSpaceId: 'companion-workspace-1',
        openVersionHistory: true,
      })
    })
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('非文档产物没有版本历史入口', () => {
    renderCard([LOCAL_FILE_ARTIFACT])
    expect(screen.queryByTestId('artifact-version-history')).toBeNull()
  })

  it('云资源打开失败（outcome=error）：toast 提示失败原因', async () => {
    openResourceUrlInSpace.mockResolvedValue({
      outcome: 'error',
      carrierAppId: null,
      resolveSource: 'system_fallback',
      errorMessage: '文件已删除或不可用',
    })
    renderCard([CLOUD_DOC_ARTIFACT])

    fireEvent.click(screen.getAllByText('turnArtifacts.preview')[0]!)
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        variant: 'destructive',
        description: '文件已删除或不可用',
      }))
    })
  })
})

describe('ArtifactOpenInMenu — 嵌套 DropdownMenu 契约', () => {
  it('源码必须 modal={false}，并阻断菜单 click 冒泡到整行', () => {
    const sourcePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'ArtifactOpenInMenu.tsx')
    const source = readFileSync(sourcePath, 'utf8')
    expect(source).toContain('<DropdownMenu modal={false}>')
    expect(source).toContain('onAction?.(); void actions.openWithSystemApp()')
    expect(source).toContain('onClick={(event) => event.stopPropagation()}')
  })
})
