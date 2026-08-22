import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import { keymapManager, KeyboardPriority } from '../utils/keymap-manager'
import * as t from '../theme'
import { useT } from '../i18n'
import { ZIndex } from '@tabtin/app-shell'
import { useContextMenuActions } from '../hooks/useContextMenuActions'
import { buildContextMenuItems } from './buildContextMenuItems'

// ═══════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════

export interface ContextMenuState {
  visible: boolean
  x: number
  y: number
}

export const INITIAL_CTX: ContextMenuState = { visible: false, x: 0, y: 0 }

interface ContextMenuProps {
  state: ContextMenuState
  onClose: () => void
}

// ═══════════════════════════════════════════════
// 组件
// ═══════════════════════════════════════════════

const ContextMenu: React.FC<ContextMenuProps> = ({ state, onClose }) => {
  const translate = useT()
  const ref = useRef<HTMLDivElement>(null)
  const actions = useContextMenuActions()

  // 视口边界检测：渲染后修正越界坐标，在 paint 前完成避免闪烁
  useLayoutEffect(() => {
    if (!state.visible || !ref.current) return
    const el = ref.current
    const rect = el.getBoundingClientRect()
    const pad = 4
    const maxX = window.innerWidth - rect.width - pad
    const maxY = window.innerHeight - rect.height - pad
    if (rect.left > maxX) el.style.left = `${Math.max(pad, maxX)}px`
    if (rect.top > maxY) el.style.top = `${Math.max(pad, maxY)}px`
  }, [state.visible, state.x, state.y])

  // 点击外部关闭
  useEffect(() => {
    if (!state.visible) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [state.visible, onClose])

  // Esc 关闭（通过 KeymapManager 以 OVERLAY 优先级注册，阻止 useKeyboard 重复处理）
  useEffect(() => {
    if (!state.visible) return
    return keymapManager.register(KeyboardPriority.OVERLAY, (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return true
      }
    })
  }, [state.visible, onClose])

  if (!state.visible) return null

  const exec = (fn: () => void) => { fn(); onClose() }
  const execMutating = (fn: () => void) => {
    const s = useSlideStore.getState()
    if (s.presentation) useHistoryStore.getState().pushSnapshot(s.presentation.pages)
    exec(fn)
  }

  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
  const MOD = isMac ? '⌘' : 'Ctrl+'

  const items = buildContextMenuItems({ translate, mod: MOD, exec, execMutating, actions })

  return (
    <div
      ref={ref}
      data-canvas-ui="true"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: state.x,
        top: state.y,
        zIndex: ZIndex.global,
        background: t.bgApp,
        border: `1px solid ${t.borderLight}`,
        borderRadius: 8,
        boxShadow: t.shadowFloating,
        padding: '4px 0',
        minWidth: 180,
        fontFamily: t.fontFamily,
      }}
    >
      {items.map((item, i) => {
        if (item === 'divider') return <div key={i} style={{ height: 1, background: t.borderLight, margin: '4px 8px' }} />
        if ('items' in item) return <SubMenuRow key={i} label={item.label} items={item.items} />
        return <MenuRow key={i} {...item} />
      })}
    </div>
  )
}

// ── 菜单行 ──

const MenuRow: React.FC<{
  label: string; shortcut?: string; onClick: () => void; disabled?: boolean; danger?: boolean
}> = ({ label, shortcut, onClick, disabled, danger }) => (
  <button
    onClick={disabled ? undefined : onClick}
    disabled={disabled}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      border: 'none',
      background: 'transparent',
      padding: '6px 14px',
      fontSize: 12,
      cursor: disabled ? 'default' : 'pointer',
      color: disabled ? t.textTertiary : danger ? t.danger : t.textPrimary,
      opacity: disabled ? 0.5 : 1,
      transition: `background ${t.transitionFast}`,
      textAlign: 'left',
      fontFamily: 'inherit',
    }}
    onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = t.bgMuted }}
    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
  >
    <span>{label}</span>
    {shortcut && (
      <span style={{ fontSize: 11, color: t.textTertiary, marginLeft: 24 }}>{shortcut}</span>
    )}
  </button>
)

// ── 子菜单行 ──

const SubMenuRow: React.FC<{ label: string; items: { label: string; shortcut?: string; onClick: () => void; disabled?: boolean }[] }> = ({ label, items }) => {
  const [open, setOpen] = React.useState(false)
  const [openDir, setOpenDir] = React.useState<'left' | 'right'>('right')
  const ref = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const SUB_MENU_WIDTH = 168

  const cancelClose = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 100)
  }

  return (
    <div
      ref={ref}
      style={{ position: 'relative' }}
      onMouseEnter={() => {
        cancelClose()
        if (ref.current) {
          const rect = ref.current.getBoundingClientRect()
          setOpenDir(rect.right + SUB_MENU_WIDTH > window.innerWidth ? 'left' : 'right')
        }
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          border: 'none',
          background: open ? t.bgMuted : 'transparent',
          padding: '6px 14px',
          fontSize: 12,
          cursor: 'pointer',
          color: t.textPrimary,
          transition: `background ${t.transitionFast}`,
          textAlign: 'left',
          fontFamily: 'inherit',
        }}
      >
        <span>{label}</span>
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {open && (
        <div
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{
            position: 'absolute',
            ...(openDir === 'right' ? { left: '100%' } : { right: '100%' }),
            top: -4,
            background: t.bgApp,
            border: `1px solid ${t.borderLight}`,
            borderRadius: 8,
            boxShadow: t.shadowFloating,
            padding: '4px 0',
            minWidth: 160,
            zIndex: ZIndex.dropdown,
          }}
        >
          {items.map((sub, i) => <MenuRow key={i} {...sub} />)}
        </div>
      )}
    </div>
  )
}

export default ContextMenu
