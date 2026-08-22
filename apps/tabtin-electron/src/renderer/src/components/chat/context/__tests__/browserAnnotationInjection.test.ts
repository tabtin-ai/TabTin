import { afterEach, describe, expect, it } from 'vitest'
import {
  BROWSER_ANNOTATION_INJECT_EVENT,
  emitBrowserAnnotationInject,
  type BrowserAnnotationInjectPayload,
} from '../browserAnnotationInjection'
import { createContextRef } from '../../types'

function makePayload(): BrowserAnnotationInjectPayload {
  return {
    contextRef: createContextRef('web_annotation', 'https://example.com/', 'Example'),
  }
}

const listeners: Array<[string, EventListener]> = []
function listen(handler: (payload: BrowserAnnotationInjectPayload) => void) {
  const wrapped: EventListener = (event) => {
    handler((event as CustomEvent<BrowserAnnotationInjectPayload>).detail)
  }
  window.addEventListener(BROWSER_ANNOTATION_INJECT_EVENT, wrapped)
  listeners.push([BROWSER_ANNOTATION_INJECT_EVENT, wrapped])
}

afterEach(() => {
  listeners.splice(0).forEach(([name, fn]) => window.removeEventListener(name, fn))
})

describe('emitBrowserAnnotationInject 投递确认', () => {
  it('无任何监听器时返回 false（引用无处可去，调用方应走兜底）', () => {
    expect(emitBrowserAnnotationInject(makePayload())).toBe(false)
  })

  it('监听器收到但未置位 consumed 时仍返回 false', () => {
    listen(() => { /* 只旁观不消费 */ })
    expect(emitBrowserAnnotationInject(makePayload())).toBe(false)
  })

  it('监听器置位 consumed 后返回 true', () => {
    listen((payload) => { payload.consumed = true })
    expect(emitBrowserAnnotationInject(makePayload())).toBe(true)
  })
})
