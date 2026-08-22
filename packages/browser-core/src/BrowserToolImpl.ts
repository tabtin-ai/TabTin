/**
 * BrowserToolImpl — 浏览器工具编排器
 *
 * 本模块是各子服务的协调者，自身不包含业务细节。
 * 每个公共方法遵循统一管道：
 *   resolveTab → rateLimit → retry(coreAction) → blockDetect → captchaGuard → recordEvent
 *
 * 所有浏览器操作通过 BrowserContext 接口，不直接访问 webContents。
 *
 * 子服务：
 *  - TabResolver:       Tab 解析/创建
 *  - CaptchaGuard:      验证码检测与处理
 *  - BlockDetector:     封禁信号检测
 *  - SnapshotService:   页面快照组合
 *  - SoMService:        Set-of-Mark 标注
 *  - DOMOperationHelper / CDPOperationHelper: 操作执行
 */

import type {
  ActAction,
  ExecuteActInput,
  ExecuteActOutput,
  ExecuteObserveInput,
  ExecuteObserveOutput,
  RequestSnapshotInput,
  RequestSnapshotOutput,
  BlockSignal,
} from './types/browser';
import type { ToolError } from './types/errors';
import { ToolErrorCode, ToolErrorFactory, isRetriableError } from './types/errors';
import { mapToToolErrorCode } from './utils/error-mapping';
import { t } from './i18n';
import { runActionSequence } from './operations/ActionRunner';

import { getSharedTabResolver } from './tab/TabResolver';
import {
  captchaNeedsUserIntervention,
  getSharedCaptchaGuard,
  type CaptchaUserInterventionCallback,
} from './guards/CaptchaGuard';
import { projectCaptchaRequired } from './captcha/CaptchaDetector';
import { getSharedBlockDetector } from './guards/BlockDetector';
import { ActionLoopDetector } from './guards/ActionLoopDetector';
import { getSharedAccessStrategyService } from './access/AccessStrategyService';
import { AccessLevel } from './access/AccessLevel';
import { getSharedSnapshotService } from './snapshot/SnapshotService';
import { getSharedSoMService, type SoMElement } from './snapshot/SoMService';
import { serializeToDomIndex } from './snapshot/DomIndexSerializer';
import type { CaptchaInfo } from './captcha/CaptchaDetector';
import type { BrowserContext } from './context/BrowserContext';
import { LegacyWebContentsBrowserContext } from './context/LegacyWebContentsBrowserContext';
import { waitForDomSettle } from './utils/dom-settle';

export type { CaptchaUserInterventionCallback } from './guards/CaptchaGuard';

// ── 速率限制 & 重试常量 ──────────────────────────────────

const RATE_LIMIT_MIN_MS = 800;
const RATE_LIMIT_MAX_MS = 1500;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_BACKOFF_MS = 8000;
// ：元素类错误是确定性 DOM 状态——单次尝试内已含 8s 元素轮询 + 语义重定位 + 重试，
// 页面不变时把整个管线重跑两遍必然同败，只会把真实错误拖过 CLI transport 的 25s cap、
// 被掩成 CONNECTION_TIMEOUT。这里只排除进程内整体重试；wire 层 retriable 标记不变
// （Agent 拿到真实错误后可自行 observe 再试）。
const IN_PROCESS_RETRY_EXCLUDED_CODES: ReadonlySet<ToolErrorCode> = new Set([
  ToolErrorCode.ELEMENT_NOT_FOUND,
  ToolErrorCode.ELEMENT_NOT_VISIBLE,
  ToolErrorCode.ELEMENT_NOT_INTERACTABLE,
  ToolErrorCode.REF_SEMANTIC_RELOCATE_FAILED,
]);
const ACT_POST_SCREENSHOT_TIMEOUT_MS = 2500;
// 交互动作后的 DOM settle 观察上限：比页面加载路径（10s）短，避免持续动画 / 长轮询页
// 每次 click 都等满上限（旧实现是固定 1-2s sleep，这里保持同量级但改为「稳定即返回」）。
const ACT_SETTLE_MAX_MS = 3000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 主类 ──────────────────────────────────────────────────

export class BrowserToolImpl {
  private runEventRecorder: ((event: any) => void) | null = null;
  private lastActionTimestamps = new Map<string, number>();
  private loopDetectors = new Map<string, ActionLoopDetector>();
  private lastDomIndexMaps = new Map<string, Map<number, SoMElement>>();
  private _explicitContextFactory = false;

  // ── 依赖注入 ───────────────────────────────────────────

  setContextFactory(factory: (tabId: string) => BrowserContext | null): void {
    getSharedTabResolver().setContextFactory(factory);
    getSharedCaptchaGuard().setContextFactory(factory);
    getSharedBlockDetector().setContextFactory(factory);
    this._explicitContextFactory = true;
    console.log('[BrowserToolImpl] ✅ BrowserContext 工厂已注入');
  }

  /** @deprecated 使用 setContextFactory() 替代。保留供非 BrowserToolImpl 路径（如 ResourceDetectionService）使用。 */
  setElectronViewGetter(getter: (tabId: string) => any): void {
    getSharedTabResolver().setViewGetter(getter);
    if (!this._explicitContextFactory) {
      const factory = (tabId: string): BrowserContext | null => {
        const view = getter(tabId);
        if (!view?.webContents) return null;
        return new LegacyWebContentsBrowserContext(view.webContents);
      };
      getSharedTabResolver().setContextFactory(factory);
      getSharedCaptchaGuard().setContextFactory(factory);
      getSharedBlockDetector().setContextFactory(factory);
    }
    console.log('[BrowserToolImpl] ✅ Electron View 获取器已注入');
  }

  setRunEventRecorder(recorder: (event: any) => void): void {
    this.runEventRecorder = recorder;
    console.log('[BrowserToolImpl] ✅ Run 事件记录器已注入');
  }

  setCaptchaInterventionCallback(cb: CaptchaUserInterventionCallback): void {
    getSharedCaptchaGuard().setInterventionCallback(cb);
    console.log('[BrowserToolImpl] ✅ 验证码用户介入回调已注入');
  }

  clearCaptchaCache(tabId: string): void {
    getSharedCaptchaGuard().clearCache(tabId);
  }

  // ── 公共 API ───────────────────────────────────────────

  async executeAct(input: ExecuteActInput): Promise<ExecuteActOutput> {
    const startTime = Date.now();
    console.log(`[BrowserToolImpl] 执行 ${input.actions.length} 个操作`);

    try {
      const runId = input.runId;

      const tabId = await this.resolveTabId(input.crawlTabId, runId, input, {
        partition: input.partition,
        proxy: input.proxy,
        userAgent: input.userAgent,
      });

      if (!tabId) {
        return this.buildTabMissingResult(runId, input, startTime, 'execute_act');
      }

      const result = await this.executeWithGuards(tabId, runId, 'execute_act', () =>
        this.coreExecuteAct(tabId, input, startTime, runId),
        input.actions,
      );

      // 导航后清 captcha 缓存（页面已变）。就绪等待已在 coreExecuteAct 采集前完成（settled），
      // 故移除原先在采集之后执行、对返回内容无效的 1-2s 固定 sleep。
      const hasNavigation = input.actions?.some(
        (a) => (a as any).action === 'navigate' || (a.type === 'click' && result.page_url),
      );
      if (hasNavigation) {
        this.clearCaptchaCache(tabId);
      }

      this.recordRunEvent(runId, tabId, 'execute_act', {
        actions: input.actions,
        resultSummary: { success: result.success, error: result.error, executed: result.executed_actions?.length },
      }, {
        selector: input.actions?.[0]?.selector,
        timeout: input.timeout,
        duration: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      return this.handleTopLevelError('execute_act', error, input, startTime);
    }
  }

  async executeObserve(input: ExecuteObserveInput): Promise<ExecuteObserveOutput> {
    const startTime = Date.now();
    console.log(`[BrowserToolImpl] 观察元素: ${input.selector || '整个页面'}`);

    try {
      const runId = input.runId;

      const tabId = await this.resolveTabId(input.crawlTabId, runId, input, {
        partition: input.partition,
        proxy: input.proxy,
        userAgent: input.userAgent,
      });

      if (!tabId) {
        this.recordRunEvent(runId, undefined, 'execute_observe', {
          selector: input.selector, success: false, error: 'No available browser context',
        });
        return {
          success: false,
          observed_elements: [],
          frontend_execution_time_ms: Date.now() - startTime,
          error: this.buildToolError('No available browser context for run', ToolErrorCode.PAGE_NOT_LOADED, { runId }),
        };
      }

      const result = await this.executeWithGuards(tabId, runId, 'execute_observe', () =>
        this.coreExecuteObserve(tabId, input, startTime),
      );

      this.recordRunEvent(runId, tabId, 'execute_observe', {
        selector: input.selector,
        success: result.success,
        count: result.observed_elements?.length ?? 0,
      });

      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.recordRunEvent(input.runId, input.crawlTabId, 'execute_observe', {
        success: false, error: errMsg, error_code: mapToToolErrorCode(undefined, errMsg),
      });
      return {
        success: false,
        observed_elements: [],
        frontend_execution_time_ms: Date.now() - startTime,
        error: this.buildToolError(errMsg, mapToToolErrorCode(undefined, errMsg), { runId: input.runId }),
      };
    }
  }

  async requestSnapshot(input: RequestSnapshotInput): Promise<RequestSnapshotOutput> {
    const startTime = Date.now();
    console.log(`[BrowserToolImpl] 获取页面快照`, input);

    try {
      const runId = input.runId;

      const crawlTabId = input.crawlTabId;
      if (!crawlTabId) {
        console.warn(`[BrowserToolImpl] ⚠️  未提供 crawlTabId，终止请求快照`);
        if (runId) {
          this.recordRunEvent(runId, undefined, 'request_snapshot', {
            success: false, error: 'No available browser context',
          });
        }
        return {
          success: false,
          error: this.buildToolError('No available browser context — crawlTabId is required', ToolErrorCode.PAGE_NOT_LOADED, { runId }),
        };
      }

      await this.enforceRateLimit(crawlTabId);

      const enrichedInput: RequestSnapshotInput = {
        ...input,
        include_dom: input.include_dom ?? true,
        include_accessibility_tree: input.include_accessibility_tree ?? true,
      };

      let result = await this.withRetry('requestSnapshot', () =>
        this.coreRequestSnapshot(crawlTabId, enrichedInput, startTime),
      );
      this.lastActionTimestamps.set(crawlTabId, Date.now());

      const blockSignal = await getSharedBlockDetector().detect(crawlTabId);
      if (blockSignal.blocked) result.block = blockSignal;

      const captchaGuard = getSharedCaptchaGuard();
      const captcha = await captchaGuard.detect(crawlTabId);
      if (captcha.detected) {
        result.captcha = captcha;
        const handled = await captchaGuard.detectAndHandle(crawlTabId);
        if (!handled.detected) {
          const prevBlock = result.block;
          result = await this.coreRequestSnapshot(crawlTabId, enrichedInput, startTime);
          result.captcha = { ...captcha, detected: false, confidence: 0 };
          if (prevBlock) result.block = prevBlock;
        }
      }

      if (runId) {
        const snap = result?.data?.snapshot;
        this.recordRunEvent(runId, crawlTabId, 'request_snapshot', {
          success: result.success,
          error: result.error,
          skeleton_length: snap?.skeleton_html?.length,
          aria_length: snap?.accessibility_tree?.length,
          screenshot: !!snap?.screenshot_base64,
          dom_index_length: snap?.dom_index?.length,
          url: snap?.url,
          title: snap?.title,
        });
      }

      return result;
    } catch (error) {
      console.error(`[BrowserToolImpl] ❌ 快照获取失败:`, error);
      return {
        success: false,
        error: this.buildToolError(
          error instanceof Error ? error.message : String(error),
          ToolErrorCode.UNKNOWN_ERROR,
          { runId: input.runId, viewId: input.crawlTabId },
        ),
      };
    }
  }

  async destroy(): Promise<void> {
    console.log('[BrowserToolImpl] 销毁 Browser 实例...');
  }

  // ── 统一管道 ───────────────────────────────────────────

  private async executeWithGuards<T extends { success: boolean; error?: ToolError; captcha?: CaptchaInfo }>(
    tabId: string,
    _runId: string | undefined,
    label: string,
    coreFn: () => Promise<T>,
    actions?: Array<{ type: string; selector?: string; value?: string; [key: string]: any }>,
  ): Promise<T & { block?: BlockSignal; captcha?: CaptchaInfo; loop_warning?: string }> {
    await this.enforceRateLimit(tabId);

    // observe 在验证码页可能拖死整页索引；先快速探测，命中人工墙则立刻返回信号。
    if (label === 'execute_observe') {
      const preCaptcha = await getSharedCaptchaGuard().detectFast(tabId);
      if (captchaNeedsUserIntervention(preCaptcha)) {
        const start = Date.now();
        let pageTitle = '';
        try {
          const ctx = getSharedTabResolver().getContext(tabId);
          if (ctx?.isAlive()) pageTitle = await ctx.getTitle();
        } catch {
          // ignore
        }
        const early = {
          success: true,
          observed_elements: [],
          frontend_execution_time_ms: Date.now() - start,
          page_url: (await this.getCurrentUrl(tabId)) || undefined,
          page_title: pageTitle || undefined,
          captcha: preCaptcha,
        } as unknown as T & { block?: BlockSignal; captcha?: CaptchaInfo; loop_warning?: string };
        this.lastActionTimestamps.set(tabId, Date.now());
        // 触发非阻塞 intervention 通知（缓存命中，不再跑长 wait）
        void getSharedCaptchaGuard().detectAndHandle(tabId).catch(() => {});
        return early;
      }
    }

    const result = await this.withRetry(label, coreFn) as T & { block?: BlockSignal; captcha?: CaptchaInfo; loop_warning?: string };
    this.lastActionTimestamps.set(tabId, Date.now());

    if (actions && actions.length > 0) {
      const detector = this.getLoopDetector(tabId);
      for (const action of actions) {
        detector.recordAction(action);
      }
      const loopResult = detector.isLooping();
      if (loopResult.looping) {
        result.loop_warning = loopResult.hint;
        console.warn(`[BrowserToolImpl] ⚠️ ${loopResult.hint}`);
      }
    }

    const blockSignal = await getSharedBlockDetector().detect(tabId);
    if (blockSignal.blocked) {
      result.block = blockSignal;

      const strategyService = getSharedAccessStrategyService();
      const url = await this.getCurrentUrl(tabId);
      if (url) {
        const initialDecision = strategyService.getInitialDecision(url);
        const currentLevel = initialDecision.level;
        const upgrade = strategyService.evaluateAndUpgrade(url, currentLevel, blockSignal);
        if (upgrade) {
          (result as any).accessUpgradeNeeded = true;
          (result as any).accessUpgradeConfig = upgrade.config;
          (result as any).accessUpgradeLog = upgrade.upgradeLog;
        }
      }
    } else if (result.success) {
      const url = await this.getCurrentUrl(tabId);
      if (url) {
        const strategyService = getSharedAccessStrategyService();
        const decision = strategyService.getInitialDecision(url);
        strategyService.recordSuccess(url, decision.level);
      }
    }

    const captcha = await getSharedCaptchaGuard().detectAndHandle(tabId);
    if (captcha.detected) result.captcha = captcha;

    return result;
  }

  private async getCurrentUrl(tabId: string): Promise<string | null> {
    try {
      const ctx = getSharedTabResolver().getContext(tabId);
      if (!ctx || !ctx.isAlive()) return null;
      return ctx.getCurrentURL() || null;
    } catch {
      return null;
    }
  }

  private getLoopDetector(tabId: string): ActionLoopDetector {
    let detector = this.loopDetectors.get(tabId);
    if (!detector) {
      detector = new ActionLoopDetector();
      this.loopDetectors.set(tabId, detector);
    }
    return detector;
  }

  // ── 核心操作（纯逻辑，不含管道） ─────────────────────

  private async coreExecuteAct(
    tabId: string,
    input: ExecuteActInput,
    startTime: number,
    runId?: string,
  ): Promise<ExecuteActOutput> {
    const tabResolver = getSharedTabResolver();
    const ctx = tabResolver.getContext(tabId);
    if (!ctx || !ctx.isAlive()) {
      throw new Error(t('errors.webContentsViewMissing', { id: tabId }));
    }

    const resolvedActions: ActAction[] = [];
    const preFailures: any[] = [];

    for (const action of input.actions) {
      const actionIndex = action.index;
      if (actionIndex != null && !action.selector) {
        const element = this.lastDomIndexMaps.get(tabId)?.get(actionIndex);
        if (element) {
          console.log(`[BrowserToolImpl] 🔗 Index [${actionIndex}] → selector: ${element.selector}`);
          resolvedActions.push({ ...action, selector: element.selector });
        } else {
          const failureEntry = this.buildFailureEntry(action.type, undefined, {
            success: false,
            error: `Index [${actionIndex}] 未在最近一次 observe/snapshot 的映射表中找到，请先执行 observe 刷新元素列表`,
          });
          if (input.stop_on_error !== false) {
            return await this.buildStopOnErrorResult([failureEntry], ctx, startTime, tabId, action.type, failureEntry, runId);
          }
          preFailures.push(failureEntry);
        }
      } else {
        resolvedActions.push(action);
      }
    }

    const seqResult = await runActionSequence(ctx, resolvedActions, {
      timeout: input.timeout ?? 8000,
      stopOnError: input.stop_on_error ?? true,
    });

    const executedActions = [...preFailures, ...seqResult.executedActions];

    if (seqResult.stoppedEarly && seqResult.lastFailure) {
      return await this.buildStopOnErrorResult(
        executedActions, ctx, startTime, tabId,
        seqResult.lastFailure.type, seqResult.lastFailure, runId,
      );
    }

    // 动作可能触发导航 / SPA 路由 / 交互后异步渲染：与 browser open 的 settled 契约对齐，
    // 在采集 page_url / title / 截图之前等 DOM 稳定，避免返回旧页或半成品（原后置 sleep 在采集之后执行、对返回内容无效）。
    // best-effort：settle 未达成不失败。只在可能改变页面的动作（navigate / click）后触发，避免给纯读动作加固定延迟。
    const navigationLikely = resolvedActions.some(
      (a) => (a as any).action === 'navigate' || a.type === 'click',
    );
    if (navigationLikely) {
      // 墙页常拖死长 settle / 截图 → CLI 25s 超时且 Agent 看不到 captcha。
      // 短 settle 后快速探测：命中人工验证码则早退，把信号交给编排层投影。
      await waitForDomSettle(ctx, Math.min(ACT_SETTLE_MAX_MS, 1500));
      const earlyCaptcha = await getSharedCaptchaGuard().detectFast(tabId);
      if (captchaNeedsUserIntervention(earlyCaptcha)) {
        const endTime = Date.now();
        // 跳过长 settle / 截图；captcha 交给外层 executeWithGuards 再 detectAndHandle（非阻塞通知）。
        const response: any = {
          success: false,
          executed_actions: executedActions,
          frontend_execution_time_ms: endTime - startTime,
          page_url: ctx.getCurrentURL(),
          page_title: await ctx.getTitle(),
          captcha: earlyCaptcha,
          error: this.buildToolError(
            projectCaptchaRequired(earlyCaptcha)?.reason || '页面需要完成验证码',
            ToolErrorCode.CAPTCHA_REQUIRED,
            { viewId: tabId },
          ),
        };
        return await this.safeSerialize(response, ctx, endTime - startTime, tabId);
      }
      await waitForDomSettle(ctx, ACT_SETTLE_MAX_MS);
    }

    const endTime = Date.now();

    let screenshotBase64: string | undefined;
    try {
      const buffer = await withTimeout(
        ctx.captureScreenshot({ format: 'jpeg', quality: 70 }),
        ACT_POST_SCREENSHOT_TIMEOUT_MS,
        `post-action screenshot timed out after ${ACT_POST_SCREENSHOT_TIMEOUT_MS}ms`,
      );
      screenshotBase64 = buffer.toString('base64');
    } catch (error) {
      console.warn(
        '[BrowserToolImpl] ⚠️ act 后截图失败（已忽略）:',
        error instanceof Error ? error.message : String(error),
      );
    }

    const hasFailedActions = executedActions.some((a: any) => a.status === 'failed');
    const firstFailure = executedActions.find((a: any) => a.status === 'failed');

    const response: any = {
      success: !hasFailedActions && executedActions.length > 0,
      executed_actions: executedActions,
      frontend_execution_time_ms: endTime - startTime,
      page_url: ctx.getCurrentURL(),
      page_title: await ctx.getTitle(),
      screenshot_base64: screenshotBase64,
    };

    if (firstFailure) {
      const errorCode = firstFailure.error_code || mapToToolErrorCode(undefined, firstFailure.error);
      response.error = this.buildToolError(firstFailure.error, errorCode, { viewId: tabId });
    }

    return await this.safeSerialize(response, ctx, endTime - startTime, tabId);
  }

  private async coreExecuteObserve(
    tabId: string,
    input: ExecuteObserveInput,
    startTime: number,
  ): Promise<ExecuteObserveOutput> {
    const tabResolver = getSharedTabResolver();
    const ctx = tabResolver.getContext(tabId);
    if (!ctx || !ctx.isAlive()) {
      throw new Error(t('errors.webContentsViewMissing', { id: tabId }));
    }

    const somService = getSharedSoMService();
    const includeSom = input.include_som === true;

    const collectResult = await somService.collectInteractiveElements(ctx, {
      selector: input.selector,
      limit: input.limit,
    });
    const { elements, truncated, totalCandidates } = collectResult;

    let somScreenshotBase64: string | undefined;
    if (includeSom && elements.length > 0) {
      const somResult = await somService.captureAnnotated(ctx, {
        selector: input.selector,
        limit: input.limit,
      });
      somScreenshotBase64 = somResult.screenshotBase64;
    }

    let domIndexResult = serializeToDomIndex(elements);
    if (truncated) {
      domIndexResult = {
        ...domIndexResult,
        text: domIndexResult.text + `\n[... 已截断，共 ${totalCandidates} 个交互元素，显示前 ${elements.length} 个]`,
      };
    }
    this.lastDomIndexMaps.set(tabId, domIndexResult.indexMap);

    // 精简投影：只保留喂给 act / 供 LLM 判读的语义字段。
    // ref(eN) 由编排层 projectObservePayload 注入；index/name/interactive 已删（分别为
    // ref 冗余、text 重复、observe 恒真）；bbox 仅视觉定位（include_som）场景才带。
    const observed_elements = elements.map((e) => ({
      selector: e.selector,
      tag: e.tag,
      text: e.name,
      role: e.role,
      visible: e.visible,
      // href 让 Agent 直接拿到页面上真实链接（含站点签名参，如小红书 xsec_token），
      // 无需自己拼 URL；配合路由层回填导航证据即可通过 open 守卫。仅链接类元素带此字段。
      ...(e.attributes?.href ? { href: e.attributes.href } : {}),
      // class 是无文本控件（图标翻页 / 加载更多）常见的唯一语义线索。
      ...(e.attributes?.class ? { class: e.attributes.class } : {}),
      ...(e.controlType ? { control_type: e.controlType } : {}),
      ...(typeof e.optionValue === 'string' ? { option_value: e.optionValue } : {}),
      ...(typeof e.checked === 'boolean' ? { checked: e.checked } : {}),
      ...(e.frameId ? { frameId: e.frameId } : {}),
      ...(includeSom && !e.frameId ? { bbox: e.bbox } : {}),
    }));

    const result: any = {
      success: true,
      observed_elements,
      frontend_execution_time_ms: Date.now() - startTime,
      page_url: ctx.getCurrentURL(),
      page_title: await ctx.getTitle(),
    };

    if (domIndexResult.text) result.dom_index = domIndexResult.text;
    if (somScreenshotBase64) result.som_screenshot_base64 = somScreenshotBase64;

    return result;
  }

  private async coreRequestSnapshot(
    crawlTabId: string,
    input: RequestSnapshotInput,
    startTime: number,
  ): Promise<RequestSnapshotOutput> {
    const tabResolver = getSharedTabResolver();
    const ctx = tabResolver.getContext(crawlTabId);
    if (!ctx || !ctx.isAlive()) {
      throw new Error(t('errors.webContentsViewMissing', { id: crawlTabId }));
    }

    const snapshotService = getSharedSnapshotService();
    const snapshot = await snapshotService.capture(ctx, input);

    if (input.include_dom === true) {
      try {
        const existingElements = snapshot.som_elements as SoMElement[] | undefined;
        const somService = getSharedSoMService();
        let elements: SoMElement[];
        let truncated = false;
        let totalCandidates = 0;
        if (existingElements?.length) {
          elements = existingElements;
          totalCandidates = elements.length;
        } else {
          const collectResult = await somService.collectInteractiveElements(ctx, {
            selector: input.selector,
            limit: input.limit,
          });
          elements = collectResult.elements;
          truncated = collectResult.truncated;
          totalCandidates = collectResult.totalCandidates;
        }
        if (elements.length > 0) {
          const domIndexResult = serializeToDomIndex(elements);
          this.lastDomIndexMaps.set(crawlTabId, domIndexResult.indexMap);
          snapshot.dom_index = truncated
            ? domIndexResult.text + `\n[... 已截断，共 ${totalCandidates} 个交互元素，显示前 ${elements.length} 个]`
            : domIndexResult.text;
          console.log(`[BrowserToolImpl] ✅ DOM Index 已生成: ${elements.length} 个元素${truncated ? ` (共 ${totalCandidates} 个，已截断)` : ''}`);
        }
      } catch (domIndexError) {
        console.warn('[BrowserToolImpl] ⚠️ DOM Index 生成失败:', domIndexError);
      }
    }

    const endTime = Date.now();
    console.log(`[BrowserToolImpl] ✅ 快照获取成功，耗时 ${endTime - startTime}ms`);

    return {
      success: true,
      data: {
        snapshot,
        frontend_execution_time_ms: endTime - startTime,
      },
    };
  }

  // ── Tab 解析 ───────────────────────────────────────────

  private async resolveTabId(
    crawlTabId: string | undefined,
    runId: string | undefined,
    input: any,
    options?: { partition?: string; proxy?: any; userAgent?: string },
  ): Promise<string | null> {
    if (crawlTabId) return crawlTabId;

    console.warn(`[BrowserToolImpl] ⚠️  未提供 crawlTabId，尝试通过 runSession 解析...`);
    const tabId = await getSharedTabResolver().resolve(runId, input, options);
    if (tabId) {
      console.log(`[BrowserToolImpl] ✅ 已解析 View: ${tabId}`);
    } else {
      console.warn(`[BrowserToolImpl] ⚠️  解析 View 失败`);
    }
    return tabId;
  }

  // ── 速率限制 ───────────────────────────────────────────

  private async enforceRateLimit(tabId: string): Promise<void> {
    const last = this.lastActionTimestamps.get(tabId);
    if (!last) return;
    const elapsed = Date.now() - last;
    const required = RATE_LIMIT_MIN_MS + Math.random() * (RATE_LIMIT_MAX_MS - RATE_LIMIT_MIN_MS);
    if (elapsed < required) {
      await this.sleep(required - elapsed);
    }
  }

  // ── 智能重试 ───────────────────────────────────────────

  private async withRetry<T extends { success: boolean; error?: ToolError; captcha?: CaptchaInfo }>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let lastThrownError: unknown;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        lastThrownError = error;
        if (attempt >= RETRY_MAX_ATTEMPTS) break;

        const errMsg = error instanceof Error ? error.message : String(error);
        const backoff = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_MAX_BACKOFF_MS);
        const jittered = Math.round(backoff * (0.5 + Math.random()));
        console.log(`[BrowserToolImpl] ${label} 第 ${attempt} 次抛出异常 (${errMsg})，${jittered}ms 后重试...`);
        await this.sleep(jittered);
        continue;
      }

      if (result.success || attempt >= RETRY_MAX_ATTEMPTS) return result;

      const err = result.error;
      if (!err) return result;
      if (err.code === ToolErrorCode.CAPTCHA_REQUIRED) return result;
      if (IN_PROCESS_RETRY_EXCLUDED_CODES.has(err.code as ToolErrorCode)) return result;
      if (!isRetriableError(err)) return result;

      const backoff = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_MAX_BACKOFF_MS);
      const jittered = Math.round(backoff * (0.5 + Math.random()));
      console.log(`[BrowserToolImpl] ${label} 第 ${attempt} 次失败 (${err.code})，${jittered}ms 后重试...`);
      await this.sleep(jittered);
    }

    throw lastThrownError ?? new Error(`[BrowserToolImpl] ${label} 重试耗尽`);
  }

  // ── 事件记录 ───────────────────────────────────────────

  private recordRunEvent(
    runId: string | undefined,
    viewId: string | undefined,
    type: string,
    data: any,
    context?: any,
  ): void {
    if (!runId && !viewId) return;
    try {
      if (!this.runEventRecorder) return;
      this.runEventRecorder({
        runId, viewId, type, data,
        timestamp: Date.now(),
        context: context ?? this.buildContextFromData(data),
      });
    } catch (error) {
      console.warn('[BrowserToolImpl] ⚠️ 记录事件失败:', error);
    }
  }

  private buildContextFromData(data: any): any | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const ctx: any = {};
    const url = data.page_url || data.url;
    const title = data.page_title || data.title;
    if (url) ctx.url = url;
    if (title) ctx.title = title;
    if (typeof data.frontend_execution_time_ms === 'number') ctx.duration = data.frontend_execution_time_ms;
    else if (typeof data.duration === 'number') ctx.duration = data.duration;
    if (data.error_code || data.error) {
      ctx.error = { code: data.error_code, message: typeof data.error === 'string' ? data.error : undefined };
    }
    return Object.keys(ctx).length > 0 ? ctx : undefined;
  }

  // ── 错误 & 序列化辅助 ─────────────────────────────────

  private buildToolError(message: string, code?: ToolErrorCode, context?: Record<string, any>): ToolError {
    const resolved = code ?? mapToToolErrorCode(undefined, message);
    return isRetriableError(resolved)
      ? ToolErrorFactory.retriable(resolved, message, context)
      : ToolErrorFactory.fatal(resolved, message, context);
  }

  private buildFailureEntry(type: string, selector: string | undefined, domResult: { success: boolean; error?: string; code?: string }) {
    const entry: any = {
      type, selector,
      status: 'failed',
      error: domResult.error || 'Script execution failed',
      timestamp: Date.now(),
    };
    entry.error_code = mapToToolErrorCode(
      typeof domResult.code === 'string' ? domResult.code : undefined,
      entry.error,
    );
    return entry;
  }

  private async buildStopOnErrorResult(
    executedActions: any[],
    ctx: BrowserContext,
    startTime: number,
    tabId: string,
    actionType: string,
    failureEntry: any,
    runId?: string,
  ): Promise<ExecuteActOutput> {
    console.log(`[BrowserToolImpl] ⚠️  stop_on_error=true，提前返回`);
    const endTime = Date.now();
    const errorCode = failureEntry.error_code || mapToToolErrorCode(undefined, failureEntry.error);
    const response: any = {
      success: false,
      executed_actions: executedActions,
      frontend_execution_time_ms: endTime - startTime,
      page_url: ctx.getCurrentURL(),
      page_title: await ctx.getTitle(),
      error: this.buildToolError(failureEntry.error, errorCode, { viewId: tabId, action: actionType }),
    };
    if (failureEntry.error_code) response.error_code = failureEntry.error_code;

    this.recordRunEvent(runId, tabId, 'execute_act_result', {
      success: false,
      error: failureEntry.error,
      error_code: failureEntry.error_code,
      executed: executedActions.length,
      page_url: response.page_url,
      page_title: response.page_title,
    });

    return await this.safeSerialize(response, ctx, endTime - startTime, tabId);
  }

  private buildTabMissingResult(
    runId: string | undefined,
    input: ExecuteActInput,
    startTime: number,
    eventType: string,
  ): ExecuteActOutput {
    const errorMessage = 'No available browser context for run';
    const toolError = this.buildToolError(errorMessage, ToolErrorCode.PAGE_NOT_LOADED, { runId });
    this.recordRunEvent(runId, undefined, eventType, {
      actions: input.actions,
      resultSummary: { success: false, error: errorMessage, executed: 0 },
    }, {
      selector: input.actions?.[0]?.selector,
      timeout: input.timeout,
      duration: Date.now() - startTime,
    });
    return {
      success: false,
      executed_actions: [],
      frontend_execution_time_ms: Date.now() - startTime,
      page_url: '',
      page_title: '',
      error: toolError,
    };
  }

  private async safeSerialize(response: any, ctx: BrowserContext, elapsedMs: number, tabId: string): Promise<any> {
    try {
      return JSON.parse(JSON.stringify(response));
    } catch (serializeError) {
      console.error(`[BrowserToolImpl] ❌ 响应序列化失败:`, serializeError);
      return {
        success: false,
        executed_actions: [],
        frontend_execution_time_ms: elapsedMs,
        page_url: ctx.getCurrentURL(),
        page_title: await ctx.getTitle(),
        error: this.buildToolError(
          'Internal error: Response serialization failed',
          ToolErrorCode.UNKNOWN_ERROR,
          { viewId: tabId },
        ),
      };
    }
  }

  private handleTopLevelError(eventType: string, error: unknown, input: any, startTime: number): ExecuteActOutput {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[BrowserToolImpl] ❌ ${eventType} 失败:`, error);
    const errorCode = mapToToolErrorCode(undefined, errorMessage);
    this.recordRunEvent(input.runId, input.crawlTabId, eventType, {
      success: false, error: errorMessage, error_code: errorCode,
    }, {
      selector: input.actions?.[0]?.selector,
      duration: Date.now() - startTime,
      error: { message: errorMessage, code: errorCode },
    });
    return {
      success: false,
      executed_actions: [],
      frontend_execution_time_ms: Date.now() - startTime,
      page_url: '',
      page_title: '',
      error: this.buildToolError(errorMessage, errorCode, { runId: input.runId, viewId: input.crawlTabId }),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ── 全局单例 ──────────────────────────────────────────────

let sharedImpl: BrowserToolImpl | null = null;

export function getSharedBrowserToolImpl(): BrowserToolImpl {
  if (!sharedImpl) sharedImpl = new BrowserToolImpl();
  return sharedImpl;
}

export function resetSharedBrowserToolImpl(): void {
  if (sharedImpl) {
    sharedImpl.destroy();
    sharedImpl = null;
  }
}
