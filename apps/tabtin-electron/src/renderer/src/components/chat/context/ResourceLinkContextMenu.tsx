/**
 * ResourceLinkContextMenu — chat 链接右键菜单
 *
 * MarkdownRenderer 的 `<a>` `onContextMenu` 调 `showResourceLinkContextMenu(...)`
 * 弹出。本菜单是用户直接操作 D2 优先级表的入口：
 *
 *   - "在 Space 内打开"   — 走 ResourceRouter（D2 五层优先级）
 *   - "用 X 打开"          — W4：D2 第 2 层 session_override（仅本会话）
 *   - "始终用 X 打开"      — W4：D2 第 1 层 user_pref（持久化到 localStorage）
 *   - "在外部应用打开"     — 直接 system fallback（D2 第 5 层短路）
 *   - "复制链接"           — 系统剪贴板
 *
 * "用 X" / "始终用 X" 的 X 列表来源：`resourceRouter.resolve(pointer)`
 * 返回的 candidates 中除 system_fallback 外的 carrier appId 集合（已按
 * priority desc 排序、已通过 ContextRegistry.hasHandlerByAppId 过滤）。
 *
 * 设计参照 chat/richContent/widget/WidgetContextMenu.tsx 同款 fixed 浮层 +
 * Esc / 点外部关闭模式；子菜单使用 hover 触发 + 内联浮层，避免引入
 * floating-ui 依赖（W3 已有的简单 fixed clamp 模型够用）。
 *
 * Imperative API：
 *   showResourceLinkContextMenu({ x, y, href, spaceId, pointer })
 *     → 全局 store 更新 → ResourceLinkContextMenuHost 渲染浮层
 *
 * Host 由 App.tsx 顶层挂载（保持单一实例，避免每个 a 元素都挂自己的菜单）。
 */

import React, { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRightFromCircle,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { toast } from '@tabtin/smartsheet-ui/toast'
import {
  preferenceKeyOf,
  SYSTEM_CARRIER_APP_ID,
  type ResolveCandidate,
  type ResourcePointer,
} from '@tabtin/resource-router'
import { resourceRouter } from '@/services/resourceRouter'
import { useResourceOpenPreferences } from '@/stores/useResourceOpenPreferences'
import { contextRegistry } from '@/components/context-space/registry/instance'
import { tryOpenPreviewableDirectUrl } from '@/components/chat/preview/assetPreviewResolver'

// ─── Imperative store ────────────────────────────────────────────────

interface MenuState {
  visible: boolean
  x: number
  y: number
  href: string
  spaceId: string
  tabScopeKey?: string | null
  pointer: ResourcePointer | null
}

interface MenuStore extends MenuState {
  show: (s: Omit<MenuState, 'visible'>) => void
  hide: () => void
}

const useMenuStore = create<MenuStore>((set) => ({
  visible: false,
  x: 0,
  y: 0,
  href: '',
  spaceId: '',
  tabScopeKey: null,
  pointer: null,
  show: (s) => set({ ...s, tabScopeKey: s.tabScopeKey ?? null, visible: true }),
  hide: () => set({ visible: false }),
}))

export function showResourceLinkContextMenu(args: {
  x: number
  y: number
  href: string
  spaceId: string
  tabScopeKey?: string | null
  pointer: ResourcePointer
}): void {
  useMenuStore.getState().show(args)
}

export function hideResourceLinkContextMenu(): void {
  useMenuStore.getState().hide()
}

// ─── 候选 carrier 提取 ────────────────────────────────────────────────

interface CarrierOption {
  appId: string
  /** 显示名称——优先 ContextRegistry.handler.displayLabel，缺则用 appId */
  displayLabel: string
  /** emoji 图标，可选（搜索结果同源）*/
  displayEmoji?: string
}

/**
 * 从 router.resolve 的 candidates 列表里抽出 carrier 选项给"用 X 打开"
 * 子菜单用。
 *
 * - 过滤 system_fallback（"在外部应用打开"是它专属入口，不在此列表重复）
 * - 按 candidate 出现顺序去重（router 已按 D2 层级 + priority 排好）
 * - 用 ContextRegistry.handler 反查显示名（保持与 Tab 标题 / 全局搜索一致的命名）
 *
 * 不预过滤 candidate.source（user_pref / session_override / agent_hint /
 * manifest_default 都列出来，让用户能看到"我现在的设置是什么"）；UI 层
 * 在选项尾部加 ✓ 标识当前已选偏好。
 */
function extractCarrierOptions(
  candidates: readonly ResolveCandidate[],
): CarrierOption[] {
  const seen = new Set<string>()
  const options: CarrierOption[] = []
  for (const c of candidates) {
    if (c.appId === SYSTEM_CARRIER_APP_ID) continue
    if (seen.has(c.appId)) continue
    seen.add(c.appId)
    const handler = contextRegistry.getHandlerByAppId(c.appId)
    options.push({
      appId: c.appId,
      displayLabel: handler?.displayLabel ?? c.appId,
      displayEmoji: handler?.displayEmoji,
    })
  }
  return options
}

// ─── Host 组件 ───────────────────────────────────────────────────────

export const ResourceLinkContextMenuHost: React.FC = () => {
  const visible = useMenuStore((s) => s.visible)
  const x = useMenuStore((s) => s.x)
  const y = useMenuStore((s) => s.y)
  const href = useMenuStore((s) => s.href)
  const spaceId = useMenuStore((s) => s.spaceId)
  const tabScopeKey = useMenuStore((s) => s.tabScopeKey ?? null)
  const pointer = useMenuStore((s) => s.pointer)
  const hide = useMenuStore((s) => s.hide)
  const { t } = useTranslation('chat')

  // 偏好 / 会话切换状态——Panel 里要给已选项加 ✓
  // selector 拿 prefKey 对应的两个 entry，避免 store 任何变化都触发整菜单重渲染
  const prefKey = useMemo(
    () => (pointer ? preferenceKeyOf(pointer) : null),
    [pointer],
  )
  const userPrefAppId = useResourceOpenPreferences((s) =>
    prefKey ? s.preferences[prefKey] : undefined,
  )
  const sessionOverrideAppId = useResourceOpenPreferences((s) =>
    prefKey ? s.sessionOverrides[prefKey] : undefined,
  )
  const setPreference = useResourceOpenPreferences((s) => s.setPreference)
  const setSessionOverride = useResourceOpenPreferences((s) => s.setSessionOverride)

  // candidates 在 menu 打开期间稳定（pointer + spaceId 不变即不变化）
  const carrierOptions = useMemo<CarrierOption[]>(() => {
    if (!pointer || !spaceId) return []
    const result = resourceRouter.resolve(pointer, { spaceId })
    return extractCarrierOptions(result.candidates)
  }, [pointer, spaceId])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('[data-resource-link-context-menu="true"]')) return
      hide()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDocClick, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDocClick, true)
    }
  }, [visible, hide])

  // viewport 边界 clamp（与 W3 同款）
  // MENU_HEIGHT 估算：基础 4 项 + 至多 2 个子菜单 trigger ≈ 200px。
  // 实际越界靠子菜单内部 absolute right-full 兜底，clamp 是粗略避免主菜单
  // 出屏底部，严格定位由浏览器 viewport 自然处理。
  const menuStyle = useMemo<React.CSSProperties>(() => {
    const MENU_WIDTH = 240
    const MENU_HEIGHT = 220
    const margin = 8
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - margin)
    const top = Math.min(y, window.innerHeight - MENU_HEIGHT - margin)
    return {
      left: Math.max(margin, left),
      top: Math.max(margin, top),
    }
  }, [x, y])

  if (!visible || !pointer) return null

  const handleOpenInSpace = async () => {
    hide()
    // 可预览直链（xlsx/xls/csv/pdf/image…）进 Lightbox，禁止默认进 tabweb。
    if (tryOpenPreviewableDirectUrl(href)) {
      return
    }
    if (!spaceId) {
      toast.error(t('resourceLink.noSpace', { defaultValue: '当前无工作空间上下文，无法在工作空间内打开' }))
      return
    }
    await resourceRouter.open(spaceId, pointer, {
      triggerSource: 'chat_markdown',
      tabScopeKey,
    })
  }

  const handleOpenExternal = async () => {
    hide()
    await resourceRouter.open(spaceId, pointer, {
      modifierExternal: true,
      triggerSource: 'chat_markdown',
      tabScopeKey,
    })
  }

  const handleOpenWith = async (appId: string) => {
    hide()
    if (!spaceId) {
      toast.error(t('resourceLink.noSpace', { defaultValue: '当前无工作空间上下文，无法在工作空间内打开' }))
      return
    }
    if (prefKey) setSessionOverride(prefKey, appId)
    await resourceRouter.open(spaceId, pointer, {
      forceCarrierAppId: appId,
      triggerSource: 'chat_markdown',
      tabScopeKey,
    })
  }

  const handleAlwaysOpenWith = async (appId: string) => {
    hide()
    if (!prefKey) {
      toast.error(t('resourceLink.cannotPersist', {
        defaultValue: '此类型链接无法保存默认应用',
      }))
      return
    }
    setPreference(prefKey, appId)
    // 显示 toast 反馈，让用户知道偏好已写入
    const handler = contextRegistry.getHandlerByAppId(appId)
    const label = handler?.displayLabel ?? appId
    toast.success(t('resourceLink.preferenceSaved', {
      defaultValue: '已设为默认：{{label}}',
      label,
    }))
    // 偏好生效后立即按新偏好打开一次（用户右键即点的语义是"现在用 X 看"）
    if (spaceId) {
      await resourceRouter.open(spaceId, pointer, {
        triggerSource: 'chat_markdown',
        tabScopeKey,
      })
    }
  }

  const handleCopy = async () => {
    hide()
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(href)
        toast.success(t('resourceLink.copied', { defaultValue: '链接已复制' }))
      }
    } catch {
      toast.error(t('resourceLink.copyFailed', { defaultValue: '复制失败' }))
    }
  }

  const hasCarrierOptions = carrierOptions.length > 0

  return (
    <div
      data-resource-link-context-menu="true"
      role="menu"
      aria-label={t('resourceLink.menuLabel', { defaultValue: '链接操作菜单' })}
      className={cn('fixed z-dropdown min-w-[220px] rounded-interactive py-1 text-caption', OVERLAY_SURFACE_CLASS)}
      style={menuStyle}
    >
      <MenuItem
        icon={<ArrowUpRightFromCircle className="h-3.5 w-3.5" aria-hidden />}
        label={t('resourceLink.openInSpace', { defaultValue: '在工作空间内打开' })}
        onClick={handleOpenInSpace}
      />

      {hasCarrierOptions && (
        <>
          <Divider />
          <SubMenu
            label={t('resourceLink.openWith', { defaultValue: '用其他应用打开' })}
            secondary={t('resourceLink.openWithSecondary', {
              defaultValue: '本会话内同类型默认走此应用',
            })}
            ariaLabel={t('resourceLink.openWithMenu', {
              defaultValue: '用其他应用打开（本会话内同类型默认走此应用）',
            })}
          >
            {carrierOptions.map((opt) => (
              <CarrierMenuItem
                key={opt.appId}
                option={opt}
                checked={sessionOverrideAppId === opt.appId}
                onClick={() => handleOpenWith(opt.appId)}
              />
            ))}
          </SubMenu>

          <SubMenu
            label={t('resourceLink.alwaysOpenWith', {
              defaultValue: '始终用其他应用打开',
            })}
            secondary={t('resourceLink.alwaysOpenWithSecondary', {
              defaultValue: '保存为持久默认',
            })}
            ariaLabel={t('resourceLink.alwaysOpenWithMenu', {
              defaultValue: '始终用其他应用打开（保存为持久默认）',
            })}
          >
            {carrierOptions.map((opt) => (
              <CarrierMenuItem
                key={opt.appId}
                option={opt}
                checked={userPrefAppId === opt.appId}
                onClick={() => handleAlwaysOpenWith(opt.appId)}
              />
            ))}
          </SubMenu>
        </>
      )}

      <Divider />

      <MenuItem
        icon={<ExternalLink className="h-3.5 w-3.5" aria-hidden />}
        label={t('resourceLink.openExternal', { defaultValue: '在外部应用打开' })}
        onClick={handleOpenExternal}
      />

      <Divider />

      <MenuItem
        icon={<Copy className="h-3.5 w-3.5" aria-hidden />}
        label={t('resourceLink.copy', { defaultValue: '复制链接' })}
        onClick={handleCopy}
      />
    </div>
  )
}

// ─── 内部小组件 ──────────────────────────────────────────────────────

const Divider: React.FC = () => <div className="my-1 h-px bg-border/40" aria-hidden />

interface MenuItemProps {
  icon?: React.ReactNode
  label: string
  onClick: () => void
  trailing?: React.ReactNode
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, onClick, trailing }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className={cn(
      'w-full flex items-center gap-2 px-3 py-1.5 text-left',
      'text-foreground hover:bg-muted/40 cursor-pointer',
    )}
  >
    {icon}
    <span className="flex-1 truncate">{label}</span>
    {trailing}
  </button>
)

interface CarrierMenuItemProps {
  option: CarrierOption
  checked: boolean
  onClick: () => void
}

const CarrierMenuItem: React.FC<CarrierMenuItemProps> = ({
  option,
  checked,
  onClick,
}) => (
  <button
    type="button"
    role="menuitemradio"
    aria-checked={checked}
    onClick={onClick}
    className={cn(
      'w-full flex items-center gap-2 px-3 py-1.5 text-left',
      'text-foreground hover:bg-muted/40 cursor-pointer',
    )}
  >
    {option.displayEmoji ? (
      <span aria-hidden className="text-body leading-none w-4 text-center">
        {option.displayEmoji}
      </span>
    ) : (
      <span className="w-4" aria-hidden />
    )}
    <span className="flex-1 truncate">{option.displayLabel}</span>
    {checked && <Check className="h-3.5 w-3.5 text-accent" aria-hidden />}
  </button>
)

interface SubMenuProps {
  label: string
  /** 副标题——给"用 X 打开" / "始终用 X 打开" 区分语义；不传不渲染 */
  secondary?: string
  ariaLabel: string
  children: React.ReactNode
}

/**
 * Hover 触发的子菜单。设计要点：
 *   - mouseenter 100ms 延迟显示，避免移动鼠标穿过时误触发
 *   - mouseleave 200ms 延迟关闭，给用户时间从 trigger 滑到子菜单
 *   - submenu 自身的 mouseenter 取消关闭定时器
 *   - 视觉位置 absolute right-full top-0：子菜单出现在右侧，与父菜单同顶
 *
 * 不用 Floating UI——本菜单 candidates 列表很短（一般 1-3 项），固定
 * 位置即可；引入新依赖反而违反"轻量补 W3"的设计取向。
 *
 * 注意：父菜单本身是 fixed，子菜单的 absolute right-full 会相对父菜单的
 * 这一行 trigger 定位，自然落在右侧。如果父菜单贴近 viewport 右侧，
 * 子菜单会溢出——本期不处理（用户场景中右键菜单不会贴右），等真出现
 * 再补 viewport 检测。
 */
const SubMenu: React.FC<SubMenuProps> = ({ label, secondary, ariaLabel, children }) => {
  const [open, setOpen] = useState(false)
  const openTimerRef = React.useRef<number | null>(null)
  const closeTimerRef = React.useRef<number | null>(null)

  const cancelTimers = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  useEffect(() => () => cancelTimers(), [])

  const scheduleOpen = () => {
    cancelTimers()
    openTimerRef.current = window.setTimeout(() => setOpen(true), 100)
  }

  const scheduleClose = () => {
    cancelTimers()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 200)
  }

  return (
    <div
      className="relative"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={(e) => {
          e.preventDefault()
          setOpen((v) => !v)
        }}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left',
          'text-foreground hover:bg-muted/40 cursor-pointer',
        )}
      >
        <span className="w-3.5" aria-hidden />
        <span className="flex-1 truncate">{label}</span>
        {secondary && (
          <span className="text-muted-foreground/60 text-caption leading-none mr-1">
            {secondary}
          </span>
        )}
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          onMouseEnter={cancelTimers}
          onMouseLeave={scheduleClose}
          className={cn('absolute left-full top-0 ml-1 min-w-[180px] rounded-interactive py-1 text-caption z-dropdown', OVERLAY_SURFACE_CLASS)}
        >
          {children}
        </div>
      )}
    </div>
  )
}
