/**
 * ActivityRail 底部「客服」入口：悬停或点击展示企业微信二维码。
 * 二维码与账单退款 / 官网客服同源（contact_me_qr.png）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui'
import contactMeQrUrl from '@components/settings/panels/assets/contact_me_qr.png?url'
import { cn } from '@utils/cn'
import { RailCustomerSupportIcon } from './activityRailIcons'
import { RailIconTooltip } from './activityRailTooltip'
import {
  ACTIVITY_RAIL_ICON_SIZE,
  ACTIVITY_RAIL_ITEM,
  ACTIVITY_RAIL_ITEM_INACTIVE,
} from './sidebarUi'

const HOVER_CLOSE_DELAY_MS = 120

export const CustomerSupportRailButton: React.FC = () => {
  const { t } = useTranslation('sidebar')
  const [open, setOpen] = useState(false)
  const pinnedRef = useRef(false)
  const closeTimerRef = useRef<number | null>(null)

  const label = t('rail.customerSupport', { defaultValue: '客服' })

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    if (pinnedRef.current) return
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }, [clearCloseTimer])

  const handleOpenHover = useCallback(() => {
    clearCloseTimer()
    setOpen(true)
  }, [clearCloseTimer])

  const handleOpenChange = useCallback((next: boolean) => {
    clearCloseTimer()
    if (!next) {
      pinnedRef.current = false
    }
    setOpen(next)
  }, [clearCloseTimer])

  const handleTriggerClick = useCallback(() => {
    clearCloseTimer()
    pinnedRef.current = true
  }, [clearCloseTimer])

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <RailIconTooltip label={label} disabled={open}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={handleTriggerClick}
            onMouseEnter={handleOpenHover}
            onMouseLeave={scheduleClose}
            className={cn(ACTIVITY_RAIL_ITEM, ACTIVITY_RAIL_ITEM_INACTIVE)}
            data-testid="activity-rail-customer-support"
          >
            <RailCustomerSupportIcon size={ACTIVITY_RAIL_ICON_SIZE} />
          </button>
        </PopoverTrigger>
      </RailIconTooltip>
      <PopoverContent
        side="right"
        align="center"
        sideOffset={10}
        className="w-auto overflow-hidden p-0"
        onMouseEnter={handleOpenHover}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-4 py-4 text-center">
          <p className="text-body font-medium text-foreground">
            {t('rail.customerSupportTitle', { defaultValue: '联系客服' })}
          </p>
          <p className="mt-1 text-caption text-muted-foreground">
            {t('rail.customerSupportHint', { defaultValue: '微信扫码添加企业微信' })}
          </p>
          <div className="mx-auto mt-3 w-fit rounded-2xl border border-border bg-background p-3 shadow-sm">
            <img
              src={contactMeQrUrl}
              alt={t('rail.customerSupportQrAlt', { defaultValue: '企业微信客服二维码' })}
              className="h-40 w-40 rounded-xl object-contain"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

CustomerSupportRailButton.displayName = 'CustomerSupportRailButton'
