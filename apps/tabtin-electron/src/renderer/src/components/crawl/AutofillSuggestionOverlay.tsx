import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, X, Loader2, User } from 'lucide-react'
import { cn, OVERLAY_SURFACE_CLASS } from '@components/ui'

interface CredentialSuggestion {
  id: string
  url: string
  username: string
  masked_password: string
}

interface AutofillSuggestion {
  tabId: string
  credentials: CredentialSuggestion[]
  formInfo: {
    hasPassword: boolean
    hasUsername: boolean
    domain: string
  }
}

export const AutofillSuggestionOverlay: React.FC = () => {
  const { t } = useTranslation('settings')
  const [suggestion, setSuggestion] = useState<AutofillSuggestion | null>(null)
  const [filling, setFilling] = useState<string | null>(null)

  useEffect(() => {
    const tabtin = window.tabtin
    if (!tabtin?.credentialVault?.onAutofillSuggest) return

    const cleanupSuggest = tabtin.credentialVault.onAutofillSuggest(
      (payload: AutofillSuggestion) => {
        setSuggestion(payload)
        setFilling(null)
      },
    )
    // 主进程通知清卡片（页面已跳转，避免残留）：按 tabId 匹配当前卡片才清。
    const cleanupClear = tabtin.credentialVault.onAutofillClear?.(
      (payload: { tabId: string }) => {
        setSuggestion((current) =>
          current && current.tabId === payload.tabId ? null : current,
        )
      },
    )
    return () => {
      cleanupSuggest?.()
      cleanupClear?.()
    }
  }, [])

  // 驱动 modal 子窗口 show/hide：自动填充建议是**非阻塞提示**——
  // 有建议时 open(true)，主进程把 modal 子窗口收缩成「贴右下角的卡片小窗」显示
  // （不抢焦点、始终捕获点击），卡片以外的屏幕不被覆盖，底层网页照常可点/可输入；
  // 无建议时 open(false) 撤出 source、窗口 hide。主 renderer 环境下无 overlay，? 兜底。
  useEffect(() => {
    window.tabtin?.overlay?.setModalSourceOpen?.('autofill-suggest', !!suggestion)
  }, [suggestion])

  // 卸载时撤出 modal source，避免小窗卡在 show 状态。
  useEffect(() => {
    return () => {
      window.tabtin?.overlay?.setModalSourceOpen?.('autofill-suggest', false)
    }
  }, [])

  // 把卡片实际尺寸上报主进程，让贴角小窗刚好覆盖卡片（含 padding 让阴影/圆角不被
  // 窗口边缘裁掉）。ResizeObserver 覆盖凭据条数变化、字体缩放等导致的尺寸变化。
  const cardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!suggestion) return
    const el = cardRef.current
    if (!el) return
    const report = () => {
      const w = Math.ceil(el.offsetWidth)
      const h = Math.ceil(el.offsetHeight)
      if (w > 0 && h > 0) window.tabtin?.overlay?.setHintSize?.({ width: w, height: h })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [suggestion])

  const handleSelect = useCallback(async (credentialId: string) => {
    if (!suggestion) return
    setFilling(credentialId)
    try {
      const tabtin = window.tabtin
      if (!tabtin) return
      const result = await tabtin.credentialVault.autofillSelect({
        tabId: suggestion.tabId,
        credentialId,
      })
      if (result.success) {
        setSuggestion(null)
      } else {
        setFilling(null)
      }
    } catch {
      setFilling(null)
    }
  }, [suggestion])

  const handleDismiss = useCallback(() => {
    if (!suggestion) return
    const tabtin = window.tabtin
    tabtin?.credentialVault?.autofillDismiss({ tabId: suggestion.tabId })
    setSuggestion(null)
  }, [suggestion])

  if (!suggestion) return null

  return (
    <>
      {/* 非阻塞提示：不铺全屏 clickaway（会吃掉用户点网页密码框的点击）。主进程把
          本 modal 子窗口收缩成刚好覆盖卡片的贴角小窗，故这里锚在窗口左上角、留
          padding 给阴影/圆角，窗口本身已被主进程贴到父窗口右下角。卡片外的整屏
          不被窗口覆盖 → 底层网页照常可点/可输入；关闭走 X 按钮或选中某条凭据。 */}
      <div
        ref={cardRef}
        className="pointer-events-auto fixed left-0 top-0 z-global p-3 animate-in slide-in-from-top-2 fade-in duration-300"
        role="dialog"
        aria-label="Password autofill"
      >
        <div className={cn('w-80 rounded-interactive overflow-hidden', OVERLAY_SURFACE_CLASS)}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-muted/30 border-b border-border/40">
          <div className="flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5 text-accent" />
            <span className="text-body font-medium text-foreground">
              {t('credentialVault.websitePasswords.title')}
            </span>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="text-muted-foreground/60 hover:text-foreground transition-colors p-0.5 rounded"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Domain hint */}
        <div className="px-4 py-1.5 text-caption text-muted-foreground/60">
          {suggestion.formInfo.domain}
        </div>

        {/* Credentials list */}
        <div className="px-2 pb-2 space-y-0.5 max-h-48 overflow-y-auto">
          {suggestion.credentials.map((cred) => (
            <button
              key={cred.id}
              type="button"
              onClick={() => handleSelect(cred.id)}
              disabled={filling !== null}
              className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-accent/10 transition-colors text-left disabled:opacity-60"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10">
                <User className="h-3.5 w-3.5 text-accent" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-foreground truncate">
                  {cred.username}
                </div>
                <div className="text-caption text-muted-foreground/60 font-mono">
                  {cred.masked_password}
                </div>
              </div>
              {filling === cred.id && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-accent shrink-0" />
              )}
            </button>
          ))}
        </div>
        </div>
      </div>
    </>
  )
}

AutofillSuggestionOverlay.displayName = 'AutofillSuggestionOverlay'
