/**
 * 系统权限总览「已授权 N / 共 M」统计。
 *
 * 分母 = 当前平台实际检索到的适用项（排除 not-applicable），
 * 与列表主区可见条数一致；detection=unsupported 仍计入分母，
 * 避免 mac 显示 /5、Win 显示 1/1 与列表条数脱节。
 *
 * tagline 仍只看可检测项是否齐：测不到的项不挡「必要权限已齐」。
 */

import type { PermissionDescriptor } from './permissionConfig'

export interface PermissionOverviewStats {
  granted: number
  total: number
  /** 可可靠检测项是否全部已授权（用于 tagline） */
  allDetectableGranted: boolean
  /** 至少一项可检测权限已授权，且尚未齐 */
  someDetectableGranted: boolean
}

export function computePermissionOverviewStats(
  items: PermissionDescriptor[],
): PermissionOverviewStats {
  const applicable = items.filter((it) => it.status !== 'not-applicable')
  const granted = applicable.filter((it) => it.status === 'granted').length
  const total = applicable.length

  const detectable = applicable.filter(
    (it) => (it.detection ?? 'supported') !== 'unsupported',
  )
  const detectableGranted = detectable.filter((it) => it.status === 'granted').length
  const allDetectableGranted =
    detectable.length > 0 && detectableGranted === detectable.length
  const someDetectableGranted =
    detectableGranted > 0 && detectableGranted < detectable.length

  return {
    granted,
    total,
    allDetectableGranted,
    someDetectableGranted,
  }
}
