/**
 * deriveAgentTerminalSpaceId 单测（R3 P1-5 治本）
 *
 * 这个启发式正则从复合 agent sessionId 反解 spaceId，是 B2 重载回填的护栏——
 * 之前零测试，正则一旦漂移（贪婪匹配 / 时间戳位数 / rand 后缀）会静默 derive 出
 * 错误 spaceId 或 null，让回填把 PTY 归错 Agent 分组、或漏回填。
 *
 * 两条产线 sessionId 形态（与生产端对齐）：
 *   - bridge 路径：`agent-{spaceId}-{ts}-{rand4}`（agent-bridge 末尾带随机后缀）
 *   - PtyManager 人控路径：`agent-{spaceId}-{ts}`（无 rand）
 * spaceId 本身可能是 UUID 形（含数字 + 横杠），不能被贪婪正则吃进时间戳段。
 */

import { describe, it, expect } from 'vitest'
import {
  deriveAgentTerminalSpaceId,
  isTerminalTabScopeKey,
  resolveTerminalSessionSpaceId,
} from './terminal'

describe('deriveAgentTerminalSpaceId', () => {
  it('bridge 路径带 rand 后缀 `agent-{spaceId}-{ts}-{rand4}` → 反解出 spaceId', () => {
    expect(deriveAgentTerminalSpaceId('agent-myspace-1700000000000-a1b2')).toBe('myspace')
  })

  it('PtyManager 人控路径无 rand `agent-{spaceId}-{ts}` → 反解出 spaceId', () => {
    expect(deriveAgentTerminalSpaceId('agent-myspace-1700000000000')).toBe('myspace')
  })

  it('spaceId 含数字（简单形）不被时间戳段吃掉', () => {
    expect(deriveAgentTerminalSpaceId('agent-team42-1700000000000')).toBe('team42')
  })

  it('spaceId 为 UUID 形（含数字 + 横杠）→ 完整反解、不被贪婪正则截断', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    expect(deriveAgentTerminalSpaceId(`agent-${uuid}-1700000000000`)).toBe(uuid)
  })

  it('UUID 形 spaceId + rand 后缀 → 仍完整反解 spaceId', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    expect(deriveAgentTerminalSpaceId(`agent-${uuid}-1700000000000-9f3c`)).toBe(uuid)
  })

  it('非 agent- 前缀（用户终端 / 其他）→ null', () => {
    expect(deriveAgentTerminalSpaceId('terminal-myspace-1700000000000')).toBeNull()
  })

  it('无时间戳段 → null', () => {
    expect(deriveAgentTerminalSpaceId('agent-justaname')).toBeNull()
  })

  it('数字段太短（不足 10 位时间戳）→ null', () => {
    expect(deriveAgentTerminalSpaceId('agent-myspace-12345')).toBeNull()
  })

  it('null / undefined / 空串 → null', () => {
    expect(deriveAgentTerminalSpaceId(null)).toBeNull()
    expect(deriveAgentTerminalSpaceId(undefined)).toBeNull()
    expect(deriveAgentTerminalSpaceId('')).toBeNull()
  })
})

describe('isTerminalTabScopeKey', () => {
  it('conversation:/desktop: 前缀为 scope 桶 key', () => {
    expect(isTerminalTabScopeKey('conversation:session-1')).toBe(true)
    expect(isTerminalTabScopeKey('desktop:organization:wt-1:user:u-1')).toBe(true)
  })

  it('真实 Space id 不是 scope 桶 key', () => {
    expect(isTerminalTabScopeKey('space-1')).toBe(false)
    expect(isTerminalTabScopeKey('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(false)
  })
})

describe('resolveTerminalSessionSpaceId', () => {
  it('优先 executionSpaceId，忽略 scope 桶 spaceId（ Bug A）', () => {
    expect(resolveTerminalSessionSpaceId({
      sessionFromStore: {
        spaceId: 'conversation:chat-1',
        executionSpaceId: 'space-real',
      },
      hiddenTranscriptSpaceId: 'space-transcript',
      spaceIdProp: 'space-prop',
      sessionId: 'agent-space-real-1700000000000',
    })).toBe('space-real')
  })

  it('store spaceId 为真实 Space 时仍可用', () => {
    expect(resolveTerminalSessionSpaceId({
      sessionFromStore: { spaceId: 'space-legacy' },
    })).toBe('space-legacy')
  })

  it('store 只有 scope 桶 key 时走 transcript / prop / derive 兜底链', () => {
    expect(resolveTerminalSessionSpaceId({
      sessionFromStore: { spaceId: 'desktop:organization:wt-1:user:u-1' },
      hiddenTranscriptSpaceId: 'space-from-transcript',
    })).toBe('space-from-transcript')

    expect(resolveTerminalSessionSpaceId({
      sessionFromStore: { spaceId: 'conversation:chat-1' },
      spaceIdProp: 'space-from-prop',
      sessionId: 'agent-x-1700000000000',
    })).toBe('space-from-prop')

    expect(resolveTerminalSessionSpaceId({
      sessionFromStore: { spaceId: 'conversation:chat-1' },
      sessionId: 'agent-derived-1700000000000',
    })).toBe('derived')
  })
})
