/**
 * ApprovalGrantPopover — composer「管理 Agent 权限」轻量浮层
 *
 * 背景：此入口过去打开右侧「授权策略」抽屉（AgentSettingsSheet → security），
 * 抽屉命中 native-view-overlays 的 `[role="dialog"][data-state="open"]` 屏蔽
 * 选择器，导致浏览器 WebContentsView 整个被隐藏——即使抽屉在几何上根本
 * 不压浏览器区域。
 *
 * 改为与 AgentModeSelector 同款的手搓浮层：
 * - 无 dialog/menu 身份标签 → 不触发「有弹层就藏浏览器」的全局规则；
 * - resolveFloatingMenuLayout 自动 clamp 在聊天栏边界内 → 几何上不越界到
 *   浏览器原生层之上，两种布局（画布主位 / 聊天主位）都贴按钮出现。
 *
 * 内容只承载「审批权限授权」三档（共享区块 ApprovalGrantSection）；
 * 路径展示 / 已记住的授权仍在 Space 设置的完整抽屉里。
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Shield, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useTranslation } from 'react-i18next'
import {
  COMPOSER_COMPACT_TRIGGER_CLASS,
  COMPOSER_TOOLBAR_ICON_CLASS,
  COMPOSER_TOOLBAR_ICON_STROKE,
} from '../registry/chatDesignTokens'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { resolveFloatingMenuLayout, type FloatingMenuLayout } from '../panel/floatingMenuLayout'
import { ApprovalGrantSection } from '@components/space-settings/ApprovalGrantSection'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { canEditAgentSettings as canEditAgentSettingsFn } from '@/hooks/useCanEditAgentSettings'
import {
  effectiveCanEditAgentSettings,
  useSpaceSettingsEditGuard,
} from '@components/space-settings/hooks/useSpaceSettingsEditGuard'
import { useCloseOnOrganizationContextReset } from '@/hooks/useCloseOnOrganizationContextReset'
import { useEffectiveSessionApprovalMode } from '@/stores/chat/session/sessionApprovalMode'
import type { ApprovalModeName } from '@/stores/chat/shared/types'

const MENU_MAX_WIDTH = 320
const MENU_MIN_HEIGHT = 180

/** 盾牌家族 + 档位着色，避免闪电等突兀 icon。 */
const APPROVAL_BUTTON_THEME: Record<ApprovalModeName, { icon: LucideIcon; colorClass: string }> = {
  always_ask: { icon: ShieldCheck, colorClass: 'text-muted-foreground' },
  auto: { icon: Shield, colorClass: 'text-warning' },
  full_access: { icon: ShieldAlert, colorClass: 'text-destructive' },
}

interface ApprovalGrantPopoverProps {
  spaceId: string | null
  sessionId: string | null
  /**
   * 强制收字。未传时仅在胶囊悬浮面板（`[data-agent-chat-overlay]`）内收字；
   * 宽分屏侧栏 / 普通面板保持档位全文。
   */
  compact?: boolean
}

export const ApprovalGrantPopover: React.FC<ApprovalGrantPopoverProps> = ({
  spaceId,
  sessionId,
  compact: compactProp,
}) => {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)
  const [inCapsuleOverlay, setInCapsuleOverlay] = useState(false)
  const [menuLayout, setMenuLayout] = useState<FloatingMenuLayout>({
    width: MENU_MAX_WIDTH,
    height: MENU_MIN_HEIGHT,
    left: 16,
    placement: 'up',
    bottom: 16,
  })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuContentRef = useRef<HTMLDivElement>(null)
  // 升档二次确认框（全局 ConfirmDialog）打开期间暂停「点外部关闭」，
  // 否则点确认/取消按钮会被当成"点了浮层外面"把浮层一起关掉。
  const confirmOpenRef = useRef(false)

  // 胶囊 overlay 与分屏侧栏是不同挂载树；切回 split 会 remount，探测结果随实例更新。
  useLayoutEffect(() => {
    setInCapsuleOverlay(Boolean(triggerRef.current?.closest('[data-agent-chat-overlay]')))
  }, [])

  const compact = compactProp ?? inCapsuleOverlay

  const selectedSpaceId = useSpaceStore(s => s.selectedSpace?.id ?? null)
  const effectiveSpaceId = spaceId ?? selectedSpaceId

  const currentApprovalMode = useEffectiveSessionApprovalMode(sessionId)
  const ApprovalIcon = APPROVAL_BUTTON_THEME[currentApprovalMode].icon
  const approvalColorClass = APPROVAL_BUTTON_THEME[currentApprovalMode].colorClass

  // canManage 口径与 AgentSettingsSheet 一致：组织角色（owner 兜底）+ 远程查看守卫。
  const currentUserRole = useOrganizationStore(s => s.currentUserRole)
  const selectedOrganization = useOrganizationStore(s => s.selectedOrganization)
  const user = useAuthStore(s => s.user)
  const isOwner = !!(user && selectedOrganization && user.id === selectedOrganization.owner_id)
  const effectiveRole = currentUserRole ?? (isOwner ? 'owner' : null)
  const settingsEditGuard = useSpaceSettingsEditGuard(effectiveSpaceId)
  const canManage = effectiveCanEditAgentSettings(
    canEditAgentSettingsFn(effectiveRole),
    settingsEditGuard,
  )

  useEffect(() => {
    if (!isOpen) return

    const updateMenuLayout = () => {
      setMenuLayout(resolveFloatingMenuLayout({
        trigger: triggerRef.current,
        maxWidth: MENU_MAX_WIDTH,
        minHeight: MENU_MIN_HEIGHT,
        contentHeight: menuContentRef.current?.scrollHeight ?? 0,
      }))
    }

    const rafId = window.requestAnimationFrame(updateMenuLayout)
    window.addEventListener('resize', updateMenuLayout)
    window.addEventListener('scroll', updateMenuLayout, true)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', updateMenuLayout)
      window.removeEventListener('scroll', updateMenuLayout, true)
    }
  }, [isOpen])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (confirmOpenRef.current) return
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const handleToggleOpen = useCallback(() => {
    // 无可用 Space 时保持 no-op（与旧入口打开空抽屉宿主的行为等价）
    if (!effectiveSpaceId) return
    setIsOpen(prev => !prev)
  }, [effectiveSpaceId])

  const handleConfirmOpenChange = useCallback((open: boolean) => {
    confirmOpenRef.current = open
  }, [])

  const closeMenu = useCallback(() => {
    setIsOpen(false)
  }, [])
  useCloseOnOrganizationContextReset(closeMenu)

  const modeLabel = t(`permissionMode.${currentApprovalMode}.name`, {
    defaultValue: currentApprovalMode,
  })
  const modeDescription = t(`permissionMode.${currentApprovalMode}.description`)

  return (
    <div className={cn(
      'relative flex shrink-0 items-center',
      compact && 'h-7 w-7 justify-center',
    )}>
      <ChatIconTooltip
        side="top"
        content={isOpen
          ? null
          : (compact ? `${modeLabel} — ${modeDescription}` : modeDescription)}
        className="max-w-[280px] whitespace-normal leading-relaxed"
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={handleToggleOpen}
          data-compact={compact ? 'true' : undefined}
          className={cn(
            'flex items-center whitespace-nowrap rounded-lg text-body text-muted-foreground transition-colors',
            'hover:bg-muted/25 hover:text-foreground',
            compact ? COMPOSER_COMPACT_TRIGGER_CLASS : 'h-7 gap-1 px-1.5',
            isOpen && 'bg-muted/25',
            !effectiveSpaceId && 'opacity-50 cursor-not-allowed',
          )}
          aria-label={t('input.permissionSettings', {
            defaultValue: '管理 Agent 权限',
          }) + `：${modeLabel}`}
          aria-expanded={isOpen}
        >
          <ApprovalIcon
            className={cn(COMPOSER_TOOLBAR_ICON_CLASS, approvalColorClass)}
            strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
          />
          {!compact && (
            <span className={cn(
              'font-normal',
              approvalColorClass,
            )}>
              {modeLabel}
            </span>
          )}
          {!compact ? (
            <ChevronDown
              data-testid="approval-grant-chevron"
              strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
              className={cn(
                COMPOSER_TOOLBAR_ICON_CLASS,
                'shrink-0 transition-transform',
                isOpen && 'rotate-180',
              )}
            />
          ) : null}
        </button>
      </ChatIconTooltip>

      {/* Portal 到 body：避免浮动输入区的 backdrop-filter 成为 fixed 包含块导致菜单错位。
          z-modal（而非 AgentModeSelector 的 z-dropdown）：升档二次确认 ConfirmDialog
          走全局层同为 z-modal，后挂载的 dialog 按 DOM 顺序盖在浮层之上；若用
          z-dropdown(55) 浮层反而会压住确认框。 */}
      {createPortal(
        <AnimatePresence>
          {isOpen && effectiveSpaceId && (
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: menuLayout.placement === 'down' ? -4 : 4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: menuLayout.placement === 'down' ? -4 : 4, scale: 0.96 }}
              transition={{ duration: 0.12 }}
              className={cn(
                'fixed z-modal rounded-interactive overflow-hidden',
                OVERLAY_SURFACE_CLASS,
              )}
              style={{
                top: menuLayout.top,
                bottom: menuLayout.bottom,
                left: menuLayout.left,
                width: menuLayout.width,
                maxHeight: menuLayout.height,
              }}
            >
              <div
                ref={menuContentRef}
                className="overflow-y-auto p-2"
                style={{ maxHeight: menuLayout.height }}
              >
                <ApprovalGrantSection
                  spaceId={effectiveSpaceId}
                  canManage={canManage}
                  sessionId={sessionId}
                  frameless
                  onConfirmOpenChange={handleConfirmOpenChange}
                  confirmDialogContainer={null}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
