/**
 * SpeakerRegistryStore — 维护当前 session 下所有 speaker（说话者）的身份信息。
 *
 * 数据来源：SUBAGENT_STARTED 事件里携带的 speaker 字段，由 subagentHandler 调用
 * registerSpeaker 写入。
 *
 * 消费端：SpeakerBadge / SubagentProgressCard 通过 getSpeaker(speakerId) 查询
 * 可读身份信息（display_name / display_color / source 等）。
 */

import { create } from 'zustand'
import type { SpeakerIdentity } from '@tabtin/agent-wire'

export interface SpeakerRegistryState {
  /**
   * 按 sessionId 隔离的 speaker 字典。
   * key1 = sessionId, key2 = speaker_id, value = SpeakerIdentity
   */
  speakersBySessionId: Record<string, Record<string, SpeakerIdentity>>

  registerSpeaker: (sessionId: string, speaker: SpeakerIdentity) => void
  getSpeaker: (sessionId: string, speakerId: string) => SpeakerIdentity | undefined
  clearForSession: (sessionId: string) => void
  reset: () => void
}

export const useSpeakerRegistryStore = create<SpeakerRegistryState>()((set, get) => ({
  speakersBySessionId: {},

  registerSpeaker: (sessionId, speaker) => {
    set((state) => {
      const sessionSpeakers = state.speakersBySessionId[sessionId] ?? {}
      if (sessionSpeakers[speaker.speaker_id] === speaker) return state
      return {
        speakersBySessionId: {
          ...state.speakersBySessionId,
          [sessionId]: {
            ...sessionSpeakers,
            [speaker.speaker_id]: speaker,
          },
        },
      }
    })
  },

  getSpeaker: (sessionId, speakerId) => {
    return get().speakersBySessionId[sessionId]?.[speakerId]
  },

  clearForSession: (sessionId) => {
    set((state) => {
      const { [sessionId]: _, ...rest } = state.speakersBySessionId
      return { speakersBySessionId: rest }
    })
  },

  reset: () => {
    set({ speakersBySessionId: {} })
  },
}))

import { registerResetAction } from './sessionResetRegistry'
registerResetAction('speaker-registry', 'reset', () => useSpeakerRegistryStore.getState().reset())
