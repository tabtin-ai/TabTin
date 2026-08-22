import { describe, expect, it } from 'vitest'
import { resolveSpaceSessionPointerAction } from '../resolveSpaceSessionPointer'

describe('resolveSpaceSessionPointerAction', () => {
  const spaceASession = { id: 'session-a' }
  const spaceBSession = { id: 'session-b' }

  it('空列表 Space：清掉仍指向外组织的全局 currentSessionId', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-a',
      rememberedSessionId: null,
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'draft' })
  })

  it('#11070 已在草稿且全局是他 Space 会话：不再 draft，避免多栏互抢指针', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-a',
      rememberedSessionId: null,
      inDraft: true,
      spaceSessions: [spaceBSession],
      trackerRunSessions: [],
      visibleSessions: [spaceBSession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'noop' })
  })

  it('#11070 已在草稿且全局仍是本 Space 旧记忆：再 draft 清本栏指针', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-b',
      rememberedSessionId: 'session-b',
      inDraft: true,
      spaceSessions: [spaceBSession],
      trackerRunSessions: [],
      visibleSessions: [spaceBSession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'draft' })
  })

  it('已在草稿且全局已空：幂等 noop（避免重复 prefetch）', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: null,
      rememberedSessionId: null,
      inDraft: true,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'noop' })
  })

  it('切回 Space：恢复 currentSessionIdBySpaceId 记忆，不因全局 null 误抹', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: null,
      rememberedSessionId: 'session-a',
      inDraft: false,
      spaceSessions: [spaceASession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'restore', sessionId: 'session-a' })
  })

  it('切回 Space：全局仍是外组织会话时，用本 Space 记忆覆盖', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-b',
      rememberedSessionId: 'session-a',
      inDraft: false,
      spaceSessions: [spaceASession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'restore', sessionId: 'session-a' })
  })

  it('记忆已与全局一致：noop', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-a',
      rememberedSessionId: 'session-a',
      inDraft: false,
      spaceSessions: [spaceASession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'noop' })
  })

  it('#8724 无记忆但全局仅在 org 合并列表（他 Workspace）：draft 清串台', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-a',
      rememberedSessionId: null,
      inDraft: false,
      spaceSessions: [spaceBSession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession, spaceBSession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'draft' })
  })

  it('无记忆且全局属于本 Space 桶：保持', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-b',
      rememberedSessionId: null,
      inDraft: false,
      spaceSessions: [spaceBSession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession, spaceBSession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'noop' })
  })

  it('新建空 Workspace：本 Space 无会话，org 合并列表仍含他 Workspace 会话 → 必须进草稿', () => {
    // 回归：创建 Workspace 后只 selectSpace 时，ChatPanel 传入的 sessions 是
    // organization 合并列表；若此处因「全局仍可见」noop，就不会自动进新任务。
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-a',
      rememberedSessionId: null,
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'draft' })
  })

  it('Tracker Run 记忆可恢复（不在主列表）', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: null,
      rememberedSessionId: 'tracker-run-1',
      inDraft: false,
      spaceSessions: [spaceASession],
      trackerRunSessions: [{ id: 'tracker-run-1' }],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'restore', sessionId: 'tracker-run-1' })
  })

  it('记忆已不在本 Space：进草稿', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-a',
      rememberedSessionId: 'session-gone',
      inDraft: false,
      spaceSessions: [spaceASession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'draft' })
  })

  it('记忆不在主列表但全局已对齐：保持（Project 任务 stub 刚点开）', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-stub',
      rememberedSessionId: 'session-stub',
      inDraft: false,
      spaceSessions: [spaceASession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'noop' })
  })

  it('桶未加载：有记忆则先 restore，避免闪旧组织正文', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-b',
      rememberedSessionId: 'session-a',
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      spaceSessionsLoaded: false,
    })).toEqual({ type: 'restore', sessionId: 'session-a' })
  })

  it('桶未加载：无记忆且全局非空 → draft 清串台', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-a',
      rememberedSessionId: null,
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      spaceSessionsLoaded: false,
    })).toEqual({ type: 'draft' })
  })

  it('#6697 local-pending 首发占位不因不在列表被打回草稿', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'local-pending-abc',
      rememberedSessionId: null,
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'noop' })
  })

  it('#6697 local-pending 即使 draft 旗标仍在也不清全局', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'local-pending-abc',
      rememberedSessionId: null,
      inDraft: true,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [],
      spaceSessionsLoaded: true,
    })).toEqual({ type: 'noop' })
  })

  it('#7903 外部已展开记忆不在列表：restore，不 draft', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: null,
      rememberedSessionId: 'ext-opened-1',
      inDraft: false,
      spaceSessions: [spaceASession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
      externallyOpenedSessionIds: new Set(['ext-opened-1']),
    })).toEqual({ type: 'restore', sessionId: 'ext-opened-1' })
  })

  it('草稿态下即使记忆是外部已展开会话：也不 restore（新任务优先）', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: null,
      rememberedSessionId: 'ext-opened-1',
      inDraft: true,
      spaceSessions: [spaceASession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
      externallyOpenedSessionIds: new Set(['ext-opened-1']),
    })).toEqual({ type: 'noop' })
  })

  it('草稿态且全局仍指向外部已展开：再 draft 清全局，不 restore', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'ext-opened-1',
      rememberedSessionId: 'ext-opened-1',
      inDraft: true,
      spaceSessions: [spaceASession],
      trackerRunSessions: [],
      visibleSessions: [spaceASession],
      spaceSessionsLoaded: true,
      externallyOpenedSessionIds: new Set(['ext-opened-1']),
    })).toEqual({ type: 'draft' })
  })

  it('#7903 外部已展开且全局已对齐：noop（list 竞态中保活）', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'ext-opened-1',
      rememberedSessionId: 'ext-opened-1',
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [],
      spaceSessionsLoaded: true,
      externallyOpenedSessionIds: new Set(['ext-opened-1']),
    })).toEqual({ type: 'noop' })
  })

  it('#7903+#7672 他 Space 外部会话残留在全局、本 Space无记忆：仍 draft 清串台', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'ext-opened-other-space',
      rememberedSessionId: null,
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [],
      spaceSessionsLoaded: true,
      externallyOpenedSessionIds: new Set(['ext-opened-other-space']),
    })).toEqual({ type: 'draft' })
  })

  it('#10951 显式打开指定会话：空桶 + 失效指针也不能 draft', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-other',
      rememberedSessionId: 'dead-pointer',
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [],
      spaceSessionsLoaded: true,
      explicitTargetSessionId: 'session-b',
    })).toEqual({ type: 'noop' })
  })

  it('#10951 显式打开指定会话：桶未加载也不按旧记忆 restore', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-other',
      rememberedSessionId: 'session-old',
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      spaceSessionsLoaded: false,
      explicitTargetSessionId: 'session-b',
    })).toEqual({ type: 'noop' })
  })

  it('#10951+#6697 local-pending 仍优先于显式目标，保持 noop', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'local-pending-abc',
      rememberedSessionId: null,
      inDraft: false,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [],
      spaceSessionsLoaded: true,
      explicitTargetSessionId: 'session-b',
    })).toEqual({ type: 'noop' })
  })

  it('#10951 显式打开指定会话：即使已在草稿旗标下也不再 draft', () => {
    expect(resolveSpaceSessionPointerAction({
      globalCurrentSessionId: 'session-other',
      rememberedSessionId: null,
      inDraft: true,
      spaceSessions: [],
      trackerRunSessions: [],
      visibleSessions: [],
      spaceSessionsLoaded: true,
      explicitTargetSessionId: 'session-b',
    })).toEqual({ type: 'noop' })
  })
})
