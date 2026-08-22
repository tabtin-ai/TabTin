/**
 * cardRenderers — 卡片渲染器注册表
 *
 * 将渲染器名称 (string) 映射到实际的 React 组件。
 * ToolStepCard 通过 toolCardRegistry 获取 renderer 名称，
 * 再从这里查找对应的 React 组件来渲染。
 *
 * 新增渲染器只需在 CARD_RENDERERS 中加一条。
 */

import type { CardRendererComponent } from './types'

/**
 * 已注册的渲染器映射。
 * key 与 ToolCardDescriptor.renderer 值一致。
 *
 * 初始为空，由各卡片组件文件调用 registerCardRenderer() 注册。
 * 也可直接在此文件中静态导入并注册。
 */
const CARD_RENDERERS: Record<string, CardRendererComponent> = {}

/** 注册一个卡片渲染器 */
export function registerCardRenderer(name: string, component: CardRendererComponent): void {
  CARD_RENDERERS[name] = component
}

/** 获取已注册的渲染器，未找到则返回 null */
export function getCardRenderer(name: string): CardRendererComponent | null {
  return CARD_RENDERERS[name] ?? null
}

/** 获取所有已注册的渲染器名称（调试用） */
export function getRegisteredRenderers(): string[] {
  return Object.keys(CARD_RENDERERS)
}
