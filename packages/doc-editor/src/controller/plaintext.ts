const BLOCK_CODE_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`([^`]*)`/g
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g
const MD_MARK_RE = /[#>*_\-\[\]\(\)]/g
const MULTI_SPACE_RE = /\s+/g

export const markdownToPlaintext = (markdown: string): string => {
  let text = markdown || ''
  text = text.replace(BLOCK_CODE_RE, ' ')
  text = text.replace(INLINE_CODE_RE, '$1')
  text = text.replace(LINK_RE, '$1')
  text = text.replace(MD_MARK_RE, ' ')
  text = text.replace(MULTI_SPACE_RE, ' ')
  return text.trim()
}

