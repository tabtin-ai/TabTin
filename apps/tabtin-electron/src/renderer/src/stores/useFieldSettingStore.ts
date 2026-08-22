/** @store-category ui */

/**
 * useFieldSettingStore - 字段设置面板状态管理
 *
 * 管理 FieldSettingPanel 的打开/关闭和模式切换。
 * 多个调用点（"+" 按钮、右键菜单、管理字段弹窗）通过此 store 统一控制面板。
 */

import { create } from 'zustand'

export type FieldOperator = 'add' | 'edit' | 'insert'

export interface FieldSettingStore {
  /** 面板是否打开 */
  isOpen: boolean
  /** 当前操作模式 */
  operator: FieldOperator
  /** 触发面板的表格 ID（用于多表格实例作用域隔离） */
  tableId: string | null
  /** 触发面板的宿主 ID（用于同一表格被嵌入多次时定位到实际交互实例） */
  hostId: string | null
  /** 编辑模式下的字段 ID */
  fieldId: string | null
  /** 插入模式下的参考字段 ID */
  referenceFieldId: string | null
  /** 插入模式下的位置 */
  insertPosition: 'before' | 'after' | null
  /** 打开时自动定位的区域 */
  activeSection: 'config' | 'ai' | null
  /** 新建/插入时预填的字段类型（如从右键菜单跳转配置面板） */
  initialFieldType: string | null
  /** 新建/插入时预填的字段名 */
  initialFieldName: string | null

  /** 打开：新建字段 */
  openForAdd: (tableId?: string | null, hostId?: string | null) => void
  /** 打开：编辑字段 */
  openForEdit: (
    fieldId: string,
    activeSection?: 'config' | 'ai',
    tableId?: string | null,
    hostId?: string | null
  ) => void
  /** 打开：插入字段 */
  openForInsert: (
    referenceFieldId: string,
    position: 'before' | 'after',
    tableId?: string | null,
    hostId?: string | null,
    options?: { fieldType?: string; fieldName?: string }
  ) => void
  /** 关闭面板 */
  close: () => void
}

export const useFieldSettingStore = create<FieldSettingStore>()((set) => ({
  isOpen: false,
  operator: 'add',
  tableId: null,
  hostId: null,
  fieldId: null,
  referenceFieldId: null,
  insertPosition: null,
  activeSection: null,
  initialFieldType: null,
  initialFieldName: null,

  openForAdd: (tableId, hostId) =>
    set({
      isOpen: true,
      operator: 'add',
      tableId: tableId ?? null,
      hostId: hostId ?? null,
      fieldId: null,
      referenceFieldId: null,
      insertPosition: null,
      activeSection: null,
      initialFieldType: null,
      initialFieldName: null,
    }),

  openForEdit: (fieldId, activeSection, tableId, hostId) =>
    set({
      isOpen: true,
      operator: 'edit',
      tableId: tableId ?? null,
      hostId: hostId ?? null,
      fieldId,
      referenceFieldId: null,
      insertPosition: null,
      activeSection: activeSection ?? null,
      initialFieldType: null,
      initialFieldName: null,
    }),

  openForInsert: (referenceFieldId, position, tableId, hostId, options) =>
    set({
      isOpen: true,
      operator: 'insert',
      tableId: tableId ?? null,
      hostId: hostId ?? null,
      fieldId: null,
      referenceFieldId,
      insertPosition: position,
      activeSection: null,
      initialFieldType: options?.fieldType ?? null,
      initialFieldName: options?.fieldName ?? null,
    }),

  close: () =>
    set({
      isOpen: false,
      operator: 'add',
      tableId: null,
      hostId: null,
      fieldId: null,
      referenceFieldId: null,
      insertPosition: null,
      activeSection: null,
      initialFieldType: null,
      initialFieldName: null,
    }),
}))
