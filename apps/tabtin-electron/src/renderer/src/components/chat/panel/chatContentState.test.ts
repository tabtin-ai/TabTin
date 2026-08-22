import { describe, expect, it } from 'vitest'
import {
  resolveCanChangeAgent,
  resolveCanSwitchDraftWorkspace,
  resolveNewTaskWelcomeVisible,
  resolveWelcomeSuggestionBarVisible,
  resolveWelcomeComposerTop,
} from './chatContentState'

describe('resolveNewTaskWelcomeVisible', () => {
  it('预热会话取得真实 sessionId 后仍保持新任务欢迎态', () => {
    expect(resolveNewTaskWelcomeVisible({
      currentSessionId: 'prefetched-session',
      currentSessionMessageCount: 0,
      localMessageCount: 0,
      isDraftSession: false,
      isLoading: false,
    })).toBe(true)
  })

  it('首条本地用户消息写入后立即退出欢迎态', () => {
    expect(resolveNewTaskWelcomeVisible({
      currentSessionId: 'prefetched-session',
      currentSessionMessageCount: 0,
      localMessageCount: 1,
      isDraftSession: false,
      isLoading: false,
    })).toBe(false)
  })

  it('draft 旗标仍在但已有本地消息时也退出欢迎态', () => {
    expect(resolveNewTaskWelcomeVisible({
      currentSessionId: 'local-pending-abc',
      currentSessionMessageCount: null,
      localMessageCount: 1,
      isDraftSession: true,
      isLoading: false,
    })).toBe(false)
  })

  it('加载已有会话时不误显示新任务欢迎态', () => {
    expect(resolveNewTaskWelcomeVisible({
      currentSessionId: 'existing-session',
      currentSessionMessageCount: 3,
      localMessageCount: 0,
      isDraftSession: false,
      isLoading: true,
    })).toBe(false)
  })

  it('会话元数据尚未进入缓存时不把未知状态误判为空会话', () => {
    expect(resolveNewTaskWelcomeVisible({
      currentSessionId: 'metadata-pending-session',
      currentSessionMessageCount: null,
      localMessageCount: 0,
      isDraftSession: false,
      isLoading: false,
    })).toBe(false)
  })
})

describe('resolveWelcomeSuggestionBarVisible', () => {
  it('空白新任务且未打开 App 时显示欢迎入口', () => {
    expect(resolveWelcomeSuggestionBarVisible({
      isNewTaskWelcome: true,
      hasOpenApp: false,
    })).toBe(true)
  })

  it('已有消息的普通会话不显示入口，即使没有打开 App', () => {
    expect(resolveWelcomeSuggestionBarVisible({
      isNewTaskWelcome: false,
      hasOpenApp: false,
    })).toBe(false)
  })

  it('已打开 App 的新任务不显示入口，交给应用欢迎态处理', () => {
    expect(resolveWelcomeSuggestionBarVisible({
      isNewTaskWelcome: true,
      hasOpenApp: true,
    })).toBe(false)
  })
})

describe('resolveWelcomeComposerTop', () => {
  it('围绕既有中心线按欢迎组高度向上移动，并由 CSS max 钳制顶部安全线', () => {
    expect(resolveWelcomeComposerTop(240)).toBe(
      'max(16px, calc(50% - 25px - 120px))',
    )
    expect(resolveWelcomeComposerTop(560)).toBe(
      'max(16px, calc(50% - 25px - 280px))',
    )
  })

  it('忽略非法或负数测量，避免瞬时 ResizeObserver 值把欢迎组顶出画布', () => {
    expect(resolveWelcomeComposerTop(-10)).toBe(
      'max(16px, calc(50% - 25px - 0px))',
    )
    expect(resolveWelcomeComposerTop(Number.NaN)).toBe(
      'max(16px, calc(50% - 25px - 0px))',
    )
  })
})

describe('resolveCanSwitchDraftWorkspace / resolveCanChangeAgent ', () => {
  it('个人正式会话：可换 Agent，不可切工作空间', () => {
    expect(resolveCanChangeAgent({ isTeamDraftSpace: false })).toBe(true)
    expect(resolveCanSwitchDraftWorkspace({
      isTeamDraftSpace: false,
      isDraftSession: false,
      currentSessionId: 'session-1',
      draftSessionPhase: null,
    })).toBe(false)
  })

  it('个人新任务草稿：Agent 与工作空间都可切', () => {
    expect(resolveCanChangeAgent({ isTeamDraftSpace: false })).toBe(true)
    expect(resolveCanSwitchDraftWorkspace({
      isTeamDraftSpace: false,
      isDraftSession: true,
      currentSessionId: null,
      draftSessionPhase: 'open',
    })).toBe(true)
  })

  it('draft episode 仍 open 时工作空间可切（bootstrap 后 marker 已清）', () => {
    expect(resolveCanSwitchDraftWorkspace({
      isTeamDraftSpace: false,
      isDraftSession: false,
      currentSessionId: 'prefetched',
      draftSessionPhase: 'open',
    })).toBe(true)
  })

  it('团队 Space：Agent 与工作空间均锁死', () => {
    expect(resolveCanChangeAgent({ isTeamDraftSpace: true })).toBe(false)
    expect(resolveCanSwitchDraftWorkspace({
      isTeamDraftSpace: true,
      isDraftSession: true,
      currentSessionId: null,
      draftSessionPhase: 'open',
    })).toBe(false)
  })
})
