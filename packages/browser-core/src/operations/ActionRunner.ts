/**
 * ActionRunner — 浏览器操作执行器
 *
 * 职责：
 * - 单个 action 的 CDP/DOM 分派
 * - 操作序列循环 + stop_on_error 逻辑
 * - 失败条目构建
 */

import { DOM_ACTION_TYPES, DOMOperationHelper, type DOMOperationOptions } from './DOMOperationHelper';
import { getSharedCDPOperationHelper, isCDPAction, isCoordinateClick, type CDPActionType } from './CDPOperationHelper';
import { mapToToolErrorCode } from '../utils/error-mapping';
import { t } from '../i18n';
import { normalizeActActionType, type ActAction, type ActActionType } from '../types/browser';
import type { BrowserContext } from '../context/BrowserContext';
import type { SemanticFingerprint } from '../runtime/ref-semantic';
import {
  buildSemanticRelocateScript,
  formatSemanticRelocateFailure,
  isStaleLocatorError,
} from '../runtime/ref-semantic';

/** act 回解 ref 后附带的语义指纹，供 selector 失效时重定位。 */
export interface ActActionWithSemantic extends ActAction {
  ref?: string;
  toRef?: string;
  frameId?: string;
  refSemantic?: SemanticFingerprint;
  toRefSemantic?: SemanticFingerprint;
}

/** 最终用于点击的 selector 来源（不改变 success 语义，仅供验收 / 排障）。 */
export type ActSelectorSource = 'initial' | 'semantic_relocate';

export interface ActionEntry {
  type: string;
  selector?: string;
  status: 'success' | 'failed';
  error?: string;
  error_code?: string;
  timestamp: number;
  actual_value?: string;
  checked?: boolean;
  control_value?: string;
  /** `initial`：首次用的 selector（ref 缓存或显式传入）；`semantic_relocate`：失效后按指纹重定位得到。 */
  selector_source?: ActSelectorSource;
  /** 重定位前的原 selector；仅当 `selector_source === 'semantic_relocate'` 时出现。 */
  relocated_from?: string;
  /**
   * ref 回解时 RefCache 登记的语义文本（glance 的 text/name）。
   * 不改变 success；用于发现「以为点页码 3、实际点到文章标题」类跨 glance 误用 eN。
   */
  resolved_text?: string;
  /** ref 回解时的语义 role（如 button / link）。 */
  resolved_role?: string;
}

/** 从 action 上的 refSemantic 抽出可观测字段（无指纹则省略）。 */
function resolvedSemanticFields(action: ActActionWithSemantic): {
  resolved_text?: string;
  resolved_role?: string;
} {
  const sem = action.refSemantic;
  if (!sem) return {};
  return {
    ...(sem.name ? { resolved_text: sem.name } : {}),
    ...(sem.role ? { resolved_role: sem.role } : {}),
  };
}

function formStateFields(result: {
  actualValue?: string;
  checked?: boolean;
  controlValue?: string;
}): Pick<ActionEntry, 'actual_value' | 'checked' | 'control_value'> {
  return {
    ...(result.actualValue !== undefined ? { actual_value: result.actualValue } : {}),
    ...(result.checked !== undefined ? { checked: result.checked } : {}),
    ...(result.controlValue !== undefined ? { control_value: result.controlValue } : {}),
  };
}

export interface ActionSequenceOptions {
  timeout?: number;
  stopOnError?: boolean;
  interActionDelayMs?: number;
}

export interface ActionSequenceResult {
  executedActions: ActionEntry[];
  stoppedEarly: boolean;
  lastFailure?: ActionEntry;
}

export async function runSingleAction(
  ctx: BrowserContext,
  action: ActActionWithSemantic,
  timeout: number,
): Promise<ActionEntry> {
  const normalizedType = normalizeActActionType(action.type);
  const normalizedAction: ActActionWithSemantic =
    normalizedType === action.type ? action : { ...action, type: normalizedType as ActActionType };
  const { type, selector, toSelector } = normalizedAction;

  if (!ctx.isAlive()) {
    throw new Error(t('errors.webContentsDestroyed'));
  }

  const domResult = await executeActionWithSemanticFallback(ctx, normalizedAction, timeout, selector, toSelector);
  const resolved = resolvedSemanticFields(normalizedAction);

  if (!domResult.success) {
    return buildFailureEntry(type, domResult.selector ?? selector, domResult, resolved);
  }

  return {
    type,
    selector: domResult.selector ?? selector,
    status: 'success',
    timestamp: Date.now(),
    selector_source: domResult.selector_source,
    relocated_from: domResult.relocated_from,
    ...formStateFields(domResult),
    ...resolved,
  };
}

interface ResolvedActionResult {
  success: boolean;
  error?: string;
  code?: string;
  selector?: string;
  selector_source?: ActSelectorSource;
  relocated_from?: string;
  actualValue?: string;
  checked?: boolean;
  controlValue?: string;
}

async function trySemanticRelocate(
  ctx: BrowserContext,
  semantic: SemanticFingerprint,
  frameId?: string,
): Promise<{ success: boolean; selector?: string; error?: string; code?: string }> {
  try {
    const script = buildSemanticRelocateScript(semantic);
    const raw = frameId
      ? await ctx.executeScript<{ success: boolean; selector?: string; error?: string; code?: string }>(script, frameId)
      : await ctx.executeScript<{ success: boolean; selector?: string; error?: string; code?: string }>(script);
    if (raw && typeof raw === 'object') return raw;
    return { success: false, code: 'ref_semantic_relocate_failed', error: 'invalid relocate script result' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, code: 'ref_semantic_relocate_failed', error: message };
  }
}

async function runDomOrCdpOnce(
  ctx: BrowserContext,
  action: ActActionWithSemantic,
  timeout: number,
  selector: string | undefined,
  toSelector: string | undefined,
): Promise<ResolvedActionResult> {
  const { type, value } = action;
  let domResult: ResolvedActionResult;

  if (action.frameId && !DOM_ACTION_TYPES.has(type)) {
    domResult = {
      success: false,
      code: 'unsupported_operation',
      error: `iframe 内暂不支持 ${type} 操作`,
    };
  } else if (!action.frameId && (isCDPAction(type) || isCoordinateClick(action))) {
    domResult = await getSharedCDPOperationHelper().runAction(ctx, {
      action: type as CDPActionType,
      selector: selector || undefined,
      value,
      key: action.key,
      toSelector: toSelector || undefined,
      fromX: action.fromX,
      fromY: action.fromY,
      toX: action.toX,
      toY: action.toY,
      x: action.x,
      y: action.y,
      files: action.files,
      steps: action.steps,
      delay: action.delay,
      timeout,
    });
  } else {
    domResult = await DOMOperationHelper.runAction(ctx, {
      selector: selector || '',
      frameId: action.frameId,
      action: type as DOMOperationOptions['action'],
      value,
      direction: action.direction,
      amount: action.amount,
      timeout,
      waitForVisible: true,
      scrollIntoView: true,
      retries: 1,
      clearFirst: true,
      duration: action.duration,
    });
  }

  return { ...domResult, selector };
}

async function executeActionWithSemanticFallback(
  ctx: BrowserContext,
  action: ActActionWithSemantic,
  timeout: number,
  selector: string | undefined,
  toSelector: string | undefined,
): Promise<ResolvedActionResult> {
  const first = await runDomOrCdpOnce(ctx, action, timeout, selector, toSelector);
  if (first.success) return { ...first, selector_source: 'initial' };
  if (!isStaleLocatorError(first.code, first.error)) return { ...first, selector_source: 'initial' };
  if (!action.refSemantic && !action.toRefSemantic) return { ...first, selector_source: 'initial' };

  let nextSelector = selector;
  let nextToSelector = toSelector;
  let relocatedPrimary = false;

  if (action.refSemantic) {
    const relocated = await trySemanticRelocate(ctx, action.refSemantic, action.frameId);
    if (!relocated.success || !relocated.selector) {
      return {
        success: false,
        code: 'ref_semantic_relocate_failed',
        error: formatSemanticRelocateFailure(action.ref, action.refSemantic, relocated.error),
        selector,
        selector_source: 'initial',
      };
    }
    nextSelector = relocated.selector;
    relocatedPrimary = true;
  }

  if (action.toRefSemantic) {
    const relocated = await trySemanticRelocate(ctx, action.toRefSemantic);
    if (!relocated.success || !relocated.selector) {
      return {
        success: false,
        code: 'ref_semantic_relocate_failed',
        error: formatSemanticRelocateFailure(action.toRef, action.toRefSemantic, relocated.error),
        selector,
        selector_source: relocatedPrimary ? 'semantic_relocate' : 'initial',
        relocated_from: relocatedPrimary ? selector : undefined,
      };
    }
    nextToSelector = relocated.selector;
  }

  const retry = await runDomOrCdpOnce(ctx, action, timeout, nextSelector, nextToSelector);
  const relocateMeta = relocatedPrimary
    ? { selector_source: 'semantic_relocate' as const, relocated_from: selector }
    : { selector_source: 'initial' as const };
  if (retry.success) return { ...retry, selector: nextSelector, ...relocateMeta };
  return { ...retry, selector: nextSelector, ...relocateMeta };
}

export async function runActionSequence(
  ctx: BrowserContext,
  actions: ActAction[],
  options?: ActionSequenceOptions,
): Promise<ActionSequenceResult> {
  const timeout = options?.timeout ?? 8000;
  const stopOnError = options?.stopOnError ?? true;
  const delayMs = options?.interActionDelayMs ?? (actions.length > 1 ? 300 : 0);

  const executedActions: ActionEntry[] = [];
  let stoppedEarly = false;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    console.log(`[ActionRunner] 🔍 执行操作: ${action.type} ${action.selector ?? ''}`);

    try {
      const entry = await runSingleAction(ctx, action, timeout);
      executedActions.push(entry);

      if (entry.status === 'failed' && stopOnError) {
        stoppedEarly = true;
        break;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[ActionRunner] ❌ ${action.type} 失败: ${errorMessage}`);

      const entry = buildFailureEntry(
        action.type,
        action.selector,
        { success: false, error: errorMessage },
        resolvedSemanticFields(action),
      );
      executedActions.push(entry);

      if (stopOnError) {
        stoppedEarly = true;
        break;
      }
    }

    if (delayMs > 0 && i < actions.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const lastFailure = [...executedActions].reverse().find((a) => a.status === 'failed');
  return { executedActions, stoppedEarly, lastFailure };
}

export function buildFailureEntry(
  type: string,
  selector: string | undefined,
  domResult: {
    success: boolean;
    error?: string;
    code?: string;
    selector_source?: ActSelectorSource;
    relocated_from?: string;
    actualValue?: string;
    checked?: boolean;
    controlValue?: string;
  },
  resolved?: { resolved_text?: string; resolved_role?: string },
): ActionEntry {
  return {
    type,
    selector,
    status: 'failed',
    error: domResult.error || 'Script execution failed',
    error_code: mapToToolErrorCode(
      typeof domResult.code === 'string' ? domResult.code : undefined,
      domResult.error || 'Script execution failed',
    ),
    timestamp: Date.now(),
    selector_source: domResult.selector_source,
    relocated_from: domResult.relocated_from,
    ...formStateFields(domResult),
    ...resolved,
  };
}
