/**
 * ViewHost — 内嵌浏览器容器抽象接缝（webview 迁移 Phase 1，）
 *
 * 把「guest 页面容器」的生命周期与宿主挂载操作收敛为一个容器无关接口：
 * - WebContentsView 实现（Phase 1）：ViewManager（contentView.addChildView / removeChildView）
 * - <webview> tag 实现（Phase 2）：WebviewTagHost（渲染进程挂载，主进程经 IPC 驱动）
 *
 * 设计约束：
 * 1. 接口面只出现 Electron 通用类型（WebContents / Rectangle），
 *    不出现 WebContentsView / BrowserWindow 等具体容器概念。
 * 2. 服务层（反检测 / 资源拦截 / 资源检测 / Cookie / 清理 / 探测等）
 *    一律通过 GuestHandle.webContents 或 getWebContents(id) 工作，不触碰容器对象。
 */

import type { WebContents, Rectangle } from 'electron';
import type { CreateViewConfig } from '../types/view.js';

/**
 * Guest 页面句柄 — 容器无关的最小引用。
 *
 * 只暴露 id + webContents；容器对象（WebContentsView / <webview> element）
 * 留在各 ViewHost 实现内部，不外泄。
 */
export interface GuestHandle {
  /** Guest 唯一标识（与 ViewFactory viewId 同一命名空间） */
  readonly id: string;
  /** 页面的 WebContents（WCV 与 <webview> tag 均具备） */
  readonly webContents: WebContents;
}

/**
 * Guest 创建配置 — 与 CreateViewConfig 同构，但 id 由第一个参数显式传入。
 *
 * ⚠️ Phase 2 适配债标注：`webPreferences` 目前是 WebContentsView 形状的全量
 * `Partial<WebPreferences>`，其中只有一小部分是跨容器契约（`partition` /
 * `sandbox` / `contextIsolation` / `preload` 等 <webview> tag 也支持的字段）；
 * 其余选项对 <webview> 实现可能不可直传（webview 走 `webpreferences` attribute
 * 字符串且支持子集不同）。WebviewTagHost 落地前应把本类型收窄为明确枚举的
 * 最小字段集，或在实现内做映射并对不支持的字段显式告警。
 */
export type CreateGuestConfig = Omit<CreateViewConfig, 'id'>;

/**
 * ViewHost — 容器操作接口。
 *
 * 方法语义（以 WebContentsView 实现为参照）：
 * - createGuest: 创建 guest 容器实例（WCV: new WebContentsView；同 id 重复创建返回既有实例）
 * - attach:      挂载到宿主使其可见（WCV: mainWindow.contentView.addChildView，含已挂载去重）
 * - detach:      从宿主移除使其不可见，不销毁（WCV: contentView.removeChildView）
 * - setBounds:   设置容器边界
 * - destroy:     销毁容器与底层页面（WCV: removeChildView + webContents.destroy）
 * - getWebContents: 取 guest 页面的 WebContents（不存在返回 null）
 * - isAttached:  当前是否挂载在宿主上
 */
export interface ViewHost {
  createGuest(id: string, cfg: CreateGuestConfig): Promise<GuestHandle>;
  attach(id: string): void;
  detach(id: string): void;
  setBounds(id: string, rect: Rectangle): void;
  destroy(id: string): void;
  getWebContents(id: string): WebContents | null;
  isAttached(id: string): boolean;
}
