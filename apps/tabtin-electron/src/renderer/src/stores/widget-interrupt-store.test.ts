/**
 * useChatRuntimeStore.markStreamingWidgetsInterruptedAndClearOthers 单元测试
 * （Widget Wave 3，widget RFC §五 3.6）
 *
 * 守住 Wave 3 cancel/error/terminated 时 widget block 保留 + 标记 interrupted
 * 的核心承诺：
 *   1. widget kind block：标记 `interrupted_at` + `interrupted_status`，**保留**
 *   2. 非 widget kind block（image/table/file/resource_ref）：**清空**（兼容
 *      原 clearRichContentBlocks 全清行为）
 *   3. 已 mark 的 widget 不被覆盖（lifecycle 路径先 mark 'cancelled' →
 *      removeStreamingSession 兜底再 mark 'unknown' 不污染状态）
 *   4. 全部 block 都被清空时（譬如只有非 widget kind）→ key 删掉与
 *      clearRichContentBlocks 行为一致
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { useChatRuntimeStore } from './useChatRuntimeStore'

const SESSION = 's-widget-interrupt'

beforeEach(() => {
  // 把 store 整个重置——避免跨测试污染（store 是 module singleton）
  useChatRuntimeStore.getState().reset()
})

describe('markStreamingWidgetsInterruptedAndClearOthers', () => {
  it('widget block 被保留 + 标记 interrupted_at / interrupted_status', () => {
    const store = useChatRuntimeStore.getState()
    store.upsertRichContentBlocksByToolCallId(SESSION, [
      {
        type: 'rich_content',
        kind: 'widget',
        widget_id: 'pending:tc-1',
        tool_call_id: 'tc-1',
        format: 'svg',
        summary: '',
      },
    ])
    store.markStreamingWidgetsInterruptedAndClearOthers(SESSION, 'cancelled')

    const blocks = useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION]
    expect(blocks).toBeDefined()
    expect(blocks).toHaveLength(1)
    const widget = blocks![0] as Record<string, unknown>
    expect(widget.kind).toBe('widget')
    expect(widget.tool_call_id).toBe('tc-1')
    expect(typeof widget.interrupted_at).toBe('number')
    expect(widget.interrupted_status).toBe('cancelled')
  })

  it('非 widget kind 全部清空（image / table_preview / file 走原 clear 行为）', () => {
    const store = useChatRuntimeStore.getState()
    store.appendRichContentBlocks(SESSION, [
      { type: 'rich_content', kind: 'image', url: 'https://a/b.png', summary: 'pic' },
      { type: 'rich_content', kind: 'table_preview', summary: 'tbl', columns: [], rows: [] },
      { type: 'rich_content', kind: 'file', url: 'https://a/f.zip', summary: 'file' },
    ])
    store.markStreamingWidgetsInterruptedAndClearOthers(SESSION, 'cancelled')

    // 全部清空 → key 也被删
    expect(useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION]).toBeUndefined()
  })

  it('混合 widget + image：widget 保留标 interrupted，image 清空', () => {
    const store = useChatRuntimeStore.getState()
    store.upsertRichContentBlocksByToolCallId(SESSION, [
      {
        type: 'rich_content',
        kind: 'widget',
        widget_id: 'pending:tc-w',
        tool_call_id: 'tc-w',
        format: 'svg',
        summary: '',
      },
    ])
    store.appendRichContentBlocks(SESSION, [
      { type: 'rich_content', kind: 'image', url: 'https://a/b.png', summary: 'pic' },
    ])
    store.markStreamingWidgetsInterruptedAndClearOthers(SESSION, 'error')

    const blocks = useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION]
    expect(blocks).toHaveLength(1)
    expect((blocks![0] as Record<string, unknown>).kind).toBe('widget')
    expect((blocks![0] as Record<string, unknown>).interrupted_status).toBe('error')
  })

  it('幂等：已 mark 的 widget 不被覆盖（lifecycleHandler "cancelled" → removeStreamingSession "unknown" 不污染）', () => {
    const store = useChatRuntimeStore.getState()
    store.upsertRichContentBlocksByToolCallId(SESSION, [
      {
        type: 'rich_content',
        kind: 'widget',
        widget_id: 'pending:tc-1',
        tool_call_id: 'tc-1',
        format: 'svg',
        summary: '',
      },
    ])
    // 首次 mark 'cancelled'（lifecycleHandler 路径）
    store.markStreamingWidgetsInterruptedAndClearOthers(SESSION, 'cancelled')
    const firstAt = (
      useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION]![0] as Record<string, unknown>
    ).interrupted_at
    expect(firstAt).toBeTruthy()

    // 二次 mark 'unknown'（removeStreamingSession 兜底路径）
    store.markStreamingWidgetsInterruptedAndClearOthers(SESSION, 'unknown')
    const after = useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION]![0] as Record<string, unknown>
    // 状态保持首次 mark 的 'cancelled'，不被覆盖为 'unknown'
    expect(after.interrupted_status).toBe('cancelled')
    // 时间戳也不变
    expect(after.interrupted_at).toBe(firstAt)
  })

  it('空 session 调用安全：无 block 时 noop 不抛错', () => {
    const store = useChatRuntimeStore.getState()
    expect(() =>
      store.markStreamingWidgetsInterruptedAndClearOthers('nonexistent', 'cancelled'),
    ).not.toThrow()
    expect(useChatRuntimeStore.getState().richContentBlocksBySessionId['nonexistent']).toBeUndefined()
  })

  it('多个 widget 同时存在（多 widget 并行 cancel）：全部保留 + 全部 mark', () => {
    const store = useChatRuntimeStore.getState()
    store.upsertRichContentBlocksByToolCallId(SESSION, [
      {
        type: 'rich_content',
        kind: 'widget',
        widget_id: 'pending:tc-1',
        tool_call_id: 'tc-1',
        format: 'svg',
        summary: '',
      },
      {
        type: 'rich_content',
        kind: 'widget',
        widget_id: 'pending:tc-2',
        tool_call_id: 'tc-2',
        format: 'svg',
        summary: '',
      },
    ])
    store.markStreamingWidgetsInterruptedAndClearOthers(SESSION, 'terminated')

    const blocks = useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION]
    expect(blocks).toHaveLength(2)
    for (const b of blocks!) {
      const r = b as Record<string, unknown>
      expect(r.kind).toBe('widget')
      expect(r.interrupted_status).toBe('terminated')
      expect(typeof r.interrupted_at).toBe('number')
    }
  })

  // Widget Wave 3（技术 Review MEDIUM 修复）：phase=end 正常完成时 widget
  // 已带 finalCode（upsert 替换过 placeholder），mark 路径**不应**污染 store
  // 加 interrupted_at——前端 `isInterrupted = !!interrupted_at && !finalCode`
  // 防御得住，但 store 状态应该干净，避免 dev 调试时所有完成 widget 都看
  // 起来"是中断的"假象。
  it('已带 finalCode 的 widget 不被 mark interrupted（phase=end 正常完成不污染 store）', () => {
    const store = useChatRuntimeStore.getState()
    store.upsertRichContentBlocksByToolCallId(SESSION, [
      {
        type: 'rich_content',
        kind: 'widget',
        widget_id: 'wgt_done',
        tool_call_id: 'tc-done',
        format: 'svg',
        code: '<svg viewBox="0 0 1 1"/>',
        summary: '架构图',
      },
    ])
    // phase=end 正常完成路径调 mark with 'unknown'
    store.markStreamingWidgetsInterruptedAndClearOthers(SESSION, 'unknown')

    const blocks = useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION]
    expect(blocks).toHaveLength(1)
    const widget = blocks![0] as Record<string, unknown>
    // 已带 finalCode → 不污染 interrupted_at（store 状态干净）
    expect(widget.interrupted_at).toBeUndefined()
    expect(widget.interrupted_status).toBeUndefined()
    expect(widget.code).toBe('<svg viewBox="0 0 1 1"/>')
  })

  it('混合：placeholder（无 finalCode）被 mark；final widget（含 finalCode）不被 mark', () => {
    const store = useChatRuntimeStore.getState()
    store.upsertRichContentBlocksByToolCallId(SESSION, [
      {
        type: 'rich_content',
        kind: 'widget',
        widget_id: 'pending:tc-1',
        tool_call_id: 'tc-1',
        format: 'svg',
        summary: '',
      },
      {
        type: 'rich_content',
        kind: 'widget',
        widget_id: 'wgt_done',
        tool_call_id: 'tc-2',
        format: 'svg',
        code: '<svg/>',
        summary: '已完成',
      },
    ])
    store.markStreamingWidgetsInterruptedAndClearOthers(SESSION, 'cancelled')

    const blocks = useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION]
    expect(blocks).toHaveLength(2)
    const placeholderWidget = blocks![0] as Record<string, unknown>
    const finalWidget = blocks![1] as Record<string, unknown>
    // placeholder（无 code）被 mark
    expect(placeholderWidget.interrupted_status).toBe('cancelled')
    expect(typeof placeholderWidget.interrupted_at).toBe('number')
    // final（带 code）不被 mark
    expect(finalWidget.interrupted_at).toBeUndefined()
    expect(finalWidget.code).toBe('<svg/>')
  })
})
