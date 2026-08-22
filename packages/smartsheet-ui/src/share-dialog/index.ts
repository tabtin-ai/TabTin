/**
 * @tabtin/smartsheet-ui/share-dialog 入口。
 * 由调用方（TabDoc 编辑器工具栏 / TabData 表格视图工具栏）import 使用。
 */

export { ShareDialog } from './ShareDialog'
export { CollaboratorsSection } from './CollaboratorsSection'
export { PublicLinkSection } from './PublicLinkSection'
export {
  RemovedFromResourceOverlay,
  type RemovedFromResourceOverlayProps,
} from './RemovedFromResourceOverlay'

export { useCollaborators } from './hooks/useCollaborators'
export type { UseCollaboratorsResult } from './hooks/useCollaborators'

export {
  useShareSettings,
  scopeToShareType,
  shareTypeToScope,
  type UseShareSettingsResult,
  type EnableShareOptions,
} from './hooks/useShareSettings'

export {
  useMemberSearch,
  type UseMemberSearchResult,
} from './hooks/useMemberSearch'

export {
  useResourceShareDowngrade,
  resolveResourceShareDowngrade,
  isPermissionInsufficientForEditing,
  hasLiveResourceAccess,
  shouldShowRemovedOverlay,
  selectResourceShareNotifications,
  PERMISSION_LEVEL,
  type ResourceShareDowngradeState,
  type ResourceShareNotificationLike,
  type DowngradeAction,
} from './hooks/useResourceShareDowngrade'

export type {
  ResourceType,
  CollaboratorPermission,
  ShareLinkPermission,
  ShareScope,
  UserBrief,
  CollaboratorOut,
  SkippedReason,
  SkippedItem,
  InviteResult,
  ShareSettings,
  SearchedUser,
  ShareDialogProps,
} from './types'
