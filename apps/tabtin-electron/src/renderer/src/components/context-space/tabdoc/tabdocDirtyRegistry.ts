/**
 * TabDoc 未保存状态注册表
 *
 * 用途：beforeClose 关闭确认需要查询某个 documentId 当前是否有未保存改动，
 * 但 `tabdoc-runtime-monitor` 是全局单 owner（最高活跃度的 host）的 snapshot
 * 设计，不能用作"按 documentId 精准查询"——同时打开两个文档时，
 * 关闭非 active 的那个会拿到错误的 owner snapshot。
 *
 * 本注册表与 monitor 解耦，每个 TabdocPanelApp 实例 mount 时注册一个
 * **同步**的 dirty 采样函数 + **异步**的 save 触发函数：
 *   - 采样函数读取 useDocEditor 的 React state 与 autoSaveController.isDirty()，
 *     避免 monitor 3s 周期采样的窗口期问题
 *   - save 函数调用 manualSave()，beforeClose "保存并关闭"分支用
 *
 * unmount 时自动注销。如果同一 documentId 出现在多个 pane（分屏），
 * 注册时会覆盖 —— 这是有意为之，因为底层 store 共享，最后注册的拿到的
 * controller 引用同样可用。
 *
 * W2.5 T9 扩展：
 * - 注册时携带 spaceId，使 collectAllDirty 可以按 space 过滤（Space 删除场景需要）
 * - 暴露 collectAllDirty 列出所有"需要确认"的 dirty 文档，供退出 / Space 删除路径聚合判断
 */
import type { SaveState } from '@tabtin/tabdoc-ui/use-doc-editor'

export interface TabDocDirtySnapshot {
  /** 编辑器的保存状态，'dirty' / 'saving' / 'error' 视为有未保存内容 */
  saveState: SaveState
  /** autoSaveController.isDirty() —— 内容相对于服务端 baseVersion 是否有未提交差异 */
  isDirty: boolean
  /** 是否在协作模式（仅作信息展示用，不影响 dirty 判定） */
  isCollaborating: boolean
  /** 文档标题，对话框文案使用 */
  title: string | null
}

export type TabDocDirtySource = () => TabDocDirtySnapshot

/**
 * 触发该文档的手动保存。返回 true 表示保存成功，false 表示失败。
 * beforeClose 在用户选择"保存并关闭"时调用；调用方应负责异常处理。
 */
export type TabDocSaver = () => Promise<boolean>

/**
 * 单条 dirty 资源摘要 —— 由 collectAllDirty / collectAllDirtyForSpace 返回。
 * 字段语义稳定，可被聚合层（dirtyRegistry）转换为通用 DirtyResource。
 */
export interface TabDocDirtyEntrySummary {
  documentId: string
  /** 注册时挂的 spaceId；可能为 null（注册侧未提供，例如调试场景） */
  spaceId: string | null
  /** 当时采样的标题；空字符串表示未命名 */
  title: string
  /** 同 snapshot.saveState，方便上层 UI 显示"有冲突 / 保存中"等差异化文案 */
  saveState: SaveState
  /** 是否在协作模式 —— 影响"放弃修改"的副文案 */
  isCollaborating: boolean
}

interface TabDocRegistryEntry {
  source: TabDocDirtySource
  save: TabDocSaver
  spaceId: string | null
}

const entries = new Map<string, TabDocRegistryEntry>()

/**
 * dirty 状态变化的订阅机制（Wave 3 T6 新增）。
 *
 * 用途：tab 标签条上需要实时显示 dirty 指示符（小圆点 / 旋转 / 错误色），
 * 而 dirty snapshot 是同步采样的，监听者无法被动感知"采样结果变了"。
 * 因此引入轻量 EventEmitter：
 *   - register / unregister 时自动 emit（→ 标签首次出现 / 卸载时立刻同步指示符）
 *   - TabdocPanelApp 在 saveState/isDirty/title 变化时主动调 `notifyTabDocDirty`
 *
 * 失败容忍：listener 抛错只 warn 不影响其他订阅者。
 */
type DirtyListener = (snapshot: TabDocDirtySnapshot | null) => void
const listeners = new Map<string, Set<DirtyListener>>()

function emitDirtyChange(documentId: string): void {
  if (!documentId) return
  const set = listeners.get(documentId)
  if (!set || set.size === 0) return
  const snapshot = getTabDocDirtySnapshot(documentId)
  set.forEach(listener => {
    try {
      listener(snapshot)
    } catch (err) {
      console.warn('[tabdocDirtyRegistry] listener threw, continuing:', err)
    }
  })
}

export function registerTabDocDirtySource(
  documentId: string,
  source: TabDocDirtySource,
  save: TabDocSaver,
  spaceId: string | null = null,
): () => void {
  if (!documentId) {
    return () => {}
  }
  const entry: TabDocRegistryEntry = { source, save, spaceId }
  entries.set(documentId, entry)
  emitDirtyChange(documentId)
  return () => {
    if (entries.get(documentId) === entry) {
      entries.delete(documentId)
      emitDirtyChange(documentId)
    }
  }
}

/**
 * 订阅一个 documentId 的 dirty 状态变化。
 *
 * - listener 不会在订阅时立刻触发，请订阅方自行用 `getTabDocDirtySnapshot` 拿初始值
 * - 触发时机：register / unregister / `notifyTabDocDirty`
 * - 返回 unsubscribe 函数（幂等，重复调用安全）
 */
export function subscribeTabDocDirty(
  documentId: string,
  listener: DirtyListener,
): () => void {
  if (!documentId) return () => {}
  let set = listeners.get(documentId)
  if (!set) {
    set = new Set()
    listeners.set(documentId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(documentId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(documentId)
  }
}

/**
 * 由 dirty source 持有方（TabdocPanelApp）在自身 saveState/isDirty/title 变化后调用，
 * 通知所有订阅者重新采样并更新 UI（如标签条 dirty 指示符）。
 *
 * 没有订阅者时是 no-op（零成本订阅）。
 */
export function notifyTabDocDirty(documentId: string): void {
  emitDirtyChange(documentId)
}

export function getTabDocDirtySnapshot(documentId: string): TabDocDirtySnapshot | null {
  const entry = entries.get(documentId)
  if (!entry) return null
  try {
    return entry.source()
  } catch (err) {
    // W2 T5 三视角 Review 修复：已注册但采样失败时不能当作"无 dirty"放行，
    // 否则极端情况下会绕过保护静默关闭。返回保守 fallback snapshot：
    // saveState='error' + isDirty=true → shouldConfirmTabDocClose 返回 true → 强制弹窗。
    // "未注册"（null）与"采样失败"（fallback）两种情况由本函数负责区分。
    console.warn('[tabdocDirtyRegistry] dirty source threw, treating as needs-confirm:', err)
    return {
      saveState: 'error',
      isDirty: true,
      isCollaborating: false,
      title: null,
    }
  }
}

export async function saveTabDoc(documentId: string): Promise<boolean> {
  const entry = entries.get(documentId)
  if (!entry) return false
  try {
    return await entry.save()
  } catch (err) {
    console.warn('[tabdocDirtyRegistry] save invocation threw:', err)
    return false
  }
}

/**
 * 列出当前所有"需要保存确认"的 tabdoc。
 *
 * @param spaceId 可选过滤：只返回属于该 space 的 entries
 *   - 不传 → 返回全部（⌘Q 退出聚合用）
 *   - 传字符串 → 只返回 entry.spaceId === spaceId 的（Space 删除聚合用）
 *   - 注意：spaceId === null 注册的 entry **永远不会**被 spaceId 过滤命中，
 *     避免"未知归属"在删 space 场景误删（保守策略）
 *
 * 采样过程中若某个 entry source 抛错 → 走 getTabDocDirtySnapshot 的保守 fallback
 * （saveState='error' + isDirty=true），仍会被 shouldConfirmTabDocClose 判为需确认。
 */
export function collectAllDirty(spaceId?: string): TabDocDirtyEntrySummary[] {
  const result: TabDocDirtyEntrySummary[] = []
  entries.forEach((entry, documentId) => {
    if (spaceId !== undefined && entry.spaceId !== spaceId) {
      return
    }
    const snap = getTabDocDirtySnapshot(documentId)
    if (!shouldConfirmTabDocClose(snap)) return
    // shouldConfirmTabDocClose 保证 snap 非 null
    result.push({
      documentId,
      spaceId: entry.spaceId,
      title: snap!.title ?? '',
      saveState: snap!.saveState,
      isCollaborating: snap!.isCollaborating,
    })
  })
  return result
}

/** 测试 / 调试用 —— 当前已注册的 documentId 数量 */
export function _getTabDocDirtyRegistrySize(): number {
  return entries.size
}

/** 测试用 —— 清空注册表，避免跨用例污染 */
export function _resetTabDocDirtyRegistry(): void {
  entries.clear()
  listeners.clear()
}

/**
 * 判定一个 dirty snapshot 是否需要弹出确认对话框。
 * 抽出为纯函数，方便测试与 handler 复用。
 *
 * 规则：
 * - 'dirty' / 'saving' / 'error' → 需要确认
 * - 'idle' / 'saved' 但 controller.isDirty() 为 true → 需要确认
 *   （兜底：理论上不会发生，但万一 React state 与 controller 不同步时优先保护数据）
 * - 其他情况（含 snapshot=null）→ 直接放行
 */
export function shouldConfirmTabDocClose(snapshot: TabDocDirtySnapshot | null): boolean {
  if (!snapshot) return false
  if (snapshot.saveState === 'dirty' || snapshot.saveState === 'saving' || snapshot.saveState === 'error') {
    return true
  }
  if (snapshot.isDirty) return true
  return false
}
