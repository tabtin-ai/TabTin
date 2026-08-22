/**
 * useBrowserSync —— 统一的「同步浏览器」动作 hook。
 *
 * 把 OnboardingImportCard / BrowserCookieSection / WebsiteCredentialsSection 里
 * 三套"从 Chrome 导入"逻辑合并到一处。所有触发同步的地方共享此 hook：
 *  - 选浏览器（Chrome / Edge / Safari …）
 *  - 选 profile（多 profile 时）
 *  - 是否同时同步密码
 *  - 真正执行：extractCookies → injectCookies + 可选 extractPasswords + batch-import
 *
 * 关键点：cookie 注入目标是当前 Organization 的共享浏览器罐
 * （`getOrganizationBrowserPartition()`，Phase 3a），同 organization 下桌面 + 所有
 * Space/对话立即生效。无 organization 时回落默认 env partition。这与
 * OnboardingImportCard / FirstTimeImportBanner 行为一致；如果用户的 Space 用了
 * 独立 env partition，UI 需提示「同步的是当前 Organization 的共享登录环境」。
 */

import { useCallback, useMemo, useState } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useDetectBrowsers } from './useDetectBrowsers'
import { PASSWORD_BROWSERS, SUPPORTED_BROWSERS, ERROR_CODE_I18N } from './constants'
import type { DetectedBrowser } from './types'
import { credentialKeys, useUpdateOnboardingStateMutation } from '@/hooks/queries/credentials'
import { getOrganizationBrowserPartition } from '@/stores/browserEnvSnapshot'
import { apiClient } from '@/services/apiClient'

interface SyncResult {
  cookieInjected: number
  passwordError: string | null
}

export interface UseBrowserSyncResult {
  /** 可同步的浏览器列表（已安装且有 profile） */
  availableBrowsers: DetectedBrowser[]
  /** 是否在检测浏览器 */
  detecting: boolean
  /** 当前选中的浏览器（默认第一个） */
  selectedBrowser: DetectedBrowser | null
  /** 切换浏览器 */
  selectBrowser: (name: string) => void
  /** 当前浏览器下选中的 profile（默认第一个 / isDefault） */
  selectedProfilePath: string | null
  /** 切换 profile */
  selectProfile: (path: string) => void
  /** 是否同时同步密码（仅 PASSWORD_BROWSERS 支持） */
  includePasswords: boolean
  /** 切换是否同步密码 */
  setIncludePasswords: (v: boolean) => void
  /** 是否支持同步密码（取决于选中的浏览器） */
  passwordSupported: boolean
  /** 是否正在同步 */
  isSyncing: boolean
  /** 触发同步 */
  sync: () => Promise<SyncResult | null>
}

export function useBrowserSync(): UseBrowserSyncResult {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const { browsers, detecting } = useDetectBrowsers()
  const updateMutation = useUpdateOnboardingStateMutation()

  const availableBrowsers = useMemo(
    () => browsers.filter((b) => SUPPORTED_BROWSERS.has(b.name) && b.installed && b.profiles.length > 0),
    [browsers],
  )

  const [selectedBrowserName, setSelectedBrowserName] = useState<string | null>(null)
  const [selectedProfilePath, setSelectedProfilePath] = useState<string | null>(null)
  const [includePasswords, setIncludePasswords] = useState(true)
  const [isSyncing, setIsSyncing] = useState(false)

  const selectedBrowser =
    availableBrowsers.find((b) => b.name === selectedBrowserName) ?? availableBrowsers[0] ?? null

  const selectedProfile = selectedBrowser
    ? selectedBrowser.profiles.find((p) => p.path === selectedProfilePath) ??
      selectedBrowser.profiles.find((p) => p.isDefault) ??
      selectedBrowser.profiles[0]
    : null

  const passwordSupported = !!selectedBrowser && PASSWORD_BROWSERS.has(selectedBrowser.name)

  const selectBrowser = useCallback((name: string) => {
    setSelectedBrowserName(name)
    setSelectedProfilePath(null)
  }, [])

  const selectProfile = useCallback((path: string) => {
    setSelectedProfilePath(path)
  }, [])

  const sync = useCallback(async (): Promise<SyncResult | null> => {
    if (!selectedBrowser) {
      toast({ title: t('credentialVault.onboarding.noBrowsersDetected'), variant: 'destructive' })
      return null
    }
    const ipcApi = (window as any)?.tabtin?.credentialVault
    if (!ipcApi || !selectedProfile) {
      toast({ title: t('credentialVault.onboarding.importFailedToast', { reason: 'IPC unavailable' }), variant: 'destructive' })
      return null
    }

    setIsSyncing(true)
    try {
      const cookieResult = await ipcApi.extractCookies({
        browser: selectedBrowser.name,
        profilePath: selectedProfile.path,
      })
      if (!cookieResult?.success) {
        const i18nKey = cookieResult?.errorCode && ERROR_CODE_I18N[cookieResult.errorCode]
        toast({
          title: t('credentialVault.onboarding.importFailedToast', { reason: i18nKey ? t(i18nKey) : cookieResult?.error || 'extract failed' }),
          variant: 'destructive',
        })
        return null
      }

      const injectResult = await ipcApi.injectCookies({
        partition: getOrganizationBrowserPartition(),
        cookies: cookieResult.cookies,
      })
      if (!injectResult?.success) {
        toast({
          title: t('credentialVault.onboarding.importFailedToast', { reason: injectResult?.error || 'inject failed' }),
          variant: 'destructive',
        })
        return null
      }

      let passwordError: string | null = null
      if (includePasswords && passwordSupported) {
        try {
          const pwResult = await ipcApi.extractPasswords({
            browser: selectedBrowser.name,
            profilePath: selectedProfile.path,
          })
          if (pwResult?.success && Array.isArray(pwResult.passwords)) {
            const items = pwResult.passwords.map((p: any) => ({
              url: p.url || p.signon_realm || '',
              username: p.username || '',
              password: p.password || '',
            }))
            if (items.length > 0) {
              await apiClient.post('/credential-vault/website/batch-import', { items })
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
        browser_import_source: selectedBrowser.name,
      })
      void queryClient.invalidateQueries({ queryKey: credentialKeys.websiteCredentials() })

      const cookieInjected = injectResult.injected || 0
      if (passwordError) {
        toast({
          title: t('credentialVault.onboarding.importPartialSuccess', { cookies: cookieInjected, reason: passwordError }),
        })
      } else {
        toast({
          title: t('credentialVault.onboarding.importSuccessToast', { cookies: cookieInjected, browser: selectedBrowser.displayName || selectedBrowser.name }),
        })
      }
      return { cookieInjected, passwordError }
    } catch (err: any) {
      toast({
        title: t('credentialVault.onboarding.importFailedToast', { reason: err?.message || String(err) }),
        variant: 'destructive',
      })
      return null
    } finally {
      setIsSyncing(false)
    }
  }, [selectedBrowser, selectedProfile, includePasswords, passwordSupported, queryClient, updateMutation, t])

  return {
    availableBrowsers,
    detecting,
    selectedBrowser,
    selectBrowser,
    selectedProfilePath: selectedProfile?.path ?? null,
    selectProfile,
    includePasswords,
    setIncludePasswords,
    passwordSupported,
    isSyncing,
    sync,
  }
}
