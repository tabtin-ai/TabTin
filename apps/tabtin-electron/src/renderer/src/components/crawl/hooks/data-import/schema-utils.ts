/**
 * Schema 推断与表格工具函数
 *
 * 从 useDataImport.ts 提取，提供字段名映射、表名生成、图标、类型推断等能力。
 */

import type { FieldType } from '@tabtin/table-core'
import type { TaskState } from '../../types'
import i18n from '@/i18n'

export function buildFieldDisplayNames(schema: any, fieldNames: string[]): Record<string, string> {
  const mapping: Record<string, string> = {}
  if (!schema || !Array.isArray(schema.fields)) return mapping
  for (const field of schema.fields) {
    const fieldName = field.name || field.key
    const description = field.description
    if (!fieldName) continue
    if (description && typeof description === 'string' && description.trim()) {
      mapping[fieldName] = description.trim()
    } else {
      mapping[fieldName] = fieldName
    }
  }
  return mapping
}

export function generateTableName(taskState: TaskState, pageTitle?: string, instruction?: string): string {
  const parts: string[] = []
  if (pageTitle && pageTitle.trim()) {
    parts.push(pageTitle.trim())
  } else if (taskState.taskId) {
    try {
      const url = new URL(taskState.taskId)
      const hostname = url.hostname.replace(/^www\./, '')
      parts.push(hostname)
    } catch {
      // fail-soft: taskId 非 URL 形态时跳过 hostname，仅靠 instruction + timestamp 命名
    }
  }
  if (instruction && instruction.trim()) {
    const cleanInstruction = instruction.trim().replace(/\s+/g, ' ')
    const maxInstructionLength = 30
    const truncatedInstruction = cleanInstruction.length > maxInstructionLength
      ? cleanInstruction.substring(0, maxInstructionLength) + '...'
      : cleanInstruction
    parts.push(truncatedInstruction)
  }
  const now = new Date()
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  parts.push(timestamp)
  if (parts.length === 1) {
    return i18n.t('crawl:dataImport.tableName.singlePart', { name: parts[0] })
  }
  return parts.join('_')
}

export function getRandomTableIcon(): string {
  const icons = ['📊', '📈', '📉', '📋', '📝', '📄', '📑', '📦', '🗂️', '📁', '📚', '🎯', '🔍', '⭐', '💡', '🎨', '🌟', '🔖', '📌', '🎪', '🎭', '🎬', '🎮', '🎲', '🎰', '🧩', '🎁', '🎈', '🎉', '🏆', '🥇', '🌈', '🔥', '⚡', '💎', '🎪', '🚀', '🛸', '🎡', '🎢']
  return icons[Math.floor(Math.random() * icons.length)]
}

export function inferFieldTypes(data: Array<Record<string, any>>, fieldNames: string[]): Record<string, FieldType> {
  const fieldTypes: Record<string, FieldType> = {}
  const sampleSize = Math.min(data.length, 100)
  const samples = data.slice(0, sampleSize)
  for (const fieldName of fieldNames) {
    const values = samples.map(record => record[fieldName]).filter(val => val !== null && val !== undefined && val !== '')
    if (values.length === 0) {
      fieldTypes[fieldName] = 'text'
      continue
    }
    fieldTypes[fieldName] = inferSingleFieldType(values)
  }
  return fieldTypes
}

const URL_RATIO_THRESHOLD = 0.8

function isUrlLike(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text) return false
  return /^https?:\/\//i.test(text)
    || /^\/\/(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:[:/?#].*)?$/.test(text)
    || /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:[:/?#].*)?$/.test(text)
}

export function inferSingleFieldType(values: any[]): FieldType {
  const isNumber = values.every(val => !isNaN(Number(val)))
  if (isNumber) return 'number'
  const isDate = values.every(val => !isNaN(Date.parse(val)))
  if (isDate) return 'date'
  const urlHits = values.filter(isUrlLike).length
  if (values.length > 0 && urlHits >= values.length * URL_RATIO_THRESHOLD) return 'url'
  return 'text'
}
