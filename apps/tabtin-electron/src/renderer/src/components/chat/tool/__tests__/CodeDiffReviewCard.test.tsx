import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'

const mocks = vi.hoisted(() => ({
  openCodeChangesTab: vi.fn(),
  expandCanvasForScope: vi.fn(),
  loadJournal: vi.fn(),
  hasSpaceContext: true,
  spaceType: 'workspace' as string | null,
  gitStatus: {
    isGitRepo: true,
    statusRevision: 1,
  },
  review: {
    turnEndMessageId: 'a1',
    changed: 2,
    insertions: 4,
    deletions: 1,
    files: [
      { displayable: true, relativePath: 'src/one.ts', status: 'modified', insertions: 3, deletions: 1 },
      { displayable: true, relativePath: 'src/two.ts', status: 'added', insertions: 1, deletions: 0 },
    ],
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number; file?: string }) => {
      let text = options?.defaultValue ?? key
      if (options?.count != null) text = text.replace(/\{\{count\}\}/g, String(options.count))
      if (options?.file != null) text = text.replace(/\{\{file\}\}/g, options.file)
      return text
    },
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: unknown) => unknown) => selector({
    spaces: [{ id: 'space-1', type: mocks.spaceType, working_dir: '/repo' }],
    agentCache: {},
    selectedAgent: null,
    selectedSpace: { id: 'space-1', type: mocks.spaceType, working_dir: '/repo' },
  }),
}))

vi.mock('@components/context-space/SpaceContextAreaContext', () => ({
  useOptionalSpaceContextState: () => mocks.hasSpaceContext
    ? ({ spaceId: 'space-1', tabScopeKey: 'conversation:s1' })
    : null,
}))

vi.mock('@components/context-space/workspaceExecutionRootApp', () => ({
  resolveWorkspaceWorkingDir: () => '/repo',
}))

vi.mock('@components/tabcode/hooks/useGitStatus', () => ({
  useGitStatus: () => mocks.gitStatus,
}))

vi.mock('@components/context-space/code-workspace/fileEditPatchJournalStore', () => ({
  useFileEditPatchJournalStore: (selector: (state: unknown) => unknown) => selector({
    byThread: { s1: [] },
    load: mocks.loadJournal,
  }),
}))

vi.mock('@components/context-space/code-workspace/agentTurnEditorOps', () => ({
  collectClosedAgentTurnReview: (_messages: unknown, _journal: unknown, codeRootPath: string) =>
    codeRootPath === '/repo' ? mocks.review : null,
}))

vi.mock('@components/context-space/code-workspace/codeWorkspaceTab', () => ({
  DEFAULT_CODE_CHANGES_VIEW: 'agent',
  openCodeChangesTab: mocks.openCodeChangesTab,
}))

vi.mock('@/services/openResourceLink', () => ({
  expandCanvasForScope: mocks.expandCanvasForScope,
}))

import { CodeDiffReviewCard } from '../CodeDiffReviewCard'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'

function message(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    role,
    content: role === 'user' ? 'edit' : 'done',
    created_at: '2026-08-17T00:00:00Z',
    message_kind: role === 'assistant' ? 'llm' : undefined,
  } as ChatMessage
}

describe('CodeDiffReviewCard', () => {
  beforeEach(() => {
    mocks.openCodeChangesTab.mockReset()
    mocks.expandCanvasForScope.mockReset()
    mocks.loadJournal.mockReset()
    mocks.hasSpaceContext = true
    mocks.spaceType = 'workspace'
    mocks.gitStatus.isGitRepo = true
    mocks.gitStatus.statusRevision = 1
    useSessionBoundCodeRootStore.getState().reset()
  })

  it('opens the referenced Agent turn in Changes', () => {
    render(
      <CodeDiffReviewCard
        message={message('a1', 'assistant')}
        timelineMessages={[message('u1', 'user'), message('a1', 'assistant')]}
        sessionId="s1"
        tabScopeKey="conversation:s1"
        isLastInTurn
        isMiniMessage={false}
        isErrorEnvelope={false}
      />,
    )

    expect(screen.getByText('已编辑 2 个文件')).toBeTruthy()
    expect(screen.queryByText('代码改动')).toBeNull()
    expect(screen.queryByText('查看 Diff')).toBeNull()
    fireEvent.click(screen.getByTestId('code-diff-review-header'))
    expect(mocks.openCodeChangesTab).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('code-diff-review-review-button'))
    expect(mocks.expandCanvasForScope).toHaveBeenCalledWith('conversation:s1')
    expect(mocks.openCodeChangesTab).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: '/repo',
      sessionId: 's1',
      agentTurnEndMessageId: 'a1',
      focusView: 'agent',
    }))
    expect(mocks.openCodeChangesTab).not.toHaveBeenCalledWith(expect.objectContaining({
      focusRelativePath: expect.any(String),
    }))
  })

  it('does not render in a team space or an embedded preview', () => {
    mocks.spaceType = 'team_space'
    const { rerender } = render(
      <CodeDiffReviewCard
        message={message('a1', 'assistant')}
        timelineMessages={[message('u1', 'user'), message('a1', 'assistant')]}
        sessionId="s1"
        isLastInTurn
        isMiniMessage={false}
        isErrorEnvelope={false}
      />,
    )
    expect(screen.queryByTestId('code-diff-review-card')).toBeNull()

    mocks.spaceType = 'workspace'
    rerender(
      <CodeDiffReviewCard
        message={message('a1', 'assistant')}
        timelineMessages={[message('u1', 'user'), message('a1', 'assistant')]}
        sessionId="s1"
        isLastInTurn
        isMiniMessage={false}
        isErrorEnvelope={false}
        previewMode
      />,
    )
    expect(screen.queryByTestId('code-diff-review-card')).toBeNull()
  })

  it('does not render before Git status is confirmed or for a non-Git root', () => {
    mocks.gitStatus.statusRevision = 0
    const { rerender } = render(
      <CodeDiffReviewCard
        message={message('a1', 'assistant')}
        timelineMessages={[message('u1', 'user'), message('a1', 'assistant')]}
        sessionId="s1"
        isLastInTurn
        isMiniMessage={false}
        isErrorEnvelope={false}
      />,
    )
    expect(screen.queryByTestId('code-diff-review-card')).toBeNull()

    mocks.gitStatus.statusRevision = 1
    mocks.gitStatus.isGitRepo = false
    rerender(
      <CodeDiffReviewCard
        message={message('a1', 'assistant')}
        timelineMessages={[message('u1', 'user'), message('a1', 'assistant')]}
        sessionId="s1"
        isLastInTurn
        isMiniMessage={false}
        isErrorEnvelope={false}
      />,
    )
    expect(screen.queryByTestId('code-diff-review-card')).toBeNull()
  })

  it('hides the card when the confirmed Git status changes to non-Git', () => {
    const { rerender } = render(
      <CodeDiffReviewCard
        message={message('a1', 'assistant')}
        timelineMessages={[message('u1', 'user'), message('a1', 'assistant')]}
        sessionId="s1"
        isLastInTurn
        isMiniMessage={false}
        isErrorEnvelope={false}
      />,
    )
    expect(screen.getByTestId('code-diff-review-card')).toBeTruthy()

    mocks.gitStatus.isGitRepo = false
    mocks.gitStatus.statusRevision = 2
    rerender(
      <CodeDiffReviewCard
        message={message('a1', 'assistant')}
        timelineMessages={[message('u1', 'user'), message('a1', 'assistant')]}
        sessionId="s1"
        isLastInTurn
        isMiniMessage={false}
        isErrorEnvelope={false}
      />,
    )
    expect(screen.queryByTestId('code-diff-review-card')).toBeNull()
  })

  it('hides the card immediately when the session worktree changes', () => {
    render(
      <CodeDiffReviewCard
        message={message('a1', 'assistant')}
        timelineMessages={[message('u1', 'user'), message('a1', 'assistant')]}
        sessionId="s1"
        tabScopeKey="conversation:s1"
        isLastInTurn
        isMiniMessage={false}
        isErrorEnvelope={false}
      />,
    )

    expect(screen.getByTestId('code-diff-review-card')).toBeTruthy()

    act(() => {
      useSessionBoundCodeRootStore.getState().setBindingLocal('s1', {
        rootPath: '/repo/wt-b',
      })
    })

    expect(screen.queryByTestId('code-diff-review-card')).toBeNull()
  })

  it('uses the selected workspace when the chat is outside SpaceContextArea', () => {
    mocks.hasSpaceContext = false

    render(
      <CodeDiffReviewCard
        message={message('a1', 'assistant')}
        timelineMessages={[message('u1', 'user'), message('a1', 'assistant')]}
        sessionId="s1"
        tabScopeKey="conversation:s1"
        isLastInTurn
        isMiniMessage={false}
        isErrorEnvelope={false}
      />,
    )

    fireEvent.click(screen.getByTestId('code-diff-review-review-button'))
    expect(mocks.openCodeChangesTab).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: 'space-1',
    }))
    expect(screen.getAllByTestId('code-diff-review-file')).toHaveLength(2)
    expect(screen.getByText('src/one.ts')).toBeTruthy()
    expect(screen.getByText('+3')).toBeTruthy()
    expect(screen.getAllByText('-1')).toHaveLength(2)
    expect(screen.getAllByTestId('code-diff-review-file')[0]?.getAttribute('title')).toBe('/repo/src/one.ts')
    expect(screen.getAllByTestId('code-diff-review-status')[1]?.textContent).toBe('A')

    fireEvent.click(screen.getAllByTestId('code-diff-review-file')[1]!)
    expect(mocks.openCodeChangesTab).toHaveBeenLastCalledWith(expect.objectContaining({
      focusRelativePath: 'src/two.ts',
      focusView: 'agent',
    }))
  })
})
