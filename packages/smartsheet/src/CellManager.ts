// 单元格管理器 - 处理单元格的创建、更新、样式和验证

import { Cell, CellStyle, CellValidation } from './types'
import { StorageAdapter } from './storage/StorageAdapter'
import { t } from './i18n'

export class CellManager {
  private storage: StorageAdapter
  private cells: Map<string, Cell> = new Map()

  constructor(storage: StorageAdapter) {
    this.storage = storage
  }

  /**
   * 初始化单元格管理器
   */
  async initialize(): Promise<void> {
    await this.loadCells()
  }

  /**
   * 加载所有单元格数据
   */
  private async loadCells(): Promise<void> {
    try {
      const cellsData = await this.storage.getCells()
      this.cells.clear()
      cellsData.forEach(cell => {
        const normalizedCell = this.normalizeCell(cell)
        this.cells.set(normalizedCell.id, normalizedCell)
      })
    } catch (error) {
      console.log('No existing cells, starting with empty map')
      this.cells.clear()
    }
  }

  /**
   * 保存单元格数据
   */
  private async saveCells(): Promise<void> {
    const cellsArray = Array.from(this.cells.values())
    await this.storage.saveCells(cellsArray)
  }

  /**
   * 创建新单元格
   */
  async createCell(tableId: string, rowId: string, columnId: string, value: any): Promise<Cell> {
    const cellId = this.getCellKey(tableId, rowId, columnId)

    const cell: Cell = {
      id: cellId,
      tableId,
      rowId,
      columnId,
      value,
      createdAt: new Date().toISOString()
    }

    this.cells.set(cellId, cell)
    await this.saveCells()

    return cell
  }

  /**
   * 获取单元格
   */
  getCell(tableId: string, rowId: string, columnId: string): Cell | null {
    const cellId = this.getCellKey(tableId, rowId, columnId)
    return this.cells.get(cellId) || null
  }

  /**
   * 更新单元格值
   */
  async updateCellValue(tableId: string, rowId: string, columnId: string, value: any): Promise<boolean> {
    const cellId = this.getCellKey(tableId, rowId, columnId)
    const cell = this.cells.get(cellId)

    if (!cell) {
      // 如果单元格不存在，创建新的
      await this.createCell(tableId, rowId, columnId, value)
      return true
    }

    cell.value = value
    cell.updatedAt = new Date().toISOString()

    await this.saveCells()
    return true
  }

  /**
   * 设置单元格样式
   */
  async setCellStyle(tableId: string, rowId: string, columnId: string, style: CellStyle): Promise<boolean> {
    const cellId = this.getCellKey(tableId, rowId, columnId)
    let cell = this.cells.get(cellId)

    if (!cell) {
      // 如果单元格不存在，创建新的
      cell = await this.createCell(tableId, rowId, columnId, null)
    }

    cell.style = { ...cell.style, ...style }
    cell.updatedAt = new Date().toISOString()

    await this.saveCells()
    return true
  }

  /**
   * 设置单元格验证规则
   */
  async setCellValidation(tableId: string, rowId: string, columnId: string, validation: CellValidation): Promise<boolean> {
    const cellId = this.getCellKey(tableId, rowId, columnId)
    let cell = this.cells.get(cellId)

    if (!cell) {
      cell = await this.createCell(tableId, rowId, columnId, null)
    }

    cell.validation = validation
    cell.updatedAt = new Date().toISOString()

    await this.saveCells()
    return true
  }

  /**
   * 验证单元格值
   */
  validateCell(cell: Cell): { isValid: boolean; message?: string } {
    if (!cell.validation) {
      return { isValid: true }
    }

    const { type, rule, message } = cell.validation

    switch (type) {
      case 'required':
        if (cell.value === null || cell.value === undefined || cell.value === '') {
          return { isValid: false, message: message || t('validation.required') }
        }
        break

      case 'range':
        const numValue = Number(cell.value)
        if (isNaN(numValue) || numValue < rule.min || numValue > rule.max) {
          return {
            isValid: false,
            message: message || t('validation.range', { min: rule.min, max: rule.max })
          }
        }
        break

      case 'list':
        if (!rule.options.includes(cell.value)) {
          return { isValid: false, message: message || t('validation.optionInvalid') }
        }
        break

      case 'regex':
        const regex = new RegExp(rule.pattern)
        if (!regex.test(String(cell.value))) {
          return { isValid: false, message: message || t('validation.formatInvalid') }
        }
        break
    }

    return { isValid: true }
  }

  /**
   * 获取表格的所有单元格
   */
  getTableCells(tableId: string): Cell[] {
    return Array.from(this.cells.values()).filter(cell => cell.tableId === tableId)
  }

  /**
   * 删除单元格
   */
  async deleteCell(tableId: string, rowId: string, columnId: string): Promise<boolean> {
    const cellId = this.getCellKey(tableId, rowId, columnId)
    const deleted = this.cells.delete(cellId)

    if (deleted) {
      await this.saveCells()
    }

    return deleted
  }

  /**
   * 批量删除行的所有单元格
   */
  async deleteRowCells(tableId: string, rowId: string): Promise<boolean> {
    const cellsToDelete = Array.from(this.cells.values()).filter(cell => cell.tableId === tableId && cell.rowId === rowId)

    cellsToDelete.forEach(cell => {
      this.cells.delete(cell.id)
    })

    if (cellsToDelete.length > 0) {
      await this.saveCells()
    }

    return cellsToDelete.length > 0
  }

  private getCellKey(tableId: string, rowId: string, columnId: string): string {
    return `${tableId}::${rowId}::${columnId}`
  }

  private normalizeCell(cell: Partial<Cell> & { id: string; rowId: string; columnId: string }): Cell {
    if (cell.tableId) {
      return cell as Cell
    }

    const inferredTableId = this.inferTableId(cell)
    return {
      ...cell,
      tableId: inferredTableId,
      id: this.getCellKey(inferredTableId, cell.rowId, cell.columnId),
      value: cell.value ?? null
    } as Cell
  }

  private inferTableId(cell: { rowId: string }): string {
    if (cell.rowId.includes('_')) {
      return cell.rowId.split('_')[0]
    }
    return 'default'
  }
}
