/**
 * Handoff Transcript Enricher
 *
 * 在 buildEffectivePrompt 阶段检测用户消息中的 <conversation_reference> 块，
 * 若包含 handoffId 且内容被截断，则调后端 /api/im/handoffs/{id}/transcript
 * 拉取完整冻结快照，替换截断版本。确保 Agent 获得完整对话上下文。
 */

import { API_BASE_URL } from '../../config/api.js'
import { joinApiPath } from '@tabtin/config'
import { TokenManager } from '../../auth.js'

const HANDOFF_ID_RE = /交接包[：:]\s*([0-9a-f-]{36})/
const CONVERSATION_REF_RE = /<conversation_reference>\s*([\s\S]*?)\s*<\/conversation_reference>/i

interface FrozenAttachment {
  type: string
  file_id: string
  filename: string
  url: string
  mime_type: string
  size: number
  /** 后端 transcript 接口回填的 DocParse 解析文本（file/document 类附件）。 */
  parsed_content?: string
}

interface FrozenTurn {
  role: string
  text: string
  tools?: Array<{ name: string; label: string }>
  attachments?: Array<string | FrozenAttachment>
}

interface TranscriptResponse {
  success: boolean
  data?: {
    title: string
    message_count: number
    truncated: boolean
    turns: FrozenTurn[]
  }
}

function roleHeading(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  return role
}

export function formatFullTranscript(
  originalBlock: string,
  turns: FrozenTurn[],
  _title: string,
): string {
  const match = originalBlock.match(CONVERSATION_REF_RE)
  if (!match) return originalBlock

  const body = match[1] ?? ''
  const metaLines: string[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (/^##\s+冻结对话内容/.test(trimmed)) break
    if (trimmed) metaLines.push(line)
  }

  const lines = ['<conversation_reference>']
  lines.push(...metaLines)
  lines.push('', '## 冻结对话内容（完整）')

  for (const turn of turns) {
    lines.push('', `### ${roleHeading(turn.role)}`)
    if (turn.text) lines.push(turn.text)
    if (turn.tools?.length) {
      const labels = turn.tools.map(t => t.label || t.name).filter(Boolean)
      if (labels.length) lines.push(`工具：${labels.join('、')}`)
    }
    if (turn.attachments?.length) {
      for (const att of turn.attachments) {
        if (typeof att === 'string') {
          lines.push(`附件：${att}`)
          continue
        }
        const sizeStr = att.size > 0
          ? att.size < 1048576 ? `${(att.size / 1024).toFixed(0)}KB` : `${(att.size / 1048576).toFixed(1)}MB`
          : ''
        lines.push(`附件：${att.filename}${sizeStr ? `（${sizeStr}）` : ''}${att.file_id ? ` file_id=${att.file_id}` : ''}`)
        // 后端已按「交接可见性」授权回填解析文本（摘要级）——直接给模型读；
        // 完整全文引导模型用 parse_document 按 file_id 分页拉（同 org 有权限）。
        if (att.parsed_content) {
          lines.push(`<attachment_content filename="${att.filename}">`)
          lines.push(att.parsed_content)
          lines.push('</attachment_content>')
          if (att.file_id) {
            lines.push(`（以上为解析摘要；如需完整原文，可用 parse_document 工具按 file_id=${att.file_id} 分页读取）`)
          }
        } else if (att.type === 'file' || att.type === 'document') {
          lines.push(
            att.file_id
              ? `（附件内容暂未解析完成；可稍后用 parse_document 工具按 file_id=${att.file_id} 读取）`
              : '（附件内容暂未解析完成，稍后重新提问可能可读）',
          )
        }
      }
    }
  }

  lines.push('</conversation_reference>')
  return lines.join('\n')
}

export async function enrichHandoffTranscript(prompt: string): Promise<string> {
  const refMatch = prompt.match(CONVERSATION_REF_RE)
  if (!refMatch) return prompt

  const refBlock = refMatch[0]
  const idMatch = refBlock.match(HANDOFF_ID_RE)
  if (!idMatch) return prompt

  const handoffId = idMatch[1]

  try {
    const token = await TokenManager.getAccessToken()
    if (!token) return prompt

    const url = joinApiPath(API_BASE_URL, `/im/handoffs/${handoffId}/transcript`)
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    })

    if (!response.ok) return prompt

    const json = (await response.json()) as TranscriptResponse
    if (!json.success || !json.data?.turns?.length) return prompt

    const fullBlock = formatFullTranscript(
      refBlock,
      json.data.turns,
      json.data.title,
    )
    return prompt.replace(refBlock, fullBlock)
  } catch {
    return prompt
  }
}
