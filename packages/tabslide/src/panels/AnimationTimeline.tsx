import React, { useState, useCallback } from 'react'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import type { PPTAnimation, AnimationType, AnimationTrigger } from '../types/slides'
import { getAnimationsByType, findAnimationEffect } from '../configs/animations'
import { createElementId } from '../utils/id'
import { useT } from '../i18n'
import { ScrollArea } from '../components/ui/ScrollArea'

// ═══════════════════════════════════════════════
// 动画时间线编辑器
// ═══════════════════════════════════════════════

const TYPE_COLORS: Record<AnimationType, string> = { in: '#22c55e', out: '#ef4444', attention: '#f59e0b' }
const TRIGGER_ICONS: Record<AnimationTrigger, string> = { click: '🖱', meantime: '⇒', auto: '▶' }
const DURATION_PRESETS = [300, 500, 800, 1000, 1500, 2000, 3000]

/**
 * 动画时间线面板
 *
 * 底部面板，展示当前页面的动画列表：
 * - 每行显示一个动画条（元素名称 + 动画效果 + 时长）
 * - 可添加/删除/编辑动画
 * - 可拖拽重新排序
 * - 颜色编码区分入场/退场/强调
 */
const AnimationTimeline: React.FC<{ collapsed?: boolean; onToggle?: () => void }> = ({
  collapsed = false,
  onToggle,
}) => {
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

  // 新建动画
  const [addMode, setAddMode] = useState(false)
  const [addType, setAddType] = useState<AnimationType>('in')
  const [editingId, setEditingId] = useState<string | null>(null)

  const runWithHistory = useCallback((fn: () => void) => {
    const s = useSlideStore.getState()
    if (s.presentation) {
      useHistoryStore.getState().pushSnapshot(s.presentation.pages)
    }
    fn()
  }, [])

  // 拖拽排序
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)

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

  const PANEL_HEIGHT = collapsed ? 32 : 240

  return (
    <div
      className="w-full bg-background border-t border-border/30 flex flex-col transition-[height] duration-200 ease-out overflow-hidden shrink-0"
      style={{ height: PANEL_HEIGHT }}
    >
      {/* 头部 */}
      <div
        className={`h-8 shrink-0 flex items-center justify-between px-3 cursor-pointer select-none ${
          !collapsed ? 'border-b border-border/10' : ''
        }`}
        onClick={onToggle}
      >
        <div className="flex items-center gap-1.5">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span className="text-caption font-semibold text-muted-foreground">
            {translate('animation.title')} ({animations.length})
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!collapsed && selectedElementIds.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setAddMode(!addMode) }}
              className={`border border-border/10 rounded px-2 py-0.5 text-caption cursor-pointer font-medium ${
                addMode ? 'bg-accent/10 text-accent' : 'bg-background text-muted-foreground'
              }`}
            >
              + {translate('animation.add')}
            </button>
          )}
          <span
            className="text-muted-foreground/60 text-subtitle transition-transform duration-200"
            style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)' }}
          >
            ▴
          </span>
        </div>
      </div>

      {/* 内容区 */}
      {!collapsed && (
        <div className="flex-1 flex overflow-hidden">
          {/* 动画列表 */}
          <ScrollArea style={{ flex: 1 }} viewportStyle={{ padding: '4px 0' }}>
            {animations.length === 0 ? (
              <div className="px-3 py-5 text-center text-muted-foreground/60 text-body">
                {selectedElementIds.length > 0
                  ? translate('animation.emptyWithSelection')
                  : translate('animation.empty')}
              </div>
            ) : (
              animations.map((anim, idx) => {
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
                    className={`flex flex-col px-3 py-1 border-t-2 cursor-pointer transition-colors ${
                      isDropTarget ? 'border-accent' : 'border-transparent'
                    } ${isDragging ? 'opacity-40' : ''} ${
                      isEditing ? 'bg-muted/50' : 'hover:bg-muted/50'
                    }`}
                  >
                    {/* 动画行 */}
                    <div className="flex items-center gap-1.5 min-h-7">
                      {/* 序号 + 触发类型指示器 */}
                      <span
                        className="size-[18px] rounded-full text-white text-caption font-bold flex items-center justify-center shrink-0"
                        style={{ background: TYPE_COLORS[anim.type] }}
                      >
                        {idx + 1}
                      </span>

                      {/* 触发方式 */}
                      <span title={triggerLabels[anim.trigger]} className="text-body shrink-0">
                        {TRIGGER_ICONS[anim.trigger]}
                      </span>

                      {/* 元素名称 */}
                      <span className="text-body text-foreground truncate min-w-0 flex-1">
                        {getElementName(anim.elId)}
                      </span>

                      {/* 效果名称 */}
                      <span className="text-caption text-muted-foreground/60 shrink-0">
                        {effect
                          ? translateWithFallback(`animation.effect.${effect.name}`, effect.label)
                          : anim.effect}
                      </span>

                      {/* 时间线条 */}
                      <div
                        className="w-[60px] h-1.5 rounded-full shrink-0 relative overflow-hidden"
                        style={{ background: `${TYPE_COLORS[anim.type]}33` }}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, anim.duration / 30)}%`,
                            background: TYPE_COLORS[anim.type],
                          }}
                        />
                      </div>

                      {/* 时长 */}
                      <span className="text-caption text-muted-foreground/60 min-w-7 text-right shrink-0">
                        {anim.duration}ms
                      </span>

                      {/* 删除按钮 */}
                      <button
                        onClick={(e) => { e.stopPropagation(); runWithHistory(() => removeAnimation(anim.id)) }}
                        title={translate('animation.delete')}
                        className="border-none bg-transparent p-0.5 cursor-pointer text-muted-foreground/60 flex rounded shrink-0 hover:text-foreground"
                      >
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>

                    {/* 展开编辑区 */}
                    {isEditing && (
                      <AnimationEditor
                        anim={anim}
                        onUpdate={(u) => runWithHistory(() => updateAnimation(anim.id, u))}
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
              })
            )}
          </ScrollArea>

          {/* 添加动画效果选择器 */}
          {addMode && (
            <ScrollArea
              style={{ width: 200 }}
              className="border-l border-border/10"
              viewportStyle={{ padding: '6px 0' }}
            >
              {/* 动画类型 tabs */}
              <div className="flex gap-0.5 px-2 mb-1.5">
                {(['in', 'out', 'attention'] as AnimationType[]).map((at) => (
                  <button
                    key={at}
                    onClick={() => setAddType(at)}
                    className="flex-1 py-[3px] text-caption font-medium rounded cursor-pointer"
                    style={{
                      border: `1px solid ${addType === at ? TYPE_COLORS[at] : 'hsl(var(--border) / 0.1)'}`,
                      background: addType === at ? `${TYPE_COLORS[at]}15` : 'hsl(var(--background))',
                      color: addType === at ? TYPE_COLORS[at] : 'hsl(var(--muted-foreground))',
                    }}
                  >
                    {typeLabels[at]}
                  </button>
                ))}
              </div>

              {/* 效果列表 */}
              {getAnimationsByType(addType).map((group) => (
                <div key={group.groupKey}>
                  <div className="px-3 py-1 text-caption text-muted-foreground/60 font-semibold">
                    {translateWithFallback(`animation.group.${group.groupKey}`, group.groupName)}
                  </div>
                  {group.effects.map((eff) => (
                    <div
                      key={eff.name}
                      onClick={() => handleAddAnimation(eff.name)}
                      className="py-1 pl-5 pr-3 text-body text-foreground cursor-pointer transition-colors hover:bg-muted/50"
                    >
                      {translateWithFallback(`animation.effect.${eff.name}`, eff.label)}
                    </div>
                  ))}
                </div>
              ))}
            </ScrollArea>
          )}
        </div>
      )}
    </div>
  )
}

// ── 动画编辑器（展开行） ──

const AnimationEditor: React.FC<{
  anim: PPTAnimation
  onUpdate: (u: Partial<PPTAnimation>) => void
  triggerLabels: Record<AnimationTrigger, string>
  resolveEffectLabel: (effectName: string, fallback: string) => string
  effectLabel: string
  triggerLabel: string
  durationLabel: string
}> = ({
  anim,
  onUpdate,
  triggerLabels,
  resolveEffectLabel,
  effectLabel,
  triggerLabel,
  durationLabel,
}) => {
  const groups = getAnimationsByType(anim.type)

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="grid grid-cols-3 gap-1 pt-1.5 pb-1 pl-6"
    >
      {/* 效果选择 */}
      <div>
        <span className="text-caption text-muted-foreground/60 block mb-0.5">{effectLabel}</span>
        <select
          value={anim.effect}
          onChange={(e) => onUpdate({ effect: e.target.value })}
          className="w-full px-1 py-[3px] text-caption border border-border/10 rounded bg-background text-foreground outline-none"
        >
          {groups.map((g) =>
            g.effects.map((eff) => (
              <option key={eff.name} value={eff.name}>
                {resolveEffectLabel(eff.name, eff.label)}
              </option>
            )),
          )}
        </select>
      </div>

      {/* 触发方式 */}
      <div>
        <span className="text-caption text-muted-foreground/60 block mb-0.5">{triggerLabel}</span>
        <select
          value={anim.trigger}
          onChange={(e) => onUpdate({ trigger: e.target.value as AnimationTrigger })}
          className="w-full px-1 py-[3px] text-caption border border-border/10 rounded bg-background text-foreground outline-none"
        >
          {(['click', 'meantime', 'auto'] as AnimationTrigger[]).map((tr) => (
            <option key={tr} value={tr}>{triggerLabels[tr]}</option>
          ))}
        </select>
      </div>

      {/* 持续时间 */}
      <div>
        <span className="text-caption text-muted-foreground/60 block mb-0.5">{durationLabel}</span>
        <select
          value={anim.duration}
          onChange={(e) => onUpdate({ duration: +e.target.value })}
          className="w-full px-1 py-[3px] text-caption border border-border/10 rounded bg-background text-foreground outline-none"
        >
          {DURATION_PRESETS.map((d) => (
            <option key={d} value={d}>{d}ms</option>
          ))}
        </select>
      </div>
    </div>
  )
}

function typeLabel(type: string, translate: (key: string) => string) {
  const map: Record<string, string> = {
    text: translate('element.type.text'),
    image: translate('element.type.image'),
    shape: translate('element.type.shape'),
    line: translate('element.type.line'),
    chart: translate('element.type.chart'),
    table: translate('element.type.table'),
    latex: translate('element.type.latex'),
    video: translate('element.type.video'),
    audio: translate('element.type.audio'),
  }
  return map[type] || type
}

export default AnimationTimeline
