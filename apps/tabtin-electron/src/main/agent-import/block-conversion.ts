/**
 * UnifiedBlock（@tabtin/agent-import）→ Django ContentBlock 转换（spec §2.3 / §1.3.1）。
 *
 * # 边界不变量（收敛"外部脏数据击穿存储"这一类问题）
 *
 * Agent 历史是极脏的数据源：内嵌二进制（PDF `>>stream`、原始字节）、超大 dump、
 * 非法编码（NUL 字符、孤立代理对）、畸形结构。逐个 case 修永远修不完。这里在**上传边界**
 * 立三条不变量，让任何脏数据都无法击穿 Postgres（text/jsonb 均存不了 NUL / 非法转义）：
 *   1. **DB-safe 文本**：所有进库字符串剥 NUL、修孤立代理对、超长截断（`sanitizeText`）。
 *   2. **有界**：单字段有长度上限；工具输入/输出只留截断预览，不搬重内容。
 *   3. **降级不失败**：二进制/超大内容 → 占位/预览，而非报错丢整条会话。
 *
 * # 产品取舍
 *
 * 可靠导入「对话」：user/assistant 正文、thinking、标题、元信息。工具响应是 hazard
 * 老巢——**降级为轻量痕迹**。图片：宿主把源文件拷进本机档案后，转为可渲染的
 * `image` 块（`tabtin-file://`）；拷贝失败则仍落文本占位。
 *
 * 产出对象同时用于 Django append-messages 与本地 transcript（同一份，Anthropic 形态）。
 */

import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import type { UnifiedBlock } from '@tabtin/agent-import'

/** Django / 本机档案 `content_blocks_json` 单块（Anthropic 形态子集 + 扁平 image）。 */
export type DjangoContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'text'; text: string }>; is_error?: boolean }
  | {
      type: 'image'
      filename: string
      mime_type: string
      url: string
      source: { type: 'url'; url: string }
    }

// ── 边界不变量：DB-safe 文本 + 有界 ──────────────────────────────────────────

/** 单条对话正文/思考上限：正常远小于此，仅防病态粘贴（整个文件/二进制贴进消息）。 */
const TEXT_CAP = 100_000
/** 工具输入/输出只留预览：足够看清"调了什么、返回啥样"，不搬重内容。 */
const TOOL_INPUT_CAP = 4_000
const TOOL_RESULT_CAP = 4_000

// 用 fromCharCode 构造，避免源码里出现字面 NUL / 替换符（编辑器与解析器都不友好）。
const NUL = String.fromCharCode(0)
const REPLACEMENT = String.fromCharCode(0xfffd)

/**
 * DB-safe 文本：剥 NUL + 修孤立代理对 + 超长截断。
 *
 * Postgres text/jsonb 存不了 NUL 字符；JS 字符串里的孤立代理对（\uD800–\uDFFF 未配对）
 * 序列化成非法 `\uXXXX`，PG JSON 解析同样报 "unsupported Unicode escape"。两者都在此清掉。
 */
export function sanitizeText(input: unknown, cap = TEXT_CAP): string {
  let out = typeof input === 'string' ? input : input == null ? '' : String(input)
  if (out.indexOf(NUL) !== -1) out = out.split(NUL).join('')
  // 孤立高/低代理对 → U+FFFD（保留合法配对）
  out = out
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, REPLACEMENT)
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, REPLACEMENT)
  if (out.length > cap) {
    const originalLen = out.length
    out = out.slice(0, cap) + `…（已截断，原 ${originalLen} 字）`
  }
  return out
}

/** 递归 DB-safe：清理任意 JSON 结构里的所有字符串（用于保留结构的小体积工具输入）。 */
function sanitizeDeep(value: unknown, cap = TEXT_CAP): unknown {
  if (typeof value === 'string') return sanitizeText(value, cap)
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, cap))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v, cap)
    return out
  }
  return value
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** 二进制启发式：采样前 1000 字，控制字符/替换符占比过高即判为二进制。 */
function looksBinary(s: string): boolean {
  const sample = s.slice(0, 1000)
  if (!sample) return false
  let ctrl = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    // 允许 \t(9) \n(10) \r(13)；其余 C0 控制符 + NUL + U+FFFD 记为"非文本"
    if (c === 0 || c < 0x09 || (c > 0x0d && c < 0x20) || c === 0xfffd) ctrl++
  }
  return ctrl / sample.length > 0.1
}

/** tool_result content（string | text 数组）拍平成一段文本。 */
function toolResultToString(content: string | Array<{ type: 'text'; text: string }>): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
  }
  return safeStringify(content)
}

/** 第一期：工具输入降级——小而干净则保留结构（sanitize），超大/二进制则截断预览。 */
function degradeToolInput(input: unknown): unknown {
  const s = safeStringify(input)
  if (s.length > TOOL_INPUT_CAP || looksBinary(s)) {
    return { _truncated: true, preview: sanitizeText(s, TOOL_INPUT_CAP) }
  }
  return sanitizeDeep(input, TOOL_INPUT_CAP)
}

/** 第一期：工具结果降级——二进制占位、其余截断预览。 */
function degradeToolResult(content: string | Array<{ type: 'text'; text: string }>): string {
  const s = toolResultToString(content)
  if (looksBinary(s)) return '（二进制工具输出，未导入）'
  if (!s.trim()) return ''
  return sanitizeText(s, TOOL_RESULT_CAP)
}

/** 图片找不到或拷贝失败时的占位文本。 */
export function imageRefPlaceholderText(path: string): string {
  return `[图片: ${sanitizeText(basename(path || 'unknown'), 200)}]`
}

/**
 * 绝对路径 → `tabtin-file://`（与渲染进程 `buildTabtinFileUrl` 同构）。
 * 档案图片落在 userData 下，协议白名单已含 userData。
 */
export function toTabtinFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized)) {
    const encodedPath = normalized
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : ''))
      .join('/')
    return `tabtin-file://local/${encodedPath}`
  }
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  const encoded = withLeadingSlash
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : ''))
    .join('/')
  return `tabtin-file://${encoded}`
}

/** 单块转换：DB-safe + 工具降级；image_ref 在路径可读时转为 image 块。 */
export function unifiedBlockToContentBlock(block: UnifiedBlock): DjangoContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: sanitizeText(block.text) }
    case 'thinking':
      // 非 Claude 来源的 signature 已在 agent-import normalize 阶段剥离；这里原样透传。
      return {
        type: 'thinking',
        thinking: sanitizeText(block.thinking),
        ...(typeof block.signature === 'string' && block.signature.length > 0
          ? { signature: block.signature }
          : {}),
      }
    case 'tool_use':
      // 轻量痕迹：保留名字（让对话里看得到"调了什么工具"）+ 截断/占位的参数。
      return { type: 'tool_use', id: block.id, name: sanitizeText(block.name, 200), input: degradeToolInput(block.input) }
    case 'tool_result':
      // 轻量痕迹：保留结构（渲染工具卡）+ 截断预览 / 二进制占位。
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: degradeToolResult(block.content),
        ...(block.is_error ? { is_error: true } : {}),
      }
    case 'image_ref': {
      const filePath = typeof block.path === 'string' ? block.path.trim() : ''
      // 宿主应已把源图拷进档案 attachments/；此处只认可读的绝对本地路径。
      const isAbs = Boolean(filePath) && (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath))
      if (!isAbs || !existsSync(filePath)) {
        return { type: 'text', text: imageRefPlaceholderText(filePath || 'unknown') }
      }
      const filename = sanitizeText(basename(filePath), 200) || 'image.png'
      const mime =
        typeof block.mimeType === 'string' && block.mimeType.trim()
          ? sanitizeText(block.mimeType, 100)
          : 'image/png'
      const url = toTabtinFileUrl(filePath)
      return {
        type: 'image',
        filename,
        mime_type: mime,
        url,
        source: { type: 'url', url },
      }
    }
    default: {
      // 穷尽检查——UnifiedBlock 新增类型时此处编译报错，强制补映射。
      const _exhaustive: never = block
      return { type: 'text', text: sanitizeText(`[未知块: ${safeStringify(_exhaustive)}]`, 500) }
    }
  }
}

/** 整条消息的块数组转换。 */
export function unifiedBlocksToContentBlocks(blocks: UnifiedBlock[]): DjangoContentBlock[] {
  return blocks.map(unifiedBlockToContentBlock)
}
