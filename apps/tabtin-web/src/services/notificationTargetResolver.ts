import type { NotificationItem, NotificationNavigateTarget } from './notificationApi'

function readString(metadata: Record<string, unknown>, snakeKey: string, camelKey = snakeKey): string | undefined {
  const value = metadata[snakeKey] ?? metadata[camelKey]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Pure Web notification resolver. Kept free of router/store imports for contract tests. */
export function resolveWebNotificationNavigateTarget(
  item: Pick<NotificationItem, 'id' | 'type' | 'metadata' | 'organization_id' | 'space_id'>,
): NotificationNavigateTarget | undefined {
  const isResourceJumpType =
    item.type === 'resource_shared'
    || item.type === 'tabdoc.comment.mention'
    || item.type === 'tabdata.comment.mention'
    || item.type === 'tabdata.record.user_assigned'
  if (!isResourceJumpType) return undefined

  const metadata = (item.metadata ?? {}) as Record<string, unknown>
  if (item.type === 'resource_shared') {
    const action = readString(metadata, 'action')
    if (action === 'removed' || action === 'auto_removed' || action === 'auto_removed_summary') {
      return undefined
    }
  }

  const resourceType = readString(metadata, 'resource_type', 'resourceType')
  const resourceId = readString(metadata, 'resource_id', 'resourceId')
  const resourceTitle = readString(metadata, 'resource_title', 'resourceTitle')
  if ((resourceType !== 'doc' && resourceType !== 'table') || !resourceId) return undefined

  const isRecordCommentMention = item.type === 'tabdata.comment.mention'
  const recordId = readString(metadata, 'record_id', 'recordId')
  if (isRecordCommentMention && (resourceType !== 'table' || !recordId)) return undefined
  const commentId = readString(metadata, 'comment_id', 'commentId')

  return {
    type: 'resource-shared',
    id: resourceId,
    resourceType,
    ...(resourceTitle ? { resourceTitle } : {}),
    ...(isRecordCommentMention && recordId
      ? {
          recordId,
          ...(commentId ? { commentId } : {}),
          openComments: true,
          intentKey: item.id,
        }
      : {}),
    organizationId:
      item.organization_id
      || readString(metadata, 'organization_id', 'organizationId'),
    spaceId:
      item.space_id
      || readString(metadata, 'space_id', 'spaceId'),
  }
}
