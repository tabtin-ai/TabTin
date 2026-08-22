/**
 * PresetPickerPopover — Preset 选择弹出面板
 *
 * 按当前 activeContextType 过滤并分组展示可用的 Preset 列表。
 * 用户选中后激活对应 Preset 卡片。
 */

import React, { useState, useMemo, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Search } from 'lucide-react'
import { getAllPresets, getPresetsByCategory } from './registry/composerPresetRegistry'
import type { ComposerPresetDescriptor } from './registry/types'
import { useComposerPresetStore } from '@/stores/useComposerPresetStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { OVERLAY_SURFACE_CLASS, useOverlayContainer } from '@components/ui'
import { ZIndex } from '@tabtin/app-shell'
import { contextRegistry } from '../../context-space/registry'
import { getDraftComposerPresetScopeId } from './scope'
import {
  COMPOSER_TEXT_META_BASE,
  TEXT,
  TEXT_COLOR,
  BORDER,
  CARD_RADIUS,
} from '../registry/chatDesignTokens'

interface PresetPickerPopoverProps {
  open: boolean
  onClose: () => void
  sessionId?: string | null
  presetScopeId: string
  anchorRef: React.RefObject<HTMLElement | null>
  spaceId?: string | null
}

interface PresetGroup {
  category: string
  label: string
  presets: ComposerPresetDescriptor[]
}

function useActiveContextType(spaceId?: string | null): string | null {
  const activeKey = useSpaceContextTabsStore(s => {
    if (!spaceId) return null
    return s.activeKeyBySpace[spaceId] ?? null
  })
  return useMemo(() => {
    if (!activeKey) return null
    const parsed = contextRegistry.parseTabKey(activeKey)
    return parsed?.type ?? null
  }, [activeKey])
}

const CATEGORY_LABELS: Record<string, string> = {
  tabvideo: 'TabVideo',
  tabslide: 'TabSlide',
  tabdata: 'TabData',
  general: '通用',
}

export const PresetPickerPopover: React.FC<PresetPickerPopoverProps> = ({
  open,
  onClose,
  sessionId,
  presetScopeId,
  anchorRef,
  spaceId = null,
}) => {
  const { t } = useTranslation('composerPreset')
  // Wave 4：preset picker 是输入辅助类浮层——切走 hot Space 时输入意图断了，
  // 应主动清理 open state（onClose），避免切回时弹窗"幽灵复活"。
  const { isForeground } = useSpaceActivity()
  // Wave 6.3：portal 到所属 Space 的 OverlayContainer，切走时容器 hidden 自动隐藏。
  const overlayContainer = useOverlayContainer()
  const activeContextType = useActiveContextType(spaceId)
  const [search, setSearch] = useState('')
  const [askingSession, setAskingSession] = useState<ComposerPresetDescriptor | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const addPreset = useComposerPresetStore(s => s.addPreset)
  const startDraftSessionForSpace = useChatStore(s => s.startDraftSessionForSpace)

  const [position, setPosition] = useState<{ bottom: number; left: number } | null>(null)

  // 调用方 onClose 是 inline arrow（每次 render 新引用），用 ref 解出 deps，
  // 避免 ChatInput 高频 render 反复重订阅 effect。
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (open && !isForeground) {
      onCloseRef.current()
    }
  }, [open, isForeground])

  useEffect(() => {
    if (!open || !anchorRef.current) {
      setPosition(null)
      setSearch('')
      return
    }
    const update = () => {
      const rect = anchorRef.current!.getBoundingClientRect()
      setPosition({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
      })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)

    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open, onClose, anchorRef])

  const groups = useMemo<PresetGroup[]>(() => {
    const all = getAllPresets()
    if (all.length === 0) return []

    const contextPresets = activeContextType
      ? getPresetsByCategory(activeContextType)
      : []
    const generalPresets = getPresetsByCategory('general')

    const seen = new Set<string>()
    const result: PresetGroup[] = []

    if (contextPresets.length > 0 && activeContextType) {
      const filtered = search
        ? contextPresets.filter(p => matchesSearch(p, search, t))
        : contextPresets
      if (filtered.length > 0) {
        result.push({
          category: activeContextType,
          label: CATEGORY_LABELS[activeContextType] ?? activeContextType,
          presets: filtered,
        })
        filtered.forEach(p => seen.add(p.id))
      }
    }

    if (generalPresets.length > 0) {
      const filtered = (search
        ? generalPresets.filter(p => matchesSearch(p, search, t))
        : generalPresets
      ).filter(p => !seen.has(p.id))
      if (filtered.length > 0) {
        result.push({
          category: 'general',
          label: CATEGORY_LABELS['general'],
          presets: filtered,
        })
        filtered.forEach(p => seen.add(p.id))
      }
    }

    const otherPresets = all.filter(p => !seen.has(p.id))
    if (otherPresets.length > 0) {
      const filtered = search
        ? otherPresets.filter(p => matchesSearch(p, search, t))
        : otherPresets
      if (filtered.length > 0) {
        const byCategory = new Map<string, ComposerPresetDescriptor[]>()
        for (const p of filtered) {
          const list = byCategory.get(p.category) ?? []
          list.push(p)
          byCategory.set(p.category, list)
        }
        for (const [cat, presets] of byCategory) {
          result.push({
            category: cat,
            label: CATEGORY_LABELS[cat] ?? cat,
            presets,
          })
        }
      }
    }

    return result
  }, [activeContextType, search, t])

  const totalCount = groups.reduce((sum, g) => sum + g.presets.length, 0)
  const showSearch = getAllPresets().length > 7

  const activateInCurrentSession = (preset: ComposerPresetDescriptor) => {
    addPreset(presetScopeId, preset.id)
    onClose()
  }

  const activateInNewSession = (preset: ComposerPresetDescriptor) => {
    if (!spaceId) {
      addPreset(presetScopeId, preset.id)
      onClose()
      return
    }

    startDraftSessionForSpace(spaceId)
    addPreset(getDraftComposerPresetScopeId(spaceId), preset.id)
    onClose()
  }

  const handleSelect = (preset: ComposerPresetDescriptor) => {
    const strategy = preset.sessionStrategy ?? 'current'

    if (strategy === 'new') {
      activateInNewSession(preset)
    } else if (strategy === 'ask') {
      if (sessionId) {
        setAskingSession(preset)
      } else {
        activateInCurrentSession(preset)
      }
    } else {
      activateInCurrentSession(preset)
    }
  }

  // Wave 6.3：onClose effect 业务语义保留（"切走时关闭 picker"）；删除单独的
  // isForeground portal 守门——portal 改走 OverlayContainer 后由容器 hidden
  // 兜底，无需双保险。
  if (!open || !position) return null

  const content = (
    <div
      ref={popoverRef}
      style={{ position: 'fixed', bottom: `${position.bottom}px`, left: `${position.left}px`, zIndex: ZIndex.dropdown }}
      className={`${CARD_RADIUS} w-[280px] ${OVERLAY_SURFACE_CLASS}`}
    >
      {askingSession ? (
        <div className="px-3 py-2.5 space-y-2">
          <div className={`${TEXT.body} ${TEXT_COLOR.primary}`}>
            {t('picker.sessionChoice', '在哪个会话中使用？')}
          </div>
          <button
            type="button"
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors hover:bg-muted/20`}
            onClick={() => { activateInCurrentSession(askingSession); setAskingSession(null) }}
          >
            <span className={`${TEXT.body} ${TEXT_COLOR.secondary}`}>
              {t('picker.currentSession', '当前会话')}
            </span>
          </button>
          <button
            type="button"
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors hover:bg-muted/20`}
            onClick={() => { activateInNewSession(askingSession); setAskingSession(null) }}
          >
            <span className={`${TEXT.body} ${TEXT_COLOR.secondary}`}>
              {t('picker.newSession', '新建会话')}
            </span>
          </button>
          <button
            type="button"
            className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted} w-full text-center py-0.5`}
            onClick={() => setAskingSession(null)}
          >
            {t('picker.cancel', '取消')}
          </button>
        </div>
      ) : (
        <>
          {showSearch && (
            <div className={`flex items-center gap-2 border-b ${BORDER.subtle} px-2.5 py-1.5`}>
              <Search className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('picker.search', '搜索...')}
                className={`${TEXT.body} w-full bg-transparent outline-none placeholder:text-muted-foreground/40`}
                autoFocus
              />
            </div>
          )}

          <div className="max-h-[300px] overflow-y-auto py-1">
            {totalCount === 0 ? (
              <div className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted} px-3 py-4 text-center`}>
                {search ? t('picker.noResults', '无匹配结果') : t('picker.empty', '暂无可用的 Preset')}
              </div>
            ) : (
              groups.map(group => (
                <div key={group.category}>
                  {groups.length > 1 && (
                    <div className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted} px-3 pt-2 pb-0.5`}>
                      {group.label}
                    </div>
                  )}
                  {group.presets.map(preset => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/20`}
                      onClick={() => handleSelect(preset)}
                    >
                      {preset.icon && (
                        <span className={`${TEXT.body} shrink-0`}>{preset.icon}</span>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className={`${TEXT.body} ${TEXT_COLOR.primary} truncate`}>
                          {resolveLabel(preset.labelKey, t)}
                        </div>
                        {preset.descriptionKey && (
                          <div className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted} truncate`}>
                            {resolveLabel(preset.descriptionKey, t)}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )

  return createPortal(content, overlayContainer ?? document.body)
}

function resolveLabel(key: string, t: TFunction): string {
  if (key.includes(':') || key.includes('.')) {
    const translated = String(t(key, key))
    return translated === key ? key.split('.').pop() ?? key : translated
  }
  return key
}

function matchesSearch(
  preset: ComposerPresetDescriptor,
  query: string,
  t: TFunction,
): boolean {
  const q = query.toLowerCase()
  const label = resolveLabel(preset.labelKey, t).toLowerCase()
  if (label.includes(q)) return true
  if (preset.id.toLowerCase().includes(q)) return true
  if (preset.descriptionKey) {
    const desc = resolveLabel(preset.descriptionKey, t).toLowerCase()
    if (desc.includes(q)) return true
  }
  return false
}
