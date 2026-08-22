/**
 * AppDeepLink — Deep Link 处理 + 邀请对话框
 *
 * 独立组件，管理 deep link 监听和邀请 token 状态。
 * 仅当收到邀请链接时才渲染 InvitationAcceptDialog。
 *
 * 处理两类 path（与 main/deep-link.ts 拆出来的 `data.path` 对齐）：
 *   1. `invite/<token>`：外部唤起接受邀请，弹 InvitationAcceptDialog
 *   2. `resource/<type>/<id>?<query>`（W3 改造）：D5 自有格式产物指针，
 *      解析后直接走 ResourceRouter 在当前 Space 内打开（不再走 navigator
 *      agentspace-app 兜底，跨过中间映射层 — D1 manifest 驱动）
 *
 * 旧的 `artifact/<app>?<query>` path 已迁出（参见 RFC §10.2 / §10.3）；
 * 历史链接形态全部由生成端在 W3 同步切到 `resource/` 形态。
 */
import React, { useEffect, useState } from 'react'
import { logger } from '@/utils/logger'
import { parseResourcePointer } from '@tabtin/resource-router'
import type { ResourcePointer } from '@tabtin/resource-router'
import { isSupportedInviteToken } from '@tabtin/config'
import { resourceRouter } from '@/services/resourceRouter'
import { useSpaceStore } from '@stores/useSpaceStore'
import {
  ensureNotificationSpaceSelected,
  ensureOrganizationSelected,
} from '@services/notificationNavigation'

const InvitationAcceptDialog = React.lazy(
  () => import('@components/invitation/InvitationAcceptDialog').then(m => ({ default: m.InvitationAcceptDialog }))
)

/**
 * 解析 `resource/<type>/<id>?<query>` deep link path 为 ResourcePointer。
 *
 * 输入是 `data.path + data.url` 的组合：
 *   - `data.path` 形如 `resource/document/doc_abc`（main/deep-link.ts 已抽出
 *     hostname + pathname）
 *   - 但 query 不在 path 里，需从 `data.url` 重构整个 URI 后送给
 *     `parseResourcePointer`（W2 协议 SSOT）
 *
 * 不命中（path 不以 `resource/` 起始 / URI 解析失败 / 缺 type 或 id）→ undefined。
 */
export function _parseResourceDeepLink(
  path: string,
  url: string,
): ResourcePointer | undefined {
  if (!path.startsWith('resource/')) return undefined
  // url 形如 `tabtin://resource/<type>/<id>?<query>`；直接送给 W2 parser
  const pointer = parseResourcePointer(url)
  if (pointer.scheme !== 'tabtin' || !pointer.type || !pointer.id) {
    return undefined
  }
  return pointer
}

/**
 * 处理 `tabtin://resource/<type>/<id>?<query>` deep link：
 *   1. 解析为 ResourcePointer（W2 SSOT）
 *   2. 依次切 organization / space（meta 透传）
 *   3. 调 ResourceRouter.open 走 D2 五层优先级派发到 carrier
 *
 * 失败路径全部走 logger.warn（外部唤起场景下用户不一定有 toast 上下文）。
 */
async function handleResourceDeepLink(pointer: ResourcePointer): Promise<void> {
  const meta = pointer.meta ?? {}
  const organizationId = typeof meta['organizationId'] === 'string' ? meta['organizationId'] : undefined
  const targetSpaceId = typeof meta['spaceId'] === 'string' ? meta['spaceId'] : undefined

  if (organizationId) {
    const organizationResult = await ensureOrganizationSelected(organizationId)
    if (organizationResult !== 'ready') {
      logger.warn('[AppDeepLink] resource link organization 切换失败', {
        organizationId,
        organizationResult,
      })
      return
    }
  }

  let spaceId = targetSpaceId
  if (spaceId) {
    const ok = await ensureNotificationSpaceSelected(spaceId, organizationId)
    if (!ok) {
      logger.warn('[AppDeepLink] resource link space 切换失败', { spaceId, organizationId })
      return
    }
  } else {
    spaceId = useSpaceStore.getState().selectedSpace?.id
  }

  if (!spaceId) {
    logger.warn('[AppDeepLink] resource link 无可用 space，跳转中止', { pointer })
    return
  }

  await resourceRouter.open(spaceId, pointer, {
    triggerSource: 'window_open_fallback',
  })
}

export function AppDeepLink() {
  const [inviteToken, setInviteToken] = useState<string | null>(null)

  useEffect(() => {
    const tabtin = window.tabtin
    if (!tabtin?.deepLink?.onDeepLink) return
    return tabtin.deepLink.onDeepLink((data: { path: string; url: string }) => {
      const inviteMatch = data.path.match(/^invite\/([^/?#]+)$/)
      const token = inviteMatch?.[1]
      if (isSupportedInviteToken(token)) {
        setInviteToken(token)
        return
      }

      // D5 自有格式产物指针 — 走 ResourceRouter 在当前 Space 内派发打开
      const pointer = _parseResourceDeepLink(data.path, data.url)
      if (pointer) {
        void handleResourceDeepLink(pointer).catch((err) => {
          logger.warn('[AppDeepLink] resource link 处理异常', { err, pointer })
        })
        return
      }

      // 其它路径：静默 noop（向后兼容；新形态由 W3 起统一是 resource/）
    })
  }, [])

  if (!inviteToken) return null

  return (
    <React.Suspense fallback={null}>
      <InvitationAcceptDialog
        token={inviteToken}
        onClose={() => setInviteToken(null)}
      />
    </React.Suspense>
  )
}
