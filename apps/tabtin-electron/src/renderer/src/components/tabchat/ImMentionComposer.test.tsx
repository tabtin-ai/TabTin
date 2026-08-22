import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IM_MENTION_COMPOSER_VISUAL_TEST_ID, ImMentionComposer } from './ImMentionComposer'
import { MENTION_COMPOSER_CLIPBOARD_MIME, TEXT_PLAIN_CLIPBOARD_MIME } from './mentionMarkdown'
import { IM_MENTION_COMPOSER_EMPTY_PLACEHOLDER_CLASS } from './tabchatUi'

function mockClipboardData(initial: Record<string, string> = {}) {
  const store = { ...initial }
  return {
    store,
    getData: (format: string) => store[format] ?? '',
    setData: (format: string, value: string) => {
      store[format] = value
    },
    files: [] as unknown as FileList,
  }
}

describe('ImMentionComposer', () => {
  it('shows mention names in the visual field instead of raw markdown', () => {
    render(
      <ImMentionComposer
        value="[@快乐猪窝](mention:agent/agent-pig) 看下"
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        onPaste={vi.fn()}
        placeholder="typeMessage"
      />,
    )

    const visual = screen.getByTestId(IM_MENTION_COMPOSER_VISUAL_TEST_ID)
    expect(visual.textContent).toContain('@快乐猪窝')
    expect(visual.textContent).toContain('看下')
    expect(visual.textContent).not.toContain('mention:agent/')
    expect(visual.textContent).not.toContain('](')

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    expect(textarea.value).toBe('[@快乐猪窝](mention:agent/agent-pig) 看下')
  })

  it('keeps the hidden textarea as the markdown source when tests change it', () => {
    const onChange = vi.fn()
    render(
      <ImMentionComposer
        value=""
        onChange={onChange}
        onKeyDown={vi.fn()}
        onPaste={vi.fn()}
        placeholder="typeMessage"
      />,
    )

    const textarea = screen.getByPlaceholderText('typeMessage') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '@快' } })
    expect(onChange).toHaveBeenCalled()
  })

  it('keeps the empty-state placeholder out of the inline caret flow', () => {
    const { rerender } = render(
      <ImMentionComposer
        value=""
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        onPaste={vi.fn()}
        placeholder="发给 进宝 · Echo Bot"
      />,
    )

    const visual = screen.getByTestId(IM_MENTION_COMPOSER_VISUAL_TEST_ID)
    expect(visual.textContent).toBe('')
    expect(visual.className).toContain('before:float-left')
    expect(visual.className).toContain('before:h-0')
    expect(visual.className).toContain(IM_MENTION_COMPOSER_EMPTY_PLACEHOLDER_CLASS)

    rerender(
      <ImMentionComposer
        value="你好"
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        onPaste={vi.fn()}
        placeholder="发给 进宝 · Echo Bot"
      />,
    )
    expect(screen.getByTestId(IM_MENTION_COMPOSER_VISUAL_TEST_ID).className)
      .not.toContain(IM_MENTION_COMPOSER_EMPTY_PLACEHOLDER_CLASS)
  })

  it('emits a numeric caret when the visual field receives @', () => {
    const onChange = vi.fn()
    render(
      <ImMentionComposer
        value=""
        onChange={onChange}
        onKeyDown={vi.fn()}
        onPaste={vi.fn()}
        placeholder="typeMessage"
      />,
    )

    const visual = screen.getByTestId(IM_MENTION_COMPOSER_VISUAL_TEST_ID)
    visual.textContent = '@'
    const textNode = visual.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.input(visual)

    expect(onChange).toHaveBeenCalled()
    const event = onChange.mock.calls[0][0] as React.ChangeEvent<HTMLTextAreaElement>
    expect(event.target.value).toBe('@')
    expect(event.target.selectionStart).toBe(1)
  })

  it('copies mention chips as markdown mime so paste keeps the id', () => {
    const onChange = vi.fn()
    const markdown = '[@快乐猪窝](mention:agent/agent-pig) 看下'
    render(
      <ImMentionComposer
        value={markdown}
        onChange={onChange}
        onKeyDown={vi.fn()}
        onPaste={vi.fn()}
        placeholder="typeMessage"
      />,
    )

    const visual = screen.getByTestId(IM_MENTION_COMPOSER_VISUAL_TEST_ID)
    const range = document.createRange()
    range.selectNodeContents(visual)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    const clipboardData = mockClipboardData()
    fireEvent.copy(visual, { clipboardData })
    expect(clipboardData.store[MENTION_COMPOSER_CLIPBOARD_MIME]).toBe(markdown)
    expect(clipboardData.store[TEXT_PLAIN_CLIPBOARD_MIME]).toBe('@快乐猪窝 看下')

    fireEvent.paste(visual, {
      clipboardData: mockClipboardData({
        [MENTION_COMPOSER_CLIPBOARD_MIME]: markdown,
        [TEXT_PLAIN_CLIPBOARD_MIME]: '@快乐猪窝 看下',
      }),
    })
    expect(onChange).toHaveBeenCalled()
    const event = onChange.mock.calls.at(-1)?.[0] as React.ChangeEvent<HTMLTextAreaElement>
    expect(event.target.value).toContain('mention:agent/agent-pig')
  })
})
