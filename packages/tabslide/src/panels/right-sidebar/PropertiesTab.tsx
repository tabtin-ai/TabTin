import React, { useCallback } from 'react'
import { useSlideStore } from '../../store/slide'
import { useHistoryStore } from '../../store/history'
import type { PPTElement, PPTLineElement } from '../../types/slides'
import { useT } from '../../i18n'
import { roundTo, typeLabel } from './shared/constants'
import { buildLineLengthUpdates, getLineLength } from '../../utils/line-geometry'
import {
  IconField, NumberInput, RangeSlider,
  PanelInput,
} from './shared/components'
import { RotateIcon, FlipHIcon, FlipVIcon, OpacityIcon } from './shared/field-icons'
import { SectionPanel } from '@tabtin/smartsheet-ui'
import { StyleEditor } from './editors/style-editor'
import { ScrollArea } from '../../components/ui/ScrollArea'

export interface PropertiesTabProps {
  onUploadImage?: (file: File) => Promise<string>
}

export const PropertiesTab: React.FC<PropertiesTabProps> = ({ onUploadImage }) => {
  const translate = useT()
  const selectedCount = useSlideStore((s) => s.selectedElementIds.length)
  const el = useSlideStore((s) => {
    if (s.selectedElementIds.length !== 1) return null
    const page = s.presentation?.pages[s.currentPageIndex]
    if (!page) return null
    const targetId = s.selectedElementIds[0]
    if (!targetId) return null
    return page.elements.find((item) => item.id === targetId) || null
  })
  const updateElement = useSlideStore((s) => s.updateElement)
  const editingElementId = useSlideStore((s) => s.editingElementId)

  const hasSelection = selectedCount > 0
  const isLine = el?.type === 'line'

  const handleUpdate = useCallback(
    (id: string, updates: Partial<PPTElement>) => {
      const s = useSlideStore.getState()
      if (s.presentation) {
        useHistoryStore.getState().pushSnapshotDebounced(s.presentation.pages)
      }
      updateElement(id, updates)
    },
    [updateElement],
  )

  if (!hasSelection) {
    return (
      <div className="px-3.5 py-10 text-center">
        <span className="text-body text-muted-foreground/60">
          {translate('property.noSelection')}
        </span>
      </div>
    )
  }

  if (selectedCount > 1) {
    return (
      <div className="px-3 py-2">
        <span className="text-body text-muted-foreground/60">
          {translate('property.multiSelection', { count: selectedCount })}
        </span>
      </div>
    )
  }

  if (!el) return null

  const opacityControl = (
    <div
      className="flex h-7 items-center gap-1.5 rounded bg-muted/40 px-1.5"
      title={translate('property.opacity')}
    >
      <span className="flex shrink-0 items-center text-muted-foreground/70"><OpacityIcon /></span>
      <RangeSlider
        min={0} max={1} step={0.01}
        value={el.opacity}
        onChange={(v) => handleUpdate(el.id, { opacity: v } as Partial<PPTElement>)}
        style={{ flex: 1 }}
      />
      <span className="min-w-[30px] shrink-0 text-right text-caption tabular-nums text-muted-foreground">
        {Math.round(el.opacity * 100)}%
      </span>
    </div>
  )

  return (
    <ScrollArea style={{ flex: 1 }}>
      <SectionPanel
        title={typeLabel(el.type, translate)}
        storageKey="slide.element"
      >
        <div className="flex flex-col gap-2">
          <PanelInput
            type="text"
            value={el.name || ''}
            onChange={(e) => handleUpdate(el.id, { name: e.target.value || undefined } as Partial<PPTElement>)}
            placeholder={translate('property.elementName')}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label="X" value={roundTo(el.x)} step={0.1} precision={1} onChange={(v) => handleUpdate(el.id, { x: v } as Partial<PPTElement>)} fullWidth />
            <NumberInput label="Y" value={roundTo(el.y)} step={0.1} precision={1} onChange={(v) => handleUpdate(el.id, { y: v } as Partial<PPTElement>)} fullWidth />
            {isLine ? (
              <NumberInput
                label="Length"
                value={roundTo(getLineLength(el as PPTLineElement))}
                step={0.1}
                precision={1}
                onChange={(v) => handleUpdate(el.id, buildLineLengthUpdates(el as PPTLineElement, v) as Partial<PPTElement>)}
                fullWidth
              />
            ) : (
              <>
                <NumberInput label="W" value={roundTo(el.width)} step={0.1} precision={1} onChange={(v) => handleUpdate(el.id, { width: v } as Partial<PPTElement>)} fullWidth />
                <NumberInput label="H" value={roundTo((el as { height: number }).height)} step={0.1} precision={1} onChange={(v) => handleUpdate(el.id, { height: v } as Partial<PPTElement>)} fullWidth />
              </>
            )}
          </div>
        </div>
      </SectionPanel>

      <SectionPanel title={translate('property.transform')} storageKey="slide.transform">
        <div className="flex flex-col gap-2">
          {isLine ? (
            opacityControl
          ) : (
            <>
              <div className="flex items-center gap-2">
                <IconField icon={<RotateIcon />} title={translate('property.rotate')} className="flex-1">
                  <NumberInput
                    value={roundTo((el as { rotate: number }).rotate)}
                    step={0.1}
                    precision={1}
                    onChange={(v) => handleUpdate(el.id, { rotate: v } as Partial<PPTElement>)}
                    suffix="°"
                    fullWidth
                  />
                </IconField>
                <button
                  type="button"
                  title={translate('property.flipHorizontal')}
                  aria-pressed={!!(el as { flipH?: boolean }).flipH}
                  onClick={() => handleUpdate(el.id, { flipH: !(el as { flipH?: boolean }).flipH } as Partial<PPTElement>)}
                  className={`flex h-7 w-8 shrink-0 items-center justify-center rounded transition-colors ${
                    (el as { flipH?: boolean }).flipH
                      ? 'bg-accent/10 text-accent'
                      : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <FlipHIcon />
                </button>
                <button
                  type="button"
                  title={translate('property.flipVertical')}
                  aria-pressed={!!(el as { flipV?: boolean }).flipV}
                  onClick={() => handleUpdate(el.id, { flipV: !(el as { flipV?: boolean }).flipV } as Partial<PPTElement>)}
                  className={`flex h-7 w-8 shrink-0 items-center justify-center rounded transition-colors ${
                    (el as { flipV?: boolean }).flipV
                      ? 'bg-accent/10 text-accent'
                      : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <FlipVIcon />
                </button>
              </div>
              {opacityControl}
            </>
          )}
          {(el.type === 'image' || el.type === 'shape' || el.type === 'latex') && (
            <label className="flex cursor-pointer items-center gap-1.5 text-body text-muted-foreground">
              <input
                type="checkbox"
                checked={!!(el as { fixedRatio?: boolean }).fixedRatio}
                onChange={(e) => handleUpdate(el.id, { fixedRatio: e.target.checked } as Partial<PPTElement>)}
                className="accent-accent"
              />
              {translate('property.fixedRatio')}
            </label>
          )}
        </div>
      </SectionPanel>

      <StyleEditor
        element={el}
        onUpdate={handleUpdate}
        editingElementId={editingElementId}
        onUploadImage={onUploadImage}
      />
    </ScrollArea>
  )
}
