/**
 * Web 端通知跳转分发器 — 与 Electron notificationNavigation 对等
 *
 * 与 Electron 唯一差异:跳转走 react-router 的 navigate(url) 而非 openResourceTab。
 *
 * navigate 函数由 NotificationBell 通过 react-router useNavigate() 注入,
 * 避免本模块直接 import react-router(否则非 Router 上下文调用会抛错)。
 */
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { useOrganizationStore, useSpaceStore } from '@tabtin/app-shell'
import type { NotificationItem, NotificationNavigateTarget } from './notificationApi'
import { resolveWebNotificationNavigateTarget } from './notificationTargetResolver'
import { appendRecordCommentRouteIntent } from '@/components/table/recordCommentRouteIntent'

export { resolveWebNotificationNavigateTarget } from './notificationTargetResolver'

/**
 * Wave 4 (PRD §五块 6):resource_shared 通知 → NavigateTarget。
 *
 * - action='removed' / 'auto_removed' / 'auto_removed_summary' → 返回 undefined,
 *   Bell 层 toast 提示。auto_removed_summary 是 Wave 5 §A 离队级联给 owner 的
 *   汇总通知，里面 metadata.resource_id 只是任意一个资源的 ID，没有跳转语义，
 *   只有汇总文案有用。
 * - 命中 doc/table 且有 resource_id → resource-shared target
 * - tabdoc.comment.mention / tabdata.record.user_assigned 复用同一 metadata 形
 * - 其它 → undefined(Web 端不识别其它 type,降级为"无导航")
 */
/**
 * 把 resolved 的 navigate_to 字段写回 item — store 端拿到的 server item 不带这个字段。
 * 对齐 Electron 端 withResolvedNotificationNavigateTarget。
 */
export function withResolvedWebNotificationNavigateTarget<T extends NotificationItem>(item: T): T {
  return {
    ...item,
    navigate_to: resolveWebNotificationNavigateTarget(item),
  }
}

/**
 * 切换 organization(如目标 organization 不是当前 selected)。Wave 4 防止跨 organization 跳转
 * 时仍停留在错误的 organization(资源所在 organization 必须先选中)。
 */
async function ensureOrganizationSelected(organizationId: string | undefined): Promise<boolean> {
  if (!organizationId) return true

  const organizationStore = useOrganizationStore.getState()
  if (organizationStore.selectedOrganization?.id === organizationId) return true

  let target = organizationStore.organizations.find((w) => w.id === organizationId)
  if (!target) {
    await organizationStore.loadOrganizations()
    target = useOrganizationStore.getState().organizations.find((w) => w.id === organizationId)
  }
  if (!target) return false

  await useOrganizationStore.getState().selectOrganization(target)
  return useOrganizationStore.getState().selectedOrganization?.id === organizationId
}

/**
 * Wave 4 (PRD §五块 6):resource-shared 目标的 Web 路由分发。
 *
 * @param navigate react-router 的 navigate 函数(useNavigate())
 * @param target 已解析的 NotificationNavigateTarget
 */
export async function navigateToWebTarget(
  navigate: (url: string) => void,
  target: NotificationNavigateTarget,
): Promise<void> {
  if (!target?.type) return

  if (target.organizationId) {
    const ok = await ensureOrganizationSelected(target.organizationId)
    if (!ok) {
      toast({
        title: i18n.t('common:notification.navigateFailed', {
          defaultValue: '通知跳转失败',
        }),
        description: i18n.t('common:notification.navigateOrganizationNotFound', {
          defaultValue: '目标组织不存在或无权限访问',
        }),
        variant: 'destructive',
      })
      return
    }
  }

  switch (target.type) {
    case 'resource-shared': {
      const organizationId = typeof target.organizationId === 'string'
        ? target.organizationId
        : undefined
      const spaceId = typeof target.spaceId === 'string' ? target.spaceId : undefined
      // Web 路由结构 (App.tsx):
      //   /organizations/:wt/spaces/:sp/docs/:docId
      //   /organizations/:wt/spaces/:sp/tables/:tableId
      //   退化:/docs/:docId / /tables/:tableId(无 organization/space prefix)
      const segments: string[] = []
      if (organizationId) segments.push('organizations', organizationId)
      if (spaceId) segments.push('spaces', spaceId)
      const path = target.resourceType === 'doc' ? 'docs' : 'tables'
      segments.push(path, target.id)
      let url = `/${segments.join('/')}`
      if (
        target.resourceType === 'table'
        && target.openComments === true
        && typeof target.recordId === 'string'
        && target.recordId
      ) {
        url = appendRecordCommentRouteIntent(url, {
          recordId: target.recordId,
          ...(typeof target.commentId === 'string' && target.commentId
            ? { commentId: target.commentId }
            : {}),
          ...(typeof target.intentKey === 'string' && target.intentKey
            ? { intentKey: target.intentKey }
            : {}),
        })
      }

      // Wave 5 §E (W4-L1 收敛)：切换 organization 之后，必须等 SpaceStore 把
      // 该 organization 下的 spaces 列表加载完，再 selectSpace；否则 spaces
      // 数组里找不到 target spaceId，SpaceHome 侧栏会短暂空白。
      // ensureOrganizationSelected 已 await selectOrganization（内部触发 loadSpaces，
      // 但 loadSpaces 是 selectOrganization 拿到 selectedOrganization 之后的下游异步）—
      // 这里再额外等一次 loadSpaces 完成以保证 spaces 已注水。
      if (spaceId) {
        const spaceStore = useSpaceStore.getState()
        let space = spaceStore.spaces.find((s) => s.id === spaceId)
        if (!space && organizationId) {
          try {
            await spaceStore.loadSpaces(organizationId)
          } catch {
            // loadSpaces 失败不阻塞路由；URL 路由仍能直达资源页面
          }
          space = useSpaceStore.getState().spaces.find((s) => s.id === spaceId)
        }
        if (space) useSpaceStore.getState().selectSpace(space)
      }

      navigate(url)
      break
    }
    case 'notification-panel': {
      // Web 端暂无独立通知面板路由;略过(Bell Popover 已是面板)
      break
    }
    default:
      // 未识别 type — 不报错,降级为静默忽略
      break
  }
}
