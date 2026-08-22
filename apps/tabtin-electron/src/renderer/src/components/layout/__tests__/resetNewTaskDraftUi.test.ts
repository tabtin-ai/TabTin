import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasLayoutStore } from '@stores/useCanvasLayoutStore'
import { useContextInjectionStore } from '@stores/useContextInjectionStore'
import { usePendingComposerAttachmentsStore } from '@stores/usePendingComposerAttachmentsStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useWorkbenchSurfaceStore } from '@stores/useWorkbenchSurfaceStore'
import { resetNewTaskDraftUi } from '../resetNewTaskDraftUi'
import { createContextRef, type ChatAttachment } from '@components/chat/types'
import { clearDraft, loadDraft, resolveDraftKey, saveDraft } from '@components/chat/composer/chatInputDraft'

function makeAttachment(id: string): ChatAttachment {
  return {
    id,
    file: new File([], `${id}.png`),
    filename: `${id}.png`,
    mimeType: 'image/png',
    size: 3,
    type: 'image',
    status: 'pending',
  }
}

describe('resetNewTaskDraftUi', () => {
  beforeEach(() => {
    clearDraft('space:space-1')
    clearDraft('space:space-2')
    clearDraft('session-9')
    const draftScopeKey = 'conversation:draft:space-1'
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: { [draftScopeKey]: 'tabdoc:doc-1' },
      tabOrderBySpace: { [draftScopeKey]: ['tabdoc:doc-1'] },
      itemsBySpace: {
        [draftScopeKey]: {
          'tabdoc:doc-1': {
            type: 'tabdoc',
            id: 'doc-1',
            tabKey: 'tabdoc:doc-1',
            title: '文档',
          },
        },
      },
      displayKeyBySpace: {},
      lastActiveSubagentByParentSession: {},
    })
    useCanvasLayoutStore.setState({
      spaceGroups: {
        [draftScopeKey]: [{ id: 'g1', panes: [] }],
      },
    } as never)
    useSpaceViewPrefsStore.setState((state) => ({
      taskViewModeByScopeKey: {
        ...state.taskViewModeByScopeKey,
        [draftScopeKey]: 'split',
      },
    }))
    useContextInjectionStore.setState({ activeScopeId: null, contextRefsByScopeId: {} })
    usePendingComposerAttachmentsStore.setState({ pendingByScopeId: {} })
  })

  it('清空该工作空间草稿 scope 的引用与待领取附件（ 二轮：新任务不继承旧注释）', () => {
    const injection = useContextInjectionStore.getState()
    injection.addRefToScope('__draft__:space-1', createContextRef('web_annotation', 'https://a/', '旧注释'))
    usePendingComposerAttachmentsStore.getState().enqueue('__draft__:space-1', makeAttachment('old-att'))

    resetNewTaskDraftUi('space-1')

    expect(useContextInjectionStore.getState().contextRefsByScopeId['__draft__:space-1'] ?? []).toHaveLength(0)
    expect(usePendingComposerAttachmentsStore.getState().pendingByScopeId['__draft__:space-1']).toBeUndefined()
  })

  it('清空该工作空间未发送的输入草稿，不影响其它工作空间和已有会话', () => {
    const currentSpaceDraftKey = resolveDraftKey(null, 'space-1')!
    const otherSpaceDraftKey = resolveDraftKey(null, 'space-2')!
    saveDraft(currentSpaceDraftKey, '上一条新任务里没发出的内容')
    saveDraft(otherSpaceDraftKey, '其它工作空间草稿')
    saveDraft('session-9', '已有会话草稿')

    resetNewTaskDraftUi('space-1')

    expect(loadDraft(currentSpaceDraftKey)).toBe('')
    expect(loadDraft(otherSpaceDraftKey)).toBe('其它工作空间草稿')
    expect(loadDraft('session-9')).toBe('已有会话草稿')
  })

  it('不影响其它工作空间的草稿引用与已有 session scope 的引用', () => {
    const injection = useContextInjectionStore.getState()
    injection.addRefToScope('__draft__:space-2', createContextRef('web_annotation', 'https://b/', '别家草稿'))
    injection.addRefToScope('session-9', createContextRef('web_annotation', 'https://c/', '正式会话'))

    resetNewTaskDraftUi('space-1')

    expect(useContextInjectionStore.getState().contextRefsByScopeId['__draft__:space-2']).toHaveLength(1)
    expect(useContextInjectionStore.getState().contextRefsByScopeId['session-9']).toHaveLength(1)
  })

  it('按 spaceId 清空草稿标签 / 引用 / pending 附件，不影响 session scope', () => {
    useSpaceContextTabsStore.setState((state) => ({
      itemsBySpace: {
        ...state.itemsBySpace,
        'conversation:session-1': {
          'tabdoc:keep': {
            type: 'tabdoc',
            id: 'keep',
            tabKey: 'tabdoc:keep',
            title: '正式任务文档',
          },
        },
      },
    }))
    useContextInjectionStore.setState({
      activeScopeId: '__draft__:space-1',
      contextRefsByScopeId: {
        '__draft__:space-1': [{
          id: 'ref-1',
          type: 'table_selection',
          resourceId: 't1',
          label: '旧选区',
        }],
      },
    })
    usePendingComposerAttachmentsStore.setState({
      pendingByScopeId: {
        '__draft__:space-1': [{
          id: 'att-1',
          type: 'image',
          filename: 'shot.png',
          mimeType: 'image/png',
          size: 10,
          status: 'ready',
          file: {} as File,
          previewUrl: '',
        }],
      },
    })

    resetNewTaskDraftUi('space-1')

    expect(useSpaceContextTabsStore.getState().itemsBySpace['conversation:draft:space-1']).toBeUndefined()
    expect(useCanvasLayoutStore.getState().spaceGroups['conversation:draft:space-1']).toBeUndefined()
    expect(useSpaceViewPrefsStore.getState().taskViewModeByScopeKey['conversation:draft:space-1']).toBeUndefined()
    expect(useContextInjectionStore.getState().contextRefsByScopeId['__draft__:space-1']).toEqual([])
    expect(usePendingComposerAttachmentsStore.getState().pendingByScopeId['__draft__:space-1']).toBeUndefined()
    expect(useWorkbenchSurfaceStore.getState().lastActiveSurfaceBySpace['conversation:draft:space-1']).toBe('desktop')
    expect(useSpaceContextTabsStore.getState().itemsBySpace['conversation:session-1']?.['tabdoc:keep']).toBeTruthy()
  })
})
