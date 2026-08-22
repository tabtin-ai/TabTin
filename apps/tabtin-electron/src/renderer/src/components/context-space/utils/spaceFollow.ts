import type { ContextItem } from '@components/context-space/registry'

/**
 * Space 目录起始页（orchestration apphome + meta.targetSpaceId）承载「某个 Space 的
 * 工作目录」身份。激活这类页签时，对话应跟随切到该 Space，保持工作台与对话一致。
 *
 * 返回需要跟随切换的目标 Space id；对普通文件/目录页签（tabfolder、tabcode、浏览器等，
 * 没有 targetSpaceId 字段）返回 null，不触发跟随。
 */
export function getSpaceFollowTarget(item: ContextItem): string | null {
  if (item.type !== 'apphome') return null
  const targetSpaceId = item.meta?.targetSpaceId
  return typeof targetSpaceId === 'string' && targetSpaceId ? targetSpaceId : null
}
