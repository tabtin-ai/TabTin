/**
 * list-subagent-runs.test.ts — `subagent-index-reader` 回归
 *
 * 测什么：
 *   - subagents.jsonl 不存在 → `subagents_index_missing`
 *   - 只有 started 行 → status='running'（孤儿 run，未结束）
 *   - started + ended 行配对 → status 取 ended.status，含 duration / endedAt
 *   - started 行 model → 恢复到 SubagentRunSnapshot.model
 *   - 多个子 Agent 按 startedAt 升序返回
 *   - errorMessage 写入到 error 字段
 *   - status 非法值降级到默认 'running'（ended 行如果 status 漂移）
 *   - JSON 行级 parse 失败兜底（坏行 silent skip）
 *   - path_traversal_detected：parentSessionDir 不在 safeRoot 子树内
 *   - maxRuns 限制（保留时序最新的 N 条）
 *
 * 测试策略：tmpdir 写真 subagents.jsonl，调 `listSubagentRunsForSession` pure
 * helper（不经 ipcMain，与 read-subagent-session.test.ts 同款风格）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { listSubagentRunsForSession } from '../subagent-index-reader'

const PARENT_SESSION_ID = 'parent-session-list-test'
const CHILD_A = '11111111-2222-3333-4444-555555555555'
const CHILD_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const CHILD_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

let workdir: string
let parentSessionDir: string
let safeRoot: string

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-list-subagent-'))
  safeRoot = path.join(workdir, 'platform-data')
  parentSessionDir = path.join(safeRoot, 'organizations', 'wt-1', 'spaces', 'sp-1', 'conversations', 'sessions')
  fs.mkdirSync(parentSessionDir, { recursive: true })
})

afterEach(() => {
  try {
    fs.rmSync(workdir, { recursive: true, force: true })
  } catch { /* cleanup best-effort */ }
})

function writeIndex(lines: Array<Record<string, unknown>>): void {
  const dir = path.join(parentSessionDir, PARENT_SESSION_ID)
  fs.mkdirSync(dir, { recursive: true })
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  fs.writeFileSync(path.join(dir, 'subagents.jsonl'), content, 'utf-8')
}

function makeStartLine(childId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 'started',
    parentSessionId: PARENT_SESSION_ID,
    subSessionId: `agent-${childId}`,
    childId,
    shortId: childId.slice(0, 4),
    parentToolCallId: 'agent:0',
    task: 'demo task',
    label: 'demo label',
    model: 'claude-test',
    createdAt: 1_000_000,
    createdAtISO: new Date(1_000_000).toISOString(),
    paths: {
      sessionDir: `subagents/agent-${childId}`,
      messagesPath: `subagents/agent-${childId}/messages.jsonl`,
      snapshotsPath: `subagents/agent-${childId}/snapshots.jsonl`,
      eventsPath: `subagents/agent-${childId}/events.jsonl`,
    },
    ...overrides,
  }
}

function makeEndLine(childId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 'ended',
    parentSessionId: PARENT_SESSION_ID,
    subSessionId: `agent-${childId}`,
    childId,
    status: 'completed',
    endedAt: 1_005_000,
    endedAtISO: new Date(1_005_000).toISOString(),
    finalTextLength: 100,
    durationMs: 5_000,
    ...overrides,
  }
}

describe('listSubagentRunsForSession', () => {
  it('subagents_index_missing — 父 session 从未派过子 Agent', async () => {
    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('subagents_index_missing')
  })

  it('path_traversal_detected — parentSessionDir 不在 safeRoot 子树内', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-outside-'))
    try {
      const result = await listSubagentRunsForSession({
        parentSessionDir: outsideDir,
        parentSessionId: PARENT_SESSION_ID,
        safeRoot,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('path_traversal_detected')
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('path_traversal_detected — 同前缀兄弟目录不能绕过 safeRoot', async () => {
    const siblingRoot = `${safeRoot}-evil`
    const siblingSessionDir = path.join(siblingRoot, 'organizations', 'wt-1', 'spaces', 'sp-1', 'conversations', 'sessions')
    fs.mkdirSync(siblingSessionDir, { recursive: true })
    const result = await listSubagentRunsForSession({
      parentSessionDir: siblingSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('path_traversal_detected')
  })

  it('只有 started 行 — status="running"（孤儿 run）', async () => {
    writeIndex([makeStartLine(CHILD_A)])
    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runs).toHaveLength(1)
    const run = result.runs[0]
    expect(run.subagentRunId).toBe(CHILD_A)
    expect(run.status).toBe('running')
    expect(run.parentToolCallId).toBe('agent:0')
    expect(run.task).toBe('demo task')
    expect(run.label).toBe('demo label')
    expect(run.model).toBe('claude-test')
    expect(run.startedAt).toBe(1_000_000)
    expect(run.endedAt).toBeUndefined()
  })

  it('started + ended 配对 — status 取 ended、含 endedAt / duration', async () => {
    writeIndex([
      makeStartLine(CHILD_A),
      makeEndLine(CHILD_A),
    ])
    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runs).toHaveLength(1)
    const run = result.runs[0]
    expect(run.subagentRunId).toBe(CHILD_A)
    expect(run.status).toBe('completed')
    expect(run.startedAt).toBe(1_000_000)
    expect(run.endedAt).toBe(1_005_000)
    expect(run.stats?.duration_ms).toBe(5_000)
  })

  it('failed + errorMessage — 写入到 error 字段', async () => {
    writeIndex([
      makeStartLine(CHILD_A),
      makeEndLine(CHILD_A, { status: 'failed', errorMessage: 'Permission denied' }),
    ])
    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const run = result.runs[0]
    expect(run.status).toBe('failed')
    expect(run.error).toBe('Permission denied')
  })

  it('cancelled — status="cancelled"', async () => {
    writeIndex([
      makeStartLine(CHILD_A),
      makeEndLine(CHILD_A, { status: 'cancelled' }),
    ])
    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runs[0].status).toBe('cancelled')
  })

  it('多个 run 按 startedAt 升序返回', async () => {
    writeIndex([
      makeStartLine(CHILD_B, { createdAt: 2_000_000 }),
      makeEndLine(CHILD_B, { endedAt: 2_003_000, durationMs: 3_000 }),
      makeStartLine(CHILD_A, { createdAt: 1_000_000 }),
      makeEndLine(CHILD_A, { endedAt: 1_005_000, durationMs: 5_000 }),
      makeStartLine(CHILD_C, { createdAt: 3_000_000 }),
      // C 只有 started，无 ended
    ])
    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runs.map(r => r.subagentRunId)).toEqual([CHILD_A, CHILD_B, CHILD_C])
    expect(result.runs[2].status).toBe('running')
  })

  it('W5-b resume 孤儿 — 最新 run 未结束不被上一 run 的 completed 污染', async () => {
    // run1: started(seq1) + ended(seq1, completed)；run2: started(seq2) 无 ended（孤儿）。
    // 旧版按 childId last-write-wins 会保留 run1 的 completed → 误判非孤儿；
    // 新版按 (subSessionId, max(runSeq)) 取 run2 → 如实 running。
    writeIndex([
      makeStartLine(CHILD_A, { runSeq: 1, createdAt: 1_000_000 }),
      makeEndLine(CHILD_A, { runSeq: 1, status: 'completed', endedAt: 1_005_000 }),
      makeStartLine(CHILD_A, { runSeq: 2, createdAt: 2_000_000 }),
    ])
    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 同 childId 折叠成一条，取最新 run（seq2）
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0].subagentRunId).toBe(CHILD_A)
    expect(result.runs[0].status).toBe('running')
    expect(result.runs[0].startedAt).toBe(2_000_000)
    expect(result.runs[0].endedAt).toBeUndefined()
  })

  it('W5-b resume 完成 — 取最新 run 的终态而非上一 run', async () => {
    writeIndex([
      makeStartLine(CHILD_A, { runSeq: 1, createdAt: 1_000_000 }),
      makeEndLine(CHILD_A, { runSeq: 1, status: 'failed', endedAt: 1_005_000, errorMessage: 'run1 失败' }),
      makeStartLine(CHILD_A, { runSeq: 2, createdAt: 2_000_000 }),
      makeEndLine(CHILD_A, { runSeq: 2, status: 'completed', endedAt: 2_008_000, durationMs: 8_000 }),
    ])
    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runs).toHaveLength(1)
    // 取最新 run（seq2）的终态 completed，而非 seq1 的 failed
    expect(result.runs[0].status).toBe('completed')
    expect(result.runs[0].endedAt).toBe(2_008_000)
    expect(result.runs[0].stats?.duration_ms).toBe(8_000)
    // childThreadId 仍从 started 行 paths.sessionDir 回填
    expect(result.runs[0].childThreadId).toBe(`subagents/agent-${CHILD_A}`)
  })

  it('坏 JSON 行 silent skip — 不影响剩余好行', async () => {
    const dir = path.join(parentSessionDir, PARENT_SESSION_ID)
    fs.mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify(makeStartLine(CHILD_A)),
      'this is not json {{{',
      JSON.stringify(makeEndLine(CHILD_A)),
    ]
    fs.writeFileSync(path.join(dir, 'subagents.jsonl'), lines.join('\n') + '\n', 'utf-8')

    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0].status).toBe('completed')
  })

  it('未知 status 值 — 降级为 running', async () => {
    writeIndex([
      makeStartLine(CHILD_A),
      makeEndLine(CHILD_A, { status: 'totally-bogus' as unknown as string }),
    ])
    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // W5-b：foldSubagentRuns 直接采信 ended.status（不校验），reader 的 normalizeStatus
    // 兜底把非法值降级为 'running'（最后已知态）——"非法 ended 不假装 completed"，
    // 不把脏 ended 误导成"completed"，也避免非法枚举值灌进 renderer。
    expect(result.runs[0].status).toBe('running')
  })

  it('maxRuns 限制 — 保留最近的 N 条', async () => {
    const entries: Array<Record<string, unknown>> = []
    for (let i = 0; i < 5; i++) {
      const childId = `${i.toString().padStart(8, '0')}-1111-2222-3333-444444444444`
      entries.push(makeStartLine(childId, { createdAt: 1_000_000 + i }))
      entries.push(makeEndLine(childId, { endedAt: 1_000_000 + i + 100, durationMs: 100 }))
    }
    writeIndex(entries)

    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
      maxRuns: 2,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runs).toHaveLength(2)
    // 升序，取尾 2 条 → i=3, i=4
    expect(result.runs[0].subagentRunId).toBe('00000003-1111-2222-3333-444444444444')
    expect(result.runs[1].subagentRunId).toBe('00000004-1111-2222-3333-444444444444')
  })

  it('childId 缺失行 — silent skip', async () => {
    const dir = path.join(parentSessionDir, PARENT_SESSION_ID)
    fs.mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify({ phase: 'started', task: 'no child id' }),
      JSON.stringify(makeStartLine(CHILD_A)),
      JSON.stringify(makeEndLine(CHILD_A)),
    ]
    fs.writeFileSync(path.join(dir, 'subagents.jsonl'), lines.join('\n') + '\n', 'utf-8')

    const result = await listSubagentRunsForSession({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0].subagentRunId).toBe(CHILD_A)
  })
})
