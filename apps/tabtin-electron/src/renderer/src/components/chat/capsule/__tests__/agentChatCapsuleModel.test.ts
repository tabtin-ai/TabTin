import { describe, expect, it } from 'vitest'
import {
  resolveCapsuleActivity,
  resolveCapsulePausedFromRunStatus,
  resolveCapsuleStatus,
} from '../agentChatCapsuleModel'

const msg = (id: string, role: string, ts: number) => ({
  id, role, created_at: ts,
})

describe('resolveCapsuleActivity', () => {
  it('未读只统计 seenUntilTs 之后的 assistant 消息', () => {
    const activity = resolveCapsuleActivity([
      msg('1', 'user', 100),
      msg('2', 'assistant', 200),
      msg('3', 'assistant', 300),
    ], 200)
    expect(activity.unreadCount).toBe(1)
  })

  it('只返回状态所需的未读计数，不携带 Agent 原始输出', () => {
    expect(resolveCapsuleActivity([], 0)).toEqual({ unreadCount: 0 })
  })

  it('created_at 为 ISO 字符串时也能比较', () => {
    const activity = resolveCapsuleActivity([
      { id: '1', role: 'assistant', created_at: '2026-07-23T06:00:00Z' },
    ], Date.parse('2026-07-23T05:00:00Z'))
    expect(activity.unreadCount).toBe(1)
  })
})

describe('resolveCapsuleStatus', () => {
  it('人工介入优先于普通运行态', () => {
    expect(resolveCapsuleStatus({
      busy: true,
      runPhase: 'tool_calls',
      pendingApproval: true,
    })).toBe('needsApproval')
    expect(resolveCapsuleStatus({
      busy: true,
      runPhase: 'planning',
      pendingAnswer: true,
    })).toBe('needsAnswer')
  })

  it('把运行阶段压缩成稳定的产品状态', () => {
    expect(resolveCapsuleStatus({ busy: true, runPhase: 'planning' })).toBe('thinking')
    expect(resolveCapsuleStatus({
      busy: true,
      runPhase: 'planning',
      completedToolCalls: 1,
    })).toBe('planningNext')
    expect(resolveCapsuleStatus({ busy: true, runPhase: 'tool_calls' })).toBe('working')
    expect(resolveCapsuleStatus({ busy: true, runPhase: 'synthesizing' })).toBe('finishing')
    expect(resolveCapsuleStatus({ busy: true, runPhase: 'done', queuedCount: 2 })).toBe('queued')
  })

  it('执行结束后区分完成未读、异常、停止与待命', () => {
    expect(resolveCapsuleStatus({ busy: false, unreadCount: 2 })).toBe('complete')
    expect(resolveCapsuleStatus({ busy: false, runPhase: 'error', unreadCount: 2 })).toBe('error')
    expect(resolveCapsuleStatus({ busy: false, runPhase: 'cancelled' })).toBe('stopped')
    expect(resolveCapsuleStatus({ busy: false })).toBe('ready')
  })

  it('paused 优先于 busy，且不是 stopped / recovering', () => {
    expect(resolveCapsuleStatus({
      busy: true,
      runPhase: 'tool_calls',
      paused: true,
    })).toBe('paused')
    expect(resolveCapsuleStatus({
      busy: false,
      paused: true,
      suspended: true,
    })).toBe('paused')
    expect(resolveCapsuleStatus({
      busy: false,
      runPhase: 'cancelled',
      paused: true,
    })).toBe('paused')
  })

  it('paused 低于人工介入，高于连接恢复', () => {
    expect(resolveCapsuleStatus({
      busy: true,
      paused: true,
      pendingApproval: true,
    })).toBe('needsApproval')
    expect(resolveCapsuleStatus({
      busy: true,
      runPhase: 'tool_calls',
      suspended: true,
    })).toBe('recovering')
  })
})

describe('resolveCapsulePausedFromRunStatus', () => {
  it('仅 ChatSessionRunStatus === paused 时为 true', () => {
    expect(resolveCapsulePausedFromRunStatus('paused')).toBe(true)
    expect(resolveCapsulePausedFromRunStatus('running')).toBe(false)
    expect(resolveCapsulePausedFromRunStatus('waiting_user')).toBe(false)
    expect(resolveCapsulePausedFromRunStatus('cancelled')).toBe(false)
    expect(resolveCapsulePausedFromRunStatus(null)).toBe(false)
    expect(resolveCapsulePausedFromRunStatus(undefined)).toBe(false)
  })
})
