import React, { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommentRail } from './CommentRail'
import type { CommentThread } from '../../comment-threads/types'
import { COMMENT_RAIL_BREAKPOINT_PX } from '../../comment-threads/layout'

function thread(partial: Partial<CommentThread> & Pick<CommentThread, 'id' | 'status'>): CommentThread {
  return {
    document_id: 'd1',
    scope: 'text_range',
    anchor: { version: 1, selected_text: '引用' },
    anchor_status: 'attached',
    created_at: null,
    updated_at: null,
    messages: [{
      id: 'm1',
      thread_id: partial.id,
      kind: 'root',
      author_name: 'Alice',
      body: '你好',
      mention_user_ids: [],
      is_deleted: false,
      attachments: [],
      created_at: null,
      updated_at: null,
    }],
    ...partial,
  }
}

function Harness({
  width,
  onCollapseOutlineChange = vi.fn(),
  embedded = false,
}: {
  width: number
  onCollapseOutlineChange?: (collapse: boolean) => void
  embedded?: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <CommentRail
      open={open}
      onOpenChange={setOpen}
      viewportWidth={width}
      threads={[
        thread({ id: 'open-1', status: 'open' }),
        thread({ id: 'resolved-1', status: 'resolved' }),
        thread({ id: 'document-1', status: 'open', scope: 'document', anchor: { version: 1 } }),
      ]}
      onCollapseOutlineChange={onCollapseOutlineChange}
      embedded={embedded}
    />
  )
}

describe('CommentRail', () => {
  it('嵌入文档布局时不使用覆盖正文的 fixed 定位', () => {
    const { rerender } = render(<Harness width={COMMENT_RAIL_BREAKPOINT_PX} embedded />)
    const rail = screen.getByTestId('comment-rail')
    expect(rail.className).toContain('relative')
    expect(rail.className).toContain('max-h-full')
    expect(rail.className).toContain('min-h-0')
    expect(rail.className).not.toContain('fixed')

    rerender(<Harness width={COMMENT_RAIL_BREAKPOINT_PX - 1} embedded />)
    expect(screen.getByTestId('comment-rail').className).toContain('relative')
    expect(screen.queryByTestId('comment-rail-drawer-root')).toBeNull()
  })

  it('宽屏使用 rail 并回调收起大纲；窄屏为 drawer', () => {
    const onCollapse = vi.fn()
    const { rerender } = render(
      <Harness width={COMMENT_RAIL_BREAKPOINT_PX} onCollapseOutlineChange={onCollapse} />,
    )
    expect(screen.getByTestId('comment-rail').dataset.layout).toBe('rail')
    expect(onCollapse).toHaveBeenCalledWith(true)

    rerender(
      <Harness width={COMMENT_RAIL_BREAKPOINT_PX - 1} onCollapseOutlineChange={onCollapse} />,
    )
    expect(screen.getByTestId('comment-rail').dataset.layout).toBe('drawer')
    expect(screen.getByTestId('comment-rail-drawer-root')).toBeTruthy()
  })

  it('筛选 open/resolved/all', () => {
    render(<Harness width={1300} />)
    expect(screen.getAllByTestId('comment-thread-card')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('comment-filter-all'))
    expect(screen.getAllByTestId('comment-thread-card')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('comment-filter-resolved'))
    expect(screen.getAllByTestId('comment-thread-card')).toHaveLength(1)
    expect(screen.getByTestId('comment-thread-card').getAttribute('data-thread-id')).toBe('resolved-1')
  })

  it('新建锚点评论时在输入框上方显示当前引用', () => {
    render(
      <CommentRail
        open
        onOpenChange={vi.fn()}
        viewportWidth={1300}
        threads={[]}
        draftSelectedText="当前选中的锚点文字"
        onCreateThread={vi.fn()}
      />,
    )

    expect(screen.getByTestId('comment-draft-anchor').textContent).toBe('当前选中的锚点文字')
  })
})
