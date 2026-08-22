/**
 * read-subagent-session.test.ts — W2 子 session 三件套读取（IPC handler 核心）回归
 *
 * 测什么：
 *   - subagents.jsonl 索引解析（按 childId / subSessionId 匹配 started 行）
 *   - 三种 kind（messages / snapshots / events）的路径拼接 + 文件读取
 *   - 安全防御：UUID 校验、kind 校验、path traversal、parentSession 缺索引
 *   - 容量保护：超 maxLines 时返回 truncated:true
 *   - JSON 行级 parse 失败兜底（保留 raw 字符串）
 *
 * 测试策略：跑真实 tmpdir，写真 subagents.jsonl + 子三件套文件，调
 * `readSubagentSessionFile` pure helper（不经过 ipcMain）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  readSubagentSessionFile,
  SUBAGENT_RUN_ID_REGEX,
  DEFAULT_MAX_LINES,
} from '../subagent-session-reader'

const PARENT_SESSION_ID = 'parent-session-w2-test'
const VALID_CHILD_ID = '11111111-2222-3333-4444-555555555555'
const ANOTHER_CHILD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

let workdir: string
let parentSessionDir: string
let safeRoot: string

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-w2-test-'))
  safeRoot = path.join(workdir, 'platform-data')
  parentSessionDir = path.join(safeRoot, 'organizations', 'wt-1', 'spaces', 'sp-1', 'conversations', 'sessions')
  fs.mkdirSync(parentSessionDir, { recursive: true })
})

afterEach(() => {
  try {
    fs.rmSync(workdir, { recursive: true, force: true })
  } catch {
    /* 测试环境 cleanup，失败不阻塞 */
  }
})

/** 在 parent session 目录里写一份 subagents.jsonl + 子三件套文件。 */
function writeSubagentFixture(opts: {
  childId: string
  messageBlockLines?: string[]
  messagesLines?: string[]
  snapshotsLines?: string[]
  eventsLines?: string[]
  /** 覆盖 paths.messagesPath / snapshotsPath / eventsPath（test path traversal 用）。 */
  pathsOverride?: Partial<{
    sessionDir: string
    messageBlocksPath: string
    messagesPath: string
    snapshotsPath: string
    eventsPath: string
  }>
}): void {
  const sessionAbsDir = path.join(parentSessionDir, PARENT_SESSION_ID)
  const childThreadId = `agent-${opts.childId}`
  const childDir = path.join(sessionAbsDir, 'subagents', childThreadId)
  fs.mkdirSync(childDir, { recursive: true })

  if (opts.messageBlockLines) {
    fs.writeFileSync(path.join(childDir, 'message-blocks.jsonl'), opts.messageBlockLines.join('\n') + '\n', 'utf-8')
  }
  if (opts.messagesLines) {
    fs.writeFileSync(path.join(childDir, 'messages.jsonl'), opts.messagesLines.join('\n') + '\n', 'utf-8')
  }
  if (opts.snapshotsLines) {
    fs.writeFileSync(path.join(childDir, 'snapshots.jsonl'), opts.snapshotsLines.join('\n') + '\n', 'utf-8')
  }
  if (opts.eventsLines) {
    fs.writeFileSync(path.join(childDir, 'events.jsonl'), opts.eventsLines.join('\n') + '\n', 'utf-8')
  }

  const indexEntry = {
    phase: 'started' as const,
    parentSessionId: PARENT_SESSION_ID,
    subSessionId: childThreadId,
    childId: opts.childId,
    shortId: opts.childId.slice(0, 4),
    task: 'test task',
    model: 'test-model',
    createdAt: Date.now(),
    createdAtISO: new Date().toISOString(),
    paths: {
      sessionDir: opts.pathsOverride?.sessionDir ?? path.join('subagents', childThreadId),
      ...(
        opts.messageBlockLines || opts.pathsOverride?.messageBlocksPath
          ? { messageBlocksPath: opts.pathsOverride?.messageBlocksPath ?? path.join('subagents', childThreadId, 'message-blocks.jsonl') }
          : {}
      ),
      messagesPath: opts.pathsOverride?.messagesPath ?? path.join('subagents', childThreadId, 'messages.jsonl'),
      snapshotsPath: opts.pathsOverride?.snapshotsPath ?? path.join('subagents', childThreadId, 'snapshots.jsonl'),
      eventsPath: opts.pathsOverride?.eventsPath ?? path.join('subagents', childThreadId, 'events.jsonl'),
    },
  }
  fs.writeFileSync(
    path.join(sessionAbsDir, 'subagents.jsonl'),
    JSON.stringify(indexEntry) + '\n',
    'utf-8',
  )
}

describe('SUBAGENT_RUN_ID_REGEX', () => {
  it('接受 UUID 36 字符 hex-dash 形态', () => {
    expect(SUBAGENT_RUN_ID_REGEX.test(VALID_CHILD_ID)).toBe(true)
    expect(SUBAGENT_RUN_ID_REGEX.test(ANOTHER_CHILD_ID)).toBe(true)
  })
  it('拒绝 path-traversal / 非 UUID 字符', () => {
    expect(SUBAGENT_RUN_ID_REGEX.test('../../../etc/passwd')).toBe(false)
    expect(SUBAGENT_RUN_ID_REGEX.test('agent-' + VALID_CHILD_ID)).toBe(false) // 带前缀拒绝
    expect(SUBAGENT_RUN_ID_REGEX.test('not-a-uuid')).toBe(false)
    expect(SUBAGENT_RUN_ID_REGEX.test('')).toBe(false)
  })
})

describe('readSubagentSessionFile - 路径解析（happy path）', () => {
  it('优先读取 message-blocks.jsonl 并返回结构化 transcript', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messageBlockLines: [
        JSON.stringify({
          message_id: 'assistant-1',
          role: 'assistant',
          blocks_json: [{ type: 'text', text: 'new authority' }],
          recorded_at: '2026-08-15T00:00:00.000Z',
        }),
      ],
      messagesLines: [
        JSON.stringify({ type: 'legacy', payload: { content: 'legacy' } }),
      ],
    })

    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })

    expect(result).toMatchObject({
      ok: true,
      format: 'transcript',
      lines: [{
        role: 'assistant',
        messageId: 'assistant-1',
        blocks: [{ type: 'text', text: 'new authority' }],
      }],
    })
  })

  it('能读 messages.jsonl（按 childId 匹配索引）', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: [
        JSON.stringify({ type: 'transcript', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({ type: 'transcript', message: { role: 'assistant', content: 'hi' } }),
      ],
    })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.format).toBe('envelopes')
    expect(result.lines).toHaveLength(2)
    expect((result.lines[0] as { message: { role: string } }).message.role).toBe('user')
  })

  it('新权威文件尚未生成时兼容读取旧 messages.jsonl', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: [JSON.stringify({ type: 'legacy-message' })],
      pathsOverride: {
        messageBlocksPath: path.join(
          'subagents',
          `agent-${VALID_CHILD_ID}`,
          'message-blocks.jsonl',
        ),
      },
    })

    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })

    expect(result).toMatchObject({
      ok: true,
      format: 'envelopes',
      lines: [{ type: 'legacy-message' }],
    })
  })

  it('能读 snapshots.jsonl', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      snapshotsLines: [
        JSON.stringify({ system: 'sys-prompt', messages: [1, 2, 3], tools: ['a', 'b'] }),
      ],
    })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'snapshots',
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(1)
  })

  it('能读 events.jsonl', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      eventsLines: [
        JSON.stringify({ type: 'lifecycle.start', ts: 1700000000000 }),
        JSON.stringify({ type: 'tool.start', ts: 1700000001000, payload: { name: 'read_file' } }),
      ],
    })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'events',
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(2)
  })

  it('多 entry 索引中按 childId 命中正确条目', async () => {
    // 先写第一个子 Agent
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: [JSON.stringify({ tag: 'first' })],
    })
    // 再 append 第二个子 Agent 索引（同一个 subagents.jsonl）
    const sessionAbsDir = path.join(parentSessionDir, PARENT_SESSION_ID)
    const secondChildDir = path.join(sessionAbsDir, 'subagents', `agent-${ANOTHER_CHILD_ID}`)
    fs.mkdirSync(secondChildDir, { recursive: true })
    fs.writeFileSync(
      path.join(secondChildDir, 'messages.jsonl'),
      JSON.stringify({ tag: 'second' }) + '\n',
      'utf-8',
    )
    fs.appendFileSync(
      path.join(sessionAbsDir, 'subagents.jsonl'),
      JSON.stringify({
        phase: 'started',
        parentSessionId: PARENT_SESSION_ID,
        subSessionId: `agent-${ANOTHER_CHILD_ID}`,
        childId: ANOTHER_CHILD_ID,
        shortId: ANOTHER_CHILD_ID.slice(0, 4),
        task: 'second task',
        model: 'test-model',
        createdAt: Date.now(),
        createdAtISO: new Date().toISOString(),
        paths: {
          sessionDir: path.join('subagents', `agent-${ANOTHER_CHILD_ID}`),
          messagesPath: path.join('subagents', `agent-${ANOTHER_CHILD_ID}`, 'messages.jsonl'),
          snapshotsPath: path.join('subagents', `agent-${ANOTHER_CHILD_ID}`, 'snapshots.jsonl'),
          eventsPath: path.join('subagents', `agent-${ANOTHER_CHILD_ID}`, 'events.jsonl'),
        },
      }) + '\n',
      'utf-8',
    )

    const second = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: ANOTHER_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.lines).toHaveLength(1)
    expect((second.lines[0] as { tag: string }).tag).toBe('second')
  })

  it('索引含 ended 行不影响 started 行命中', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: [JSON.stringify({ ok: true })],
    })
    const sessionAbsDir = path.join(parentSessionDir, PARENT_SESSION_ID)
    fs.appendFileSync(
      path.join(sessionAbsDir, 'subagents.jsonl'),
      JSON.stringify({
        phase: 'ended',
        parentSessionId: PARENT_SESSION_ID,
        subSessionId: `agent-${VALID_CHILD_ID}`,
        childId: VALID_CHILD_ID,
        status: 'completed',
        endedAt: Date.now(),
        endedAtISO: new Date().toISOString(),
        finalTextLength: 0,
        durationMs: 100,
      }) + '\n',
      'utf-8',
    )
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result.ok).toBe(true)
  })
})

describe('readSubagentSessionFile - 失败枚举', () => {
  it('UUID 校验失败：path traversal 尝试返回 invalid_subagent_run_id', async () => {
    writeSubagentFixture({ childId: VALID_CHILD_ID, messagesLines: ['{}'] })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: '../../../etc/passwd',
      kind: 'messages',
      safeRoot,
    })
    expect(result).toEqual({ ok: false, error: 'invalid_subagent_run_id' })
  })

  it('UUID 校验失败：空字符串', async () => {
    writeSubagentFixture({ childId: VALID_CHILD_ID, messagesLines: ['{}'] })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: '',
      kind: 'messages',
      safeRoot,
    })
    expect(result).toEqual({ ok: false, error: 'invalid_subagent_run_id' })
  })

  it('kind 校验失败', async () => {
    writeSubagentFixture({ childId: VALID_CHILD_ID, messagesLines: ['{}'] })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kind: 'evil' as any,
      safeRoot,
    })
    expect(result).toEqual({ ok: false, error: 'invalid_kind' })
  })

  it('subagents.jsonl 不存在 → subagents_index_missing', async () => {
    // 不写 fixture，session 目录都没创建
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result).toEqual({ ok: false, error: 'subagents_index_missing' })
  })

  it('索引中没匹配 childId → subagent_not_found', async () => {
    writeSubagentFixture({ childId: ANOTHER_CHILD_ID, messagesLines: ['{}'] })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result).toEqual({ ok: false, error: 'subagent_not_found' })
  })

  it('文件存在但 kind 对应路径缺失 → file_missing', async () => {
    // 只写 messages.jsonl，不写 events.jsonl
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: ['{}'],
    })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'events',
      safeRoot,
    })
    expect(result).toEqual({ ok: false, error: 'file_missing' })
  })

  it('path traversal 尝试（索引 paths.messagesPath 含 ../）被 startsWith 校验拦截', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: ['{}'],
      pathsOverride: {
        messagesPath: '../../../../../../../../etc/passwd',
      },
    })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result).toEqual({ ok: false, error: 'path_traversal_detected' })
  })

  it('索引 paths.messageBlocksPath 含 path traversal 时拒绝读取', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: [JSON.stringify({ type: 'legacy-message' })],
      pathsOverride: {
        messageBlocksPath: '../../../../../../../../etc/passwd',
      },
    })

    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })

    expect(result).toEqual({ ok: false, error: 'path_traversal_detected' })
  })

  it('索引 entry 缺 paths.messagesPath → paths_missing_in_index', async () => {
    const sessionAbsDir = path.join(parentSessionDir, PARENT_SESSION_ID)
    fs.mkdirSync(sessionAbsDir, { recursive: true })
    // 手写一个缺 paths 的 entry
    fs.writeFileSync(
      path.join(sessionAbsDir, 'subagents.jsonl'),
      JSON.stringify({
        phase: 'started',
        parentSessionId: PARENT_SESSION_ID,
        subSessionId: `agent-${VALID_CHILD_ID}`,
        childId: VALID_CHILD_ID,
        shortId: VALID_CHILD_ID.slice(0, 4),
        task: 'no paths',
        model: 'test',
        createdAt: Date.now(),
        createdAtISO: new Date().toISOString(),
        // paths 缺失
      }) + '\n',
      'utf-8',
    )
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result).toEqual({ ok: false, error: 'paths_missing_in_index' })
  })
})

describe('readSubagentSessionFile - 容量保护', () => {
  it('超 maxLines 返回 truncated:true 并截断到上限', async () => {
    const lines: string[] = []
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({ idx: i }))
    }
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: lines,
    })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
      maxLines: 10,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(10)
    expect(result.truncated).toBe(true)
  })

  it('未超 maxLines 不带 truncated 字段', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: [JSON.stringify({ a: 1 }), JSON.stringify({ a: 2 })],
    })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(2)
    expect(result.truncated).toBeUndefined()
  })

  it('DEFAULT_MAX_LINES = 5000', () => {
    expect(DEFAULT_MAX_LINES).toBe(5000)
  })
})

describe('readSubagentSessionFile - 行级 JSON parse 兜底', () => {
  it('损坏的 JSON 行保留为 { __raw__: line }（不丢数据）', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: [
        JSON.stringify({ ok: true }),
        'NOT_VALID_JSON{{{',
        JSON.stringify({ ok: false }),
      ],
    })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(3)
    expect((result.lines[1] as { __raw__: string }).__raw__).toBe('NOT_VALID_JSON{{{')
  })
})

/**
 * P0-D（2026-05-27）：放宽 parent_session_not_alive 门禁回归
 *
 * 验证 reader 本身——已经设计成"接受 parentSessionDir 直接读盘"，所以这里跑一遍
 * 完整路径解析，证明：renderer 只要能拿到 organizationId / spaceId，从 fresh tmpdir
 * 走 `resolveSpaceSessionArchiveDir`（已在 IPC handler 内调用）即可读到历史
 * session 的子 Agent 数据，不依赖 host.sessions Map。
 */
describe('readSubagentSessionFile - 归档读盘（不要求 live session）', () => {
  it('历史 session 目录：写完 fixture 后直接读盘成功（模拟 P0-D 放宽场景）', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: [
        JSON.stringify({ type: 'agent.stream.message_start', payload: { role: 'user' } }),
      ],
    })
    // 注意：本测试不构造任何 live host.sessions Map；只验证 reader 接受归档目录
    // 直接读盘——这是 P0-D IPC handler 放宽门禁后的核心使用场景：
    // renderer 传 organizationId/spaceId → 主进程 resolveSpaceSessionArchiveDir
    // → 喂给 readSubagentSessionFile（即本测试覆盖的 happy path）。
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines).toHaveLength(1)
  })

  it('safeRoot 校验在归档场景下仍生效（path traversal 防御不松）', async () => {
    writeSubagentFixture({
      childId: VALID_CHILD_ID,
      messagesLines: ['{}'],
      pathsOverride: {
        // 模拟索引被篡改：相对路径含足够 ../ 穿出 safeRoot
        // 父 session 目录在 safeRoot/organizations/wt/spaces/sp/conversations/sessions/<sid>，
        // 要爬出 safeRoot 需 ≥ 7 个 ../
        messagesPath: '../../../../../../../../etc/passwd',
      },
    })
    const result = await readSubagentSessionFile({
      parentSessionDir,
      parentSessionId: PARENT_SESSION_ID,
      subagentRunId: VALID_CHILD_ID,
      kind: 'messages',
      safeRoot,
    })
    expect(result).toEqual({ ok: false, error: 'path_traversal_detected' })
  })
})
