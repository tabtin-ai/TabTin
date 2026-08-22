/**
 * useAiServiceVaultRows —— 把 AI 服务密钥列表映射成 VaultRow。
 */

import React, { useMemo } from 'react'
import { KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useServiceKeysQuery } from '@/hooks/queries/credentials'
import type { CredentialItem } from '../credentials/types'
import type { VaultRow } from '../vault/types'

export type AiServiceVaultFilter = 'all' | 'active' | 'disabled'

export type AiServiceVaultRow = VaultRow<CredentialItem>

export interface AiServiceVaultTotals {
  all: number
  active: number
  disabled: number
}

export interface UseAiServiceVaultRowsResult {
  rows: AiServiceVaultRow[]
  totals: AiServiceVaultTotals
  isLoading: boolean
}

export function useAiServiceVaultRows(): UseAiServiceVaultRowsResult {
  const { t } = useTranslation('settings')
  const { data: credentials = [], isLoading } = useServiceKeysQuery()

  const rows = useMemo<AiServiceVaultRow[]>(() => {
    return credentials.map((c) => {
      const masked = Object.values(c.masked_data || {}).filter(Boolean).join(' · ') || '••••••••'
      return {
        id: c.id,
        faviconKey: c.service_name,
        primary: c.display_name || c.service_name,
        secondary: masked,
        kindIcon: React.createElement(KeyRound, { className: 'h-3 w-3' }),
        badges: c.is_active
          ? undefined
          : [{ kind: 'disabled' as const, label: t('credentialVault.serviceKeys.disabled', { defaultValue: '已禁用' }) }],
        raw: c,
      }
    })
  }, [credentials, t])

  const totals = useMemo<AiServiceVaultTotals>(() => {
    let active = 0
    let disabled = 0
    for (const c of credentials) {
      if (c.is_active) active++
      else disabled++
    }
    return { all: credentials.length, active, disabled }
  }, [credentials])

  return { rows, totals, isLoading }
}
