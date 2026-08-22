import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextBlock } from '../ContextRefCard'
import { navigateContextBlock } from '../contextBlockNavigation'

const ensureSpaceSelectedWithFeedback = vi.fn(async () => true)
const resourceRouterOpen = vi.fn(async () => ({ ok: true }))
const expandCanvasAfterInSpaceOpen = vi.fn()
const expandCanvasForScope = vi.fn()
const reportRichResourceOpenFailure = vi.fn()
const warn = vi.fn()
const toastNoSpace = vi.fn()
const toastOpenFailed = vi.fn()
const openProjectTaskDocumentPreview = vi.fn(() => false)
const setPendingReveal = vi.fn()
const openResourceTab = vi.fn()
const findContainingOpenTabRoot = vi.fn(() => null)
const workingDirRef = { current: '/projects/current-agent' }

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: (...args: unknown[]) => ensureSpaceSelectedWithFeedback(...args),
}))

vi.mock('@/services/resourceRouter', () => ({
  resourceRouter: {
    open: (...args: unknown[]) => resourceRouterOpen(...args),
  },
}))

vi.mock('@/services/openProjectTaskDocumentPreview', () => ({
  openProjectTaskDocumentPreview: (...args: unknown[]) => openProjectTaskDocumentPreview(...args),
}))

vi.mock('../buildRichResourcePointer', () => ({
  buildRichResourcePointer: vi.fn(() => ({ raw: 'tabdoc:doc-1' })),
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      spaces: [{
        id: 'space-1',
        type: 'workspace',
        working_dir: workingDirRef.current,
      }],
      selectedSpace: {
        id: 'space-1',
        type: 'workspace',
        working_dir: workingDirRef.current,
      },
      agentCache: {},
      loadAgent: async () => null,
    }),
  },
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab: (...args: unknown[]) => openResourceTab(...args),
    }),
  },
}))

vi.mock('@components/tabcode/hooks/useTabCodeStore', () => ({
  useTabCodeStore: {
    getState: () => ({
      setPendingReveal: (...args: unknown[]) => setPendingReveal(...args),
    }),
  },
}))

vi.mock('@components/chat/cards/hooks/useFileOpenAction', () => ({
  findContainingOpenTabRoot: (...args: unknown[]) => findContainingOpenTabRoot(...args),
  isInsideWorkingDir: (absoluteFile: string, workingDir: string) => {
    const normFile = absoluteFile.replace(/\\/g, '/')
    const normWD = workingDir.replace(/\\/g, '/')
    if (!normWD || !normFile) return false
    return normFile === normWD || normFile.startsWith(`${normWD}/`)
  },
}))

function createDeps() {
  return {
    expandCanvasAfterInSpaceOpen,
    expandCanvasForScope,
    reportRichResourceOpenFailure,
    warn,
    toastNoSpace,
    toastOpenFailed,
  }
}

describe('navigateContextBlock', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    ensureSpaceSelectedWithFeedback.mockResolvedValue(true)
    openProjectTaskDocumentPreview.mockReturnValue(false)
    findContainingOpenTabRoot.mockReturnValue(null)
    workingDirRef.current = '/projects/current-agent'
  })

  it('shows toast when no space context is available', async () => {
    const block: ContextBlock = { type: 'document', doc_id: 'doc-1' }
    await navigateContextBlock(
      { block, selectedSpaceId: null, tabScopeKey: null },
      createDeps(),
    )
    expect(toastNoSpace).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
    expect(ensureSpaceSelectedWithFeedback).not.toHaveBeenCalled()
  })

  it('routes rich resource blocks through resourceRouter', async () => {
    const block: ContextBlock = {
      type: 'document',
      resource_id: 'doc-1',
      space_id: 'space-1',
    }
    await navigateContextBlock(
      { block, selectedSpaceId: 'space-1', tabScopeKey: 'scope-1' },
      createDeps(),
    )
    expect(ensureSpaceSelectedWithFeedback).toHaveBeenCalledWith('space-1', {})
    expect(resourceRouterOpen).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ raw: 'tabdoc:doc-1' }),
      expect.objectContaining({
        tabScopeKey: 'scope-1',
        triggerSource: 'rich_resource_card',
      }),
    )
    expect(expandCanvasAfterInSpaceOpen).toHaveBeenCalled()
    expect(reportRichResourceOpenFailure).toHaveBeenCalled()
  })

  it('keeps Project Task document cards inside the Project preview modal', async () => {
    openProjectTaskDocumentPreview.mockReturnValueOnce(true)
    const block: ContextBlock = {
      type: 'document',
      resource_id: 'doc-1',
    }

    await navigateContextBlock(
      {
        block,
        selectedSpaceId: 'fallback-workspace',
        tabScopeKey: 'conversation:task-session-1',
      },
      createDeps(),
    )

    expect(openProjectTaskDocumentPreview).toHaveBeenCalledWith({
      resourceType: 'document',
      resourceId: 'doc-1',
      tabScopeKey: 'conversation:task-session-1',
    })
    expect(ensureSpaceSelectedWithFeedback).not.toHaveBeenCalled()
    expect(resourceRouterOpen).not.toHaveBeenCalled()
  })

  it('stops when ensureSpaceSelectedWithFeedback rejects navigation', async () => {
    ensureSpaceSelectedWithFeedback.mockResolvedValueOnce(false)
    const block: ContextBlock = {
      type: 'table',
      table_id: 'table-1',
      space_id: 'space-1',
    }
    await navigateContextBlock(
      { block, selectedSpaceId: 'space-1', tabScopeKey: null },
      createDeps(),
    )
    expect(expandCanvasForScope).not.toHaveBeenCalled()
  })

  it('surfaces router failures through toastOpenFailed', async () => {
    resourceRouterOpen.mockRejectedValueOnce(new Error('router failed'))
    const block: ContextBlock = {
      type: 'document',
      resource_id: 'doc-1',
      space_id: 'space-1',
    }
    await navigateContextBlock(
      { block, selectedSpaceId: 'space-1', tabScopeKey: null },
      createDeps(),
    )
    expect(toastOpenFailed).toHaveBeenCalledWith('router failed')
    expect(warn).toHaveBeenCalled()
  })

  it('opens code_file when root_path matches Agent working_dir', async () => {
    workingDirRef.current = '/projects/source'
    const block: ContextBlock = {
      type: 'code_file',
      file_path: '/projects/source/pkg/index.ts',
      root_path: '/projects/source',
      space_id: 'space-1',
    }

    await navigateContextBlock(
      { block, selectedSpaceId: 'space-1', tabScopeKey: 'scope-1' },
      createDeps(),
    )

    expect(expandCanvasForScope).toHaveBeenCalledWith('scope-1')
    expect(setPendingReveal).toHaveBeenCalledWith(
      '/projects/source',
      expect.objectContaining({
        filePath: '/projects/source/pkg/index.ts',
      }),
    )
    expect(openResourceTab).toHaveBeenCalledWith(
      'scope-1',
      expect.objectContaining({
        type: 'tabcode',
        title: 'source',
        meta: { path: '/projects/source', spaceId: 'space-1' },
      }),
    )
    expect(toastOpenFailed).not.toHaveBeenCalled()
  })

  it('opens code_file when root_path differs from working_dir but file stays inside explicit root', async () => {
    workingDirRef.current = '/projects/current-agent'
    const appendSessionAllowedPath = vi.fn(async () => undefined)
    vi.stubGlobal('tabtin', {
      workspace: { appendSessionAllowedPath },
    })

    const block: ContextBlock = {
      type: 'code_file',
      file_path: '/projects/source/pkg/index.ts',
      root_path: '/projects/source',
      space_id: 'space-1',
    }

    await navigateContextBlock(
      { block, selectedSpaceId: 'space-1', tabScopeKey: 'scope-1' },
      createDeps(),
    )

    expect(setPendingReveal).toHaveBeenCalledWith(
      '/projects/source',
      expect.objectContaining({
        filePath: '/projects/source/pkg/index.ts',
      }),
    )
    expect(openResourceTab).toHaveBeenCalled()
    expect(appendSessionAllowedPath).toHaveBeenCalled()
    expect(toastOpenFailed).not.toHaveBeenCalled()
  })

  it('working_dir 为空时显式来源根仍须先获得 session 授权', async () => {
    workingDirRef.current = ''
    const appendSessionAllowedPath = vi.fn(async () => undefined)
    vi.stubGlobal('tabtin', {
      workspace: { appendSessionAllowedPath },
    })
    const block: ContextBlock = {
      type: 'code_file',
      file_path: '/projects/source/pkg/index.ts',
      root_path: '/projects/source',
      space_id: 'space-1',
    }

    await navigateContextBlock(
      { block, selectedSpaceId: 'space-1', tabScopeKey: 'scope-1' },
      createDeps(),
    )

    expect(appendSessionAllowedPath).toHaveBeenCalledWith({
      spaceId: 'space-1',
      path: '/projects/source/pkg/index.ts',
    })
    expect(appendSessionAllowedPath).toHaveBeenCalledWith({
      spaceId: 'space-1',
      path: '/projects/source',
    })
    expect(openResourceTab).toHaveBeenCalled()
    expect(toastOpenFailed).not.toHaveBeenCalled()
  })

  it('需要来源路径授权但 bridge 不可用时提示失败且不打开', async () => {
    workingDirRef.current = ''
    vi.stubGlobal('tabtin', { workspace: {} })
    const block: ContextBlock = {
      type: 'code_file',
      file_path: '/projects/source/pkg/index.ts',
      root_path: '/projects/source',
      space_id: 'space-1',
    }

    await navigateContextBlock(
      { block, selectedSpaceId: 'space-1', tabScopeKey: 'scope-1' },
      createDeps(),
    )

    expect(toastOpenFailed).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      '[ChatPanel] code context session allow bridge unavailable',
    )
    expect(setPendingReveal).not.toHaveBeenCalled()
    expect(openResourceTab).not.toHaveBeenCalled()
  })

  it('toasts when code context path cannot be resolved', async () => {
    workingDirRef.current = '/projects/current-agent'
    const block: ContextBlock = {
      type: 'code_file',
      file_path: '/tmp/outside.ts',
      space_id: 'space-1',
    }

    await navigateContextBlock(
      { block, selectedSpaceId: 'space-1', tabScopeKey: 'scope-1' },
      createDeps(),
    )

    expect(toastOpenFailed).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
    expect(setPendingReveal).not.toHaveBeenCalled()
    expect(openResourceTab).not.toHaveBeenCalled()
  })

  it('reveals code_selection line range when opening source', async () => {
    workingDirRef.current = '/projects/source'
    const block: ContextBlock = {
      type: 'code_selection',
      file_path: 'pkg/index.ts',
      root_path: '/projects/source',
      start_line: 12,
      end_line: 18,
      space_id: 'space-1',
    }

    await navigateContextBlock(
      { block, selectedSpaceId: 'space-1', tabScopeKey: 'scope-1' },
      createDeps(),
    )

    expect(setPendingReveal).toHaveBeenCalledWith(
      '/projects/source',
      expect.objectContaining({
        filePath: '/projects/source/pkg/index.ts',
        line: 12,
        endLine: 18,
      }),
    )
    expect(openResourceTab).toHaveBeenCalled()
  })
})
