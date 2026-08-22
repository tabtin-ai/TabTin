import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  aggregateEditorTurnFinals,
  collectClosedAgentTurnReview,
  collectLatestTurnEditorFinals,
  collectLatestTurnEditorOps,
  collectTurnEditorOps,
  foldEditorTurnFiles,
  getLatestClosedTurnEndMessageIdForCodeRoot,
  groupEditorOpsByFile,
  indexEditorTurnJournal,
  latestTurnHasEditorOps,
  summarizeEditorTurn,
} from '../agentTurnEditorOps'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content' | 'created_at'>): ChatMessage {
  const base = {
    message_kind: partial.role === 'assistant' ? 'llm' : undefined,
    ...partial,
  } as ChatMessage
  if (base.blocks === undefined && Array.isArray(base.content_blocks_json)) {
    base.blocks = base.content_blocks_json.map((block, index) => ({
      index,
      block_id: `b-${base.id}-${index}`,
      block,
      finalized: true,
      partial: false,
    })) as never
  }
  return base
}

function editorTurn(blocks: unknown[]): ChatMessage[] {
  return [
    msg({ id: 'u1', role: 'user', content: 'please edit', created_at: '2026-08-13T00:00:00Z' }),
    msg({
      id: 'a1',
      role: 'assistant',
      content: '',
      created_at: '2026-08-13T00:00:01Z',
      agent_run_id: 'run-1',
      content_blocks_json: blocks as ChatMessage['content_blocks_json'],
    }),
  ]
}

describe('agentTurnEditorOps', () => {
  it('collects a successful edit_file hunk from tool_result old/new lines', () => {
    const ops = collectTurnEditorOps(editorTurn([
      {
        type: 'tool_use',
        id: 'tu_edit',
        name: 'edit_file',
        input: { path: 'src/a.ts', old_string: 'alpha', new_string: 'beta' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_edit',
        content: JSON.stringify({
          success: true,
          old_lines: ['alpha'],
          new_lines: ['beta'],
        }),
      },
    ]))
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      toolName: 'edit_file',
      relativePath: 'src/a.ts',
      before: 'alpha',
      after: 'beta',
      displayable: true,
    })
    expect(ops[0]?.insertions).toBeGreaterThan(0)
  })

  it('ignores failed edits and terminal-only file changes', () => {
    const ops = collectTurnEditorOps(editorTurn([
      {
        type: 'tool_use',
        id: 'tu_fail',
        name: 'edit_file',
        input: { path: 'src/a.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_fail',
        is_error: true,
        content: JSON.stringify({ success: false }),
      },
      {
        type: 'tool_use',
        id: 'tu_sh',
        name: 'run_terminal_command',
        input: { command: 'echo hi > src/a.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_sh',
        content: JSON.stringify({
          success: true,
          file_history: { paths: ['src/a.ts'] },
        }),
      },
    ]))
    expect(ops).toEqual([])
    expect(latestTurnHasEditorOps(editorTurn([
      {
        type: 'tool_use',
        id: 'tu_sh',
        name: 'run_terminal_command',
        input: { command: 'echo hi > src/a.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_sh',
        content: JSON.stringify({ success: true }),
      },
    ]))).toBe(false)
  })

  it('keeps multiple edits to the same file as separate collected ops', () => {
    const files = groupEditorOpsByFile(collectTurnEditorOps(editorTurn([
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
    ])))
    expect(files).toHaveLength(1)
    expect(files[0]?.ops.map((op) => op.toolUseId)).toEqual(['tu_1', 'tu_2'])
    expect(files[0]?.ops.map((op) => op.after)).toEqual(['two', 'three'])
  })

  it('folds two full-file edits on the same path into one→three', () => {
    const files = groupEditorOpsByFile(collectTurnEditorOps(editorTurn([
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
    ]), indexEditorTurnJournal([
      {
        toolUseId: 'tu_1',
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
    ])))
    const folded = foldEditorTurnFiles(files)
    expect(folded).toHaveLength(1)
    expect(folded[0]).toMatchObject({
      relativePath: 'a.ts',
      status: 'modified',
      before: 'one',
      after: 'three',
      displayable: true,
      opCount: 2,
    })
  })

  it('aggregates folded latest-turn finals for the workbench change counts', () => {
    const journal = [
      {
        toolUseId: 'tu_1',
        patch: {
          toolName: 'edit_file' as const,
          relativePath: 'a.ts',
          status: 'modified' as const,
          before: 'one',
          after: 'two',
          beforeFull: 'one',
          afterFull: 'two',
        },
      },
      {
        toolUseId: 'tu_2',
        patch: {
          toolName: 'edit_file' as const,
          relativePath: 'a.ts',
          status: 'modified' as const,
          before: 'two',
          after: 'three',
          beforeFull: 'two',
          afterFull: 'three',
        },
      },
      {
        toolUseId: 'tu_add',
        patch: {
          toolName: 'write_file' as const,
          relativePath: 'b.ts',
          status: 'added' as const,
          after: 'created',
          afterFull: 'created',
        },
      },
    ]
    const finals = collectLatestTurnEditorFinals(editorTurn([
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'edit_file',
        input: { path: 'a.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: JSON.stringify({ success: true }),
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
        content: JSON.stringify({ success: true }),
      },
      {
        type: 'tool_use',
        id: 'tu_add',
        name: 'write_file',
        input: { path: 'b.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_add',
        content: JSON.stringify({ success: true }),
      },
    ]), journal)
    expect(finals).toHaveLength(2)
    expect(aggregateEditorTurnFinals(finals)).toEqual({ insertions: 2, deletions: 1 })
  })

  it('marks a broken full-snapshot chain unreadable instead of guessing disk', () => {
    const files = groupEditorOpsByFile(collectTurnEditorOps(editorTurn([
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
    ]), indexEditorTurnJournal([
      {
        toolUseId: 'tu_1',
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
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          before: 'two',
          after: 'three',
          beforeFull: 'tampered',
          afterFull: 'three',
        },
      },
    ])))
    expect(foldEditorTurnFiles(files)[0]).toMatchObject({
      displayable: false,
      status: 'unreadable',
      opCount: 2,
    })
  })

  it('falls back to a single legacy hunk and refuses to compose multi-step old journals', () => {
    const single = foldEditorTurnFiles(groupEditorOpsByFile(collectTurnEditorOps(editorTurn([
      {
        type: 'tool_use',
        id: 'tu_edit',
        name: 'edit_file',
        input: { path: 'a.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_edit',
        content: JSON.stringify({ success: true, old_lines: ['alpha'], new_lines: ['beta'] }),
      },
    ]))))
    expect(single[0]).toMatchObject({
      before: 'alpha',
      after: 'beta',
      displayable: true,
      opCount: 1,
    })

    const multi = foldEditorTurnFiles(groupEditorOpsByFile(collectTurnEditorOps(editorTurn([
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
    ]))))
    expect(multi[0]).toMatchObject({
      displayable: false,
      status: 'unreadable',
      opCount: 2,
    })
  })

  it('uses journal for write/delete and marks missing write bodies unreadable', () => {
    const turn = editorTurn([
      {
        type: 'tool_use',
        id: 'tu_write',
        name: 'write_file',
        input: { path: 'new.ts', contents: 'created' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_write',
        content: JSON.stringify({ success: true }),
      },
      {
        type: 'tool_use',
        id: 'tu_del',
        name: 'delete_file',
        input: { path: 'gone.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_del',
        content: JSON.stringify({ success: true }),
      },
    ])
    const withoutJournal = collectTurnEditorOps(turn)
    expect(withoutJournal.every((op) => op.status === 'unreadable')).toBe(true)

    const withJournal = collectTurnEditorOps(turn, indexEditorTurnJournal([
      {
        toolUseId: 'tu_write',
        patch: { toolName: 'write_file', relativePath: 'new.ts', status: 'added', after: 'created' },
      },
      {
        toolUseId: 'tu_del',
        patch: { toolName: 'delete_file', relativePath: 'gone.ts', status: 'deleted', before: 'old' },
      },
    ]))
    expect(withJournal.map((op) => op.status)).toEqual(['added', 'deleted'])
    expect(withJournal.every((op) => op.displayable)).toBe(true)
  })

  it('does not guess from current disk when the journal patch is unreadable', () => {
    const ops = collectTurnEditorOps(editorTurn([
      {
        type: 'tool_use',
        id: 'tu_bin',
        name: 'write_file',
        input: { path: 'a.bin', contents: 'nope' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_bin',
        content: JSON.stringify({ success: true }),
      },
    ]), indexEditorTurnJournal([{
      toolUseId: 'tu_bin',
      patch: { toolName: 'write_file', relativePath: 'a.bin', status: 'unreadable', binary: true },
    }]))
    expect(ops[0]).toMatchObject({ displayable: false, binary: true })
    expect(ops[0]?.after).toBeUndefined()
  })

  it('defaults to no agent ops when the latest turn has none', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'hello', created_at: '2026-08-13T00:00:00Z' }),
      msg({ id: 'a1', role: 'assistant', content: 'ok', created_at: '2026-08-13T00:00:01Z' }),
    ]
    expect(collectLatestTurnEditorOps(messages)).toEqual([])
    expect(summarizeEditorTurn([]).changed).toBe(0)
    expect(latestTurnHasEditorOps(messages)).toBe(false)
  })

  it('returns no editor ops while a new user message is pending', () => {
    const pending = [
      ...editorTurn([
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
      ]),
      msg({ id: 'u2', role: 'user', content: 'next task', created_at: '2026-08-13T00:00:02Z' }),
    ]
    expect(collectLatestTurnEditorOps(pending)).toEqual([])
    expect(collectLatestTurnEditorFinals(pending)).toEqual([])
    expect(latestTurnHasEditorOps(pending)).toBe(false)
  })

  it('returns only the current closed turn for the review card', () => {
    const messages = [
      ...editorTurn([
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
      ]),
      msg({ id: 'u2', role: 'user', content: 'just explain', created_at: '2026-08-13T00:00:02Z' }),
      msg({ id: 'a2', role: 'assistant', content: 'done', created_at: '2026-08-13T00:00:03Z' }),
    ]
    const records = [{
      toolUseId: 'tu_1',
      codeRootPath: '/repo',
      patch: {
        toolName: 'edit_file' as const,
        relativePath: 'a.ts',
        status: 'modified' as const,
        before: 'one',
        after: 'two',
      },
    }]

    expect(collectClosedAgentTurnReview(messages, records, '/repo')).toBeNull()
  })

  it('builds the review reference and final line summary for the current turn', () => {
    const messages = editorTurn([
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
    ])
    const records = [{
      toolUseId: 'tu_1',
      codeRootPath: '/repo',
      patch: {
        toolName: 'edit_file' as const,
        relativePath: 'a.ts',
        status: 'modified' as const,
        before: 'one',
        after: 'two',
      },
    }]

    expect(collectClosedAgentTurnReview(messages, records, '/repo')).toMatchObject({
      turnEndMessageId: 'a1',
      changed: 1,
      files: [{ relativePath: 'a.ts', displayable: true }],
    })
  })

  it('hides the review while a next user turn is pending', () => {
    const messages = [
      ...editorTurn([
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
      ]),
      msg({ id: 'u2', role: 'user', content: 'next', created_at: '2026-08-13T00:00:02Z' }),
    ]
    const records = [{
      toolUseId: 'tu_1',
      codeRootPath: '/repo',
      patch: {
        toolName: 'edit_file' as const,
        relativePath: 'a.ts',
        status: 'modified' as const,
        before: 'one',
        after: 'two',
      },
    }]

    expect(collectClosedAgentTurnReview(messages, records, '/repo')).toBeNull()
  })

  it('collects only the second turn after assistant₂ arrives', () => {
    const messages = [
      ...editorTurn([
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
      ]),
      msg({ id: 'u2', role: 'user', content: 'edit b.ts', created_at: '2026-08-13T00:00:02Z' }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '',
        created_at: '2026-08-13T00:00:03Z',
        agent_run_id: 'run-2',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'edit_file',
            input: { path: 'b.ts' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: JSON.stringify({ success: true, old_lines: ['old'], new_lines: ['new'] }),
          },
        ] as ChatMessage['content_blocks_json'],
      }),
    ]
    const ops = collectLatestTurnEditorOps(messages)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ relativePath: 'b.ts', before: 'old', after: 'new' })
    expect(ops.some((op) => op.relativePath === 'a.ts')).toBe(false)
  })

  it('keeps the previous turn when trailing push is not a regular user message', () => {
    const withPush = [
      ...editorTurn([
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
      ]),
      msg({
        id: 'push-1',
        role: 'user',
        content: '后台完成',
        created_at: '2026-08-13T00:00:02Z',
        metadata: { triggered_by: 'push-notification' },
      }),
    ]
    const ops = collectLatestTurnEditorOps(withPush)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ relativePath: 'a.ts' })
  })

  it('filters same relative paths by the recorded code root', () => {
    const messages = editorTurn([
      {
        type: 'tool_use',
        id: 'tu_a',
        name: 'edit_file',
        input: { path: 'src/a.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_a',
        content: JSON.stringify({ success: true }),
      },
      {
        type: 'tool_use',
        id: 'tu_b',
        name: 'edit_file',
        input: { path: 'src/a.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_b',
        content: JSON.stringify({ success: true }),
      },
    ])
    const records = [
      {
        toolUseId: 'tu_a',
        codeRootPath: '/repo/worktree-a',
        patch: {
          toolName: 'edit_file' as const,
          relativePath: 'src/a.ts',
          status: 'modified' as const,
          before: 'a-old',
          after: 'a-new',
        },
      },
      {
        toolUseId: 'tu_b',
        codeRootPath: '/repo/worktree-b',
        patch: {
          toolName: 'edit_file' as const,
          relativePath: 'src/a.ts',
          status: 'modified' as const,
          before: 'b-old',
          after: 'b-new',
        },
      },
    ]

    expect(collectLatestTurnEditorFinals(messages, records, '/repo/worktree-a')).toMatchObject([
      { relativePath: 'src/a.ts', before: 'a-old', after: 'a-new' },
    ])
    expect(collectLatestTurnEditorFinals(messages, records, '/repo/worktree-b')).toMatchObject([
      { relativePath: 'src/a.ts', before: 'b-old', after: 'b-new' },
    ])
  })

  it('finds the latest completed editor turn for the active code root', () => {
    const messages = [
      ...editorTurn([
        {
          type: 'tool_use',
          id: 'tu_a',
          name: 'edit_file',
          input: { path: 'src/a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_a',
          content: JSON.stringify({ success: true }),
        },
      ]),
      msg({ id: 'u2', role: 'user', content: 'edit b', created_at: '2026-08-13T00:00:02Z' }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '',
        created_at: '2026-08-13T00:00:03Z',
        agent_run_id: 'run-2',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_b',
            name: 'edit_file',
            input: { path: 'src/a.ts' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_b',
            content: JSON.stringify({ success: true }),
          },
        ] as ChatMessage['content_blocks_json'],
      }),
    ]
    const records = [
      {
        toolUseId: 'tu_a',
        codeRootPath: '/repo/worktree-a',
        patch: {
          toolName: 'edit_file' as const,
          relativePath: 'src/a.ts',
          status: 'modified' as const,
          before: 'a-old',
          after: 'a-new',
        },
      },
      {
        toolUseId: 'tu_b',
        codeRootPath: '/repo/worktree-b',
        patch: {
          toolName: 'edit_file' as const,
          relativePath: 'src/a.ts',
          status: 'modified' as const,
          before: 'b-old',
          after: 'b-new',
        },
      },
    ]

    expect(getLatestClosedTurnEndMessageIdForCodeRoot(
      messages,
      records,
      '/repo/worktree-a',
    )).toBe('a1')
    expect(getLatestClosedTurnEndMessageIdForCodeRoot(
      messages,
      records,
      '/repo/worktree-b',
    )).toBe('a2')
  })

  it('does not assign legacy journal records without a code root to the active worktree', () => {
    const messages = editorTurn([
      {
        type: 'tool_use',
        id: 'tu_legacy',
        name: 'edit_file',
        input: { path: 'src/a.ts' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_legacy',
        content: JSON.stringify({ success: true }),
      },
    ])
    const records = [{
      toolUseId: 'tu_legacy',
      patch: {
        toolName: 'edit_file' as const,
        relativePath: 'src/a.ts',
        status: 'modified' as const,
        before: 'old',
        after: 'new',
      },
    }]

    expect(collectLatestTurnEditorFinals(messages, records, '/repo/worktree-a')).toEqual([])
  })
})
