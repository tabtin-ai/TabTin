/**
 * CrawlToolImpl - 抓取工具实现类
 *
 * 抓取清洗工具实现，提供 HTML 清洗等工具接口。
 * 内置 withRetry 机制：仅对网络/超时等瞬态错误重试，
 * URL 无效/权限拒绝等逻辑错误直接返回。
 */

import type { CrawlCleanHtmlInput, CrawlCleanHtmlOutput } from '../types';
import { ToolErrorCode, ToolErrorFactory, isRetriableError, type ToolError } from '../types/errors';
import { mapToToolErrorCode } from '../utils/error';
import { resolveRunSessionAPI } from '../utils/runtime-bridge';
import { t } from '../i18n';
import { withRetry } from './utils/retry';
import {
  type CrawlToolRunner,
  getCrawlToolRunnerFactoryOrThrow,
} from './crawl-runner';

const CRAWL_RETRY_MAX_ATTEMPTS = 3;
const CRAWL_RETRY_BASE_MS = 2000;

/**
 * 工具实现类（单例模式）
 */
export class CrawlToolImpl {
  private runner: CrawlToolRunner;

  constructor(private webContentsAdapter?: any) {
    const factory = getCrawlToolRunnerFactoryOrThrow();
    this.runner = factory(webContentsAdapter);
  }

  /**
   * 抓取并清洗 HTML（带智能重试）
   */
  async crawlCleanHtml(input: CrawlCleanHtmlInput): Promise<CrawlCleanHtmlOutput> {
    const { url, waitForDynamic = true, timeout = 30000, runId } = input as any;

    console.log('[CrawlToolImpl] 开始抓取:', { url, waitForDynamic, timeout });

    const result = await withRetry(
      'crawlCleanHtml',
      async () => {
        try {
          const output = await this.runner.crawlCleanHtml(input);

          if (!output.success && output.error) {
            const errorMsg = (output.error as any)?.message || String(output.error);
            return {
              ...output,
              error: this.classifyError(errorMsg, url),
            };
          }

          return output;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[CrawlToolImpl] 抓取失败:', errorMessage);

          const formatted = this.formatError(error);
          return {
            success: false as const,
            clean_html: '',
            title: '',
            url,
            content_length: 0,
            error: this.classifyError(formatted, url),
          };
        }
      },
      { maxAttempts: CRAWL_RETRY_MAX_ATTEMPTS, baseMs: CRAWL_RETRY_BASE_MS },
    );

    this.recordRunEvent(runId, undefined, 'crawl_clean_html', {
      success: result.success,
      url: result.url || url,
      title: result.title,
      content_length: result.content_length,
      ...(result.error ? { error: result.error.message } : {}),
    });

    return result;
  }

  /**
   * 格式化错误信息
   */
  private formatError(error: any): string {
    if (!error) return t('errors.unknownError');

    const message = error.message || String(error);

    if (message.includes('HUMAN_CHECK_REQUIRED')) {
      return t('errors.captchaRequired');
    }

    if (message.includes('TIMEOUT') || message.includes('timeout')) {
      return t('errors.pageLoadTimeout');
    }

    if (message.includes('NAVIGATION_FAILED')) {
      return t('errors.navigationFailed');
    }

    const crashPatterns = ['destroyed', 'crashed', 'killed'];
    if (crashPatterns.some(p => message.toLowerCase().includes(p))) {
      return t('errors.pageCrashed') || 'Page crashed or was destroyed';
    }

    if (message.includes('not found')) {
      return t('errors.pageNotFound');
    }

    return message;
  }

  /**
   * 将错误信息分类为 retryable / fatal ToolError。
   * 网络/超时/连接 → retryable；URL 无效/权限拒绝 → fatal。
   */
  private classifyError(message: string, url: string): ToolError {
    const errorCode = this.inferCrawlErrorCode(message);
    const context = { url };

    if (isRetriableError(errorCode)) {
      return ToolErrorFactory.retriable(errorCode, message, context);
    }
    return ToolErrorFactory.fatal(errorCode, message, context);
  }

  /**
   * 从错误消息推断 crawl 场景下的 ToolErrorCode，
   * 覆盖 Node.js / Chromium 常见的网络级异常。
   */
  private inferCrawlErrorCode(message: string): ToolErrorCode {
    const msg = message.toLowerCase();

    const networkPatterns = [
      'econnrefused', 'enotfound', 'etimedout', 'econnreset', 'epipe',
      'err_connection', 'err_name_not_resolved', 'err_internet_disconnected',
      'err_network_changed', 'err_ssl', 'err_cert', 'net::err_',
      'fetch failed', 'network error', 'socket hang up',
    ];
    if (networkPatterns.some(p => msg.includes(p))) {
      return ToolErrorCode.NETWORK_ERROR;
    }

    const crashPatterns = ['destroyed', 'crashed', 'killed', 'render process gone'];
    if (crashPatterns.some(p => msg.includes(p))) {
      return ToolErrorCode.PAGE_CRASHED;
    }

    if (
      msg.includes('invalid url') || msg.includes('url is required') ||
      msg.includes('err_invalid_url') || msg.includes('err_disallowed_url_scheme')
    ) {
      return ToolErrorCode.INVALID_PARAMETER;
    }

    // 404 / 页面未找到 → fatal，避免误分类为 ELEMENT_NOT_FOUND（retriable）
    if (
      msg.includes('404') || msg.includes('page not found') ||
      msg.includes('页面未找到') || (msg.includes('not found') && (msg.includes('page') || msg.includes('404')))
    ) {
      return ToolErrorCode.PAGE_NOT_FOUND;
    }

    return mapToToolErrorCode(undefined, message);
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    await this.runner.cleanup?.();
    console.log('[CrawlToolImpl] 资源已清理');
  }

  private recordRunEvent(runId: string | undefined, viewId: string | undefined, type: string, data: any) {
    if (!runId && !viewId) return;

    try {
      const runSession = resolveRunSessionAPI();
      runSession?.addEvent?.({
        runId,
        viewId,
        type,
        data,
        timestamp: Date.now()
      });
    } catch (error) {
      console.warn('[CrawlToolImpl] ⚠️ 记录事件失败:', error);
    }
  }
}

/**
 * 单例实例（可选）
 * 在需要跨多次调用复用实例时使用
 */
let sharedInstance: CrawlToolImpl | null = null;

export function getSharedCrawlToolImpl(webContentsAdapter?: any): CrawlToolImpl {
  if (!sharedInstance) {
    sharedInstance = new CrawlToolImpl(webContentsAdapter);
  }
  return sharedInstance;
}

export function resetSharedCrawlToolImpl(): void {
  if (sharedInstance) {
    sharedInstance.cleanup();
    sharedInstance = null;
  }
}
