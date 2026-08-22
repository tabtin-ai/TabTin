/**
 * 第三方源「关联关系扫描」通用类型。
 * source 可扩展：feishu / 未来外部表格源等，各任务彼此独立。
 */

export type RelationScanSource = 'feishu' | (string & {})

export type RelationScanItemStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped'
  | 'cancelled'

export type RelationScanTaskStatus = 'scanning' | 'done' | 'error'

export interface RelationScanItem {
  key: string
  name: string
  status: RelationScanItemStatus
}

export interface RelationScanTask {
  id: string
  source: RelationScanSource
  /** 面板标题，如「飞书 · 关联扫描」 */
  title: string
  status: RelationScanTaskStatus
  items: RelationScanItem[]
  collapsed: boolean
  errorMessage: string | null
  /**
   * 为 true 时：发起方弹窗已收束，完成后应由该任务弹回后续步骤。
   * 同刻最多一个任务持有（新任务会抢走 holding）。
   */
  holdingDialog: boolean
  createdAt: number
}

export function isTerminalRelationScanItemStatus(status: RelationScanItemStatus): boolean {
  return status === 'done'
    || status === 'error'
    || status === 'skipped'
    || status === 'cancelled'
}

export function isExcludedFromScanResult(status: RelationScanItemStatus): boolean {
  return status === 'skipped' || status === 'cancelled'
}
