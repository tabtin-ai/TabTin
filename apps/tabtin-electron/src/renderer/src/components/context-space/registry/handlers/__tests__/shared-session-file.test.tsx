import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { contextRegistry } from '../../instance'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { SHARED_SESSION_FILE_TAB_TYPE } from '@/components/chat/shared-view/preview/sharedSessionFileTab'
import { sharedSessionFileHandler } from '../shared-session-file'

vi.mock('@/components/chat/shared-view/preview/SharedSessionFilePreviewPane', () => ({
  SharedSessionFilePreviewPane: ({ target }: { target: { shareId: string } }) => (
    React.createElement('div', { 'data-testid': 'preview', 'data-share-id': target.shareId })
  ),
}))

const SCOPE = 'im:conversation-1'
const FILE_ID = 'shared-session-file:session-1:artifacts%2Freport.pdf'

describe('sharedSessionFileHandler ', () => {
  beforeEach(() => {
    contextRegistry.register(sharedSessionFileHandler)
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      explicitCloseRevisionByScope: {},
      explicitClosedTabKeysByScope: {},
      lastActiveSubagentByParentSession: {},
    })
  })

  it('keeps the preview tab after switching back to the shared conversation', () => {
    const store = useSpaceContextTabsStore.getState()
    store.openResourceTab(SCOPE, {
      type: SHARED_SESSION_FILE_TAB_TYPE,
      id: FILE_ID,
      title: 'report.pdf',
    })
    store.openResourceTab(SCOPE, {
      type: 'sharedsession',
      id: 'session-1',
      title: '共享对话',
    })

    store.syncTabOrder(SCOPE, ['sharedsession:session-1'], 'sharedsession:session-1')

    expect(useSpaceContextTabsStore.getState().tabOrderBySpace[SCOPE]).toEqual([
      `${SHARED_SESSION_FILE_TAB_TYPE}:${FILE_ID}`,
      'sharedsession:session-1',
    ])
  })

  it('does not expose local-file context, attachment, or drag capabilities', () => {
    expect(sharedSessionFileHandler.persistOnly).toBe(true)
    expect(sharedSessionFileHandler.appMeta).toBeUndefined()
    expect(sharedSessionFileHandler.attachToChat).toBeUndefined()
    expect(sharedSessionFileHandler.getDragPayload?.({
      type: SHARED_SESSION_FILE_TAB_TYPE,
      id: FILE_ID,
      tabKey: `${SHARED_SESSION_FILE_TAB_TYPE}:${FILE_ID}`,
    })).toBeNull()
  })

  it('restores a persisted preview only with its exact share credential', () => {
    const item = {
      type: SHARED_SESSION_FILE_TAB_TYPE,
      id: FILE_ID,
      tabKey: `${SHARED_SESSION_FILE_TAB_TYPE}:${FILE_ID}` as `${string}:${string}`,
      title: 'report.pdf',
      meta: {
        shared_session_id: 'session-1',
        session_share_id: 'share-1',
        relative_path: 'artifacts/report.pdf',
      },
    }

    const { rerender } = render(<>{sharedSessionFileHandler.renderPane?.(item, {})}</>)
    expect(screen.getByTestId('preview').getAttribute('data-share-id')).toBe('share-1')

    rerender(<>{sharedSessionFileHandler.renderPane?.({
      ...item,
      meta: {
        shared_session_id: 'session-1',
        relative_path: 'artifacts/report.pdf',
      },
    }, {})}</>)
    expect(screen.queryByTestId('preview')).toBeNull()
  })
})
