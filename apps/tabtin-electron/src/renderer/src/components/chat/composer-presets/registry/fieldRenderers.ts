/**
 * Level 1 字段类型原子渲染器注册表
 *
 * 框架内置基础类型（input / number / textarea / select / upload / toggle）。
 * 开发者可注册新字段类型（如 rating、code-editor）。
 */

import type { FieldRendererComponent, PresetFieldType } from './types'

const FIELD_RENDERERS: Record<string, FieldRendererComponent> = {}

export function registerFieldRenderer(
  type: PresetFieldType | string,
  component: FieldRendererComponent,
): void {
  FIELD_RENDERERS[type] = component
}

export function getFieldRenderer(type: string): FieldRendererComponent | null {
  return FIELD_RENDERERS[type] ?? null
}

export function hasFieldRenderer(type: string): boolean {
  return type in FIELD_RENDERERS
}

/** @internal 仅测试用：清空注册表 */
export function __resetFieldRenderersForTesting(): void {
  for (const key of Object.keys(FIELD_RENDERERS)) {
    delete FIELD_RENDERERS[key]
  }
}
