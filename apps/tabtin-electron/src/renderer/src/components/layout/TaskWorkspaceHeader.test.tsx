import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@components/checkpoint/CheckpointBrowseTrigger', () => ({
  CheckpointBrowseTrigger: () => <button type="button">快照</button>,
}))

vi.mock('@components/chat/session/SessionCollaborators', () => ({
  SessionCollaborators: ({ sessionId, sourceUserId, sourceOrganizationId }: {
    sessionId: string | null | undefined
    sourceUserId?: string | null
    sourceOrganizationId?: string | null
  }) => (
    sessionId
      ? (
          <div
            data-testid="session-collaborators"
            data-source-user-id={sourceUserId ?? ''}
            data-source-organization-id={sourceOrganizationId ?? ''}
          />
        )
      : null
  ),
}))

vi.mock('@components/chat/tracker/TrackerRunBreadcrumb', () => ({
  TrackerRunBreadcrumb: () => (
    <button type="button" data-testid="tracker-run-breadcrumb">查看自动化任务</button>
  ),
  resolveTrackerRunSessionTitle: (
    trackerRun: { tracker_name?: string; run_index?: number },
    t: (key: string, opts?: Record<string, unknown>) => string,
  ) => t('trackerRun.sessionTitle', {
    defaultValue: '自动化任务 "{{name}}" 的第 {{idx}} 次记录',
    name: trackerRun.tracker_name || '未命名',
    idx: trackerRun.run_index || '?',
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'taskWorkspaceHeader.newTask': '新任务',
        'taskWorkspaceHeader.draftBadge': '草稿',
        'taskWorkspaceHeader.untitledTask': '未命名任务',
        'taskWorkspaceHeader.agentTitle': `Agent：${params?.name ?? ''}`,
        'taskWorkspaceHeader.workspaceTitle': `Workspace：${params?.name ?? ''}`,
      }
      if (params && typeof params === 'object' && 'defaultValue' in params) {
        let v = String(params.defaultValue)
        for (const [k, val] of Object.entries(params)) {
          if (k !== 'defaultValue') v = v.replace(`{{${k}}}`, String(val))
        }
        return v
      }
      return labels[key] ?? key
    },
  }),
}))

import {
  DraftTaskWorkspaceHeader,
  resolveTaskHeaderAgentName,
  TaskWorkspaceHeader,
} from './TaskWorkspaceHeader'
import { useSessionAccessStore } from '@/stores/chat/session/sessionAccessStore'

describe('TaskWorkspaceHeader', () => {
  it('会话 agent_id 命中 cache 时用真名', () => {
    const agentCache = {
      'agent-session': { name: 'Session Agent' },
      'agent-global': { name: 'Global Agent' },
    }

    expect(resolveTaskHeaderAgentName('agent-session', agentCache)).toBe('Session Agent')
  })

  it('#6739 cache 未命中时用同 id 的 selectedAgent，禁止 UUID 占位', () => {
    expect(resolveTaskHeaderAgentName(
      null,
      {},
      { id: 'agent-test', name: 'test' },
    )).toBe('test')

    expect(resolveTaskHeaderAgentName(
      'agent-test',
      {},
      { id: 'agent-test', display_name: 'test' },
    )).toBe('test')

    // 无真名：不渲染假名
    expect(resolveTaskHeaderAgentName('agent-missing', {})).toBeNull()
    expect(resolveTaskHeaderAgentName(null, {})).toBeNull()
  })

  it('#7744 正式顶栏：快照收为标题旁图标，不再重复 Agent/Workspace 药丸，右侧挂共享协作区', () => {
    render(
      <TaskWorkspaceHeader
        scopeKey="conversation:session-1"
        title="整理发布清单"
        workspaceId="ws-1"
        sessionId="session-1"
        activeViewMode="chat-focus"
      />,
    )

    expect(screen.getByText('整理发布清单')).toBeTruthy()
    expect(screen.getByText('快照')).toBeTruthy()
    // 药丸信息由 composer 底部承载，顶栏不重复
    expect(screen.queryByTitle(/^Agent：/)).toBeNull()
    expect(screen.queryByTitle(/^Workspace：/)).toBeNull()
    expect(screen.getByTestId('session-collaborators')).toBeTruthy()
  })

  it('共享接收态把来源用户交给同一个顶栏协作区', () => {
    useSessionAccessStore.getState().setSharedAccess({
      shareId: 'share-1',
      sessionId: 'shared-session-1',
      ownerUserId: 'owner-1',
      ownerDisplayName: '来源用户',
      organizationId: 'org-1',
      role: 'grantee',
    })

    const { unmount } = render(
      <TaskWorkspaceHeader
        scopeKey="conversation:shared-session-1"
        title="共享任务"
        sessionId="shared-session-1"
        activeViewMode="chat-focus"
      />,
    )

    expect(screen.getByTestId('session-collaborators').getAttribute('data-source-user-id'))
      .toBe('owner-1')
    expect(screen.getByTestId('session-collaborators').getAttribute('data-source-organization-id'))
      .toBe('org-1')
    unmount()
    useSessionAccessStore.getState().clearSharedAccess('shared-session-1')
  })

  it('分享发起人打开原任务时不把自己投影为来源用户', () => {
    useSessionAccessStore.getState().setSharedAccess({
      shareId: 'share-owner',
      sessionId: 'owned-session',
      ownerUserId: 'owner-1',
      ownerDisplayName: '当前用户',
      organizationId: 'org-1',
      role: 'owner',
    })

    const { unmount } = render(
      <TaskWorkspaceHeader
        scopeKey="conversation:owned-session"
        title="原任务"
        sessionId="owned-session"
        activeViewMode="chat-focus"
      />,
    )

    expect(screen.getByTestId('session-collaborators').getAttribute('data-source-user-id'))
      .toBe('')
    expect(screen.getByTestId('session-collaborators').getAttribute('data-source-organization-id'))
      .toBe('')
    unmount()
    useSessionAccessStore.getState().clearSharedAccess('owned-session')
  })

  it('应用聚焦时按视图切换真实宽度动态避让，协作者仍留在原顶栏', () => {
    render(
      <TaskWorkspaceHeader
        scopeKey="conversation:session-1"
        title="共享任务"
        sessionId="session-1"
        activeViewMode="app-focus"
      />,
    )

    const header = screen.getByTestId('task-workspace-header')
    expect(header.getAttribute('style')).toContain('var(--task-view-mode-switch-width, 0px)')
    expect(header.contains(screen.getByTestId('session-collaborators'))).toBe(true)
  })

  it('Tracker 执行记录：标题改为第 n 次记录，旁挂查看自动化任务，隐藏快照', () => {
    render(
      <TaskWorkspaceHeader
        scopeKey="conversation:session-tracker"
        title="未命名任务"
        workspaceId="ws-1"
        sessionId="session-tracker"
        activeViewMode="chat-focus"
        trackerRun={{
          run_id: 'run-1',
          run_index: 15,
          run_status: 'completed',
          tracker_id: 'tracker-1',
          tracker_name: 'test',
          tracker_origin: 'user_created',
          trigger_type: 'manual',
          trigger_context: {},
        }}
      />,
    )

    expect(screen.getByText('自动化任务 "test" 的第 15 次记录')).toBeTruthy()
    expect(screen.getByTestId('tracker-run-breadcrumb').textContent).toContain('查看自动化任务')
    expect(screen.queryByText('快照')).toBeNull()
    expect(screen.queryByText('未命名任务')).toBeNull()
  })

  it('预备分屏顶栏展示新任务状态并与正式任务同高结构', () => {
    render(
      <DraftTaskWorkspaceHeader
        scopeKey="conversation:draft"
        activeViewMode="split"
      />,
    )

    const header = screen.getByTestId('draft-task-workspace-header')
    expect(header).toBeTruthy()
    expect(screen.getByText('新任务')).toBeTruthy()
    expect(screen.getByText('草稿')).toBeTruthy()
    expect(screen.queryByText('发送第一条消息后将创建任务')).toBeNull()
    expect(screen.queryByTitle(/^Workspace：/)).toBeNull()
    expect(header.className).toContain('px-6')
    expect(header.className).not.toContain('pr-28')
    expect(screen.queryByRole('group', { name: '任务视图' })).toBeNull()
  })

  it('正式任务顶栏不再内嵌三态切换，左右边距保持一致', () => {
    render(
      <TaskWorkspaceHeader
        scopeKey="conversation:session-1"
        title="整理发布清单"
        activeViewMode="chat-focus"
      />,
    )

    const header = screen.getByTestId('task-workspace-header')
    expect(header.className).toContain('px-6')
    expect(header.className).not.toContain('pr-28')
    expect(screen.queryByRole('group', { name: '任务视图' })).toBeNull()
  })
})
