import React, { useState, useCallback, useEffect } from 'react'
import { useSlideStore } from '../../store/slide'
import { useHistoryStore } from '../../store/history'
import type { PPTAnimation, AnimationType, AnimationTrigger } from '../../types/slides'
import { getAnimationsByType, findAnimationEffect } from '../../configs/animations'
import { createElementId } from '../../utils/id'
import { useT } from '../../i18n'
import { PanelSelect } from './shared/components'
import { SectionPanel } from '@tabtin/smartsheet-ui'
import { typeLabel } from './shared/constants'
import { ScrollArea } from '../../components/ui/ScrollArea'

const TYPE_COLORS: Record<AnimationType, string> = { in: '#22c55e', out: '#ef4444', attention: '#f59e0b' }
const TRIGGER_ICONS: Record<AnimationTrigger, string> = { click: '🖱', meantime: '⇒', auto: '▶' }
const DURATION_PRESETS = [300, 500, 800, 1000, 1500, 2000, 3000]

export const AnimationTab: React.FC = () => {
  const translate = useT()
  const translateWithFallback = useCallback((key: string, fallback: string) => {
    const translated = translate(key)
    return translated === key ? fallback : translated
  }, [translate])

  const typeLabels: Record<AnimationType, string> = {
    in: translate('animation.type.in'),
    out: translate('animation.type.out'),
    attention: translate('animation.type.attention'),
  }
  const triggerLabels: Record<AnimationTrigger, string> = {
    click: translate('animation.trigger.click'),
    meantime: translate('animation.trigger.meantime'),
    auto: translate('animation.trigger.auto'),
  }

  const presentation = useSlideStore((s) => s.presentation)
  const currentPageIndex = useSlideStore((s) => s.currentPageIndex)
  const selectedElementIds = useSlideStore((s) => s.selectedElementIds)
  const addAnimation = useSlideStore((s) => s.addAnimation)
  const updateAnimation = useSlideStore((s) => s.updateAnimation)
  const removeAnimation = useSlideStore((s) => s.removeAnimation)
  const reorderAnimations = useSlideStore((s) => s.reorderAnimations)

  const page = presentation?.pages[currentPageIndex]
  const animations = page?.animations ?? []
  const elements = page?.elements ?? []

  const [addMode, setAddMode] = useState(false)
  const [addType, setAddType] = useState<AnimationType>('in')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)

  useEffect(() => {
    setAddMode(false)
    setAddType('in')
    setEditingId(null)
    setDragIdx(null)
    setDropIdx(null)
  }, [currentPageIndex])

  const runWithHistory = useCallback((fn: () => void) => {
    const s = useSlideStore.getState()
    if (s.presentation) {
      useHistoryStore.getState().pushSnapshot(s.presentation.pages)
    }
    fn()
  }, [])

  const getElementName = useCallback((elId: string) => {
    const el = elements.find((e) => e.id === elId)
    if (!el) return translate('animation.elementDeleted')
    return el.name || typeLabel(el.type, translate)
  }, [elements, translate])

  const handleAddAnimation = useCallback((effect: string) => {
    if (selectedElementIds.length === 0) return
    runWithHistory(() => {
      for (const elId of selectedElementIds) {
        const anim: PPTAnimation = {
          id: createElementId(),
          elId,
          type: addType,
          effect,
          duration: 800,
          trigger: 'click',
        }
        addAnimation(anim)
      }
    })
    setAddMode(false)
  }, [selectedElementIds, addType, addAnimation, runWithHistory])

  const handleDrop = useCallback((targetIdx: number) => {
    if (dragIdx !== null && dragIdx !== targetIdx) {
      runWithHistory(() => {
        reorderAnimations(dragIdx, targetIdx)
      })
    }
    setDragIdx(null)
    setDropIdx(null)
  }, [dragIdx, reorderAnimations, runWithHistory])

  return (
    <ScrollArea className="flex-1">
      <SectionPanel
        title={`${translate('animation.title')} (${animations.length})`}
        storageKey="slide.animation"
        actions={
          selectedElementIds.length > 0 ? (
            <button
              onClick={() => setAddMode(!addMode)}
              className={addMode
                ? 'bg-accent/10 text-accent border-none rounded px-2.5 py-0.5 text-body font-medium cursor-pointer'
                : 'bg-muted/40 text-muted-foreground border-none rounded px-2.5 py-0.5 text-body font-medium cursor-pointer hover:bg-muted/60'
              }
            >
              + {translate('animation.add')}
            </button>
          ) : undefined
        }
      >
        {/* 效果选择器 */}
        {addMode && (
          <div className="pb-2">
            <div className="flex gap-0.5 mb-2">
              {(['in', 'out', 'attention'] as AnimationType[]).map((at) => (
                <button
                  key={at}
                  onClick={() => setAddType(at)}
                  className="flex-1 py-1 text-body font-medium rounded cursor-pointer border"
                  style={{
                    borderColor: addType === at ? TYPE_COLORS[at] : 'hsl(var(--border) / 0.3)',
                    background: addType === at ? `${TYPE_COLORS[at]}15` : 'hsl(var(--background))',
                    color: addType === at ? TYPE_COLORS[at] : 'hsl(var(--muted-foreground))',
                  }}
                >
                  {typeLabels[at]}
                </button>
              ))}
            </div>
            <ScrollArea className="max-h-[180px]">
              {getAnimationsByType(addType).map((group) => (
                <div key={group.groupKey}>
                  <div className="text-caption text-muted-foreground/60 font-semibold py-1">
                    {translateWithFallback(`animation.group.${group.groupKey}`, group.groupName)}
                  </div>
                  {group.effects.map((eff) => (
                    <div
                      key={eff.name}
                      onClick={() => handleAddAnimation(eff.name)}
                      className="px-2 py-1 text-body text-foreground cursor-pointer rounded transition-colors hover:bg-muted/80"
                    >
                      {translateWithFallback(`animation.effect.${eff.name}`, eff.label)}
                    </div>
                  ))}
                </div>
              ))}
            </ScrollArea>
          </div>
        )}

        {/* 动画列表 */}
        {animations.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground/60 text-body">
            {selectedElementIds.length > 0
              ? translate('animation.emptyWithSelection')
              : translate('animation.empty')}
          </div>
        ) : (
          <div>
            {animations.map((anim, idx) => {
              const effect = findAnimationEffect(anim.effect)
              const isDragging = dragIdx === idx
              const isDropTarget = dropIdx === idx && dropIdx !== dragIdx
              const isEditing = editingId === anim.id

              return (
                <div
                  key={anim.id}
                  draggable
                  onDragStart={() => setDragIdx(idx)}
                  onDragOver={(e) => { e.preventDefault(); setDropIdx(idx) }}
                  onDrop={() => handleDrop(idx)}
                  onDragEnd={() => { setDragIdx(null); setDropIdx(null) }}
                  onClick={() => setEditingId(isEditing ? null : anim.id)}
                  className={`px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
                    isEditing ? 'bg-muted/60' : 'hover:bg-muted/80'
                  }`}
                  style={{
                    borderTop: isDropTarget ? '2px solid hsl(var(--accent))' : '2px solid transparent',
                    opacity: isDragging ? 0.4 : 1,
                  }}
                >
                  <div className="flex items-center gap-1.5 min-h-[26px]">
                    <span
                      className="w-[18px] h-[18px] rounded-full text-white text-caption font-bold flex items-center justify-center shrink-0"
                      style={{ background: TYPE_COLORS[anim.type] }}
                    >
                      {idx + 1}
                    </span>
                    <span title={triggerLabels[anim.trigger]} className="text-body shrink-0">
                      {TRIGGER_ICONS[anim.trigger]}
                    </span>
                    <span className="text-body text-foreground overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-1">
                      {getElementName(anim.elId)}
                    </span>
                    <span className="text-caption text-muted-foreground/60 shrink-0">
                      {anim.duration}ms
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        runWithHistory(() => {
                          removeAnimation(anim.id)
                        })
                      }}
                      title={translate('animation.delete')}
                      className="border-none bg-transparent p-0.5 cursor-pointer flex rounded-sm text-muted-foreground/60 hover:text-foreground shrink-0"
                    >
                      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5 mt-0.5 pl-6">
                    <span className="text-body text-muted-foreground/60">
                      {effect
                        ? translateWithFallback(`animation.effect.${effect.name}`, effect.label)
                        : anim.effect}
                    </span>
                    <div
                      className="w-10 h-1 rounded-sm overflow-hidden shrink-0"
                      style={{ background: `${TYPE_COLORS[anim.type]}33` }}
                    >
                      <div
                        className="h-full rounded-sm"
                        style={{
                          width: `${Math.min(100, anim.duration / 30)}%`,
                          background: TYPE_COLORS[anim.type],
                        }}
                      />
                    </div>
                  </div>

                  {isEditing && (
                    <AnimationEditor
                      anim={anim}
                      onUpdate={(u) => {
                        runWithHistory(() => {
                          updateAnimation(anim.id, u)
                        })
                      }}
                      triggerLabels={triggerLabels}
                      resolveEffectLabel={(effectName, fallback) =>
                        translateWithFallback(`animation.effect.${effectName}`, fallback)}
                      effectLabel={translate('animation.effectLabel')}
                      triggerLabel={translate('animation.triggerLabel')}
                      durationLabel={translate('animation.duration')}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SectionPanel>
    </ScrollArea>
  )
}

const AnimationEditor: React.FC<{
  anim: PPTAnimation
  onUpdate: (u: Partial<PPTAnimation>) => void
  triggerLabels: Record<AnimationTrigger, string>
  resolveEffectLabel: (effectName: string, fallback: string) => string
  effectLabel: string
  triggerLabel: string
  durationLabel: string
}> = ({ anim, onUpdate, triggerLabels, resolveEffectLabel, effectLabel, triggerLabel, durationLabel }) => {
  const groups = getAnimationsByType(anim.type)

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="grid gap-1.5 pt-2 pb-1 pl-6"
    >
      <div>
        <span className="text-caption text-muted-foreground/60 block mb-0.5">{effectLabel}</span>
        <PanelSelect value={anim.effect} onChange={(e) => onUpdate({ effect: e.target.value })}>
          {groups.map((g) =>
            g.effects.map((eff) => (
              <option key={eff.name} value={eff.name}>
                {resolveEffectLabel(eff.name, eff.label)}
              </option>
            )),
          )}
        </PanelSelect>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <span className="text-caption text-muted-foreground/60 block mb-0.5">{triggerLabel}</span>
          <PanelSelect value={anim.trigger} onChange={(e) => onUpdate({ trigger: e.target.value as AnimationTrigger })}>
            {(['click', 'meantime', 'auto'] as AnimationTrigger[]).map((tr) => (
              <option key={tr} value={tr}>{triggerLabels[tr]}</option>
            ))}
          </PanelSelect>
        </div>
        <div>
          <span className="text-caption text-muted-foreground/60 block mb-0.5">{durationLabel}</span>
          <PanelSelect value={anim.duration} onChange={(e) => onUpdate({ duration: +e.target.value })}>
            {DURATION_PRESETS.map((d) => (
              <option key={d} value={d}>{d}ms</option>
            ))}
          </PanelSelect>
        </div>
      </div>
    </div>
  )
}
