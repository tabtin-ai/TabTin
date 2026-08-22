/**
 * Wave 5c T1 — 首次引导横幅（PRD Story 1）。
 *
 * # 业务目标
 *
 *   - 用户首次打开 TabWeb，所有网站都未登录；TabTin 自身的凭据库也是空白。
 *   - 顶部出现一条不阻塞的引导气泡："从你的浏览器导入登录状态？"
 *   - 用户点 [从浏览器导入] → 检测本机浏览器 → 一键提取 Cookie + 密码 →
 *     注入到 **默认登录环境** partition（`tabtin:env:default`）。
 *   - 用户点"不再提示" → 后端持久化 dismiss 时间戳，跨设备保留；CredentialsPanel
 *     里仍然能再次手动导入。
 *   - 用户点 ×（关闭按钮）→ **仅本次会话隐藏**，不写持久化（视角 2 P1-1 修复：
 *     × 与"不再提示"语义不同——避免下意识关闭就跨设备永久 dismiss）。
 *
 * # 反思 6 三视角自修
 *
 * - **视角 1 P0-2**：onboarding 注入到 default-env partition 在独立 env Space 失效 →
 *   通过 `isolatedEnvWarning` 文案警示用户；shouldShow 不阻塞独立 env Space
 *   （仍展示 banner，因为用户可能想给共享环境导入）。
 * - **视角 2 P0-2**：multi-Profile 没有选择 UI → 加 profile select。多 profile 时
 *   显示账号名让用户选；单 profile 直接默选。
 * - **视角 2 P1-1**：× ≠ "不再提示"。 × 仅 session-only 隐藏；"不再提示"才写后端。
 * - **视角 2 P1-3**：noBrowsers 文案承诺 JSON 但 banner 无入口 → 改文案 + 加跳设置页 CTA。
 * - **视角 2 P1-4**：默认勾选密码无安全声明 → 复选框旁加 `passwordSecurityNotice`。
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Globe, Loader2, X, AlertCircle, ExternalLink } from 'lucide-react'
import { Button, toast } from '@tabtin/smartsheet-ui'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'

import { useFirstTimeOnboarding } from './useFirstTimeOnboarding'
import {
  credentialKeys,
  useUpdateOnboardingStateMutation,
} from '@/hooks/queries/credentials'
import {
  BROWSER_CREDENTIAL_IMPORT_ENABLED,
  BROWSER_ICONS,
  ERROR_CODE_I18N,
  PASSWORD_BROWSERS,
  SUPPORTED_BROWSERS,
} from '@/components/settings/panels/credentials/constants'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useSettingsSpaceStore } from '@/stores/useSettingsSpaceStore'
import { useCrawlspaceRegistry } from '@/crawlspace/registry/useCrawlspaceRegistry'
import { DEFAULT_ENV_PARTITION, getOrganizationBrowserPartition } from '@/stores/browserEnvSnapshot'
import type { DetectedBrowser, BrowserProfile } from '@/components/settings/panels/credentials/types'

interface ImportingState {
  browser: string
}

export const FirstTimeImportBanner: React.FC<{
  /** 外层禁用开关（比如 ContentArea 不在 space mode 时不渲染）。 */
  enabled?: boolean
}> = ({ enabled = true }) => {
  const importEnabled = enabled && BROWSER_CREDENTIAL_IMPORT_ENABLED
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const openSettings = useSettingsSpaceStore((s) => s.openSettings)
  const onboarding = useFirstTimeOnboarding({ enabled: importEnabled })
  const updateMutation = useUpdateOnboardingStateMutation()
  const [importing, setImporting] = useState<ImportingState | null>(null)
  const [includePasswords, setIncludePasswords] = useState(true)
  const [selectedBrowser, setSelectedBrowser] = useState<string | null>(null)
  const [selectedProfilePath, setSelectedProfilePath] = useState<string | null>(null)
  /** 视角 2 P1-1：× 按钮 = 仅本次会话隐藏，不调 mutation；下次启动仍会出现。 */
  const [sessionDismissed, setSessionDismissed] = useState(false)

  // 视角 1 P0-2：判定当前 Space 是否使用独立登录环境（显式 env 绑定）。
  // Phase 3a：普通浏览器现在用 Organization 共享罐（`tabtin:organization:*`），它**不是**
  // 独立环境；只有显式绑到独立 env（`tabtin:env:{uuid}`）才算 isolated。因此把
  // organization 共享罐和默认 env 罐都视为"非独立"。
  const selectedSpace = useSpaceStore((state) => state.selectedSpace)
  const { getSpacePartition } = useCrawlspaceRegistry()
  const currentPartition = getSpacePartition(selectedSpace?.id ?? null)
  const sharedBrowserPartition = getOrganizationBrowserPartition()
  const isCurrentSpaceIsolated =
    typeof currentPartition === 'string' &&
    currentPartition !== '' &&
    currentPartition !== sharedBrowserPartition &&
    currentPartition !== DEFAULT_ENV_PARTITION

  const handleSessionClose = useCallback(() => {
    setSessionDismissed(true)
  }, [])

  const handleDontShowAgain = useCallback(async () => {
    try {
      await updateMutation.mutateAsync({ action: 'dismiss' })
    } catch (err) {
      console.warn('[FirstTimeImportBanner] dismiss persist failed:', err)
    }
  }, [updateMutation])

  const handleOpenSettings = useCallback(() => {
    try {
      openSettings({ category: 'device', section: 'credentials-browser' })
    } catch {
      console.warn('[FirstTimeImportBanner] openSettings failed')
    }
  }, [openSettings])

  const importFromBrowser = useCallback(
    async (browser: DetectedBrowser, profile: BrowserProfile) => {
      const ipcApi = (window as any)?.tabtin?.credentialVault
      if (!ipcApi) {
        toast({
          title: t('credentialVault.onboarding.importFailedToast', {
            reason: 'IPC unavailable',
          }),
          variant: 'destructive',
        })
        return
      }

      setImporting({ browser: browser.name })
      try {
        const cookieResult = await ipcApi.extractCookies({
          browser: browser.name,
          profilePath: profile.path,
        })

        if (!cookieResult?.success) {
          const i18nKey = cookieResult?.errorCode && ERROR_CODE_I18N[cookieResult.errorCode]
          toast({
            title: t('credentialVault.onboarding.importFailedToast', {
              reason: i18nKey ? t(i18nKey) : cookieResult?.error || 'extract failed',
            }),
            variant: 'destructive',
          })
          return
        }

        const injectResult = await ipcApi.injectCookies({
          partition: getOrganizationBrowserPartition(),
          cookies: cookieResult.cookies,
        })

        if (!injectResult?.success) {
          toast({
            title: t('credentialVault.onboarding.importFailedToast', {
              reason: injectResult?.error || 'inject failed',
            }),
            variant: 'destructive',
          })
          return
        }

        const cookiesInjected = injectResult.injected || 0

        // 可选：导入密码（仅 Chrome / Edge 支持 PasswordExtractor）
        let passwordError: string | null = null
        if (includePasswords && PASSWORD_BROWSERS.has(browser.name)) {
          try {
            const pwResult = await ipcApi.extractPasswords({
              browser: browser.name,
              profilePath: profile.path,
            })
            if (pwResult?.success && Array.isArray(pwResult.passwords)) {
              try {
                const apiClient = (await import('@/services/apiClient')).apiClient
                const items = pwResult.passwords.map((p: any) => ({
                  url: p.url || p.signon_realm || '',
                  username: p.username || '',
                  password: p.password || '',
                }))
                if (items.length > 0) {
                  await apiClient.post('/credential-vault/website/batch-import', {
                    items,
                  })
                }
              } catch (err: any) {
                passwordError = err?.message || String(err)
                console.warn('[FirstTimeImportBanner] batch-import failed:', err)
              }
            } else if (pwResult?.error && pwResult.error !== 'cancelled') {
              passwordError = pwResult.error
            }
          } catch (err: any) {
            passwordError = err?.message || String(err)
          }
        }

        await updateMutation.mutateAsync({
          action: 'complete',
          browser_import_source: browser.name,
        })
        queryClient.invalidateQueries({ queryKey: credentialKeys.websiteCredentials() })

        if (passwordError) {
          toast({
            title: t('credentialVault.onboarding.importPartialSuccess', {
              cookies: cookiesInjected,
              reason: passwordError,
            }),
          })
        } else {
          toast({
            title: t('credentialVault.onboarding.importSuccessToast', {
              cookies: cookiesInjected,
              browser: browser.displayName || browser.name,
            }),
          })
        }
      } catch (err: any) {
        toast({
          title: t('credentialVault.onboarding.importFailedToast', {
            reason: err?.message || String(err),
          }),
          variant: 'destructive',
        })
      } finally {
        setImporting(null)
      }
    },
    [includePasswords, queryClient, t, updateMutation],
  )

  // session-only 关闭后不渲染（不调 mutation）
  if (!importEnabled || sessionDismissed || !onboarding.shouldShow) return null

  const supportedBrowsers = onboarding.browsers.filter(
    (b) => SUPPORTED_BROWSERS.has(b.name) && b.installed && b.profiles.length > 0,
  )

  // 多个浏览器时让用户选——单个直接默认。selectedBrowser=null 时取第一个。
  const targetBrowser =
    supportedBrowsers.find((b) => b.name === selectedBrowser) || supportedBrowsers[0] || null

  // 视角 2 P0-2：profile 选择 —— 多 profile 时让用户选 default 或别的（如工作 vs 个人）。
  const targetProfile = targetBrowser
    ? targetBrowser.profiles.find((p) => p.path === selectedProfilePath) ||
      targetBrowser.profiles.find((p) => p.isDefault) ||
      targetBrowser.profiles[0]
    : null

  const handleImport = () => {
    if (!targetBrowser || !targetProfile) {
      toast({
        title: t('credentialVault.onboarding.noBrowsersDetected'),
        variant: 'destructive',
      })
      return
    }
    void importFromBrowser(targetBrowser, targetProfile)
  }

  const isImporting = !!importing
  const noBrowsers = supportedBrowsers.length === 0
  const multipleBrowsers = supportedBrowsers.length > 1
  const multipleProfiles = targetBrowser ? targetBrowser.profiles.length > 1 : false
  const passwordsToggleDisabled =
    isImporting || !targetBrowser || !PASSWORD_BROWSERS.has(targetBrowser.name)

  return (
    <div
      className="absolute top-2 left-1/2 -translate-x-1/2 z-banner w-[640px] max-w-[92vw] animate-in slide-in-from-top-2 fade-in duration-200"
      role="dialog"
      aria-label="First-time import onboarding"
      data-component="FirstTimeImportBanner"
    >
      <div className={`rounded-lg overflow-hidden ${OVERLAY_SURFACE_CLASS}`}>
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="shrink-0 mt-0.5">
            <Globe className="h-4 w-4 text-muted-foreground/80" />
          </div>
          <div className="flex-1 min-w-0 space-y-2">
            <div>
              <div className="text-body font-medium text-foreground">
                {t('credentialVault.onboarding.bannerTitle')}
              </div>
              <div className="text-caption text-muted-foreground/80 mt-0.5">
                {t('credentialVault.onboarding.bannerSubtitle')}
              </div>
            </div>

            {/* 视角 1 P0-2 自修：独立环境 Space 警示 */}
            {isCurrentSpaceIsolated && (
              <div className="flex items-start gap-1.5 text-caption text-warning/90 bg-warning/10 rounded px-2 py-1.5">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{t('credentialVault.onboarding.isolatedEnvWarning')}</span>
              </div>
            )}

            {noBrowsers ? (
              <div className="space-y-1.5">
                <div className="text-caption text-muted-foreground/80">
                  {t('credentialVault.onboarding.noBrowsersDetected')}
                </div>
                <div className="text-caption text-muted-foreground/60">
                  {t('credentialVault.onboarding.manualSettingsHint')}
                </div>
                <button
                  type="button"
                  onClick={handleOpenSettings}
                  className="inline-flex items-center gap-1 text-caption text-accent hover:text-accent/80"
                  data-action="open-settings"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t('credentialVault.onboarding.openCredentialsSettings')}
                </button>
              </div>
            ) : (
              <>
                {multipleBrowsers && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-caption text-muted-foreground/60">
                      {t('credentialVault.onboarding.selectBrowser')}
                    </span>
                    {supportedBrowsers.map((b) => {
                      const active = (selectedBrowser || supportedBrowsers[0]?.name) === b.name
                      return (
                        <label
                          key={b.name}
                          className={`flex items-center gap-1.5 cursor-pointer rounded-md px-2 py-1 text-caption transition-colors ${
                            active
                              ? 'bg-accent text-accent-foreground'
                              : 'hover:bg-muted/40 text-foreground/80'
                          }`}
                        >
                          <input
                            type="radio"
                            name="onboarding-browser"
                            value={b.name}
                            className="sr-only"
                            checked={active}
                            onChange={() => {
                              setSelectedBrowser(b.name)
                              // 切浏览器后重置 profile 选择，避免脏选中
                              setSelectedProfilePath(null)
                            }}
                            data-action="select-browser"
                          />
                          {BROWSER_ICONS[b.name] || <Globe className="h-3.5 w-3.5" />}
                          <span>{b.displayName || b.name}</span>
                        </label>
                      )
                    })}
                  </div>
                )}

                {/* 视角 2 P0-2：multi-Profile 选择 UI */}
                {multipleProfiles && targetBrowser && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-caption text-muted-foreground/60">
                      {t('credentialVault.onboarding.selectProfile')}
                    </span>
                    {targetBrowser.profiles.map((p) => {
                      const active =
                        (selectedProfilePath || targetProfile?.path) === p.path
                      return (
                        <label
                          key={p.path}
                          className={`flex items-center gap-1.5 cursor-pointer rounded-md px-2 py-1 text-caption transition-colors ${
                            active
                              ? 'bg-accent text-accent-foreground'
                              : 'hover:bg-muted/40 text-foreground/80'
                          }`}
                          title={p.path}
                        >
                          <input
                            type="radio"
                            name="onboarding-profile"
                            value={p.path}
                            className="sr-only"
                            checked={active}
                            onChange={() => setSelectedProfilePath(p.path)}
                            data-action="select-profile"
                          />
                          <span>
                            {p.name ||
                              (p.isDefault
                                ? t('credentialVault.browserCookies.defaultProfile')
                                : p.path)}
                          </span>
                          {p.isDefault && p.name && (
                            <span className="text-caption text-muted-foreground/60">·</span>
                          )}
                          {p.isDefault && p.name && (
                            <span className="text-caption text-muted-foreground/60">
                              {t('credentialVault.browserCookies.defaultProfile')}
                            </span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                )}

                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-caption text-muted-foreground cursor-pointer w-fit">
                    <input
                      type="checkbox"
                      className="h-3 w-3"
                      checked={includePasswords}
                      onChange={(e) => setIncludePasswords(e.target.checked)}
                      disabled={passwordsToggleDisabled}
                      data-action="toggle-passwords"
                    />
                    <span>{t('credentialVault.onboarding.alsoImportPasswords')}</span>
                  </label>
                  {includePasswords && !passwordsToggleDisabled && (
                    <div className="text-caption text-muted-foreground/60 ml-5">
                      {t('credentialVault.onboarding.passwordSecurityNotice')}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={handleSessionClose}
            disabled={isImporting}
            aria-label={t('credentialVault.onboarding.close')}
            title={t('credentialVault.onboarding.closeTooltip')}
            className="shrink-0 -mr-1 -mt-1 p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
            data-action="close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border/40 bg-muted/20">
          <Button
            variant="ghost"
            size="sm"
            className="text-body"
            onClick={handleDontShowAgain}
            disabled={isImporting || updateMutation.isPending}
            title={t('credentialVault.onboarding.tooltipDismissed')}
            data-action="dismiss"
          >
            {t('credentialVault.onboarding.remindLater')}
          </Button>
          <Button
            size="sm"
            className="text-body gap-1.5"
            onClick={handleImport}
            disabled={isImporting || noBrowsers || updateMutation.isPending}
            data-action="import"
          >
            {isImporting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('credentialVault.onboarding.importingLabel')}
              </>
            ) : (
              <>
                {targetBrowser
                  ? BROWSER_ICONS[targetBrowser.name] || <Globe className="h-3.5 w-3.5" />
                  : <Globe className="h-3.5 w-3.5" />}
                {t('credentialVault.onboarding.importFromBrowser')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
