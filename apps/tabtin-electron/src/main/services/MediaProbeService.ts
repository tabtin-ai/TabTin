/**
 * MediaProbeService — DOM 层媒体元素探测
 *
 * 通过 CDP Runtime.evaluate 注入脚本，探测页面中的 <video>/<audio> 元素。
 * 补全 webRequest 被动检测的盲区：
 * - blob: URL（MediaSource 生成的视频流）
 * - 动态插入的媒体元素（SPA 路由跳转后出现）
 * - 通过 JS 设置 srcObject 的媒体（WebRTC 等）
 *
 * 设计原则：
 * - 按需调用，不持续驻留（避免性能开销）
 * - 只读探测，不修改页面状态
 * - 与 ResourceDetectionService 互补，探测结果注入其 store
 */

import type { WebContents } from 'electron'
import type { MediaElementInfo, ResourceCategory } from '@tabtin/action-tools/types'
import { createLogger } from '../logger'

const log = createLogger('MediaProbe')

export interface MediaProbeResult {
  /** 页面中发现的媒体元素 */
  elements: ProbeMediaElement[]
  /** 页面 URL */
  pageUrl: string
  /** 探测耗时（ms） */
  probeTimeMs: number
  /** 探测过程中的错误信息（存在时表示探测失败，elements 为空） */
  error?: string
}

export interface ProbeMediaElement {
  tagName: 'video' | 'audio'
  /** 当前播放的 URL（优先 currentSrc，其次 src） */
  currentSrc: string
  /** <source> 子元素的 src 列表 */
  sources: string[]
  /** 视频固有宽度 */
  videoWidth: number
  /** 视频固有高度 */
  videoHeight: number
  /** 媒体时长（秒），NaN/Infinity 会转为 undefined */
  duration?: number
  /** 是否使用 MediaSource API */
  usesMediaSource: boolean
  /** 海报图 */
  poster?: string
  /** 是否正在播放 */
  isPlaying: boolean
  /** 是否已暂停 */
  isPaused: boolean
  /** 当前时间（秒） */
  currentTime: number
  /** 缓冲范围末尾（秒） */
  buffered?: number
  /** 自然推断的资源类别 */
  inferredCategory: ResourceCategory
}

/**
 * 注入页面的探测脚本（纯 JS，无外部依赖）
 * 返回 JSON 格式的媒体元素列表
 */
const PROBE_SCRIPT = `
(() => {
  const results = [];

  const processElement = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'video' && tag !== 'audio') return null;

    const sources = [];
    el.querySelectorAll('source').forEach(s => {
      if (s.src) sources.push(s.src);
    });

    let duration = el.duration;
    if (!Number.isFinite(duration)) duration = undefined;

    let bufferedEnd;
    try {
      if (el.buffered && el.buffered.length > 0) {
        bufferedEnd = el.buffered.end(el.buffered.length - 1);
      }
    } catch (e) {}

    const usesMediaSource = !!(
      el.srcObject instanceof MediaSource ||
      (el.currentSrc && el.currentSrc.startsWith('blob:'))
    );

    return {
      tagName: tag,
      currentSrc: el.currentSrc || el.src || '',
      sources,
      videoWidth: el.videoWidth || 0,
      videoHeight: el.videoHeight || 0,
      duration,
      usesMediaSource,
      poster: el.poster || undefined,
      isPlaying: !el.paused && !el.ended && el.readyState > 2,
      isPaused: el.paused,
      currentTime: el.currentTime || 0,
      buffered: bufferedEnd
    };
  };

  document.querySelectorAll('video, audio').forEach(el => {
    const info = processElement(el);
    if (info) results.push(info);
  });

  // Shadow DOM 中的媒体元素
  const walkShadow = (root) => {
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        el.shadowRoot.querySelectorAll('video, audio').forEach(media => {
          const info = processElement(media);
          if (info) results.push(info);
        });
        walkShadow(el.shadowRoot);
      }
    });
  };
  walkShadow(document);

  // iframe 中的媒体（同源时可访问）
  document.querySelectorAll('iframe').forEach(iframe => {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (iframeDoc) {
        iframeDoc.querySelectorAll('video, audio').forEach(el => {
          const info = processElement(el);
          if (info) results.push(info);
        });
      }
    } catch (e) {
      // cross-origin iframe, skip
    }
  });

  return JSON.stringify(results);
})()
`

export class MediaProbeService {
  /**
   * 探测指定 view 中的媒体元素
   *
   * : 参数从 WebContentsView 收窄为 WebContents（内部只用 webContents）。
   */
  async probe(webContents: WebContents): Promise<MediaProbeResult> {
    const start = Date.now()
    const wc = webContents

    if (wc.isDestroyed()) {
      return { elements: [], pageUrl: '', probeTimeMs: 0 }
    }

    try {
      const rawJson = await wc.executeJavaScript(PROBE_SCRIPT, true)
      const rawElements: any[] = JSON.parse(rawJson)

      const elements: ProbeMediaElement[] = rawElements
        .filter(el => el.currentSrc || el.sources.length > 0)
        .map(el => ({
          ...el,
          inferredCategory: this.inferCategory(el)
        }))

      const probeTimeMs = Date.now() - start

      log.debug(
        `🎯 探测完成: 发现 ${elements.length} 个媒体元素 (${probeTimeMs}ms)`
      )

      if (elements.length > 0) {
        for (const el of elements) {
          const srcDisplay = el.currentSrc.substring(0, 80)
          const dims = el.videoWidth ? `${el.videoWidth}x${el.videoHeight}` : 'N/A'
          const dur = el.duration ? `${el.duration.toFixed(1)}s` : 'N/A'
          log.debug(
            `  ${el.tagName} | ${el.inferredCategory} | ${dims} | ${dur} | blob=${el.usesMediaSource} | ${srcDisplay}`
          )
        }
      }

      return {
        elements,
        pageUrl: wc.getURL(),
        probeTimeMs
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      log.warn('⚠️ 探测失败:', errorMsg)
      return {
        elements: [],
        pageUrl: wc.getURL() || '',
        probeTimeMs: Date.now() - start,
        error: errorMsg
      }
    }
  }

  /**
   * 从 ProbeMediaElement 构造 MediaElementInfo（用于注入 DetectedResource）
   */
  toMediaElementInfo(el: ProbeMediaElement): MediaElementInfo {
    return {
      tagName: el.tagName,
      currentSrc: el.currentSrc || undefined,
      sources: el.sources.length > 0 ? el.sources : undefined,
      videoWidth: el.videoWidth || undefined,
      videoHeight: el.videoHeight || undefined,
      duration: el.duration,
      usesMediaSource: el.usesMediaSource,
      poster: el.poster
    }
  }

  private inferCategory(el: any): ResourceCategory {
    if (el.tagName === 'audio') return 'audio'

    const src = (el.currentSrc || '').toLowerCase()
    if (src.includes('.m3u8')) return 'hls'
    if (src.includes('.mpd')) return 'dash'
    if (src.includes('.mp3') || src.includes('.aac') || src.includes('.ogg')) return 'audio'

    return 'video'
  }
}

let instance: MediaProbeService | null = null

export function getMediaProbeService(): MediaProbeService {
  if (!instance) {
    instance = new MediaProbeService()
  }
  return instance
}
