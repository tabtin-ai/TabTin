/**
 * Agent Profile Hook —— 在内容变化时把当前 Agent 展示名 / 人设与规则注入
 * messages（贴当前 user 前），并随注入落库。
 *
 * **为什么不进 system prompt**：对话中可切换 Agent；静态 `<identity>`
 * 保持平台默认，per-Agent 名称 / `custom_rules`（配置页「人设与规则」）
 * 与 context / memory-recall 同构，贴当前 user 消息之前，切换后下一轮自然生效。
 * ：personal_rules 与 custom_rules 都是存量自由文本；不做自然语言分类，
 * 而是在这里按字段来源合成同一 user context（personal 在前、Agent 在后），
 * 当前真实 user 仍位于其后。
 *
 * **行为**：
 *   1. per-run 幂等闸门——本 run 已注入过则跳过
 *   2. 拉本轮 Agent 档案 + personal rules；全部为空 → 跳过
 *   3. fingerprint（section 正文）与历史最新 agent-profile 比较；相同 → 不重新注入
 *      （改规则 / 切 Agent 等场景 fingerprint 变才重新注入）
 *   4. 渲染 `<context type="agent-profile">` 插入：memory 后 / context 后 / 当前 user 前
 *   5. 有注入时由 prelude `emitPendingAgentProfilePhase` 落库
 */

import {
  buildAgentProfileSection,
  buildUserContextWrapper,
} from '@tabtin/agent-prompt'
import type { EngineHooks, IterationHookContext, Message } from '@tabtin/agent-runtime/engine'
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  findLastRealUserIndex,
  firstMessageText,
  findFirstUserContextWrapper,
} from '@tabtin/agent-runtime/engine'
import { upsertTaggedBlock } from './message-inject.js'

export interface AgentProfileSnapshot {
  agentName?: string | null
  /** 配置页「人设与规则」——`Agent.custom_rules` */
  customRules?: string | null
  /** ：当前 Workspace 现场规则——`Workspace.custom_rules` */
  workspaceRules?: string | null
}

export interface AgentProfileHookOptions {
  /**
   * 拉本轮当前 Agent 档案。每轮 beforeIteration 调用；宿主从 session 读
   * （与 `buildContextHook({ getAppContext })` 同构，支持对话中切 Agent）。
   */
  getAgentProfile: () => Promise<AgentProfileSnapshot | null | undefined> | AgentProfileSnapshot | null | undefined
  /**
   * Agent owner 的 `UserProfile.personal_rules`。它是创建期/cache-key 字段，
   * 已迁移宿主（当前 Electron）从 session 的 `personalRules` 读取；与动态
   * agent profile 在本 hook 合并成同一 user context。未提供此 getter 的宿主
   * 继续由 shared assembler 把 personal rules 留在 system。
   */
  getPersonalRules?: () => Promise<string | null | undefined> | string | null | undefined
}

const PROFILE_MARKER = INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION
const MEMORY_MARKER = INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION
const CONTEXT_MARKER = INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION

async function safeGetAgentProfile(
  getAgentProfile: AgentProfileHookOptions['getAgentProfile'],
): Promise<AgentProfileSnapshot | null | undefined> {
  try {
    return await getAgentProfile()
  } catch {
    return null
  }
}

async function safeGetPersonalRules(
  getPersonalRules: AgentProfileHookOptions['getPersonalRules'],
): Promise<string | null | undefined> {
  if (!getPersonalRules) return undefined
  try {
    return await getPersonalRules()
  } catch {
    return null
  }
}

/**
 * 从 messages 倒序找最后一条 agent-profile wrapper 的 section 正文（不含外层
 * `<context>`）。跳过本 run 的 fresh marker。用于变化检测。
 */
export function findLastAgentProfileSectionBody(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!
    if (msg.role !== 'user') continue
    if (hasInternalMarker(msg, PROFILE_MARKER)) continue
    const text = firstMessageText(msg)
    if (!text) continue
    const wrapper = findFirstUserContextWrapper(text.trimStart())
    if (wrapper && wrapper.startOffset === 0 && wrapper.type === 'agent-profile') {
      return wrapper.body
    }
  }
  return null
}

/**
 * 构造 agent-profile hook —— 内容变化时把个人 + Agent 长期自由文本
 * 渲染成 `<context type="agent-profile">` 贴当前 user 消息之前。
 */
export function buildAgentProfileHook(options: AgentProfileHookOptions): EngineHooks {
  const { getAgentProfile, getPersonalRules } = options

  return {
    async beforeIteration(ctx: IterationHookContext): Promise<void> {
      const state = ctx.state
      if (state.messages.some((m) => hasInternalMarker(m, PROFILE_MARKER))) return

      const [profile, personalRules] = await Promise.all([
        safeGetAgentProfile(getAgentProfile),
        safeGetPersonalRules(getPersonalRules),
      ])
      if (
        !profile?.agentName?.trim()
        && !profile?.customRules?.trim()
        && !profile?.workspaceRules?.trim()
        && !personalRules?.trim()
      ) {
        return
      }

      const body = buildAgentProfileSection({
        agentName: profile?.agentName ?? undefined,
        personalRules: personalRules ?? undefined,
        customRules: profile?.customRules ?? undefined,
        workspaceRules: profile?.workspaceRules ?? undefined,
      })
      if (!body) return

      const lastBody = findLastAgentProfileSectionBody(state.messages)
      if (lastBody !== null && lastBody === body) {
        // 未改规则 / 未切 Agent：不重新注入，依赖历史最新一份（LLM keep-latest）
        return
      }

      const content = buildUserContextWrapper('agent-profile', body)

      state.messages = upsertTaggedBlock(state.messages, {
        marker: PROFILE_MARKER,
        content,
        position: (filtered) => {
          const memoryIdx = filtered.findIndex((m) => hasInternalMarker(m, MEMORY_MARKER))
          if (memoryIdx >= 0) return memoryIdx + 1
          const ctxIdx = filtered.findIndex((m) => hasInternalMarker(m, CONTEXT_MARKER))
          if (ctxIdx >= 0) return ctxIdx + 1
          const userIdx = findLastRealUserIndex(filtered)
          return userIdx < 0 ? filtered.length : userIdx
        },
      })
    },
  }
}
