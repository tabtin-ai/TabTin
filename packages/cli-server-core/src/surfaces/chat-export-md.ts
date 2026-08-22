/**
 * chat/export-md — 将对话消息导出为 Markdown 格式。
 *
 * 这是 PlatformSurface 框架的第一个端到端 PoC surface，验证
 * "一份 service 多 binding"的完整故事：
 *   - IPC: renderer 通过 window.tabtin.chat.exportMd({sessionId}) 调用
 *   - HTTP: Electron / Daemon CLI Server 通过 POST /chat/export-md 调用
 *   - alias: chat:export / /chat/export 也指向同一个 handler
 *
 * handler 逻辑：
 *   1. 校验 sessionId 必填
 *   2. 调 Django GET /api/chat/sessions/{sessionId}/messages 获取消息列表
 *   3. 把消息数组转成人类可读的 Markdown 文本
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

// ─── 输入 / 输出类型 ──────────────────────────────────────────────

/** handler 输入：需要导出的会话 ID */
export interface ChatExportMdInput {
  sessionId: string
}

/** handler 输出：Markdown 文本 + 消息条数 */
export interface ChatExportMdOutput {
  /** 拼接后的 Markdown 字符串 */
  markdown: string
  /** 消息总条数（含 system / tool 等所有角色） */
  messageCount: number
}

// ─── 角色映射（英文 role → 中文标签） ─────────────────────────────

const _ROLE_LABELS: Record<string, string> = {
  user: '用户',
  assistant: 'AI 助手',
  system: '系统',
  tool: '工具调用',
}

/**
 * 将消息数组转换为 Markdown 格式。
 *
 * 每条消息格式：
 * ```
 * ## 角色名
 * > 时间戳（如有）
 *
 * 正文内容
 *
 * ---
 * ```
 *
 * 工具调用类消息展示 tool_call_id + 工具名 + 参数摘要；
 * 无 content 的消息标注"（无文本内容）"。
 */
function _formatMessagesAsMarkdown(
  messages: unknown[],
  sessionId: string,
): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return `# 对话导出\n\n> Session: ${sessionId}\n\n_该对话暂无消息。_\n`
  }

  const header = `# 对话导出\n\n> Session: ${sessionId}\n> 共 ${messages.length} 条消息\n\n---\n\n`

  const body = messages.map((rawMsg: unknown) => {
    const msg = (rawMsg ?? {}) as Record<string, unknown>
    const role = String(msg.role ?? 'unknown')
    const label = _ROLE_LABELS[role] ?? role

    // 时间戳行（created_at / timestamp 两种常见字段名）
    const ts = msg.created_at ?? msg.timestamp
    const timeLine = ts ? `> ${String(ts)}\n\n` : ''

    // 正文内容（tool 角色优先展示 tool_call_id 元信息 + content）
    let content = ''
    if (role === 'tool' && msg.tool_call_id) {
      // 工具调用结果：展示 tool_call_id + 工具名
      const toolName = msg.name ?? msg.tool_name ?? '未知工具'
      content = `**工具**: ${String(toolName)}\n**调用 ID**: \`${String(msg.tool_call_id)}\``
      if (typeof msg.content === 'string') {
        content += `\n\n${msg.content}`
      }
    } else if (typeof msg.content === 'string' && msg.content.length > 0) {
      content = msg.content
    } else if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // assistant 发起的工具调用
      content = msg.tool_calls.map((tc: Record<string, unknown>) => {
        const fn = tc.function as Record<string, unknown> | undefined
        const name = fn?.name ?? tc.name ?? '未知工具'
        const args = fn?.arguments ?? tc.arguments ?? ''
        return `**调用工具**: \`${String(name)}\`\n\`\`\`json\n${String(args)}\n\`\`\``
      }).join('\n\n')
    } else {
      content = '_（无文本内容）_'
    }

    return `## ${label}\n${timeLine}${content}\n\n---\n`
  }).join('\n')

  return header + body
}

// ─── Surface 定义 ────────────────────────────────────────────────

export const chatExportMd = definePlatformSurface({
  module: 'chat',
  verb: 'export-md',
  kind: 'local',
  errorCodes: ['NOT_FOUND', 'VALIDATION_ERROR'] as const,
  bindings: { ipc: true, http: true },
  aliases: ['chat/export'],

  handler: async (
    input: ChatExportMdInput,
    ctx,
  ): Promise<ChatExportMdOutput> => {
    // ── 1. 校验必填字段 ──
    if (!input?.sessionId) {
      throw new SurfaceError('VALIDATION_ERROR', 'sessionId 是必填参数')
    }

    // ── 2. 调 Django API 获取消息列表 ──
    // djangoRequest 路径以 /api/ 开头（跟 cli-routes 现有用法一致，
    // 如 /api/tabdata/tables/...）。Django 路由结构：
    //   urls.py path('api/', api.urls) → chat router → /sessions/{id}/messages
    const result = await ctx.djangoRequest(
      'GET',
      `/api/chat/sessions/${input.sessionId}/messages`,
    )

    if (result.status === 404) {
      throw new SurfaceError(
        'NOT_FOUND',
        `会话 ${input.sessionId} 不存在`,
      )
    }

    // 非成功状态码（403/500 等）不能当成功数据处理，
    // 直接抛 Error（不是 SurfaceError）让 adapter 兜底为 INTERNAL_ERROR
    if (result.status >= 400) {
      throw new Error(
        `获取消息失败: Django 返回 HTTP ${result.status}`,
      )
    }

    // ── 3. 解析消息、拼 Markdown ──
    const messages: unknown[] = result.data?.data ?? result.data ?? []
    const messagesArray = Array.isArray(messages) ? messages : []
    const markdown = _formatMessagesAsMarkdown(messagesArray, input.sessionId)

    return {
      markdown,
      messageCount: messagesArray.length,
    }
  },
})
