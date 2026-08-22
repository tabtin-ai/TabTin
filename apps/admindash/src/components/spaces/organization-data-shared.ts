/** 组织详情「数据与回收」共用展示工具与中文标签 */

import { formatDateTime as formatDateTimeBase } from '@/lib/utils'

export const ITEM_TYPE_LABELS: Record<string, string> = {
  space: '空间',
  tabdoc: '文档',
  tabdata: '表格',
  tabslide: '演示',
  tabdesign: '设计',
  tabvideo: '视频',
  tabmemo: '碎片',
  tabwhiteboard: '画布',
  tabfiles: '文件',
  tabcode: '代码',
  document: '文档',
  file: '文件',
  cloud_file: '文件',
  tabfolder: '文件',
}

export const SPACE_TYPE_LABELS: Record<string, string> = {
  workspace: '个人工作区',
  team_space: '团队项目空间',
}

export const SPACE_STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  paused: '暂停',
  completed: '已完成',
  archived: '已归档',
  trashed: '回收站中',
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '未记录'
  return formatDateTimeBase(value)
}

export function displayPerson(name?: string | null, id?: string | null): string {
  if (name?.trim()) return name.trim()
  if (id) return `${id.slice(0, 8)}…`
  return '未记录'
}

export function itemTypeLabel(itemType: string, fallback = '未知'): string {
  return ITEM_TYPE_LABELS[itemType] || itemType || fallback
}

export function spaceTypeLabel(spaceType?: string | null, fallback = '空间'): string {
  if (!spaceType) return fallback
  return SPACE_TYPE_LABELS[spaceType] || spaceType || fallback
}

export function spaceStatusLabel(status?: string | null): string {
  if (!status) return '—'
  return SPACE_STATUS_LABELS[status] || status
}
