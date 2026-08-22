/**
 * W3.3 D-5 §5 · main 守护测试：conversation:summary-export bucket。
 *
 * 守住：
 *   1. registerConversationSummaryExportBucket 后 bucket 字段符合 D-5 §5
 *   2. conversationsRoot 不存在时 exportFn 仍产出合法 JSON（conversations: []）
 *   3. 真实有 messages.jsonl 时能解析 firstMessageTime / lastMessageTime + 不含消息正文
 *   4. filename 含 ISO timestamp
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const TEST_ROOT = path.join(os.tmpdir(), '__tabtin_conversations_w33_test__')

vi.mock('@tabtin/shared', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/shared')>('@tabtin/shared')
  return {
    ...actual,
    getPlatformDataRoot: vi.fn(() => TEST_ROOT),
  }
})

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

async function setupConversation(
  organizationId: string,
  spaceId: string,
  sessionId: string,
  lines: object[],
): Promise<void> {
  // 2026-05-04 platform-data 布局：`{platformData}/{wt}/spaces/{sp}/conversations/sessions/{sid}/`
  const sessionDir = path.join(
    TEST_ROOT,
    organizationId,
    'spaces',
    spaceId,
    'conversations',
    'sessions',
    sessionId,
  )
  await fsp.mkdir(sessionDir, { recursive: true })
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  await fsp.writeFile(path.join(sessionDir, 'messages.jsonl'), content)
}

describe('ConversationSummaryExport · conversation:summary-export', () => {
  beforeEach(async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
    if (fs.existsSync(TEST_ROOT)) {
      await fsp.rm(TEST_ROOT, { recursive: true, force: true })
    }
  })

  afterEach(async () => {
    if (fs.existsSync(TEST_ROOT)) {
      await fsp.rm(TEST_ROOT, { recursive: true, force: true })
    }
  })

  it('注册的 bucket 字段符合 D-5 §5 规范', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerConversationSummaryExportBucket } = await import(
      '../ConversationSummaryExport'
    )

    registerConversationSummaryExportBucket()
    const bucket = sm.getBucket('conversation:summary-export')
    expect(bucket).toBeDefined()
    expect(bucket?.category).toBe('data')
    expect(bucket?.group).toBe('conversation')
    expect(bucket?.requiresConfirmation).toBe('hard')
    expect(bucket?.hideFromList).toBe(true)
    expect(typeof bucket?.exportFn).toBe('function')
  })

  it('conversationsRoot 不存在时产出空 conversations 数组', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerConversationSummaryExportBucket } = await import(
      '../ConversationSummaryExport'
    )

    registerConversationSummaryExportBucket()
    const bucket = sm.getBucket('conversation:summary-export')!
    const exp = await bucket.exportFn!()

    expect(exp.mimeType).toBe('application/json')
    expect(exp.filename).toMatch(
      /^tabtin-conversation-summary-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z\.json$/,
    )
    const parsed = JSON.parse(exp.data as string)
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      source: 'tabtin-electron',
      bucketId: 'conversation:summary-export',
      totalSpaces: 0,
      totalSessions: 0,
    })
    expect(parsed.conversations).toHaveLength(0)
  })

  it('messages.jsonl 真实存在时解析首/末时间戳 + 不含消息正文', async () => {
    await setupConversation('wt-A', 'sp-A', 'sess-1', [
      { id: 'm1', role: 'user', content: 'PRIVATE_HELLO_WORLD', created_at: '2026-05-01T10:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'PRIVATE_REPLY', created_at: '2026-05-01T10:05:00Z' },
      { id: 'm3', role: 'user', content: 'PRIVATE_FOLLOWUP', created_at: '2026-05-01T11:00:00Z' },
    ])

    const sm = await import('@tabtin/storage-manager')
    const { registerConversationSummaryExportBucket } = await import(
      '../ConversationSummaryExport'
    )
    registerConversationSummaryExportBucket()
    const bucket = sm.getBucket('conversation:summary-export')!
    const exp = await bucket.exportFn!()

    const parsed = JSON.parse(exp.data as string)
    expect(parsed.totalSessions).toBe(1)
    expect(parsed.totalSpaces).toBe(1)
    expect(parsed.conversations).toHaveLength(1)

    const space = parsed.conversations[0]
    expect(space).toMatchObject({ organizationId: 'wt-A', spaceId: 'sp-A', sessionCount: 1 })

    const session = space.sessions[0]
    expect(session.sessionId).toBe('sess-1')
    expect(session.fileSizeBytes).toBeGreaterThan(0)
    expect(session.firstMessageTime).toBe('2026-05-01T10:00:00Z')
    expect(session.lastMessageTime).toBe('2026-05-01T11:00:00Z')
    // 小文件（< 64KB 头部窗口）的 messageCount 是精确值，isEstimated=false
    expect(session.messageCountIsEstimated).toBe(false)
    expect(session.messageCount).toBe(3)
    expect(parsed.totalMessagesIsEstimated).toBe(false)

    // ⚠️ 关键守护：消息正文不能出现在导出文件中
    expect(exp.data).not.toContain('PRIVATE_HELLO_WORLD')
    expect(exp.data).not.toContain('PRIVATE_REPLY')
    expect(exp.data).not.toContain('PRIVATE_FOLLOWUP')
  })
})
