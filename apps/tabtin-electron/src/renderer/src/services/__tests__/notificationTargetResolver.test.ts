import { describe, expect, it, beforeAll } from 'vitest'
import { resolveNotificationNavigateTarget } from '../notificationTargetResolver'
import { contextRegistry } from '@components/context-space/registry/instance'

// W3 改造（RFC §11）后 trackerArtifactMap.resolveArtifactAppFromSkill 走
// contextRegistry 反查（manifest 即 SSOT），不再有静态白名单。本测试需要
// 预先把测试用到的 app 注册到 contextRegistry，否则 skill_key 解析 → undefined。
beforeAll(() => {
  for (const appId of ['tabmemo', 'tabdoc', 'tabslide', 'tabcode', 'tabdata']) {
    if (!contextRegistry.getHandlerByAppId(appId)) {
      contextRegistry.register({ type: appId, appId })
    }
  }
})

describe('notificationTargetResolver', () => {
  it('外部联系人申请始终跳到通讯录的收到申请页', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'organization.invitation.external_contact',
      metadata: {
        // 已发出的旧通知仍指向成员页；新客户端必须纠正这个失效目标。
        navigate_to: { type: 'settings', id: 'teamMembers' },
      },
      organization_id: '',
      space_id: undefined,
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'im-contacts',
      id: 'incoming',
    })
  })

  it('外部联系人申请被拒绝后跳到通讯录的发出申请页', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'organization.invitation.external_contact.rejected',
      metadata: {},
      organization_id: '',
      space_id: undefined,
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'im-contacts',
      id: 'outgoing',
    })
  })

  it('显式 navigate_to 会继承通知本体的 organization/space scope', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'tracker.run.completed',
      metadata: {},
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: { type: 'tracker', id: 'tracker-1' },
      source_extension_id: undefined,
    })).toEqual({
      type: 'tracker',
      id: 'tracker-1',
      organizationId: 'ws-1',
      spaceId: 'space-1',
    })
  })

  it('Tracker Run 通知会保留本次执行的会话目标', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'tracker.run.completed',
      metadata: {
        session_id: 'session-run-4',
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: {
        type: 'tracker',
        id: 'tracker-1',
        runId: 'run-4',
      },
      source_extension_id: undefined,
    })).toEqual({
      type: 'tracker',
      id: 'tracker-1',
      runId: 'run-4',
      sessionId: 'session-run-4',
      organizationId: 'ws-1',
      spaceId: 'space-1',
    })
  })

  it('metadata.navigate_to 也会被识别并补齐 scope', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'system',
      metadata: {
        navigate_to: { type: 'chat-session', id: 'sess-1' },
        organization_id: 'ws-meta',
        space_id: 'space-meta',
      },
      organization_id: '',
      space_id: undefined,
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'chat-session',
      id: 'sess-1',
      organizationId: 'ws-meta',
      spaceId: 'space-meta',
    })
  })

  it('Agent 项目会话通知保留 workspace/project 双重 scope，并规范化 snake_case', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'agent.task.completed',
      metadata: {
        navigate_to: {
          type: 'chat-session',
          id: 'sess-project-1',
          workspace_id: 'workspace-1',
          project_id: 'project-1',
        },
      },
      organization_id: 'org-1',
      space_id: undefined,
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'chat-session',
      id: 'sess-project-1',
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
  })

  it('邮件事件不再深链到已下线的 TabMail', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'extension_event',
      metadata: {
        event_type: 'email.received',
        message_id: 'msg-1',
        thread_id: 'thread-1',
      },
      organization_id: 'ws-2',
      space_id: 'space-2',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toBeUndefined()
  })

  it('tracker.run.completed + skill_key 命中 → 跳产物 app(Wave 6 §4.4)', () => {
    // Wave 6 (charter §4.4 产物呈现分层):成功通知默认跳产物 app,
    // 而非 Run 详情。skill_key=tabmemo-summarize → app=tabmemo
    expect(resolveNotificationNavigateTarget({
      type: 'tracker.run.completed',
      metadata: {
        tracker_id: 'g-42',
        skill_key: 'tabmemo-summarize',
        tracker_event_status: 'completed',
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'agentspace-app',
      id: 'tabmemo',
      organizationId: 'ws-1',
      spaceId: 'space-1',
    })
  })

  it('tracker.run.completed 但 skill_key 不命中 app → 降级到 Run 详情', () => {
    // 兜底：skill_key 解析不到任何 contextRegistry 注册的 app 时，仍能跳 Run 详情（原行为）
    expect(resolveNotificationNavigateTarget({
      type: 'tracker.run.completed',
      metadata: {
        tracker_id: 'g-42',
        skill_key: 'unknown-app-skill',
        tracker_event_status: 'completed',
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'tracker',
      id: 'g-42',
      organizationId: 'ws-1',
      spaceId: 'space-1',
    })
  })

  it('tracker.run.failed → 仍跳 Run 详情(产物未必存在,看过程更合理)', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'tracker.run.failed',
      metadata: {
        tracker_id: 'g-42',
        skill_key: 'tabmemo-summarize',
        tracker_event_status: 'failed',
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'tracker',
      id: 'g-42',
      organizationId: 'ws-1',
      spaceId: 'space-1',
    })
  })

  it('tracker.run.completed 无 skill_key → 降级 Run 详情', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'tracker.run.completed',
      metadata: { tracker_id: 'g-42' },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'tracker',
      id: 'g-42',
      organizationId: 'ws-1',
      spaceId: 'space-1',
    })
  })

  it('Wave 6 续作 P0-3:tracker.run.completed + artifact_ref 透传到 target.artifactRef(charter §4.4)', () => {
    // 后端 envelope payload 把 artifact_ref(camelCase)放在 metadata 里,
    // resolver 必须把它透传到 NotificationNavigateTarget,navigator 据此跳具体产物。
    const target = resolveNotificationNavigateTarget({
      type: 'tracker.run.completed',
      metadata: {
        tracker_id: 'g-42',
        skill_key: 'tabmemo-summarize',
        tracker_event_status: 'completed',
        artifact_ref: { memoId: 'memo-2025' },
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })
    expect(target).toBeDefined()
    expect(target!.type).toBe('agentspace-app')
    expect(target!.id).toBe('tabmemo')
    // artifactRef 透传(navigator 把它放进 openResourceTab 的 meta)
    expect((target as { artifactRef?: Record<string, unknown> }).artifactRef).toEqual({ memoId: 'memo-2025' })
  })

  it('Wave 6 续作 P0-3:无 artifact_ref 时不带 artifactRef 字段(向后兼容)', () => {
    const target = resolveNotificationNavigateTarget({
      type: 'tracker.run.completed',
      metadata: {
        tracker_id: 'g-42',
        skill_key: 'tabmemo-summarize',
        tracker_event_status: 'completed',
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })
    expect(target!.type).toBe('agentspace-app')
    expect((target as { artifactRef?: unknown }).artifactRef).toBeUndefined()
  })

  it('extension_event 的设置页兜底会保留通知 scope', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'extension_event',
      metadata: {},
      organization_id: 'ws-3',
      space_id: 'space-3',
      navigate_to: undefined,
      source_extension_id: 'ext-mail',
    })).toEqual({
      type: 'settings',
      id: 'ext-mail',
      organizationId: 'ws-3',
      spaceId: 'space-3',
      route: 'extensions',
    })
  })

  it('#4370 owner_reassigned_summary 汇总通知不跳转', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'resource_shared',
      metadata: {
        action: 'owner_reassigned_summary',
        resource_type: 'doc',
        resource_id: 'doc-1',
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toBeUndefined()
  })

  it('资源权限变化属于纯通知，不再跳转资源', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'resource_shared',
      metadata: {
        action: 'permission_changed',
        resource_type: 'doc',
        resource_id: 'doc-1',
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toBeUndefined()
  })

  it('TabDoc 协作邀请跳转到被邀请的文档', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'resource_shared',
      metadata: {
        action: 'invited',
        behavior: 'view_context',
        resource_type: 'doc',
        resource_id: 'doc-invited-1',
        resource_title: '0818',
        space_id: 'space-owner-1',
      },
      organization_id: 'org-1',
      space_id: 'space-owner-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'resource-shared',
      id: 'doc-invited-1',
      resourceType: 'doc',
      resourceTitle: '0818',
      organizationId: 'org-1',
      spaceId: 'space-owner-1',
    })
  })

  it('TabData 协作邀请跳转到被邀请的表格', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'resource_shared',
      metadata: {
        action: 'invited',
        behavior: 'view_context',
        resource_type: 'table',
        resource_id: 'table-invited-1',
        resource_title: '成绩单',
        space_id: 'space-owner-2',
      },
      organization_id: 'org-1',
      space_id: 'space-owner-2',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'resource-shared',
      id: 'table-invited-1',
      resourceType: 'table',
      resourceTitle: '成绩单',
      organizationId: 'org-1',
      spaceId: 'space-owner-2',
    })
  })

  it('#5994 tabdoc.comment.mention 跳转到被提及文档', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'tabdoc.comment.mention',
      metadata: {
        resource_type: 'doc',
        resource_id: 'doc-mention-1',
        resource_title: '协作文档',
        action: 'mentioned',
        thread_id: 'thread-mention-1',
        comment_id: 'comment-mention-1',
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'resource-shared',
      id: 'doc-mention-1',
      resourceType: 'doc',
      resourceTitle: '协作文档',
      threadId: 'thread-mention-1',
      commentId: 'comment-mention-1',
      openComments: true,
      organizationId: 'ws-1',
      spaceId: 'space-1',
    })
  })

  it('#9634 tabdata.comment.mention opens the exact record comment', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'tabdata.comment.mention',
      metadata: {
        resource_type: 'table',
        resource_id: 'table-1',
        resource_title: 'Tasks',
        record_id: 'record-1',
        comment_id: 'comment-1',
      },
      organization_id: 'org-1',
      space_id: 'space-1',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'resource-shared',
      id: 'table-1',
      resourceType: 'table',
      resourceTitle: 'Tasks',
      recordId: 'record-1',
      commentId: 'comment-1',
      openComments: true,
      organizationId: 'org-1',
      spaceId: 'space-1',
    })
  })

  it('#6099 tabdata.record.user_assigned 跳转到成员字段所在记录', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'tabdata.record.user_assigned',
      metadata: {
        resource_type: 'table',
        resource_id: 'table-1',
        resource_title: '任务表',
        action: 'assigned',
        record_id: 'record-9',
      },
      organization_id: 'ws-2',
      space_id: 'space-2',
      navigate_to: undefined,
      source_extension_id: undefined,
    })).toEqual({
      type: 'resource-shared',
      id: 'table-1',
      resourceType: 'table',
      resourceTitle: '任务表',
      recordId: 'record-9',
      organizationId: 'ws-2',
      spaceId: 'space-2',
    })
  })

  it('#7986 resource_access_request 不解析为资源导航（确认弹窗由 store 打开）', () => {
    expect(resolveNotificationNavigateTarget({
      type: 'resource_access_request',
      metadata: {
        request_id: 'req-1',
        resource_type: 'document',
        resource_id: 'doc-1',
        // 即使带 navigate_to / 权限字段也不应走资源跳转
        navigate_to: { type: 'resource-shared', id: 'doc-1', resourceType: 'doc' },
        role: 'editor',
      },
      organization_id: 'ws-1',
      space_id: 'space-1',
      navigate_to: { type: 'resource-shared', id: 'doc-1', resourceType: 'doc' },
      source_extension_id: undefined,
    })).toBeUndefined()
  })
})
