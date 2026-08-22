import { beforeEach, describe, expect, it } from 'vitest'
import { useTabDocRevealStore } from './useTabDocRevealStore'

beforeEach(() => {
  useTabDocRevealStore.setState({ pendingRevealByDocId: {} })
})

describe('useTabDocRevealStore', () => {
  it('设置并一次性消费文档选区 reveal', () => {
    useTabDocRevealStore.getState().setPendingReveal('doc-1', {
      kind: 'doc_selection',
      blockIds: [' block-1 ', ''],
      fullText: ' 第一段 ',
    })

    const pending = useTabDocRevealStore.getState().pendingRevealByDocId['doc-1']
    expect(pending).toMatchObject({
      kind: 'doc_selection',
      blockIds: ['block-1'],
      fullText: '第一段',
    })
    expect(pending.requestId).toBeGreaterThan(0)

    const consumed = useTabDocRevealStore.getState().consumePendingReveal('doc-1')
    expect(consumed).toEqual(pending)
    expect(useTabDocRevealStore.getState().pendingRevealByDocId['doc-1']).toBeUndefined()
    expect(useTabDocRevealStore.getState().consumePendingReveal('doc-1')).toBeNull()
  })

  it('同一文档重复设置会更新 requestId，便于 keepAlive tab 重新消费', () => {
    useTabDocRevealStore.getState().setPendingReveal('doc-1', {
      kind: 'doc_selection',
      blockIds: ['block-1'],
    })
    const first = useTabDocRevealStore.getState().pendingRevealByDocId['doc-1']

    useTabDocRevealStore.getState().setPendingReveal('doc-1', {
      kind: 'doc_selection',
      blockIds: ['block-2'],
    })
    const second = useTabDocRevealStore.getState().pendingRevealByDocId['doc-1']

    expect(second.blockIds).toEqual(['block-2'])
    expect(second.requestId).toBeGreaterThan(first.requestId)
  })

  it('按 requestId 消费时不会清掉更新后的 reveal', () => {
    useTabDocRevealStore.getState().setPendingReveal('doc-1', {
      kind: 'doc_selection',
      blockIds: ['block-1'],
    })
    const first = useTabDocRevealStore.getState().pendingRevealByDocId['doc-1']

    useTabDocRevealStore.getState().setPendingReveal('doc-1', {
      kind: 'doc_selection',
      blockIds: ['block-2'],
    })

    expect(useTabDocRevealStore.getState().consumePendingReveal('doc-1', first.requestId)).toBeNull()
    expect(useTabDocRevealStore.getState().pendingRevealByDocId['doc-1'].blockIds).toEqual(['block-2'])
  })

  it('缺少 docId 和可定位字段时不写入 pending reveal', () => {
    useTabDocRevealStore.getState().setPendingReveal('', {
      kind: 'doc_selection',
      blockIds: ['block-1'],
    })
    useTabDocRevealStore.getState().setPendingReveal('doc-1', {
      kind: 'doc_selection',
    })

    expect(useTabDocRevealStore.getState().pendingRevealByDocId).toEqual({})
  })
})
