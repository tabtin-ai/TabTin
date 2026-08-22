import { describe, expect, it } from 'vitest'
import {
  resolveCloudResourceEmoji,
  resolveImportedFileEmoji,
} from './resolveCloudResourceIcon'

const typeEmoji = (type: string) => {
  const map: Record<string, string> = {
    tabdoc: '📄',
    tabdata: '📊',
    tabslide: '📽️',
    tabfiles: '📁',
    tabfolder: '📁',
  }
  return map[type]
}

describe('resolveImportedFileEmoji', () => {
  it.each([
    ['notes.docx', '📄'],
    ['notes.md', '📄'],
    ['sheet.xlsx', '📊'],
    ['data.csv', '📊'],
    ['deck.pptx', '📽️'],
    ['photo.png', '🖼️'],
    ['unknown.bin', '📄'],
  ])('maps %s to %s', (fileName, emoji) => {
    expect(resolveImportedFileEmoji(fileName)).toBe(emoji)
  })
})

describe('resolveCloudResourceEmoji', () => {
  it('prefers custom metadata.icon', () => {
    expect(resolveCloudResourceEmoji(
      'tabfiles',
      { icon: '⭐', file_name: 'a.docx' },
      typeEmoji,
      'a.docx',
    )).toBe('⭐')
  })

  it('keeps folder emoji for tabfolder', () => {
    expect(resolveCloudResourceEmoji('tabfolder', {}, typeEmoji, 'Inbox')).toBe('📁')
  })

  it('uses TabDoc/TabData emoji for bare imported files by extension', () => {
    expect(resolveCloudResourceEmoji(
      'tabfiles',
      { file_name: 'spec.docx' },
      typeEmoji,
      'spec.docx',
    )).toBe('📄')
    expect(resolveCloudResourceEmoji(
      'file',
      {},
      typeEmoji,
      'budget.xlsx',
    )).toBe('📊')
  })

  it('falls back to type emoji for native app resources', () => {
    expect(resolveCloudResourceEmoji('tabdoc', {}, typeEmoji, 'Doc')).toBe('📄')
    expect(resolveCloudResourceEmoji('tabdata', {}, typeEmoji, 'Table')).toBe('📊')
  })
})
