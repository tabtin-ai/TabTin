/**
 * 检测提示的触发聚合 hook（Layer D，impl-spec §4 / PRD §4.1）。
 *
 * 登录成功进入主界面后调 `window.tabtin.import.detect()`——只读各工具本地索引做
 * 计数（亚秒级、不读正文、不上传），任一源 installed 且有会话即可能亮指示灯。
 *
 * 侧栏指示灯语义：
 *   - 每次登录最多亮 2 次（localStorage 计数）；
 *   - 点击「导入数据」后当次会话熄灭；
 *   - 完成至少一次导入后永不再亮。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import type { ImportDetectResult } from '@tabtin/cli-server-core'
import {
  isForceImportOnboardingForTest,
  isImportSidebarIndicatorAllowed,
  isImportSidebarNavClickedThisSession,
  markExternalImportCompleted,
  markImportSidebarNavClicked,
  readImportSidebarIndicatorState,
  registerImportSidebarLoginImpression,
  resetImportSidebarNavClickedSession,
} from './importSidebarIndicator'

export {
  IMPORT_DISMISS_STORAGE_KEY,
  IMPORT_FORCE_ONBOARDING_STORAGE_KEY,
  persistImportDismissed,
} from './importSidebarIndicator'

export { IMPORT_SOURCE_LABELS } from '@shared/external-archive-transcript'

export interface ExternalImportDetectionResult {
  loading: boolean
  activeSources: ImportDetectResult[]
  hasData: boolean
  totalSessions: number
  totalWorkspaces: number
  /** @deprecated 指示灯不再区分加急色，保留字段兼容测试 mock */
  claudeUrgent: boolean
  shouldShow: boolean
  markNavClicked: () => void
}

export interface UseExternalImportDetectionOptions {
  enabled?: boolean
}

export function useExternalImportDetection(
  opts: UseExternalImportDetectionOptions = {},
): ExternalImportDetectionResult {
  const { enabled = true } = opts
  const authPhase = useAuthStore((s) => s.authPhase)
  const isAuthenticated = authPhase === 'authenticated'
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const forceOnboarding = isForceImportOnboardingForTest()

  const [loading, setLoading] = useState(false)
  const [sources, setSources] = useState<ImportDetectResult[] | null>(null)
  const [indicatorEligible, setIndicatorEligible] = useState(false)
  const [importCompleted, setImportCompleted] = useState(
    () => readImportSidebarIndicatorState().importCompleted,
  )
  const [navClicked, setNavClicked] = useState(() => isImportSidebarNavClickedThisSession())

  const importApi = typeof window !== 'undefined' ? window.tabtin?.import : undefined
  const gated = enabled && isAuthenticated && !!importApi

  const detectPromiseRef = useRef<Promise<ImportDetectResult[]> | null>(null)
  const impressionRegisteredRef = useRef(false)

  useEffect(() => {
    if (authPhase !== 'authenticated') {
      resetImportSidebarNavClickedSession()
      setNavClicked(false)
      impressionRegisteredRef.current = false
      setIndicatorEligible(false)
    }
  }, [authPhase])

  useEffect(() => {
    if (!gated) {
      detectPromiseRef.current = null
      return
    }
    if (sources !== null) return
    let active = true
    if (!detectPromiseRef.current) {
      detectPromiseRef.current = importApi!
        .detect()
        .then((out) => out.sources ?? [])
        .catch((err) => {
          console.warn('[ExternalImportDetection] detect failed:', err)
          return [] as ImportDetectResult[]
        })
    }
    setLoading(true)
    detectPromiseRef.current.then((result) => {
      if (active) {
        setSources(result)
        setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [gated, importApi, sources])

  const hasData = useMemo(
    () => (sources ?? []).some((s) => s.installed && s.sessionCount > 0),
    [sources],
  )

  // 本机已有档案 → 补记「导过」，避免 dogfood / 旧状态一直亮蓝点
  useEffect(() => {
    if (!gated || !organizationId || !importApi?.listArchives) return
    if (readImportSidebarIndicatorState().importCompleted) {
      setImportCompleted(true)
      return
    }
    let active = true
    void importApi.listArchives(organizationId).then((list) => {
      if (!active) return
      if (Array.isArray(list) && list.length > 0) {
        markExternalImportCompleted()
        setImportCompleted(true)
        setIndicatorEligible(false)
      }
    }).catch(() => { /* 探测失败不挡指示灯主路径 */ })
    return () => {
      active = false
    }
  }, [gated, importApi, organizationId])

  useEffect(() => {
    if (!gated || loading || sources === null || !hasData) return
    if (impressionRegisteredRef.current) return
    impressionRegisteredRef.current = true
    // 已完成过导入：永久熄灭（force 调试也不绕过）
    if (!isImportSidebarIndicatorAllowed()) {
      setImportCompleted(true)
      setIndicatorEligible(false)
      return
    }
    if (forceOnboarding) {
      setIndicatorEligible(true)
      return
    }
    setIndicatorEligible(registerImportSidebarLoginImpression())
  }, [forceOnboarding, gated, hasData, loading, sources])

  const markNavClicked = useCallback(() => {
    markImportSidebarNavClicked()
    setNavClicked(true)
  }, [])

  return useMemo<ExternalImportDetectionResult>(() => {
    const activeSources = (sources ?? []).filter(
      (s) => s.installed && s.sessionCount > 0,
    )
    const totalSessions = activeSources.reduce((n, s) => n + s.sessionCount, 0)
    const totalWorkspaces = activeSources.reduce((n, s) => n + s.workspaceCount, 0)
    const claudeUrgent = activeSources.some((s) => s.source === 'claude_code')
    const shouldShow =
      gated &&
      !loading &&
      sources !== null &&
      hasData &&
      !navClicked &&
      !importCompleted &&
      (forceOnboarding || indicatorEligible)

    return {
      loading,
      activeSources,
      hasData,
      totalSessions,
      totalWorkspaces,
      claudeUrgent,
      shouldShow,
      markNavClicked,
    }
  }, [
    sources,
    loading,
    gated,
    hasData,
    navClicked,
    importCompleted,
    forceOnboarding,
    indicatorEligible,
    markNavClicked,
  ])
}
