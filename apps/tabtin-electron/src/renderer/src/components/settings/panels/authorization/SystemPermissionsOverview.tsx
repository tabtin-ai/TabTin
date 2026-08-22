/**
 * 系统权限总览卡片
 *
 * 顶部状态条：
 *  - 拟人化 tagline（按可检测项授权进度切换文案）
 *  - "已授权 N / 共 M 项"摘要（M = 平台适用项数，含无法自动检测）
 *  - 重新检查按钮
 *
 * 不统计 not-applicable（避免把 Windows 上的 macOS 专属项算进分母）。
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import type { PermissionDescriptor } from './permissionConfig'
import { computePermissionOverviewStats } from './permissionOverviewStats'
import { SETTINGS_TEXT_META } from '../../settingsUi'
import { cn } from '@utils/cn'

interface Props {
  items: PermissionDescriptor[]
  refreshing: boolean
  onRefresh: () => Promise<void> | void
}

export const SystemPermissionsOverview: React.FC<Props> = ({
  items,
  refreshing,
  onRefresh,
}) => {
  const { t } = useTranslation('settings')

  const stats = useMemo(() => computePermissionOverviewStats(items), [items])

  const allGranted = stats.allDetectableGranted
  const someGranted = stats.someDetectableGranted

  const taglineKey = allGranted
    ? 'authorizationSystem.overview.taglineAll'
    : someGranted
      ? 'authorizationSystem.overview.taglineSome'
      : 'authorizationSystem.overview.taglineNone'

  return (
    <section className="rounded-[12px] bg-muted/10 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          {allGranted ? (
            <ShieldCheck className="h-5 w-5 text-success" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-muted-foreground/60" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-foreground">
            {t(taglineKey)}
          </p>
          {stats.total > 0 && (
            <p className={cn(SETTINGS_TEXT_META, 'mt-0.5')}>
              {t('authorizationSystem.overview.summary', {
                granted: stats.granted,
                total: stats.total,
              })}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={refreshing}
          data-testid="permissions-overview-refresh"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span className="ml-1.5">
            {t('authorizationSystem.overview.refresh')}
          </span>
        </Button>
      </div>
    </section>
  )
}
