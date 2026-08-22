/**
 * ViewFactory - 统一 WebContentsView 管理器
 *
 * 核心职责：
 * 1. 统一创建入口：所有 View 都通过 createView() 创建
 * 2. 显示逻辑集中：根据 displayMode 决定如何显示
 * 3. 生命周期管理：统一的销毁和清理逻辑
 * 4. 标签系统集成：自动通知渲染进程创建/删除标签
 *
 * 设计原则：
 * - 单一入口：createView 是唯一创建 View 的地方
 * - 单一出口：destroyView 是唯一销毁 View 的地方
 * - Profile 驱动：用预设配置简化使用
 * - 向后兼容：不破坏现有代码
 */

import { BrowserWindow, WebContentsView, type WebContents } from 'electron';
import { EventEmitter } from 'events';
import { createLogger } from '../logger';
import { guardLoadURL } from '../../shared/guard-load-url';
import { handleBlockedPreviewLoad, installPreviewGuardWillNavigate } from '../blocked-preview-load';
import type { OpenIntentHints } from '../../shared/open-intent';
import { mergeProfileConfig } from './profiles';
import { shouldHideAgentBackgroundInteraction } from './background-interaction';

const moduleLog = createLogger('ViewFactory');
import { getViewStateRegistry, type ViewState as RegistryViewState } from '../webcontents/ViewStateRegistry';
import { PerformanceCollector, type PerformanceMetrics } from './PerformanceMetrics';
import { getRunSessionManager } from '../run-session/RunSessionManager';
import { getOrganizationTabManager } from '../organization/OrganizationTabManager';
import { getCrawlspaceContextHub } from '../crawlspace/CrawlspaceContextHub';
import { configureSyncViewInUse, syncCrawlspaceViewInUseState } from '../crawlspace/sync-view-in-use';
import { getResourceDetectionService } from '../services/ResourceDetectionService';
import { ensureCrawlspaceWindowOpenHandler } from '../crawlspace/window-open-handler';
import { registerContextMenu } from '../context-menu';
import { getDarwinVersion, getSystemArch } from '../utils/system-ua';
import { sharedAntiDetectManager } from '@tabtin/anti-detect';
import { getClientHintsService } from '@tabtin/anti-detect/client-hints';
import { ViewRegistrationCoordinator } from './registrations/ViewRegistrationCoordinator';
import {
  type ResourceInterceptionContext
} from './resource-interception';
import * as subsysReg from './registrations/subsystem-registrations';
import { createCoordinatorDelegates, type DelegatesDeps } from './registrations/coordinator-delegates';
import {
  setupResourceInterceptionForProfile,
  type ViewInstanceDeps,
} from './session-config';
import {
  cleanupIdleViews as runIdleCleanup,
  forceCleanupForQuota,
  QUOTA_RECLAIM_PROFILES,
  destroyWebContents as destroyWebContentsFn,
  closeBrowserForView as closeBrowserForViewFn,
  cleanupFingerprintPreload as cleanupPreloadFn,
  startCleanupTimer as startCleanupTimerFn,
  type ExternalHandlers as LifecycleExternalHandlers,
} from './lifecycle';
import {
  createSessionPreloadRegistry,
} from './session-preload-registry';
import { resolveViewReuse } from './view-reuse';
import { evaluateViewQuota, isGlobalViewQuotaReject, type QuotaDecision, type ViewQuotaConfig } from './view-quota';
import type { ViewQuotaSnapshotItem } from './view-quota-summary';
import { PromiseMutex } from '../utils/promise-mutex';
import { attachCrashRecoveryHandlers, buildCrashRecoveryCallbacks } from './crash-recovery';
import * as viewCreateMod from './view-create';
import * as viewDestroyMod from './view-destroy';
import * as stateSync from './view-state-sync';
import {
  handleDisplay as handleDisplayFn,
  removeFromMainWindow as removeFromMainWindowFn,
  notifyRendererCreateTab as notifyRendererCreateTabFn,
} from './display-handler';
import type {
  ViewFactoryConfig,
  ViewHandle,
  ViewEntry,
  ViewState,
  ViewFactoryOptions,
  DestroyViewOptions,
  ShowViewOptions,
  ViewDisplayMode,
  ViewProfile,
  ViewRegistrationStatus
} from './types';

// 🆕 导入新的 ViewManager
import { ViewManager } from '@tabtin/browser-capabilities';

type ResourceManagerLike = {
  register?: (resource: any) => void;
  unregister?: (resourceId: string) => void;
  get?: (resourceId: string) => any;
};

type ViewManagerLike = {
  hasView: (id: string) => boolean;
  getViewIds: () => string[];
  registerView?: (id: string, view: WebContentsView) => void;
  registerExternalView?: (id: string, view: WebContentsView) => void;
  unregisterView?: (id: string) => void;
};

type ViewFactoryExternalHandlers = {
  getResourceManager?: () => ResourceManagerLike | null;
  getViewManager?: () => ViewManagerLike | null;
  closeEngineBrowserForView?: (id: string) => Promise<void>;
  /** INFRA-014: 销毁 TabPhone view 时停止对应的 scrcpy 镜像 */
  stopTabPhoneMirrorForView?: (id: string) => Promise<void>;
  /** 创建网页 view 时挂载 CDP 网络/console 捕获（从加载起就抓，历史留本地缓冲） */
  enableNetworkCaptureForView?: (id: string) => Promise<void>;
  /** 销毁 view 时释放 CDP 网络/console 捕获缓冲，避免泄漏 */
  disableNetworkCaptureForView?: (id: string) => Promise<void>;
};

let externalHandlers: ViewFactoryExternalHandlers = {};

export function setViewFactoryExternalHandlers(next: ViewFactoryExternalHandlers): void {
  externalHandlers = {
    ...externalHandlers,
    ...next,
  };
}

export interface ViewFactoryEventMap {
  'view:crash': { id: string; reason: string; url: string };
  'view:created': { id: string; profile?: string };
  'view:registered': { id: string; profile?: string; source: string };
  'view:destroyed': { id: string; profile?: string };
  'view:task-attached': { id: string; taskId: string };
}

export class ViewFactory extends EventEmitter {
  override emit<K extends keyof ViewFactoryEventMap>(event: K, data: ViewFactoryEventMap[K]): boolean;
  override emit(event: string | symbol, ...args: any[]): boolean;
  override emit(event: string | symbol, ...args: any[]): boolean { return super.emit(event, ...args); }

  override on<K extends keyof ViewFactoryEventMap>(event: K, listener: (data: ViewFactoryEventMap[K]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this { return super.on(event, listener); }

  private static instance: ViewFactory | null = null;

  /** RF04: ViewEntry 仅存储配置/生命周期数据，运行时状态统一走 VSR */
  private views = new Map<string, ViewEntry>();

  /** 主窗口引用 */
  private mainWindow: BrowserWindow | null = null;

  /** 当前活动的 View ID */
  private currentViewId: string | null = null;

  /** 配置选项 */
  private options: Required<ViewFactoryOptions>;

  /** 清理定时器 */
  private cleanupTimer?: NodeJS.Timeout;
  private registrationReconcileTimer?: NodeJS.Timeout;
  private viewStateRegistryBridgeAttached = false;
  private registrationCoordinator: ViewRegistrationCoordinator;

  /** ⚡ 性能指标收集器 */
  private performanceCollector = new PerformanceCollector();
  /** 🆕 LRU：预览 View 最大保留数量 */
  private readonly MAX_PREVIEW_VIEWS = 5;
  /** 🆕 待注册到 ResourceManager 的队列（EngineManager 未就绪时暂存） */
  private pendingResourceRegistrations = new Map<string, Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> & Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>>();
  private destroyingViewIds = new Set<string>();
  /** 崩溃恢复频率限制：URL → 崩溃时间戳数组（跨 View 共享，避免 discard 重建后计数丢失导致无限循环） */
  private crashHistory = new Map<string, number[]>();
  /**
   * AA-008 /  冷路径窄锁：仅在命中兜底配额上限、需要驱逐空闲 View 时序列化，
   * 避免多个创建同时触发重复的 forceCleanupForQuota。锁内**不 await 建实例**，
   * 故不会像旧的全局锁那样把并发创建的慢活串成一队。
   */
  private readonly _quotaCleanupMutex = new PromiseMutex();
  /**
   *  单飞：同 id 并发创建折叠为一次，返回同一 Promise。
   * 替代旧全局锁承担的「同 id 不重复建 → 不漏 view」职责（P2-01 / CR-013）。
   */
  private readonly _inFlightCreates = new Map<string, Promise<ViewHandle>>();
  /**
   *  配额占坑：已通过同步配额判定、尚未写入 `views` 的 id。
   * 计入配额用量（{@link getQuotaUsage}），保证并发创建不同 id 时不超发。
   */
  private readonly _quotaReservations = new Set<string>();
  private resourceRetryTimer?: NodeJS.Timeout;
  private resourceRetryCount = 0;
  private static readonly MAX_REGISTRATION_RETRIES = 10;
  private static readonly BASE_RETRY_INTERVAL_MS = 1500;
  /** taskId → viewId 集合的索引，供外部通过 taskId 查询关联 View */
  private taskViewIndex = new Map<string, Set<string>>();
  /** 🆕 待注册到 WebContentsViewManager/CDPManager 的队列（EngineManager 未就绪时暂存） */
  private pendingViewManagerRegistrations = new Map<string, WebContentsView>();
  private viewManagerRetryTimer?: NodeJS.Timeout;
  private viewManagerRetryCount = 0;

  /** 🆕 ViewManager - 底层 View 创建引擎（基于 Min Browser 设计） */
  private viewManager: ViewManager;

  /** 🆕 AntiDetectManager - 反检测管理器（统一管理 UA/Proxy/Fingerprint） */
  private antiDetectManager = sharedAntiDetectManager;

  /** 🆕 Client Hints 服务 */
  private clientHintsService = getClientHintsService();

  /** ✅ 跟踪已注册的 session 级 preload（仅用于隔离 partition） */
  private sessionPreloadRegistry = createSessionPreloadRegistry();
  /** ✅ 跟踪已设置 UA 重写的 session（避免重复注册 handler） */
  private sessionsWithUARewrite = new WeakSet<Electron.Session>();
  /** 🔍 调试标记：是否已输出过 Client Hints 日志 */
  private _clientHintsLogged = false;

  /** 🆕 真实系统信息（用于 Client Hints 覆盖） */
  private systemInfo: {
    darwinVersion?: string;
    arch: 'arm' | 'x86';
  } = {
    arch: getSystemArch(),
  };

  private constructor(options?: ViewFactoryOptions) {
    super();

    this.options = {
      verbose: options?.verbose ?? false,
      maxViews: options?.maxViews ?? 50,
      idleTimeout: options?.idleTimeout ?? 300000,  // 5分钟
      enableReuse: options?.enableReuse ?? false   // 暂时禁用复用，先保证功能正确
    };

    // 🆕 初始化 ViewManager（基于 Min Browser 的轻量级 View 管理）
    this.viewManager = new ViewManager();
    // Preview Guard：createView 首载走 ViewManager.loadURL，在此统一拦截 previewable 直链
    this.viewManager.setUrlLoadGuard((url, id) => {
      const hints = this.resolveOpenIntentHintsForView(id);
      const decision = guardLoadURL({ url, ...hints, source: 'ViewManager.loadURL' });
      if (decision.action === 'allow') return true;
      handleBlockedPreviewLoad({
        url,
        source: 'ViewManager.loadURL',
        intent: decision.intent,
        mainWindow: this.mainWindow,
        ...hints,
      });
      return false;
    });

    // 注册协调器（回调实现提取至 coordinator-delegates.ts）
    this.registrationCoordinator = new ViewRegistrationCoordinator(
      createCoordinatorDelegates(this.getDelegatesDeps())
    );

    // 🆕 异步获取 macOS Darwin 版本（用于 Client Hints）
    if (process.platform === 'darwin') {
      getDarwinVersion().then((version) => {
        this.systemInfo.darwinVersion = version;
        this.log(`[ViewFactory] 📱 macOS Darwin 版本: ${version}`);
      }).catch((err) => {
        moduleLog.warn('⚠️  无法获取 Darwin 版本:', err);
      });
    }

    this.log('[ViewFactory] 初始化完成（使用 ViewManager 引擎）', this.options);
    this.attachViewStateRegistryBridge();

    // ⚡ 优化: 延迟到第一个 View 创建时再启动清理定时器
    // 这可以减少初始化开销，并避免在没有 View 的情况下运行清理任务
  }

  /**
   * 获取单例实例
   */
  public static getInstance(options?: ViewFactoryOptions): ViewFactory {
    if (!ViewFactory.instance) {
      ViewFactory.instance = new ViewFactory(options);
    }
    return ViewFactory.instance;
  }

  /**
   * 设置主窗口
   *
   * 必须在创建嵌入式 View 之前调用
   */
  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
    // 🆕 同时设置 ViewManager 的主窗口
    this.viewManager.setMainWindow(window);
    this.log('[ViewFactory] 主窗口已设置');
  }

  private resolveOpenIntentHintsForView(id: string | null | undefined): OpenIntentHints | undefined {
    if (!id) return undefined;
    const raw = this.views.get(id)?.config.metadata?.openIntentHints;
    if (!raw || typeof raw !== 'object') return undefined;
    const hints = raw as Record<string, unknown>;
    return {
      ...(typeof hints.filename === 'string' && hints.filename ? { filename: hints.filename } : {}),
      ...(typeof hints.mimeType === 'string' && hints.mimeType ? { mimeType: hints.mimeType } : {}),
      ...(typeof hints.assetId === 'string' && hints.assetId ? { assetId: hints.assetId } : {}),
    };
  }

  // ==================== 核心 API ====================

  /**
   * 创建 View（统一入口）
   *
   * @param config View 配置
   * @returns View 句柄
   *
   * @example
   * ```typescript
   * // 后台任务
   * const handle = await viewFactory.createView({
   *   profile: 'background-task',
   *   id: 'task-123',
   *   url: 'https://example.com'
   * });
   * ```
   */
  public async createView(config: ViewFactoryConfig): Promise<ViewHandle> {
    const startTime = Date.now();  // ⚡ 性能监控

    this.log('[ViewFactory] 创建 View 请求:', {
      profile: config.profile,
      id: config.id,
      url: config.url,
      runId: config.runId // 🆕 输出 runId 用于调试
    });

    // ⚡ 优化: 延迟启动清理定时器（首次创建 View 时）
    if (!this.cleanupTimer && this.views.size === 0) {
      this.log('[ViewFactory] 首次创建 View，启动清理定时器');
      this.startCleanupTimer();
      this.startRegistrationReconcileTimer();
    }

    // 1. 合并 Profile 预设
    const finalConfig = mergeProfileConfig(config);

    this.log('[ViewFactory] 最终配置:', {
      profile: finalConfig.profile,
      displayMode: finalConfig.displayMode,
      showInSidebar: finalConfig.showInSidebar,
      persistent: finalConfig.persistent,
      autoClose: finalConfig.autoClose,
      runId: finalConfig.runId // 🆕 输出 runId 用于调试
    });

    // 🧭 统一隔离诊断日志：用于排查 crawlspace 是否绑定独立 partition
    this.log('[ViewFactory] 隔离诊断:', {
      id: finalConfig.id,
      profile: finalConfig.profile,
      partition: finalConfig.partition,
      crawlspaceId: finalConfig.metadata?.crawlspaceId,
      kind: finalConfig.metadata?.kind,
      runId: finalConfig.runId,
      source: finalConfig.metadata?.source || finalConfig.metadata?.createdBy
    });

    // ✅ 强制隔离：crawlspace view 必须指定 partition
    if ((finalConfig.metadata?.crawlspaceId || finalConfig.metadata?.kind === 'workspace-view') && !finalConfig.partition) {
      throw new Error(`[ViewFactory] crawlspace view 缺少 partition: id=${finalConfig.id}`);
    }

    //  单飞：同 id 并发创建折叠为一次，避免重复建实例导致 View 泄漏（旧全局锁的 P2-01 职责）。
    // 不同 id 之间不再串行——各自并发走 _createViewInternal，慢的 createViewInstance 不再被全局锁堵。
    //
    // 语义收窄：并发的同 id 第二个调用直接拿第一个的结果，不会用自己的 config（如不同 runId）
    // 再跑一遍复用登记。viewId 带时间戳、正常不会同 id 并发，此路径只兜「同一逻辑视图被抢建」，
    // 折叠后不漏 view，严格优于旧锁下的重复建；串行复用（视图已存在时）仍走 resolveViewReuse。
    const inflight = this._inFlightCreates.get(finalConfig.id);
    if (inflight) {
      this.log('[ViewFactory] 复用进行中的同 id 创建（single-flight）:', finalConfig.id);
      return inflight;
    }
    const creation = this._createViewInternal(finalConfig, startTime);
    this._inFlightCreates.set(finalConfig.id, creation);
    try {
      return await creation;
    } finally {
      this._inFlightCreates.delete(finalConfig.id);
    }
  }

  /**
   * 单个 id 的实际创建流程，由 {@link createView} 通过 single-flight 调度。
   * 复用检查 → 同步配额占坑 → 并发建实例 → 注册 → 显示。
   */
  private async _createViewInternal(
    finalConfig: ReturnType<typeof mergeProfileConfig>,
    startTime: number,
  ): Promise<ViewHandle> {
    //  双向堵截影子 WCV（对称 adoptWebviewGuest 的旧条目销毁）：
    // 同 id 已由存活的 webview guest 承载时，绝不能再建 WCV 覆盖——后面的
    // views.set 会把权威条目换成用户看不见的「影子视图」，且旧 guest 的各
    // 子系统注册被静默丢弃（地址栏导航/截图/executeScript 全打进影子）。
    // fail-fast 与 getOrCreateViewForTab 同口径；guest 已死则销毁残留条目
    // 后照常重建 WCV（与 adopt 侧清理 stale guest 对称）。
    const existingEntry = this.views.get(finalConfig.id);
    if (existingEntry?.containerKind === 'webview-tag') {
      if (existingEntry.guestWebContents && !existingEntry.guestWebContents.isDestroyed()) {
        // dogfood grep 关键字：createView blocked by live guest
        throw new Error(
          `[ViewFactory] createView 被拒绝: id=${finalConfig.id} 已由存活 webview guest 承载，` +
          `不允许建 WCV 覆盖（requested source=${String(finalConfig.metadata?.source || finalConfig.metadata?.createdBy || 'unknown')}）`
        );
      }
      this.log('[ViewFactory] 同 id 残留已死 guest 条目，销毁后重建 WCV:', finalConfig.id);
      await this.destroyView(finalConfig.id, { force: true });
    }

    // 2. 尝试复用已有 View（同 id 已由 single-flight 串行，此处安全）
    const reused = await resolveViewReuse(finalConfig, {
      views: this.views,
      destroyView: (id, opts) => this.destroyView(id, opts),
      getRunSessionManager: () => getRunSessionManager(),
      performanceCollector: this.performanceCollector,
      getStats: () => this.getStats(),
      enableReuse: this.options.enableReuse,
      log: this.log.bind(this),
      getInUse: (id) => this.getViewInUse(id),
      setInUse: (id, value) => this.setViewInUse(id, value),
      touchView: (id) => this.touchView(id),
    });
    if (reused) {
      const duration = Date.now() - startTime;
      this.performanceCollector.recordViewCreation(duration, true);
      this.performanceCollector.updateResourceUsage(this.getStats().inUse, this.views.size);
      return reused;
    }

    // 3. 配额：同步「判定 + 占坑」快路径；仅兜底上限时进冷路径窄锁驱逐后复检。
    await this.reserveQuotaOrThrow(finalConfig);

    let view!: WebContentsView;
    let state!: ViewEntry;
    let reservationHeld = true;
    try {
      // 4. 创建底层 WebContentsView 实例（不同 id 之间并发，不再被全局锁串行）
      view = await this.createViewInstance(finalConfig);

      // 4.5 绑定崩溃恢复监听（RF04: syncState 通过 VSR 更新运行时状态）
      attachCrashRecoveryHandlers(view, finalConfig.id, this.emit.bind(this), this.log.bind(this),
        buildCrashRecoveryCallbacks(finalConfig.id, {
          hasView: (id) => this.views.has(id),
          crashHistory: this.crashHistory,
          getViewStateRegistry: () => getViewStateRegistry(),
          destroyView: (id, opts) => this.destroyView(id, opts),
        }),
        {
          getMainWindow: () => this.mainWindow,
          getOpenIntentHints: () => this.resolveOpenIntentHintsForView(finalConfig.id),
        },
      );

      // 5. 创建 ViewEntry（纯配置/生命周期数据）
      state = {
        id: finalConfig.id,
        view,
        profile: finalConfig.profile,
        config: finalConfig,
        createdAt: Date.now(),
        attachedToMainWindow: false,
        tabNotified: false,
        registrations: {}
      };

      // 占坑转正：先写入 views、再同步移除 reservation，二者间无 await，配额计数不重复也不落空。
      this.views.set(finalConfig.id, state);
      this._quotaReservations.delete(finalConfig.id);
      reservationHeld = false;

      // RF04: 立即注册 VSR 作为运行时状态的单一来源（inUse=true）
      this.registerToViewStateRegistry(finalConfig.id, view.webContents, finalConfig, true);
    } catch (err) {
      if (reservationHeld) this._quotaReservations.delete(finalConfig.id);
      throw err;
    }

    // 注册阶段：失败时回滚已写入的 ViewEntry / VSR / webContents
    try {
      await this.registrationCoordinator.registerForCreate(state);

      ensureCrawlspaceWindowOpenHandler(view.webContents, finalConfig.id);
      installPreviewGuardWillNavigate(
        view.webContents,
        () => this.mainWindow,
        'ViewFactory.will-navigate',
        () => this.resolveOpenIntentHintsForView(finalConfig.id),
      );

      if (this.mainWindow) {
        registerContextMenu(view.webContents, finalConfig.id, this.mainWindow);
      }

      await this.registrationCoordinator.registerRegistries(state);

      // 网络捕获从加载起就挂：仅网页类 view（crawlspace / workspace-view），
      // 排除 TabDoc/TabData 等 App view。
      //
      // 关键：fire-and-forget，绝不 await。CDP attach + Network.enable 是对浏览器
      // 进程的快速 round-trip，会在导航真正发出首个网络请求之前就位（与
      // FrontendActionBridge 旧的 .catch(()=>{}) 懒挂同口径）；若在创建热路径上
      // await，一旦 CDP attach 在 webContents 初始化期间 stall，会卡死整个建 tab
      // 流程（实测 open 直接挂到 120s 超时）。这里只负责"尽早触发"，不阻断创建。
      const isWebView =
        Boolean(finalConfig.metadata?.crawlspaceId) ||
        finalConfig.metadata?.kind === 'workspace-view';
      if (isWebView && externalHandlers.enableNetworkCaptureForView) {
        void externalHandlers.enableNetworkCaptureForView(finalConfig.id).catch((err) => {
          this.log('[ViewFactory] 挂载网络捕获失败（不阻断创建）:', finalConfig.id, err);
        });
      }

      if (finalConfig.url && finalConfig.url !== 'about:blank') {
        this.viewManager.loadURL(finalConfig.id, finalConfig.url);
      }
    } catch (error) {
      this.log('[ViewFactory] 注册失败，执行回滚:', finalConfig.id);
      try {
        await this.registrationCoordinator.unregisterAll(state);
      } catch (unregErr) {
        this.log('[ViewFactory] 回滚 unregisterAll 失败:', unregErr);
      }
      this.unregisterFromViewStateRegistry(finalConfig.id);
      if (state.view && !state.view.webContents.isDestroyed()) {
        const wc = state.view.webContents as WebContents & { destroy?: () => void }
        if (typeof wc.destroy === 'function') {
          wc.destroy()
        }
      }
      this.views.delete(finalConfig.id);
      throw error;
    }

    // 7. 处理显示逻辑
    await handleDisplayFn(state, this.getDisplayCtx());

    // 8. 通知渲染进程创建标签（如果需要）
    // 🆕 支持 notifyRenderer 选项：允许在不显示侧边栏的情况下仍然通知渲染进程
    if (finalConfig.notifyRenderer) {
      await notifyRendererCreateTabFn(state, this.getDisplayCtx());
    }

    // 9. 关联任务（如果有）
    if (finalConfig.taskId) {
      this.attachToTask(finalConfig.id, finalConfig.taskId);
    }

    moduleLog.info(
      `✅ View 创建完成: id=${finalConfig.id}, displayMode=${finalConfig.displayMode}, ` +
        `attachedToMainWindow=${state.attachedToMainWindow}, tabNotified=${state.tabNotified}`,
    );

    this.emit('view:created', { id: finalConfig.id, profile: finalConfig.profile });

    // 预览/脱屏创建后若未激活，尽快 release inUse，避免一直占「使用中」挡回收
    const createdCrawlspaceId = finalConfig.metadata?.crawlspaceId as string | undefined;
    if (createdCrawlspaceId) {
      try {
        syncCrawlspaceViewInUseState(createdCrawlspaceId);
      } catch (error) {
        this.log('[ViewFactory] createView 后同步 inUse 失败（可忽略）:', error);
      }
    }

    // ⚡ 记录性能
    const duration = Date.now() - startTime;
    this.performanceCollector.recordViewCreation(duration, false);  // 新创建
    this.performanceCollector.updateResourceUsage(
      this.getStats().inUse,
      this.views.size
    );

    return {
      id: finalConfig.id,
      view,
      reused: false,
      profile: finalConfig.profile,
      config: finalConfig
    };
  }

  /**
   * 注册外部创建的 View
   *
   * 用于将 ElectronLauncher 或其他外部系统创建的 View 注册到 ViewFactory 统一管理
   *
   * @param id View ID
   * @param view 已创建的 WebContentsView 实例
   * @param options 可选配置
   *
   * @example
   * ```typescript
   * // ElectronLauncher 创建 View 后注册
   * const view = await launcher.createView({ id: 'task-123', url: '...' });
   * viewFactory.registerExternalView('task-123', view.view, {
   *   profile: 'background-task',
   *   url: '...',
   *   metadata: { source: 'launcher' }
   * });
   * ```
   */
  public async registerExternalView(
    id: string,
    view: WebContentsView,
    options?: {
      profile?: ViewProfile;
      url?: string;
      metadata?: Record<string, any>;
      taskId?: string;
      runId?: string;
      partition?: string;
    }
  ): Promise<void> {
    this.log('[ViewFactory] 注册外部 View:', { id, options });

    // 检查是否已存在（同步快判，未占坑，直接返回不泄漏）
    if (this.views.has(id)) {
      this.log('[ViewFactory] ⚠️  View 已存在，跳过注册:', id);
      return;
    }

    const baseMetadata = options?.metadata || {}
    const hasWorkspaceSignal =
      baseMetadata.kind === 'workspace-view' || Boolean(baseMetadata.crawlspaceId)
    const sessionPartition =
      (view.webContents?.session as unknown as { partition?: string } | undefined)?.partition
    const partition = options?.partition ?? sessionPartition

    if (hasWorkspaceSignal) {
      if (!baseMetadata.kind) {
        throw new Error(`[ViewFactory] 外部 View 缺少 metadata.kind: id=${id}`)
      }
      if (!baseMetadata.crawlspaceId) {
        throw new Error(`[ViewFactory] 外部 View 缺少 metadata.crawlspaceId: id=${id}`)
      }
      if (!partition) {
        throw new Error(`[ViewFactory] 外部 View 缺少 partition: id=${id}`)
      }
    }

    // 使用默认配置或指定的 profile
    const profile = options?.profile || 'user-tab';
    const url = options?.url || view.webContents.getURL() || '';
    const metadata = {
      ...baseMetadata,
      source: baseMetadata.source ?? 'external',
      registeredAt: Date.now()
    }

    // 创建最小配置
    const config = mergeProfileConfig({
      profile,
      id,
      url,
      runId: options?.runId,
      partition,
      metadata: {
        ...metadata
      }
    });

    // CR-013 / : 配额占坑 — 与 createView 共享同步占坑账（_quotaReservations），
    // 保证两路并发时配额不超发。
    //
    // 收窄说明：旧 P2-02 用同一把全局锁额外保证「与 createView 并发时 views.set 互斥」。
    // 去锁后占坑账只保配额、不保跨路径同 id 的 views.set 互斥。这在此处安全，因为 external
    // view 的 id 来自 launcher/task 命名空间，与 createView 的 crawlspace viewId 不相交，
    // 不存在两路抢同一 id；单路径内的同 id 并发分别由 createView 单飞、本方法 has 复查兜住。
    await this.reserveQuotaOrThrow(config);
    let reservationHeld = true;
    try {
      // 冷路径驱逐 await 后可能已被并发创建，复查一次避免双注册
      if (this.views.has(id)) {
        this.log('[ViewFactory] ⚠️  View 已存在（并发），跳过注册:', id);
        return;
      }

      // RF04: 创建 ViewEntry（纯配置/生命周期数据）
      const state: ViewEntry = {
        id,
        view,
        profile,
        config,
        createdAt: Date.now(),
        attachedToMainWindow: false,
        tabNotified: false,
        registrations: {}
      };

      // 占坑转正：写入 views 后同步移除 reservation，二者间无 await。
      this.views.set(id, state);
      this._quotaReservations.delete(id);
      reservationHeld = false;

      // RF04: 立即注册 VSR（inUse=false，外部 View 默认不标记为使用中）
      this.registerToViewStateRegistry(id, view.webContents, config, false);

      await this.registrationCoordinator.registerExternal(state);

      // 注册右键上下文菜单（与 createView 保持一致）
      if (this.mainWindow) {
        registerContextMenu(view.webContents, id, this.mainWindow);
      }

      // 关联任务（如果有）
      if (options?.taskId) {
        this.attachToTask(id, options.taskId);
      }

      this.log('[ViewFactory] ✅ 外部 View 已注册:', id);
      this.emit('view:registered', { id, profile, source: 'external' });
    } finally {
      // 早退（并发已存在）或注册抛错时释放占坑，避免配额被占死
      if (reservationHeld) this._quotaReservations.delete(id);
    }
  }

  // ==================== webview tag guest（, flag=webview 专用） ====================

  /**
   * : webview guest 的 session 准备（announce 阶段调用）。
   *
   * renderer 创建 <webview> 元素**之前**必须先经此归一化：
   *   - mergeProfileConfig 合并 Profile 预设（与 createView 同一入口）
   *   - SessionConfigFactory 归一化 partition（`persist:` 前缀纪律的唯一权威）
   *   - session 级指纹 preload 注册（guest 加载前就位）
   *
   * 返回 effectivePartition = renderer 应写到 <webview> partition 属性的完整
   * 字符串（'' = 默认共享 session，元素不设该属性）。
   */
  public async prepareWebviewGuestSession(config: ViewFactoryConfig): Promise<{
    effectivePartition: string;
    finalConfig: ReturnType<typeof mergeProfileConfig>;
  }> {
    const finalConfig = mergeProfileConfig(config);

    // 与 createView 相同的强制隔离约束
    if ((finalConfig.metadata?.crawlspaceId || finalConfig.metadata?.kind === 'workspace-view') && !finalConfig.partition) {
      throw new Error(`[ViewFactory] crawlspace view 缺少 partition: id=${finalConfig.id}`);
    }

    const sessionConfig = await viewCreateMod.prepareGuestSessionConfig(finalConfig, {
      sessionPreloadRegistry: this.sessionPreloadRegistry,
      log: this.log.bind(this),
    });

    const partition = (sessionConfig as Electron.WebPreferences).partition;
    if ((sessionConfig as Electron.WebPreferences).preload) {
      // 共享默认 session + 指纹配置时 prepareGuestSessionConfig 会回落 view 级
      // preload——webview 容器的 will-attach 白名单禁止属性级 preload，此路径
      // 指纹注入不生效。TODO(Phase 3): 共享 session 的指纹 preload 改为
      // session 级注册或放弃该组合。
      moduleLog.warn('webview guest 共享 session 的 view 级指纹 preload 不受支持（已忽略）:', finalConfig.id);
    }

    return {
      effectivePartition: typeof partition === 'string' ? partition : '',
      finalConfig,
    };
  }

  /**
   * : 收养 webview tag guest（did-attach/bind 配对成功后调用）。
   *
   * 与 registerExternalView 的差异：
   *   - 容器对象（<webview> 元素）在 renderer，主进程只持有 guest WebContents；
   *     ViewEntry.view 恒为 null + guestWebContents 承载页面能力。
   *   - 复用既有能力装配：VSR 注册 → registerExternal（RunSession / Workspace /
   *     ResourceDetection；CDPManager/ResourceManager 注册对两种容器都是 no-op——
   *     externalHandlers.getResourceManager / getViewManager 从未被任何调用方
   *     配置，属遗留死代码，见 ）
   *     → 反检测 + 资源拦截（与 WCV createViewInstance
   *     共用 applyGuestCapabilities）→ popup 接管（ensureCrawlspaceWindowOpenHandler）。
   *   - 崩溃恢复不走 attachCrashRecoveryHandlers（guest 恢复须经 renderer 的
   *     webview.reload()，由 webview-host 转发 IPC 处理）。
   */
  public async adoptWebviewGuest(
    id: string,
    webContents: WebContents,
    finalConfig: ReturnType<typeof mergeProfileConfig>,
  ): Promise<void> {
    this.log('[ViewFactory] 收养 webview guest:', { id, partition: finalConfig.partition, profile: finalConfig.profile });

    const existing = this.views.get(id);
    if (existing) {
      const sameAliveGuest =
        existing.containerKind === 'webview-tag' &&
        existing.guestWebContents &&
        !existing.guestWebContents.isDestroyed() &&
        existing.guestWebContents.id === webContents.id;
      if (sameAliveGuest) {
        // 同一 guest 重复收养（did-attach + bind 双路径），无事可做
        this.log('[ViewFactory] ⚠️  webview guest 已收养，跳过重复收养:', id);
        return;
      }
      // 两种残留都不能当权威：
      //   a) WCV 条目——flag=webview 下用户看到的是 <webview> guest，这个 WCV
      //      是不可见的「影子视图」（多由休眠唤醒/冷恢复等未迁移路径先建出来），
      //      保留它会让 executeScript / 截图打进看不见的那份；
      //   b) 死掉/换代的旧 guest 条目——元素重建后 webContents 已是新的。
      // 一律销毁旧条目，由当前可见 guest 接管。
      this.log('[ViewFactory] ⚠️  同 id 存在旧容器条目（影子 WCV 或 stale guest），销毁后由 webview guest 接管:', {
        id,
        oldContainerKind: existing.containerKind ?? 'wcv',
      });
      await this.destroyView(id, { force: true });
    }

    // 与 createView 对齐：首个 View 出现时启动清理/对账定时器
    if (!this.cleanupTimer && this.views.size === 0) {
      this.startCleanupTimer();
      this.startRegistrationReconcileTimer();
    }

    await this.reserveQuotaOrThrow(finalConfig);
    let reservationHeld = true;
    try {
      if (this.views.has(id)) {
        this.log('[ViewFactory] ⚠️  View 已存在（并发），跳过 webview guest 收养:', id);
        return;
      }

      const state: ViewEntry = {
        id,
        view: null,
        guestWebContents: webContents,
        containerKind: 'webview-tag',
        profile: finalConfig.profile,
        config: finalConfig,
        createdAt: Date.now(),
        attachedToMainWindow: false,
        tabNotified: false,
        registrations: {},
      };

      this.views.set(id, state);
      this._quotaReservations.delete(id);
      reservationHeld = false;

      this.registerToViewStateRegistry(id, webContents, finalConfig, false);

      try {
        await this.registrationCoordinator.registerExternal(state);

        await viewCreateMod.applyGuestCapabilities(webContents, finalConfig, {
          getViewInstanceDeps: () => this.getViewInstanceDeps(),
          getResourceInterceptionCtx: () => this.getResourceInterceptionCtx(),
          log: this.log.bind(this),
        });

        // popup 接管：guest 内 window.open → deny + 转产品 tab（与 WCV 同一 handler）
        ensureCrawlspaceWindowOpenHandler(webContents, id);

        // 右键菜单：与 WCV createView 同一套 menu items（registerContextMenu
        // 内部幂等，重复收养不会双挂 listener）
        if (this.mainWindow) {
          registerContextMenu(webContents, id, this.mainWindow);
        }

        // 网络捕获（与 createView 的 crawlspace 分支同口径，fire-and-forget）
        const isWebView =
          Boolean(finalConfig.metadata?.crawlspaceId) ||
          finalConfig.metadata?.kind === 'workspace-view';
        if (isWebView && externalHandlers.enableNetworkCaptureForView) {
          void externalHandlers.enableNetworkCaptureForView(id).catch((err) => {
            this.log('[ViewFactory] 挂载网络捕获失败（不阻断收养）:', id, err);
          });
        }
      } catch (error) {
        this.log('[ViewFactory] webview guest 装配失败，执行回滚:', id);
        try {
          await this.registrationCoordinator.unregisterAll(state);
        } catch (unregErr) {
          this.log('[ViewFactory] 回滚 unregisterAll 失败:', unregErr);
        }
        this.views.delete(id);
        throw error;
      }

      if (finalConfig.taskId) {
        this.attachToTask(id, finalConfig.taskId);
      }

      this.log('[ViewFactory] ✅ webview guest 已收养:', id);
      this.emit('view:registered', { id, profile: finalConfig.profile, source: 'webview-tag' });
    } finally {
      if (reservationHeld) this._quotaReservations.delete(id);
    }
  }


  /**
   * 销毁 View（统一出口）
   *
   * @param id View ID
   * @param options 销毁选项
   *
   * @example
   * ```typescript
   * // 正常销毁
   * await viewFactory.destroyView('task-123');
   *
   * // 强制销毁（忽略 keepAlive）
   * await viewFactory.destroyView('task-123', { force: true });
   * ```
   */
  public async destroyView(id: string, options?: DestroyViewOptions): Promise<void> {
    const startTime = Date.now();  // ⚡ 性能监控

    if (this.destroyingViewIds.has(id)) {
      this.log('[ViewFactory] View 正在销毁，跳过重复请求:', id);
      return;
    }
    this.destroyingViewIds.add(id);

    // ✅ 审计：记录调用栈
    const stack = new Error().stack;
    const caller = stack?.split('\n')[2]?.trim() || 'unknown';

    moduleLog.info(`销毁 View 请求: id=${id}, force=${!!options?.force}, caller=${caller.substring(0, 100)}`);

    const entry = this.views.get(id);
    let crawlspaceId: string | undefined;
    let closingMarked = false;
    let viewDestroyed = false;
    try {
      if (!entry) {
        this.log('[ViewFactory] View 不存在，跳过销毁:', id);
        return;
      }

      if (entry.config.keepAlive && !options?.force) {
        this.log('[ViewFactory] View 保持活跃，跳过销毁:', id);
        return;
      }

      crawlspaceId = entry.config.metadata?.crawlspaceId;
      if (crawlspaceId && (entry.config.metadata?.kind === 'workspace-view' || crawlspaceId)) {
        getCrawlspaceContextHub().markViewClosing(crawlspaceId, id);
        closingMarked = true;
      }

      const result = await viewDestroyMod.executeViewDestruction(id, entry, options, this.getDestroyDeps());
      viewDestroyed = result.viewDestroyed;

      const duration = Date.now() - startTime;
      this.performanceCollector.recordViewDestroy(duration);
      this.performanceCollector.updateResourceUsage(this.getStats().inUse, this.views.size);
      this.emit('view:destroyed', { id, profile: entry.profile });
    } catch (error) {
      if (viewDestroyed && entry) {
        await viewDestroyMod.recoverFromPartialDestruction(id, entry, options, {
          views: this.views,
          registrationCoordinator: this.registrationCoordinator,
          log: this.log.bind(this),
        });
      }
      throw error;
    } finally {
      if (closingMarked && crawlspaceId) {
        getCrawlspaceContextHub().clearViewClosing(crawlspaceId, id);
      }
      this.destroyingViewIds.delete(id);
    }
  }

  /**
   * 显示 View
   *
   * @param id View ID
   * @param options 显示选项
   */
  public async showView(id: string, options?: ShowViewOptions): Promise<void> {
    const entry = this.views.get(id);

    if (!entry) {
      throw new Error(`View 不存在: ${id}`);
    }

    if (options?.bounds) {
      entry.config.bounds = options.bounds;
    }

    await handleDisplayFn(entry, this.getDisplayCtx());
  }

  /**
   * 隐藏 View（不销毁）
   *
   * @param id View ID
   */
  public async hideView(id: string): Promise<void> {
    const entry = this.views.get(id);

    if (!entry) {
      throw new Error(`View 不存在: ${id}`);
    }

    if (entry.attachedToMainWindow) {
      await removeFromMainWindowFn(id, this.views, this.getDisplayCtx());
    }
  }

  /**
   * 🆕 处理任务完成事件
   *
   * ✅ 根据 Profile 的 autoClose 配置决定是否销毁 View
   *
   * 这是遵循 Profile 系统的核心方法：
   * - autoClose: true  → 自动销毁（如 background-task）
   * - autoClose: false → 保留（如 agent-workspace, user-tab）
   *
   * @param viewId View ID
   * @param context 上下文信息（用于日志）
   *
   * @example
   * ```typescript
   * // 任务完成后，ViewFactory 根据 Profile 自动决定
   * await viewFactory.onTaskCompleted('view-cs-123-1700000000000', {
   *   taskId: 'task_abc',
   *   status: 'completed'
   * });
   * ```
   */
  public async onTaskCompleted(
    viewId: string,
    context?: { taskId?: string; status?: string; reason?: string }
  ): Promise<void> {
    const entry = this.views.get(viewId);

    if (!entry) {
      moduleLog.warn(`View ${viewId} 不存在，跳过 onTaskCompleted`);
      return;
    }

    moduleLog.info(
      `📝 任务完成通知: view=${viewId}, profile=${entry.config.profile}, autoClose=${entry.config.autoClose}`,
    );

    const currentBounds = entry.view?.getBounds() ?? entry.config.bounds;
    if (shouldHideAgentBackgroundInteraction(entry.config, currentBounds)) {
      moduleLog.info(`🫥 后台交互 View 任务完成，隐藏 View: ${viewId}`);
      this.releaseViewInUse(viewId);
      await this.hideView(viewId);
      return;
    }

    if (entry.config.autoClose) {
      moduleLog.info(`🔄 autoClose=true，销毁 View: ${viewId}`);
      await this.destroyView(viewId);
    } else {
      moduleLog.info(`✋ autoClose=false，保留 View (由用户/工作区管理): ${viewId}`);
      this.releaseViewInUse(viewId);
    }
  }

  /**
   * 获取 View 状态（组合 ViewEntry + VSR 运行时数据）
   *
   * @param id View ID
   * @returns 完整 View 状态
   */
  public getViewState(id: string): ViewState | undefined {
    return this.composeViewState(id);
  }

  /**
   * 检查 View 是否存在
   *
   * @param id View ID
   * @returns 是否存在
   */
  public hasView(id: string): boolean {
    return this.views.has(id);
  }

  public isDestroyingView(id: string): boolean {
    return this.destroyingViewIds.has(id);
  }

  /**
   * 获取 View 实例
   *
   * @param id View ID
   * @returns WebContentsView 实例或 null
   */
  public getView(id: string): WebContentsView | null {
    const entry = this.views.get(id);
    return entry?.view || null;
  }

  /**
   * : 获取 View 的 WebContents（容器无关句柄）。
   *
   * 只需要页面能力（executeJavaScript / capturePage / session 等）的调用方
   * 应使用本方法替代 getView()，以便 Phase 2 换容器实现时不需要改动。
   * 注意：与 getView() 一致，不过滤已销毁的 WebContents，判活由调用方负责。
   *
   * : webview tag guest 条目（view=null）返回 guestWebContents，
   * 让导航 / 截图 / zoom / executeScript 等容器无关路径对两种容器一致工作。
   *
   * @param id View ID
   * @returns WebContents 或 null（View 不存在 / 已 discard）
   */
  public getWebContents(id: string): WebContents | null {
    const entry = this.views.get(id);
    return entry?.view?.webContents ?? entry?.guestWebContents ?? null;
  }

  /**
   * 为主进程观测/诊断提供稳定视图快照（组合 ViewEntry + VSR）。
   */
  public getAllViewStates(): ViewState[] {
    return Array.from(this.views.keys())
      .map(id => this.composeViewState(id))
      .filter((s): s is ViewState => s !== undefined);
  }

  /**
   * 只读快照：供 CLI QUOTA_EXCEEDED detail.quota 填充，不暴露 WebContents。
   */
  public listQuotaSnapshotItems(): ViewQuotaSnapshotItem[] {
    const items: ViewQuotaSnapshotItem[] = []
    for (const [viewId, entry] of this.views) {
      const crawlspaceId = entry.config.metadata?.crawlspaceId
      const snapshot: ViewQuotaSnapshotItem = {
        viewId,
        profile: entry.profile,
      }
      if (entry.config.tabName) {
        snapshot.title = entry.config.tabName
      }
      if (entry.config.url) {
        snapshot.url = entry.config.url
      }
      if (typeof crawlspaceId === 'string' && crawlspaceId.length > 0) {
        snapshot.crawlspaceId = crawlspaceId
      }
      if (entry.discarded) {
        snapshot.discarded = true
      }
      items.push(snapshot)
    }
    return items
  }

  public refreshResourceInterception(id: string, url: string): void {
    const entry = this.views.get(id);
    // : webview guest 条目 view=null、页面能力在 guestWebContents——
    // 与 getWebContents 同口径取用，否则 Agent loadUrl 换页后 guest 的
    // agent-workspace 资源拦截 URL 上下文停留在旧页
    const wc = entry?.view?.webContents ?? entry?.guestWebContents;
    if (!entry || !wc || wc.isDestroyed()) {
      return;
    }
    entry.config.url = url;
    setupResourceInterceptionForProfile(wc, entry.config, this.getResourceInterceptionCtx());
  }

  /**
   * 🆕 标记 View 的主窗口附加状态
   *
   * @param id View ID
   * @param attached 是否已附加到主窗口
   */
  public markAttachedToMainWindow(id: string, attached: boolean): void {
    const entry = this.views.get(id);

    if (!entry) {
      this.log('[ViewFactory] ⚠️  View 不存在，无法更新 attachedToMainWindow:', id);
      return;
    }

    entry.attachedToMainWindow = attached;
    this.log('[ViewFactory] 📌 更新 attachedToMainWindow:', { id, attached });

    const crawlspaceId = entry.config.metadata?.crawlspaceId as string | undefined;
    if (crawlspaceId) {
      try {
        syncCrawlspaceViewInUseState(crawlspaceId);
      } catch (error) {
        this.log('[ViewFactory] markAttached 后同步 inUse 失败（可忽略）:', error);
      }
    }
  }

  /**
   * 🆕 更新 View 状态
   *
   * @param id View ID
   * @param updates 要更新的状态字段
   */
  public updateViewState(id: string, updates: Partial<Pick<ViewState, 'attachedToMainWindow' | 'tabNotified' | 'inUse'>>): void {
    const entry = this.views.get(id);

    if (!entry) {
      this.log('[ViewFactory] ⚠️  View 不存在，无法更新状态:', id);
      return;
    }

    // RF04: inUse 写入 VSR，其余字段写入 ViewEntry
    if (updates.inUse !== undefined) {
      this.setViewInUse(id, updates.inUse);
    }
    if (updates.attachedToMainWindow !== undefined) {
      entry.attachedToMainWindow = updates.attachedToMainWindow;
    }
    if (updates.tabNotified !== undefined) {
      entry.tabNotified = updates.tabNotified;
    }
    this.log('[ViewFactory] 📝 更新 View 状态:', { id, updates });
  }

  /**
   * 标记 View 为使用中（防止 LRU 清理）
   *
   * @param id View ID
   */
  public markViewInUse(id: string): void {
    if (!this.views.has(id)) {
      this.log('[ViewFactory] ⚠️  View 不存在，无法标记为使用中:', id);
      return;
    }

    this.setViewInUse(id, true);
    this.touchView(id);
    this.log('[ViewFactory] 🔒 标记 View 为使用中:', id);
  }

  /**
   * 释放 View 的使用标记
   *
   * @param id View ID
   */
  public releaseViewInUse(id: string): void {
    if (!this.views.has(id)) {
      this.log('[ViewFactory] ⚠️  View 不存在，无法释放使用标记:', id);
      return;
    }

    this.setViewInUse(id, false);
    this.touchView(id);
    this.log('[ViewFactory] 🔓 释放 View 使用标记:', id);
  }

  /**
   * 刷新所有 View 的 lastAccessTime，防止批量误清理。
   *
   * 典型使用场景：系统唤醒后（合盖过夜），所有 View 的 lastAccessTime 远超 idle 阈值，
   * 首个清理周期会批量 discard 全部标签。在 system-sleep-guard.ts 的 handleResume
   * 回调中调用此方法可给每个 View 续期一个新的 idle 窗口。
   *
   * ⚠️ 不要在 ViewFactory 中直接监听 powerMonitor.resume，
   *     唤醒保护统一由 system-sleep-guard.ts 协调。
   */
  public touchAllViews(): void {
    stateSync.touchAllViews(this.views, () => getViewStateRegistry(), this.log.bind(this));
  }

  /**
   * 获取所有 View 的 ID 列表
   *
   * @returns ID 列表
   */
  public getAllViewIds(): string[] {
    return Array.from(this.views.keys());
  }

  /**
   * 获取当前活动的 View ID
   *
   * @returns 当前活动的 View ID 或 null
   */
  public getCurrentViewId(): string | null {
    return this.currentViewId;
  }

  /**
   * 设置当前活动的 View ID
   *
   * @param id View ID 或 null
   */
  public setCurrentViewId(id: string | null): void {
    this.currentViewId = id;
    this.log('[ViewFactory] 🎯 设置当前活动 View:', id);
  }

  /**
   * 获取统计信息
   */
  public getStats(): {
    total: number;
    inUse: number;
    idle: number;
    byProfile: Record<string, number>;
    pending: {
      resource: number;
      cdp: number;
    };
  } {
    const stats = {
      total: this.views.size,
      inUse: 0,
      idle: 0,
      byProfile: {} as Record<string, number>,
      pending: {
        resource: this.pendingResourceRegistrations.size,
        cdp: this.pendingViewManagerRegistrations.size
      }
    };

    for (const [id, entry] of this.views.entries()) {
      if (this.getViewInUse(id)) {
        stats.inUse++;
      } else {
        stats.idle++;
      }

      const profile = entry.profile;
      stats.byProfile[profile] = (stats.byProfile[profile] || 0) + 1;
    }

    return stats;
  }

  // ==================== 内部实现 ====================

  /**
   * 创建底层 WebContentsView 实例
   *
   * 委托 session-config 子模块处理 Session 构建 + 反检测配置。
   */
  private async createViewInstance(config: Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> & Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>): Promise<WebContentsView> {
    return viewCreateMod.createViewInstance(config, this.getViewCreateDeps());
  }

  // ---------------------------------------------------------------------------
  // Context 工厂方法（为提取出的子模块提供依赖）
  // ---------------------------------------------------------------------------

  private getDisplayCtx() {
    return {
      mainWindow: this.mainWindow,
      viewManager: this.viewManager,
      log: this.log.bind(this),
      touchView: (id: string) => this.touchView(id),
    }
  }

  private _cachedResourceInterceptionCtx: ResourceInterceptionContext | null = null;
  private getResourceInterceptionCtx(): ResourceInterceptionContext {
    if (!this._cachedResourceInterceptionCtx) {
      this._cachedResourceInterceptionCtx = {
        clientHintsService: this.clientHintsService,
        systemInfo: this.systemInfo,
        log: this.log.bind(this),
        _clientHintsLogged: false,
      };
    }
    return this._cachedResourceInterceptionCtx;
  }

  // ---------------------------------------------------------------------------
  // RF04: VSR 运行时状态访问器（单一来源）
  // ---------------------------------------------------------------------------

  private getViewInUse(id: string): boolean {
    return stateSync.getViewInUse(id, () => getViewStateRegistry());
  }

  private setViewInUse(id: string, value: boolean): void {
    stateSync.setViewInUse(id, value, () => getViewStateRegistry());
  }

  private touchView(id: string): void {
    stateSync.touchView(id, () => getViewStateRegistry());
  }

  private composeViewState(id: string): ViewState | undefined {
    return stateSync.composeViewState(id, this.views, () => getViewStateRegistry());
  }

  private getCleanupCtx() {
    return {
      views: this.views,
      idleTimeout: this.options.idleTimeout,
      maxPreviewViews: this.MAX_PREVIEW_VIEWS,
      destroyView: (id: string, opts?: DestroyViewOptions) => this.destroyView(id, opts),
      log: this.log.bind(this),
      performanceCollector: this.performanceCollector,
    }
  }

  private getViewCreateDeps(): viewCreateMod.ViewCreateDeps {
    return {
      viewManager: this.viewManager,
      sessionPreloadRegistry: this.sessionPreloadRegistry,
      getViewInstanceDeps: () => this.getViewInstanceDeps(),
      getResourceInterceptionCtx: () => this.getResourceInterceptionCtx(),
      log: this.log.bind(this),
    };
  }

  private getDestroyDeps(): viewDestroyMod.ViewDestroyDeps {
    return {
      views: this.views,
      viewManager: this.viewManager,
      mainWindow: this.mainWindow,
      taskViewIndex: this.taskViewIndex,
      registrationCoordinator: this.registrationCoordinator,
      getDisplayCtx: () => this.getDisplayCtx(),
      closeBrowserForView: (id) => this.closeBrowserForView(id),
      destroyWebContents: (view, entry) => this.destroyWebContents(view, entry),
      log: this.log.bind(this),
    };
  }

  private getViewInstanceDeps(): ViewInstanceDeps {
    return {
      viewManager: this.viewManager,
      antiDetectManager: this.antiDetectManager,
      sessionsWithUARewrite: this.sessionsWithUARewrite,
      resourceInterceptionCtx: this.getResourceInterceptionCtx(),
      log: this.log.bind(this),
    }
  }

  // ---------------------------------------------------------------------------
  // 子系统注册 — 委托 registrations/subsystem-registrations.ts
  // ---------------------------------------------------------------------------

  private registerToViewStateRegistry(
    id: string,
    webContents: WebContents,
    config: Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> & Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>,
    inUse: boolean = false,
  ): void {
    subsysReg.registerToViewStateRegistry(id, webContents, config, inUse, this.getRegCtx())
  }

  private unregisterFromViewStateRegistry(id: string): void {
    subsysReg.unregisterFromViewStateRegistry(id, this.getRegCtx())
  }

  private async registerToResourceManager(
    id: string,
    config: Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> & Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>,
  ): Promise<void> {
    await subsysReg.registerToResourceManager(id, config, this.getRegCtx())
  }

  private async unregisterFromResourceManager(id: string): Promise<void> {
    await subsysReg.unregisterFromResourceManager(id, this.getRegCtx())
  }

  private async registerToWebContentsViewManager(id: string, view: WebContentsView): Promise<void> {
    await subsysReg.registerToWebContentsViewManager(id, view, this.getRegCtx())
  }

  private async unregisterFromWebContentsViewManager(id: string): Promise<void> {
    await subsysReg.unregisterFromWebContentsViewManager(id, this.getRegCtx())
  }

  private async flushPendingResourceRegistrations(): Promise<void> {
    await subsysReg.flushPendingResourceRegistrations(this.getRegCtx())
    if (this.pendingResourceRegistrations.size === 0) {
      this.resourceRetryCount = 0
    }
  }

  private async flushPendingViewManagerRegistrations(): Promise<void> {
    await subsysReg.flushPendingViewManagerRegistrations(this.getRegCtx())
    if (this.pendingViewManagerRegistrations.size === 0) {
      this.viewManagerRetryCount = 0
    }
  }

  private schedulePendingResourceRetry(): void {
    if (this.resourceRetryTimer) return
    if (this.resourceRetryCount >= ViewFactory.MAX_REGISTRATION_RETRIES) {
      this.log(
        '[ViewFactory] ⛔ ResourceManager 重试已达上限，放弃注册:',
        Array.from(this.pendingResourceRegistrations.keys()),
      )
      this.pendingResourceRegistrations.clear()
      this.resourceRetryCount = 0
      return
    }
    const delay = ViewFactory.BASE_RETRY_INTERVAL_MS * Math.pow(2, Math.min(this.resourceRetryCount, 5))
    this.resourceRetryCount++
    this.resourceRetryTimer = setTimeout(() => {
      this.resourceRetryTimer = undefined
      void this.flushPendingResourceRegistrations()
    }, delay)
  }

  private schedulePendingViewManagerRetry(): void {
    if (this.viewManagerRetryTimer) return
    if (this.viewManagerRetryCount >= ViewFactory.MAX_REGISTRATION_RETRIES) {
      this.log(
        '[ViewFactory] ⛔ WebContentsViewManager 重试已达上限，放弃注册:',
        Array.from(this.pendingViewManagerRegistrations.keys()),
      )
      this.pendingViewManagerRegistrations.clear()
      this.viewManagerRetryCount = 0
      return
    }
    const delay = ViewFactory.BASE_RETRY_INTERVAL_MS * Math.pow(2, Math.min(this.viewManagerRetryCount, 5))
    this.viewManagerRetryCount++
    this.viewManagerRetryTimer = setTimeout(() => {
      this.viewManagerRetryTimer = undefined
      void this.flushPendingViewManagerRegistrations()
    }, delay)
  }

  private getRegCtx(): subsysReg.RegistrationContext {
    return {
      views: this.views,
      pendingResourceRegistrations: this.pendingResourceRegistrations,
      pendingViewManagerRegistrations: this.pendingViewManagerRegistrations,
      getResourceManager: externalHandlers.getResourceManager ? (() => externalHandlers.getResourceManager!() ?? null) : undefined,
      getViewManager: externalHandlers.getViewManager ? (() => externalHandlers.getViewManager!() ?? null) : undefined,
      getViewStateRegistry: () => getViewStateRegistry(),
      profileToMode: this.profileToMode,
      setRegistrationState: this.setRegistrationState.bind(this),
      schedulePendingResourceRetry: () => this.schedulePendingResourceRetry(),
      schedulePendingViewManagerRetry: () => this.schedulePendingViewManagerRetry(),
      log: this.log.bind(this),
    }
  }

  /**
   * 关联到任务：建立 taskId → viewId 的索引，并通知外部监听者
   */
  private attachToTask(viewId: string, taskId: string): void {
    this.log('[ViewFactory] 关联到任务:', { viewId, taskId });
    const viewSet = this.taskViewIndex.get(taskId) ?? new Set<string>();
    viewSet.add(viewId);
    this.taskViewIndex.set(taskId, viewSet);
    this.emit('view:task-attached', { id: viewId, taskId });
  }

  /**
   * 查询与指定 taskId 关联的所有 View ID
   */
  public getViewIdsByTaskId(taskId: string): string[] {
    return Array.from(this.taskViewIndex.get(taskId) ?? []);
  }

  private async destroyWebContents(view: WebContentsView, state?: ViewEntry): Promise<void> {
    await destroyWebContentsFn(view, state, this.log.bind(this));
  }

  private async closeBrowserForView(id: string): Promise<void> {
    await closeBrowserForViewFn(id, externalHandlers as LifecycleExternalHandlers, this.log.bind(this));
  }

  /**
   * Profile 转换为 ViewStateRegistry 的 mode
   */
  private profileToMode(profile: string): 'preview' | 'task' | 'background' | 'unknown' {
    switch (profile) {
      case 'user-tab':
      case 'temporary-preview':
        return 'preview';
      case 'agent-workspace':
        return 'task';
      case 'background-task':
        return 'background';
      default:
        return 'unknown';
    }
  }

  /** 配额计数：排除 discarded 条目，只计入实际占用资源的 View */
  private getActiveViewCount(): number {
    let count = 0
    for (const entry of this.views.values()) {
      if (!entry.discarded) count++
    }
    return count
  }

  /**
   *  配额用量 = 活跃 View 数 + 尚未落表的占坑数。
   * 占坑计入用量，才能保证并发创建不同 id 时不超发（占坑期间的并发读到彼此）。
   */
  private getQuotaUsage(): number {
    return this.getActiveViewCount() + this._quotaReservations.size
  }

  /**
   * 同步「配额判定 + 占坑」。判定 `allow` 时把 id 加入占坑集合并返回 `allow`。
   * 全程无 await，借单线程原子性保证判定到占坑之间不被并发创建插入（AA-008）。
   */
  private tryReserveQuotaSync(finalConfig: ReturnType<typeof mergeProfileConfig>): QuotaDecision {
    const decision = evaluateViewQuota(
      this.getQuotaUsage(),
      finalConfig,
      getRunSessionManager(),
      this.options.maxViews,
    )
    if (decision.decision === 'allow') {
      this._quotaReservations.add(finalConfig.id)
    }
    return decision
  }

  /**
   * 配额占坑，失败抛错。快路径同步占坑；命中兜底上限（needCleanup）或全局硬限 reject 时进冷路径窄锁，
   * 驱逐空闲 View 后复检占坑。窄锁内**不 await 建实例**，故不串行化并发创建的慢活。
   */
  private async reserveQuotaOrThrow(finalConfig: ReturnType<typeof mergeProfileConfig>): Promise<void> {
    const first = this.tryReserveQuotaSync(finalConfig)
    if (first.decision === 'allow') return

    const shouldCleanup =
      first.decision === 'needCleanup' ||
      (first.decision === 'reject' && isGlobalViewQuotaReject(first.reason))

    if (!shouldCleanup) {
      this.log('[ViewFactory] 配额检查失败:', { id: finalConfig.id, reason: first.reason })
      throw new Error(first.reason)
    }

    this.log('[ViewFactory] 配额达限，尝试紧急腾位...', {
      id: finalConfig.id,
      decision: first.decision,
    })
    const release = await this._quotaCleanupMutex.acquire(30_000)
    try {
      await forceCleanupForQuota(this.getCleanupCtx(), {
        allowedProfiles: [...QUOTA_RECLAIM_PROFILES],
      })
      const retry = this.tryReserveQuotaSync(finalConfig)
      if (retry.decision === 'allow') return
      const reason =
        retry.decision === 'reject'
          ? retry.reason
          : `View 数量已达上限: ${this.options.maxViews}`
      throw new Error(reason)
    } finally {
      release()
    }
  }

  private async cleanupIdleViews(): Promise<void> {
    await runIdleCleanup(this.getCleanupCtx());
    this.purgeStaleCrashHistory();
  }

  /** 清理超过 10 分钟的 URL 级崩溃历史，防止 Map 无限膨胀 */
  private purgeStaleCrashHistory(): void {
    const TTL = 10 * 60_000
    const now = Date.now()
    for (const [url, timestamps] of this.crashHistory) {
      const recent = timestamps.filter(t => now - t < TTL)
      if (recent.length === 0) {
        this.crashHistory.delete(url)
      } else {
        this.crashHistory.set(url, recent)
      }
    }
  }

  /**
   * 🆕 手动触发清理（公共接口）
   *
   * 外部调用此方法可以立即触发一次清理，清理：
   * 1. 超时的空闲 View
   * 2. 超过 LRU 上限的预览 View
   *
   * @returns 清理结果统计
   */
  public async triggerCleanup(): Promise<{ cleaned: number; message: string }> {
    this.log('[ViewFactory] 🧹 手动触发清理');
    const beforeCount = this.views.size;

    await this.cleanupIdleViews();

    const afterCount = this.views.size;
    const cleaned = beforeCount - afterCount;

    const message = cleaned > 0
      ? `清理了 ${cleaned} 个 View`
      : '没有需要清理的 View';

    this.log('[ViewFactory] ✅ 清理完成:', message);

    return { cleaned, message };
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = startCleanupTimerFn(
      () => this.cleanupIdleViews(),
      this.log.bind(this),
    );
  }

  private attachViewStateRegistryBridge(): void {
    if (this.viewStateRegistryBridgeAttached) return;
    this.viewStateRegistryBridgeAttached = true;
    const registry = getViewStateRegistry();
    registry.on('view:updated', this.handleViewStateUpdated);
  }

  private handleViewStateUpdated = (payload: {
    id: string;
    state: RegistryViewState;
    updates: Partial<RegistryViewState>;
  }): void => {
    stateSync.handleViewStateUpdated(payload, this.views);
  };

  /**
   * 启动注册一致性校验定时器
   */
  private startRegistrationReconcileTimer(): void {
    if (this.registrationReconcileTimer) return;
    this.registrationReconcileTimer = setInterval(() => {
      void this.reconcileSubsystemRegistrations('timer');
    }, 90_000);
  }

  private buildWorkspaceViewMeta(
    config: Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> & Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>,
    createdAt: number,
  ) {
    let title = config.metadata?.title || '新标签';
    if (config.url) { try { title = new URL(config.url).hostname; } catch { title = config.url || title; } }
    return {
      title, url: config.url || '', favicon: config.metadata?.favicon,
      runId: config.runId || undefined, isPreview: config.metadata?.isPreview === true, createdAt,
    };
  }

  private getDelegatesDeps(): DelegatesDeps {
    return {
      log: this.log.bind(this),
      setRegistrationState: this.setRegistrationState.bind(this),
      destroyView: (id, opts) => this.destroyView(id, opts),
      registerToViewStateRegistry: (id, webContents, config, inUse) => this.registerToViewStateRegistry(id, webContents, config, inUse),
      registerToWebContentsViewManager: (id, view) => this.registerToWebContentsViewManager(id, view),
      registerToResourceManager: (id, config) => this.registerToResourceManager(id, config),
      unregisterFromViewStateRegistry: (id) => this.unregisterFromViewStateRegistry(id),
      unregisterFromWebContentsViewManager: (id) => this.unregisterFromWebContentsViewManager(id),
      unregisterFromResourceManager: (id) => this.unregisterFromResourceManager(id),
      getRunSessionManager: () => getRunSessionManager(),
      getOrganizationTabManager: () => getOrganizationTabManager(),
      getCrawlspaceContextHub: () => getCrawlspaceContextHub(),
      getResourceDetectionService: () => getResourceDetectionService(),
      getViewPageRegistry: () => null,
      getExternalViewManager: () => externalHandlers.getViewManager?.() ?? null,
      getExternalResourceManager: () => externalHandlers.getResourceManager?.() ?? null,
      viewStateRegistryHasView: (id) => getViewStateRegistry().hasView(id),
      buildWorkspaceViewMeta: (config, createdAt) => this.buildWorkspaceViewMeta(config, createdAt),
      getViewInUse: (id) => this.getViewInUse(id),
    };
  }

  private ensureRegistrationState(id: string): ViewRegistrationStatus {
    const entry = this.views.get(id);
    if (!entry) return {};
    if (!entry.registrations) {
      entry.registrations = {};
    }
    return entry.registrations;
  }

  private setRegistrationState(id: string, key: keyof ViewRegistrationStatus, value: boolean): void {
    const registrations = this.ensureRegistrationState(id);
    registrations[key] = value;
  }

  private async reconcileSubsystemRegistrations(reason: 'timer' | 'manual'): Promise<void> {
    if (this.views.size === 0) return;
    const activeStates = Array.from(this.views.values()).filter(
      state => !this.destroyingViewIds.has(state.id) && !state.discarded
    );
    await this.registrationCoordinator.reconcileAll(activeStates, reason);
  }

  /**
   * 日志输出
   */
  private log(...args: any[]): void {
    if (this.options.verbose) {
      // 走 createLogger.debug：统一模块前缀；ELECTRON_VERBOSE 时输出到 dev console，
      // 打包版不刷屏（高价值的创建/销毁/崩溃事件在各自点位用 info/warn/error 显式落 main.log）。
      moduleLog.debug(...args);
    }
  }

  // Anti-detect / display / resource-interception 已提取到同名子模块

  /**
   * 销毁所有 View
   *
   * @param options 销毁选项
   */
  public async destroyAllViews(options?: DestroyViewOptions): Promise<void> {
    this.log('[ViewFactory] 销毁所有 View...');

    const viewIds = Array.from(this.views.keys());
    for (const id of viewIds) {
      try {
        await this.destroyView(id, options || { force: true });
      } catch (error) {
        this.log('[ViewFactory] 销毁 View 失败:', id, error);
      }
    }

    this.log('[ViewFactory] ✅ 所有 View 已销毁');
  }

  /**
   * 关闭 ViewFactory
   */
  public async shutdown(): Promise<void> {
    this.log('[ViewFactory] 关闭...');

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    if (this.registrationReconcileTimer) {
      clearInterval(this.registrationReconcileTimer);
      this.registrationReconcileTimer = undefined;
    }
    if (this.resourceRetryTimer) {
      clearTimeout(this.resourceRetryTimer);
      this.resourceRetryTimer = undefined;
    }
    if (this.viewManagerRetryTimer) {
      clearTimeout(this.viewManagerRetryTimer);
      this.viewManagerRetryTimer = undefined;
    }
    if (this.viewStateRegistryBridgeAttached) {
      const registry = getViewStateRegistry();
      registry.off('view:updated', this.handleViewStateUpdated);
      this.viewStateRegistryBridgeAttached = false;
    }

    // ✅ 清理指纹 Preload Script 设置
    await this.cleanupFingerprintPreload();

    // 销毁所有 View
    await this.destroyAllViews({ force: true });

    this.removeAllListeners();

    // 重置单例，允许测试环境和应用重启场景重新初始化
    ViewFactory.instance = null;

    this.log('[ViewFactory] 已关闭');
  }

  private async cleanupFingerprintPreload(): Promise<void> {
    await cleanupPreloadFn(this.sessionPreloadRegistry, this.log.bind(this));
  }

  /**
   * 🆕 外部触发：立即重试所有待注册项（Resource/CDP）
   */
  public async flushPendingRegistrations(): Promise<void> {
    await this.flushPendingResourceRegistrations();
    await this.flushPendingViewManagerRegistrations();
  }
}

let syncViewInUseConfigured = false

function ensureSyncViewInUseConfigured(): void {
  if (syncViewInUseConfigured) return
  configureSyncViewInUse({
    getHub: () => getCrawlspaceContextHub(),
    getViewFactory: () => ViewFactory.getInstance(),
    getRuntimeViewActive: (viewId) => {
      const runSessionManager = getRunSessionManager()
      const runId = runSessionManager.getRunIdByView(viewId)
      if (!runId) return undefined
      return runSessionManager.getRun(runId)?.activeViewId === viewId
    },
  })
  syncViewInUseConfigured = true
}

/**
 * 获取 ViewFactory 单例实例
 */
export function getViewFactory(options?: ViewFactoryOptions): ViewFactory {
  const factory = ViewFactory.getInstance(options);
  ensureSyncViewInUseConfigured();
  return factory;
}
