import {
  requestSnapshotTool,
  executeActTool,
} from '@tabtin/action-tools/tools';
import { t } from './i18n';

export interface SnapshotResult {
  url: string;
  title: string;
  skeletonHtml?: string;
  accessibilityTree?: string;
  xpathMap?: Record<string, string>;
  screenshotBase64?: string;
  executionTime?: number;
  errorCode?: string;
  retriable?: boolean;
}

export interface ActionResult {
  success: boolean;
  executedActions: any[];
  snapshot?: any;
  diff?: any;
  error?: string;
  errorCode?: string;
  retriable?: boolean;
}

/**
 * ActionToolsAdapter
 * 薄封装 @tabtin/action-tools，方便在工作流中调用。
 */

export { setActionToolsAdapterLocale, setActionToolsAdapterTranslator } from './i18n';
export class ActionToolsAdapter {
  /**
   * 判断错误码是否为可重试错误
   */
  private isRetriableErrorCode(errorCode?: string): boolean {
    if (!errorCode) return false;

    const retriableCodes = [
      'NETWORK_ERROR',
      'TIMEOUT',
      'PAGE_LOADING',
      'ELEMENT_NOT_VISIBLE',
      'RATE_LIMIT'
    ];

    return retriableCodes.some(code => errorCode.includes(code));
  }

  /**
   * 创建增强的错误对象
   */
  private createEnhancedError(message: string, errorCode?: string): Error {
    const error: any = new Error(message);
    error.code = errorCode;
    error.retriable = this.isRetriableErrorCode(errorCode);
    return error;
  }

  private getErrorMessage(error: unknown): string | undefined {
    if (!error) return undefined;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && 'message' in error) {
      return String((error as any).message);
    }
    return String(error);
  }

  async requestSnapshot(options: {
    runId: string;
    viewId?: string;
    includeDom?: boolean;
    includeScreenshot?: boolean;
    includeAccessibilityTree?: boolean;
  }): Promise<SnapshotResult> {
    const result = await requestSnapshotTool.execute({
      runId: options.runId,
      crawlTabId: options.viewId,
      include_dom: options.includeDom ?? true,
      include_screenshot: options.includeScreenshot ?? false,
      include_accessibility_tree: options.includeAccessibilityTree ?? true
    });

    if (!result.success || !result.data?.snapshot) {
      const errorCode = (result as any).error_code;
      throw this.createEnhancedError(
        this.getErrorMessage(result.error) || 'request_snapshot failed',
        errorCode
      );
    }

    const snap = result.data.snapshot;
    return {
      url: snap.url,
      title: snap.title,
      skeletonHtml: snap.skeleton_html,
      accessibilityTree: snap.accessibility_tree,
      xpathMap: snap.xpath_map,
      screenshotBase64: snap.screenshot_base64,
      executionTime: result.data.frontend_execution_time_ms,
      errorCode: (result as any).error_code,
      retriable: this.isRetriableErrorCode((result as any).error_code)
    };
  }

  async executeActions(options: {
    runId: string;
    viewId?: string;
    actions: Array<{
      type: 'click' | 'fill' | 'scroll' | 'wait';
      selector?: string;
      value?: string;
      duration?: number;
    }>;
    stopOnError?: boolean;
  }): Promise<ActionResult> {
    const result = await executeActTool.execute({
      runId: options.runId,
      crawlTabId: options.viewId,
      actions: options.actions,
      stop_on_error: options.stopOnError ?? true
    } as any);

    const errorCode = (result as any).error_code;
    return {
      success: result.success,
      executedActions: result.executed_actions || [],
      snapshot: (result as any).snapshot,
      diff: (result as any).diff,
      error: this.getErrorMessage(result.error),
      errorCode,
      retriable: this.isRetriableErrorCode(errorCode)
    };
  }

}

let sharedAdapter: ActionToolsAdapter | null = null;
export function getActionToolsAdapter(): ActionToolsAdapter {
  if (!sharedAdapter) {
    sharedAdapter = new ActionToolsAdapter();
  }
  return sharedAdapter;
}
