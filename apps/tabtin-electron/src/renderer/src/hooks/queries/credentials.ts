import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/services/apiClient'
import type {
  CredentialItem,
  WebsiteCredentialItem,
  AppCredentialItem,
} from '@/components/settings/panels/credentials/types'

export type { CredentialItem, WebsiteCredentialItem, AppCredentialItem }

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

/**
 * Wave 5b 视角 3#4 自修：apiKeys queryKey **不再**编进 service_name。
 *
 * 原设计 `apiKeys('openai')` / `apiKeys('anthropic')` 各占一棵 cache tree → 同一份
 * `/credential-vault/list?category=api_key` 被前端按 service 缓存成 N 份；用户在
 * SkillConfigDialog 切 N 个 Skill 配置 → N 次重复 HTTP；invalidation 也要小心
 * 不能漏 service。改成：queryKey 单根，service 过滤通过 react-query `select`
 * 在内存层做（O(n) 一次性，n 极小，远小于 HTTP 成本）。
 */
export const credentialKeys = {
  all: ['credentials'] as const,
  serviceKeys: () => [...credentialKeys.all, 'service-keys'] as const,
  apiKeys: () => [...credentialKeys.all, 'api-keys'] as const,
  websiteCredentials: () => [...credentialKeys.all, 'website'] as const,
  appCredentials: () => [...credentialKeys.all, 'app'] as const,
  saveBlacklist: () => [...credentialKeys.all, 'save-blacklist'] as const,
  onboardingState: () => [...credentialKeys.all, 'onboarding-state'] as const,
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useServiceKeysQuery() {
  return useQuery({
    queryKey: credentialKeys.serviceKeys(),
    queryFn: async () => {
      const result = await apiClient.get<CredentialItem[]>('/credential-vault/list')
      return result.data || []
    },
  })
}

/**
 * Wave 5b S2：按 category=api_key 拉取 + 可选按 service_name 过滤。
 *
 * 给 Skill 配置页的"凭据选择器"用——传 serviceName='openai' 时只回 OpenAI
 * 凭据；不传时回所有 api_key 凭据（fallback：自定义 LLM 等不在
 * SKILL_CREDENTIAL_ENV_MAP 表里的 service 让用户兜底选）。
 *
 * 视角 3#4 自修：queryKey 单根（无 service_name），过滤走 react-query `select`，
 * 同一份 list 数据全 SkillConfigDialog 共享缓存；invalidation `apiKeys()` 一次
 * 覆盖所有 service 视图。
 */
export function useApiKeyCredentialsQuery(opts: { serviceName?: string } = {}) {
  const { serviceName } = opts
  return useQuery({
    queryKey: credentialKeys.apiKeys(),
    queryFn: async () => {
      const result = await apiClient.get<CredentialItem[]>(
        '/credential-vault/list?category=api_key',
      )
      return result.data || []
    },
    select: (all) => {
      if (!serviceName) return all
      const lower = serviceName.toLowerCase()
      return all.filter((c) => (c.service_name || '').toLowerCase() === lower)
    },
  })
}

export function useWebsiteCredentialsQuery() {
  return useQuery({
    queryKey: credentialKeys.websiteCredentials(),
    queryFn: async () => {
      const result = await apiClient.get<WebsiteCredentialItem[]>('/credential-vault/website/list')
      return result.data || []
    },
  })
}

export function useAppCredentialsQuery() {
  return useQuery({
    queryKey: credentialKeys.appCredentials(),
    queryFn: async () => {
      const result = await apiClient.get<AppCredentialItem[]>('/credential-vault/app/list')
      return result.data || []
    },
  })
}

// ---------------------------------------------------------------------------
// Wave 5b S3：SaveBlacklist（"不为此网站保存"屏蔽列表）
// ---------------------------------------------------------------------------

export interface SaveBlacklistEntry {
  id: string
  domain: string
  created_at: string
}

/** 列出当前用户的"不为此网站保存"屏蔽列表。 */
export function useSaveBlacklistQuery() {
  return useQuery({
    queryKey: credentialKeys.saveBlacklist(),
    queryFn: async () => {
      const result = await apiClient.get<SaveBlacklistEntry[]>(
        '/credential-vault/save-blacklist',
      )
      return result.data || []
    },
  })
}

/**
 * 撤销一个屏蔽（用户在设置页点"移除"）。
 *
 * Wave 5b S3 review#2：必须走主进程 IPC `credential-vault:save-undismiss` 而非
 * 直接 HTTP DELETE。理由：
 *   - 主进程 `autofill-service.blacklistCache` 是 5min 本地 LRU——HTTP 直删后
 *     `onPasswordSubmitted` 仍读旧 cache，最长 5min 内 SavePasswordBar 不弹，
 *     用户感知"删完没生效"；
 *   - IPC handler 内部已做"DELETE django + cache.delete(domain)"原子序列，
 *     与 SavePasswordBar 5s 撤销路径走同一条线。
 *
 * Daemon / Web 部署没有 window.tabtin → fallback 到 HTTP 直接删（保留兼容性，
 * 这两个宿主无 autofill-service，本来也不存在 cache 漂移问题）。
 */
// ---------------------------------------------------------------------------
// Wave 5c T1：首次引导（PRD Story 1）跨设备状态
// ---------------------------------------------------------------------------

export interface OnboardingState {
  onboarding_dismissed_at: string | null
  browser_import_completed_at: string | null
  browser_import_source: string
}

/** 拉取当前用户的首次引导状态——FirstTimeImportBanner 决定是否展示。 */
export function useOnboardingStateQuery(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: credentialKeys.onboardingState(),
    queryFn: async () => {
      const result = await apiClient.get<OnboardingState>(
        '/credential-vault/onboarding/state',
      )
      return (
        result.data || {
          onboarding_dismissed_at: null,
          browser_import_completed_at: null,
          browser_import_source: '',
        }
      )
    },
    // 这是个跨设备状态，5 分钟 stale 已经够避免 refetch 风暴
    staleTime: 5 * 60 * 1000,
    enabled: opts.enabled ?? true,
  })
}

/**
 * 更新首次引导状态。`action`:
 *   - `dismiss`：用户点了"稍后再说"或 ×
 *   - `complete`：成功完成"从浏览器导入"流程
 *   - `reset`（仅 dev）：清掉两个时间戳
 *
 * 后端语义保证幂等——dismiss / complete 已 not null 时不刷时间戳。
 */
export function useUpdateOnboardingStateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: {
      action: 'dismiss' | 'complete' | 'reset'
      browser_import_source?: string
    }) => {
      const result = await apiClient.put<OnboardingState>(
        '/credential-vault/onboarding/state',
        {
          action: payload.action,
          browser_import_source: payload.browser_import_source || '',
        },
      )
      return result.data
    },
    onSuccess: (data) => {
      if (data) {
        queryClient.setQueryData(credentialKeys.onboardingState(), data)
      } else {
        queryClient.invalidateQueries({ queryKey: credentialKeys.onboardingState() })
      }
    },
  })
}

export function useDeleteSaveBlacklistEntryMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (domain: string) => {
      const ipcApi = (window as unknown as {
        tabtin?: {
          credentialVault?: {
            saveUndismiss?: (
              payload: { domain: string },
            ) => Promise<{ success: boolean; error?: string }>
          }
        }
      }).tabtin?.credentialVault?.saveUndismiss
      if (ipcApi) {
        const result = await ipcApi({ domain })
        if (!result?.success) {
          throw new Error(result?.error || 'save-undismiss IPC failed')
        }
      } else {
        // Daemon / Web fallback：无 autofill-service 缓存可清，直接删
        const encoded = encodeURIComponent(domain)
        await apiClient.delete(`/credential-vault/save-blacklist/${encoded}`)
      }
      return domain
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: credentialKeys.saveBlacklist() })
    },
  })
}
