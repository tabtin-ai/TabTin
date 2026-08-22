import { current } from 'immer'
import type { PPTAnimation, PPTElement, Slide, SlidePresentation } from '../../types/slides'
import { SLIDE_BG } from '../../defaults/colors'
import { resolveThemeColorByKey } from '../../utils/background'
import { createElementId, createPageId, regenerateNestedIds } from '../../utils/id'
import { normalizeElementTransform, normalizeLayoutRef } from './element-normalization'
import { applyThemeColorsToElement } from './theme-colors'
import type { SlideStoreState } from './slide-store-types'

export const createBlankPage = (): Slide => ({
  id: createPageId(),
  elements: [],
  background: { type: 'solid', color: SLIDE_BG },
})

export const resetPageInteractionState = (s: SlideStoreState) => {
  s.selectedElementIds = []
  s.isEditing = false
  s.editingElementId = null
}

/**
 * 在 Immer draft 上同步 isDirty + saveStatus + saveError 三态，
 * 避免各 produce 回调手动维护一致性。
 */
export const applySaveState = (
  s: SlideStoreState,
  status: 'unsaved' | 'saving' | 'saved' | 'error',
  error?: string,
) => {
  switch (status) {
    case 'unsaved':
      s.isDirty = true
      s.saveStatus = 'unsaved'
      s.saveError = null
      break
    case 'saving':
      s.isDirty = false
      s.saveStatus = 'saving'
      s.saveError = null
      break
    case 'saved':
      s.saveStatus = 'saved'
      s.saveError = null
      break
    case 'error':
      s.isDirty = true
      s.saveStatus = 'error'
      s.saveError = error ?? null
      break
  }
}

export const normalizePresentation = (p: SlidePresentation): SlidePresentation => ({
  ...p,
  pages: p.pages.map((page) => ({
    ...page,
    elements: page.elements.map((el) => normalizeElementTransform(el)),
    ...(page.masterElements
      ? { masterElements: page.masterElements.map((el) => normalizeElementTransform(el)) }
      : {}),
    ...(page.layout ? { layout: normalizeLayoutRef(page.layout) } : {}),
  })),
})

export const applyPresentationTheme = (presentation: SlidePresentation) => {
  const theme = presentation.theme
  for (const page of presentation.pages) {
    const bg = page.background
    if (bg?.type === 'theme' && bg.theme?.key) {
      const resolved = resolveThemeColorByKey(bg.theme.key, theme)
      if (resolved) bg.theme.color = resolved
    }
    for (const el of page.elements) {
      applyThemeColorsToElement(el, theme)
    }
    if (page.masterElements) {
      for (const el of page.masterElements) {
        applyThemeColorsToElement(el, theme)
      }
    }
  }
}

export const cloneSlideWithRegeneratedIds = (slide: Slide): Slide => {
  const duplicated = structuredClone(current(slide))
  duplicated.id = createPageId()

  const elementIdMap = new Map<string, string>()
  duplicated.elements = duplicated.elements.map((el) => regenerateElementId(el, elementIdMap))

  if (duplicated.masterElements?.length) {
    duplicated.masterElements = duplicated.masterElements.map((el) => regenerateElementId(el, elementIdMap))
  }

  if (duplicated.animations?.length) {
    duplicated.animations = duplicated.animations
      .map((anim) => cloneAnimationWithMappedElement(anim, elementIdMap))
      .filter((anim): anim is PPTAnimation => anim !== null)
  }

  normalizeLegacyNotes(duplicated, elementIdMap)
  return duplicated
}

const regenerateElementId = (
  el: PPTElement,
  elementIdMap: Map<string, string>,
): PPTElement => {
  const newId = createElementId()
  elementIdMap.set(el.id, newId)
  const newEl = { ...el, id: newId }
  regenerateNestedIds(newEl)
  return newEl
}

const cloneAnimationWithMappedElement = (
  anim: PPTAnimation,
  elementIdMap: Map<string, string>,
): PPTAnimation | null => {
  const mappedElId = elementIdMap.get(anim.elId)
  if (!mappedElId) return null
  return {
    ...anim,
    id: createElementId(),
    elId: mappedElId,
  }
}

const normalizeLegacyNotes = (
  duplicated: Slide,
  elementIdMap: Map<string, string>,
) => {
  const rawNotes = (duplicated as { notes?: unknown }).notes
  if (Array.isArray(rawNotes) && rawNotes.length > 0) {
    duplicated.notes = rawNotes.map((note) => {
      const noteObj = note as { elId?: string }
      const mappedElId = noteObj.elId ? elementIdMap.get(noteObj.elId) : undefined
      return {
        ...(note as Record<string, unknown>),
        id: createElementId(),
        elId: mappedElId,
      }
    }) as Slide['notes']
  } else if (typeof rawNotes === 'string') {
    if (!duplicated.remark && rawNotes.trim().length > 0) {
      duplicated.remark = rawNotes
    }
    delete (duplicated as { notes?: unknown }).notes
  }
}
