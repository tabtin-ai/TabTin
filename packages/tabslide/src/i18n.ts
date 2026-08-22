/**
 * TabSlide i18n 翻译配置
 *
 * 由于 @tabtin/tabslide 是一个独立的 React 包，
 * 它应该接受外部传入的 i18n 实例，而不是内部硬编码。
 *
 * 使用方式：
 * 1. 在宿主应用中配置 i18next 并导入 tabslide 翻译文件
 * 2. 使用 SlideEditor 或其他组件时，通过 context 传入 i18n 实例
 */

import { createContext, useContext } from 'react'

export interface TabSlideI18n {
  t: (key: string, options?: Record<string, unknown>) => string
  language: string
}

const TabSlideI18nContext = createContext<TabSlideI18n | null>(null)

export const TabSlideI18nProvider = TabSlideI18nContext.Provider

/**
 * 获取 TabSlide i18n 实例
 * 如果未提供，返回一个默认实现（直接返回 key）
 */
export function useTabSlideI18n(): TabSlideI18n {
  const ctx = useContext(TabSlideI18nContext)
  if (ctx) return ctx

  // 默认实现：直接返回 key（降级方案）
  return {
    t: (key: string) => key,
    language: 'zh-CN',
  }
}

/**
 * 快捷翻译函数
 */
export function useT() {
  const { t } = useTabSlideI18n()
  return (key: string, options?: Record<string, unknown>) => t(key, options)
}
