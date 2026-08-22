import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStorage } from '@tabtin/agent-runtime'
import { buildReplayHistoryFromTranscript } from '@tabtin/agent-runtime/history'
import { seedExternalArchiveIntoSessionStorage } from '../seed-external-archive-transcript'

const meta = {
  source: 'workbuddy',
  sourceSessionId: 'sess-1',
  title: '电影讨论',
  cwd: '/tmp/wb',
}

const archiveMessages = [
  {
    id: 'm1',
    role: 'user' as const,
    content_blocks: [{ type: 'text', text: '推荐一部电影' }],
  },
  {
    id: 'm2',
    role: 'assistant' as const,
    content_blocks: [{ type: 'text', text: '《盗梦空间》' }],
  },
]

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-archive-seed-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('seedExternalArchiveIntoSessionStorage', () => {
  it('空 transcript 写入导入正文与边界，重放后 LLM history 可见', async () => {
    const storage = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-1' })
    const result = await seedExternalArchiveIntoSessionStorage(
      storage,
      meta,
      archiveMessages,
    )
    expect(result).toBe('seeded')

    const restored = await storage.restoreMessages()
    expect(restored.length).toBeGreaterThanOrEqual(3)
    const replay = buildReplayHistoryFromTranscript(restored)
    const texts = replay.map((m) => (
      typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content)
    ))
    expect(texts.some((t) => t.includes('推荐一部电影'))).toBe(true)
    expect(texts.some((t) => t.includes('盗梦空间'))).toBe(true)
    expect(texts.some((t) => t.includes('type="external-archive"'))).toBe(true)
    await storage.dispose()
  })

  it('已有内容时不重复写入', async () => {
    const storage = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-2' })
    await seedExternalArchiveIntoSessionStorage(storage, meta, archiveMessages)
    const again = await seedExternalArchiveIntoSessionStorage(
      storage,
      meta,
      archiveMessages,
    )
    expect(again).toBe('already_present')
    await storage.dispose()
  })

  it('已有 live 轮时不把导入正文追加到队尾', async () => {
    const storage = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-3' })
    await storage.recordUserMessage({ role: 'user', content: '帮我做一个这部电影的介绍ppt' })
    const result = await seedExternalArchiveIntoSessionStorage(
      storage,
      meta,
      archiveMessages,
    )
    expect(result).toBe('already_present')
    const restored = await storage.restoreMessages()
    const replay = buildReplayHistoryFromTranscript(restored)
    const texts = replay.map((m) => (
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ))
    expect(texts.some((t) => t.includes('盗梦空间'))).toBe(false)
    await storage.dispose()
  })

  it('仅有 environment_context 残留时仍写入导入正文', async () => {
    const storage = new SessionStorage({ sessionDir: tmpDir, threadId: 'chat-4' })
    await storage.recordSystemMessage(
      { role: 'user', content: '<context type="environment">cwd=/tmp</context>' },
      { messageKind: 'environment_context' },
    )
    await storage.ensureBlockBackfillFromTranscript()
    const result = await seedExternalArchiveIntoSessionStorage(
      storage,
      meta,
      archiveMessages,
    )
    expect(result).toBe('seeded')
    const replay = buildReplayHistoryFromTranscript(await storage.restoreMessages())
    const texts = replay.map((m) => (
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ))
    expect(texts.some((t) => t.includes('盗梦空间'))).toBe(true)
    await storage.dispose()
  })
})
