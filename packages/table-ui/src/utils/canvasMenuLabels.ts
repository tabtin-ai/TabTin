/**
 * 构建表格 Canvas 右键菜单的 i18n 标签。
 * 共享给 Electron / Web 两端，避免菜单项文案的重复维护。
 */

export interface CanvasFieldMenuLabels {
  editField: string
  duplicateField: string
  insertFieldLeft: string
  insertFieldRight: string
  sortField: string
  filterField: string
  groupField: string
  freezeField: string
  setPrimaryField: string
  primaryField: string
  hideField: string
  hideAllSelectedFields: string
  deleteField: string
  deleteAllSelectedFields: string
}

export interface CanvasRecordMenuLabels {
  insertAbove: string
  insertBelow: string
  rowUnit: string
  addSubRecord: string
  duplicate: string
  copyLink: string
  comment: string
  viewHistory: string
  sendToChat: string
  sendMultipleToChat: string
  delete: string
  deleteMultiple: string
}

export interface CanvasOverlayLabels {
  fieldMenuLabels: CanvasFieldMenuLabels
  recordMenuLabels: CanvasRecordMenuLabels
  allRecordsCheckboxTooltip: string
}

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string

export function buildCanvasMenuLabels(t: TranslateFn): CanvasOverlayLabels {
  return {
    fieldMenuLabels: {
      editField: t('menu.editField'),
      duplicateField: t('menu.duplicateField'),
      insertFieldLeft: t('menu.insertFieldLeft'),
      insertFieldRight: t('menu.insertFieldRight'),
      sortField: t('menu.sortField'),
      filterField: t('menu.filterField'),
      groupField: t('menu.groupField'),
      freezeField: t('menu.freezeUpField'),
      setPrimaryField: t('menu.setPrimaryField'),
      primaryField: t('menu.primaryField'),
      hideField: t('menu.hideField'),
      hideAllSelectedFields: t('menu.hideAllSelectedFields'),
      deleteField: t('menu.deleteField'),
      deleteAllSelectedFields: t('menu.deleteAllSelectedFields'),
    },
    recordMenuLabels: {
      insertAbove: t('menu.insertRecordAbove'),
      insertBelow: t('menu.insertRecordBelow'),
      rowUnit: t('menu.recordRowUnit'),
      addSubRecord: t('menu.addSubRecord'),
      duplicate: t('menu.duplicateRecord'),
      copyLink: t('menu.copyRecordLink'),
      comment: t('menu.comment'),
      viewHistory: t('record.history.open'),
      sendToChat: t('menu.sendToChat'),
      sendMultipleToChat: t('menu.sendMultipleToChat'),
      delete: t('menu.deleteRecord'),
      deleteMultiple: t('menu.deleteAllSelectedRecords'),
    },
    allRecordsCheckboxTooltip: t('grid.allRecordsCheckboxTooltip'),
  }
}
