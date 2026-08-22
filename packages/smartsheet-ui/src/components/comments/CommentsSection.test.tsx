import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommentsSection, type CommentItem, type CommentMentionCandidate } from './CommentsSection'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const mentionCandidates: CommentMentionCandidate[] = [
  {
    userId: 'user-1',
    displayName: '张三',
    accountName: 'zhangsan',
    email: 'zhang@example.com',
    labels: ['张三', 'zhang@example.com', 'user-1'],
  },
  {
    userId: 'user-2',
    displayName: '李四',
    accountName: 'alice',
    email: 'ji@example.com',
    labels: ['李四', 'ji@example.com', 'user-2'],
  },
  {
    userId: 'user-3',
    displayName: 'Verify Owner',
    accountName: 'verify_owner',
    email: 'verify@example.com',
    labels: ['Verify Owner', 'verify@example.com', 'user-3'],
  },
]

function Harness({
  onMentionSelect = vi.fn(),
  onMentionSearch,
  onSubmit = vi.fn(),
  onDeleteComment,
  onValueChangeSpy,
  clearLabel,
  comments = [],
  currentUserId,
  deletingCommentIds,
  readOnly,
  layout,
  isLoading,
  error,
  onRetry,
  hasMore,
  onLoadMore,
  highlightedCommentId,
  autoFocus,
  statusFilter,
  onStatusFilterChange,
  onResolveThread,
  onReopenThread,
  updatingThreadIds,
}: {
  onMentionSelect?: (candidate: CommentMentionCandidate) => void
  onMentionSearch?: (query: string) => void
  onSubmit?: (mentionUserIds: string[], replyToCommentId?: string) => void | Promise<void>
  onDeleteComment?: (commentId: string) => void
  onValueChangeSpy?: (value: string) => void
  clearLabel?: string
  comments?: CommentItem[]
  currentUserId?: string | null
  deletingCommentIds?: string[]
  readOnly?: boolean
  layout?: 'inline' | 'side-panel'
  isLoading?: boolean
  error?: string | null
  onRetry?: () => void
  hasMore?: boolean
  onLoadMore?: () => void | Promise<void>
  highlightedCommentId?: string | null
  autoFocus?: boolean
  statusFilter?: 'open' | 'resolved' | 'all'
  onStatusFilterChange?: (status: 'open' | 'resolved' | 'all') => void
  onResolveThread?: (threadId: string) => void
  onReopenThread?: (threadId: string) => void
  updatingThreadIds?: string[]
}) {
  const [value, setValue] = useState('')
  const handleValueChange = (nextValue: string) => {
    setValue(nextValue)
    onValueChangeSpy?.(nextValue)
  }

  return (
    <>
      <CommentsSection
        comments={comments}
        value={value}
        onValueChange={handleValueChange}
        onSubmit={onSubmit}
        mentionCandidates={mentionCandidates}
        onMentionSelect={onMentionSelect}
        onMentionSearch={onMentionSearch}
        currentUserId={currentUserId}
        deletingCommentIds={deletingCommentIds}
        onDeleteComment={onDeleteComment}
        readOnly={readOnly}
        layout={layout}
        isLoading={isLoading}
        error={error}
        onRetry={onRetry}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        highlightedCommentId={highlightedCommentId}
        autoFocus={autoFocus}
        statusFilter={statusFilter}
        onStatusFilterChange={onStatusFilterChange}
        onResolveThread={onResolveThread}
        onReopenThread={onReopenThread}
        updatingThreadIds={updatingThreadIds}
        labels={{
          placeholder: '输入评论',
          submit: '发送评论',
          deleteComment: '删除',
          deletingComment: '删除中',
          filterOpen: '未解决',
          filterResolved: '已解决',
          filterAll: '全部',
          resolveThread: '标记已解决',
          reopenThread: '重新打开',
          deletedComment: '评论已删除',
        }}
      />
      {clearLabel ? (
        <button type="button" onClick={() => setValue('')}>
          {clearLabel}
        </button>
      ) : null}
    </>
  )
}

describe('CommentsSection thread status', () => {
  it('switches categories and exposes the root thread status action', () => {
    const onStatusFilterChange = vi.fn()
    const onResolveThread = vi.fn()
    render(
      <Harness
        layout="side-panel"
        statusFilter="open"
        onStatusFilterChange={onStatusFilterChange}
        onResolveThread={onResolveThread}
        comments={[{
          id: 'thread-1',
          thread_id: 'thread-1',
          thread_status: 'open',
          can_resolve: true,
          author_name: '张三',
          body: '待处理',
          created_at: '2026-08-10T08:00:00Z',
        }]}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '已解决' }))
    expect(onStatusFilterChange).toHaveBeenCalledWith('resolved')
    fireEvent.click(screen.getByRole('button', { name: '标记已解决' }))
    expect(onResolveThread).toHaveBeenCalledWith('thread-1')
  })

  it('renders a deleted audit placeholder without leaking its body', () => {
    render(
      <Harness
        layout="side-panel"
        statusFilter="all"
        onStatusFilterChange={vi.fn()}
        comments={[{
          id: 'thread-1',
          thread_id: 'thread-1',
          thread_status: 'open',
          is_deleted: true,
          author_name: '张三',
          body: 'secret deleted body',
          created_at: '2026-08-10T08:00:00Z',
        }]}
      />,
    )

    expect(screen.getByText('评论已删除')).toBeTruthy()
    expect(screen.queryByText('secret deleted body')).toBeNull()
    expect(screen.queryByRole('button', { name: /回复/ })).toBeNull()
  })
})

function setEditorText(editor: HTMLElement, value: string) {
  editor.focus()
  editor.textContent = value
  setEditorCaretAtEnd(editor)
  fireEvent.input(editor)
}

function setEditorCaretAtEnd(editor: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function getEditorCaretOffset(editor: HTMLElement): number | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.endContainer)) return null
  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.endContainer, range.endOffset)
  return before.toString().length
}

function rect(input: Partial<DOMRect>): DOMRect {
  return {
    x: input.left ?? 0,
    y: input.top ?? 0,
    width: input.width ?? 0,
    height: input.height ?? 0,
    top: input.top ?? 0,
    right: input.right ?? 0,
    bottom: input.bottom ?? 0,
    left: input.left ?? 0,
    toJSON: () => ({}),
  } as DOMRect
}

describe('CommentsSection mentions', () => {
  it('keeps the caret after @ while remote mention candidates load', async () => {
    vi.useFakeTimers()

    function AsyncMentionHarness() {
      const [value, setValue] = useState('')
      const [candidates, setCandidates] = useState<CommentMentionCandidate[]>([])
      const handleMentionSearch = React.useCallback(async () => {
        await Promise.resolve()
        setCandidates(mentionCandidates)
      }, [])
      return (
        <CommentsSection
          comments={[]}
          value={value}
          onValueChange={setValue}
          onSubmit={vi.fn()}
          mentionCandidates={candidates}
          onMentionSearch={handleMentionSearch}
          labels={{ placeholder: '输入评论' }}
        />
      )
    }

    render(<AsyncMentionHarness />)
    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(getEditorCaretOffset(editor)).toBe(1)

    await act(() => vi.advanceTimersByTimeAsync(250))

    expect(screen.getByRole('option', { name: '李四' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '输入评论' })).toBe(editor)
    expect(document.activeElement).toBe(editor)
    expect(editor.textContent).toBe('@')
    expect(getEditorCaretOffset(editor)).toBe(1)
  })

  it('keeps the caret after @ when remote mention search returns no results', async () => {
    vi.useFakeTimers()

    function EmptyMentionHarness() {
      const [value, setValue] = useState('')
      const [, setSearchVersion] = useState(0)
      const handleMentionSearch = React.useCallback(async () => {
        await Promise.resolve()
        setSearchVersion((version) => version + 1)
      }, [])
      return (
        <CommentsSection
          comments={[]}
          value={value}
          onValueChange={setValue}
          onSubmit={vi.fn()}
          mentionCandidates={[]}
          onMentionSearch={handleMentionSearch}
          labels={{ placeholder: '杈撳叆璇勮' }}
        />
      )
    }

    render(<EmptyMentionHarness />)
    const editor = screen.getByRole('textbox', { name: '杈撳叆璇勮' })
    setEditorText(editor, '@')
    await act(() => vi.advanceTimersByTimeAsync(250))

    expect(screen.getByRole('textbox', { name: '杈撳叆璇勮' })).toBe(editor)
    expect(document.activeElement).toBe(editor)
    expect(editor.textContent).toBe('@')
    expect(getEditorCaretOffset(editor)).toBe(1)
  })

  it('keeps the caret after @ when remote mention search fails', async () => {
    vi.useFakeTimers()

    function FailedMentionHarness() {
      const [value, setValue] = useState('')
      const [, setSearchVersion] = useState(0)
      const handleMentionSearch = React.useCallback(async () => {
        await Promise.resolve()
        setSearchVersion((version) => version + 1)
        throw new Error('mention search failed')
      }, [])
      return (
        <CommentsSection
          comments={[]}
          value={value}
          onValueChange={setValue}
          onSubmit={vi.fn()}
          mentionCandidates={[]}
          onMentionSearch={handleMentionSearch}
          labels={{ placeholder: '杈撳叆璇勮' }}
        />
      )
    }

    render(<FailedMentionHarness />)
    const editor = screen.getByRole('textbox', { name: '杈撳叆璇勮' })
    setEditorText(editor, '@')
    await act(() => vi.advanceTimersByTimeAsync(250))

    expect(screen.getByRole('textbox', { name: '杈撳叆璇勮' })).toBe(editor)
    expect(document.activeElement).toBe(editor)
    expect(editor.textContent).toBe('@')
    expect(getEditorCaretOffset(editor)).toBe(1)
  })

  it('debounces remote mention search without replacing local candidates', () => {
    vi.useFakeTimers()
    const onMentionSearch = vi.fn()
    render(<Harness onMentionSearch={onMentionSearch} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@计')

    expect(screen.getByRole('option', { name: '李四' })).toBeTruthy()
    expect(onMentionSearch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(249)
    expect(onMentionSearch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onMentionSearch).toHaveBeenCalledTimes(1)
    expect(onMentionSearch).toHaveBeenCalledWith('计')
  })

  it('opens member suggestions after @ and inserts the selected member', () => {
    const onMentionSelect = vi.fn()
    render(<Harness onMentionSelect={onMentionSelect} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')

    expect(screen.getByRole('listbox', { name: '选择提及成员' })).toBeTruthy()
    const option = screen.getByRole('option', { name: '李四' })

    expect(fireEvent.mouseDown(option)).toBe(false)

    expect(editor.textContent).toBe('@李四 ')
    const token = editor.querySelector('[data-mention-user-id="user-2"]')
    expect(token?.getAttribute('contenteditable')).toBe('false')
    expect(token?.getAttribute('role')).toBe('button')
    expect(token?.getAttribute('tabindex')).toBe('0')
    expect(token?.getAttribute('class')).toContain('text-primary')
    expect(onMentionSelect).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-2' }))
  })

  it('submits mention user ids from editor segments, not plain-text matching', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    fireEvent.mouseDown(screen.getByRole('option', { name: '李四' }))

    fireEvent.click(screen.getByRole('button', { name: '发送评论' }))

    expect(onSubmit).toHaveBeenCalledWith(['user-2'])
  })

  it('opens a user card from the selected mention chip by click', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    fireEvent.mouseDown(screen.getByRole('option', { name: '李四' }))

    const token = editor.querySelector('[data-mention-user-id="user-2"]')
    expect(token).not.toBeNull()

    fireEvent.mouseOver(token!)
    expect(screen.queryByRole('dialog', { name: '李四 的用户信息' })).toBeNull()

    fireEvent.focus(token!)
    expect(screen.queryByRole('dialog', { name: '李四 的用户信息' })).toBeNull()

    fireEvent.click(token!)

    expect(screen.getByRole('dialog', { name: '李四 的用户信息' })).toBeTruthy()
    expect(screen.getByText('@alice')).toBeTruthy()
    expect(screen.queryByText('ji@example.com')).toBeNull()

    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '李四 的用户信息' })).toBeNull()
  })

  it('keeps the input mention user card inside the viewport when the anchor is near the bottom', () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 260 })
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    fireEvent.mouseDown(screen.getByRole('option', { name: '李四' }))

    const token = editor.querySelector('[data-mention-user-id="user-2"]') as HTMLElement
    vi.spyOn(token, 'getBoundingClientRect').mockReturnValue(rect({
      top: 210,
      bottom: 230,
      left: 40,
      right: 96,
      width: 56,
      height: 20,
    }))

    fireEvent.click(token)

    const card = screen.getByRole('dialog', { name: '李四 的用户信息' })
    expect(card.style.top).toBe('74px')
    expect(card.style.left).toBe('40px')

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
  })

  it('closes the mention user card when the page scrolls', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    fireEvent.mouseDown(screen.getByRole('option', { name: '李四' }))

    const token = editor.querySelector('[data-mention-user-id="user-2"]')
    expect(token).not.toBeNull()
    fireEvent.click(token!)
    expect(screen.getByRole('dialog', { name: '李四 的用户信息' })).toBeTruthy()

    fireEvent.scroll(document)

    expect(screen.queryByRole('dialog', { name: '李四 的用户信息' })).toBeNull()
  })

  it('supports keyboard navigation and enter selection', () => {
    const onMentionSelect = vi.fn()
    render(<Harness onMentionSelect={onMentionSelect} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(editor.textContent).toBe('@李四 ')
    expect(onMentionSelect).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-2' }))
  })

  it('closes member suggestions when the controlled value is cleared', () => {
    render(<Harness clearLabel="清空" />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    expect(screen.getByRole('listbox', { name: '选择提及成员' })).toBeTruthy()

    fireEvent.click(screen.getByText('清空'))

    expect(screen.queryByRole('listbox', { name: '选择提及成员' })).toBeNull()
  })

  it('closes member suggestions when the comment input loses focus', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    expect(screen.getByRole('listbox', { name: '选择提及成员' })).toBeTruthy()

    fireEvent.blur(editor)

    expect(screen.queryByRole('listbox', { name: '选择提及成员' })).toBeNull()
  })

  it('does not reopen suggestions for the same dismissed @ query', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    expect(screen.getByRole('listbox', { name: '选择提及成员' })).toBeTruthy()

    fireEvent.blur(editor)
    setEditorText(editor, '@大苏打钉钉钉')

    expect(screen.queryByRole('listbox', { name: '选择提及成员' })).toBeNull()

    setEditorText(editor, '@大苏打钉钉钉 @')

    expect(screen.getByRole('listbox', { name: '选择提及成员' })).toBeTruthy()
  })

  it('does not reopen suggestions for the same Esc-dismissed @ query', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    expect(screen.getByRole('listbox', { name: '选择提及成员' })).toBeTruthy()

    fireEvent.keyDown(editor, { key: 'Escape' })
    setEditorText(editor, '@大苏打钉钉钉')

    expect(screen.queryByRole('listbox', { name: '选择提及成员' })).toBeNull()
  })

  it('reopens suggestions after the dismissed @ query is cleared', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    expect(screen.getByRole('listbox', { name: '选择提及成员' })).toBeTruthy()

    fireEvent.blur(editor)
    setEditorText(editor, '')
    setEditorText(editor, '@')

    expect(screen.getByRole('listbox', { name: '选择提及成员' })).toBeTruthy()
  })

  it('removes a selected mention as one token with backspace', () => {
    render(<Harness />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    fireEvent.mouseDown(screen.getByRole('option', { name: '李四' }))

    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.keyDown(editor, { key: 'Backspace' })
    fireEvent.keyDown(editor, { key: 'Backspace' })

    expect(editor.querySelector('[data-mention-user-id="user-2"]')).toBeNull()
    expect(editor.textContent).toBe('')
  })

  it('达到最大字数后继续输入仍保留 mention token 和提交用户 ID', () => {
    const onSubmit = vi.fn()
    const onValueChangeSpy = vi.fn()
    render(<Harness onSubmit={onSubmit} onValueChangeSpy={onValueChangeSpy} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '@')
    fireEvent.mouseDown(screen.getByRole('option', { name: '李四' }))

    const mentionTextLength = editor.textContent?.length ?? 0
    editor.append(document.createTextNode('a'.repeat(2000 - mentionTextLength)))
    setEditorCaretAtEnd(editor)
    fireEvent.input(editor)

    editor.append(document.createTextNode('b'))
    setEditorCaretAtEnd(editor)
    fireEvent.input(editor)

    expect(onValueChangeSpy.mock.calls.at(-1)?.[0]).toHaveLength(2000)
    expect(editor.textContent).toHaveLength(2000)
    expect(editor.querySelector('[data-mention-user-id="user-2"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '发送评论' }))
    expect(onSubmit).toHaveBeenCalledWith(['user-2'])
  })

  it('does not commit IME composition text before composition ends', () => {
    const onValueChangeSpy = vi.fn()
    render(<Harness onValueChangeSpy={onValueChangeSpy} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    fireEvent.compositionStart(editor)
    editor.textContent = "jin'tian'tian'qi'zhe"
    fireEvent.input(editor)

    expect(onValueChangeSpy).not.toHaveBeenCalled()

    editor.textContent = '今天天气真'
    fireEvent.compositionEnd(editor)

    expect(onValueChangeSpy).toHaveBeenCalledWith('今天天气真')
  })

  it('IME composition 结束时截断超额文本并同步编辑区', () => {
    const onValueChangeSpy = vi.fn()
    render(<Harness onValueChangeSpy={onValueChangeSpy} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    const prefix = 'a'.repeat(1999)
    setEditorText(editor, prefix)
    onValueChangeSpy.mockClear()

    fireEvent.compositionStart(editor)
    editor.textContent = `${prefix}ni`
    fireEvent.input(editor)
    expect(onValueChangeSpy).not.toHaveBeenCalled()

    editor.textContent = `${prefix}你我`
    setEditorCaretAtEnd(editor)
    fireEvent.compositionEnd(editor)

    const maxLengthValue = `${prefix}你`
    expect(onValueChangeSpy).toHaveBeenLastCalledWith(maxLengthValue)
    expect(editor.textContent).toBe(maxLengthValue)
    expect(getEditorCaretOffset(editor)).toBe(2000)
  })

  it('hides the placeholder while IME composition text has not been committed', () => {
    const onValueChangeSpy = vi.fn()
    render(<Harness onValueChangeSpy={onValueChangeSpy} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    fireEvent.compositionStart(editor)
    editor.textContent = "jin'tian'tian'qi'zhe"
    fireEvent.input(editor)

    expect(onValueChangeSpy).not.toHaveBeenCalled()
    expect(editor.getAttribute('data-empty')).toBeNull()
  })

  it('highlights mentions in the comment list with text color only', () => {
    render(
      <Harness
        comments={[
          {
            id: 'comment-1',
            author_name: '张三',
            body: '你好 @李四 今天同步一下',
            mention_user_ids: ['user-2'],
            created_at: null,
          },
        ]}
      />,
    )

    const mention = screen.getByText('@李四')
    expect(mention.getAttribute('class')).toContain('text-primary')
  })

  it('does not highlight unmatched @ tokens in the comment list', () => {
    const { container } = render(
      <Harness
        comments={[
          {
            id: 'comment-unmatched',
            author_name: '张三',
            body: '你好 @随便写的 今天同步一下',
            mention_user_ids: [],
            created_at: null,
          },
        ]}
      />,
    )

    expect(container.textContent).toContain('@随便写的')
    expect(screen.queryByRole('button', { name: /随便写的/ })).toBeNull()
    const mentionLike = Array.from(container.querySelectorAll('.text-primary'))
      .filter((el) => (el.textContent || '').includes('@随便写的'))
    expect(mentionLike).toHaveLength(0)
  })

  it('does not paint trailing plain @text blue when a real mention already consumed the id', () => {
    const { container } = render(
      <Harness
        comments={[
          {
            id: 'comment-mixed',
            author_name: '张三',
            body: '你好 @李四 @123 看下',
            mention_user_ids: ['user-2'],
            created_at: null,
          },
        ]}
      />,
    )

    expect(screen.getByRole('button', { name: '查看 李四 的用户信息' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /123/ })).toBeNull()
    const blueAt123 = Array.from(container.querySelectorAll('.text-primary'))
      .filter((el) => (el.textContent || '').includes('@123'))
    expect(blueAt123).toHaveLength(0)
    expect(container.textContent).toContain('@123')
  })

  it('renders comment author avatar image and falls back to initials', () => {
    render(
      <Harness
        comments={[
          {
            id: 'comment-with-avatar',
            author_name: '张三',
            author_user_id: 'user-1',
            author_avatar: 'https://example.com/avatar.png',
            author_account_name: 'zhangsan',
            body: '带头像评论',
            created_at: null,
          },
          {
            id: 'comment-without-avatar',
            author_name: '王小明',
            author_user_id: 'user-4',
            author_account_name: 'wangxm',
            body: '无头像评论',
            created_at: null,
          },
          {
            id: 'comment-with-object-key',
            author_name: '赵六',
            author_user_id: 'user-5',
            author_avatar: 'user-avatars/zhao.png',
            author_account_name: 'zhaoliu',
            body: 'object key 头像',
            created_at: null,
          },
          {
            id: 'comment-with-junk-relative',
            author_name: '钱七',
            author_user_id: 'user-6',
            author_avatar: 'junk-relative.png',
            author_account_name: 'qianqi',
            body: '相对路径不应直接当 img',
            created_at: null,
          },
        ]}
      />,
    )

    const avatarButton = screen.getByRole('button', { name: '查看评论作者 张三 的用户信息' })
    expect(avatarButton.querySelector('img')?.getAttribute('src')).toBe('https://example.com/avatar.png')
    expect(screen.getByText('王')).toBeTruthy()

    const objectKeyButton = screen.getByRole('button', { name: '查看评论作者 赵六 的用户信息' })
    expect(objectKeyButton.querySelector('img')?.getAttribute('src')).toBe(
      'https://assets.example.com/user-avatars/zhao.png',
    )

    const junkButton = screen.getByRole('button', { name: '查看评论作者 钱七 的用户信息' })
    expect(junkButton.querySelector('img')).toBeNull()
    expect(screen.getByText('钱')).toBeTruthy()
  })

  it('falls back to initials when comment author avatar image fails to load', () => {
    render(
      <Harness
        comments={[
          {
            id: 'comment-broken-avatar',
            author_name: '殷玉蒙',
            author_user_id: 'user-7',
            author_avatar: 'https://example.com/broken-avatar.png',
            author_account_name: 'yinyumeng',
            body: '裂图应回退首字母',
            created_at: null,
          },
        ]}
      />,
    )

    const avatarButton = screen.getByRole('button', { name: '查看评论作者 殷玉蒙 的用户信息' })
    const image = avatarButton.querySelector('img')
    expect(image).not.toBeNull()
    fireEvent.error(image as HTMLImageElement)
    expect(avatarButton.querySelector('img')).toBeNull()
    expect(screen.getByText('殷')).toBeTruthy()
  })

  it('opens the shared user card from a comment author avatar', () => {
    render(
      <Harness
        comments={[
          {
            id: 'comment-1',
            author_name: '张三',
            author_user_id: 'user-1',
            author_avatar: 'https://example.com/avatar.png',
            author_account_name: 'zhangsan',
            body: '作者头像可点击',
            created_at: null,
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '查看评论作者 张三 的用户信息' }))

    expect(screen.getByRole('dialog', { name: '张三 的用户信息' })).toBeTruthy()
    expect(screen.getByText('@zhangsan')).toBeTruthy()
    expect(screen.queryByText('zhang@example.com')).toBeNull()
  })

  it('confirms before deleting comments authored by the current user', () => {
    const onDeleteComment = vi.fn()
    render(
      <Harness
        currentUserId="user-1"
        onDeleteComment={onDeleteComment}
        comments={[
          {
            id: 'comment-own',
            author_name: '张三',
            author_user_id: 'user-1',
            body: '自己发的评论',
            created_at: null,
          },
          {
            id: 'comment-other',
            author_name: '李四',
            author_user_id: 'user-2',
            body: '别人发的评论',
            created_at: null,
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '删除 张三 的评论' }))

    expect(onDeleteComment).not.toHaveBeenCalled()
    expect(screen.getByText('删除这条评论？')).toBeTruthy()
    expect(screen.getByText('删除后将无法在评论区恢复。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    expect(onDeleteComment).toHaveBeenCalledWith('comment-own')
    expect(screen.queryByRole('button', { name: '删除 李四 的评论' })).toBeNull()
  })

  it('submits a reply with its parent comment and clears the reply target', async () => {
    const onSubmit = vi.fn(async () => undefined)
    render(
      <Harness
        onSubmit={onSubmit}
        comments={[{
          id: 'comment-parent',
          author_name: '张三',
          body: '原评论内容',
          created_at: null,
        }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '回复 张三 的评论' }))
    expect(screen.getAllByText('原评论内容')).toHaveLength(2)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '这是回复')
    fireEvent.click(screen.getByRole('button', { name: '发送评论' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([], 'comment-parent'))
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消回复' })).toBeNull())
  })

  it('does not delete the comment when the confirmation is cancelled', () => {
    const onDeleteComment = vi.fn()
    render(
      <Harness
        currentUserId="user-1"
        onDeleteComment={onDeleteComment}
        comments={[
          {
            id: 'comment-own',
            author_name: '张三',
            author_user_id: 'user-1',
            body: '自己发的评论',
            created_at: null,
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '删除 张三 的评论' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(onDeleteComment).not.toHaveBeenCalled()
    expect(screen.queryByText('删除这条评论？')).toBeNull()
  })

  it('disables the delete action while a comment is being deleted', () => {
    render(
      <Harness
        currentUserId="user-1"
        onDeleteComment={vi.fn()}
        deletingCommentIds={['comment-own']}
        comments={[
          {
            id: 'comment-own',
            author_name: '张三',
            author_user_id: 'user-1',
            body: '自己发的评论',
            created_at: null,
          },
        ]}
      />,
    )

    const deleteButton = screen.getByRole('button', { name: '删除 张三 的评论' }) as HTMLButtonElement
    expect(deleteButton.disabled).toBe(true)
    expect(deleteButton.textContent).toContain('删除中')
  })

  it('does not open a user card for comments without an author user id', () => {
    render(
      <Harness
        comments={[
          {
            id: 'comment-1',
            author_name: '匿名访客',
            body: '历史评论',
            created_at: null,
          },
        ]}
      />,
    )

    expect(screen.queryByRole('button', { name: /查看评论作者/ })).toBeNull()
    fireEvent.click(screen.getByText('匿'))
    fireEvent.click(screen.getByText('匿名访客'))
    expect(screen.queryByRole('dialog', { name: '匿名访客 的用户信息' })).toBeNull()
  })

  it('opens a user card from persisted comment mentions only on click', () => {
    render(
      <Harness
        comments={[
          {
            id: 'comment-1',
            author_name: '张三',
            body: '你好 @李四 今天同步一下',
            mention_user_ids: ['user-2'],
            created_at: null,
          },
        ]}
      />,
    )

    const mention = screen.getByRole('button', { name: '查看 李四 的用户信息' })

    fireEvent.mouseEnter(mention)
    expect(screen.queryByRole('dialog', { name: '李四 的用户信息' })).toBeNull()

    fireEvent.focus(mention)
    expect(screen.queryByRole('dialog', { name: '李四 的用户信息' })).toBeNull()

    fireEvent.click(mention)
    expect(screen.getByText('@alice')).toBeTruthy()
    expect(screen.queryByText('ji@example.com')).toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '李四 的用户信息' })).toBeNull()
  })

  it('keeps persisted mentions clickable when stored text differs from current member name', () => {
    render(
      <Harness
        comments={[
          {
            id: 'comment-1',
            author_name: '张三',
            body: '你好 @Verify 今天同步一下',
            mention_user_ids: ['user-2'],
            created_at: null,
          },
        ]}
      />,
    )

    const mention = screen.getByText('@Verify')
    fireEvent.click(mention)

    expect(screen.getByRole('dialog', { name: '李四 的用户信息' })).toBeTruthy()
    expect(screen.getByText('@alice')).toBeTruthy()
    expect(screen.queryByText('ji@example.com')).toBeNull()
  })

  it('highlights full persisted mention names that contain spaces', () => {
    render(
      <Harness
        comments={[
          {
            id: 'comment-1',
            author_name: '张三',
            body: '你好 @Verify Owner 11111',
            mention_user_ids: ['user-3'],
            created_at: null,
          },
        ]}
      />,
    )

    const mention = screen.getByRole('button', { name: '查看 Verify Owner 的用户信息' })

    expect(mention.textContent).toBe('@Verify Owner')
    fireEvent.click(mention)
    expect(screen.getByRole('dialog', { name: 'Verify Owner 的用户信息' })).toBeTruthy()
    expect(screen.getByText('@verify_owner')).toBeTruthy()
    expect(screen.queryByText('verify@example.com')).toBeNull()
  })

})

describe('CommentsSection showCount', () => {
  it('渲染当前/最大字数角标，输入时同步更新', () => {
    render(<Harness />)

    const count = screen.getByTestId('comment-char-count')
    expect(count.textContent?.replace(/\s+/g, ' ').trim()).toBe('0 / 2000')
    expect(count.className).toContain('group-focus-within/comment-input:block')

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '你好')
    expect(screen.getByTestId('comment-char-count').textContent?.replace(/\s+/g, ' ').trim()).toBe('2 / 2000')
  })

  it('输入超过最大字数时同步截断受控值和可见编辑区', () => {
    const onValueChangeSpy = vi.fn()
    render(<Harness onValueChangeSpy={onValueChangeSpy} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    const maxLengthValue = 'a'.repeat(2000)
    setEditorText(editor, maxLengthValue)
    setEditorText(editor, `${maxLengthValue}b`)

    expect(onValueChangeSpy).toHaveBeenLastCalledWith(maxLengthValue)
    expect(editor.textContent).toBe(maxLengthValue)
    expect(screen.getByTestId('comment-char-count').textContent?.replace(/\s+/g, ' ').trim()).toBe('2000 / 2000')
  })

  it('粘贴超长文本时只保留最大字数并把光标放在末尾', () => {
    const onValueChangeSpy = vi.fn()
    render(<Harness onValueChangeSpy={onValueChangeSpy} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    const maxLengthValue = '粘'.repeat(2000)
    editor.focus()
    editor.textContent = `${maxLengthValue}贴`
    setEditorCaretAtEnd(editor)
    fireEvent.input(editor, { inputType: 'insertFromPaste' })

    expect(onValueChangeSpy).toHaveBeenLastCalledWith(maxLengthValue)
    expect(editor.textContent).toBe(maxLengthValue)
    expect(getEditorCaretOffset(editor)).toBe(2000)
  })

  it('清空后残留 caret <br> 时字数归零并恢复 empty 态', () => {
    const onValueChangeSpy = vi.fn()
    render(<Harness onValueChangeSpy={onValueChangeSpy} />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, 'a')
    expect(screen.getByTestId('comment-char-count').textContent?.replace(/\s+/g, ' ').trim()).toBe('1 / 2000')

    // Chromium 清空 contentEditable 后的典型残留
    editor.innerHTML = '<br>'
    fireEvent.input(editor)

    expect(onValueChangeSpy).toHaveBeenLastCalledWith('')
    expect(screen.getByTestId('comment-char-count').textContent?.replace(/\s+/g, ' ').trim()).toBe('0 / 2000')
    expect(editor.getAttribute('data-empty')).toBe('true')
    expect(editor.innerHTML).toBe('')
  })
})

describe('CommentsSection readOnly', () => {
  it('keeps existing comments visible without rendering a comment composer', () => {
    render(
      <Harness
        readOnly
        currentUserId="user-1"
        onDeleteComment={vi.fn()}
        comments={[
          {
            id: 'comment-1',
            author_name: '张三',
            author_user_id: 'user-1',
            body: '这条评论仍然可见',
            created_at: '2026-08-10T08:00:00Z',
          },
        ]}
      />,
    )

    expect(screen.getByText('这条评论仍然可见')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '输入评论' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除 张三 的评论' })).toBeNull()
  })
})

describe('CommentsSection side-panel layout', () => {
  it('focuses the comment editor when the opening entry requests it', async () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<Harness layout="side-panel" autoFocus />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    await waitFor(() => expect(document.activeElement).toBe(editor))
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('keeps the comments heading and zero count visible when the list is empty', () => {
    render(<Harness layout="side-panel" />)

    expect(screen.getByRole('region', { name: '全文评论' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '全文评论' })).toBeTruthy()
    expect(screen.getByText('0 条线程')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '输入评论' })).toBeTruthy()
  })

  it('keeps long comment drafts inside a scrollable editor', () => {
    render(<Harness layout="side-panel" />)

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 行`).join('\n'))

    expect(editor.classList.contains('max-h-40')).toBe(true)
    expect(editor.classList.contains('overflow-y-auto')).toBe(true)
    expect(editor.classList.contains('overscroll-contain')).toBe(true)
  })

  it('shows first-load progress before any comment is available', () => {
    render(<Harness layout="side-panel" isLoading />)

    expect(screen.getByRole('status', { name: '正在加载评论...' })).toBeTruthy()
  })

  it('shows a first-load error with a retry action before any comment is available', () => {
    const onRetry = vi.fn()
    render(
      <Harness
        layout="side-panel"
        error="评论加载失败"
        onRetry={onRetry}
      />,
    )

    expect(screen.getByText('评论加载失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('CommentsSection author attribution and links', () => {
  it('marks an Agent author without changing the displayed author name', () => {
    render(
      <Harness
        comments={[{
          id: 'comment-agent',
          author_name: '数据助手',
          author_type: 'agent',
          authorization_subject_name: '张三',
          agent_run_id: 'run-42',
          body: '已完成核对',
          created_at: '2026-08-10T08:00:00Z',
        }]}
      />,
    )

    expect(screen.getByText('数据助手')).toBeTruthy()
    expect(screen.getByText('Agent').getAttribute('title')).toBe('授权用户：张三\nRun：run-42')
  })

  it('renders only http and https URLs as safe new-window links while preserving mentions', () => {
    render(
      <Harness
        comments={[{
          id: 'comment-link',
          author_name: '张三',
          author_user_id: 'user-1',
          body: '@张三 请看 https://admin.example.com/threads 和 http://example.com，javascript:alert(1)',
          created_at: '2026-08-10T08:00:00Z',
          mention_user_ids: ['user-1'],
        }]}
      />,
    )

    expect(screen.getByRole('button', { name: '查看 张三 的用户信息' })).toBeTruthy()
    const secureLink = screen.getByRole('link', { name: 'https://admin.example.com/threads' })
    expect(secureLink.getAttribute('href')).toBe('https://admin.example.com/threads')
    expect(secureLink.getAttribute('target')).toBe('_blank')
    expect(secureLink.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('link', { name: 'http://example.com' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /javascript:/ })).toBeNull()
  })

  it('does not mistake an at sign inside an http URL for a member mention', () => {
    render(
      <Harness
        comments={[{
          id: 'comment-url-userinfo',
          author_name: '张三',
          body: 'https://user@example.com/path',
          created_at: '2026-08-10T08:00:00Z',
        }]}
      />,
    )

    expect(screen.getByRole('link', { name: 'https://user@example.com/path' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /example/ })).toBeNull()
  })

  it('contains rejected host actions so UI event handlers do not leak unhandled promises', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('submit failed'))
    const onRetry = vi.fn().mockRejectedValue(new Error('retry failed'))
    const onLoadMore = vi.fn().mockRejectedValue(new Error('load more failed'))
    render(
      <Harness
        layout="side-panel"
        error="评论加载失败"
        onSubmit={onSubmit}
        onRetry={onRetry}
        hasMore
        onLoadMore={onLoadMore}
      />,
    )

    const editor = screen.getByRole('textbox', { name: '输入评论' })
    setEditorText(editor, '请重试')
    fireEvent.click(screen.getByRole('button', { name: '发送评论' }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    fireEvent.click(screen.getByRole('button', { name: '加载更早评论' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledTimes(1)
      expect(onLoadMore).toHaveBeenCalledTimes(1)
    })
  })

  it('scrolls the requested comment into view and marks it with the shared highlight tokens', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    try {
      render(
        <Harness
          highlightedCommentId="comment-target"
          comments={[{
            id: 'comment-target',
            author_name: '张三',
            body: '通知定位到这里',
            created_at: '2026-08-10T08:00:00Z',
          }]}
        />,
      )

      const target = document.querySelector('[data-comment-id="comment-target"]')
      expect(target?.getAttribute('data-highlighted')).toBe('true')
      expect(target?.getAttribute('class')).toContain('bg-accent/10')
      expect(target?.getAttribute('class')).toContain('ring-primary/30')
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})
