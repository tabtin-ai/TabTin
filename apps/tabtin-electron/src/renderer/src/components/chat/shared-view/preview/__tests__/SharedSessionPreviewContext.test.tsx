import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openSharedSessionFileTab = vi.fn(() => true)
const openDrawer = vi.fn()
const closeResourcePreview = vi.fn()
const spaceContext = {
  value: { tabScopeKey: 'im:conversation-1' } as { tabScopeKey: string } | null,
}

vi.mock('../openSharedSessionFileTab', () => ({
  openSharedSessionFileTab: (...args: unknown[]) => openSharedSessionFileTab(...args),
}))

vi.mock('@/components/context-space/SpaceContextAreaContext', () => ({
  useOptionalSpaceContextState: () => spaceContext.value,
}))

vi.mock('@/components/chat/preview/useResourcePreviewStore', () => ({
  useResourcePreviewStore: {
    getState: () => ({ close: closeResourcePreview }),
  },
}))

vi.mock('../useSharedSessionPreviewStore', () => ({
  useSharedSessionPreviewStore: {
    getState: () => ({ target: null, open: openDrawer, close: vi.fn() }),
  },
}))

import {
  SharedSessionPreviewProvider,
  useSharedSessionPreview,
} from '../SharedSessionPreviewContext'

function PreviewTrigger() {
  const preview = useSharedSessionPreview()
  return (
    <button
      type="button"
      onClick={() => preview?.openSharedLocalFilePreview({
        relativePath: 'artifacts/report.pdf',
        title: 'report.pdf',
      })}
    >
      open
    </button>
  )
}

describe('SharedSessionPreviewProvider ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spaceContext.value = { tabScopeKey: 'im:conversation-1' }
  })

  it('opens shared files as tabs when the conversation has a canvas scope', () => {
    render(
      <SharedSessionPreviewProvider sessionId="shared-session-1" shareId="share-1" organizationId="org-1">
        <PreviewTrigger />
      </SharedSessionPreviewProvider>,
    )

    fireEvent.click(screen.getByText('open'))

    expect(openSharedSessionFileTab).toHaveBeenCalledWith({
      tabScopeKey: 'im:conversation-1',
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/report.pdf',
      title: 'report.pdf',
    })
    expect(openDrawer).not.toHaveBeenCalled()
    expect(closeResourcePreview).toHaveBeenCalled()
  })

  it('uses the drawer adapter in a detached IM window without a tab canvas', () => {
    spaceContext.value = null
    render(
      <SharedSessionPreviewProvider sessionId="shared-session-1" shareId="share-1" organizationId="org-1">
        <PreviewTrigger />
      </SharedSessionPreviewProvider>,
    )

    fireEvent.click(screen.getByText('open'))

    expect(openSharedSessionFileTab).not.toHaveBeenCalled()
    expect(openDrawer).toHaveBeenCalledWith({
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/report.pdf',
      title: 'report.pdf',
    })
  })

  it('opens shared files as tabs when the Agent conversation provides its scope', () => {
    spaceContext.value = null
    render(
      <SharedSessionPreviewProvider
        sessionId="shared-session-1"
        shareId="share-1"
        organizationId="org-1"
        tabScopeKey="conversation:shared-session-1"
      >
        <PreviewTrigger />
      </SharedSessionPreviewProvider>,
    )

    fireEvent.click(screen.getByText('open'))

    expect(openSharedSessionFileTab).toHaveBeenCalledWith({
      tabScopeKey: 'conversation:shared-session-1',
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/report.pdf',
      title: 'report.pdf',
    })
    expect(openDrawer).not.toHaveBeenCalled()
  })

  it('is a transparent provider for ordinary conversations', () => {
    render(
      <SharedSessionPreviewProvider sessionId={null} shareId={null} organizationId="org-1">
        <PreviewTrigger />
      </SharedSessionPreviewProvider>,
    )

    fireEvent.click(screen.getByText('open'))

    expect(openSharedSessionFileTab).not.toHaveBeenCalled()
    expect(openDrawer).not.toHaveBeenCalled()
    expect(closeResourcePreview).not.toHaveBeenCalled()
  })

})
