/**
 * conversation_reference 用户气泡展示解析。
 * Agent / 落库仍保留完整 XML；本模块只服务阅读态卡片。
 */

export interface ConversationReferenceDisplay {
  title?: string
  messageCount?: number
  /** 已格式化的「最后活动 / 创建时间」文案（含时区），直接展示 */
  lastActivityLabel?: string
  preview?: string
  spaceId?: string
  sessionId?: string
  organizationId?: string
}

export interface ParsedConversationReferenceMessage {
  reference: ConversationReferenceDisplay
  remainderText: string
  /** 完整 `<conversation_reference>...</conversation_reference>`，发送时注入消息正文 */
  rawBlock: string
}

const REFERENCE_BLOCK_RE =
  /<conversation_reference>\s*([\s\S]*?)\s*<\/conversation_reference>/i

const LABEL_LINE_RE = /^(标题|消息数|最后活动|创建时间|预览|组织|空间|会话)[：:]\s*(.*)$/u

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseRuntimeId(value: string): { name?: string; id?: string } {
  const trimmed = value.trim()
  const named = trimmed.match(/^"([^"]*)"\s*\(id:\s*([^)]+)\)\s*$/)
  if (named) {
    return { name: named[1]?.trim() || undefined, id: named[2]?.trim() || undefined }
  }
  const idOnly = trimmed.match(/^\(id:\s*([^)]+)\)\s*$/)
  if (idOnly) return { id: idOnly[1]?.trim() || undefined }
  if (trimmed) return { id: trimmed }
  return {}
}

function applyLabeledField(
  out: ConversationReferenceDisplay,
  label: string,
  value: string,
): 'preview' | void {
  switch (label) {
    case '标题':
      if (value) out.title = value
      return
    case '消息数': {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n)) out.messageCount = n
      return
    }
    case '最后活动':
    case '创建时间':
      if (value) out.lastActivityLabel = value
      return
    case '预览':
      return 'preview'
    case '组织': {
      const { id } = parseRuntimeId(value)
      if (id) out.organizationId = id
      return
    }
    case '空间': {
      const { id } = parseRuntimeId(value)
      if (id) out.spaceId = id
      return
    }
    case '会话':
      if (value) out.sessionId = value
      return
    default:
      return
  }
}

function parseLabeledFields(body: string): ConversationReferenceDisplay {
  const lines = body.split('\n')
  const out: ConversationReferenceDisplay = {}
  let previewLines: string[] | null = null

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    if (previewLines) {
      // 预览吃到下一个 ## 段；随后继续解析定位字段
      if (/^##\s/.test(trimmed)) {
        previewLines = finalizePreview(out, previewLines)
        continue
      }
      previewLines.push(line)
      continue
    }

    const match = trimmed.match(LABEL_LINE_RE)
    if (!match) continue

    const label = match[1] ?? ''
    const value = (match[2] ?? '').trim()
    if (applyLabeledField(out, label, value) === 'preview') {
      previewLines = [value]
    }
  }

  if (previewLines) finalizePreview(out, previewLines)
  return out
}

function finalizePreview(
  out: ConversationReferenceDisplay,
  previewLines: string[],
): null {
  const preview = previewLines.join('\n').trim()
  if (preview) out.preview = preview
  return null
}

/**
 * 若正文含完整 `<conversation_reference>` 块，抽出卡片字段与块外追问。
 * 损坏/半截标签 → null（阅读态回退原文）。
 */
export function parseConversationReferenceMessage(
  raw: string | null | undefined,
): ParsedConversationReferenceMessage | null {
  const source = textValue(raw)
  if (!source) return null

  const match = source.match(REFERENCE_BLOCK_RE)
  if (!match || match.index == null) return null

  const body = match[1] ?? ''
  const reference = parseLabeledFields(body)
  // 至少要有 sessionId 才能构成「可跳转的对话引用」；否则仍当引用摘要展示
  // （无 session 时卡片可点但会 toast 失败）。
  if (
    !reference.sessionId
    && !reference.title
    && !reference.preview
    && reference.messageCount == null
  ) {
    return null
  }

  const before = source.slice(0, match.index).trim()
  const after = source.slice(match.index + match[0].length).trim()
  const remainderText = [before, after].filter(Boolean).join('\n\n')

  return { reference, remainderText, rawBlock: match[0] }
}

/** 从输入框 context ref 还原卡片展示字段 */
export function conversationReferenceDisplayFromContextRef(
  ref: { resourceId: string; label: string; spaceId?: string; meta?: Record<string, unknown> },
): ConversationReferenceDisplay {
  const meta = ref.meta ?? {}
  return {
    title: ref.label || undefined,
    sessionId: ref.resourceId || undefined,
    spaceId: ref.spaceId,
    organizationId: typeof meta.organizationId === 'string' ? meta.organizationId : undefined,
    messageCount: typeof meta.messageCount === 'number' ? meta.messageCount : undefined,
    lastActivityLabel: typeof meta.lastActivityLabel === 'string' ? meta.lastActivityLabel : undefined,
    preview: typeof meta.preview === 'string' ? meta.preview : undefined,
  }
}
