/**
 * fs:watch IPC 共享类型——main / preload / renderer 三方对齐的事件 payload。
 *
 * 单源管理（修 review #F"类型重复"）：
 *   - 旧版 main 端 dispatch 时手写 payload object literal、preload 在 onWatchEvent
 *     的 callback 类型里写一份、renderer hook (FolderWatchEvent) 又写一份——
 *     三处同构但分散，未来加字段时可能漏改。
 *   - 新方案：本文件 + `FsWatchEvent` 即唯一权威，三方都 import。
 *
 * 字段语义见每个字段的 jsdoc。**dirPath 字段已废弃，改名 parentDir**——
 * 旧名容易让人误以为它是"被监听的根目录"，实际是"实际变化文件的父目录"，
 * 命名层面就要把这个语义说清楚（修 review #F 的"隐式契约"问题）。
 */

export interface FsWatchEvent {
  /** 由 fs:watch 启动时返的 watchId，前端可用于多 watcher 共存时按根筛选事件 */
  watchId: string

  /**
   * 实际变化文件的**父目录**绝对路径。
   *
   * - 常规变化：`/tmp/proj/src/components` 这种实际父目录
   * - OS 队列溢出（isGlobal=true）：退化为 rootPath
   *
   * 前端按这个判断要不要重读已展开的某个目录。**重要**：旧版 dirPath 永远 =
   * watch 根目录，子目录变化时前端会"以为根变了"导致 UX 混乱（要么不刷新
   * 要么过度刷新）。新版语义收敛为"实际父目录"。
   */
  parentDir: string

  /** 监听根目录绝对路径——前端可用于按 watchId/根筛选事件（多 watcher 防窜） */
  rootPath: string

  /** Node fs.watch 给的 eventType（'rename' / 'change'），透传不解释 */
  eventType: string

  /**
   * 实际变化文件的绝对路径——OS 队列溢出（isGlobal=true）时为 undefined。
   *
   * recursive 模式下 main 端用 `path.join(rootPath, filename)` 计算。
   */
  fullPath?: string

  /**
   * OS 文件系统事件队列溢出标志。
   *
   * - macOS FSEvents `kFSEventStreamEventFlagMustScanSubDirs`
   * - Linux inotify `IN_Q_OVERFLOW`
   *
   * true 时 main 端拿不到具体变化路径（filename 为空），fullPath 必为
   * undefined、parentDir 退化为 rootPath。**前端必须把 cache 里所有已展开
   * 目录都重读**——只刷 parentDir（=rootPath）会漏深层子目录变化。
   *
   * 触发场景：`pnpm install` / `git checkout` 大批量文件变化、外接盘 unmount
   * 期间事件累积。
   */
  isGlobal: boolean

  /**
   * 监听根已丢失（目录被删/改名/移走，或 watcher error）。
   *
   * true 时前端应进入「根不可达」失效态并 unwatch，**不要**再按普通
   * rename 去重读旧 rootPath（会 ENOENT 静默空白）。
   */
  isRootLost?: boolean
}

/**
 * `useFolderWatch` hook 给上层 caller 的事件——结构与 `FsWatchEvent` 完全
 * 一致，但用独立类型名让 hook 文档更聚焦。本质是 alias，未来如有需要可以
 * 在 hook 层加 caller 友好字段而不影响 IPC 契约。
 */
export type FolderWatchEvent = FsWatchEvent
