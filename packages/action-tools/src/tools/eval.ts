import { isParsableExpression } from '@tabtin/browser-core';
import type { AgentTool } from '../types';
import type { ToolError } from '../types/errors';
import { ToolErrorCode } from '../types/errors';
import { standardizeLegacyResult } from '../utils/tool-output';
import { resolveRunSessionAPI, resolveCrawlViewAPI } from '../utils/runtime-bridge';
import { t } from '../i18n';

async function resolveViewIdFromRun(runId?: string): Promise<string | undefined> {
  if (!runId) return undefined;
  const runSession = resolveRunSessionAPI();
  const getter = runSession?.get;
  if (!getter) return undefined;
  try {
    const run = await getter.call(runSession, runId);
    if (run?.activeViewId) return run.activeViewId;
    if (run?.views?.length) return run.views[0].viewId;
  } catch (error) {
    console.warn('[eval:resolveViewIdFromRun] Failed:', error);
  }
  return undefined;
}

function resolveExecuteScript(): ((script: string, tabId?: string) => Promise<any>) | null {
  const crawlView = resolveCrawlViewAPI();
  if (crawlView?.executeScript) {
    return (script: string, tabId?: string) => crawlView.executeScript!(script, tabId);
  }
  return null;
}

// ==================== eval ====================

/**
 * 执行 JavaScript 的输入参数
 */
export interface EvalInput {
  /**
   * JavaScript 代码（函数体或表达式）
   *
   * 示例：
   * - 表达式：'document.title'
   * - 函数：'() => document.querySelectorAll("a").length'
   * - 元素函数：'(element) => element.textContent'
   */
  code: string;

  /**
   * 选择器（可选，如果提供则在元素上下文中执行）
   */
  selector?: string;

  /**
   * 超时时间（毫秒，默认 5000）
   */
  timeout?: number;

  /**
   * 是否等待元素可见（如果提供了 selector，默认 false）
   */
  waitForVisible?: boolean;

  /**
   * Run ID（用于事件归档）
   */
  runId?: string;

  /**
   * Electron View ID（使用已有标签页）
   */
  crawlTabId?: string;

  /**
   * 返回类型提示（用于 JSON 序列化，可选）
   * - 'json': 尝试 JSON.stringify
   * - 'text': 转换为字符串
   * - 'auto': 自动检测（默认）
   */
  returnType?: 'json' | 'text' | 'auto';
}

/**
 * 执行 JavaScript 的输出结果
 */
export interface EvalOutput {
  success: boolean;
  data?: Record<string, any>;

  /**
   * 执行结果（已序列化为 JSON）
   */
  result?: any;

  /**
   * 结果类型
   */
  resultType?: string;

  /**
   * 错误信息
   */
  error?: ToolError;


  /**
   * 执行耗时（毫秒）
   */
  duration?: number;
}

/**
 * Eval 工具
 *
 * 功能：
 * - 在页面上下文中执行 JavaScript
 * - 在元素上下文中执行 JavaScript
 * - 支持超时控制
 * - 支持可见性等待
 * - 自动序列化结果
 */
export const evalTool: AgentTool<EvalInput, EvalOutput> = {
  name: 'eval',

  description: t('tools.eval.description'),

  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: t('tools.eval.params.code')
      },
      selector: {
        type: 'string',
        description: t('tools.eval.params.selector')
      },
      timeout: {
        type: 'number',
        description: t('tools.eval.params.timeout'),
        default: 5000
      },
      waitForVisible: {
        type: 'boolean',
        description: t('tools.eval.params.waitForVisible'),
        default: false
      },
      returnType: {
        type: 'string',
        enum: ['json', 'text', 'auto'],
        description: t('tools.eval.params.returnType'),
        default: 'auto'
      },
      runId: {
        type: 'string',
        description: t('tools.eval.params.runId')
      },
      crawlTabId: {
        type: 'string',
        description: t('tools.eval.params.crawlTabId')
      }
    },
    required: ['code']
  },

  async execute(input: EvalInput): Promise<EvalOutput> {
    const startTime = Date.now();

    try {
      const executor = resolveExecuteScript();
      if (!executor) {
        return standardizeLegacyResult(
          {
            success: false,
            error: '当前环境不支持页面脚本执行。请确保已安装 Chrome/Chromium 浏览器，或使用 Electron 桌面客户端。',
            error_code: ToolErrorCode.CAPABILITY_UNAVAILABLE
          },
          { defaultErrorCode: ToolErrorCode.CAPABILITY_UNAVAILABLE }
        );
      }

      let viewId = input.crawlTabId;
      if (!viewId) {
        viewId = await resolveViewIdFromRun(input.runId);
      }
      if (!viewId) {
        return standardizeLegacyResult(
          {
            success: false,
            error: t('errors.evalViewIdRequired'),
            error_code: ToolErrorCode.INVALID_PARAMETER
          },
          { defaultErrorCode: ToolErrorCode.INVALID_PARAMETER }
        );
      }

      // Build script that runs directly in page context (no eval() to avoid CSP issues)
      const timeout = input.timeout || 5000;
      const selectorLiteral = input.selector ? JSON.stringify(input.selector) : 'null';
      const waitForVisible = input.waitForVisible ?? false;
      const userCode = (input.code || '').trim();

      // Expression vs statement sequence: syntax-level check (compile only, no
      // execution). The old regex heuristic misclassified expressions whose
      // nested function bodies contain `;` (async IIFE, promise chains) as
      // multi-statement, silently discarding their result .
      // Expression: auto-wrapped with return (trailing newline guards `//` comments).
      // Statement sequence: treated as a function body — user must explicitly return.
      const fnBody = isParsableExpression(userCode)
        ? `return (${userCode}\n);`
        : userCode;

      const script = `
        (async () => {
          const selector = ${selectorLiteral};
          const waitForVisible = ${waitForVisible ? 'true' : 'false'};
          const timeout = ${timeout};

          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

          const waitForElement = async () => {
            if (!selector) return null;
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              const el = selector.startsWith('xpath=')
                ? (() => {
                    try {
                      const xpath = selector.slice(6);
                      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                      return result.singleNodeValue || null;
                    } catch {
                      return null;
                    }
                  })()
                : document.querySelector(selector);
              if (el) {
                if (!waitForVisible || el.offsetParent !== null) {
                  return el;
                }
              }
              await sleep(100);
            }
            return null;
          };

          const element = await waitForElement();
          if (selector && !element) {
            return { success: false, error: waitForVisible ? 'Element not visible' : 'Element not found', code: waitForVisible ? 'element_not_visible' : 'element_not_found' };
          }

          try {
            const __result = await (async (element) => { ${fnBody} })(element);
            return { success: true, result: __result };
          } catch (err) {
            return { success: false, error: err?.message || String(err), code: 'evaluation_error' };
          }
        })();
      `;

      const result = await executor(script, viewId);

      const duration = Date.now() - startTime;

      const normalized = result && typeof result === 'object' && 'success' in result ? result : { success: true, result };

      if (!normalized.success) {
        return standardizeLegacyResult(
          {
            success: false,
            error: (normalized as any).error || 'Script execution failed',
            error_code: (normalized as any).code || 'UNKNOWN_ERROR',
            duration
          },
          { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
        );
      }

      // 记录事件到 RunSessionManager
      if (input.runId) {
        try {
          const runSession = resolveRunSessionAPI();
          await runSession?.addEvent?.({
            runId: input.runId,
            viewId,
            type: 'EVAL_EXECUTED',
            data: {
              code: input.code.substring(0, 100), // 只记录前 100 字符
              selector: input.selector,
              resultType: typeof result.result,
              duration
            }
          });
        } catch (err) {
          console.warn('[evalTool] ⚠️ 记录事件失败:', err);
        }
      }

      const resultValue = (normalized as any).result;
      const resultType = typeof resultValue;
      return standardizeLegacyResult({
        success: true,
        result: resultValue,
        resultType,
        duration,
        // /#7038：语句序列（如以 if/else 块结尾）无显式 return 时，函数体契约
        // 返回 undefined。此前信封 ok:true 且 result 字段整个缺失、零提示，Agent 会把
        // 「静默 null」误判成页面/tab 状态问题并绕远路。这里不改包裹语义，只补可自愈的 hint。
        ...(resultType === 'undefined'
          ? { hint: '脚本执行成功但返回 undefined：多语句代码按函数体执行，不会自动取最后一个语句块的值。需要取值时请以表达式收尾，或在代码中显式 return。' }
          : {})
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error('[evalTool] 执行失败:', error);

      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR,
          duration
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      );
    }
  }
};

// ==================== 工具集合导出 ====================

/**
 * Eval 工具集合
 */
export const evalTools = [evalTool];
