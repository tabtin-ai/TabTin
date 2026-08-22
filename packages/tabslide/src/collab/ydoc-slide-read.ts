import * as Y from 'yjs'
import type { Slide, PPTElement } from '../types/slides'
import {
  PAGE_ELEMENTS_MAP,
  PAGE_ELEMENT_ORDER,
  PAGE_ELEMENT_ORDER_MAP,
  PAGE_ELEMENTS_LEGACY,
} from './ydoc-schema'
import { getOrderedIds } from './utils'
import { normalizeCollabElement, normalizeCollabElements } from './normalize-collab-element'
import { yValueToPlain } from './ydoc-slide-model'

function yMapToElement(yMap: Y.Map<unknown>): PPTElement {
  const obj: Record<string, unknown> = {}
  yMap.forEach((value, key) => {
    obj[key] = yValueToPlain(value)
  })
  return normalizeCollabElement(obj)
}

function readElementsFromYMap(pageYMap: Y.Map<unknown>): PPTElement[] | null {
  const elementsMap = pageYMap.get(PAGE_ELEMENTS_MAP)
  const elementOrderMap = pageYMap.get(PAGE_ELEMENT_ORDER_MAP)
  const elementOrder = pageYMap.get(PAGE_ELEMENT_ORDER)
  if (!(elementsMap instanceof Y.Map)) return null

  let orderedIds: string[] = []
  if (elementOrderMap instanceof Y.Map && elementOrderMap.size > 0) {
    orderedIds = getOrderedIds(elementOrderMap)
  } else if (elementOrder instanceof Y.Array) {
    orderedIds = elementOrder.toArray() as string[]
  } else {
    elementsMap.forEach((_v, key) => {
      orderedIds.push(key)
    })
  }

  const result: PPTElement[] = []
  for (const elId of orderedIds) {
    const elYMap = elementsMap.get(elId)
    if (elYMap instanceof Y.Map) {
      result.push(yMapToElement(elYMap))
    }
  }
  return result
}

function readSlideElements(pageYMap: Y.Map<unknown>): PPTElement[] {
  const newFormatElements = readElementsFromYMap(pageYMap)
  if (newFormatElements !== null) return newFormatElements

  const oldElements = pageYMap.get(PAGE_ELEMENTS_LEGACY)
  if (oldElements instanceof Y.Array) {
    return normalizeCollabElements(oldElements.toJSON() as Record<string, unknown>[])
  }
  if (Array.isArray(oldElements)) {
    return normalizeCollabElements(oldElements as Record<string, unknown>[])
  }
  return []
}

function applyBasicSlideFields(slide: Slide, pageYMap: Y.Map<unknown>): void {
  const background = pageYMap.get('background')
  const remark = pageYMap.get('remark')
  const turningMode = pageYMap.get('turningMode')
  const layout = pageYMap.get('layout')

  if (background !== undefined && background !== null) {
    slide.background = background as Slide['background']
  }
  if (typeof remark === 'string' && remark) {
    slide.remark = remark
  }
  if (typeof turningMode === 'string' && turningMode) {
    slide.turningMode = turningMode as Slide['turningMode']
  }
  if (layout !== undefined && layout !== null) {
    slide.layout = layout as Slide['layout']
  }
}

function applyArraySlideFields(slide: Slide, pageYMap: Y.Map<unknown>): void {
  const masterElements = pageYMap.get('masterElements')
  const animations = pageYMap.get('animations')
  const notes = pageYMap.get('notes')

  if (masterElements instanceof Y.Array) {
    slide.masterElements = masterElements.toJSON() as PPTElement[]
  }
  if (animations instanceof Y.Array) {
    slide.animations = animations.toJSON() as Slide['animations']
  }
  if (notes instanceof Y.Array) {
    slide.notes = notes.toJSON() as Slide['notes']
  }
}

function applyMetadataSlideFields(slide: Slide, pageYMap: Y.Map<unknown>): void {
  const sectionTag = pageYMap.get('sectionTag')
  const slideType = pageYMap.get('slideType')

  if (sectionTag !== undefined && sectionTag !== null) {
    slide.sectionTag = sectionTag as Slide['sectionTag']
  }
  if (typeof slideType === 'string' && slideType) {
    slide.slideType = slideType as Slide['slideType']
  }
}

export function yPageToSlide(pageId: string, pageYMap: Y.Map<unknown>): Slide {
  const slide: Slide = { id: pageId, elements: readSlideElements(pageYMap) }
  applyBasicSlideFields(slide, pageYMap)
  applyArraySlideFields(slide, pageYMap)
  applyMetadataSlideFields(slide, pageYMap)
  return slide
}
