import type { NotificationItem, NotificationNavigateTarget } from '@services/notificationApi'
import { resolveArtifactAppFromSkill } from './trackerArtifactMap'

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

type NotificationScope = {
  organizationId?: string
  spaceId?: string
  workspaceId?: string
  projectId?: string
}

function readNotificationScope(
  item: Pick<NotificationItem, 'organization_id' | 'space_id' | 'metadata'>,
): NotificationScope {
  const metadata = item.metadata ?? {}

  return {
    organizationId:
      item.organization_id
      || readString(metadata, 'organization_id')
      || readString(metadata, 'organizationId'),
    spaceId:
      item.space_id
      || readString(metadata, 'space_id')
      || readString(metadata, 'spaceId'),
    workspaceId:
      readString(metadata, 'workspace_id')
      || readString(metadata, 'workspaceId'),
    projectId:
      readString(metadata, 'project_id')
      || readString(metadata, 'projectId'),
  }
}

function readNavigateTarget(raw: unknown): NotificationNavigateTarget | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }

  const candidate = raw as Record<string, unknown>
  const type = readString(candidate, 'type')
  const id = readString(candidate, 'id')

  if (!type || !id) {
    return undefined
  }

  if (type === 'chat-session') {
    const {
      workspace_id: _workspaceIdSnake,
      project_id: _projectIdSnake,
      workspaceId: _workspaceIdCamel,
      projectId: _projectIdCamel,
      ...target
    } = candidate
    const workspaceId = readString(candidate, 'workspaceId') || readString(candidate, 'workspace_id')
    const projectId = readString(candidate, 'projectId') || readString(candidate, 'project_id')
    return {
      ...target,
      type,
      id,
      ...(workspaceId ? { workspaceId } : {}),
      ...(projectId ? { projectId } : {}),
    } as NotificationNavigateTarget
  }

  return raw as NotificationNavigateTarget
}

function applyNotificationScope(
  target: NotificationNavigateTarget,
  scope: NotificationScope,
): NotificationNavigateTarget {
  if (target.type === 'chat-session') {
    return {
      ...target,
      organizationId: target.organizationId || scope.organizationId,
      ...(target.spaceId || scope.spaceId
        ? { spaceId: target.spaceId || scope.spaceId }
        : {}),
      ...(target.workspaceId || scope.workspaceId
        ? { workspaceId: target.workspaceId || scope.workspaceId }
        : {}),
      ...(target.projectId || scope.projectId
        ? { projectId: target.projectId || scope.projectId }
        : {}),
    }
  }

  return {
    ...target,
    organizationId: target.organizationId || scope.organizationId,
    ...(target.spaceId || scope.spaceId
      ? { spaceId: target.spaceId || scope.spaceId }
      : {}),
  }
}


export function resolveNotificationNavigateTarget(
  item: Pick<NotificationItem, 'type' | 'metadata' | 'organization_id' | 'space_id' | 'navigate_to' | 'source_extension_id'>,
): NotificationNavigateTarget | undefined {
  const metadata = item.metadata ?? {}
  const scope = readNotificationScope(item)

  // ：owner 确认弹窗由 notification store 打开；不据此导航/本地授权
  if (item.type === 'resource_access_request') {
    return undefined
  }

  // 外部联系人申请统一在消息通讯录处理；覆盖旧通知携带的设置页目标。
  if (item.type === 'organization.invitation.external_contact') {
    return { type: 'im-contacts', id: 'incoming' }
  }
  if (item.type === 'organization.invitation.external_contact.rejected') {
    return { type: 'im-contacts', id: 'outgoing' }
  }

  const explicitTarget = readNavigateTarget(item.navigate_to) || readNavigateTarget(metadata.navigate_to)

  if (explicitTarget) {
    const scopedTarget = applyNotificationScope(explicitTarget, scope)
    if (scopedTarget.type === 'tracker' && !scopedTarget.sessionId) {
      const sessionId = readString(metadata, 'session_id') || readString(metadata, 'sessionId')
      return sessionId ? { ...scopedTarget, sessionId } : scopedTarget
    }
    return scopedTarget
  }

  const trackerId =
    readString(metadata, 'tracker_id') || readString(metadata, 'trackerId')
  if (trackerId && item.type.startsWith('tracker.run.')) {
    // Wave 6 (charter v1.8 §4.4 产物呈现分层):
    //   Inbox 通知点击**默认跳产物**(对应 app),不再固定跳 Run 详情。
    //   completed → 跳产物 app(skill_key 解析到 contextRegistry 注册的 app id);
    //   failed → 仍跳 Run 详情(产物未必存在,看过程更合理)。
    //   skill_key 缺失或不命中映射 → 降级到 Run 详情(原行为,兜底)。
    //
    // 波次 4 Stage 2.6 一刀切：metadata 字段 ``goal_id`` / event type
    // ``goal.run.*`` 已下线，统一 ``tracker_id`` / ``tracker.run.*``。
    const status =
      readString(metadata, 'tracker_event_status')
      || (item.type === 'tracker.run.completed'
        ? 'completed'
        : item.type === 'tracker.run.failed'
          ? 'failed'
          : '')
    const skillKey = readString(metadata, 'skill_key')
    const artifactApp = resolveArtifactAppFromSkill(skillKey)
    const artifactRefRaw = metadata.artifact_ref ?? metadata.artifactRef
    const artifactRef =
      artifactRefRaw && typeof artifactRefRaw === 'object'
        ? (artifactRefRaw as Record<string, unknown>)
        : undefined

    if (status === 'completed' && artifactApp) {
      // 默认主路径:跳产物。降级保留:在 NotificationBell 双按钮里给"看过程"。
      return applyNotificationScope({
        type: 'agentspace-app',
        id: artifactApp,
        ...(artifactRef ? { artifactRef } : {}),
      } as NotificationNavigateTarget, scope)
    }

    return applyNotificationScope({
      type: 'tracker',
      id: trackerId,
    }, scope)
  }

  const sourceExtensionId =
    item.source_extension_id
    || readString(metadata, 'source_extension_id')
    || readString(metadata, 'sourceExtensionId')
  if (item.type === 'extension_event' && sourceExtensionId) {
    return applyNotificationScope({
      type: 'settings',
      id: sourceExtensionId,
      route: 'extensions',
    }, scope)
  }

  /**
   * Wave 4 (PRD §五块 5):resource_shared 通知,把 Wave 2 metadata 转成 NavigateTarget。
   * - action='permission_changed' / 'removed' / 'auto_removed' / 'auto_removed_summary' /
   *   'owner_reassigned_summary' → 返回 undefined, store/Bell 层走 toast 分支(不跳转)。
   *   auto_removed_summary / owner_reassigned_summary 是离队级联给 owner 的汇总通知,
   *   metadata.resource_id 是任意一个资源 ID,无跳转语义。
   * - 其它 action（当前仅 invited）+ 命中 doc/table → 跳对应资源
   * resource_type 不识别或缺失 resource_id → undefined(降级到原"无导航"行为)
   */
  if (item.type === 'resource_shared') {
    const action = readString(metadata, 'action')
    if (
      action === 'permission_changed'
      || action === 'removed'
      || action === 'auto_removed'
      || action === 'auto_removed_summary'
      || action === 'owner_reassigned_summary'
    ) {
      return undefined
    }
    const resourceType = readString(metadata, 'resource_type')
    const resourceId = readString(metadata, 'resource_id')
    const resourceTitle = readString(metadata, 'resource_title')
    if ((resourceType === 'doc' || resourceType === 'table') && resourceId) {
      return applyNotificationScope({
        type: 'resource-shared',
        id: resourceId,
        resourceType,
        ...(resourceTitle ? { resourceTitle } : {}),
      }, scope)
    }
    return undefined
  }

  // TabDoc 评论 @ / TabData 成员字段指派：metadata 与 resource_shared 同形，跳对应资源
  if (
    item.type === 'tabdoc.comment.mention'
    || item.type === 'tabdata.comment.mention'
    || item.type === 'tabdata.record.user_assigned'
  ) {
    const resourceType = readString(metadata, 'resource_type')
    const resourceId = readString(metadata, 'resource_id')
    const resourceTitle = readString(metadata, 'resource_title')
    const recordId = readString(metadata, 'record_id') || readString(metadata, 'recordId')
    const threadId = readString(metadata, 'thread_id') || readString(metadata, 'threadId')
    const commentId = readString(metadata, 'comment_id') || readString(metadata, 'commentId')
    if ((resourceType === 'doc' || resourceType === 'table') && resourceId) {
      return applyNotificationScope({
        type: 'resource-shared',
        id: resourceId,
        resourceType,
        ...(resourceTitle ? { resourceTitle } : {}),
        ...(item.type === 'tabdata.comment.mention' && recordId
          ? { recordId, openComments: true }
          : {}),
        ...(item.type === 'tabdata.comment.mention' && commentId ? { commentId } : {}),
        ...(item.type === 'tabdata.record.user_assigned' && recordId ? { recordId } : {}),
        ...(item.type === 'tabdoc.comment.mention' && threadId
          ? { threadId, openComments: true }
          : {}),
        ...(item.type === 'tabdoc.comment.mention' && commentId ? { commentId } : {}),
      }, scope)
    }
  }

  return undefined
}

export function withResolvedNotificationNavigateTarget<T extends NotificationItem>(item: T): T {
  return {
    ...item,
    navigate_to: resolveNotificationNavigateTarget(item),
  }
}
