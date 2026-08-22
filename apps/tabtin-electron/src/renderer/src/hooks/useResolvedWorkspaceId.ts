/**
 * 统一解析当前上下文中的 organization_id。
 *
 * @deprecated 请使用 useResolvedOrganizationId
 *
 * 该兼容导出复用当前解析器，避免旧调用方绕开 pendingOrganizationId。
 */
export { useResolvedOrganizationId } from './useResolvedOrganizationId'
