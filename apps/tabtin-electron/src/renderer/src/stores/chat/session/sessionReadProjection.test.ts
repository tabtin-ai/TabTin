import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import {
  hasSessionReadContract,
  getLatestCompletedReadTarget,
  mergeSessionReadStateFields,
  parseSessionReadState,
  resolveSessionHasUnreadReply,
} from './sessionReadProjection'

const session = (extra: Record<string, unknown> = {}) => ({
  id: 'session-1',
  ...extra,
}) as ChatSession
const readState = (
  readSequence: number,
  readRevision: number,
  latestSequence: number | null = readSequence,
  latestRevision: number | null = readRevision,
) => ({
  last_read_run_sequence: readSequence,
  last_read_terminal_revision: readRevision,
  read_at: '2026-07-29T00:00:00Z',
  latest_completed_run_id: latestSequence === null ? null : `run-${latestSequence}`,
  latest_completed_run_sequence: latestSequence,
  latest_completed_terminal_revision: latestRevision,
})

describe('sessionReadProjection', () => {
  it('新后端权威字段覆盖本机时间戳兜底', () => {
    expect(resolveSessionHasUnreadReply(
      session({ has_unread_reply: false, read_state: readState(0, 0, null, null) }),
      true,
    )).toBe(false)
    expect(resolveSessionHasUnreadReply(session({ has_unread_reply: false }), true)).toBe(true)
    expect(resolveSessionHasUnreadReply(session(), true)).toBe(true)
  })

  it('只以 read_state 键识别新契约', () => {
    expect(hasSessionReadContract(session({ has_unread_reply: false }))).toBe(false)
    expect(hasSessionReadContract(session({ read_state: null }))).toBe(true)
  })

  it('拒绝畸形游标', () => {
    expect(parseSessionReadState({
      last_read_run_sequence: Number.NaN,
      last_read_terminal_revision: 2,
      read_at: null,
      latest_completed_run_id: null,
      latest_completed_run_sequence: null,
      latest_completed_terminal_revision: null,
    })).toBeNull()
  })

  it('飞行中的旧 list 不覆盖较新的乐观 ACK', () => {
    const merged = mergeSessionReadStateFields(
      session({
        has_unread_reply: true,
        read_state: readState(3, 1, 4, 6),
        run_state: { sequence: 4 },
      }),
      session({
        has_unread_reply: false,
        read_state: readState(4, 6, 4, 6),
      }),
    ) as ChatSession & { has_unread_reply: boolean; read_state: { last_read_run_sequence: number } }
    expect(merged.has_unread_reply).toBe(false)
    expect(merged.read_state.last_read_run_sequence).toBe(4)
  })

  it('旧轮次 ACK 不能清除更新一轮的未读', () => {
    const merged = mergeSessionReadStateFields(
      session({
        has_unread_reply: true,
        read_state: readState(4, 2, 5, 3),
        run_state: { sequence: 5 },
      }),
      session({
        has_unread_reply: false,
        read_state: readState(4, 9, 4, 9),
      }),
    ) as ChatSession & { has_unread_reply: boolean }
    expect(merged.has_unread_reply).toBe(true)
  })

  it('已读游标相等时仍接受更新的 latest completed 事件', () => {
    const merged = mergeSessionReadStateFields(
      session({
        has_unread_reply: true,
        read_state: readState(4, 2, 5, 7),
      }),
      session({
        has_unread_reply: false,
        read_state: readState(4, 2, 4, 2),
      }),
    ) as ChatSession & {
      has_unread_reply: boolean
      read_state: { latest_completed_run_sequence: number }
    }
    expect(merged.has_unread_reply).toBe(true)
    expect(merged.read_state.latest_completed_run_sequence).toBe(5)
  })

  it('ACK 目标取 latest completed，不依赖当前 run_state', () => {
    expect(getLatestCompletedReadTarget(readState(3, 1, 7, 9))).toEqual({
      runId: 'run-7',
      sequence: 7,
      revision: 9,
    })
  })
})
