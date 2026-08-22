/**
 * 资源缓存管理模块
 *
 * 职责：
 * 1. 管理从 Main Process 传递的网络响应缓存（包含图片 base64）
 * 2. 提供资源查找和获取接口
 * 3. 支持缓存清理（上传完成后）
 *
 * 优势：
 * - 避免重复下载（利用浏览器已加载的资源）
 * - 解决防盗链、跨域、资源失效等问题
 * - 提高性能和成功率
 */

import type { NetworkResponse } from '@/components/crawl/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('ResourceCache')

export interface CachedResource {
  url: string
  resourceId?: string
  viewId?: string
  category?: string
  captureStatus?: string
  blob: Blob
  mimeType: string
  size: number
  cachedAt: number
}

export interface ResourceCacheStats {
  totalCount: number
  imageCount: number
  mediaCount: number
  totalSize: number
  urls: string[]
}

export class ResourceCache {
  private cache: Map<string, CachedResource> = new Map()

  /**
   * 从网络响应中加载资源到缓存
   */
  async loadFromNetworkResponses(networkResponses: NetworkResponse[]): Promise<ResourceCacheStats> {
    const startTime = Date.now()
    log.debug(`开始加载网络响应到缓存: ${networkResponses.length} 个`)

    let imageCount = 0
    let mediaCount = 0
    let totalSize = 0
    const urls: string[] = []

    for (const response of networkResponses) {
      // 必须有 body（base64 数据）
      if (!response.body) {
        continue
      }

      try {
        const contentKind = response.contentKind
          || (response.body.startsWith('data:') ? 'data_url' : 'text')
        const mimeType = response.mimeType || (contentKind === 'text' ? 'text/plain' : 'application/octet-stream')
        const blob = contentKind === 'data_url'
          ? await this.base64ToBlob(response.body, mimeType)
          : new Blob([response.body], { type: mimeType })

        const cached: CachedResource = {
          url: response.url,
          resourceId: response.resourceId,
          viewId: response.viewId,
          category: response.category,
          captureStatus: response.captureStatus,
          blob,
          mimeType,
          size: blob.size,
          cachedAt: Date.now()
        }

        this.cache.set(response.url, cached)

        if (mimeType.startsWith('image/')) {
          imageCount++
        } else {
          mediaCount++
        }
        totalSize += blob.size
        urls.push(response.url)

        log.debug(`缓存成功: ${response.url} (${this.formatBytes(blob.size)})`)
      } catch (error) {
        log.error(`缓存失败: ${response.url}`, error)
      }
    }

    const duration = Date.now() - startTime
    const stats: ResourceCacheStats = {
      totalCount: this.cache.size,
      imageCount,
      mediaCount,
      totalSize,
      urls
    }

    log.info(`缓存加载完成 (${duration}ms):`, {
      总数: stats.totalCount,
      图片数: stats.imageCount,
      媒体数: stats.mediaCount,
      总大小: this.formatBytes(stats.totalSize)
    })

    return stats
  }

  /**
   * 获取缓存的资源
   */
  get(url: string): CachedResource | undefined {
    return this.cache.get(url)
  }

  /**
   * 检查资源是否在缓存中
   */
  has(url: string): boolean {
    return this.cache.has(url)
  }

  /**
   * 获取所有缓存的 URL
   */
  getCachedUrls(): string[] {
    return Array.from(this.cache.keys())
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): ResourceCacheStats {
    let totalSize = 0
    const urls: string[] = []

    for (const [url, resource] of this.cache.entries()) {
      totalSize += resource.size
      urls.push(url)
    }

    return {
      totalCount: this.cache.size,
      imageCount: Array.from(this.cache.values()).filter(item => item.mimeType.startsWith('image/')).length,
      mediaCount: Array.from(this.cache.values()).filter(item => !item.mimeType.startsWith('image/')).length,
      totalSize,
      urls
    }
  }

  /**
   * 清除指定 URL 的缓存
   */
  remove(url: string): boolean {
    const result = this.cache.delete(url)
    if (result) {
      log.debug(`已移除缓存: ${url}`)
    }
    return result
  }

  /**
   * 批量清除缓存
   */
  removeBatch(urls: string[]): number {
    let count = 0
    for (const url of urls) {
      if (this.cache.delete(url)) {
        count++
      }
    }
    log.debug(`批量移除缓存: ${count} / ${urls.length}`)
    return count
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    const count = this.cache.size
    this.cache.clear()
    log.debug(`清空所有缓存: ${count} 个`)
  }

  /**
   * 将 base64 字符串转换为 Blob
   * 支持两种格式：
   * 1. data:image/png;base64,iVBORw0KG...
   * 2. iVBORw0KG...（纯 base64）
   */
  private async base64ToBlob(base64: string, mimeType: string): Promise<Blob> {
    // 如果是 data URL 格式，提取 base64 部分
    let base64Data = base64
    if (base64.startsWith('data:')) {
      const match = base64.match(/^data:[^;]+;base64,(.+)$/)
      if (match) {
        base64Data = match[1]
      }
    }

    // 解码 base64
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }

    return new Blob([bytes], { type: mimeType })
  }

  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
  }
}

/**
 * 创建单例实例
 */
export const resourceCache = new ResourceCache()
