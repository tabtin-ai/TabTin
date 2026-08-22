import type { ChatSession } from '@tabtin/chat-client'
import { PERSIST_KEYS } from '@/stores/persist-key-registry'
import { isOpenAICodexModel } from '../../../../../shared/openai-codex-models'

type StoredSelection = {
  modelId: string
  updatedAt: number
}

type StoredState = {
  version: 1
  sessions: Record<string, StoredSelection>
}

const MAX_STORED_SESSIONS = 500

function readState(): StoredState {
  if (typeof window === 'undefined') return { version: 1, sessions: {} }
  try {
    const raw = window.localStorage.getItem(PERSIST_KEYS.localSessionModels)
    if (!raw) return { version: 1, sessions: {} }
    const parsed = JSON.parse(raw) as Partial<StoredState>
    if (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
      return { version: 1, sessions: {} }
    }
    const sessions: Record<string, StoredSelection> = {}
    for (const [sessionId, value] of Object.entries(parsed.sessions)) {
      if (!value || typeof value !== 'object') continue
      const modelId = (value as Partial<StoredSelection>).modelId?.trim()
      const updatedAt = (value as Partial<StoredSelection>).updatedAt
      if (!sessionId.trim() || !modelId || !isOpenAICodexModel(modelId)) continue
      sessions[sessionId] = {
        modelId,
        updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
      }
    }
    return { version: 1, sessions }
  } catch {
    return { version: 1, sessions: {} }
  }
}

function writeState(state: StoredState): void {
  if (typeof window === 'undefined') return
  try {
    const entries = Object.entries(state.sessions)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_STORED_SESSIONS)
    if (entries.length === 0) {
      window.localStorage.removeItem(PERSIST_KEYS.localSessionModels)
      return
    }
    window.localStorage.setItem(PERSIST_KEYS.localSessionModels, JSON.stringify({
      version: 1,
      sessions: Object.fromEntries(entries),
    } satisfies StoredState))
  } catch {
    // 本地偏好写失败不阻断会话切模。
  }
}

export function readSessionLocalModelPreference(sessionId: string): string | null {
  return readState().sessions[sessionId.trim()]?.modelId ?? null
}

export function writeSessionLocalModelPreference(sessionId: string, modelId: string): void {
  const normalizedSessionId = sessionId.trim()
  const normalizedModelId = modelId.trim()
  if (!normalizedSessionId || !isOpenAICodexModel(normalizedModelId)) return
  const state = readState()
  state.sessions[normalizedSessionId] = { modelId: normalizedModelId, updatedAt: Date.now() }
  writeState(state)
}

export function clearSessionLocalModelPreference(sessionId: string): void {
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId) return
  const state = readState()
  if (!state.sessions[normalizedSessionId]) return
  delete state.sessions[normalizedSessionId]
  writeState(state)
}

/** ChatGPT 断开或授权失效后清掉所有仅本机可执行的会话选择。 */
export function clearAllSessionLocalModelPreferences(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(PERSIST_KEYS.localSessionModels)
  } catch {
    // localStorage 不可用时不阻断断开流程。
  }
}

/** 冷启动 list 时把 Django 的平台模型投影恢复为本机实际选择。 */
export function restoreSessionLocalModelPreference(session: ChatSession): ChatSession {
  const modelId = readSessionLocalModelPreference(session.id)
  if (!modelId) return session
  return {
    ...session,
    current_model_id: modelId,
    context_tier_id: null,
  }
}
