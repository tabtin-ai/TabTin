import React from 'react'
import { ZIndex } from '@tabtin/app-shell'
import { useT } from '../../i18n'
import { OVERLAY_TEXT, OVERLAY_BG_HOVER } from './constants'

// ═══════════════════════════════════════════════
// 结束画面
// ═══════════════════════════════════════════════

export const EndScreen: React.FC<{ onExit: () => void }> = ({ onExit }) => {
  const translate = useT()
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        animation: 'tabslide-fadeIn 0.5s ease forwards',
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: 'rgba(255,255,255,0.7)',
          letterSpacing: 1,
        }}
      >
        {translate('slideshow.endTitle')}
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'rgba(255,255,255,0.35)',
        }}
      >
        {translate('slideshow.endSubtitle')}
      </div>
      <button
        data-slideshow-controls
        onClick={(e) => {
          e.stopPropagation()
          onExit()
        }}
        style={{
          marginTop: 12,
          border: '1px solid rgba(255,255,255,0.15)',
          background: 'rgba(255,255,255,0.06)',
          color: 'rgba(255,255,255,0.6)',
          borderRadius: 8,
          padding: '8px 24px',
          fontSize: 13,
          cursor: 'pointer',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.12)'
          e.currentTarget.style.color = 'rgba(255,255,255,0.8)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
          e.currentTarget.style.color = 'rgba(255,255,255,0.6)'
        }}
      >
        {translate('slideshow.exit')}
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════
// 快捷键提示
// ═══════════════════════════════════════════════

export const KeyboardHint: React.FC = () => {
  const translate = useT()
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 48,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 20,
        padding: '10px 20px',
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(12px)',
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.08)',
        animation: 'tabslide-hintFade 3.5s ease forwards',
        pointerEvents: 'none',
        zIndex: ZIndex.floating,
      }}
    >
      {[
        { key: '← →', desc: translate('slideshow.hintNavigate') },
        { key: 'Space', desc: translate('slideshow.hintNext') },
        { key: 'ESC', desc: translate('slideshow.hintExit') },
      ].map(({ key, desc }) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <kbd
            style={{
              display: 'inline-block',
              padding: '2px 7px',
              fontSize: 11,
              fontFamily: 'system-ui, sans-serif',
              fontWeight: 500,
              color: 'rgba(255,255,255,0.7)',
              background: 'rgba(255,255,255,0.1)',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            {key}
          </kbd>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>{desc}</span>
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════
// 底部控制栏
// ═══════════════════════════════════════════════

interface ControlBarProps {
  visible: boolean
  currentIndex: number
  totalPages: number
  onPrev: () => void
  onNext: () => void
  onGoToPage: (index: number) => void
  onExit: () => void
  t: (key: string) => string
}

export const ControlBar: React.FC<ControlBarProps> = ({
  visible,
  currentIndex,
  totalPages,
  onPrev,
  onNext,
  onExit,
  t,
}) => (
  <div
    data-slideshow-controls
    style={{
      position: 'fixed',
      bottom: 12,
      left: '50%',
      transform: `translateX(-50%) translateY(${visible ? 0 : 20}px)`,
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '5px 8px',
      background: 'rgba(0,0,0,0.55)',
      backdropFilter: 'blur(16px)',
      borderRadius: 10,
      border: '1px solid rgba(255,255,255,0.08)',
      opacity: visible ? 1 : 0,
      transition: 'all 0.25s ease',
      pointerEvents: visible ? 'auto' : 'none',
      zIndex: ZIndex.floating,
    }}
    onMouseDown={(e) => e.stopPropagation()}
    onClick={(e) => e.stopPropagation()}
  >
    {/* 上一页 */}
    <ControlButton title={t('slideshow.prev')} onClick={onPrev}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </ControlButton>

    {/* 页码 */}
    <div
      style={{
        padding: '2px 10px',
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        fontVariantNumeric: 'tabular-nums',
        color: OVERLAY_TEXT,
        whiteSpace: 'nowrap',
        minWidth: 52,
        textAlign: 'center',
      }}
    >
      {currentIndex + 1} / {totalPages}
    </div>

    {/* 下一页 */}
    <ControlButton title={t('slideshow.next')} onClick={onNext}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </ControlButton>

    {/* 分隔线 */}
    <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.12)', margin: '0 2px' }} />

    {/* 退出 */}
    <ControlButton title={`${t('slideshow.exit')} (ESC)`} onClick={onExit}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 6L6 18" />
        <path d="M6 6l12 12" />
      </svg>
    </ControlButton>
  </div>
)

const ControlButton: React.FC<{
  title: string
  onClick: () => void
  children: React.ReactNode
}> = ({ title, onClick, children }) => (
  <button
    title={title}
    onClick={(e) => {
      e.stopPropagation()
      onClick()
    }}
    style={{
      border: 'none',
      background: 'transparent',
      color: OVERLAY_TEXT,
      borderRadius: 6,
      padding: 6,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background 0.15s ease, color 0.15s ease',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.background = OVERLAY_BG_HOVER
      e.currentTarget.style.color = 'rgba(255,255,255,0.9)'
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = 'transparent'
      e.currentTarget.style.color = OVERLAY_TEXT
    }}
  >
    {children}
  </button>
)
