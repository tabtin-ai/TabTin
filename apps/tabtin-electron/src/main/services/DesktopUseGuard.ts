/**
 * DesktopUseGuard — 桌面操控安全编排层
 *
 * 将 DesktopUseLock、紧急中止快捷键（macOS Cmd+Shift+Esc / 其他 Ctrl+Alt+Esc）、
 * OS 通知、审批对话框和 macOS 辅助功能权限检查统一编排。
 *
 * DesktopExecutorService 在执行操作前调用 acquire()，完成后调用 release()。
 */

import {
  dialog,
  globalShortcut,
  systemPreferences,
} from 'electron'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import * as DesktopUseLock from './DesktopUseLock'
import { notificationService } from './notification'
import { requestApproval } from './ApprovalManager'
import { approvalScopeCache } from './ApprovalScopeCache'
import { createLogger } from '../logger'
import { getMainWindow } from '../window-manager'
import { desktopAuditLogger, writeAuditLog } from './desktop-audit-logger'
import { DesktopErrorCode } from './desktop-error-codes'

const log = createLogger('DesktopUseGuard')

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export type GuardAcquireResult =
  | { readonly ok: true; readonly abortSignal: AbortSignal }
  | { readonly ok: false; readonly reason: string }

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

const ABORT_SHORTCUT = process.platform === 'darwin'
  ? 'Command+Shift+Escape'
  : 'Ctrl+Alt+Escape'

const ABORT_SHORTCUT_LABEL = process.platform === 'darwin'
  ? 'Cmd+Shift+Esc'
  : 'Ctrl+Alt+Esc'

let activeAbortController: AbortController | undefined
let activeSessionId: string | undefined
let abortShortcutRegistered = false
let desktopApprovedOnce = false

// ---------------------------------------------------------------------------
// 中止快捷键管理（macOS: Cmd+Shift+Esc，其他平台: Ctrl+Alt+Esc）
// ---------------------------------------------------------------------------

function registerAbortShortcut(controller: AbortController): void {
  if (abortShortcutRegistered) return

  const registered = globalShortcut.register(ABORT_SHORTCUT, () => {
    log.info(`用户按下 ${ABORT_SHORTCUT_LABEL}，中止桌面操控`)
    controller.abort()
    sendNotification('桌面操控已中止', `你按下了 ${ABORT_SHORTCUT_LABEL}，Agent 桌面操控已停止。`)
  })

  if (!registered) {
    log.warn(`${ABORT_SHORTCUT_LABEL} 快捷键注册失败（可能被其他应用占用）`)
    return
  }

  abortShortcutRegistered = true
  sendNotification(
    'TabTin 正在操控你的电脑',
    `按 ${ABORT_SHORTCUT_LABEL} 可随时停止 Agent 操控。`,
  )
}

function unregisterAbortShortcut(): void {
  if (!abortShortcutRegistered) return
  globalShortcut.unregister(ABORT_SHORTCUT)
  abortShortcutRegistered = false
}

// ---------------------------------------------------------------------------
// OS 通知
// ---------------------------------------------------------------------------

function sendNotification(title: string, body: string): void {
  try {
    notificationService.show({
      type: 'system.desktop_control',
      title,
      body,
      priority: 'normal',
    })
  } catch (err) {
    log.warn('发送通知失败:', err)
  }
}

// ---------------------------------------------------------------------------
// macOS 系统权限检查（桌面操控同时需要：辅助功能 + 屏幕录制）
// ---------------------------------------------------------------------------

export function checkAccessibilityPermission(): { granted: boolean } {
  if (process.platform !== 'darwin') {
    return { granted: true }
  }

  const granted = systemPreferences.isTrustedAccessibilityClient(false)
  if (!granted) {
    // 弹出系统引导对话框（传 true 会弹出系统偏好设置引导）
    systemPreferences.isTrustedAccessibilityClient(true)
    log.info('macOS 辅助功能权限未授予，已触发系统引导')
  }
  return { granted }
}

/**
 * 屏幕录制权限检查（仅 macOS 有效，其他平台默认 granted）。
 *
 * 与辅助功能合在 acquire 阶段一起预检：避免用户在审批弹窗里点了「允许」、
 * 业务流程开始后才发现 screenshot 拿到全黑图——那时再引导成本太高。
 */
export function checkScreenRecordingPermission(): {
  granted: boolean
  status: string
} {
  if (process.platform !== 'darwin') {
    return { granted: true, status: 'not-applicable' }
  }
  try {
    const status = systemPreferences.getMediaAccessStatus('screen')
    return { granted: status === 'granted', status }
  } catch (err) {
    log.warn('getMediaAccessStatus(screen) 失败:', err)
    return { granted: false, status: 'unknown' }
  }
}

// ---------------------------------------------------------------------------
// 审批 — 走统一 ApprovalManager（React UI + 超时 + 多语言 + Daemon 兼容）
// ---------------------------------------------------------------------------

/**
 * 请求桌面操控审批。
 *
 * 审计 sessionId 字段（hardening-round4.md #2 / Wave A0.4.续 落地）：
 * - granted/denied：走 acquire(sessionId) 链路注入；
 * - expired/clock_anomaly：来自 {@link loadPersistedApproval}，无 session 上下文，
 *   传 `sessionId: null`（与 desktop-audit-logger jsonl `sessionId?: string | null`
 *   schema 对齐）。
 *
 * 注：当前 4 个 approval 事件仍走 desktopAuditLogger.info()（v1.4 单事实源
 * 设计：Guard approval 事件刻意不进 ~/.tabtin/desktop-audit.jsonl，仅落到
 * console debug 给本地排障看）；本字段补全只让 console debug 输出含 sessionId，
 * 便于人工排障关联同一 session 的多条事件。完整意图（"与 Executor 审计交叉
 * 关联"）若要真正实现，需评估是否让 Guard approval 事件也走 writeAuditLog
 * 进 jsonl —— 这是设计变更，留给后续 Wave 决策（详 W A0.4.续 反思 §6）。
 */
async function requestDesktopApproval(sessionId: string): Promise<boolean> {
  // macOS: 桌面操控需要两个系统权限同时授予 —— 辅助功能（鼠标/键盘/AX 树）
  // + 屏幕录制（截屏）。任一缺失都在业务审批前一次性给出引导，避免
  // 「业务审批通过 → screenshot 黑图 → 再回头补权限」的二次中断。
  if (process.platform === 'darwin') {
    const accessibility = checkAccessibilityPermission()
    const screenRecording = checkScreenRecordingPermission()
    if (!accessibility.granted || !screenRecording.granted) {
      const mainWindow = getMainWindow()
      const missing: string[] = []
      if (!accessibility.granted) missing.push('辅助功能')
      if (!screenRecording.granted) missing.push('屏幕录制')
      const opts: Electron.MessageBoxOptions = {
        type: 'info',
        title: '需要系统权限',
        message: `TabTin 需要这些权限才能操控桌面：${missing.join('、')}`,
        detail:
          '请在系统设置 → 隐私与安全性 中允许 TabTin 访问以下项：\n' +
          missing.map((name) => `  • ${name}`).join('\n') +
          '\n\n授权后重新发起桌面操控请求即可。',
        buttons: ['知道了'],
      }
      if (mainWindow) {
        await dialog.showMessageBox(mainWindow, opts)
      } else {
        await dialog.showMessageBox(opts)
      }
      log.info(
        `桌面操控前预检未通过：missing=${missing.join(',')} screen-status=${screenRecording.status}`,
      )
      return false
    }
  }

  // If the user has already approved desktop control (this session or persisted),
  // skip the dialog. The user can revoke via Settings or by deleting the approval file.
  if (desktopApprovedOnce || loadPersistedApproval()) {
    desktopApprovedOnce = true
    return true
  }

  const { approved } = await requestApproval({
    actionType: 'desktop_control',
    detail: `截屏、鼠标点击、键盘输入、窗口管理。操控期间按 ${ABORT_SHORTCUT_LABEL} 可随时中止。`,
    mode: 'computer_use',
  })

  if (approved) {
    desktopApprovedOnce = true
    persistApproval()
    desktopAuditLogger.info(JSON.stringify({ action: 'approval_granted', sessionId, ts: Date.now() }))
  }

  if (!approved) {
    desktopAuditLogger.info(JSON.stringify({ action: 'approval_denied', sessionId, ts: Date.now() }))
  }

  return approved
}

// ---------------------------------------------------------------------------
// 审批持久化 — 跨 Electron 重启记住"允许桌面操控"
// ---------------------------------------------------------------------------

import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'

const APPROVAL_FILE = getHomeTabtinPath('desktop-approval.json')
const DEFAULT_APPROVAL_TTL_MS = 86_400_000 // 24 hours

function loadPersistedApproval(): boolean {
  try {
    const data = JSON.parse(readFileSync(APPROVAL_FILE, 'utf8'))
    if (data?.approved !== true) return false

    const grantedAt = new Date(data.grantedAt).getTime()
    const ttlMs = data.ttlMs ?? DEFAULT_APPROVAL_TTL_MS

    // 时钟倒退保护：grantedAt 在未来 → 视为异常
    if (grantedAt > Date.now()) {
      try { unlinkSync(APPROVAL_FILE) } catch {}
      // 持久化审批失效路径无 session 上下文（acquire 之外触发），sessionId: null
      // 与 desktop-audit-logger jsonl `sessionId?: string | null` schema 对齐
      desktopAuditLogger.info(JSON.stringify({ action: 'approval_clock_anomaly', sessionId: null, ts: Date.now() }))
      return false
    }

    // TTL 过期检查
    if (Date.now() - grantedAt > ttlMs) {
      try { unlinkSync(APPROVAL_FILE) } catch {}
      desktopAuditLogger.info(JSON.stringify({ action: 'approval_expired', sessionId: null, ts: Date.now() }))
      return false
    }

    return true
  } catch {
    return false
  }
}

function persistApproval(): void {
  try {
    mkdirSync(getHomeTabtinPath(), { recursive: true })
    writeFileSync(APPROVAL_FILE, JSON.stringify({
      approved: true,
      grantedAt: new Date().toISOString(),
      ttlMs: DEFAULT_APPROVAL_TTL_MS,
    }))
  } catch (err) {
    log.warn('持久化桌面审批偏好失败:', err)
  }
}

/**
 * 撤销桌面操控的"总是允许"授权。
 * 下次 acquire() 会重新弹出审批弹窗。
 *
 * Wave 2 · 产品 Review P1-2 修正：首次审批弹窗若用户选"总是允许"（scope='always'），
 * `ApprovalManager.recordAndResolve` 会把 `desktop_control` 写入 `ApprovalScopeCache`
 * 持久化缓存。仅删 `desktop-approval.json` + 清 `desktopApprovedOnce` 还不够——下次
 * `requestApproval('desktop_control')` 第一步就是 `approvalScopeCache.isApproved(...)`
 * 命中返回 `cached`，**弹窗被绕过**。因此撤销时必须同步清掉 scopeCache 的
 * `desktop_control` 条目，否则"撤销"形同虚设（规范 § 6.3 的产品承诺破产）。
 *
 * 同步写审计日志（`approval_revoked`）进 jsonl 事实源，便于安全事件回溯。
 */
export function revokeDesktopApproval(): void {
  desktopApprovedOnce = false
  try {
    unlinkSync(APPROVAL_FILE)
  } catch { /* file may not exist */ }
  // 清 ApprovalScopeCache 里 desktop_control 的 session/persisted 条目，
  // 阻断"撤销后弹窗被 cache 命中绕过"。
  try {
    approvalScopeCache.clearByActionType('desktop_control')
  } catch (err) {
    log.warn('[revokeDesktopApproval] 清 approvalScopeCache 失败:', err)
  }
  writeAuditLog({
    action: 'approval_revoked',
    sessionId: null,
    params: {},
    result: 'ok',
  })
}

/**
 * 桌面操控授权状态（供设置面板 D5 撤销入口使用）。
 *
 * 规范 § 6.3：设置面板展示"当前状态（已允许剩余 N 小时 / 未授权）+ 授权时间 +
 * 撤销按钮"。本函数返回渲染所需的全部元数据。
 *
 * - ``granted``：当前是否处于"已授权 + 未过期"状态
 * - ``grantedAt``：ISO-8601 授权时间（granted=false 时为 null）
 * - ``ttlMs``：授权持续时长（默认 24h）
 * - ``remainingMs``：剩余 TTL；未授权时为 0
 * - ``reason``：granted=false 时的原因标签（'none' / 'expired' / 'clock_anomaly' / 'invalid'）
 */
export interface DesktopApprovalStatus {
  granted: boolean
  grantedAt: string | null
  ttlMs: number
  remainingMs: number
  reason: 'granted' | 'none' | 'expired' | 'clock_anomaly' | 'invalid'
}

export function getDesktopApprovalStatus(): DesktopApprovalStatus {
  const empty: DesktopApprovalStatus = {
    granted: false,
    grantedAt: null,
    ttlMs: DEFAULT_APPROVAL_TTL_MS,
    remainingMs: 0,
    reason: 'none',
  }
  try {
    const raw = readFileSync(APPROVAL_FILE, 'utf8')
    const data = JSON.parse(raw) as {
      approved?: unknown
      grantedAt?: unknown
      ttlMs?: unknown
    }
    if (data?.approved !== true || typeof data.grantedAt !== 'string') {
      return { ...empty, reason: 'invalid' }
    }
    const grantedAtMs = new Date(data.grantedAt).getTime()
    if (!Number.isFinite(grantedAtMs)) {
      return { ...empty, reason: 'invalid' }
    }
    const ttlMs = typeof data.ttlMs === 'number' && data.ttlMs > 0 ? data.ttlMs : DEFAULT_APPROVAL_TTL_MS
    const now = Date.now()
    if (grantedAtMs > now) {
      return { ...empty, reason: 'clock_anomaly' }
    }
    const elapsed = now - grantedAtMs
    if (elapsed > ttlMs) {
      return {
        granted: false,
        grantedAt: data.grantedAt,
        ttlMs,
        remainingMs: 0,
        reason: 'expired',
      }
    }
    return {
      granted: true,
      grantedAt: data.grantedAt,
      ttlMs,
      remainingMs: Math.max(0, ttlMs - elapsed),
      reason: 'granted',
    }
  } catch {
    // 文件不存在 / JSON 解析失败均视为"未授权"
    return empty
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 获取桌面操控权限：审批 → 锁 → 中止快捷键注册 → 通知。
 *
 * 返回 AbortSignal 供执行器监听中止事件。
 * 如果锁被占用或用户拒绝，返回失败原因。
 */
export async function acquire(sessionId: string): Promise<GuardAcquireResult> {
  // 重入检查：如果同一 session 已持有锁，直接返回现有 signal
  if (DesktopUseLock.isHeldLocally() && activeAbortController && activeSessionId === sessionId) {
    return { ok: true, abortSignal: activeAbortController.signal }
  }

  // 1. 用户审批
  const approved = await requestDesktopApproval(sessionId)
  if (!approved) {
    // 按规范 § 8.2 铁律 + error-message-checklist §1 三段式（原因 · 影响 · 行动）
    return {
      ok: false,
      reason:
        `用户拒绝了桌面操控请求。` +
        `本次截屏 / 会话启动未执行，其他已授权的操作不受影响。` +
        `请在下次审批弹窗中选择「允许」，或通过「设置 → 隐私与权限 → 桌面操控」撤销后重新审批。`,
    }
  }

  // 2. 获取文件锁
  const lockResult = await DesktopUseLock.tryAcquire(sessionId)
  if (lockResult.kind === 'blocked') {
    // 按规范 § 8.2 示范 B 三段式（原因 · 影响 · 行动）
    return {
      ok: false,
      reason:
        `桌面操控已被另一个 session 占用（session ${lockResult.by}）。` +
        `本次请求未执行，其他桌面应用不受影响。` +
        `请等待该 session 完成，或在对应对话中运行 tabtin desktop session end；` +
        `若怀疑是死进程占用，可手动删除 ~/.tabtin/desktop-use.lock 后重试。`,
    }
  }

  // 3. 设置 AbortController + 注册中止快捷键
  const controller = new AbortController()
  activeAbortController = controller
  activeSessionId = sessionId

  registerAbortShortcut(controller)

  if (!abortShortcutRegistered) {
    // 中止快捷键是用户唯一的紧急停止入口——注册失败立即放弃，不留隐患
    await DesktopUseLock.release(sessionId).catch(() => {})
    activeAbortController = undefined
    activeSessionId = undefined
    return { ok: false, reason: `${ABORT_SHORTCUT_LABEL} 热键注册失败，无法保证安全中止能力。请关闭可能占用该快捷键的应用后重试。` }
  }

  // abort 时自动释放
  controller.signal.addEventListener(
    'abort',
    () => {
      release(sessionId).catch((err) => log.warn('abort 后释放锁失败:', err))
    },
    { once: true },
  )

  return { ok: true, abortSignal: controller.signal }
}

/**
 * 释放桌面操控：注销中止快捷键 → 释放锁 → 通知。
 * 每步独立 try-catch，保证锁一定被释放。
 */
export async function release(sessionId: string): Promise<void> {
  // 1. 注销中止快捷键
  try {
    unregisterAbortShortcut()
  } catch (err) {
    log.warn('注销中止快捷键失败:', err)
  }

  // 2. 清理 AbortController + sessionId
  activeAbortController = undefined
  activeSessionId = undefined

  // 3. 释放文件锁
  try {
    const released = await DesktopUseLock.release(sessionId)
    if (released) {
      sendNotification('Agent 已完成桌面操控', '桌面操控已结束，你的电脑已恢复正常。')
    }
  } catch (err) {
    log.error('释放桌面操控锁失败:', err)
  }
}

/**
 * 当前 Guard 是否已通过审批且持有锁（session 级"已确认"语义）。
 * 路由层用此判断 confirm 级策略是否可放行。
 */
export function isApproved(): boolean {
  return DesktopUseLock.isHeldLocally() && activeSessionId !== undefined
}

/**
 * 检查当前桌面操控锁状态（不获取）。
 */
export async function checkLockStatus(sessionId: string) {
  return DesktopUseLock.check(sessionId)
}
