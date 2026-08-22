/**
 * useAppVaultRows —— 应用凭据列表映射成 VaultRow。
 */

import React, { useMemo } from 'react'
import { Smartphone } from 'lucide-react'
import { useAppCredentialsQuery } from '@/hooks/queries/credentials'
import type { AppCredentialItem } from '../credentials/types'
import type { VaultRow } from '../vault/types'

export type AppVaultFilter = 'all'

export type AppVaultRow = VaultRow<AppCredentialItem>

export interface AppVaultTotals {
  all: number
}

export interface UseAppVaultRowsResult {
  rows: AppVaultRow[]
  totals: AppVaultTotals
  isLoading: boolean
}

export function useAppVaultRows(): UseAppVaultRowsResult {
  const { data: credentials = [], isLoading } = useAppCredentialsQuery()

  const rows = useMemo<AppVaultRow[]>(() => {
    return credentials.map((c) => ({
      id: c.id,
      faviconKey: c.app_name || c.app_package,
      primary: c.display_name || c.app_name || c.app_package,
      secondary: c.username || c.app_package,
      kindIcon: React.createElement(Smartphone, { className: 'h-3 w-3' }),
      raw: c,
    }))
  }, [credentials])

  return { rows, totals: { all: credentials.length }, isLoading }
}
