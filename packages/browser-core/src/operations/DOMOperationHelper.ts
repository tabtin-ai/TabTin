import { ToolErrorCode } from '../types/errors'
import { t } from '../i18n'
import type { BrowserContext } from '../context/BrowserContext'
import { SHADOW_DOM_HELPERS_SNIPPET } from '../page-scripts/shadow-dom'
import { SCROLL_RUNTIME_SNIPPET } from '../page-scripts/scroll-runtime'
import { CURSOR_RUNTIME_SNIPPET } from '../page-scripts/cursor-runtime'
import { normalizeScrollIntent } from './scroll-intent'

export interface DOMOperationOptions {
  selector: string
  frameId?: string
  action: 'click' | 'fill' | 'scroll' | 'wait'
  value?: string
  direction?: string
  amount?: number
  timeout?: number
  waitForVisible?: boolean
  scrollIntoView?: boolean
  retries?: number
  clearFirst?: boolean
  duration?: number
}

export const DOM_ACTION_TYPES = new Set(['click', 'fill', 'scroll', 'wait'])

export interface DOMOperationResult {
  success: boolean
  error?: string
  code?: string
  actualValue?: string
  checked?: boolean
  controlValue?: string
  delta?: number
  atBoundary?: boolean
  target?: string
}

/**
 * DOMOperationHelper
 *
 * 封装常见 DOM 操作的可见性检查、滚动和重试逻辑，统一返回 ToolErrorCode
 */
export class DOMOperationHelper {
  static async runAction(ctx: BrowserContext, options: DOMOperationOptions): Promise<DOMOperationResult> {
    const {
      selector,
      action,
      value,
      direction,
      amount,
      timeout = 5000,
      waitForVisible = true,
      scrollIntoView = true,
      retries = 1,
      clearFirst = true,
      duration,
      frameId,
    } = options

    const scrollIntent = action === 'scroll'
      ? normalizeScrollIntent({ value, direction, amount })
      : undefined

    const attempts = Math.max(1, retries + 1)
    let lastError: DOMOperationResult | null = null

    for (let i = 0; i < attempts; i++) {
      let result: DOMOperationResult
      const script = `
          (async () => {
            const selector = ${JSON.stringify(selector)};
            const action = ${JSON.stringify(action)};
            const value = ${value !== undefined ? JSON.stringify(value) : 'undefined'};
            const timeout = ${timeout};
            const waitForVisible = ${waitForVisible ? 'true' : 'false'};
            const scrollIntoView = ${scrollIntoView ? 'true' : 'false'};
            const clearFirst = ${clearFirst ? 'true' : 'false'};
            const duration = ${typeof duration === 'number' ? duration : 'undefined'};
            const scrollIntent = ${scrollIntent ? JSON.stringify(scrollIntent) : 'undefined'};

            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

            if (action === 'wait') {
              const waitMs = typeof duration === 'number' ? duration : 1000;
              await sleep(waitMs);
              return { success: true };
            }

            ${SHADOW_DOM_HELPERS_SNIPPET}
            ${SCROLL_RUNTIME_SNIPPET}
            ${CURSOR_RUNTIME_SNIPPET}

            const findElement = () => {
              if (!selector) return { success: false, code: 'invalid_selector', error: ${JSON.stringify(t('errors.dom.emptySelector'))} };
              try {
                if (String(selector).indexOf(' >>> ') !== -1) {
                  const element = __tabtinDeepQuery(selector);
                  if (!element) return { success: false, code: 'element_not_found', error: ${JSON.stringify(t('errors.dom.elementNotFoundSelector'))} };
                  return { success: true, element };
                }
                const isXPath = selector.startsWith('xpath=') || selector.startsWith('/');
                if (isXPath) {
                  const xpath = selector.startsWith('xpath=') ? selector.slice(6) : selector;
                  const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                  const element = result.singleNodeValue;
                  if (!element) return { success: false, code: 'element_not_found', error: ${JSON.stringify(t('errors.dom.elementNotFoundXpath'))} };
                  return { success: true, element };
                } else {
                  const element = document.querySelector(selector);
                  if (!element) return { success: false, code: 'element_not_found', error: ${JSON.stringify(t('errors.dom.elementNotFoundSelector'))} };
                  return { success: true, element };
                }
              } catch (err) {
                return { success: false, code: 'selector_evaluation_failed', error: err?.message || String(err) };
              }
            };

            function isVisible(el) {
              if (!el) return false;
              var rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return false;
              var style = getComputedStyle(el);
              if (style.display === 'none') return false;
              if (style.visibility === 'hidden') return false;
              if (parseFloat(style.opacity) === 0) return false;
              return true;
            }

            // scroll 无 selector：跳过等待，直接解析主滚目标
            if (action === 'scroll' && !selector) {
              try {
                return await __tabtinApplyScroll(null, scrollIntent || { kind: 'to_end' });
              } catch (err) {
                return { success: false, code: 'unknown_error', error: err?.message || String(err) };
              }
            }

            const deadline = Date.now() + timeout;
            let element = null;
            while (Date.now() < deadline) {
              const res = findElement();
              if (res.success && res.element) {
                element = res.element;
                const visible = !waitForVisible || isVisible(element);
                if (visible) break;
              }
              await sleep(100);
            }

            try {
              if (!element) {
                return { success: false, code: waitForVisible ? 'element_not_visible' : 'element_not_found', error: ${JSON.stringify(t('errors.dom.elementNotReady'))} };
              }

              // Agent 模拟指针：先飞到目标元素中心，到位后再执行动作（可视化失败静默）
              const __cursorFly = async () => {
                try {
                  if (scrollIntoView && element.scrollIntoView && action !== 'scroll') {
                    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
                  }
                  const r = element.getBoundingClientRect();
                  if (r.width > 0 || r.height > 0) {
                    await Promise.race([
                      __tabtinAgentCursorMoveTo(r.left + r.width / 2, r.top + r.height / 2),
                      new Promise((resolve) => setTimeout(resolve, 1500)),
                    ]);
                  }
                } catch (_) { /* 静默 */ }
              };

              if (action === 'scroll') {
                await __cursorFly();
                return await __tabtinApplyScroll(element, scrollIntent || { kind: 'to_end' });
              }

              await __cursorFly();

              const controlState = (element) => ({
                ...(element instanceof HTMLInputElement && ['radio', 'checkbox'].includes(element.type)
                  ? { controlValue: String(element.value), checked: Boolean(element.checked) }
                  : {}),
              });

              const setControlValue = (element, nextValue) => {
                const prototype = element instanceof HTMLInputElement
                  ? HTMLInputElement.prototype
                  : element instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : null;
                const nativeSetter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                if (nativeSetter) {
                  nativeSetter.call(element, nextValue);
                  return;
                }
                element.value = nextValue;
              };

              switch (action) {
                case 'click': {
                  if (element && typeof element.click === 'function') {
                    element.click();
                    try { __tabtinAgentCursorPulse('click'); } catch (_) {}
                    return { success: true, ...controlState(element) };
                  }
                  return { success: false, code: 'element_not_interactable', error: ${JSON.stringify(t('errors.dom.elementNotClickable'))} };
                }
                case 'fill': {
                  if (element && 'value' in element) {
                    const requestedValue = value ?? '';
                    try { __tabtinAgentCursorPulse('click'); } catch (_) {}
                    if (typeof element.focus === 'function') element.focus();
                    if (clearFirst) setControlValue(element, '');
                    setControlValue(element, requestedValue);
                    try {
                      element.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        composed: true,
                        inputType: 'insertText',
                        data: requestedValue,
                      }));
                    } catch (_) {
                      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                    }
                    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                    await Promise.resolve();
                    const actualValue = String(element.value);
                    if (actualValue !== requestedValue) {
                      return { success: false, code: 'invalid_parameter', error: '填写后值与请求值不一致', actualValue };
                    }
                    return { success: true, actualValue };
                  }
                  return { success: false, code: 'element_not_interactable', error: ${JSON.stringify(t('errors.dom.elementNoValue'))} };
                }
                case 'wait': {
                  const waitMs = typeof duration === 'number' ? duration : 1000;
                  await sleep(waitMs);
                  return { success: true };
                }
                default:
                return { success: false, code: 'unsupported_operation', error: ${JSON.stringify(t('errors.dom.unsupportedAction'))} };
              }
            } catch (err) {
              return { success: false, code: 'unknown_error', error: err?.message || String(err) };
            }
          })();
        `
      try {
        result = frameId
          ? await ctx.executeScript(script, frameId)
          : await ctx.executeScript(script)
      } catch (error) {
        if (!frameId) throw error
        return {
          success: false,
          code: 'element_not_found',
          error: error instanceof Error ? error.message : String(error),
        }
      }

      if (result.success) {
        return result
      }

      lastError = result
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }

    const finalError = lastError ?? { success: false, code: ToolErrorCode.UNKNOWN_ERROR, error: t('errors.unknownError') }

    try {
      const url = ctx.getCurrentURL()
      console.warn('[DOMOperationHelper] Action failed', {
        selector,
        action,
        error: finalError.error,
        code: finalError.code,
        url
      })
    } catch {
      // ignore logging failures
    }

    return finalError
  }
}
