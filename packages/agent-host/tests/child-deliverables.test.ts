import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MessageBlockRecord } from '@tabtin/agent-runtime'
import {
  CHILD_DELIVERABLES_TAG,
  appendDeliverablesToToolResultContent,
  canonicalizeDeliverableRelativePath,
  collectChildDeliverables,
  collectDeliverablesFromRecords,
  filterRecordsBySubagentRunId,
  isDeliverableRelativePath,
  parseDeliverablesFromToolResultContent,
  type ChildDeliverable,
} from '../src/delivery/child-deliverables.js'

function record(
  messageId: string,
  blocks: unknown[],
  extras?: Partial<MessageBlockRecord>,
): MessageBlockRecord {
  return {
    v: 1,
    recorded_at: new Date().toISOString(),
    message_id: messageId,
    role: 'assistant',
    message_kind: 'llm',
    blocks_json: blocks as MessageBlockRecord['blocks_json'],
    ...extras,
  }
}

describe('child-deliverables path gates', () => {
  it('canonicalize rejects absolute / scheme / traversal', () => {
    expect(canonicalizeDeliverableRelativePath('/tmp/a.txt')).toBeNull()
    expect(canonicalizeDeliverableRelativePath('file:x')).toBeNull()
    expect(canonicalizeDeliverableRelativePath('../secret.txt')).toBeNull()
    expect(canonicalizeDeliverableRelativePath('./docs/a.md')).toBe('docs/a.md')
  })

  it('isDeliverableRelativePath rejects temp / hidden / extensionless', () => {
    expect(isDeliverableRelativePath('tmp/a.txt')).toBe(false)
    expect(isDeliverableRelativePath('.agent-drafts/a.md')).toBe(false)
    expect(isDeliverableRelativePath('bin/tool')).toBe(false)
    expect(isDeliverableRelativePath('reports/out.xlsx')).toBe(true)
  })
})

describe('collectDeliverablesFromRecords', () => {
  it('nets write + delete and keeps surviving local_file', () => {
    const records = [
      record('m1', [
        { type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'draft.md' } },
        { type: 'tool_result', tool_use_id: 'w1', content: '{"success":true}' },
        { type: 'tool_use', id: 'd1', name: 'delete_file', input: { path: 'draft.md' } },
        { type: 'tool_result', tool_use_id: 'd1', content: '{"success":true}' },
        { type: 'tool_use', id: 'w2', name: 'write_file', input: { path: 'final.md' } },
        { type: 'tool_result', tool_use_id: 'w2', content: '{"success":true}' },
      ]),
    ]
    expect(collectDeliverablesFromRecords(records)).toEqual([
      {
        artifact_kind: 'local_file',
        relative_path: 'final.md',
        filename: 'final.md',
      },
    ])
  })

  it('collects platform_resource / oss_file rich blocks', () => {
    const records = [
      record('m1', [
        {
          type: 'tabtin_rich_content',
          kind: 'resource_ref',
          summary: '客户表',
          payload: {
            artifact_kind: 'platform_resource',
            resource_type: 'tabdata',
            resource_id: 'tbl_1',
            resource_name: '客户表',
            url: 'tabtin://resource/tabdata/tbl_1',
          },
        },
        {
          type: 'tabtin_rich_content',
          kind: 'file',
          summary: 'deck.pdf',
          payload: {
            artifact_kind: 'oss_file',
            file_id: 'file-uuid-1',
            filename: 'deck.pdf',
          },
        },
      ]),
    ]
    const got = collectDeliverablesFromRecords(records)
    expect(got).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact_kind: 'platform_resource',
        resource_id: 'tbl_1',
        url: 'tabtin://resource/tabdata/tbl_1',
      }),
      expect.objectContaining({
        artifact_kind: 'oss_file',
        filename: 'deck.pdf',
        url: expect.stringContaining('tabtin://resource/file/file-uuid-1'),
      }),
    ]))
  })

  it('ignores failed write_file', () => {
    const records = [
      record('m1', [
        { type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'fail.md' } },
        { type: 'tool_result', tool_use_id: 'w1', content: '{"success":false}', is_error: true },
      ]),
    ]
    expect(collectDeliverablesFromRecords(records)).toEqual([])
  })
})

describe('tool_result content embed/parse', () => {
  it('round-trips deliverables through tool_result text', () => {
    const deliverables: ChildDeliverable[] = [
      {
        artifact_kind: 'local_file',
        relative_path: 'reports/a.xlsx',
        filename: 'a.xlsx',
      },
    ]
    const content = appendDeliverablesToToolResultContent('任务完成', deliverables)
    expect(content).toContain('交付物：')
    expect(content).toContain(`<${CHILD_DELIVERABLES_TAG}>`)
    expect(parseDeliverablesFromToolResultContent(content)).toEqual(deliverables)
  })

  it('returns empty when tag missing', () => {
    expect(parseDeliverablesFromToolResultContent('plain summary')).toEqual([])
  })
})

describe('collectChildDeliverables — parent blocks + subagent_run_id ( 方案 A)', () => {
  const tmpRoots: string[] = []
  afterEach(() => {
    // 测试夹具留在 tmp；不强制 rm（多 agent 共享 /tmp 时更安全）
    tmpRoots.length = 0
  })

  it('filterRecordsBySubagentRunId keeps only matching child', () => {
    const records = [
      record('parent', [{ type: 'text', text: 'main' }]),
      record('child', [
        { type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'a.md' } },
        { type: 'tool_result', tool_use_id: 'w1', content: '{"success":true}' },
      ], { subagent_run_id: 'child-1' }),
      record('other', [
        { type: 'tool_use', id: 'w2', name: 'write_file', input: { path: 'b.md' } },
        { type: 'tool_result', tool_use_id: 'w2', content: '{"success":true}' },
      ], { subagent_run_id: 'child-2' }),
    ]
    expect(filterRecordsBySubagentRunId(records, 'child-1')).toHaveLength(1)
    expect(collectDeliverablesFromRecords(filterRecordsBySubagentRunId(records, 'child-1'))).toEqual([
      {
        artifact_kind: 'local_file',
        relative_path: 'a.md',
        filename: 'a.md',
      },
    ])
  })

  it('reads parent message-blocks.jsonl filtered by childId (not sidechain)', async () => {
    const root = mkdtempSync(join(tmpdir(), '8876-deliverables-'))
    tmpRoots.push(root)
    const threadId = 'parent-thread'
    const threadDir = join(root, threadId)
    mkdirSync(threadDir, { recursive: true })
    const childId = '48b2409e-4914-43b8-beb4-f118fb0c85c1'
    const lines = [
      record('main-1', [{ type: 'text', text: 'parent' }]),
      record('child-1', [
        { type: 'tool_use', id: 'w1', name: 'write_file', input: { path: '8876-live-deliverable.txt' } },
        { type: 'tool_result', tool_use_id: 'w1', content: '{"success":true}' },
      ], { subagent_run_id: childId }),
    ]
    writeFileSync(
      join(threadDir, 'message-blocks.jsonl'),
      `${lines.map((r) => JSON.stringify(r)).join('\n')}\n`,
      { mode: 0o600 },
    )
    // 子 sidechain 故意不写 message-blocks——若误读 sidechain 应得到 []
    mkdirSync(join(threadDir, 'subagents', `agent-${childId}`), { recursive: true })

    let flushed = false
    const got = await collectChildDeliverables(
      { sessionDir: root, threadId },
      childId,
      { flushParentMessageBlocks: async () => { flushed = true } },
    )
    expect(flushed).toBe(true)
    expect(got).toEqual([
      {
        artifact_kind: 'local_file',
        relative_path: '8876-live-deliverable.txt',
        filename: '8876-live-deliverable.txt',
      },
    ])
  })
})
