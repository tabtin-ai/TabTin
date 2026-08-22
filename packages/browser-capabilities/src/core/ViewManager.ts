/**
 * ViewManager - 基于 Min 浏览器的 viewManager 设计
 *
 * 核心职责：
 * - 创建和销毁 WebContentsView
 * - 管理 View 的显示和隐藏
 * - 提供基础的 View 操作 API
 *
 * 设计原则：
 * 1. 同步创建，异步加载（不阻塞）
 * 2. 防闪烁优化（只在必要时操作 DOM）
 * 3. 简洁的状态管理
 * 4. 不包含业务逻辑
 *
 * 参考：Min Browser - viewManager.js
 */

import { WebContentsView, BrowserWindow, WebPreferences, Rectangle, WebContents } from 'electron';
import type { ViewState, CreateViewConfig } from '../types/view.js';
import type { ViewHost, GuestHandle, CreateGuestConfig } from './ViewHost.js';
import { t } from '../i18n.js';

/**
 * ViewManager - 轻量级 View 管理器
 *
 * : 同时作为 ViewHost 的 WebContentsView 实现（WebContentsViewHost）。
 * ViewHost 接口方法是既有方法的别名/薄封装，不改变任何运行时行为。
 */
/** Optional pre-loadURL gate. Return false to skip webContents.loadURL. */
export type UrlLoadGuard = (url: string, id: string) => boolean;

export class ViewManager implements ViewHost {
  /** View 映射表 */
  private viewMap = new Map<string, WebContentsView>();

  /** View 状态映射表 */
  private viewStateMap = new Map<string, ViewState>();

  /** 主窗口引用 */
  private mainWindow: BrowserWindow | null = null;

  /** Injected by host (e.g. Preview Guard); ViewManager stays free of product rules. */
  private urlLoadGuard: UrlLoadGuard | null = null;

  /** 日志前缀 */
  private readonly logPrefix = '[ViewManager]';

  constructor(mainWindow?: BrowserWindow) {
    this.mainWindow = mainWindow || null;
  }

  /**
   * 设置主窗口（用于显示 View）
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
    this.log('主窗口已设置');
  }

  /**
   * Install a loadURL gate (Preview Guard etc.). Pass null to clear.
   */
  setUrlLoadGuard(guard: UrlLoadGuard | null): void {
    this.urlLoadGuard = guard;
  }

  /**
   * 创建 View
   *
   * Min 的设计：**同步创建，异步加载**
   * - View 实例立即创建并返回
   * - URL 加载不阻塞创建过程
   * - 性能优异（平均 1ms 创建）
   */
  createView(config: CreateViewConfig): WebContentsView {
    const { id, webPreferences = {}, bounds, url } = config;

    // 检查重复创建
    if (this.viewMap.has(id)) {
      this.log('⚠️  View 已存在，返回现有实例:', id);
      return this.viewMap.get(id)!;
    }

    // 合并默认配置
    const finalPrefs: WebPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      enableWebSQL: false,
      ...webPreferences,
    };

    // 创建 WebContentsView
    const view = new WebContentsView({
      webPreferences: finalPrefs,
    });

    // 设置边界
    if (bounds) {
      view.setBounds(bounds);
    }

    // 初始化状态
    this.viewStateMap.set(id, {
      loadedInitialURL: false,
    });

    // 保存 View
    this.viewMap.set(id, view);

    this.log('✅ View 已创建:', id);

    // 🚀 异步加载 URL（不阻塞）
    if (url) {
      this.loadURL(id, url);
    }

    return view;
  }

  /**
   * 销毁 View
   *
   * 遵循 Min Browser 的设计：
   * 1. 从主窗口移除
   * 2. 销毁 webContents
   * 3. 清理映射
   */
  destroyView(id: string): void {
    const view = this.viewMap.get(id);
    if (!view) {
      this.log('⚠️  View 不存在，无法销毁:', id);
      return;
    }

    // 1. 从主窗口移除（仅当 view 仍在 children 中时）
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const contentView = this.mainWindow.contentView;
      if (contentView.children.includes(view)) {
        contentView.removeChildView(view);
      }
    }

    // 2. 销毁 webContents（Min Browser 的核心设计）
    // 注意：webContents.destroy() 在运行时存在，但 TypeScript 类型定义可能不完整
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (view.webContents as any).destroy();

    // 3. 清理映射
    this.viewMap.delete(id);
    this.viewStateMap.delete(id);

    this.log('✅ View 已销毁:', id);
  }

  /**
   * 销毁所有 View
   */
  destroyAllViews(): void {
    this.log('🗑️  销毁所有 View...');
    const ids = Array.from(this.viewMap.keys());
    ids.forEach(id => this.destroyView(id));
    this.log('✅ 所有 View 已销毁');
  }

  /**
   * 获取 View
   */
  getView(id: string): WebContentsView | undefined {
    return this.viewMap.get(id);
  }

  /**
   * 检查 View 是否存在
   */
  hasView(id: string): boolean {
    return this.viewMap.has(id);
  }

  /**
   * 显示 View（添加到主窗口）
   *
   * Min 的防闪烁优化：
   * - 只在 View 真正改变时才操作 DOM
   * - 避免不必要的 addChildView/removeChildView
   */
  showView(id: string): void {
    const view = this.viewMap.get(id);
    if (!view) {
      throw new Error(t('errors.viewManager.viewNotFound', { id }));
    }

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      throw new Error(t('errors.viewManager.mainWindowUnavailable'));
    }

    // 检查是否已经显示
    const contentView = this.mainWindow.contentView;
    if (contentView.children.includes(view)) {
      this.log('View 已显示，跳过:', id);
      return;
    }

    // 添加到主窗口
    contentView.addChildView(view);
    this.log('✅ View 已显示:', id);
  }

  /**
   * 隐藏 View（从主窗口移除）
   */
  hideView(id: string): void {
    const view = this.viewMap.get(id);
    if (!view) {
      this.log('⚠️  View 不存在，无法隐藏:', id);
      return;
    }

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.log('⚠️  主窗口不可用，无法隐藏 View');
      return;
    }

    try {
      this.mainWindow.contentView.removeChildView(view);
      this.log('✅ View 已隐藏:', id);
    } catch (error) {
      this.log('⚠️  隐藏 View 失败:', error);
    }
  }

  /**
   * 设置 View 边界
   */
  setBounds(id: string, bounds: Rectangle): void {
    const view = this.viewMap.get(id);
    if (!view) {
      throw new Error(t('errors.viewManager.viewNotFound', { id }));
    }

    view.setBounds(bounds);
  }

  /**
   * 加载 URL
   *
   * Min 的设计：
   * - 首次加载时，在 dom-ready 后设置背景色
   * - 异步加载，不阻塞
   */
  loadURL(id: string, url: string): void {
    const view = this.viewMap.get(id);
    if (!view) {
      throw new Error(t('errors.viewManager.viewNotFound', { id }));
    }

    const state = this.viewStateMap.get(id);
    if (!state) {
      throw new Error(t('errors.viewManager.viewStateNotFound', { id }));
    }

    if (this.urlLoadGuard && !this.urlLoadGuard(url, id)) {
      this.log('🚫 URL load blocked by guard:', url);
      return;
    }

    // 首次加载：使用透明背景，避免在暗色模式下强制白底闪烁
    if (!state.loadedInitialURL) {
      view.webContents.once('dom-ready', () => {
        view.setBackgroundColor('#00000000');
      });

      state.loadedInitialURL = true;
    }

    // 🚀 异步加载 URL
    view.webContents.loadURL(url).catch((error) => {
      // 🆕 忽略主动停止（ERR_ABORTED, errno: -3）的错误
      if (error.code !== 'ERR_ABORTED' && error.errno !== -3) {
        this.log('❌ URL 加载失败:', url, error);
      } else {
        this.log('ℹ️  URL 加载被主动停止（忽略）:', url);
      }
    });

    this.log('🔄 开始加载 URL:', url);
  }

  /**
   * 调用 WebContents 方法
   *
   * 支持同步和异步方法
   */
  async callViewMethod<T = any>(
    id: string,
    method: string,
    args: any[] = []
  ): Promise<T> {
    const view = this.viewMap.get(id);
    if (!view) {
      throw new Error(t('errors.viewManager.viewNotFound', { id }));
    }

    const webContents = view.webContents;
    const methodOrProp = (webContents as any)[method];

    if (typeof methodOrProp === 'function') {
      // 调用方法
      return methodOrProp.apply(webContents, args);
    } else {
      // 读取属性
      return methodOrProp;
    }
  }

  /**
   * 获取所有 View ID
   */
  getAllViewIds(): string[] {
    return Array.from(this.viewMap.keys());
  }

  /**
   * 获取 View 数量
   */
  getViewCount(): number {
    return this.viewMap.size;
  }

  /**
   * 获取 View 状态
   */
  getViewState(id: string): ViewState | undefined {
    return this.viewStateMap.get(id);
  }

  // ==========================================================================
  // ViewHost 接口实现（ webview 迁移接缝）
  //
  // 全部为既有方法的别名/薄封装：调用时序、去重、防闪烁逻辑与旧方法一致。
  // ==========================================================================

  /**
   * ViewHost.createGuest — 等价于 createView（同步创建，异步加载）。
   *
   * 接口签名为 Promise 以兼容 Phase 2 的 WebviewTagHost（跨进程创建必然异步）；
   * WCV 实现同步完成后立即 resolve。
   */
  async createGuest(id: string, cfg: CreateGuestConfig): Promise<GuestHandle> {
    const view = this.createView({ ...cfg, id });
    return { id, webContents: view.webContents };
  }

  /** ViewHost.attach — 等价于 showView（含已挂载去重） */
  attach(id: string): void {
    this.showView(id);
  }

  /** ViewHost.detach — 等价于 hideView（移除但不销毁） */
  detach(id: string): void {
    this.hideView(id);
  }

  /** ViewHost.destroy — 等价于 destroyView */
  destroy(id: string): void {
    this.destroyView(id);
  }

  /** ViewHost.getWebContents — 取 guest 页面的 WebContents */
  getWebContents(id: string): WebContents | null {
    return this.viewMap.get(id)?.webContents ?? null;
  }

  /** ViewHost.isAttached — 是否已挂载到主窗口 contentView */
  isAttached(id: string): boolean {
    const view = this.viewMap.get(id);
    if (!view) {
      return false;
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }
    return this.mainWindow.contentView.children.includes(view);
  }

  /**
   * 日志输出
   */
  private log(...args: any[]): void {
    console.log(this.logPrefix, ...args);
  }
}

/**
 * 全局单例（可选）
 */
let globalInstance: ViewManager | null = null;

export function getViewManager(mainWindow?: BrowserWindow): ViewManager {
  if (!globalInstance) {
    globalInstance = new ViewManager(mainWindow);
  }
  return globalInstance;
}
