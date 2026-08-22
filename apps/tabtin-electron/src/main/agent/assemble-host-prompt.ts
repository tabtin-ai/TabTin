/**
 * Electron Host 侧发送前拼装薄包装：注入 TokenManager + API_BASE_URL。
 * 拼装逻辑在 `@tabtin/agent-host`；禁止再维护一份双协议实现。
 */

import {
  assembleHostPromptContext as assembleHostPromptContextShared,
  resolveHostContextBlocks as resolveHostContextBlocksShared,
  renderMcpFocusContext,
  filterHostPromptContextBlocks,
  type HostReplyToContext,
  type HostPromptLogger,
  type ResolveHostContextBlocksOptions,
} from '@tabtin/agent-host/conversation'
import { API_ENDPOINTS } from '@tabtin/config'
import { TokenManager } from '../auth.js'
import { API_BASE_URL } from '../config/api.js'

export {
  renderMcpFocusContext,
  filterHostPromptContextBlocks,
  type HostReplyToContext,
  type HostPromptLogger,
}

export async function resolveHostContextBlocks(
  blocks: Array<Record<string, unknown>>,
  opts?: Partial<ResolveHostContextBlocksOptions>,
): Promise<string> {
  return resolveHostContextBlocksShared(blocks, {
    apiBaseUrl: opts?.apiBaseUrl ?? API_BASE_URL,
    getAccessToken: opts?.getAccessToken ?? (() => TokenManager.getAccessToken()),
    fetchImpl: opts?.fetchImpl,
    organizationId: opts?.organizationId,
  })
}

export async function assembleHostPromptContext(params: {
  message: string
  replyTo?: HostReplyToContext
  contextBlocks?: Array<Record<string, unknown>>
  staleAfterTurn: string
  log: HostPromptLogger
  resolveContextBlocks?: (blocks: Array<Record<string, unknown>>) => Promise<string>
}): Promise<string> {
  return assembleHostPromptContextShared({
    ...params,
    resolveContextBlocks: params.resolveContextBlocks
      ?? ((blocks) => resolveHostContextBlocks(blocks)),
  })
}

/** 供测试 / 诊断：拼装模块不依赖 AUTH personal-rules 路径常量遗漏。 */
export const HOST_PERSONAL_RULES_PATH = API_ENDPOINTS.AUTH.PROFILE_PERSONAL_RULES
