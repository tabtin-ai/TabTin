/**
 * handoff 模块 — IM 上下文交接的 4 个 PlatformSurface（纯代理 Django）。
 *
 *   - handoff:create — 创建交接包（默认创建后立即发送）
 *   - handoff:send   — 发送草稿交接包（幂等）
 *   - handoff:get    — 交接包详情（含材料逐条鉴权结果）
 *   - handoff:list   — 会话内交接包列表
 *
 * CLI 形态：`tabtin invoke handoff create --json '{...}'` 等。
 * Agent 通过 create（send=false）代拟草稿，人确认后 send。
 * 后端权威实现见 apps/tabtin_django/apps/tabchat/handoff/。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'
import type { SurfaceContext } from '../surface/types.js'

// ─── 输入 / 输出类型 ──────────────────────────────────────────────
// 注意：codegen（scripts/electron/codegen-surface-preload.ts）按约定取文件中
// 第一个 `XxxInput` / `XxxOutput` 接口作为主 surface 的签名，因此
// HandoffCreateInput / HandoffCreateOutput 必须最先声明，条目/引用
// 结构体不以 Input/Output 结尾。

export interface HandoffCreateInput {
  conversationId: string
  goal: string
  progress?: HandoffChecklistEntry[]
  nextSteps?: HandoffChecklistEntry[]
  risks?: HandoffChecklistEntry[]
  scope?: 'view_only' | 'continuable'
  recipients: string[]
  references?: HandoffReferenceSpec[]
  /** false = 只建草稿不发送（Agent 代拟场景）；默认 true */
  send?: boolean
}

/** 后端 serialize_package 的原样透传（详情结构以 Django 为权威）。 */
export interface HandoffCreateOutput {
  [key: string]: unknown
}

export interface HandoffChecklistEntry {
  text: string
  checked?: boolean
  high_risk?: boolean
}

export interface HandoffReferenceSpec {
  ref_type: 'im_message' | 'document' | 'table' | 'attachment' | 'chat_session'
  resource_id: string
}

export interface HandoffSendParams {
  handoffId: string
}

export interface HandoffGetParams {
  handoffId: string
}

export interface HandoffListParams {
  conversationId: string
}

export type HandoffPackageOutput = HandoffCreateOutput

export interface HandoffListResult {
  items: HandoffPackageOutput[]
}

// ─── Django ApiResponse 解包 ─────────────────────────────────────

/**
 * tabchat ApiResponse 统一形态 {success, message, code, data}，HTTP 状态恒 200，
 * 业务失败靠 body.success=false + code 表达——这里翻译成 SurfaceError。
 */
async function _unwrapApiResponse(
  ctx: SurfaceContext,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const result = await ctx.djangoRequest(method, path, body)
  if (result.status === 404) {
    throw new SurfaceError('NOT_FOUND', `接口不存在: ${path}`)
  }
  if (result.status >= 400) {
    throw new Error(`Django 返回 HTTP ${result.status}`)
  }
  const envelope = (result.data ?? {}) as Record<string, unknown>
  if (envelope.success === false) {
    const code = Number(envelope.code ?? 400)
    const message = String(envelope.message ?? '操作失败')
    if (code === 403) throw new SurfaceError('PERMISSION_DENIED', message)
    if (code === 404) throw new SurfaceError('NOT_FOUND', message)
    throw new SurfaceError('VALIDATION_ERROR', message)
  }
  return (envelope.data ?? {}) as Record<string, unknown>
}

// ─── Surface 定义 ────────────────────────────────────────────────

export const handoffCreate = definePlatformSurface({
  module: 'handoff',
  verb: 'create',
  kind: 'proxied',
  risk: 'write',
  errorCodes: ['VALIDATION_ERROR', 'PERMISSION_DENIED', 'NOT_FOUND'] as const,
  bindings: { ipc: false, http: true },

  handler: async (
    input: HandoffCreateInput,
    ctx,
  ): Promise<HandoffPackageOutput> => {
    if (!input?.conversationId) {
      throw new SurfaceError('VALIDATION_ERROR', 'conversationId 是必填参数')
    }
    if (!input?.goal?.trim()) {
      throw new SurfaceError('VALIDATION_ERROR', 'goal 是必填参数')
    }
    if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
      throw new SurfaceError('VALIDATION_ERROR', 'recipients 至少一个接收者')
    }
    return _unwrapApiResponse(ctx, 'POST', '/api/im/handoffs', {
      conversation_id: input.conversationId,
      goal: input.goal,
      progress: input.progress ?? [],
      next_steps: input.nextSteps ?? [],
      risks: input.risks ?? [],
      scope: input.scope ?? 'continuable',
      recipients: input.recipients,
      references: input.references ?? [],
      send: input.send ?? true,
    })
  },
})

export const handoffSend = definePlatformSurface({
  module: 'handoff',
  verb: 'send',
  kind: 'proxied',
  risk: 'write',
  errorCodes: ['VALIDATION_ERROR', 'PERMISSION_DENIED', 'NOT_FOUND'] as const,
  bindings: { ipc: false, http: true },

  handler: async (
    input: HandoffSendParams,
    ctx,
  ): Promise<HandoffPackageOutput> => {
    if (!input?.handoffId) {
      throw new SurfaceError('VALIDATION_ERROR', 'handoffId 是必填参数')
    }
    return _unwrapApiResponse(
      ctx, 'POST', `/api/im/handoffs/${input.handoffId}/send`, {},
    )
  },
})

export const handoffGet = definePlatformSurface({
  module: 'handoff',
  verb: 'get',
  kind: 'proxied',
  errorCodes: ['VALIDATION_ERROR', 'PERMISSION_DENIED', 'NOT_FOUND'] as const,
  bindings: { ipc: false, http: true },

  handler: async (
    input: HandoffGetParams,
    ctx,
  ): Promise<HandoffPackageOutput> => {
    if (!input?.handoffId) {
      throw new SurfaceError('VALIDATION_ERROR', 'handoffId 是必填参数')
    }
    return _unwrapApiResponse(
      ctx, 'GET', `/api/im/handoffs/${input.handoffId}`,
    )
  },
})

export const handoffList = definePlatformSurface({
  module: 'handoff',
  verb: 'list',
  kind: 'proxied',
  errorCodes: ['VALIDATION_ERROR', 'PERMISSION_DENIED', 'NOT_FOUND'] as const,
  bindings: { ipc: false, http: true },

  handler: async (
    input: HandoffListParams,
    ctx,
  ): Promise<HandoffListResult> => {
    if (!input?.conversationId) {
      throw new SurfaceError('VALIDATION_ERROR', 'conversationId 是必填参数')
    }
    const data = await _unwrapApiResponse(
      ctx,
      'GET',
      `/api/im/handoffs?conversation_id=${encodeURIComponent(input.conversationId)}`,
    )
    return { items: (data.items ?? []) as HandoffPackageOutput[] }
  },
})
