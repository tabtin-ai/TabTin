/**
 * Space 资源路由构造器
 *
 * 把「文档 / 表格 / 演示 / Space 首页」的 URL 拼接收敛到一处，
 * 让 SpaceHome 主区与侧边栏资源面板（SpaceResourcePanel）复用同一套路径，
 * 避免两处各拼一遍、改路由时漏改导致跳转错位。
 */

const enc = encodeURIComponent

export function spaceHomePath(
  organizationId: string | null | undefined,
  spaceId: string | null | undefined,
): string {
  if (organizationId && spaceId) return `/organizations/${enc(organizationId)}/spaces/${enc(spaceId)}`
  if (spaceId) return `/spaces/${enc(spaceId)}`
  return '/'
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1)
  }
  return pathname || '/'
}

export function getPendingSpaceRouteSyncTarget({
  pathname,
  pendingOrganizationSwitch,
  selectedSpaceKind,
  organizationId,
  spaceId,
}: {
  pathname: string
  pendingOrganizationSwitch: boolean
  selectedSpaceKind: string | null | undefined
  organizationId: string | null | undefined
  spaceId: string | null | undefined
}): string | null {
  if (!pendingOrganizationSwitch || selectedSpaceKind !== 'workspace' || !organizationId || !spaceId) {
    return null
  }

  const targetPath = spaceHomePath(organizationId, spaceId)
  return normalizePathname(pathname) === targetPath ? null : targetPath
}

export function docPath(
  organizationId: string | null | undefined,
  spaceId: string | null | undefined,
  documentId: string,
): string {
  if (organizationId && spaceId) {
    return `/organizations/${enc(organizationId)}/spaces/${enc(spaceId)}/docs/${enc(documentId)}`
  }
  if (spaceId) return `/spaces/${enc(spaceId)}/docs/${enc(documentId)}`
  return `/docs/${enc(documentId)}`
}

export function tablePath(
  organizationId: string | null | undefined,
  spaceId: string | null | undefined,
  tableId: string,
): string {
  if (organizationId && spaceId) {
    return `/organizations/${enc(organizationId)}/spaces/${enc(spaceId)}/tables/${enc(tableId)}`
  }
  if (spaceId) return `/spaces/${enc(spaceId)}/tables/${enc(tableId)}`
  return `/tables/${enc(tableId)}`
}
