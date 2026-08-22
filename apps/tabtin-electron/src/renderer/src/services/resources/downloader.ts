/**
 * 资源下载模块
 * 负责下载图片/文件到本地缓存
 *
 * 下载策略（优先级）：
 * 1. 从 ResourceCache 读取（浏览器已加载的资源）
 * 2. 通过 HTTPS 请求下载
 * 3. 失败后重试
 */

import pLimit from 'p-limit'
import { resourceCache, type ResourceCache } from './resource-cache'
import i18n from '@/i18n'
import { formatFileSize } from '@/constants/upload'
import { createLogger } from '@/utils/logger'

const log = createLogger('Downloader')

// ========== 类型定义 ==========

/**
 * 下载任务
 */
export interface DownloadTask {
  url: string                    // 资源URL
  fieldName: string              // 字段名称
  recordIndex: number            // 记录索引
  resourceId?: string
  viewId?: string
  category?: string
  captureStatus?: string
}

/**
 * 下载结果
 */
export interface DownloadResult {
  url: string                    // 原始URL
  fieldName: string              // 字段名称
  recordIndex: number            // 记录索引
  resourceId?: string
  viewId?: string
  category?: string
  captureStatus?: string
  success: boolean               // 是否成功
  localPath?: string             // 本地路径（成功时）
  blob?: Blob                    // 文件Blob（成功时）
  fileName?: string              // 文件名
  fileSize?: number              // 文件大小
  mimeType?: string              // MIME类型
  error?: string                 // 错误信息（失败时）
  retries?: number               // 重试次数
  source?: 'cache' | 'network'   // 数据来源
}

/**
 * 下载进度回调
 */
export interface DownloadProgress {
  total: number                  // 总任务数
  completed: number              // 已完成数
  failed: number                 // 失败数
  fromCache: number              // 从缓存获取的数量
  fromNetwork: number            // 从网络下载的数量
  current?: string               // 当前下载的URL
  percentage: number             // 完成百分比 (0-100)
}

/**
 * 下载配置
 */
export interface DownloaderConfig {
  concurrency?: number           // 并发数（默认3）
  maxRetries?: number            // 最大重试次数（默认3）
  timeout?: number               // 超时时间（毫秒，默认30000）
  resourceCache?: ResourceCache  // 资源缓存实例（可选，默认使用全局单例）
  onProgress?: (progress: DownloadProgress) => void  // 进度回调
}

// ========== ResourceDownloader 类 ==========

/**
 * 资源下载管理器
 */
export class ResourceDownloader {
  private config: Required<Omit<DownloaderConfig, 'resourceCache' | 'onProgress'>> & {
    onProgress: (progress: DownloadProgress) => void
  }
  private cache: Map<string, DownloadResult> = new Map()
  private resourceCache: ResourceCache
  private systemUA: string | null = null  // ✅ 缓存系统 UA

  constructor(config: DownloaderConfig = {}) {
    this.config = {
      concurrency: config.concurrency || 3,
      maxRetries: config.maxRetries || 3,
      timeout: config.timeout || 30000,
      onProgress: config.onProgress || (() => {})
    }
    this.resourceCache = config.resourceCache || resourceCache

    // ✅ 初始化时从主进程获取系统 UA
    this.initSystemUA()
  }

  /**
   * 从 navigator.userAgent 取系统 User-Agent。
   *
   * contract W2-β：原实现走 main 进程的 `app.getSystemUserAgent()`（通过裸
   * `window.electron` IPC），违反 renderer 不直接 import ipcRenderer
   * 的契约（北极星 2）。Electron renderer 的 `navigator.userAgent` 已是同源 Chromium
   * 字符串，对 OSS / 静态资源 CDN 几乎所有目标主机区分不出"主进程 UA vs renderer UA"
   * 的差异——即让出 main 端"完整 OS 版本号"也无关紧要，足够实际下载兜底。
   *
   * 后续真要恢复主进程 UA：preload 层补一条 `getSystemUA: () => invokeIpc('get-system-ua')`
   * 即可，本期 caller 改造不动 preload，登记 P2 遗留待 W2-γ 顺手补。
   */
  private async initSystemUA(): Promise<void> {
    this.systemUA = navigator.userAgent
    log.debug('系统 UA（navigator）:', this.systemUA?.substring(0, 50) + '...')
  }

  /**
   * 批量下载资源
   */
  async downloadBatch(tasks: DownloadTask[]): Promise<DownloadResult[]> {
    if (tasks.length === 0) {
      return []
    }

    log.info(`开始批量下载: ${tasks.length} 个资源`)
    log.debug(`ResourceCache 可用资源: ${this.resourceCache.getStats().totalCount} 个`)

    const results: DownloadResult[] = []
    let completed = 0
    let failed = 0
    let fromCache = 0
    let fromNetwork = 0

    // 创建并发限制器
    const limit = pLimit(this.config.concurrency)

    // 进度报告函数
    const reportProgress = (current?: string) => {
      const percentage = Math.round((completed / tasks.length) * 100)
      this.config.onProgress({
        total: tasks.length,
        completed,
        failed,
        fromCache,
        fromNetwork,
        current,
        percentage
      })
    }

    // 初始进度
    reportProgress()

    // 创建下载Promise数组
    const downloadPromises = tasks.map((task) =>
      limit(async () => {
        try {
          // 检查内存缓存
          const cacheKey = this.getCacheKey(task.url)
          if (this.cache.has(cacheKey)) {
            log.debug(`命中内存缓存: ${task.url}`)
            const cachedResult = this.cache.get(cacheKey)!
            completed++
            if (cachedResult.source === 'cache') {
              fromCache++
            } else {
              fromNetwork++
            }
            reportProgress(task.url)
            return {
              ...cachedResult,
              resourceId: task.resourceId,
              viewId: task.viewId,
              category: task.category,
              captureStatus: task.captureStatus,
              fieldName: task.fieldName,
              recordIndex: task.recordIndex
            }
          }

          const bridgedResult = await this.tryDownloadFromResourceBridge(task)
          if (bridgedResult) {
            this.cache.set(cacheKey, bridgedResult)
            completed++
            fromCache++
            reportProgress(task.url)
            return bridgedResult
          }

          // 优先从 ResourceCache 获取
          const cachedResource = this.resourceCache.get(task.url)
          if (cachedResource) {
            log.debug(`从 ResourceCache 获取: ${task.url} (${formatFileSize(cachedResource.size)})`)

            const fileName = this.extractFileName(task.url, cachedResource.mimeType)
            const result: DownloadResult = {
              url: task.url,
              fieldName: task.fieldName,
              recordIndex: task.recordIndex,
              resourceId: task.resourceId || cachedResource.resourceId,
              viewId: task.viewId || cachedResource.viewId,
              category: task.category || cachedResource.category,
              captureStatus: task.captureStatus || cachedResource.captureStatus,
              success: true,
              blob: cachedResource.blob,
              fileName,
              fileSize: cachedResource.size,
              mimeType: cachedResource.mimeType,
              retries: 0,
              source: 'cache'
            }

            // 缓存到内存
            this.cache.set(cacheKey, result)
            completed++
            fromCache++
            reportProgress(task.url)
            return result
          }

          // ResourceCache 未命中，通过网络下载
          log.debug(`ResourceCache 未命中，通过网络下载: ${task.url}`)
          reportProgress(task.url)
          const result = await this.downloadSingleWithRetry(task)

          if (result.success) {
            // 缓存成功结果
            this.cache.set(cacheKey, result)
            completed++
            fromNetwork++
          } else {
            failed++
          }

          reportProgress(task.url)
          return result
        } catch (error) {
          failed++
          const errorMsg = error instanceof Error ? error.message : String(error)
          log.error(`下载失败: ${task.url}`, error)

          reportProgress(task.url)
          return {
            url: task.url,
            fieldName: task.fieldName,
            recordIndex: task.recordIndex,
            success: false,
            error: errorMsg
          }
        }
      })
    )

    // 等待所有下载完成
    results.push(...(await Promise.all(downloadPromises)))

    // 最终进度
    reportProgress()

    log.info(
      `批量下载完成: 成功 ${completed}/${tasks.length}, 失败 ${failed}, 缓存 ${fromCache}, 网络 ${fromNetwork}`
    )

    return results
  }

  /**
   * 单个资源下载（带重试）
   */
  private async downloadSingleWithRetry(task: DownloadTask): Promise<DownloadResult> {
    let lastError: Error | null = null
    let retries = 0

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        // 智能重试策略
        const options: { referer?: string } = {};

        // 如果是重试，且上一次是 403，尝试添加 Referer
        if (attempt > 0 && lastError && (lastError.message.includes('403') || lastError.message.includes('Forbidden'))) {
            // 针对豆瓣图片的特殊处理
            if (task.url.includes('doubanio.com')) {
                options.referer = 'https://movie.douban.com/';
            } else {
                // 默认尝试使用源站域名作为 Referer
                try {
                    const u = new URL(task.url);
                    options.referer = `${u.protocol}//${u.hostname}/`;
                } catch (e) {}
            }
            log.debug(`403重试，添加 Referer: ${options.referer}`);
        }

        const result = await this.downloadSingle(task.url, options)

        // 生成文件名
        const fileName = this.extractFileName(task.url, result.type)

        return {
          url: task.url,
          fieldName: task.fieldName,
          recordIndex: task.recordIndex,
          resourceId: task.resourceId,
          viewId: task.viewId,
          category: task.category,
          captureStatus: task.captureStatus,
          success: true,
          blob: result,
          fileName,
          fileSize: result.size,
          mimeType: result.type,
          retries,
          source: 'network'
        }
      } catch (error) {
        lastError = error as Error
        retries++

        if (attempt < this.config.maxRetries) {
          log.warn(
            `重试 ${attempt + 1}/${this.config.maxRetries}: ${task.url}`
          )
          // 指数退避：1s, 2s, 4s
          await this.sleep(Math.pow(2, attempt) * 1000)
        }
      }
    }

    return {
      url: task.url,
      fieldName: task.fieldName,
      recordIndex: task.recordIndex,
      resourceId: task.resourceId,
      viewId: task.viewId,
      category: task.category,
      captureStatus: task.captureStatus,
      success: false,
      error: lastError?.message || i18n.t('crawl:resource.errors.downloadFailed'),
      retries
    }
  }

  /**
   * 下载单个资源
   */
  async downloadSingle(url: string, options: { referer?: string } = {}): Promise<Blob> {
    log.debug(`下载: ${url}${options.referer ? ` (Ref: ${options.referer})` : ''}`)

    // ✅ 确保 systemUA 已初始化
    if (!this.systemUA) {
      await this.initSystemUA()
    }

    // 创建 AbortController 用于超时控制
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout)

    try {
      const headers: Record<string, string> = {
        // ✅ 修复：使用从主进程获取的系统 UA
        'User-Agent': this.systemUA || navigator.userAgent
      };

      if (options.referer) {
        headers['Referer'] = options.referer;
      }

      const response = await fetch(url, {
        signal: controller.signal,
        headers
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const blob = await response.blob()

      // 验证blob大小
      if (blob.size === 0) {
        throw new Error(i18n.t('crawl:resource.errors.fileSizeZero'))
      }

      log.debug(`下载成功: ${url} (${formatFileSize(blob.size)})`)

      return blob
    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          i18n.t('crawl:resource.errors.timeout', { ms: this.config.timeout })
        )
      }

      throw error
    }
  }

  /**
   * 对 blob:/页面内捕获资源优先走主进程桥接，避免 renderer 裸 fetch 失效。
   */
  private async tryDownloadFromResourceBridge(task: DownloadTask): Promise<DownloadResult | null> {
    const inspectedResource = await this.inspectResourceViaBridge(task)
    if (!this.shouldUseResourceBridge(task, inspectedResource)) {
      return null
    }

    let resource = inspectedResource
    if (!resource?.contentRef) {
      const response = await window.tabtin.resourceDetection.captureResource({
        resourceId: task.resourceId,
        viewId: task.viewId,
        force: (resource?.captureStatus || task.captureStatus) === 'page_bound_blob' || task.url.startsWith('blob:')
      })

      if (!response?.success) {
        throw new Error(response?.error || i18n.t('crawl:resource.errors.downloadFailed'))
      }

      resource = response.data?.resource
    }

    const contentRef = resource?.contentRef
    if (!contentRef) {
      if (/^https?:/i.test(task.url)) {
        return null
      }
      throw new Error('资源未返回可下载内容')
    }

    const blob = await this.contentRefToBlob(contentRef)
    const mimeType = contentRef.mimeType || blob.type || undefined
    const fileName = this.extractFileName(task.url, mimeType)

    return {
      url: task.url,
      fieldName: task.fieldName,
      recordIndex: task.recordIndex,
      resourceId: resource?.resourceId || task.resourceId,
      viewId: resource?.viewId || task.viewId,
      category: resource?.category || task.category,
      captureStatus: resource?.captureStatus || task.captureStatus,
      success: true,
      blob,
      fileName,
      fileSize: blob.size,
      mimeType,
      retries: 0,
      source: 'cache'
    }
  }

  private async inspectResourceViaBridge(task: DownloadTask): Promise<any | null> {
    if (!task.resourceId || !task.viewId) {
      return null
    }

    if (!window.tabtin.resourceDetection.inspectResource) {
      return null
    }

    const response = await window.tabtin.resourceDetection.inspectResource({
      resourceId: task.resourceId,
      viewId: task.viewId
    })

    if (!response?.success) {
      return null
    }

    return response.data?.resource || null
  }

  private shouldUseResourceBridge(task: DownloadTask, resource?: { contentRef?: { kind?: string }; captureStatus?: string } | null): boolean {
    if (!task.resourceId || !task.viewId) {
      return false
    }

    if (resource?.contentRef?.kind) {
      return true
    }

    if (!/^https?:/i.test(task.url)) {
      return true
    }

    return (resource?.captureStatus || task.captureStatus) === 'page_bound_blob'
  }

  /**
   * 校验 filePath 是否在安全沙盒目录内，防止任意文件读取。
   * 拒绝目录遍历、相对路径、空字节注入和已知敏感目录。
   */
  private isFilePathSafe(filePath: string): boolean {
    if (!filePath || typeof filePath !== 'string') return false
    if (filePath.includes('\0')) return false
    if (filePath.includes('..')) return false
    if (!filePath.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(filePath)) return false

    const normalized = filePath.toLowerCase().replace(/\\/g, '/')
    const sensitivePatterns = [
      '/etc/', '/var/', '/usr/', '/proc/', '/sys/', '/dev/',
      '/.ssh/', '/.gnupg/', '/.config/', '/.local/share/keyrings',
      '/windows/system32', '/windows/syswow64',
    ]
    for (const pattern of sensitivePatterns) {
      if (normalized.includes(pattern)) return false
    }

    return true
  }

  private async contentRefToBlob(contentRef: { kind?: string; data?: string; mimeType?: string; filePath?: string }): Promise<Blob> {
    if (contentRef.kind === 'data_url' && contentRef.data) {
      const response = await fetch(contentRef.data)
      return await response.blob()
    }

    if (contentRef.kind === 'text' && typeof contentRef.data === 'string') {
      return new Blob([contentRef.data], { type: contentRef.mimeType || 'text/plain' })
    }

    if (contentRef.kind === 'file_path' && contentRef.filePath) {
      if (!this.isFilePathSafe(contentRef.filePath)) {
        throw new Error(`安全校验失败: 文件路径不在允许的目录范围内`)
      }

      // contract W2-β：旧 envelope `{success, data: {content, kind, mime}, error}`
      // 改为 invokeIpc 直接返 `{ content, kind, mime }` 或 throw。
      // 失败时把 PlatformIpcError 文案包装一层"主进程拒绝读取文件"语义抛出，
      // 让 caller 能区分"业务侧拒绝"和"通道不可用"两种情况（后者下面 throw "无法通过安全通道"）。
      let preview: { content?: string; kind?: string; mime?: string } | undefined
      try {
        // @ts-ignore - window.tabtin is defined in preload
        preview = await window.tabtin?.fileSystem?.readFilePreview?.(
          contentRef.filePath,
          { maxBytes: 50 * 1024 * 1024 }
        )
      } catch (err) {
        throw new Error(`主进程拒绝读取文件: ${err instanceof Error ? err.message : '未知错误'}`)
      }

      if (preview?.content) {
        if (preview.kind === 'image' && preview.mime) {
          const byteString = atob(preview.content)
          const ab = new ArrayBuffer(byteString.length)
          const ia = new Uint8Array(ab)
          for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i)
          }
          return new Blob([ab], { type: preview.mime })
        }

        if (preview.kind === 'text') {
          return new Blob([preview.content], { type: contentRef.mimeType || 'text/plain' })
        }
      }

      throw new Error(`无法通过安全通道读取文件: ${contentRef.filePath}`)
    }

    throw new Error('暂不支持的资源内容格式')
  }

  /**
   * 获取缓存键（浏览器兼容版本）
   */
  private getCacheKey(url: string): string {
    // 使用简单的哈希函数，适用于浏览器环境
    let hash = 0
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36)
  }

  /**
   * 提取文件名
   */
  private extractFileName(url: string, mimeType?: string): string {
    try {
      // 从URL提取文件名
      const urlObj = new URL(url)
      const pathname = urlObj.pathname
      const segments = pathname.split('/').filter(Boolean)
      let fileName = segments[segments.length - 1] || 'file'

      // 获取文件扩展名（浏览器兼容版本）
      const lastDotIndex = fileName.lastIndexOf('.')
      const hasExtension = lastDotIndex > 0 && lastDotIndex < fileName.length - 1

      // 如果文件名没有扩展名，根据MIME类型添加
      if (!hasExtension && mimeType) {
        const ext = this.getExtensionFromMimeType(mimeType)
        if (ext) {
          fileName += `.${ext}`
        }
      }

      // 清理文件名（移除查询参数等）
      fileName = fileName.split('?')[0].split('#')[0]

      return fileName
    } catch (error) {
      log.warn(`无法解析文件名: ${url}`, error)
      if (mimeType) {
        const ext = this.getExtensionFromMimeType(mimeType)
        if (ext) {
          return `file_${Date.now()}.${ext}`
        }
      }
      return `file_${Date.now()}`
    }
  }

  /**
   * 根据MIME类型获取扩展名
   */
  private getExtensionFromMimeType(mimeType: string): string | null {
    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'audio/flac': 'flac',
      'application/vnd.apple.mpegurl': 'm3u8',
      'application/x-mpegurl': 'm3u8',
      'application/dash+xml': 'mpd',
      'text/plain': 'txt',
      'application/json': 'json',
      'application/pdf': 'pdf',
      'application/zip': 'zip',
      'application/x-rar-compressed': 'rar',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
    }

    return mimeMap[mimeType.toLowerCase()] || null
  }


  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear()
    log.debug('缓存已清空')
  }

  /**
   * 获取缓存大小
   */
  getCacheSize(): number {
    return this.cache.size
  }
}
