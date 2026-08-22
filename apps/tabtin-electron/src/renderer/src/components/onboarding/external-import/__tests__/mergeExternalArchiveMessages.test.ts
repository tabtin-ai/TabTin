import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  mergeHydratedArchiveWithLive,
  mergeTranscriptPreservingExternalArchive,
  preserveLiveRuntimeOnTranscriptMerge,
} from '../mergeExternalArchiveMessages'

function msg(partial: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return {
    content: partial.content ?? '',
    created_at: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as ChatMessage
}

describe('mergeTranscriptPreservingExternalArchive', () => {
  it('把 IDB 外来行/横幅/边界插回 transcript 之前', () => {
    const cached = [
      msg({
        id: 'ext-a1',
        role: 'assistant',
        content: '我是 WorkBuddy',
        metadata: { external_archive: true, source: 'workbuddy' },
      }),
      msg({
        id: 'ext-prefix-s1',
        role: 'system',
        content: '新任务 · 来自 WorkBuddy',
        metadata: { system_fact: 'external_archive_prefix', external_archive: true, source: 'workbuddy' },
      }),
      msg({
        id: 'ext-llm-boundary-s1',
        role: 'user',
        content: '<context type="external-archive">\nx\n</context>',
        message_kind: 'external_archive_context',
        metadata: { system_fact: 'external_archive_llm_boundary', external_archive: true },
      }),
      msg({ id: 'live-old', role: 'user', content: '旧 live' }),
    ]
    const local = [
      msg({ id: 'live-1', role: 'user', content: '验收探针' }),
      msg({ id: 'live-2', role: 'assistant', content: '我是小Tin' }),
    ]
    const merged = mergeTranscriptPreservingExternalArchive(local, cached)
    expect(merged.map((m) => m.id)).toEqual([
      'ext-a1',
      'ext-prefix-s1',
      'ext-llm-boundary-s1',
      'live-1',
      'live-2',
    ])
  })

  it('cache 无外来装饰时原样返回 local', () => {
    const local = [msg({ id: 'u1', role: 'user', content: 'hi' })]
    const cached = [msg({ id: 'u0', role: 'user', content: 'old' })]
    expect(mergeTranscriptPreservingExternalArchive(local, cached)).toEqual(local)
  })
})

describe('preserveLiveRuntimeOnTranscriptMerge ', () => {
  const liveBlocks = [
    {
      index: 1,
      block_id: 'blk-1',
      block: { type: 'text', text: '# 标题\n\n完整流式前缀…' },
      finalized: false,
    },
  ] as NonNullable<ChatMessage['blocks']>

  it('同 id 时保留 live blocks，避免 transcript 覆盖抹掉流式正文', () => {
    const transcript = [
      msg({ id: 'u1', role: 'user', content: '写长文' }),
      msg({ id: 'a1', role: 'assistant', content: 'transcript-shell' }),
    ]
    const liveCache = [
      msg({ id: 'u1', role: 'user', content: '写长文' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: 'live-content-much-longer-than-transcript-shell',
        blocks: liveBlocks,
      }),
    ]
    const merged = preserveLiveRuntimeOnTranscriptMerge(transcript, liveCache)
    const assistant = merged.find((m) => m.id === 'a1')
    expect(assistant?.blocks).toEqual(liveBlocks)
    expect((assistant?.blocks?.[0]?.block as { text?: string })?.text).toContain('完整流式前缀')
    // 只保 blocks，不动壳 content（避免长度启发误选）
    expect(assistant?.content).toBe('transcript-shell')
  })

  it('追加 transcript 尚无、仅存在于 live 的流式消息行', () => {
    const transcript = [msg({ id: 'u1', role: 'user', content: '写长文' })]
    const liveCache = [
      msg({ id: 'u1', role: 'user', content: '写长文' }),
      msg({ id: 'a-live', role: 'assistant', content: '', blocks: liveBlocks }),
    ]
    const merged = preserveLiveRuntimeOnTranscriptMerge(transcript, liveCache)
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a-live'])
    expect(merged[1]?.blocks).toEqual(liveBlocks)
  })

  it('与 mergeTranscriptPreservingExternalArchive 串联：无装饰时也不丢 live', () => {
    const local = [
      msg({ id: 'u1', role: 'user', content: 'hi' }),
      msg({ id: 'a1', role: 'assistant', content: 'half' }),
    ]
    const cached = [
      msg({ id: 'u1', role: 'user', content: 'hi' }),
      msg({ id: 'a1', role: 'assistant', content: '', blocks: liveBlocks }),
    ]
    const base = mergeTranscriptPreservingExternalArchive(local, cached)
    expect(base.find((m) => m.id === 'a1')?.blocks).toBeUndefined()
    const merged = preserveLiveRuntimeOnTranscriptMerge(base, cached)
    expect(merged.find((m) => m.id === 'a1')?.blocks).toEqual(liveBlocks)
  })
})

describe('mergeHydratedArchiveWithLive', () => {
  it('档案段在前，live 去重接后', () => {
    const hydrated = [
      msg({
        id: 'ext-a1',
        role: 'assistant',
        content: '外来',
        metadata: { external_archive: true },
      }),
      msg({
        id: 'ext-prefix-s1',
        role: 'system',
        content: '横幅',
        metadata: { system_fact: 'external_archive_prefix', external_archive: true },
      }),
    ]
    const existing = [
      msg({
        id: 'ext-a1',
        role: 'assistant',
        content: 'stale',
        metadata: { external_archive: true },
      }),
      msg({ id: 'live-1', role: 'user', content: '探针' }),
    ]
    const merged = mergeHydratedArchiveWithLive(hydrated, existing)
    expect(merged.map((m) => m.id)).toEqual(['ext-a1', 'ext-prefix-s1', 'live-1'])
    expect(merged[0]?.content).toBe('外来')
  })
})
