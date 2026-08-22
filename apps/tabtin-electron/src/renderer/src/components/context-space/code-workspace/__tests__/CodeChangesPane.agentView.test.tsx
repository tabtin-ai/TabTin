import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { CodeChangesPane } from '../CodeChangesPane'

const mocks = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  journalRecords: [] as Array<{ toolUseId: string; patch: Record<string, unknown> }>,
  gitStatus: {
    branch: 'main',
    gitStatus: new Map([['/repo/a.ts', 'M']]),
    stagedStatus: new Map(),
    unstagedStatus: new Map([['/repo/a.ts', 'M']]),
    isGitRepo: true,
    isLoading: false,
    statusRevision: 1,
    contentRevisions: {},
    refresh: vi.fn(),
  },
  workflowData: {
    files: [{
      path: 'a.ts',
      status: 'M',
      staged: false,
      unstaged: true,
      partiallyStaged: false,
      added: 1,
      deleted: 0,
      untracked: false,
      conflict: false,
    }],
    branchNames: ['main'],
    ensureBranchContext: vi.fn(),
  },
}))

function assistantWithBlocks(blocks: unknown[], id = 'a1'): ChatMessage {
  const content_blocks_json = blocks as ChatMessage['content_blocks_json']
  return {
    id,
    role: 'assistant',
    content: '',
    created_at: '2026-08-13T00:00:01Z',
    message_kind: 'llm',
    agent_run_id: 'run-1',
    content_blocks_json,
    blocks: (content_blocks_json ?? []).map((block, index) => ({
      index,
      block_id: `b-${id}-${index}`,
      block,
      finalized: true,
      partial: false,
    })),
  } as ChatMessage
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number; file?: string }) => {
      let text = opts?.defaultValue ?? key
      if (opts?.count != null) text = text.replace(/\{\{count\}\}/g, String(opts.count))
      if (opts?.file != null) text = text.replace(/\{\{file\}\}/g, opts.file)
      return text
    },
  }),
}))

vi.mock('@components/tabcode/hooks/useGitStatus', () => ({
  useGitStatus: () => mocks.gitStatus,
}))

vi.mock('@components/tabcode/components/git-workflow/useGitWorkflowData', () => ({
  useGitWorkflowData: () => mocks.workflowData,
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: { messagesBySessionId: Record<string, ChatMessage[]> }) => unknown) =>
    selector({ messagesBySessionId: { 'session-1': mocks.messages } }),
}))

vi.mock('../agentTurnDiffSnapshots', () => ({
  useAgentTurnDiffStore: (
    selector: (state: {
      captureFromMessages: () => void
      listForSessionRoot: () => []
      byMessageId: Record<string, never>
    }) => unknown,
  ) =>
    selector({
      captureFromMessages: vi.fn(),
      listForSessionRoot: () => [],
      byMessageId: {},
    }),
}))

vi.mock('../fileEditPatchJournalStore', () => ({
  useFileEditPatchJournalStore: (
    selector: (state: {
      byThread: Record<string, typeof mocks.journalRecords>
      load: () => Promise<void>
    }) => unknown,
  ) =>
    selector({
      byThread: { 'session-1': mocks.journalRecords },
      load: vi.fn(async () => undefined),
    }),
}))

vi.mock('../ContinuousChangesDiff', () => ({
  ContinuousChangesDiff: (props: {
    frozenTextsByPath?: Record<string, { leftText: string; rightText: string }>
    unreadablePaths?: Set<string>
  }) => (
    <div
      data-testid="mock-continuous-diff"
      data-frozen-paths={Object.keys(props.frozenTextsByPath || {}).join(',')}
      data-unreadable={Array.from(props.unreadablePaths || []).join(',')}
    >
      {Object.entries(props.frozenTextsByPath || {}).map(([path, texts]) => (
        <div key={path} data-testid="mock-frozen-diff" data-path={path}>
          {`${texts.leftText}→${texts.rightText}`}
        </div>
      ))}
    </div>
  ),
}))

vi.mock('../ChangesFileTree', () => ({
  ChangesFileTree: (props: { readOnly?: boolean; selectedPath?: string | null }) => (
    <div
      data-testid="mock-changes-tree"
      data-readonly={props.readOnly ? 'true' : 'false'}
      data-selected-path={props.selectedPath ?? ''}
    />
  ),
}))

vi.mock('@components/tabcode/components/TabCodeConfirmDialog', () => ({
  TabCodeConfirmDialog: () => null,
}))

vi.mock('../StaticUnifiedFileDiff', () => ({
  StaticUnifiedFileDiff: ({ leftText, rightText }: { leftText?: string; rightText?: string }) => (
    <div data-testid="mock-static-diff">{`${leftText ?? ''}→${rightText ?? ''}`}</div>
  ),
}))

describe('CodeChangesPane agent view ( editor-only)', () => {
  beforeEach(() => {
    mocks.messages = []
    mocks.journalRecords = []
    mocks.gitStatus.gitStatus = new Map([['/repo/a.ts', 'M']])
  })

  afterEach(() => {
    cleanup()
  })

  it('shows fallback guide when the latest turn has no editor ops but live dirty exists', () => {
    render(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="agent"
      />,
    )

    expect(screen.getByTestId('changes-agent-empty')).toBeTruthy()
    expect(screen.getByText(/本轮没有可展示的编辑工具改动/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('changes-agent-empty-show-uncommitted'))
    expect(screen.getByTestId('mock-continuous-diff')).toBeTruthy()
  })

  it('defaults to the latest Agent turn view', () => {
    render(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
      />,
    )

    expect(screen.getByTestId('changes-agent-empty')).toBeTruthy()
    expect(screen.queryByTestId('mock-continuous-diff')).toBeNull()
  })

  it('renders the final frozen file diff in the shared dual-pane layout', () => {
    mocks.messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'edit a.ts',
        created_at: '2026-08-13T00:00:00Z',
      } as ChatMessage,
      assistantWithBlocks([
        {
          type: 'tool_use',
          id: 'tu_edit',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_edit',
          content: JSON.stringify({
            success: true,
            old_lines: ['old'],
            new_lines: ['new'],
          }),
        },
      ]),
    ]
    mocks.journalRecords = [{
      toolUseId: 'tu_edit',
      codeRootPath: '/repo',
      patch: {
        toolName: 'edit_file',
        relativePath: 'a.ts',
        status: 'modified',
        before: 'old',
        after: 'new',
      },
    }]

    render(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="agent"
      />,
    )

    expect(screen.queryByTestId('changes-agent-empty')).toBeNull()
    expect(screen.queryByTestId('changes-agent-hunk')).toBeNull()
    expect(screen.getByTestId('changes-agent-ops')).toBeTruthy()
    expect(screen.getByTestId('mock-continuous-diff')).toBeTruthy()
    expect(screen.getByTestId('mock-changes-tree').getAttribute('data-readonly')).toBe('true')
    expect(screen.getByTestId('mock-frozen-diff').textContent).toBe('old→new')
    expect(screen.getByText('本轮agent编辑工具造成的最终差异（不含终端改动与之后的手改）')).toBeTruthy()
  })

  it('focuses the requested Agent file when a Changes intent arrives', () => {
    mocks.messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'edit a.ts',
        created_at: '2026-08-13T00:00:00Z',
      } as ChatMessage,
      assistantWithBlocks([
        {
          type: 'tool_use',
          id: 'tu_edit',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_edit',
          content: JSON.stringify({ success: true }),
        },
      ]),
    ]
    mocks.journalRecords = [{
      toolUseId: 'tu_edit',
      codeRootPath: '/repo',
      patch: {
        toolName: 'edit_file',
        relativePath: 'a.ts',
        status: 'modified',
        before: 'old',
        after: 'new',
      },
    }]

    const { rerender } = render(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="uncommitted"
      />,
    )

    rerender(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="uncommitted"
        requestedView="agent"
        requestedRelativePath="a.ts"
        viewIntentId="open-a-ts"
      />,
    )

    expect(screen.getByTestId('mock-changes-tree').getAttribute('data-selected-path')).toBe('/repo/a.ts')
  })

  it('restores the latest Agent edit for the active code root', () => {
    mocks.messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'edit in A',
        created_at: '2026-08-13T00:00:00Z',
      } as ChatMessage,
      assistantWithBlocks([
        {
          type: 'tool_use',
          id: 'tu_a',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_a',
          content: JSON.stringify({ success: true }),
        },
      ]),
      {
        id: 'u2',
        role: 'user',
        content: 'edit in B',
        created_at: '2026-08-13T00:00:02Z',
      } as ChatMessage,
      assistantWithBlocks([
        {
          type: 'tool_use',
          id: 'tu_b',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_b',
          content: JSON.stringify({ success: true }),
        },
      ], 'a2'),
    ]
    mocks.journalRecords = [
      {
        toolUseId: 'tu_a',
        codeRootPath: '/repo-a',
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          before: 'a-old',
          after: 'a-new',
        },
      },
      {
        toolUseId: 'tu_b',
        codeRootPath: '/repo-b',
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          before: 'b-old',
          after: 'b-new',
        },
      },
    ]

    render(
      <CodeChangesPane
        rootPath="/repo-a"
        sessionId="session-1"
        initialView="agent"
      />,
    )

    expect(screen.getByTestId('mock-frozen-diff').textContent).toBe('a-old→a-new')
  })

  it('folds two edits of the same file into one final diff', () => {
    mocks.messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'edit a.ts twice',
        created_at: '2026-08-13T00:00:00Z',
      } as ChatMessage,
      assistantWithBlocks([
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: JSON.stringify({ success: true, old_lines: ['one'], new_lines: ['two'] }),
        },
        {
          type: 'tool_use',
          id: 'tu_2',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_2',
          content: JSON.stringify({ success: true, old_lines: ['two'], new_lines: ['three'] }),
        },
      ]),
    ]
    mocks.journalRecords = [
      {
        toolUseId: 'tu_1',
        codeRootPath: '/repo',
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          before: 'one',
          after: 'two',
          beforeFull: 'one',
          afterFull: 'two',
        },
      },
      {
        toolUseId: 'tu_2',
        codeRootPath: '/repo',
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          before: 'two',
          after: 'three',
          beforeFull: 'two',
          afterFull: 'three',
        },
      },
    ]

    render(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="agent"
      />,
    )

    expect(screen.getAllByTestId('mock-frozen-diff')).toHaveLength(1)
    expect(screen.getByTestId('mock-frozen-diff').textContent).toBe('one→three')
  })

  it('shows Agent empty state for a pending user and hides the previous turn diff', () => {
    mocks.messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'edit a.ts',
        created_at: '2026-08-13T00:00:00Z',
      } as ChatMessage,
      assistantWithBlocks([
        {
          type: 'tool_use',
          id: 'tu_edit',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_edit',
          content: JSON.stringify({
            success: true,
            old_lines: ['old'],
            new_lines: ['new'],
          }),
        },
      ]),
      {
        id: 'u2',
        role: 'user',
        content: 'next task',
        created_at: '2026-08-13T00:00:02Z',
      } as ChatMessage,
    ]

    render(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="agent"
      />,
    )

    expect(screen.getByTestId('changes-agent-empty')).toBeTruthy()
    expect(screen.queryByTestId('mock-frozen-diff')).toBeNull()
    expect(screen.queryByTestId('changes-agent-ops')).toBeNull()
  })

  it('does not overwrite a manual uncommitted view when initialView later becomes agent', () => {
    const { rerender } = render(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="uncommitted"
      />,
    )

    expect(screen.getByTestId('mock-continuous-diff')).toBeTruthy()
    expect(screen.queryByTestId('changes-agent-empty')).toBeNull()

    rerender(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="agent"
      />,
    )

    expect(screen.getByTestId('mock-continuous-diff')).toBeTruthy()
    expect(screen.queryByTestId('changes-agent-empty')).toBeNull()
  })

  it('returns a kept-alive Changes pane to the requested Agent turn', () => {
    mocks.messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'edit a.ts',
        created_at: '2026-08-13T00:00:00Z',
      } as ChatMessage,
      assistantWithBlocks([
        {
          type: 'tool_use',
          id: 'tu_edit',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_edit',
          content: JSON.stringify({ success: true }),
        },
      ]),
    ]
    mocks.journalRecords = [{
      toolUseId: 'tu_edit',
      codeRootPath: '/repo',
      patch: {
        toolName: 'edit_file',
        relativePath: 'a.ts',
        status: 'modified',
        before: 'old',
        after: 'new',
      },
    }]

    const { rerender } = render(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="uncommitted"
      />,
    )

    rerender(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="uncommitted"
        agentTurnEndMessageId="a1"
        requestedView="agent"
        viewIntentId="open-1"
      />,
    )

    expect(screen.getByTestId('changes-agent-ops')).toBeTruthy()
    expect(screen.getByTestId('mock-frozen-diff').textContent).toBe('old→new')

    rerender(
      <CodeChangesPane
        rootPath="/repo"
        sessionId="session-1"
        initialView="uncommitted"
        requestedView="uncommitted"
        viewIntentId="open-2"
      />,
    )

    expect(screen.getByTestId('changes-diff-column')).toBeTruthy()
    expect(screen.queryByTestId('changes-agent-ops')).toBeNull()
  })
})
