import { beforeEach, describe, expect, it, vi } from 'vitest'

const openPreview = vi.fn()
const getSelection = vi.fn()
const getMessages = vi.fn()

vi.mock('@/components/chat/preview/useCloudDocumentPreviewStore', () => ({
  useCloudDocumentPreviewStore: {
    getState: () => ({ open: openPreview }),
  },
}))

vi.mock('@/components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: {
    getState: () => getSelection(),
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      messagesBySessionId: getMessages(),
    }),
  },
}))

const collectSessionArtifacts = vi.fn(() => [])

vi.mock('@/components/chat/turn/turnArtifacts', () => ({
  collectSessionArtifacts: (...args: unknown[]) => collectSessionArtifacts(...args),
}))

vi.mock('@tabtin/resource-router', () => ({
  parseResourcePointer: (href: string) => {
    const match = /^tabtin:\/\/resource\/([^/?#]+)\/([^?#]+)/.exec(href)
    return {
      id: match ? decodeURIComponent(match[2]!) : 'doc-1',
      type: match ? decodeURIComponent(match[1]!) : 'document',
    }
  },
}))

import { openProjectTaskDocumentPreview } from '../openProjectTaskDocumentPreview'

describe('openProjectTaskDocumentPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSelection.mockReturnValue({
      selectedProjectId: 'project-1',
      activeTaskSessionId: 'session-1',
    })
    getMessages.mockReturnValue({ 'session-1': [] })
    collectSessionArtifacts.mockReturnValue([])
  })

  it('opens CloudDocumentPreviewModal for Project Task docs', () => {
    const opened = openProjectTaskDocumentPreview({
      resourceType: 'tabdoc',
      resourceId: 'doc-1',
      tabScopeKey: 'conversation:session-1',
      resourceSpaceId: 'workspace-1',
      title: 'seaside-plan.md',
    })

    expect(opened).toBe(true)
    expect(openPreview).toHaveBeenCalledWith({
      documentId: 'doc-1',
      resourceSpaceId: 'workspace-1',
      title: 'seaside-plan.md',
    })
  })

  it('补齐缺失的 resourceSpaceId（host=Project / resource=伴生工作空间）', () => {
    collectSessionArtifacts.mockReturnValue([{
      kind: 'doc',
      href: 'tabtin://resource/document/doc-1?hint=tabdoc',
      resourceSpaceId: 'companion-workspace-1',
    }])

    const opened = openProjectTaskDocumentPreview({
      resourceType: 'document',
      resourceId: 'doc-1',
      tabScopeKey: 'conversation:session-1',
    })

    expect(opened).toBe(true)
    expect(openPreview).toHaveBeenCalledWith({
      documentId: 'doc-1',
      resourceSpaceId: 'companion-workspace-1',
    })
  })

  it('缺少 resourceSpaceId 且产物无法补齐时拒绝打开，避免踢出 Project', () => {
    expect(openProjectTaskDocumentPreview({
      resourceType: 'document',
      resourceId: 'doc-1',
      tabScopeKey: 'conversation:session-1',
    })).toBe(false)
    expect(openPreview).not.toHaveBeenCalled()
  })

  it('can request version history to open expanded', () => {
    const opened = openProjectTaskDocumentPreview({
      resourceType: 'document',
      resourceId: 'doc-1',
      tabScopeKey: 'conversation:session-1',
      resourceSpaceId: 'workspace-1',
      openVersionHistory: true,
    })

    expect(opened).toBe(true)
    expect(openPreview).toHaveBeenCalledWith({
      documentId: 'doc-1',
      resourceSpaceId: 'workspace-1',
      openVersionHistory: true,
    })
  })

  it('rejects non-document resources', () => {
    expect(openProjectTaskDocumentPreview({
      resourceType: 'table',
      resourceId: 'table-1',
      tabScopeKey: 'conversation:session-1',
      resourceSpaceId: 'workspace-1',
    })).toBe(false)
    expect(openPreview).not.toHaveBeenCalled()
  })
})
