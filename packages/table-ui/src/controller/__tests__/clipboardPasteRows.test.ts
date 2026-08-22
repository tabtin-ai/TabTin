import { resolveClipboardPasteRows } from '../clipboardPasteRows'

describe('resolveClipboardPasteRows', () => {
  it('keeps plain multiline content in one long-text cell', () => {
    expect(
      resolveClipboardPasteRows('第一行\n第二行\n第三行', '', 'long_text'),
    ).toEqual([['第一行\n第二行\n第三行']])
  })

  it.each([
    ['trailing newline', 'content\n'],
    ['leading newline', '\ncontent'],
    ['only newlines', '\n\n'],
  ])('preserves %s in a long-text cell', (_label, text) => {
    expect(resolveClipboardPasteRows(text, '', 'long_text')).toEqual([[text]])
  })

  it('keeps TSV structure when the long-text target receives tabular text', () => {
    expect(resolveClipboardPasteRows('A\tB\nC\tD', '', 'long_text')).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ])
  })

  it('keeps an explicit one-column HTML table as multiple target rows', () => {
    expect(
      resolveClipboardPasteRows(
        '第一行\n第二行',
        '<table><tr><td>第一行</td></tr><tr><td>第二行</td></tr></table>',
        'long_text',
      ),
    ).toEqual([['第一行'], ['第二行']])
  })

  it('keeps a Markdown table as a grid for long-text targets', () => {
    expect(
      resolveClipboardPasteRows('| A | B |\n| - | - |\n| C | D |', '', 'long_text'),
    ).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ])
  })

  it('keeps existing multiline grid paste semantics for regular text fields', () => {
    expect(resolveClipboardPasteRows('第一行\n第二行', '', 'text')).toEqual([
      ['第一行'],
      ['第二行'],
    ])
  })
})
