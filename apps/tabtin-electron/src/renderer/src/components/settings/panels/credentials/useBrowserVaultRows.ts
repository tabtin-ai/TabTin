/**
 * useBrowserVaultRows —— 把 cookie summary + 密码列表「拍平」成一行一记录的 VaultRow 数组。
 *
 * macOS Passwords.app 的设计哲学：
 *  - master list 一行 = 一条独立记录（不是按 host 聚合）
 *  - 同 host 邻近排序，扫读时自然成组
 *  - 顶部 filter chip 切换视图（全部 / 仅密码 / 仅 Cookie / 警告）
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { Globe, KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isLegacyOk } from '@/services/legacy-result'
import {
  useWebsiteCredentialsQuery,
  type WebsiteCredentialItem,
} from '@/hooks/queries/credentials'
import type { PartitionCookieSummary } from './types'
import { normalizeHost, sortKey } from './hostUtils'
import type { VaultRow } from '../vault/types'

export type BrowserVaultFilter = 'all' | 'passwords' | 'cookies' | 'warnings'

export interface BrowserCookieRowData {
  kind: 'cookie'
  hostKey: string
  displayHost: string
  cookieCount: number
  hasExpired: boolean
  expiredCount: number
}

export interface BrowserPasswordRowData {
  kind: 'password'
  hostKey: string
  displayHost: string
  username: string
  displayName: string
  item: WebsiteCredentialItem
}

export type BrowserVaultRowData = BrowserCookieRowData | BrowserPasswordRowData
export type BrowserVaultRow = VaultRow<BrowserVaultRowData>

export interface BrowserVaultTotals {
  all: number
  passwords: number
  cookies: number
  warnings: number
}

export interface UseBrowserVaultRowsResult {
  rows: BrowserVaultRow[]
  totals: BrowserVaultTotals
  isLoading: boolean
  refresh: () => Promise<void>
}

function buildHostFromUrl(url: string): string {
  try {
    const withScheme = url.startsWith('http') ? url : `https://${url}`
    return new URL(withScheme).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function useBrowserVaultRows(partition: string | null): UseBrowserVaultRowsResult {
  const { t } = useTranslation('settings')
  const [cookieSummary, setCookieSummary] = useState<PartitionCookieSummary | null>(null)
  const [loadingCookies, setLoadingCookies] = useState(false)
  const { data: passwords = [], isLoading: loadingPasswords } = useWebsiteCredentialsQuery()

  const loadCookies = useCallback(async () => {
    if (!partition) {
      setCookieSummary(null)
      return
    }
    setLoadingCookies(true)
    try {
      const res = await window.tabtin.credentialVault.getPartitionCookies({ partition })
      setCookieSummary(isLegacyOk(res) && res.summary ? res.summary : null)
    } catch (e) {
      console.error('[useBrowserVaultRows] load cookies failed:', e)
    } finally {
      setLoadingCookies(false)
    }
  }, [partition])

  useEffect(() => {
    loadCookies()
  }, [loadCookies])

  const rows = useMemo<BrowserVaultRow[]>(() => {
    const list: BrowserVaultRow[] = []

    if (cookieSummary?.domains) {
      for (const d of cookieSummary.domains) {
        const hostKey = normalizeHost(d.domain)
        if (!hostKey) continue
        const data: BrowserCookieRowData = {
          kind: 'cookie',
          hostKey,
          displayHost: d.domain,
          cookieCount: d.count,
          hasExpired: d.hasExpired,
          expiredCount: d.expiredCount,
        }
        list.push({
          id: `cookie:${d.domain}`,
          faviconKey: hostKey,
          primary: d.domain,
          secondary: t('credentialVault.list.cookieCount', { count: d.count, defaultValue: '{{count}} 个 Cookie' }),
          kindIcon: React.createElement(Globe, { className: 'h-3 w-3' }),
          badges: d.hasExpired
            ? [
                {
                  kind: 'warning',
                  label: t('credentialVault.list.expiredBadge', { count: d.expiredCount, defaultValue: '{{count}} 个 Cookie 已过期' }),
                },
              ]
            : undefined,
          raw: data,
        })
      }
    }

    for (const p of passwords) {
      const hostKey = normalizeHost(p.url)
      const displayHost = buildHostFromUrl(p.url)
      const displayName = p.display_name || displayHost
      const data: BrowserPasswordRowData = {
        kind: 'password',
        hostKey,
        displayHost,
        username: p.username,
        displayName,
        item: p,
      }
      list.push({
        id: `password:${p.id}`,
        faviconKey: hostKey,
        primary: displayName,
        secondary: p.username,
        kindIcon: React.createElement(KeyRound, { className: 'h-3 w-3' }),
        raw: data,
      })
    }

    return list.sort((a, b) => {
      const k = sortKey(a.raw.hostKey).localeCompare(sortKey(b.raw.hostKey))
      if (k !== 0) return k
      // 同 host 内：密码在前（更重要），cookie 在后
      if (a.raw.kind !== b.raw.kind) return a.raw.kind === 'password' ? -1 : 1
      return 0
    })
  }, [cookieSummary, passwords, t])

  const totals = useMemo<BrowserVaultTotals>(() => {
    let pw = 0
    let ck = 0
    let warn = 0
    for (const row of rows) {
      if (row.raw.kind === 'password') pw++
      if (row.raw.kind === 'cookie') {
        ck++
        if (row.raw.hasExpired) warn++
      }
    }
    return { all: rows.length, passwords: pw, cookies: ck, warnings: warn }
  }, [rows])

  return {
    rows,
    totals,
    isLoading: loadingCookies || loadingPasswords,
    refresh: loadCookies,
  }
}
