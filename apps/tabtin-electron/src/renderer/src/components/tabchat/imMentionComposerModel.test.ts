import { describe, expect, it } from 'vitest'
import {
  MENTION_COMPOSER_CLIPBOARD_MIME,
  MENTION_COMPOSER_MARKDOWN_ATTR,
  TEXT_PLAIN_CLIPBOARD_MIME,
} from './mentionMarkdown'
import {
  getMentionComposerMarkdownSelection,
  mentionComposerClipboardFromSelection,
  readMentionComposerClipboard,
  renderMentionComposerValue,
  serializeMentionComposerElement,
  writeMentionComposerClipboard,
} from './imMentionComposerModel'

describe('imMentionComposerModel', () => {
  it('renders mention markdown as a named chip and serializes back to markdown', () => {
    const root = document.createElement('div')
    renderMentionComposerValue(root, '请 [@快乐猪窝](mention:agent/agent-pig) 看下')

    expect(root.textContent).toBe('请 @快乐猪窝 看下')
    expect(root.textContent).not.toContain('mention:agent/')
    const chip = root.querySelector(`[${MENTION_COMPOSER_MARKDOWN_ATTR}]`)
    expect(chip?.textContent).toBe('@快乐猪窝')
    expect(serializeMentionComposerElement(root)).toBe(
      '请 [@快乐猪窝](mention:agent/agent-pig) 看下',
    )
  })

  it('keeps line breaks when rendering and serializing', () => {
    const root = document.createElement('div')
    renderMentionComposerValue(root, '一行\n二行')
    expect(serializeMentionComposerElement(root)).toBe('一行\n二行')
  })

  it('maps the caret after a typed @ to a numeric markdown offset', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderMentionComposerValue(root, '@')
    const textNode = root.firstChild
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE)
    const range = document.createRange()
    range.setStart(textNode as Text, 1)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    const mapped = getMentionComposerMarkdownSelection(root)
    expect(mapped.end).toBe(1)
    expect(typeof mapped.end).toBe('number')
    document.body.removeChild(root)
  })

  it('serializes a selected mention chip to markdown for clipboard', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const markdown = '请 [@快乐猪窝](mention:agent/agent-pig) 看下'
    renderMentionComposerValue(root, markdown)
    const range = document.createRange()
    range.selectNodeContents(root)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    expect(mentionComposerClipboardFromSelection(root)).toEqual({
      markdown,
      display: '请 @快乐猪窝 看下',
    })
    document.body.removeChild(root)
  })

  it('prefers mention markdown mime when pasting back', () => {
    const clipboardData = {
      store: {} as Record<string, string>,
      getData(format: string) {
        return this.store[format] ?? ''
      },
      setData(format: string, value: string) {
        this.store[format] = value
      },
    }
    writeMentionComposerClipboard(clipboardData as DataTransfer, {
      markdown: '[@快乐猪窝](mention:agent/agent-pig)',
      display: '@快乐猪窝',
    })
    expect(clipboardData.store[MENTION_COMPOSER_CLIPBOARD_MIME]).toBe(
      '[@快乐猪窝](mention:agent/agent-pig)',
    )
    expect(clipboardData.store[TEXT_PLAIN_CLIPBOARD_MIME]).toBe('@快乐猪窝')
    expect(readMentionComposerClipboard(clipboardData as DataTransfer)).toBe(
      '[@快乐猪窝](mention:agent/agent-pig)',
    )
  })
})
