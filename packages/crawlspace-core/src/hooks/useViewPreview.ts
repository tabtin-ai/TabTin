/**
 * useViewPreview - 通用视图预览/复用 Hook
 *
 * 封装 URL 预览逻辑，支持视图复用和创建
 * 适用场景：需要预览 URL 的模式
 *
 * @module useViewPreview
 */

import { useState, useCallback, useRef } from 'react'
import { isValidUrl, autocompleteUrl as defaultAutocompleteUrl } from '../utils/helpers'
import type { ViewId, ViewInfo } from '../types'
import { t } from '../i18n'

export interface UseViewPreviewOptions {
  /**
   * 现有视图列表
   */
  views: ViewInfo[]

  /**
   * 当前激活的视图 ID
   */
  activeViewId: ViewId | null

  /**
   * 创建新视图的方法
   * @param url 目标 URL
   * @param title 视图标题（可选）
   * @returns 新创建的视图 ID
   */
  createView: (url: string, title?: string) => Promise<ViewId | null>

  /**
   * 切换到指定视图
   * @param viewId 视图 ID
   */
  switchView?: (viewId: ViewId) => Promise<void>

  /**
   * URL 验证函数（可选，默认使用简单的 URL 构造器验证）
   */
  validateUrl?: (url: string) => boolean

  /**
   * URL 自动补全函数（可选，默认无处理）
   */
  autocompleteUrl?: (url: string) => string

  /**
   * 是否激活（用于跳过非活动状态下的预览）
   */
  isActive?: boolean

  /**
   * 日志前缀（用于调试）
   */
  logPrefix?: string
}

export interface UseViewPreviewReturn {
  /**
   * 当前预览的 URL
   */
  previewUrl: string

  /**
   * 是否正在创建预览
   */
  isCreatingPreview: boolean

  /**
   * 预览错误信息
   */
  previewError: string | null

  /**
   * 创建或复用预览视图
   * @param url 目标 URL
   * @param options 可选配置
   * @returns 视图 ID（如果成功）
   */
  preview: (url: string, options?: {
    title?: string
    forceNew?: boolean  // 强制创建新视图，不复用
  }) => Promise<ViewId | null>

  /**
   * 清除预览错误
   */
  clearPreviewError: () => void
}

const defaultValidateUrl = isValidUrl

/**
 * 通用视图预览/复用 Hook
 *
 * @example
 * ```typescript
 * const { preview, previewUrl, isCreatingPreview, previewError } = useViewPreview({
 *   views: context.viewManager.views,
 *   activeViewId: context.viewManager.activeViewId,
 *   createView: context.viewManager.createView,
 *   switchView: context.viewManager.switchView,
 *   isActive: true
 * });
 *
 * // 预览 URL（自动复用或创建）
 * const viewId = await preview('https://example.com');
 *
 * // 强制创建新视图
 * const newViewId = await preview('https://example.com', { forceNew: true });
 * ```
 */
export function useViewPreview(options: UseViewPreviewOptions): UseViewPreviewReturn {
  const {
    views,
    activeViewId,
    createView,
    switchView,
    validateUrl = defaultValidateUrl,
    autocompleteUrl = defaultAutocompleteUrl,
    isActive = true,
    logPrefix = '[ViewPreview]'
  } = options

  const [previewUrl, setPreviewUrl] = useState<string>('')
  const [isCreatingPreview, setIsCreatingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // 防止重复创建
  const isCreatingRef = useRef(false)

  const preview = useCallback(async (
    url: string,
    previewOptions?: { title?: string; forceNew?: boolean }
  ): Promise<ViewId | null> => {
    // 检查是否激活
    if (!isActive) {
      console.warn(`${logPrefix} inactive, skipping preview:`, url)
      return null
    }

    // 防止重复创建
    if (isCreatingRef.current) {
      return activeViewId
    }

    // URL 自动补全
    const normalizedUrl = autocompleteUrl(url)

    // URL 验证
    if (!validateUrl(normalizedUrl)) {
      const errorMsg = t('preview.error.invalidUrl', { url })
      console.warn(`${logPrefix}`, errorMsg)
      setPreviewError(errorMsg)
      return null
    }

    try {
      isCreatingRef.current = true
      setIsCreatingPreview(true)
      setPreviewError(null)

      // 检查是否复用已有视图（除非强制创建新视图）
      if (!previewOptions?.forceNew) {
        const existingView = views.find(v => v.url === normalizedUrl)
        if (existingView) {
          // 切换到该视图
          if (switchView) {
            await switchView(existingView.viewId)
          }

          setPreviewUrl(normalizedUrl)
          return existingView.viewId
        }
      }

      // 创建新视图
      const title = previewOptions?.title || new URL(normalizedUrl).hostname
      const viewId = await createView(normalizedUrl, title)

      if (!viewId) {
        throw new Error(t('preview.error.createViewFailed'))
      }

      setPreviewUrl(normalizedUrl)

      return viewId

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : t('preview.error.previewFailed')
      console.error(`${logPrefix} preview failed:`, error)
      setPreviewError(errorMsg)
      return null

    } finally {
      isCreatingRef.current = false
      setIsCreatingPreview(false)
    }
  }, [
    views,
    activeViewId,
    createView,
    switchView,
    validateUrl,
    autocompleteUrl,
    isActive,
    logPrefix
  ])

  const clearPreviewError = useCallback(() => {
    setPreviewError(null)
  }, [])

  return {
    previewUrl,
    isCreatingPreview,
    previewError,
    preview,
    clearPreviewError
  }
}





