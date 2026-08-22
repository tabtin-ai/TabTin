/**
 * SavePasswordBar — Wave 3 G4 自动保存密码提示条。
 *
 * 渲染位置：本组件挂载在 **modal 子窗口**（overlay 方案 Y）里，
 *   而不是主 renderer。原因有二：
 *   1. TabWeb 网页是原生 `WebContentsView`，永远盖在主 renderer DOM 之上——保存条
 *      画在主 renderer 会被网页盖住（下半截按钮看不见）。overlay 子窗口由 OS 合成，
 *      永远在最上层。
 *   2. 保存条有可点按钮，必须跑在 **focusable 的 modal 子窗口**——toast 子窗口整窗
 *      鼠标穿透且 `focusable:false`（非激活窗口），macOS 上按钮点击收不到、会漏穿到
 *      下层网页（ 复现）。modal 子窗口整窗捕获点击，按钮可靠生效。
 *   代价（半模态语义）：modal 显示时整窗捕获点击，故用一个全屏透明 clickaway 背景
 *   承接"点卡片外"= 关闭当前提示，让用户能立刻回到网页；modal 的 show/hide 由本
 *   组件按"是否有可见内容"通过 `overlay.setModalSourceOpen('save-password', ...)` 驱动（无内容即
 *   hide，网页恢复交互）。overlay 子窗口与主窗口共用同一 preload，故
 *   `window.tabtin.credentialVault.*` / `window.tabtin.overlay.*` 全部可用。
 *
 * 业务（PRD Story 2 + UI 5.3）：
 *   1. 用户在 TabWeb 提交登录表单 → 主进程 PASSWORD_CAPTURE_SCRIPT 捕获
 *   2. 主进程验证登录成功（URL 跳转 + 当前页无密码框）
 *   3. 主进程查凭据库决策模式：save / update / new-account
 *   4. emit `credential-vault:save-prompt` IPC → toast 子窗口 renderer（**不带密码**）
 *   5. **本组件**订阅 IPC，按 mode 渲染不同文案 + 三种操作（保存 / 不为此网站保存 / 关闭）
 *   6. 用户点保存 → renderer 发 `credential-vault:save-confirm { tabId }`
 *      → 主进程从 pendingSavePasswords map 取出密码 + 调后端，密码不出主进程
 *
 * 安全设计（PRD 8.1）：
 *   - **密码全程不进 renderer state**：IPC payload 不含 password 字段，本组件
 *     state 也没有密码。renderer 只持有 (mode, domain, url, username) 这种
 *     非敏感元数据。
 *   - 用户点"保存"时 renderer 只发 tabId，主进程按 tabId 反查内存 map 取密码。
 *   - 这种设计避免了"密码进 React component state → DevTools props inspector
 *     可读"的攻击面。
 *
 * Wave 3 P0 修复（视角 2 #2）：**队列化** —— 多 tab 同时登录时旧 prompt
 *   不再被新 prompt 静默覆盖，按 FIFO 排队展示。
 *
 * Wave 3 P0 修复（视角 2 #1）：**撤销入口** —— 用户点"不为此网站保存"
 *   后 5s 内可点"撤销"调 `credential-vault:save-undismiss` 撤回黑名单
 *   （主进程清本地缓存 + 后端 DELETE），避免单向死结。
 *
 * 已知限制（视角 1 #5）：
 *   - 当前实现依赖主进程 emit 时机（蒙层期间主进程仍 emit），renderer 这
 *     里只能"收到就显示"——配合主进程 verifyLoginSuccess 的 1.5s 等待 +
 *     webContents 销毁守门已经能覆盖大部分异常场景。Wave 4/5 进一步精确
 *     化"哪个 tab 在哪个 workspace"再做更强约束。
 */
import React, { useCallback, useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, X, Loader2, Undo2 } from 'lucide-react'
import { cn, OVERLAY_SURFACE_CLASS } from '@components/ui'

export type SavePromptMode = 'save' | 'update' | 'new-account'

export interface SavePromptPayload {
  tabId: string
  mode: SavePromptMode
  domain: string
  url: string
  username: string
  /** 仅 mode='update' 时携带 */
  credentialId?: string
  /** 仅 mode='new-account' 时携带 */
  existingUsernames?: string[]
}

/** 撤销窗口（用户点"不为此网站保存"后 5s 内可撤回）—— Wave 3 P0 视角 2#1 */
const UNDISMISS_WINDOW_MS = 5000
/** 单条 prompt 自动清除时间（用户没操作就消失） */
const AUTO_CLEAR_MS = 3 * 60 * 1000
/** 操作成功后的反馈停留时间（撤销 button 在此期间可点） */
const FEEDBACK_HOLD_MS = UNDISMISS_WINDOW_MS

type Submitting = 'save' | 'never' | 'undismiss' | null

interface Feedback {
  kind: 'success' | 'error'
  text: string
  /** 用于"已加入黑名单"反馈的撤销按钮：携带刚被加黑的 domain，5s 内可点 */
  undismissDomain?: string
}

export const SavePasswordBar: React.FC = () => {
  const { t } = useTranslation('settings')
  // **队列化**：FIFO，head 是当前展示的 prompt
  const [queue, setQueue] = useState<SavePromptPayload[]>([])
  const [submitting, setSubmitting] = useState<Submitting>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const autoClearTimerRef = useRef<number | null>(null)
  const feedbackClearTimerRef = useRef<number | null>(null)
  /**
   * Wave 3 修正版 Review 视角 2 P0-2 自修：撤销窗口零代价化。
   *
   * 旧实现：用户点"不为此网站保存" → **立即** POST /save-blacklist 写后端
   *   → 5s 内可点"撤销" → DELETE /save-blacklist 反向写回。
   *
   * 问题：5s 倒计时跟"用户的注意力"赛跑。新 prompt 入队后 advance() 被
   *   调用，feedback 仍保留但被新 prompt 视觉抢占，用户根本看不到"撤销"
   *   按钮，5s 一过 → undismiss 机会消失，**永久进黑名单**。
   *
   * 修复：把 POST /save-blacklist **延迟 5s 真执行**——5s 内用户点撤销
   *   直接 cancel timer，**根本不打后端**，撤销变成零代价（不消耗 API
   *   配额、不写日志、不触发任何持久化），即使用户没看到撤销按钮、5s 过
   *   后再发现自己点错也只是失去"立即撤销"的窗口；真正的撤销可以走
   *   Wave 5 的"已屏蔽列表"管理页。
   *
   * 同时，pending 写黑名单 timer 在切下一条 prompt 时**保留 5s 计时不
   *   重置**，让用户在新 prompt 上仍可点"撤销刚才那条"完成 cancel。
   */
  const pendingNeverTimerRef = useRef<number | null>(null)
  const pendingNeverDomainRef = useRef<string | null>(null)

  const prompt = queue[0] ?? null

  // 是否有可见内容（当前 prompt，或带"撤销"按钮的 feedback）。
  const isVisible = !!prompt || !!feedback?.undismissDomain

  // 驱动 modal 子窗口 show/hide：有可见内容时 open(true) 让 modal
  // 显示且可点，无内容时 open(false) 撤出 modal source，无其他 source 时 modal
  // hide、网页恢复交互。主 renderer 环境下 window.tabtin.overlay 不存在，? 链兜底。
  useEffect(() => {
    window.tabtin?.overlay?.setModalSourceOpen?.('save-password', isVisible)
  }, [isVisible])

  // 卸载时确保撤出 modal source，避免 modal 卡在 show 状态挡住网页。
  useEffect(() => {
    return () => {
      window.tabtin?.overlay?.setModalSourceOpen?.('save-password', false)
    }
  }, [])

  // 订阅 main 进程 save-prompt IPC
  useEffect(() => {
    const tabtin = window.tabtin
    if (!tabtin?.credentialVault?.onSavePrompt) return
    const cleanup = tabtin.credentialVault.onSavePrompt((payload: any) => {
      if (!payload || typeof payload.tabId !== 'string' || typeof payload.domain !== 'string') {
        console.warn('[SavePasswordBar] save-prompt invalid payload, dropping')
        return
      }
      const next: SavePromptPayload = {
        tabId: payload.tabId,
        mode: payload.mode,
        domain: payload.domain,
        url: payload.url,
        username: payload.username || '',
        ...(payload.credentialId ? { credentialId: payload.credentialId } : {}),
        ...(payload.existingUsernames ? { existingUsernames: payload.existingUsernames } : {}),
      }
      setQueue((prev) => {
        // 同一 tabId 的 pending 用最新一条（同一 tab 短时间内多次提交，新覆盖旧；
        // 不同 tab 排队累加）
        const filtered = prev.filter((p) => p.tabId !== next.tabId)
        return [...filtered, next]
      })
    })
    return cleanup
  }, [])

  // 当前 prompt 的"3min 自动清除" timer —— 单 ref 持有，新 prompt 切换时 reset
  useEffect(() => {
    if (autoClearTimerRef.current !== null) {
      window.clearTimeout(autoClearTimerRef.current)
      autoClearTimerRef.current = null
    }
    if (!prompt) return
    autoClearTimerRef.current = window.setTimeout(() => {
      setQueue((prev) => prev.slice(1))
      autoClearTimerRef.current = null
    }, AUTO_CLEAR_MS)
    return () => {
      if (autoClearTimerRef.current !== null) {
        window.clearTimeout(autoClearTimerRef.current)
        autoClearTimerRef.current = null
      }
    }
  }, [prompt?.tabId])

  // 组件 unmount 时全部清掉
  useEffect(() => {
    return () => {
      setQueue([])
      if (autoClearTimerRef.current !== null) window.clearTimeout(autoClearTimerRef.current)
      if (feedbackClearTimerRef.current !== null) window.clearTimeout(feedbackClearTimerRef.current)
      // Wave 3 修正版 Review 视角 2 P0-2 自修：unmount 时如果还有 pending
      // dismiss timer 没到期，**立即真写一次后端**（保证用户的"不为此网
      // 站保存"语义不丢——unmount 通常是刷新或关闭，timer 会随之消失）。
      if (pendingNeverTimerRef.current !== null) {
        window.clearTimeout(pendingNeverTimerRef.current)
        const domain = pendingNeverDomainRef.current
        pendingNeverTimerRef.current = null
        pendingNeverDomainRef.current = null
        if (domain) {
          const tabtin = window.tabtin
          void tabtin?.credentialVault?.saveDismiss?.({ domain })
        }
      }
    }
  }, [])

  /** 弹出当前 head prompt，进入下一条 */
  const advance = useCallback(() => {
    setQueue((prev) => prev.slice(1))
    setSubmitting(null)
    // 切下一条时清掉旧 feedback —— 但保留 undismiss 反馈，让用户能撤回上一步操作
    if (!feedback?.undismissDomain) {
      setFeedback(null)
    }
  }, [feedback])

  const dismiss = useCallback(() => {
    if (submitting) return
    advance()
  }, [advance, submitting])

  const clearFeedbackLater = useCallback((ms: number) => {
    if (feedbackClearTimerRef.current !== null) {
      window.clearTimeout(feedbackClearTimerRef.current)
    }
    feedbackClearTimerRef.current = window.setTimeout(() => {
      setFeedback(null)
      feedbackClearTimerRef.current = null
    }, ms)
  }, [])

  const handleSave = useCallback(async () => {
    if (!prompt || submitting) return
    setSubmitting('save')
    try {
      const tabtin = window.tabtin
      if (!tabtin?.credentialVault?.saveConfirm) {
        throw new Error('saveConfirm IPC unavailable')
      }
      // Wave 3 G3 安全设计：renderer 只发 tabId，主进程从 pendingSavePasswords
      // 内存 map 取出密码（密码全程不进 renderer state）
      const result = await tabtin.credentialVault.saveConfirm({
        tabId: prompt.tabId,
      })
      if (result?.success) {
        setFeedback({
          kind: 'success',
          text: prompt.mode === 'update' ? t('credentialVault.savePasswordBar.updateSuccess') : t('credentialVault.savePasswordBar.saveSuccess'),
        })
        // 1.2s 后弹下一条
        window.setTimeout(() => advance(), 1200)
      } else {
        setFeedback({ kind: 'error', text: result?.error || t('credentialVault.savePasswordBar.saveFailed') })
        setSubmitting(null)
      }
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err?.message || t('credentialVault.savePasswordBar.saveFailed') })
      setSubmitting(null)
    }
  }, [prompt, submitting, t, advance])

  const handleNever = useCallback(() => {
    if (!prompt || submitting) return
    const dismissedDomain = prompt.domain
    // Wave 3 修正版 Review 视角 2 P0-2 自修：先记 pending（不打后端），
    // 5s 后真写。撤销路径只需 clearTimeout，零后端开销。
    if (pendingNeverTimerRef.current !== null) {
      // 上一条 pending 还没到期就被新 dismiss 覆盖（用户连续 dismiss 多条）：
      // 立即真写上一条，再开始新一条的 pending 窗口（保证旧的不丢）。
      window.clearTimeout(pendingNeverTimerRef.current)
      const prevDomain = pendingNeverDomainRef.current
      if (prevDomain && prevDomain !== dismissedDomain) {
        const tabtin = window.tabtin
        // fire-and-forget：上一条立即下发；如果失败用户已看不到反馈，只能等 Wave 5 列表页
        void tabtin?.credentialVault?.saveDismiss?.({ domain: prevDomain })
      }
    }
    pendingNeverDomainRef.current = dismissedDomain
    pendingNeverTimerRef.current = window.setTimeout(() => {
      const tabtin = window.tabtin
      if (!tabtin?.credentialVault?.saveDismiss) {
        pendingNeverTimerRef.current = null
        pendingNeverDomainRef.current = null
        return
      }
      void tabtin.credentialVault.saveDismiss({ domain: dismissedDomain }).then((result) => {
        // 真写完成；如果失败但用户已经看不到（advance 后 feedback 已清），
        // 静默——下次密码提交时主进程缓存已 invalidate 会重新尝试
        if (!result?.success) {
          console.warn('[SavePasswordBar] delayed saveDismiss failed:', result)
        }
      }).catch((err) => {
        console.warn('[SavePasswordBar] delayed saveDismiss error:', err)
      })
      pendingNeverTimerRef.current = null
      pendingNeverDomainRef.current = null
    }, UNDISMISS_WINDOW_MS)
    // UI 立即给反馈（带 undismissDomain），让用户能在 5s 内 cancel
    setFeedback({
      kind: 'success',
      text: t('credentialVault.savePasswordBar.neverSuccess', { domain: dismissedDomain }),
      undismissDomain: dismissedDomain,
    })
    clearFeedbackLater(FEEDBACK_HOLD_MS + 200)
    // advance 进下一条 prompt——feedback 保留（advance 内部对 undismissDomain 不清）
    window.setTimeout(() => advance(), 100)
  }, [prompt, submitting, t, advance, clearFeedbackLater])

  const handleUndismiss = useCallback(async () => {
    if (!feedback?.undismissDomain || submitting === 'undismiss') return
    const domain = feedback.undismissDomain
    // Wave 3 修正版 Review 视角 2 P0-2 自修：优先 cancel pending timer
    // （零后端开销路径）。如果 timer 已经触发完（5s 后），fall back 到
    // 真 DELETE 反向写。
    if (pendingNeverTimerRef.current !== null && pendingNeverDomainRef.current === domain) {
      window.clearTimeout(pendingNeverTimerRef.current)
      pendingNeverTimerRef.current = null
      pendingNeverDomainRef.current = null
      setFeedback({
        kind: 'success',
        text: t('credentialVault.savePasswordBar.undismissSuccess', { domain }),
      })
      clearFeedbackLater(2000)
      return
    }
    // 已超 5s 真写过了 → 走真 DELETE 反向写
    setSubmitting('undismiss')
    try {
      const tabtin = window.tabtin as any
      if (!tabtin?.credentialVault?.saveUndismiss) {
        throw new Error('saveUndismiss IPC unavailable')
      }
      const result = await tabtin.credentialVault.saveUndismiss({ domain })
      if (result?.success) {
        setFeedback({
          kind: 'success',
          text: t('credentialVault.savePasswordBar.undismissSuccess', { domain }),
        })
        clearFeedbackLater(2000)
      } else {
        setFeedback({
          kind: 'error',
          text: result?.error || t('credentialVault.savePasswordBar.undismissFailed'),
        })
      }
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err?.message || t('credentialVault.savePasswordBar.undismissFailed') })
    } finally {
      setSubmitting(null)
    }
  }, [feedback, submitting, t, clearFeedbackLater])

  // 只渲染 prompt 或带"撤销"按钮的 feedback；无 prompt + 无 undismissable feedback 时不显示
  if (!prompt && !(feedback?.undismissDomain)) return null

  // feedback-only 渲染（用户已点"不为此网站保存"，等 undismiss 窗口）
  if (!prompt && feedback?.undismissDomain) {
    return (
      <>
        {/* clickaway：modal 整窗捕获点击，点卡片外 = 关闭反馈，让用户回到网页 */}
        <div
          className="pointer-events-auto fixed inset-0 z-global"
          aria-hidden="true"
          onClick={() => setFeedback(null)}
        />
        <div
          className="pointer-events-auto fixed top-2 left-1/2 -translate-x-1/2 z-global w-[480px] max-w-[90vw] animate-in slide-in-from-top-2 fade-in duration-200"
          role="status"
          aria-label="Save password feedback"
          data-component="SavePasswordBar"
          data-mode="feedback-only"
        >
        <div className={cn('rounded-interactive overflow-hidden', OVERLAY_SURFACE_CLASS)}>
          <div className="flex items-center gap-2 px-4 py-2.5">
            <span className={`text-caption flex-1 ${feedback.kind === 'success' ? 'text-foreground' : 'text-destructive'}`}>
              {feedback.text}
            </span>
            <button
              type="button"
              onClick={handleUndismiss}
              disabled={submitting === 'undismiss'}
              className="flex items-center gap-1 text-caption text-accent hover:text-accent/80 transition-colors disabled:opacity-50"
              data-action="undismiss"
            >
              {submitting === 'undismiss' && <Loader2 className="h-3 w-3 animate-spin" />}
              <Undo2 className="h-3 w-3" />
              {t('credentialVault.savePasswordBar.undismissAction')}
            </button>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-muted-foreground/60 hover:text-foreground p-1 rounded -mr-1"
              aria-label={t('credentialVault.savePasswordBar.dismissAction')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        </div>
      </>
    )
  }

  if (!prompt) return null

  const titleKey = prompt.mode === 'update'
    ? 'credentialVault.savePasswordBar.updateTitle'
    : prompt.mode === 'new-account'
      ? 'credentialVault.savePasswordBar.newAccountTitle'
      : 'credentialVault.savePasswordBar.saveTitle'

  const saveActionKey = prompt.mode === 'update'
    ? 'credentialVault.savePasswordBar.updateAction'
    : prompt.mode === 'new-account'
      ? 'credentialVault.savePasswordBar.saveAsNewAction'
      : 'credentialVault.savePasswordBar.saveAction'

  return (
    <>
      {/* clickaway：modal 整窗捕获点击，点卡片外 = 关闭当前提示，让用户回到网页 */}
      <div
        className="pointer-events-auto fixed inset-0 z-global"
        aria-hidden="true"
        onClick={dismiss}
      />
      <div
        className="pointer-events-auto fixed top-2 left-1/2 -translate-x-1/2 z-global w-[480px] max-w-[90vw] animate-in slide-in-from-top-2 fade-in duration-200"
        role="dialog"
        aria-label="Save password prompt"
        data-component="SavePasswordBar"
        data-mode={prompt.mode}
        data-domain={prompt.domain}
      >
      <div className={cn('rounded-interactive overflow-hidden', OVERLAY_SURFACE_CLASS)}>
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 mt-0.5">
            <KeyRound className="h-4 w-4 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-foreground">
              {t(titleKey, { domain: prompt.domain })}
            </p>
            <p className="text-caption text-muted-foreground mt-0.5 truncate">
              {prompt.username || '—'}
            </p>
            {prompt.mode === 'new-account' && prompt.existingUsernames && prompt.existingUsernames.length > 0 && (
              <p className="text-caption text-muted-foreground/80 mt-1">
                {t('credentialVault.savePasswordBar.existingHint')}
                {' '}
                {prompt.existingUsernames.slice(0, 3).join(', ')}
                {prompt.existingUsernames.length > 3 ? ` +${prompt.existingUsernames.length - 3}` : ''}
              </p>
            )}
            {/* 队列剩余条数提示（视角 2 #2 修复后明示用户还有 N 条等待） */}
            {queue.length > 1 && (
              <p className="text-caption text-muted-foreground/60 mt-1" data-pending-count={queue.length - 1}>
                {t('credentialVault.savePasswordBar.pendingCount', { count: queue.length - 1 })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={submitting !== null}
            className="text-muted-foreground/60 hover:text-foreground transition-colors p-1 rounded -mt-1 -mr-1 disabled:opacity-50"
            aria-label={t('credentialVault.savePasswordBar.dismissAction')}
            data-action="dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 px-4 py-2 bg-muted/30 border-t border-border/40">
          <button
            type="button"
            onClick={handleNever}
            disabled={submitting !== null}
            className="text-caption text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            data-action="never"
            // Wave 3 真关闭补丁 P0-补-2：proactive disclosure。
            // 用户点这个按钮 = 把 domain 写后端黑名单。撤回路径分两段：5s 内
            // 可在反馈 toast 上点"撤销"（零代价 cancel pending timer）；逾期
            // 后唯一入口是「设置 → 设备 → 浏览器」的黑名单管理 UI。
            // tooltip 让用户**点之前**就知道有去处，避免后悔时找不到入口。
            title={t('credentialVault.savePasswordBar.neverHint')}
          >
            {submitting === 'never' && (
              <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" />
            )}
            {t('credentialVault.savePasswordBar.neverAction')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={submitting !== null}
            className="px-3 py-1 text-body font-medium rounded bg-accent text-accent-foreground hover:bg-accent/90 transition-colors disabled:opacity-50 flex items-center gap-1"
            data-action="save"
          >
            {submitting === 'save' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t(saveActionKey)}
          </button>
        </div>
        <div className="px-4 py-1.5 text-caption text-muted-foreground/80 bg-muted/20 border-t border-border/40">
          {t('credentialVault.savePasswordBar.securityHint')}
        </div>
        {feedback && (
          <div
            className={`px-4 py-1.5 text-caption flex items-center justify-between gap-2 ${
              feedback.kind === 'success' ? 'text-success' : 'text-destructive'
            }`}
            data-feedback={feedback.kind}
          >
            <span className="flex-1 truncate">{feedback.text}</span>
            {feedback.undismissDomain && (
              <button
                type="button"
                onClick={handleUndismiss}
                disabled={submitting === 'undismiss'}
                className="flex items-center gap-1 text-caption text-accent hover:text-accent/80 transition-colors disabled:opacity-50 shrink-0"
                data-action="undismiss"
              >
                {submitting === 'undismiss' && <Loader2 className="h-3 w-3 animate-spin" />}
                <Undo2 className="h-3 w-3" />
                {t('credentialVault.savePasswordBar.undismissAction')}
              </button>
            )}
          </div>
        )}
      </div>
      </div>
    </>
  )
}

SavePasswordBar.displayName = 'SavePasswordBar'
