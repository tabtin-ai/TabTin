/**
 * Level 2 自定义渲染器注册表
 *
 * 与 cardRenderers.ts 对称。
 * 仅用于声明式 fields 无法满足的复杂场景。
 */

import type { ComposerPresetComponent } from './types'

const COMPOSER_RENDERERS: Record<string, ComposerPresetComponent> = {}

export function registerComposerRenderer(
  name: string,
  component: ComposerPresetComponent,
): void {
  COMPOSER_RENDERERS[name] = component
}

export function getComposerRenderer(name: string): ComposerPresetComponent | null {
  return COMPOSER_RENDERERS[name] ?? null
}

/** @internal 仅测试用：清空注册表 */
export function __resetComposerRenderersForTesting(): void {
  for (const key of Object.keys(COMPOSER_RENDERERS)) {
    delete COMPOSER_RENDERERS[key]
  }
}
