/**
 * buildRemoteAppContext 纯函数回归：remote Focus 与 local IPC 语义对齐，
 * 经模拟 Django normalize 后仍可解码；危险字段不透传。
 */
import { describe, expect, it } from 'vitest'
import { buildRemoteAppContext } from '../buildRemoteAppContext'

/**
 * 模拟 Django `normalize_focus_snapshot` 归并后的 Host Focus camel 语义
 *（只取跨端可比的身份字段，不复刻 appMeta 白名单细节）。
 */
function simulateDjangoNormalizedFocus(appContext: Record<string, unknown>) {
  return {
    appType: (appContext.appType ?? appContext.current_app_type ?? null) as string | null,
    appMeta: (appContext.appMeta ?? null) as Record<string, unknown> | null,
    openTabs: (appContext.openTabs ?? null) as unknown[] | null,
    spaceId: (appContext.spaceId
      ?? appContext.space_id
      ?? appContext.current_space_id
      ?? null) as string | null,
    userTimeZone: (appContext.userTimeZone
      ?? appContext.user_time_zone
      ?? null) as string | null,
  }
}

describe('buildRemoteAppContext — Focus 与 local IPC 对齐', () => {
  const cachedFocus = {
    appType: 'tabdoc',
    appMeta: { idField: 'doc-1', titleField: '周报' },
    openTabs: [
      {
        type: 'tabdoc',
        id: 'doc-1',
        title: '周报',
        active: true,
        app_key: 'tabdoc',
        display_name: '文档',
      },
    ],
    spaceId: 'space-cached',
    userTimeZone: 'Asia/Shanghai',
    workspaceMode: 'desktop' as const,
    tabScopeKey: 'conversation:s1',
    workspaceScopeKey: 'conversation:s1',
  }

  it('产出完整 Focus camel 字段，并附带 Django 透传键', () => {
    const appContext = buildRemoteAppContext(cachedFocus, {
      organizationId: 'org-1',
      spaceId: 'space-1',
      tabScopeKey: 'conversation:s1',
      displayMessage: '你好',
      replyTo: {
        messageId: 'm-prev',
        preview: { role: 'user', text: '上一条' },
      },
    })

    expect(appContext.appType).toBe('tabdoc')
    expect(appContext.openTabs).toEqual(cachedFocus.openTabs)
    expect(appContext.appMeta).toEqual(cachedFocus.appMeta)
    expect(appContext.spaceId).toBe('space-1')
    expect(appContext.userTimeZone).toBe('Asia/Shanghai')
    expect(appContext.workspaceMode).toBe('desktop')
    expect(appContext.current_organization_id).toBe('org-1')
    expect(appContext.current_space_id).toBe('space-1')
    expect(appContext._invoked_from).toBe('conversation:s1')
    expect(appContext.display_message).toBe('你好')
    expect(appContext.reply_to_message_id).toBe('m-prev')
  })

  it('经模拟 Django normalize 后与 local IPC Focus 语义等价', () => {
    const remote = buildRemoteAppContext(cachedFocus, {
      organizationId: 'org-1',
      spaceId: cachedFocus.spaceId,
      displayMessage: '对齐',
    })
    const normalized = simulateDjangoNormalizedFocus(remote)
    const localIpcFocus = {
      appType: cachedFocus.appType,
      appMeta: cachedFocus.appMeta,
      openTabs: cachedFocus.openTabs,
      spaceId: cachedFocus.spaceId,
      userTimeZone: cachedFocus.userTimeZone,
    }
    expect(normalized).toEqual(localIpcFocus)
  })

  it('不透传危险顶层字段与 host-only scope 键', () => {
    const polluted = {
      ...cachedFocus,
      billing_precheck_source: 'evil',
      runtime_mode: 'admin',
      _execution_agent_id: 'agent-x',
      billing_idempotency_key: 'bill-1',
    }
    const appContext = buildRemoteAppContext(
      polluted as typeof cachedFocus,
      { displayMessage: 'x', organizationId: 'org-1', spaceId: 'space-1' },
    )

    expect(appContext).not.toHaveProperty('billing_precheck_source')
    expect(appContext).not.toHaveProperty('runtime_mode')
    expect(appContext).not.toHaveProperty('_execution_agent_id')
    expect(appContext).not.toHaveProperty('billing_idempotency_key')
    expect(appContext).not.toHaveProperty('tabScopeKey')
    expect(appContext).not.toHaveProperty('workspaceScopeKey')
    expect(appContext.appType).toBe('tabdoc')
    expect(appContext.openTabs).toEqual(cachedFocus.openTabs)
  })

  it('chat 视觉 Focus：清空 openTabs / appMeta，不把资源当当前看见的 App', () => {
    const chatFocus = {
      appType: 'chat',
      appMeta: { project_id: 'p1', task_id: 't1', idField: 'stale' },
      openTabs: [
        { type: 'tabdoc', id: 'doc-stale', title: '旧文档', active: true, app_key: 'tabdoc' },
      ],
      spaceId: 'space-1',
      userTimeZone: 'Asia/Shanghai',
      workspaceMode: 'conversation' as const,
    }
    const appContext = buildRemoteAppContext(chatFocus, {
      displayMessage: '在对话里问一句',
      spaceId: 'space-1',
      tabScopeKey: 'conversation:s1',
    })

    expect(appContext.appType).toBe('chat')
    expect(appContext.appMeta).toBeNull()
    expect(appContext.openTabs).toEqual([])
    expect(appContext.workspaceMode).toBe('conversation')
  })
})
