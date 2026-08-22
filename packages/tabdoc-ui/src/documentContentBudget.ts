import { TEXT_IMPORT_MAX_BYTES } from './editor/import-file-utils'

/**
 * : Renderer safety budget before creating ProseMirror.
 * Aligned with text import cap so abnormally amplified docs (binary-migration
 * loops) fail closed with a recoverable error instead of freezing the main thread.
 */
export const DOC_EDITOR_MAX_CONTENT_BYTES = TEXT_IMPORT_MAX_BYTES

/** Top-level PM blocks beyond this are treated as unrenderable amplification. */
export const DOC_EDITOR_MAX_TOP_LEVEL_BLOCKS = 8_192

export type DocumentContentBudgetOk = {
  ok: true
  topLevelBlocks: number
  contentBytes: number
}

export type DocumentContentBudgetExceeded = {
  ok: false
  reason: 'content_bytes' | 'top_level_blocks'
  topLevelBlocks: number
  contentBytes: number
  maxContentBytes: number
  maxTopLevelBlocks: number
}

export type DocumentContentBudgetResult =
  | DocumentContentBudgetOk
  | DocumentContentBudgetExceeded

function countTopLevelBlocks(pmJson: Record<string, unknown> | null | undefined): number {
  if (!pmJson || typeof pmJson !== 'object') return 0
  const content = pmJson.content
  return Array.isArray(content) ? content.length : 0
}

function estimateContentBytes(
  pmJson: Record<string, unknown> | null | undefined,
  markdown: string,
): number {
  const mdBytes = typeof markdown === 'string' ? markdown.length : 0
  if (!pmJson || typeof pmJson !== 'object' || Object.keys(pmJson).length === 0) {
    return mdBytes
  }
  try {
    return Math.max(mdBytes, JSON.stringify(pmJson).length)
  } catch {
    return mdBytes
  }
}

export function assessDocumentContentBudget(
  pmJson: Record<string, unknown> | null | undefined,
  markdown = '',
  options?: {
    maxContentBytes?: number
    maxTopLevelBlocks?: number
  },
): DocumentContentBudgetResult {
  const maxContentBytes = options?.maxContentBytes ?? DOC_EDITOR_MAX_CONTENT_BYTES
  const maxTopLevelBlocks = options?.maxTopLevelBlocks ?? DOC_EDITOR_MAX_TOP_LEVEL_BLOCKS
  const topLevelBlocks = countTopLevelBlocks(pmJson)
  const contentBytes = estimateContentBytes(pmJson, markdown)

  if (contentBytes > maxContentBytes) {
    return {
      ok: false,
      reason: 'content_bytes',
      topLevelBlocks,
      contentBytes,
      maxContentBytes,
      maxTopLevelBlocks,
    }
  }

  if (topLevelBlocks > maxTopLevelBlocks) {
    return {
      ok: false,
      reason: 'top_level_blocks',
      topLevelBlocks,
      contentBytes,
      maxContentBytes,
      maxTopLevelBlocks,
    }
  }

  return { ok: true, topLevelBlocks, contentBytes }
}

export function formatDocumentContentBudgetError(
  result: DocumentContentBudgetExceeded,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (result.reason === 'content_bytes') {
    return t('contentBudgetExceededBytes', {
      defaultValue:
        '文档内容过大（约 {{sizeMb}} MB，上限 {{maxMb}} MB），已停止加载以免卡死。请从版本历史恢复到安全快照，或导出诊断信息后联系支持。',
      sizeMb: (result.contentBytes / (1024 * 1024)).toFixed(1),
      maxMb: (result.maxContentBytes / (1024 * 1024)).toFixed(0),
      blocks: result.topLevelBlocks,
    })
  }
  return t('contentBudgetExceededBlocks', {
    defaultValue:
      '文档块数异常（{{blocks}}，上限 {{maxBlocks}}），已停止加载以免卡死。请从版本历史恢复到安全快照，或导出诊断信息后联系支持。',
    blocks: result.topLevelBlocks,
    maxBlocks: result.maxTopLevelBlocks,
    sizeMb: (result.contentBytes / (1024 * 1024)).toFixed(1),
  })
}
