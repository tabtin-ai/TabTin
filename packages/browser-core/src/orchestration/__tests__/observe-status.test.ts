import { describe, expect, it } from 'vitest'
import {
  ACT_OBSERVE_OK_HINT,
  ACT_OBSERVE_RETRY_HINT,
  resolveObserveStatus,
  mergeActEmbedObserve,
} from '../observe-status'

describe('resolveObserveStatus', () => {
  it('observeRequested=false → skipped，无 observed_elements', () => {
    const result = resolveObserveStatus({
      observeRequested: false,
      observation: { observed_elements: [{ ref: 'e1' }] },
      observeFailed: false,
    })
    expect(result.observe_status).toBe('skipped')
    expect(result.patch).toEqual({ observe_status: 'skipped' })
    expect(result.patch).not.toHaveProperty('observed_elements')
  })

  it('observeFailed=true → error，无 observed_elements', () => {
    const result = resolveObserveStatus({
      observeRequested: true,
      observation: { observed_elements: [{ ref: 'e1' }] },
      observeFailed: true,
    })
    expect(result.observe_status).toBe('error')
    expect(result.patch).toEqual({ observe_status: 'error' })
    expect(result.patch).not.toHaveProperty('observed_elements')
  })

  it('observation 有 ≥1 元素 → ok，patch 含 observed_elements', () => {
    const elements = [{ ref: 'e1', text: '提交' }, { ref: 'e2', role: 'link' }]
    const result = resolveObserveStatus({
      observeRequested: true,
      observation: { observed_elements: elements },
      observeFailed: false,
    })
    expect(result.observe_status).toBe('ok')
    expect(result.patch).toEqual({
      observe_status: 'ok',
      observed_elements: elements,
    })
  })

  it('observation 空数组 → empty，patch 含 observed_elements:[]', () => {
    const result = resolveObserveStatus({
      observeRequested: true,
      observation: { observed_elements: [] },
      observeFailed: false,
    })
    expect(result.observe_status).toBe('empty')
    expect(result.patch).toEqual({
      observe_status: 'empty',
      observed_elements: [],
    })
  })

  it('observation undefined 且未 failed → error（与硬失败同等）', () => {
    const result = resolveObserveStatus({
      observeRequested: true,
      observation: undefined,
      observeFailed: false,
    })
    expect(result.observe_status).toBe('error')
    expect(result.patch).toEqual({ observe_status: 'error' })
    expect(result.patch).not.toHaveProperty('observed_elements')
  })

  it('observation 无 observed_elements 字段 → error', () => {
    const result = resolveObserveStatus({
      observeRequested: true,
      observation: { hint: 'some hint' },
      observeFailed: false,
    })
    expect(result.observe_status).toBe('error')
    expect(result.patch).toEqual({ observe_status: 'error' })
    expect(result.patch).not.toHaveProperty('observed_elements')
  })

  it('observed_elements 非数组 → error', () => {
    const result = resolveObserveStatus({
      observeRequested: true,
      observation: { observed_elements: 'not-an-array' },
      observeFailed: false,
    })
    expect(result.observe_status).toBe('error')
    expect(result.patch).toEqual({ observe_status: 'error' })
  })

  it('observeFailed 优先于有效 observation → error', () => {
    const result = resolveObserveStatus({
      observeRequested: true,
      observation: { observed_elements: [{ ref: 'e1' }] },
      observeFailed: true,
    })
    expect(result.observe_status).toBe('error')
    expect(result.patch).not.toHaveProperty('observed_elements')
  })
})

describe('mergeActEmbedObserve ( act embed observe)', () => {
  const baseAct = {
    executed_actions: [{ type: 'click', success: true }],
    page_url: 'https://example.com/page',
    page_title: 'Example',
  }

  it('observe 关闭时只加 observe_status=skipped', () => {
    expect(mergeActEmbedObserve(baseAct, {
      observeRequested: false,
      observeFailed: false,
    })).toEqual({
      ...baseAct,
      observe_status: 'skipped',
    })
  })

  it('观察成功时合并 observe_status + observed_elements + 路由 hint + login_required', () => {
    const elements = [{ ref: 'e1', role: 'link', text: 'Go', href: 'https://example.com/go' }]
    const merged = mergeActEmbedObserve(baseAct, {
      observeRequested: true,
      observeFailed: false,
      observation: {
        observed_elements: elements,
        hint: 'use act --ref eN',
        login_required: { reason: 'login wall' },
      },
    })
    expect(merged).toMatchObject({
      ...baseAct,
      observe_status: 'ok',
      observed_elements: elements,
      login_required: { reason: 'login wall' },
    })
    expect(String(merged.hint)).toContain(ACT_OBSERVE_OK_HINT)
    expect(String(merged.hint)).toContain('use act --ref eN')
  })

  it('观察失败时 act 字段保留且 observe_status=error，并提示再 glance', () => {
    const merged = mergeActEmbedObserve(baseAct, {
      observeRequested: true,
      observeFailed: true,
    })
    expect(merged).toMatchObject({
      ...baseAct,
      observe_status: 'error',
    })
    expect(String(merged.hint)).toContain(ACT_OBSERVE_RETRY_HINT)
  })

  it('空清单时 observe_status=empty 且 observed_elements=[]，并提示再 glance', () => {
    const merged = mergeActEmbedObserve(baseAct, {
      observeRequested: true,
      observeFailed: false,
      observation: { observed_elements: [] },
    })
    expect(merged).toMatchObject({
      ...baseAct,
      observe_status: 'empty',
      observed_elements: [],
    })
    expect(String(merged.hint)).toContain(ACT_OBSERVE_RETRY_HINT)
  })
})
