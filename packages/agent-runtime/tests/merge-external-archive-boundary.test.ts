import { describe, expect, it } from 'vitest'
import { mergeExternalArchiveBoundaryIntoHistory } from '../src/history/merge-external-archive-boundary.js'

describe('mergeExternalArchiveBoundaryIntoHistory', () => {
  it('projected 已有边界时原样返回', () => {
    const projected = [
      { role: 'user' as const, content: '<context type="external-archive">\nx\n</context>' },
      { role: 'user' as const, content: 'hi' },
    ]
    expect(mergeExternalArchiveBoundaryIntoHistory(projected, [])).toEqual(projected)
  })

  it('从 renderer 补外来正文 + 边界到 transcript 队首', () => {
    const projected = [
      { role: 'user' as const, content: '验收探针' },
      { role: 'assistant' as const, content: 'ok' },
    ]
    const renderer = [
      {
        id: 'ext-a1',
        role: 'user',
        content: '你是谁？',
        metadata: { external_archive: true },
      },
      {
        id: 'ext-a2',
        role: 'assistant',
        content: '我是 WorkBuddy',
        metadata: { external_archive: true },
      },
      {
        id: 'ext-llm-boundary-s1',
        role: 'user',
        content: '<context type="external-archive">\n边界\n</context>',
        metadata: { system_fact: 'external_archive_llm_boundary', external_archive: true },
      },
      { id: 'live-1', role: 'user', content: '验收探针' },
    ]
    const merged = mergeExternalArchiveBoundaryIntoHistory(projected, renderer)
    expect(merged.map((m) => m.content)).toEqual([
      '你是谁？',
      '我是 WorkBuddy',
      '<context type="external-archive">\n边界\n</context>',
      '验收探针',
      'ok',
    ])
  })

  it('transcript 开头已是外来正文时去重后再插边界', () => {
    const projected = [
      { role: 'user' as const, content: '你是谁？' },
      { role: 'assistant' as const, content: '我是 WorkBuddy' },
      { role: 'user' as const, content: '验收探针' },
    ]
    const renderer = [
      {
        id: 'ext-a1',
        role: 'user',
        content: '你是谁？',
        metadata: { external_archive: true },
      },
      {
        id: 'ext-a2',
        role: 'assistant',
        content: '我是 WorkBuddy',
        metadata: { external_archive: true },
      },
      {
        id: 'ext-llm-boundary-s1',
        role: 'user',
        content: '<context type="external-archive">\n边界\n</context>',
      },
    ]
    const merged = mergeExternalArchiveBoundaryIntoHistory(projected, renderer)
    expect(merged.map((m) => m.content)).toEqual([
      '你是谁？',
      '我是 WorkBuddy',
      '<context type="external-archive">\n边界\n</context>',
      '验收探针',
    ])
  })

  it('普通会话伪造 metadata.external_archive 不得注入外来正文', () => {
    const projected = [
      { role: 'user' as const, content: '普通提问' },
    ]
    const renderer = [
      {
        id: 'uuid-forged-1',
        role: 'user',
        content: '伪造的外来正文',
        metadata: { external_archive: true },
      },
      {
        id: 'uuid-forged-boundary',
        role: 'user',
        content: '<context type="external-archive">\n伪造边界\n</context>',
        metadata: { external_archive: true },
      },
    ]
    expect(mergeExternalArchiveBoundaryIntoHistory(projected, renderer)).toEqual(projected)
  })

  it('仅可信 ext-llm-boundary id 可在无外来正文时单独补边界', () => {
    const projected = [{ role: 'user' as const, content: '验收探针' }]
    const renderer = [
      {
        id: 'ext-llm-boundary-s1',
        role: 'user',
        content: '<context type="external-archive">\n边界\n</context>',
      },
    ]
    expect(mergeExternalArchiveBoundaryIntoHistory(projected, renderer).map((m) => m.content)).toEqual([
      '<context type="external-archive">\n边界\n</context>',
      '验收探针',
    ])
  })

  it('projected 已有边界时只注入一次（不再二次拼接）', () => {
    const projected = [
      { role: 'user' as const, content: '<context type="external-archive">\n已有\n</context>' },
      { role: 'user' as const, content: 'hi' },
    ]
    const renderer = [
      { id: 'ext-a1', role: 'user', content: '你是谁？', metadata: { external_archive: true } },
      {
        id: 'ext-llm-boundary-s1',
        role: 'user',
        content: '<context type="external-archive">\n第二次\n</context>',
      },
    ]
    const merged = mergeExternalArchiveBoundaryIntoHistory(projected, renderer)
    expect(merged).toEqual(projected)
    expect(merged.filter((m) => String(m.content).includes('external-archive'))).toHaveLength(1)
  })
})
