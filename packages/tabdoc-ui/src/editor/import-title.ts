import { isUntitledTitle } from './titleSync'

type PmJsonNode = Record<string, unknown>

function normalizeTitleForComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function collectNodeText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const record = node as PmJsonNode
  const ownText = typeof record.text === 'string' ? record.text : ''
  const childText = Array.isArray(record.content)
    ? record.content.map(collectNodeText).join('')
    : ''
  return ownText + childText
}

function isHeadingNodeMatchingTitle(node: unknown, title: string): boolean {
  if (!node || typeof node !== 'object') return false
  const record = node as PmJsonNode
  if (record.type !== 'heading') return false
  return normalizeTitleForComparison(collectNodeText(record)) === normalizeTitleForComparison(title)
}

export function shouldApplyImportedTitle(currentTitle: string | null | undefined, importedTitle: string): boolean {
  return Boolean(importedTitle.trim()) && isUntitledTitle(currentTitle)
}

export function removeLeadingImportedTitleBlock(content: unknown, importedTitle: string): unknown[] {
  if (!Array.isArray(content)) return []
  const trimmedTitle = importedTitle.trim()
  if (!trimmedTitle) return content
  if (!isHeadingNodeMatchingTitle(content[0], trimmedTitle)) return content
  return content.slice(1)
}
